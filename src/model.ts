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
import { demangle } from './utils/demangle';


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
    public rawOwn: number = 0;
    public rawTotal: number = 0;
    public rawCallerContributions: Map<string, number> = new Map();
    public callees: Map<string, TopStats> = new Map();
    public callers: Map<string, TopStats> = new Map();
    public callerContributions: Map<string, number> = new Map();
    public minLine: number = 0;

    public constructor(scope: string | null = null, module: string | null = null) {
        this.scope = scope;
        this.module = module;
    }

    key() {
        return `${this.module}:${this.scope}`;
    }
}

export interface GCEvent {
    pid: number;
    tid: string;
    gc: boolean;
    metric: number;
    frameKeys: string[];  // `${module}:${scope}` for each frame in the sample
}

export interface AustinStats {
    hierarchy: FlameNode;
    locationMap: Map<string, Map<string, [FrameObject, number, number]>>;
    callStack: TopStats;
    top: Map<string, TopStats>;
    overallTotal: number;
    source: string | null;
    metadata: Map<string, string>;
    gcEvents: GCEvent[];
}

export class AustinStats implements AustinStats {

    public paused: boolean = false;
    private _beforeCbs: (() => void)[];
    private _afterCbs: ((stats: AustinStats) => void)[];
    private _errorCbs: (() => void)[];

    public constructor() {
        this.locationMap = new Map();
        this.overallTotal = 0;
        this.top = new Map();
        this.hierarchy = {
            kind: 'root',
            key: "",
            name: "",
            value: 0,
            children: [],
        };
        this.callStack = new TopStats();
        this._beforeCbs = [];
        this._afterCbs = [];
        this._errorCbs = [];
        this.source = null;
        this.metadata = new Map();
        this.gcEvents = [];
    }

    clear() {
        this.top.clear();
        this.locationMap.clear();
        this.overallTotal = 0;
        this.hierarchy = {
            kind: 'root',
            key: "",
            name: this.source!,
            value: 0,
            children: [],
        };
        this.callStack = new TopStats();
        this.metadata = new Map();
        this.gcEvents = [];
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
            topStats.rawTotal += metric;
            if (fo.line > 0 && (topStats.minLine === 0 || fo.line < topStats.minLine)) { topStats.minLine = fo.line; }
            if (caller) {
                const callerKey = caller.key();
                if (!topStats.callers.has(callerKey)) {
                    topStats.callers.set(callerKey, caller);
                }
                topStats.rawCallerContributions.set(callerKey, (topStats.rawCallerContributions.get(callerKey) ?? 0) + metric);
            }
            caller = topStats;
        });

        // Set own time to the top of the stack
        fo = frameList[frameList.length - 1];
        let key = `${fo.module}:${fo.scope}`;
        stats.get(key)!.rawOwn += metric;
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

        const updateContainer = (container: FlameNode[], frame: FrameObject) => {
            const key = `${frame.module}:${frame.scope}`;
            for (const e of container) {
                if (e.key === key) {
                    e.value += metric;
                    return e.children;
                }
            }
            const children: FlameNode[] = [];
            container.push({
                kind: 'frame',
                key,
                name: frame.scope,
                value: metric,
                children,
                file: frame.module,
                line: frame.line,
                source: this.source,
            });
            return children;
        };

        const getGroupContainer = (kind: 'process' | 'thread', name: string, container: FlameNode[]) => {
            for (const e of container) {
                if (e.key === name) {
                    e.value += metric;
                    return e.children;
                }
            }
            const children: FlameNode[] = [];
            container.push({ kind, key: name, name, value: metric, children });
            return children;
        };

        let container = getGroupContainer('thread', `Thread ${tid}`, getGroupContainer('process', `Process ${pid}`, stats.children));

        frameList.forEach((fo) => {
            container = updateContainer(container, fo);
        });
    }

    private updateCallStack(pid: number, tid: string, frameList: FrameObject[], metric: number) {
        const processNode = this.callStack.callees.getDefault(pid.toString(), () => new TopStats(`Process ${pid}`, ""));
        processNode.rawTotal += metric;
        let current = processNode.callees.getDefault(tid, () => new TopStats(`Thread ${tid}`, ""));
        current.rawTotal += metric;

        frameList.forEach((fo, idx) => {
            const key = `${fo.module}:${fo.scope}`;
            const callee = current.callees.getDefault(key, () => new TopStats(fo.scope, fo.module));
            if (fo.line > 0 && (callee.minLine === 0 || fo.line < callee.minLine)) { callee.minLine = fo.line; }
            callee.rawTotal += metric;
            if (idx === frameList.length - 1) {
                callee.rawOwn += metric;
            }
            current = callee;
        });
    }

    private normalizeAll() {
        if (this.overallTotal === 0) { return; }
        const total = this.overallTotal;
        for (const s of this.top.values()) {
            s.own = s.rawOwn / total;
            s.total = s.rawTotal / total;
            for (const [k, v] of s.rawCallerContributions) {
                s.callerContributions.set(k, v / total);
            }
        }
        const queue: TopStats[] = [...this.callStack.callees.values()];
        while (queue.length > 0) {
            const node = queue.pop()!;
            node.own = node.rawOwn / total;
            node.total = node.rawTotal / total;
            for (const child of node.callees.values()) {
                queue.push(child);
            }
        }
    }

    public setMetadata(key: string, value: string) {
        this.metadata.set(key, value);
    }

    public update(pid: number, tid: string, frames: FrameObject[], metric: number, gc: boolean = false) {
        if (metric > 0) {
            this.overallTotal += metric;
        }

        this.gcEvents.push({
            pid,
            tid,
            gc,
            metric,
            frameKeys: frames.map(f => `${f.module}:${f.scope}`),
        });

        this.updateLineMap(frames, metric);
        this.updateTop(frames, metric);
        this.updateHierarchy(pid, tid, frames, metric);
        this.updateCallStack(pid, tid, frames, metric);
    }

    public registerBeforeCallback(cb: () => void) {
        this._beforeCbs.push(cb);
    }


    public registerAfterCallback(cb: (stats: AustinStats) => void) {
        this._afterCbs.push(cb);
    }

    public registerOnceAfterCallback(cb: (stats: AustinStats) => void) {
        const wrapper = (stats: AustinStats) => {
            cb(stats);
            this._afterCbs = this._afterCbs.filter(c => c !== wrapper);
        };
        this._afterCbs.push(wrapper);
    }

    public registerErrorCallback(cb: () => void) {
        this._errorCbs.push(cb);
    }

    public notifyError() {
        this._errorCbs.forEach(cb => cb());
    }

    public begin(fileName: string) {
        this.source = fileName;
        this.clear();
        this._beforeCbs.forEach(cb => cb());
    }

    public refresh() {
        this.normalizeAll();
        this._afterCbs.forEach(cb => cb(this));
    }

    private finalize() {
        this.refresh();
    }

    public readFromBuffer(buffer: Buffer, fileName: string) {
        if (buffer.length >= 3 && buffer.slice(0, 3).toString() === "MOJ") {
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
            const parsedFrames = frames.map(parseFrame);
            const gc = parsedFrames.some(f => f.module === "" && f.scope === "GC");
            this.update(Number(pid), tid, parsedFrames.filter(f => !(f.module === "" && f.scope === "GC")), Number(metric), gc);
        });

        readInterface.on("close", this.finalize.bind(this));
    }

    readFromMojoStream(bytes: IterableIterator<number>, fileName: string) {
        this.source = fileName;
        this.clear();

        this._beforeCbs.forEach(cb => cb());

        try {
            new MojoParser(bytes).parseInto(this);
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to parse MOJO profile: ${err instanceof Error ? err.message : err}`);
            console.error(err);
            return;
        }

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
        scope: demangle(scope),
        line: Number(line),
        module: absolutePath(module),
    };
}


export type FlameNodeKind = 'root' | 'process' | 'thread' | 'frame';

export interface FlameNode {
    kind: FlameNodeKind;
    key: string;
    name: string;
    value: number;
    children: FlameNode[];
    // Frame-specific fields (only present when kind === 'frame'):
    file?: string;
    line?: number;
    source?: string | null;
    // Added by the webview frontend during rendering:
    pathKey?: string;
}
