import { AustinStats, FrameObject } from "../model";
import { demangle } from "./demangle";

class IteratorDone extends Error {
    constructor() {
        super("done");
        this.name = this.constructor.name;
    }
}

function ord(c: string) {
    return c.charCodeAt(0);
}


const MOJO_VERSION = 4n;

/* MOJO Events */

const MOJO_EVENT = Object.freeze({
    "metadata": 1,
    "stack": 2,
    "frame": 3,
    "invalidFrame": 4,
    "frameReference": 5,
    "kernelFrame": 6,
    "gc": 7,
    "idle": 8,
    "time": 9,
    "memory": 10,
    "string": 11,
    "stringReference": 12,
    "stackRepeat": 13,
    "taskStack": 14,
    "taskWaiter": 15,
    "taskRunning": 16,
});

interface PendingTaskReport {
    taskId: string;
    frameCount: number;
    frames: FrameObject[];
}

interface FrameData {
    key: bigint;
    frame: FrameObject;
}


function specialFrame(label: string): FrameObject {
    return { scope: label, module: "", line: 0 };
}

function isPythonFrame(frame: FrameObject): boolean {
    return frame.module.endsWith('.py') || (frame.module.startsWith('<') && frame.module.endsWith('>'));
}

function stripTopNativeFrames(stack: FrameObject[]): FrameObject[] {
    let i = stack.length - 1;
    while (i >= 0 && !isPythonFrame(stack[i])) { i--; }
    return stack.slice(0, i + 1);
}

// Frame/string caches are keyed `${pid}:${key}` to keep different attached
// processes' otherwise-colliding numeric keys (they're raw addresses) apart.
// A task-graph frame/string can be pre-registered before the pid it belongs
// to has ever appeared on its own MOJO_STACK -- not just once at the very
// start of the capture (where `pid` is still the literal "null" it's
// initialised to), but potentially before EACH attached process's own first
// stack in a multi-process (--children) run, where `pid` at that point is
// left over from whichever process was sampled last, not "null". Falling
// back to a scan of every cached entry for that key is the last resort for
// that case: only reached once both the current pid and "null" have already
// missed, so it stays off the hot path.
function resolveAcrossPids<T>(cache: Map<string, T>, pid: bigint | null, key: bigint): T | undefined {
    const direct = cache.get(`${pid}:${key}`);
    if (direct !== undefined) {
        return direct;
    }
    const fallback = cache.get(`null:${key}`);
    if (fallback !== undefined) {
        return fallback;
    }
    const suffix = `:${key}`;
    for (const [k, v] of cache) {
        if (k.endsWith(suffix)) {
            return v;
        }
    }
    return undefined;
}

// Reads MOJO_TASK_STACK reports, the same way for MojoParser (pull,
// whole-buffer) and StreamingMojoParser (push, chunked). A report is a task's
// new position: its header gives the task, its name and how many of the
// frame references that follow are its frames; the thread's own follow after
// those. It carries no time: the time a task spends at a position is the time
// of its thread's samples while it holds it (see AustinStats.update). A report
// with no frames closes the task. Task ids are opaque, and unique to a task.
class TaskReportReader {
    private pending: PendingTaskReport | null = null;

    begin(
        taskId: bigint, nameKey: bigint, frameCount: bigint,
        stringRefs: Map<string, string>, currentPid: bigint | null, stats: AustinStats,
    ): void {
        const id = taskId.toString();
        if (nameKey !== 0n) {
            const name = resolveAcrossPids(stringRefs, currentPid, nameKey);
            if (name !== undefined) {
                stats.setTaskName(id, name);
            }
        }
        if (frameCount === 0n) {
            stats.closeTask(id);
            this.pending = null;
        } else {
            this.pending = { taskId: id, frameCount: Number(frameCount), frames: [] };
        }
    }

    // Takes the frame if a report is still waiting for frames, returning false
    // (having done nothing) otherwise, so the caller adds it to the thread's
    // own stack instead. A task's owning thread is the one whose sample the
    // report comes with.
    pushFrame(
        frame: FrameObject, currentPid: bigint | null, currentIid: bigint | null, currentTid: string | null,
        stats: AustinStats,
    ): boolean {
        if (!this.pending) {
            return false;
        }
        this.pending.frames.push(frame);
        if (this.pending.frames.length >= this.pending.frameCount) {
            if (currentPid !== null) {
                stats.updateTaskPosition(
                    this.pending.taskId, this.pending.frames, Number(currentPid), `${currentIid}:${currentTid}`,
                );
            }
            this.pending = null;
        }
        return true;
    }
}


export class MojoParser {
    private version: bigint;
    private mojo: IterableIterator<number>;

    constructor(mojo: IterableIterator<number>) {
        this.mojo = mojo;

        this.version = this.consumeHeader();
    }

    private consume() {
        let next = this.mojo.next();
        if (next.done) {
            throw new IteratorDone();
        }
        return next.value;
    }

    /* MOJO Data Types */

    private consumeVarInt(): bigint {
        let n: bigint = 0n;
        let s = 6n;
        let b = BigInt(this.consume());
        const sign = (b & 0x40n);

        n |= (b & 0x3Fn);
        while (b & 0x80n) {
            b = BigInt(this.consume());
            n |= ((b & 0x7Fn) << s);
            s += 7n;
        }

        return sign ? -n : n;
    }

    private consumeString(): string {
        let bs = [];

        while (true) {
            const b = this.consume();
            if (b === 0) {
                break;
            }
            bs.push(b);
        }

        return String.fromCharCode(...bs);
    }


    private consumeHeader(): bigint {
        if (this.consume() !== ord('M') || this.consume() !== ord('O') || this.consume() !== ord('J')) {
            throw new Error("Invalid header");
        }
        const version = this.consumeVarInt();
        if (version > MOJO_VERSION) {
            throw new Error(`Unsupported MOJO version: ${version}`);
        }
        return version;
    }

    private consumeMetadata() {
        return [this.consumeString(), this.consumeString()];
    }

    private consumeStack(): [bigint, bigint, string] {
        let pid = this.consumeVarInt();
        let iid = this.version >= 3n ? this.consumeVarInt() : 0n;
        let tid = this.consumeString();

        return [pid, iid, tid];
    }

    private consumeFrame(stringRefs: Map<string, string>, pid: bigint | null): FrameData {
        let key = this.consumeVarInt();

        let filenameKey = this.consumeVarInt();
        let scopeKey = this.consumeVarInt();

        let line = this.consumeVarInt();
        let lineEnd = 0n;
        let column = 0n;
        let columnEnd = 0n;

        if (this.version >= 2n) {
            lineEnd = this.consumeVarInt();
            column = this.consumeVarInt();
            columnEnd = this.consumeVarInt();
        }

        // See resolveAcrossPids: task-graph strings may have been cached
        // under a stale or "null" pid and are referenced again afterwards
        // under this frame's real one.
        let filename = resolveAcrossPids(stringRefs, pid, filenameKey);
        let scope = (scopeKey === 1n) ? "<unknown>" : resolveAcrossPids(stringRefs, pid, scopeKey);

        if (filename === undefined || scope === undefined) {
            throw new Error("Invalid string references in frame event");
        }

        return {
            key: key,
            frame: {
                module: filename,
                scope: demangle(scope),
                line: Number(line),
                lineEnd: Number(lineEnd),
                column: Number(column),
                columnEnd: Number(columnEnd),
            }
        };
    }

    private consumeKernel(): FrameObject {
        return {
            module: "kernel",
            scope: demangle(this.consumeString()),
            line: 0,
        };
    }

    public parseInto(stats: AustinStats) {
        let metadata = new Map<string, string>();
        let frameRefs = new Map<string, FrameObject>();
        let stringRefs = new Map<string, string>();

        let currentPid: bigint | null = null;
        let currentIid: bigint | null = null;
        let currentTid: string | null = null;
        let currentStack = new Array<FrameObject>();
        let currentStackKey: string | null = null;
        let currentTimeMetric = null;
        let currentMemoryMetric = null;
        let currentGC = false;
        let mode: string | null = null;

        let previousStacks = new Map<string, Array<FrameObject>>();
        let invalidFrame = false;
        // The task the current sample's thread is running (MOJO_TASK_RUNNING).
        let currentRunningTask: string | null = null;
        const taskReports = new TaskReportReader();

        try {
            while (true) {
                switch (this.consume()) {
                    case MOJO_EVENT.metadata:
                        let [k, v] = this.consumeMetadata();
                        metadata.set(k, v);
                        stats.setMetadata(k, v);
                        if (k === "mode") {
                            mode = v;
                        }
                        break;

                    case MOJO_EVENT.stack: {
                        // Finish the previous stack and update the stats
                        if (currentPid !== null) {
                            const metric = Number(mode === "memory" ? currentMemoryMetric! : currentTimeMetric!);
                            stats.update(
                                Number(currentPid),
                                `${currentIid}:${currentTid}`,
                                currentStack,
                                metric,
                                currentGC,
                                currentRunningTask,
                            );
                            // Save the current stack (without top native frames) for repeat/back-attribution
                            previousStacks.set(currentStackKey!, stripTopNativeFrames(currentStack));
                        }

                        [currentPid, currentIid, currentTid] = this.consumeStack();
                        currentStackKey = `${currentPid}:${currentIid}:${currentTid}`;
                        invalidFrame = false;

                        currentStack = [];
                        currentTimeMetric = null;
                        currentMemoryMetric = null;
                        currentGC = false;
                        currentRunningTask = null;

                        break;
                    }

                    case MOJO_EVENT.frame:
                        // currentPid may still be null here: task-graph frames (from a
                        // MOJO_TASK_STACK) can be emitted before the first MOJO_STACK of
                        // a freshly-attached process. Keying by pid (even "null") is still
                        // consistent, since the matching MOJO_STRING/MOJO_TASK_STACK events
                        // are emitted under the same pid context.
                        let frameData = this.consumeFrame(stringRefs, currentPid);
                        frameRefs.set(`${currentPid}:${frameData.key}`, frameData.frame);
                        break;

                    case MOJO_EVENT.invalidFrame:
                        if (previousStacks.has(currentStackKey!)) {
                            // Back-attribution
                            currentStack = previousStacks.get(currentStackKey!)!;
                            invalidFrame = true;
                        } else {
                            currentStack.push(specialFrame("INVALID"));
                        }
                        break;

                    case MOJO_EVENT.frameReference: {
                        // See resolveAcrossPids.
                        const refKey = this.consumeVarInt();
                        let frame = resolveAcrossPids(frameRefs, currentPid, refKey);
                        if (frame === undefined) {
                            throw new Error("Invalid frame reference");
                        }
                        if (!taskReports.pushFrame(frame, currentPid, currentIid, currentTid, stats) && !invalidFrame) {
                            currentStack.push(frame);
                        }
                        break;
                    }

                    case MOJO_EVENT.kernelFrame: {
                        let kernelFrame = this.consumeKernel();
                        if (!invalidFrame) {
                            currentStack.push(kernelFrame);
                        }
                        break;
                    }

                    case MOJO_EVENT.gc:
                        currentGC = true;
                        break;

                    case MOJO_EVENT.idle:
                        break;

                    case MOJO_EVENT.time:
                        currentTimeMetric = this.consumeVarInt();
                        break;

                    case MOJO_EVENT.memory:
                        currentMemoryMetric = this.consumeVarInt();
                        break;

                    case MOJO_EVENT.string:
                        let stringKey = this.consumeVarInt();
                        let stringValue = this.consumeString();
                        stringRefs.set(`${currentPid}:${stringKey}`, stringValue);
                        break;

                    case MOJO_EVENT.stackRepeat:
                        currentStack = [...(previousStacks.get(currentStackKey!) ?? []), ...currentStack];
                        break;

                    case MOJO_EVENT.taskStack: {
                        const taskId = this.consumeVarInt();
                        const nameKey = this.consumeVarInt();
                        const frameCount = this.consumeVarInt();
                        taskReports.begin(taskId, nameKey, frameCount, stringRefs, currentPid, stats);
                        break;
                    }

                    case MOJO_EVENT.taskWaiter: {
                        const taskId = this.consumeVarInt();
                        const waiterId = this.consumeVarInt();
                        // A waiter of 0 is no task: the task has no waiters any
                        // more. Task forests record who ever awaited a task,
                        // so there's nothing to add.
                        if (waiterId !== 0n) {
                            stats.updateTaskWaiter(taskId.toString(), waiterId.toString());
                        }
                        break;
                    }

                    case MOJO_EVENT.taskRunning:
                        currentRunningTask = this.consumeVarInt().toString();
                        break;

                    default:
                        throw new Error("Received unknown MOJO event");
                }
            }
        } catch (e) {
            if (e instanceof IteratorDone) {
                // Finish the last stack and update the stats
                if (currentPid !== null) {
                    const metric = Number(mode === "memory" ? currentMemoryMetric! : currentTimeMetric!);
                    stats.update(
                        Number(currentPid),
                        `${currentIid}:${currentTid}`,
                        currentStack,
                        metric,
                        currentGC,
                        currentRunningTask,
                    );
                }
                return;
            }

            throw e;
        }
    }
}

export class StreamingMojoParser {
    private pending: Buffer = Buffer.alloc(0);
    private offset = 0;
    private version: bigint | null = null;

    private frameRefs = new Map<string, FrameObject>();
    private stringRefs = new Map<string, string>();

    private currentPid: bigint | null = null;
    private currentIid: bigint | null = null;
    private currentTid: string | null = null;
    private currentStack: FrameObject[] = [];
    private currentStackKey: string | null = null;
    private currentTimeMetric: bigint | null = null;
    private currentMemoryMetric: bigint | null = null;
    private mode: string | null = null;
    private previousStacks = new Map<string, FrameObject[]>();
    private invalidFrame = false;
    private currentGC = false;
    // The task the current sample's thread is running (MOJO_TASK_RUNNING).
    private currentRunningTask: string | null = null;
    private taskReports = new TaskReportReader();

    constructor(private readonly stats: AustinStats) { }

    private consume(): number {
        if (this.offset >= this.pending.length) {
            throw new IteratorDone();
        }
        return this.pending[this.offset++];
    }

    private consumeVarInt(): bigint {
        let n: bigint = 0n;
        let s = 6n;
        let b = BigInt(this.consume());
        const sign = (b & 0x40n);
        n |= (b & 0x3Fn);
        while (b & 0x80n) {
            b = BigInt(this.consume());
            n |= ((b & 0x7Fn) << s);
            s += 7n;
        }
        return sign ? -n : n;
    }

    private consumeString(): string {
        const bs: number[] = [];
        while (true) {
            const b = this.consume();
            if (b === 0) { break; }
            bs.push(b);
        }
        return String.fromCharCode(...bs);
    }

    private consumeHeader(): void {
        if (this.consume() !== ord('M') || this.consume() !== ord('O') || this.consume() !== ord('J')) {
            throw new Error("Invalid MOJO header");
        }
        const version = this.consumeVarInt();
        if (version > MOJO_VERSION) {
            throw new Error(`Unsupported MOJO version: ${version}`);
        }
        this.version = version;
    }

    private consumeFrame(): FrameData {
        const key = this.consumeVarInt();
        const filenameKey = this.consumeVarInt();
        const scopeKey = this.consumeVarInt();
        const line = this.consumeVarInt();
        let lineEnd = 0n, column = 0n, columnEnd = 0n;
        if (this.version! >= 2n) {
            lineEnd = this.consumeVarInt();
            column = this.consumeVarInt();
            columnEnd = this.consumeVarInt();
        }
        // See resolveAcrossPids.
        const filename = resolveAcrossPids(this.stringRefs, this.currentPid, filenameKey);
        const rawScope = (scopeKey === 1n) ? "<unknown>" : resolveAcrossPids(this.stringRefs, this.currentPid, scopeKey);
        if (filename === undefined || rawScope === undefined) {
            throw new Error("Invalid string references in frame event");
        }
        return {
            key,
            frame: {
                module: filename,
                scope: demangle(rawScope),
                line: Number(line),
                lineEnd: Number(lineEnd),
                column: Number(column),
                columnEnd: Number(columnEnd),
            }
        };
    }

    private processOneEvent(): void {
        switch (this.consume()) {
            case MOJO_EVENT.metadata: {
                const k = this.consumeString();
                const v = this.consumeString();
                this.stats.setMetadata(k, v);
                if (k === "mode") { this.mode = v; }
                break;
            }
            case MOJO_EVENT.stack: {
                // Read all new state before committing the old sample.
                // If any read throws IteratorDone mid-event, the offset rolls
                // back to the tag byte and no state changes take effect.
                const newPid = this.consumeVarInt();
                const newIid = this.version! >= 3n ? this.consumeVarInt() : 0n;
                const newTid = this.consumeString();
                if (this.currentPid !== null) {
                    const metric = Number(this.mode === "memory" ? this.currentMemoryMetric! : this.currentTimeMetric!);
                    this.stats.update(
                        Number(this.currentPid),
                        `${this.currentIid}:${this.currentTid}`,
                        this.currentStack,
                        metric,
                        this.currentGC,
                        this.currentRunningTask,
                    );
                    this.previousStacks.set(this.currentStackKey!, stripTopNativeFrames(this.currentStack));
                }
                this.currentPid = newPid;
                this.currentIid = newIid;
                this.currentTid = newTid;
                this.currentStackKey = `${newPid}:${newIid}:${newTid}`;
                this.currentStack = [];
                this.currentTimeMetric = null;
                this.currentMemoryMetric = null;
                this.invalidFrame = false;
                this.currentGC = false;
                this.currentRunningTask = null;
                break;
            }
            case MOJO_EVENT.frame: {
                // currentPid may still be null: see the matching comment in MojoParser.
                const fd = this.consumeFrame();
                this.frameRefs.set(`${this.currentPid}:${fd.key}`, fd.frame);
                break;
            }
            case MOJO_EVENT.invalidFrame: {
                if (this.previousStacks.has(this.currentStackKey!)) {
                    this.currentStack = this.previousStacks.get(this.currentStackKey!)!;
                    this.invalidFrame = true;
                } else {
                    this.currentStack.push(specialFrame("INVALID"));
                }
                break;
            }
            case MOJO_EVENT.frameReference: {
                // See resolveAcrossPids.
                const refKey = this.consumeVarInt();
                const frame = resolveAcrossPids(this.frameRefs, this.currentPid, refKey);
                if (frame === undefined) {
                    throw new Error("Invalid frame reference");
                }
                if (
                    !this.taskReports.pushFrame(frame, this.currentPid, this.currentIid, this.currentTid, this.stats)
                    && !this.invalidFrame
                ) {
                    this.currentStack.push(frame);
                }
                break;
            }
            case MOJO_EVENT.kernelFrame: {
                const kf = { module: "kernel", scope: demangle(this.consumeString()), line: 0 };
                if (!this.invalidFrame) {
                    this.currentStack.push(kf);
                }
                break;
            }
            case MOJO_EVENT.gc:
                this.currentGC = true;
                break;
            case MOJO_EVENT.idle:
                break;
            case MOJO_EVENT.time:
                this.currentTimeMetric = this.consumeVarInt();
                break;
            case MOJO_EVENT.memory:
                this.currentMemoryMetric = this.consumeVarInt();
                break;
            case MOJO_EVENT.string: {
                const k = this.consumeVarInt();
                const v = this.consumeString();
                this.stringRefs.set(`${this.currentPid}:${k}`, v);
                break;
            }
            case MOJO_EVENT.stackRepeat:
                this.currentStack = [...(this.previousStacks.get(this.currentStackKey!) ?? []), ...this.currentStack];
                break;
            case MOJO_EVENT.taskStack: {
                const taskId = this.consumeVarInt();
                const nameKey = this.consumeVarInt();
                const frameCount = this.consumeVarInt();
                this.taskReports.begin(taskId, nameKey, frameCount, this.stringRefs, this.currentPid, this.stats);
                break;
            }
            case MOJO_EVENT.taskWaiter: {
                const taskId = this.consumeVarInt();
                const waiterId = this.consumeVarInt();
                // See the matching comment in MojoParser.
                if (waiterId !== 0n) {
                    this.stats.updateTaskWaiter(taskId.toString(), waiterId.toString());
                }
                break;
            }
            case MOJO_EVENT.taskRunning:
                this.currentRunningTask = this.consumeVarInt().toString();
                break;
            default:
                throw new Error("Unknown MOJO event");
        }
    }

    push(chunk: Buffer): void {
        this.pending = Buffer.concat([this.pending.slice(this.offset), chunk]);
        this.offset = 0;

        if (this.version === null) {
            const checkpoint = this.offset;
            try {
                this.consumeHeader();
            } catch (e) {
                if (e instanceof IteratorDone) {
                    this.offset = checkpoint;
                    return;
                }
                throw e;
            }
        }

        while (true) {
            const checkpoint = this.offset;
            try {
                this.processOneEvent();
            } catch (e) {
                if (e instanceof IteratorDone) {
                    this.offset = checkpoint;
                    break;
                }
                throw e;
            }
        }
    }

    finalize(): void {
        if (this.currentPid !== null) {
            const metric = Number(this.mode === "memory" ? this.currentMemoryMetric! : this.currentTimeMetric!);
            this.stats.update(
                Number(this.currentPid),
                `${this.currentIid}:${this.currentTid}`,
                this.currentStack,
                metric,
                this.currentGC,
                this.currentRunningTask,
            );
        }
    }
}
