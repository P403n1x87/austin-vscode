import * as vscode from 'vscode';
import { createReadStream, existsSync, readFile } from 'fs';
import { createInterface } from 'readline';
import './stringExtension';
import './mapExtension';
import './utils/io';
import { isAbsolute } from 'path';
import { Readable } from 'stream';
import { readHead } from './utils/io';
import { MojoParser } from './utils/mojo';
import { AustinRuntimeSettings } from './settings';


export class AustinSample {
    public pid: number;
    public tid: string;
    public stack: FrameObject[];
    public metrics: number[];
    public idle: boolean = false;
    public gc: boolean = false;

    public constructor(pid: number, tid: string, stack: FrameObject[], metrics: number[], idle: boolean = false, gc: boolean = false) {
        this.pid = pid;
        this.tid = tid;
        this.stack = stack;
        this.metrics = metrics;
        this.idle = idle;
        this.gc = gc;
    }

    public static parse(sample: string): AustinSample {
        let [pidTidFrames, metrics] = sample.rsplit(' ', 1);

        let frames = pidTidFrames.split(';');
        let pid = frames.shift()!;
        let tid = frames.shift()!;
        return new AustinSample(Number(pid), tid, frames.map(parseFrame), [Number(metrics)]);
    }
}

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
    locationMap: Map<string, Map<string, [FrameObject, number, number]>>;
    callStack: TopStats;
    top: Map<string, TopStats>;
    overallTotal: number;
    source: string | null;
    metadata: Map<string, string>;
}

export class AustinStats implements AustinStats {

    private _beforeCbs: (() => void)[];
    private _afterCbs: ((stats: AustinStats) => void)[];

    public constructor() {
        this.locationMap = new Map();
        this.overallTotal = 0;
        this.top = new Map();
        this.hierarchy = {
            name: "",
            value: 0,
            children: [],
            data: "root",
        };
        this.callStack = new TopStats();
        this._beforeCbs = [];
        this._afterCbs = [];
        this.source = null;
        this.metadata = new Map();
    }

    clear() {
        this.top.clear();
        this.locationMap.clear();
        this.overallTotal = 0;
        this.hierarchy = {
            name: this.source!,
            value: 0,
            children: [],
            data: "root",
        };
        this.callStack = new TopStats();
        this.metadata = new Map();
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
            topStats.lines.add(fo.line);
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

    private updateLineMap(frames: FrameObject[], metric: number) {
        let fo: FrameObject | undefined = undefined;
        let seenFrames = new Set<string>(); // Prevent inflating times (e.g. recursive functions)
        let stats = this.locationMap;

        let key = (fo: FrameObject) => `${fo.module}:${fo.scope}:${fo.line}:${fo.lineEnd}:${fo.column}:${fo.columnEnd}`;

        frames.forEach((fo) => {
            let frameKey = key(fo);
            if (seenFrames.has(frameKey)) {
                return;
            }
            seenFrames.add(frameKey);
            if (!(stats.has(fo.module))) {
                stats.set(fo.module, new Map<string, [FrameObject, number, number]>());
            }
            let module = stats.get(fo.module);
            if (!(module?.has(frameKey))) {
                module?.set(frameKey, [fo, 0, 0]);
            }
            let own: number, total: number;
            [fo, own, total] = module?.get(frameKey)!;
            total += metric;
            module?.set(frameKey, [fo, own, total]);
        });

        // Set own time to the top of the stack
        if (frames.length > 0) {
            fo = frames[frames.length - 1];
            let frameKey = key(fo);
            let module = stats.get(fo.module);
            let own: number, total: number;
            [fo, own, total] = module?.get(frameKey)!;
            own += metric;
            module?.set(frameKey, [fo, own, total]);
        }
    }

    private updateHierarchy(pid: number, tid: string, frameList: FrameObject[], metric: number) {
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
                name: name,
                value: metric,
                children: newContainer,
                data: newDataFactory(frame),
            });
            return newContainer;
        };

        let getGroupContainer = (key: string, container: D3Hierarchy[]) => {
            for (let e of container) {
                if (e.name === key) {
                    e.value += metric;
                    return e.children;
                }
            }
            const newContainer: D3Hierarchy[] = [];
            container.push({
                name: key,
                value: metric,
                children: newContainer,
                data: {},
            });
            return newContainer;
        };

        let container = getGroupContainer(`Thread ${tid}`, getGroupContainer(`Processs ${pid}`, stats.children));

        frameList.forEach((fo) => {
            if (false) { // TODO: Consider whether to re-enable per-line flamegraphs or not.
                container = updateContainer(
                    container,
                    fo,
                    (fo) => { return fo.line ? `${fo.scope} (${fo.module})` : fo.scope; },
                    (fo) => { return { "file": fo.module, "source": this.source }; }
                );
                if (fo.line) {
                    container = updateContainer(
                        container,
                        fo,
                        (fo) => { return `${fo.line}`; },
                        (fo) => { return { "file": fo.module, "line": fo.line, "source": this.source }; }
                    );
                };
            }
            else {
                container = updateContainer(
                    container,
                    fo,
                    (fo) => { return fo.scope; /*fo.module && fo.line ? `${fo.scope} (${fo.module})` : fo.scope;*/ },
                    (fo) => {
                        return {
                            file: fo.module,
                            name: fo.scope,
                            line: fo.line,
                            source: this.source
                        };
                    }
                );
            }
        });
    }

    private updateCallStack(frameList: FrameObject[], metric: number) {
        let stats: TopStats = this.callStack!;
        frameList.forEach((fo) => {
            let key = `${fo.module}:${fo.scope}`;
            let callee = stats.callees.getDefault(key, () => new TopStats(fo.scope, fo.module));
            callee.lines.add(fo.line);
            // stats?.total += metric;
            stats = callee;
        });
    }

    public setMetadata(key: string, value: string) {
        this.metadata.set(key, value);
    }

    public update(pid: number, tid: string, frames: FrameObject[], metric: number) {
        this.overallTotal += metric;

        this.updateLineMap(frames, metric);
        this.updateTop(frames, metric);
        this.updateHierarchy(pid, tid, frames, metric);
        this.updateCallStack(frames, metric);
    }

    public registerBeforeCallback(cb: () => void) {
        this._beforeCbs.push(cb);
    }


    public registerAfterCallback(cb: (stats: AustinStats) => void) {
        this._afterCbs.push(cb);
    }

    private finalize() {
        [...this.top.values()].forEach(v => { v.own /= this.overallTotal; v.total /= this.overallTotal; });
        this._afterCbs.forEach((cb) => cb(this));
    }

    public readFromBuffer(buffer: Buffer, fileName: string) {
        if (AustinRuntimeSettings.get().settings.binaryMode) {
            this.readFromMojoStream(buffer.values(), fileName);
        } else {
            let stream = new Readable();

            stream.push(buffer.toString());
            stream.push(null);

            this.readFromStream(stream, fileName);
        }
    }

    public readFromStream(stream: Readable, fileName: string) {
        this.source = fileName;
        this.clear();

        const readInterface = createInterface({
            input: stream
        });

        this._beforeCbs.forEach(cb => cb());

        readInterface.on("line", (line) => {
            if (line.length === 0) {
                return;
            }

            if (line.startsWith("#")) {
                let [key, value] = line.substring(2).split(": ", 2);
                this.setMetadata(key, value);
                return;
            }

            let [pidTidFrames, metric] = line.rsplit(" ", 1);
            let frames = pidTidFrames.split(";");
            let pid = frames.shift()!.substring(1);
            let tid = frames.shift()!.substring(1);
            this.update(Number(pid), tid, frames.map(parseFrame), Number(metric));
        });

        readInterface.on("close", this.finalize.bind(this));
    }

    readFromMojoStream(bytes: IterableIterator<number>, fileName: string) {
        this.source = fileName;
        this.clear();

        this._beforeCbs.forEach(cb => cb());

        new MojoParser(bytes).parseInto(this);

        this.finalize();
    }

    public readFromMojo(fileName: string) {
        readFile(fileName, (err, data) => {
            if (err) {
                vscode.window.showErrorMessage(`Error reading file: ${err}`);
                console.error(err);
                return;
            }

            this.readFromMojoStream(data.values(), fileName);
        });
    }

    public readFromFile(file: string) {
        readHead(file, 3).then((head) => {
            if (head === "MOJ") {
                this.readFromMojo(file);
            } else {
                this.readFromStream(createReadStream(file), file);
            }
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


export interface FrameObject {
    module: string;
    scope: string;
    line: number;
    lineEnd?: number;
    column?: number;
    columnEnd?: number;
};


function parseFrame(frame: string): FrameObject {
    let module: string, scope: string, line: string;
    [module, scope, line] = frame.rsplit(":", 2);

    return {
        scope: scope,
        line: Number(line),
        module: absolutePath(module),
    };
}


interface D3Hierarchy {
    name: string;
    value: number;
    children: D3Hierarchy[];
    data?: any;
}
