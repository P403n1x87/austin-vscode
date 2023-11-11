import { AustinStats, FrameObject } from "../model";

class IteratorDone extends Error {
    constructor() {
        super("done");
        this.name = this.constructor.name;
    }
}

function ord(c: string) {
    return c.charCodeAt(0);
}


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
});

interface FrameData {
    key: bigint;
    frame: FrameObject;
}


function specialFrame(label: string): FrameObject {
    return { scope: label, module: "", line: 0 };
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
        return this.consumeVarInt();
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
                scope: scope,
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
            scope: this.consumeString(),
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
        let currentTimeMetric = null;
        let currentMemoryMetric = null;
        let currentIdle = false;
        let currentGC = false;
        let mode: string | null = null;

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
                            );
                        }

                        [currentPid, currentIid, currentTid] = this.consumeStack();
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
                        currentStack.push(specialFrame("INVALID"));
                        break;

                    case MOJO_EVENT.frameReference:
                        let key = `${currentPid}:${this.consumeVarInt()}`;
                        currentStack.push(frameRefs.get(key)!);
                        break;

                    case MOJO_EVENT.kernelFrame:
                        currentStack.push(this.consumeKernel());
                        break;

                    case MOJO_EVENT.gc:
                        currentStack.push(specialFrame("GC"));
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
                    );
                }
                return;
            }

            throw e;
        }
    }
}
