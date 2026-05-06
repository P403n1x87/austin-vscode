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
});

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

    private consumeFrame(stringRefs: Map<string, string>, pid: bigint): FrameData {
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

        let filename = stringRefs.get(`${pid}:${filenameKey}`);
        let scope = (scopeKey === 1n) ? "<unknown>" : stringRefs.get(`${pid}:${scopeKey}`);

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
        let currentIdle = false;
        let currentGC = false;
        let mode: string | null = null;

        let previousStacks = new Map<string, Array<FrameObject>>();
        let invalidFrame = false;

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

                    case MOJO_EVENT.stack:
                        // Finish the previous stack and update the stats
                        if (currentPid !== null) {
                            stats.update(
                                Number(currentPid),
                                `${currentIid}:${currentTid}`,
                                currentStack,
                                Number(mode === "memory" ? currentMemoryMetric! : currentTimeMetric!),
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
                        currentIdle = false;
                        currentGC = false;

                        break;

                    case MOJO_EVENT.frame:
                        if (currentPid === null) {
                            throw new Error("Frame event before stack event");
                        }
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

                    case MOJO_EVENT.frameReference:
                        let key = `${currentPid}:${this.consumeVarInt()}`;
                        if (!invalidFrame) {
                            currentStack.push(frameRefs.get(key)!);
                        }
                        break;

                    case MOJO_EVENT.kernelFrame:
                        let kernelFrame = this.consumeKernel();
                        if (!invalidFrame) {
                            currentStack.push(kernelFrame);
                        }
                        break;

                    case MOJO_EVENT.gc:
                        currentGC = true;
                        break;

                    case MOJO_EVENT.idle:
                        currentIdle = true;
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

                    default:
                        throw new Error("Received unknown MOJO event");
                }
            }
        } catch (e) {
            if (e instanceof IteratorDone) {
                // Finish the last stack and update the stats
                if (currentPid !== null) {
                    stats.update(
                        Number(currentPid),
                        `${currentIid}:${currentTid}`,
                        currentStack,
                        Number(mode === "memory" ? currentMemoryMetric! : currentTimeMetric!),
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
        const filename = this.stringRefs.get(`${this.currentPid}:${filenameKey}`);
        const rawScope = (scopeKey === 1n) ? "<unknown>" : this.stringRefs.get(`${this.currentPid}:${scopeKey}`);
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
                    this.stats.update(
                        Number(this.currentPid),
                        `${this.currentIid}:${this.currentTid}`,
                        this.currentStack,
                        Number(this.mode === "memory" ? this.currentMemoryMetric! : this.currentTimeMetric!),
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
                if (this.currentPid === null) { throw new Error("Frame before stack"); }
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
                const key = `${this.currentPid}:${this.consumeVarInt()}`;
                if (!this.invalidFrame) {
                    this.currentStack.push(this.frameRefs.get(key)!);
                }
                break;
            }
            case MOJO_EVENT.kernelFrame: {
                const kf = { module: "kernel", scope: demangle(this.consumeString()), line: 0 };
                if (!this.invalidFrame) { this.currentStack.push(kf); }
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
            this.stats.update(
                Number(this.currentPid),
                `${this.currentIid}:${this.currentTid}`,
                this.currentStack,
                Number(this.mode === "memory" ? this.currentMemoryMetric! : this.currentTimeMetric!),
                this.currentGC,
            );
        }
    }
}
