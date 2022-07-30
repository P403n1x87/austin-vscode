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

function consumeVarInt(mojo: IterableIterator<number>): number {
    let n = 0;
    let s = 6;
    let b = consume(mojo);
    const sign = (b & 0x40) >> 6;

    n |= (b & 0x3F);
    while (b & 0x80) {
        b = consume(mojo);
        n |= ((b & 0x7F) << s);
        s += 7;
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
});

function consumeHeader(mojo: IterableIterator<number>): number {
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

    return `P${pid};T${tid}`;
}

function consumeFrame(mojo: IterableIterator<number>) {
    let key = consumeVarInt(mojo);
    let filename = consumeString(mojo);
    let scope = consumeString(mojo);
    let line = consumeVarInt(mojo);

    return { "key": key, "frame": `${filename}:${scope}:${line}` };
}

function consumeKernel(mojo: IterableIterator<number>) {
    return `;kernel:${consumeString(mojo)}:0`;
}

function finalizeStack(stack: string, time: number | null, memory: number | null, idle: boolean, gc: boolean, full: boolean): string {
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
    let frameRefs = new Map<number, string>();

    let mojoVersion = consumeHeader(mojo);

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

                    currentStack = consumeStack(mojo);
                    currentTimeMetric = null;
                    currentMemoryMetric = null;
                    currentIdle = false;
                    currentGC = false;

                    break;

                case MOJO_EVENT.frame:
                    let frameData = consumeFrame(mojo);
                    frameRefs.set(frameData.key, frameData.frame);
                    break;

                case MOJO_EVENT.invalidFrame:
                    currentStack += ";:INVALID:";
                    break;

                case MOJO_EVENT.frameReference:
                    currentStack += `;${frameRefs.get(consumeVarInt(mojo))}`;
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
            vscode.window.showErrorMessage(`Failed to parse the MOJO file ${stats.source}`);
        }
    }
}
