import * as vscode from 'vscode';
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import './stringExtension';
import './mapExtension';
import { isAbsolute } from 'path';


export class TopStats {
    public scope: string | null = null;
    public module: string | null = null;
    public own: number = 0;
    public total: number = 0;
    public callees: Map<string, TopStats> = new Map();
    public callers: Map<string, TopStats> = new Map();
    public lines: Set<number> = new Set();

    public constructor(scope: string | null = null, module: string | null = null) {
        this.scope = scope;
        this.module = module;
    }

    key() {
        return `${this.module}:${this.scope}`;
    }

}

export interface AustinStats {
    hierarchy: D3Hierarchy;
    lineMap: Map<string, Map<number, [number, number]>>;
    callStack: TopStats;
    top: Map<string, TopStats>;
    overallTotal: number;
    source: string | null;
}

export class AustinStats implements AustinStats {

    private _beforeCbs: (() => void)[];
    private _afterCbs: ((stats: AustinStats) => void)[];

    public constructor() {
        this.lineMap = new Map();
        this.overallTotal = 0;
        this.top = new Map();
        this.hierarchy = {
            "name": "",
            "value": 0,
            "children": [],
            "data": "root",
        };
        this.callStack = new TopStats();
        this._beforeCbs = [];
        this._afterCbs = [];
        this.source = null;
    }

    clear() {
        this.top.clear();
        this.lineMap.clear();
        this.overallTotal = 0;
        this.hierarchy = {
            "name": this.source!,
            "value": 0,
            "children": [],
            "data": "root",
        };
        this.callStack = new TopStats();
    }

    private updateTop(frameList: FrameObject[], metric: number) {
        if (frameList.length === 0) {
            return;
        }

        let fo: FrameObject | undefined = undefined;
        let seenFrames = new Set<string>(); // Prevent inflating times (e.g. recursive functions)
        let stats = this.top;
        let caller: TopStats | null = null;
        frameList.forEach((fo) => {
            let key = `${fo.module}:${fo.scope}`;
            if (seenFrames.has(key)) {
                return;
            }
            seenFrames.add(key);
            if (!(stats.has(key))) {
                stats.set(key, new TopStats(fo.scope, fo.module));
            }
            let topStats = stats.get(key)!;
            topStats.total += metric;
            topStats.lines.add(fo.lineNumber);
            if (caller && !topStats.callers.has(caller.key())) {
                topStats.callers.set(caller.key(), caller);
            }
            caller = topStats;
        });

        // Set own time to the top of the stack
        fo = frameList[frameList.length - 1];
        let key = `${fo.module}:${fo.scope}`;
        stats.get(key)!.own += metric;
    }

    private updateLineMap(frameList: FrameObject[], metric: number) {
        let fo: FrameObject | undefined = undefined;
        let seenFrames = new Set<string>(); // Prevent inflating times (e.g. recursive functions)
        let stats = this.lineMap;
        frameList.forEach((fo) => {
            if (seenFrames.has(`${fo.module}:${fo.lineNumber}`)) {
                return;
            }
            seenFrames.add(`${fo.module}:${fo.lineNumber}`);
            if (!(stats.has(fo.module))) {
                stats.set(fo.module, new Map<number, [number, number]>());
            }
            let module = stats.get(fo.module);
            if (!(module?.has(fo.lineNumber))) {
                module?.set(fo.lineNumber, [0, 0]);
            }
            let own: number, total: number;
            [own, total] = module?.get(fo.lineNumber)!;
            total += metric;
            module?.set(fo.lineNumber, [own, total]);
        });

        // Set own time to the top of the stack
        if (frameList.length > 0) {
            fo = frameList[frameList.length - 1];
            let module = stats.get(fo.module);
            let own: number, total: number;
            [own, total] = module?.get(fo.lineNumber)!;
            own += metric;
            module?.set(fo.lineNumber, [own, total]);
        }
    }

    private updateHierarchy(frameList: FrameObject[], metric: number) {
        let stats = this.hierarchy;
        stats.value += metric;

        let updateContainer = (container: D3Hierarchy[], frame: FrameObject, keyFactory: (frame: FrameObject) => string, newDataFactory: (frame: FrameObject) => any) => {
            const name: string = keyFactory(frame);
            for (let e of container) {
                if (e.name === name) {
                    e.value += metric;
                    return e.children;
                }
            }
            const newContainer: D3Hierarchy[] = [];
            container.push({
                "name": name,
                "value": metric,
                children: newContainer,
                "data": newDataFactory(frame),
            });
            return newContainer;
        };

        let container = stats.children;
        frameList.forEach((fo) => {
            if (false) { // TODO: Consider whether to re-enable per-line flamegraphs or not.
                container = updateContainer(
                    container,
                    fo,
                    (fo) => { return fo.lineNumber ? `${fo.scope} (${fo.module})` : fo.scope; },
                    (fo) => { return { "file": fo.module, "source": this.source }; }
                );
                if (fo.lineNumber) {
                    container = updateContainer(
                        container,
                        fo,
                        (fo) => { return `${fo.lineNumber}`; },
                        (fo) => { return { "file": fo.module, "line": fo.lineNumber, "source": this.source }; }
                    );
                };
            }
            else {
                container = updateContainer(
                    container,
                    fo,
                    (fo) => { return fo.scope; /*fo.module && fo.lineNumber ? `${fo.scope} (${fo.module})` : fo.scope;*/ },
                    (fo) => { return { "file": fo.module, "name": fo.scope, "line": fo.lineNumber, "source": this.source }; }
                );
            }
        });
    }

    private updateCallStack(frameList: FrameObject[], metric: number) {
        let stats: TopStats = this.callStack!;
        frameList.forEach((fo) => {
            let key = `${fo.module}:${fo.scope}`;
            let callee = stats.callees.getDefault(key, () => new TopStats(fo.scope, fo.module));
            callee.lines.add(fo.lineNumber);
            // stats?.total += metric;
            stats = callee;
        });
    }

    public update(sample: string) {
        if (sample.startsWith('# ') || sample.length === 0) {
            return;
        }

        let frames: string, metrics: string;
        [frames, metrics] = sample.rsplit(' ', 1);
        const metric = Number(metrics);  // TODO: Assuming metrics is a single number
        this.overallTotal += metric;

        let callStack = frames.split(';');
        let frameList: FrameObject[] = callStack.map(parseFrame);

        this.updateLineMap(frameList.slice(2), metric);
        this.updateTop(frameList.slice(2), metric);
        this.updateHierarchy(frameList, metric);
        this.updateCallStack(frameList, metric);
    }

    public registerBeforeCallback(cb: () => void) {
        this._beforeCbs.push(cb);
    }


    public registerAfterCallback(cb: (stats: AustinStats) => void) {
        this._afterCbs.push(cb);
    }

    public readFromFile(file: string) {
        this.source = file;
        this.clear();

        const readInterface = createInterface({
            input: createReadStream(file)
        });

        this._beforeCbs.forEach(cb => cb());

        readInterface.on("line", this.update.bind(this));

        readInterface.on("close", () => {
            [...this.top.values()].forEach(v => { v.own /= this.overallTotal; v.total /= this.overallTotal; });
            this._afterCbs.forEach(cb => cb(this));
        });
    }
}


export function absolutePath(path: string) {
    if (!isAbsolute(path)) {
        if (vscode.workspace.workspaceFolders) {
            for (let folder of vscode.workspace.workspaceFolders) {
                let absolutePath = vscode.Uri.joinPath(folder.uri, path).fsPath;
                if (existsSync(absolutePath)) {
                    return absolutePath;
                }
            }
        }
    }
    return path;
}


interface FrameObject {
    scope: string;
    lineNumber: number;
    module: string;
};


function parseFrame(frame: string): FrameObject {
    let module: string, scope: string, line: string;
    [module, scope, line] = frame.rsplit(":", 2);

    return { "scope": scope, "lineNumber": Number(line), "module": absolutePath(module) };
}


interface D3Hierarchy {
    name: string;
    value: number;
    children: D3Hierarchy[];
    data?: any;
}
