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
});

interface PendingTaskStack {
    taskId: bigint;
    frames: FrameObject[];
    // Real dwell time (MOJO_METRIC_TIME), when the capture is new enough to
    // carry one after the frame sequence. Per the MOJO_TASK_STACK doc comment
    // in austin's mojo.h, this describes how long the task dwelled at the
    // frame it just *left* -- i.e. the *previous* MOJO_TASK_STACK block for
    // this task, not this one's `frames` (Austin can only ever unwind the
    // task's current live frame chain, so the metric it can flush at that
    // point necessarily lags one block behind). Older captures never emit
    // this at all, so this stays null and the caller falls back to an
    // interval-based approximation applied directly to `frames`.
    metric: bigint | null;
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

// A task's id on the wire is really just the awaitable object's raw memory
// address, which CPython's allocator is free to hand to a brand new,
// unrelated Task once the original is freed -- Austin faithfully reports
// both occurrences under that same numeric id. Using the raw id as-is
// throughout would make the model see a SECOND task's data as more data
// for the FIRST (now-dead) one -- e.g. its waiter set gaining a bogus extra
// entry, which can make an unrelated later task get misattributed as a
// child of a task that finished long ago.
//
// close() is called on the empty-frames closing/eviction signal (see the
// MOJO_TASK_STACK doc comment in austin's mojo.h) -- the wire's own
// "this task is done" signal -- and bumps a generation counter for that
// raw id; resolve() folds the generation into the id whenever it's
// nonzero, so a later reuse of the same raw address resolves to a
// distinct logical id instead of colliding with the original task's.
class TaskIdRemapper {
    private generation = new Map<string, number>();

    resolve(rawId: string): string {
        const gen = this.generation.get(rawId) ?? 0;
        return gen === 0 ? rawId : `${rawId}#${gen}`;
    }

    close(rawId: string): void {
        this.generation.set(rawId, (this.generation.get(rawId) ?? 0) + 1);
    }
}

// Everything about buffering and flushing one in-flight MOJO_TASK_STACK block
// -- the part of task-graph parsing that's identical between MojoParser
// (pull, whole-buffer) and StreamingMojoParser (push, chunked): both just
// need somewhere to accumulate frames between a taskStack event and whatever
// closes it (the next taskStack/taskWaiter/stack event, a trailing
// MOJO_METRIC_TIME, or end of stream), and the exact same rules for when a
// flush should actually report data to AustinStats (see flush's own
// comments). The two parsers differ in how they consume bytes, not in any of
// this -- that consumption-mechanics difference is why they still each drive
// this class from their own event-handling loop instead of sharing that too.
class TaskStackTracker {
    private pending: PendingTaskStack | null = null;
    // Per task, the most recent MOJO_TASK_STACK block's frames that haven't
    // yet been weighted -- they're waiting on the *next* block's trailing
    // metric, which describes dwell time at this (previous) block, not its
    // own. See PendingTaskStack.metric. Keyed by the RAW id: purely a
    // parsing-internal buffer for the CURRENT incarnation, already correctly
    // cleared on that incarnation's closing signal.
    private carry = new Map<string, FrameObject[]>();
    private taskIds = new TaskIdRemapper();

    get isPending(): boolean {
        return this.pending !== null;
    }

    // Resolves a raw wire task id to its logical (generation-aware) id --
    // see TaskIdRemapper. Used directly for MOJO_TASK_WAITER, which has no
    // frames of its own to buffer.
    resolve(rawId: string): string {
        return this.taskIds.resolve(rawId);
    }

    // Appends to the pending block if one is open; returns false (having done
    // nothing) if there isn't one, so the caller falls back to its own
    // regular-sample handling.
    pushFrame(frame: FrameObject): boolean {
        if (!this.pending) {
            return false;
        }
        this.pending.frames.push(frame);
        return true;
    }

    // Starts a new pending block for taskId. The caller must flush() any
    // previous one first (a MOJO_TASK_STACK's own frames are for THIS
    // incarnation, not whatever was still open).
    begin(taskId: bigint, nameKey: bigint, stringRefs: Map<string, string>, currentPid: bigint | null, stats: AustinStats): void {
        if (nameKey !== 0n) {
            const name = resolveAcrossPids(stringRefs, currentPid, nameKey);
            if (name !== undefined) {
                stats.setTaskName(this.resolve(taskId.toString()), name);
            }
        }
        this.pending = { taskId, frames: [], metric: null };
    }

    // A trailing MOJO_METRIC_TIME always closes the pending block immediately
    // (see the taskStack/time event handling in both parsers): on the wire,
    // nothing else task-related necessarily follows it before the enclosing
    // sample's own regular frames, which must not get misattributed into it.
    setMetricAndFlush(value: bigint, currentPid: bigint | null, currentIid: bigint | null, currentTid: string | null, stats: AustinStats): void {
        if (!this.pending) {
            return;
        }
        this.pending.metric = value;
        this.flush(currentPid, currentIid, currentTid, stats);
    }

    flush(currentPid: bigint | null, currentIid: bigint | null, currentTid: string | null, stats: AustinStats): void {
        if (!this.pending) {
            return;
        }
        const rawId = this.pending.taskId.toString();
        const taskId = this.resolve(rawId);
        const isClosing = this.pending.frames.length === 0;
        // A task's owning thread isn't tagged on the wire: it's implicit in
        // position, since a MOJO_TASK_STACK only ever arrives bracketed
        // within the MOJO_STACK it belongs to and the next one -- so
        // whichever sample is current right now, before the next MOJO_STACK
        // reassigns it, is this task's owner. Skipped for an empty frame
        // sequence (the closing/eviction flush, see below): there's no new
        // content there, so no owner to (re)attribute.
        if (this.pending.frames.length > 0 && currentPid !== null) {
            stats.setTaskOwner(taskId, Number(currentPid), `${currentIid}:${currentTid}`);
        }
        if (this.pending.metric === null) {
            // No real timing on the wire at all (older capture): weight this
            // single observation directly with the fallback approximation.
            // Skip the empty-frame closing/eviction signal itself -- like the
            // metric-carrying branch below, it has no new content to weight,
            // and reporting it would inflate the task's duration by one
            // bogus fallback-interval unit for nothing.
            if (this.pending.frames.length > 0) {
                stats.updateTaskStack(taskId, this.pending.frames, null);
            }
        } else {
            const carried = this.carry.get(rawId);
            if (carried) {
                stats.updateTaskStack(taskId, carried, Number(this.pending.metric));
            }
            // An empty frame sequence is a closing signal (Austin flushing a
            // task's final dwell time on eviction, see mojo.h's
            // MOJO_TASK_STACK doc comment) -- nothing more will ever arrive
            // for this task, so don't carry it forward as if it were a new,
            // still-unweighted observation.
            if (this.pending.frames.length > 0) {
                this.carry.set(rawId, this.pending.frames);
            } else {
                this.carry.delete(rawId);
            }
        }
        // Bump AFTER reporting this flush (above), which must still resolve
        // to the incarnation that's closing -- only a LATER reference to
        // this same raw id should see a fresh one.
        if (isClosing) {
            this.taskIds.close(rawId);
        }
        this.pending = null;
    }

    // Any still-carried frames at end of stream are the last frame chain
    // ever observed for that task -- its true dwell time was never flushed
    // (the task was still there when sampling stopped), so fall back to the
    // interval-based approximation rather than losing it.
    flushCarry(stats: AustinStats): void {
        for (const [rawId, frames] of this.carry) {
            stats.updateTaskStack(this.resolve(rawId), frames, null);
        }
        this.carry.clear();
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
        const taskTracker = new TaskStackTracker();

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
                        taskTracker.flush(currentPid, currentIid, currentTid, stats);
                        // Finish the previous stack and update the stats
                        if (currentPid !== null) {
                            const metric = Number(mode === "memory" ? currentMemoryMetric! : currentTimeMetric!);
                            stats.update(
                                Number(currentPid),
                                `${currentIid}:${currentTid}`,
                                currentStack,
                                metric,
                                currentGC,
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
                        if (!taskTracker.pushFrame(specialFrame("INVALID"))) {
                            if (previousStacks.has(currentStackKey!)) {
                                // Back-attribution
                                currentStack = previousStacks.get(currentStackKey!)!;
                                invalidFrame = true;
                            } else {
                                currentStack.push(specialFrame("INVALID"));
                            }
                        }
                        break;

                    case MOJO_EVENT.frameReference: {
                        // See resolveAcrossPids.
                        const refKey = this.consumeVarInt();
                        let frame = resolveAcrossPids(frameRefs, currentPid, refKey);
                        if (frame === undefined) {
                            throw new Error("Invalid frame reference");
                        }
                        if (!taskTracker.pushFrame(frame) && !invalidFrame) {
                            currentStack.push(frame);
                        }
                        break;
                    }

                    case MOJO_EVENT.kernelFrame: {
                        let kernelFrame = this.consumeKernel();
                        if (!taskTracker.pushFrame(kernelFrame) && !invalidFrame) {
                            currentStack.push(kernelFrame);
                        }
                        break;
                    }

                    case MOJO_EVENT.gc:
                        currentGC = true;
                        break;

                    case MOJO_EVENT.idle:
                        break;

                    case MOJO_EVENT.time: {
                        const value = this.consumeVarInt();
                        if (taskTracker.isPending) {
                            taskTracker.setMetricAndFlush(value, currentPid, currentIid, currentTid, stats);
                        } else {
                            currentTimeMetric = value;
                        }
                        break;
                    }

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
                        taskTracker.flush(currentPid, currentIid, currentTid, stats);
                        taskTracker.begin(taskId, nameKey, stringRefs, currentPid, stats);
                        break;
                    }

                    case MOJO_EVENT.taskWaiter: {
                        const taskId = this.consumeVarInt();
                        const waiterId = this.consumeVarInt();
                        taskTracker.flush(currentPid, currentIid, currentTid, stats);
                        stats.updateTaskWaiter(taskTracker.resolve(taskId.toString()), taskTracker.resolve(waiterId.toString()));
                        break;
                    }

                    default:
                        throw new Error("Received unknown MOJO event");
                }
            }
        } catch (e) {
            if (e instanceof IteratorDone) {
                taskTracker.flush(currentPid, currentIid, currentTid, stats);
                taskTracker.flushCarry(stats);
                // Finish the last stack and update the stats
                if (currentPid !== null) {
                    const metric = Number(mode === "memory" ? currentMemoryMetric! : currentTimeMetric!);
                    stats.update(
                        Number(currentPid),
                        `${currentIid}:${currentTid}`,
                        currentStack,
                        metric,
                        currentGC,
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
    private taskTracker = new TaskStackTracker();

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
                this.taskTracker.flush(this.currentPid, this.currentIid, this.currentTid, this.stats);
                if (this.currentPid !== null) {
                    const metric = Number(this.mode === "memory" ? this.currentMemoryMetric! : this.currentTimeMetric!);
                    this.stats.update(
                        Number(this.currentPid),
                        `${this.currentIid}:${this.currentTid}`,
                        this.currentStack,
                        metric,
                        this.currentGC,
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
                break;
            }
            case MOJO_EVENT.frame: {
                // currentPid may still be null: see the matching comment in MojoParser.
                const fd = this.consumeFrame();
                this.frameRefs.set(`${this.currentPid}:${fd.key}`, fd.frame);
                break;
            }
            case MOJO_EVENT.invalidFrame: {
                if (!this.taskTracker.pushFrame(specialFrame("INVALID"))) {
                    if (this.previousStacks.has(this.currentStackKey!)) {
                        this.currentStack = this.previousStacks.get(this.currentStackKey!)!;
                        this.invalidFrame = true;
                    } else {
                        this.currentStack.push(specialFrame("INVALID"));
                    }
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
                if (!this.taskTracker.pushFrame(frame) && !this.invalidFrame) {
                    this.currentStack.push(frame);
                }
                break;
            }
            case MOJO_EVENT.kernelFrame: {
                const kf = { module: "kernel", scope: demangle(this.consumeString()), line: 0 };
                if (!this.taskTracker.pushFrame(kf) && !this.invalidFrame) {
                    this.currentStack.push(kf);
                }
                break;
            }
            case MOJO_EVENT.gc:
                this.currentGC = true;
                break;
            case MOJO_EVENT.idle:
                break;
            case MOJO_EVENT.time: {
                const value = this.consumeVarInt();
                if (this.taskTracker.isPending) {
                    this.taskTracker.setMetricAndFlush(value, this.currentPid, this.currentIid, this.currentTid, this.stats);
                } else {
                    this.currentTimeMetric = value;
                }
                break;
            }
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
                this.taskTracker.flush(this.currentPid, this.currentIid, this.currentTid, this.stats);
                this.taskTracker.begin(taskId, nameKey, this.stringRefs, this.currentPid, this.stats);
                break;
            }
            case MOJO_EVENT.taskWaiter: {
                const taskId = this.consumeVarInt();
                const waiterId = this.consumeVarInt();
                this.taskTracker.flush(this.currentPid, this.currentIid, this.currentTid, this.stats);
                this.stats.updateTaskWaiter(this.taskTracker.resolve(taskId.toString()), this.taskTracker.resolve(waiterId.toString()));
                break;
            }
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
        this.taskTracker.flush(this.currentPid, this.currentIid, this.currentTid, this.stats);
        this.taskTracker.flushCarry(this.stats);
        if (this.currentPid !== null) {
            const metric = Number(this.mode === "memory" ? this.currentMemoryMetric! : this.currentTimeMetric!);
            this.stats.update(
                Number(this.currentPid),
                `${this.currentIid}:${this.currentTid}`,
                this.currentStack,
                metric,
                this.currentGC,
            );
        }
    }
}
