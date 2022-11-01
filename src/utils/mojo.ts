import * as vscode from 'vscode';
import { AustinStats } from "../model";

class IteratorDone extends Error {
    constructor() {
        super("done");
        this.name = this.constructor.name;
    }
}

function ord(c: string) {
    return c.charCodeAt(0);
}

function consume(mojo: IterableIterator<number>) {
    let next = mojo.next();
    if (next.done) {
        throw new IteratorDone();
    }
    return next.value;
}

/* MOJO Data Types */

function consumeVarInt(mojo: IterableIterator<number>): bigint {
    let n: bigint = 0n;
    let s = 6n;
    let b = BigInt(consume(mojo));
    const sign = (b & 0x40n);

    n |= (b & 0x3Fn);
    while (b & 0x80n) {
        b = BigInt(consume(mojo));
        n |= ((b & 0x7Fn) << s);
        s += 7n;
    }

    return sign ? -n : n;
}

function consumeString(mojo: IterableIterator<number>): string {
    let bs = [];

    while (true) {
        const b = consume(mojo);
        if (b === 0) {
            break;
        }
        bs.push(b);
    }

    return String.fromCharCode(...bs);
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

function consumeHeader(mojo: IterableIterator<number>): bigint {
    if (consume(mojo) !== ord('M') || consume(mojo) !== ord('O') || consume(mojo) !== ord('J')) {
        throw new Error("Invalid header");
    }
    return consumeVarInt(mojo);
}

function consumeMetadata(mojo: IterableIterator<number>) {
    return [consumeString(mojo), consumeString(mojo)];
}

function consumeStack(mojo: IterableIterator<number>) {
    let pid = consumeVarInt(mojo);
    let tid = consumeString(mojo);

    return [pid.toString(), tid];
}

interface FrameData {
    key: bigint;
    frame: string;
}

function consumeFrame(mojo: IterableIterator<number>, stringRefs: Map<string, string>, pid: string): FrameData {
    let key = consumeVarInt(mojo);
    let filenameKey = consumeVarInt(mojo);
    let scopeKey = consumeVarInt(mojo);
    let line = consumeVarInt(mojo);

    let filename = stringRefs.get(`${pid}:${filenameKey}`);
    let scope = (scopeKey === 1n) ? "<unknown>" : stringRefs.get(`${pid}:${scopeKey}`);

    if (filename === undefined || scope === undefined) {
        throw new Error("Invalid string references in frame event");
    }

    return { "key": key, "frame": `${filename}:${scope}:${line}` };
}

function consumeKernel(mojo: IterableIterator<number>) {
    return `;kernel:${consumeString(mojo)}:0`;
}

function finalizeStack(stack: string, time: bigint | null, memory: bigint | null, idle: boolean, gc: boolean, full: boolean): string {
    if (gc) {
        stack += ";:GC:";
    }

    if (full) {
        return `${stack} ${time}:${idle}:${memory}`;
    }

    let metric = time !== null ? time : memory;

    return `${stack} ${metric}`;
}

export function parseMojo(mojo: IterableIterator<number>, stats: AustinStats) {
    let metadata = new Map<string, string>();
    let frameRefs = new Map<string, string>();
    let stringRefs = new Map<string, string>();

    let mojoVersion = consumeHeader(mojo);

    let currentPid = null;
    let currentTid = null;
    let currentStack = null;
    let currentTimeMetric = null;
    let currentMemoryMetric = null;
    let currentIdle = false;
    let currentGC = false;

    try {
        while (true) {
            switch (consume(mojo)) {
                case MOJO_EVENT.metadata:
                    let [k, v] = consumeMetadata(mojo);
                    metadata.set(k, v);
                    stats.update(`# ${k}: ${v}`);
                    break;

                case MOJO_EVENT.stack:
                    // Finish the previous stack and update the stats
                    if (currentStack !== null) {
                        stats.update(
                            finalizeStack(
                                currentStack,
                                currentTimeMetric,
                                currentMemoryMetric,
                                currentIdle,
                                currentGC,
                                metadata.get("mode") === "full",
                            )
                        );
                    }

                    [currentPid, currentTid] = consumeStack(mojo);
                    currentStack = `P${currentPid};T${Number("0x" + currentTid)}`;
                    currentTimeMetric = null;
                    currentMemoryMetric = null;
                    currentIdle = false;
                    currentGC = false;

                    break;

                case MOJO_EVENT.frame:
                    if (currentPid === null) {
                        throw new Error("Frame event before stack event");
                    }
                    let frameData = consumeFrame(mojo, stringRefs, currentPid);
                    frameRefs.set(`${currentPid}:${frameData.key}`, frameData.frame);
                    break;

                case MOJO_EVENT.invalidFrame:
                    currentStack += ";:INVALID:";
                    break;

                case MOJO_EVENT.frameReference:
                    let key = `${currentPid}:${consumeVarInt(mojo)}`;
                    currentStack += `;${frameRefs.get(key)}`;
                    break;

                case MOJO_EVENT.kernelFrame:
                    currentStack += consumeKernel(mojo);
                    break;

                case MOJO_EVENT.gc:
                    currentGC = true;
                    break;

                case MOJO_EVENT.idle:
                    currentIdle = true;
                    break;

                case MOJO_EVENT.time:
                    currentTimeMetric = consumeVarInt(mojo);
                    break;

                case MOJO_EVENT.memory:
                    currentMemoryMetric = consumeVarInt(mojo);
                    break;

                case MOJO_EVENT.string:
                    let stringKey = consumeVarInt(mojo);
                    let stringValue = consumeString(mojo);
                    stringRefs.set(`${currentPid}:${stringKey}`, stringValue);
                    break;

                case MOJO_EVENT.stringReference:
                    let string = stringRefs.get(`${currentPid}:${consumeVarInt(mojo)}`);
                    if (string === undefined) {
                        throw new Error("Invalid string reference");
                    }
                    currentStack += string;
                    break;

                default:
                    console.error("Received unknown MOJO event");
                    vscode.window.showErrorMessage("Invalid MOJO file");
            }
        }
    } catch (e) {
        if (e instanceof IteratorDone) {
            // Finish the last stack and update the stats
            if (currentStack !== null) {
                stats.update(
                    finalizeStack(
                        currentStack,
                        currentTimeMetric,
                        currentMemoryMetric,
                        currentIdle,
                        currentGC,
                        metadata.get("mode") === "full",
                    )
                );
            }
        } else {
            let message = (e instanceof Error) ? e.message : e;
            vscode.window.showErrorMessage(`Failed to parse the MOJO file ${stats.source}: ${message}`);
        }
    }
}
