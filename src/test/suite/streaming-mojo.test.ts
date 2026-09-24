import * as assert from 'assert';
import * as fs from 'fs';
import { StreamingMojoParser } from '../../utils/mojo';
import { AustinStats } from '../../model';
import { testDataPath } from './helpers';
import '../../stringExtension';
import '../../mapExtension';


// ---------------------------------------------------------------------------
// Helpers (mirrored from mojo.test.ts)
// ---------------------------------------------------------------------------

function vi(n: number): number {
    assert.ok(n >= 0 && n <= 63, `vi() only handles 0–63, got ${n}`);
    return n;
}

function varIntBytes(n: number): number[] {
    assert.ok(n >= 0, 'varIntBytes only handles non-negative');
    if (n <= 63) { return [n]; }
    const lo = 0x80 | (n & 0x3F);
    const hi = (n >> 6) & 0x7F;
    return [lo, hi];
}

function str(s: string): number[] {
    return [...s].map(c => c.charCodeAt(0)).concat([0]);
}

/** Feed the byte array to a StreamingMojoParser as a single chunk. */
function parseWithStreaming(bytes: number[]): AustinStats {
    const stats = new AustinStats();
    const parser = new StreamingMojoParser(stats);
    parser.push(Buffer.from(bytes));
    parser.finalize();
    stats.refresh();
    return stats;
}

/** Feed the byte array byte-by-byte. */
function parseByteByByte(bytes: number[]): AustinStats {
    const stats = new AustinStats();
    const parser = new StreamingMojoParser(stats);
    for (const b of bytes) {
        parser.push(Buffer.from([b]));
    }
    parser.finalize();
    stats.refresh();
    return stats;
}

// Shared minimal v1 MOJO stream with one sample:
//   pid=1, tid="T1", frame={/test.py:foo:10}, time=100
function buildV1Stream(): number[] {
    return [
        // Header
        0x4D, 0x4F, 0x4A,         // "MOJ"
        vi(1),                     // version = 1

        // metadata: mode=wall
        vi(1),                     // MOJO_EVENT.metadata
        ...str('mode'),
        ...str('wall'),

        // stack: pid=1, tid="T1"
        vi(2),                     // MOJO_EVENT.stack
        vi(1),                     // pid = 1
        ...str('T1'),              // tid

        // string: key=2 → "/test.py"
        vi(11),                    // MOJO_EVENT.string
        vi(2),
        ...str('/test.py'),

        // string: key=3 → "foo"
        vi(11),                    // MOJO_EVENT.string
        vi(3),
        ...str('foo'),

        // frame: key=1, filenameKey=2, scopeKey=3, line=10
        vi(3),                     // MOJO_EVENT.frame
        vi(1),
        vi(2),
        vi(3),
        vi(10),

        // frameReference: key=1
        vi(5),                     // MOJO_EVENT.frameReference
        vi(1),

        // time: 100
        vi(9),                     // MOJO_EVENT.time
        ...varIntBytes(100),
    ];
}


// ---------------------------------------------------------------------------
// StreamingMojoParser — single-chunk
// ---------------------------------------------------------------------------
suite('StreamingMojoParser — single chunk', () => {

    test('parses a complete stream fed as one chunk', () => {
        const stats = parseWithStreaming(buildV1Stream());
        assert.strictEqual(stats.overallTotal, 100);
    });

    test('populates top for the frame in the stream', () => {
        const stats = parseWithStreaming(buildV1Stream());
        assert.ok(stats.top.has('/test.py:foo'), 'top should contain /test.py:foo');
    });

    test('populates locationMap for the module', () => {
        const stats = parseWithStreaming(buildV1Stream());
        assert.ok(stats.locationMap.has('/test.py'), 'locationMap should contain /test.py');
    });

    test('stores metadata from the stream', () => {
        const stats = parseWithStreaming(buildV1Stream());
        assert.strictEqual(stats.metadata.get('mode'), 'wall');
    });

    test('finalize() commits the last in-flight sample', () => {
        const stats = new AustinStats();
        const parser = new StreamingMojoParser(stats);
        // Feed the whole stream but do NOT call finalize yet
        parser.push(Buffer.from(buildV1Stream()));
        // The last sample is buffered; overallTotal is still 0 until finalize
        assert.strictEqual(stats.overallTotal, 0, 'sample not committed before finalize');
        parser.finalize();
        assert.strictEqual(stats.overallTotal, 100, 'sample committed after finalize');
    });

    test('finalize() is a no-op when no sample is in flight', () => {
        const stats = new AustinStats();
        const parser = new StreamingMojoParser(stats);
        // Empty push + finalize should not throw
        parser.push(Buffer.alloc(0));
        assert.doesNotThrow(() => parser.finalize());
        assert.strictEqual(stats.overallTotal, 0);
    });
});


// ---------------------------------------------------------------------------
// StreamingMojoParser — byte-by-byte (partial-event rollback)
// ---------------------------------------------------------------------------
suite('StreamingMojoParser — byte-by-byte', () => {

    test('produces same overallTotal as single-chunk when fed byte-by-byte', () => {
        const bytes = buildV1Stream();
        const single = parseWithStreaming(bytes);
        const streamed = parseByteByByte(bytes);
        assert.strictEqual(streamed.overallTotal, single.overallTotal);
    });

    test('produces same top entries as single-chunk when fed byte-by-byte', () => {
        const bytes = buildV1Stream();
        const single = parseWithStreaming(bytes);
        const streamed = parseByteByByte(bytes);
        assert.deepStrictEqual([...streamed.top.keys()].sort(), [...single.top.keys()].sort());
    });

    test('produces same locationMap keys as single-chunk when fed byte-by-byte', () => {
        const bytes = buildV1Stream();
        const single = parseWithStreaming(bytes);
        const streamed = parseByteByByte(bytes);
        assert.deepStrictEqual([...streamed.locationMap.keys()].sort(), [...single.locationMap.keys()].sort());
    });
});


// ---------------------------------------------------------------------------
// StreamingMojoParser — split at specific boundaries
// ---------------------------------------------------------------------------
suite('StreamingMojoParser — split chunks', () => {

    test('header split across two chunks is handled correctly', () => {
        const bytes = buildV1Stream();
        const stats = new AustinStats();
        const parser = new StreamingMojoParser(stats);
        // Split after first two header bytes ("MO")
        parser.push(Buffer.from(bytes.slice(0, 2)));
        parser.push(Buffer.from(bytes.slice(2)));
        parser.finalize();
        assert.strictEqual(stats.overallTotal, 100);
    });

    test('varint split across chunk boundary is handled correctly', () => {
        const bytes = buildV1Stream();
        // The time varint for 100 requires two bytes (>63); split right before it
        const split = bytes.length - 2;
        const stats = new AustinStats();
        const parser = new StreamingMojoParser(stats);
        parser.push(Buffer.from(bytes.slice(0, split)));
        parser.push(Buffer.from(bytes.slice(split)));
        parser.finalize();
        assert.strictEqual(stats.overallTotal, 100);
    });

    test('null-terminated string split across chunk boundary is handled correctly', () => {
        const bytes = buildV1Stream();
        // Split mid-way through the tid string "T1\0"
        const split = bytes.indexOf(str('T1')[0]);
        const stats = new AustinStats();
        const parser = new StreamingMojoParser(stats);
        parser.push(Buffer.from(bytes.slice(0, split + 1)));
        parser.push(Buffer.from(bytes.slice(split + 1)));
        parser.finalize();
        assert.strictEqual(stats.overallTotal, 100);
    });
});


// ---------------------------------------------------------------------------
// StreamingMojoParser — real data file
// ---------------------------------------------------------------------------
suite('StreamingMojoParser — real data file', () => {

    test('produces same overallTotal as MojoParser when fed in 16-byte chunks', () => {
        const filePath = testDataPath('test.mojo');
        if (!fs.existsSync(filePath)) { return; }

        const data = fs.readFileSync(filePath);

        // Reference: synchronous MojoParser via readFromMojoStream
        const refStats = new AustinStats();
        refStats.readFromMojoStream(data.values() as IterableIterator<number>, filePath);

        // Streaming: feed in 16-byte chunks
        const stats = new AustinStats();
        const parser = new StreamingMojoParser(stats);
        const chunkSize = 16;
        for (let i = 0; i < data.length; i += chunkSize) {
            parser.push(data.slice(i, i + chunkSize));
        }
        parser.finalize();

        assert.strictEqual(stats.overallTotal, refStats.overallTotal);
    });

    test('produces same top keys as MojoParser when fed in 32-byte chunks', () => {
        const filePath = testDataPath('test.mojo');
        if (!fs.existsSync(filePath)) { return; }

        const data = fs.readFileSync(filePath);

        const refStats = new AustinStats();
        refStats.readFromMojoStream(data.values() as IterableIterator<number>, filePath);

        const stats = new AustinStats();
        const parser = new StreamingMojoParser(stats);
        const chunkSize = 32;
        for (let i = 0; i < data.length; i += chunkSize) {
            parser.push(data.slice(i, i + chunkSize));
        }
        parser.finalize();

        assert.deepStrictEqual([...stats.top.keys()].sort(), [...refStats.top.keys()].sort());
    });
});

// ---------------------------------------------------------------------------
// asyncio task-graph events (MOJO_TASK_STACK / MOJO_TASK_WAITER)
//
// A task's owning thread isn't tagged on the wire at all: it's recovered
// from wire position, since a MOJO_TASK_STACK only ever arrives bracketed
// between the MOJO_STACK it belongs to and the next one (see mojo.ts's
// flushTaskStack). Task subtrees are attached to the real spine frame that
// awaited/ran them (resolved once, at refresh() time), not dumped in a flat
// bucket -- see AustinStats.finalizeTaskNodes / resolveTaskParent.
// ---------------------------------------------------------------------------

// v4 stream: thread T1's window contains a waiter edge (999 awaited by
// 1000, never independently resolved) and task 999's own suspended stack
// (one frame), so 999's owner is recovered as T1 purely from position; T1's
// own regular sample (a second, distinct frame) gives it a real leaf to
// nest under.
function buildTaskGraphStream(): number[] {
    return [
        0x4D, 0x4F, 0x4A, vi(4), // MOJ v4

        vi(2), vi(1), ...str('T1'),                          // MOJO_STACK pid=1 tid="T1"

        // Strings are registered here, inside T1's window, not before any
        // MOJO_STACK. (A separate test below covers the "null pid" fallback
        // for a name registered before any MOJO_STACK is seen.)
        vi(11), vi(2), ...str('worker'),    // string key=2 -> task 999's name
        vi(11), vi(10), ...str('/test.py'), // string key=10 -> filename
        vi(11), vi(11), ...str('foo'),      // string key=11 -> scope of task 999's own frame
        vi(11), vi(12), ...str('bar'),      // string key=12 -> scope of T1's own frame

        vi(15), ...varIntBytes(999), ...varIntBytes(1000),   // taskWaiter(999, 1000) — unresolved
        vi(14), ...varIntBytes(999), vi(2),                  // taskStack(999, name_key=2)
        vi(3), vi(1), vi(10), vi(11), vi(10), vi(0), vi(0), vi(0), // MOJO_FRAME key=1 (foo)
        vi(5), vi(1),                                         // frameReference key=1
        vi(9), ...varIntBytes(5),             // time=5 — closes task 999's block (first sighting: carried forward, not yet reported)

        vi(3), vi(2), vi(10), vi(12), vi(20), vi(0), vi(0), vi(0), // MOJO_FRAME key=2 (bar) — T1's own frame
        vi(5), vi(2),                                         // frameReference key=2
        vi(9), ...varIntBytes(100),           // time=100 — closes T1's own regular sample
    ];
}

// v4 stream where the waiter (task 1000) is itself resolved: its own
// suspended stack is also captured inside T1's window, so task 999 (which
// it awaits) nests under 1000's own leaf frame, and 1000 in turn nests
// under the thread's leaf frame -- all recovered from position, with no
// tag anywhere naming which thread owns which task.
function buildWaiterChainStream(): number[] {
    return [
        0x4D, 0x4F, 0x4A, vi(4), // MOJ v4

        vi(2), vi(1), ...str('T1'),                          // MOJO_STACK pid=1 tid="T1"

        vi(11), vi(2), ...str('worker'),    // string key=2 -> task 999's name
        vi(11), vi(10), ...str('/test.py'), // string key=10 -> filename
        vi(11), vi(11), ...str('bar'),      // string key=11 -> scope of task 999's own frame
        vi(11), vi(12), ...str('foo'),      // string key=12 -> scope of task 1000's own frame, and T1's own leaf

        vi(15), ...varIntBytes(999), ...varIntBytes(1000),   // taskWaiter(999, 1000)

        vi(14), ...varIntBytes(1000), vi(0),                 // taskStack(1000, name_key=0 — unresolved)
        vi(3), vi(1), vi(10), vi(12), vi(10), vi(0), vi(0), vi(0), // MOJO_FRAME key=1 (foo)
        vi(5), vi(1),                                         // frameReference key=1
        vi(9), ...varIntBytes(1),              // time=1 — closes 1000's block (first sighting)

        vi(14), ...varIntBytes(999), vi(2),                  // taskStack(999, name_key=2)
        vi(3), vi(2), vi(10), vi(11), vi(20), vi(0), vi(0), vi(0), // MOJO_FRAME key=2 (bar)
        vi(5), vi(2),                                         // frameReference key=2
        vi(9), ...varIntBytes(1),              // time=1 — closes 999's block (first sighting)

        vi(5), vi(1),                                         // frameReference key=1 (foo) — T1's own regular frame
        vi(9), ...varIntBytes(50),             // time=50 — closes T1's own regular sample
    ];
}

// v4 stream with a suspended task stack whose waiter is never independently
// resolved and which never appears inside any thread's window -- nothing to
// attach it to.
function buildUnresolvedTaskStream(): number[] {
    return [
        0x4D, 0x4F, 0x4A, vi(4), // MOJ v4

        vi(11), vi(2), ...str('worker'),
        vi(11), vi(10), ...str('/test.py'),
        vi(11), vi(11), ...str('bar'),

        vi(14), ...varIntBytes(999), vi(2),                        // taskStack(999, name_key=2)
        vi(3), vi(1), vi(10), vi(11), vi(20), vi(0), vi(0), vi(0), // MOJO_FRAME key=1 (bar)
        vi(5), vi(1),                                               // frameReference key=1
    ];
}

// v4 stream where a task's name string is registered before ANY MOJO_STACK
// is seen (so it's keyed "null:<key>" at registration time), but the
// taskStack event referencing it arrives after a real MOJO_STACK has set a
// non-null currentPid -- the lookup must fall back to the "null pid" key,
// exactly like frame/frameReference lookups already do.
function buildTaskNameRegisteredBeforeAnyStackStream(): number[] {
    return [
        0x4D, 0x4F, 0x4A, vi(4), // MOJ v4

        vi(11), vi(2), ...str('worker'), // string key=2 -> task 999's name, registered pre-pid
        vi(11), vi(10), ...str('/test.py'),
        vi(11), vi(11), ...str('bar'),

        vi(2), vi(1), ...str('T1'),                                // MOJO_STACK pid=1 tid="T1" -- currentPid now non-null

        vi(14), ...varIntBytes(999), vi(2),                        // taskStack(999, name_key=2) -- key=2 was registered under "null"
        vi(3), vi(1), vi(10), vi(11), vi(20), vi(0), vi(0), vi(0), // MOJO_FRAME key=1 (bar)
        vi(5), vi(1),                                               // frameReference key=1
    ];
}

suite('StreamingMojoParser — asyncio task graph', () => {

    test('resolves a task name registered before any MOJO_STACK via the "null pid" fallback', () => {
        const stats = parseWithStreaming(buildTaskNameRegisteredBeforeAnyStackStream());
        const [task] = stats.getTaskForest()[0].tasks;
        assert.strictEqual(task.name, 'worker');
    });

    test('nests a task under the thread leaf that ran it when its waiter is unresolved', () => {
        const stats = parseWithStreaming(buildTaskGraphStream());

        const processNode = stats.hierarchy.children.find(c => c.key === 'Process 1')!;
        assert.ok(processNode, 'expected the normal Process 1 node to still be built');
        const threadNode = processNode.children.find(c => c.kind === 'thread')!;
        assert.ok(threadNode, 'expected a thread node under Process 1');
        const leafFrame = threadNode.children.find(c => c.key === '/test.py:bar')!;
        assert.ok(leafFrame, 'expected the regular leaf frame run by the thread to still be built');

        // The task's own entry frame is merged by shape (see
        // finalizeTaskNodes): the node IS the frame ('foo'), keyed by
        // content, not the raw task id -- and its own display name
        // ('worker') plays no part in the label any more either.
        const taskNode = leafFrame.children.find(c => c.kind === 'task')!;
        assert.ok(taskNode, 'expected task 999 nested under the thread leaf frame, not a flat bucket');
        assert.strictEqual(taskNode.name, 'foo');
        assert.strictEqual(taskNode.key, '/test.py:foo');
        // Its own trailing metric never gets applied to it directly (first
        // sighting -- nothing was carried yet to pair it with), so it's
        // reported at end-of-stream via the interval-based fallback (1).
        assert.strictEqual(taskNode.value, 1);

        assert.strictEqual(
            stats.hierarchy.children.find(c => c.key === '__tasks__'),
            undefined,
            'no fallback Tasks bucket needed once the task resolves to a real spine frame'
        );
    });

    test("blends a task's frames into its waiter's own tower when it's the only thing being awaited", () => {
        const stats = parseWithStreaming(buildWaiterChainStream());

        const processNode = stats.hierarchy.children.find(c => c.key === 'Process 1')!;
        const threadNode = processNode.children.find(c => c.kind === 'thread')!;
        const mainLeaf = threadNode.children.find(c => c.key === '/test.py:foo' && c.kind === 'frame')!;
        assert.ok(mainLeaf, "expected T1's own regular sample frame");
        assert.strictEqual(mainLeaf.value, 50);

        // Task 1000 is a genuine root task -- no waiter of its own, so
        // nothing to blend INTO (blending only continues inside an already-
        // floating tower, see mergeAndAttachTask). It anchors directly at
        // the thread's own last frame (mainLeaf, threadLeaves) as its own
        // floating tower (kind:'task'), positioned by true wall-clock time
        // rather than sharing width with T1's regular content -- the
        // renderer (media/flamegraph-utils.js) only ever treats a
        // kind:'task' node as such an anchor. Its own entry frame happens
        // to share mainLeaf's key ('/test.py:foo') too, but the two stay
        // distinct nodes (a child of mainLeaf, not mainLeaf itself, and a
        // different kind besides), exactly as intended.
        const task1000 = mainLeaf.children.find(c => c.kind === 'task')!;
        assert.ok(task1000, 'expected task 1000 nested under the thread leaf frame as its own floating tower');
        assert.strictEqual(task1000.key, '/test.py:foo');
        assert.strictEqual(task1000.name, 'foo');
        assert.strictEqual(task1000.value, 1);

        // Task 999 is the ONLY thing task 1000 is awaiting -- no
        // concurrency to disambiguate, so it blends directly into task
        // 1000's own tower as a plain continuation (kind:'frame', not a
        // separate floating 'task') instead of a spine to its own tower.
        const task999 = task1000.children.find(c => c.key === '/test.py:bar')!;
        assert.ok(task999, 'expected task 999 blended into its waiter (task 1000) tower');
        assert.strictEqual(task999.kind, 'frame');
        // Reported via the interval-based fallback at end-of-stream, same
        // reasoning as task 1000's own value above.
        assert.strictEqual(task999.value, 1);
    });

    test('falls back to the flat Tasks bucket when neither waiter nor thread resolves', () => {
        const stats = parseWithStreaming(buildUnresolvedTaskStream());

        const tasksRoot = stats.hierarchy.children.find(c => c.key === '__tasks__')!;
        assert.ok(tasksRoot, 'expected a fallback Tasks root node');

        const taskNode = tasksRoot.children.find(c => c.kind === 'task')!;
        assert.ok(taskNode, 'expected task 999 node in the fallback bucket');
        assert.strictEqual(taskNode.value, tasksRoot.value, 'fallback bucket value should reflect its children');
    });

    test('produces the same nested result when fed byte-by-byte', () => {
        const streamed = parseWithStreaming(buildWaiterChainStream());
        const byByte = parseByteByByte(buildWaiterChainStream());

        const locate = (s: AustinStats) => {
            const processNode = s.hierarchy.children.find(c => c.key === 'Process 1')!;
            const threadNode = processNode.children.find(c => c.kind === 'thread')!;
            const mainLeaf = threadNode.children.find(c => c.key === '/test.py:foo' && c.kind === 'frame')!;
            const task1000 = mainLeaf.children.find(c => c.kind === 'task')!;
            return task1000.children.find(c => c.key === '/test.py:bar')!;
        };

        const a = locate(byByte);
        const b = locate(streamed);
        assert.strictEqual(a.name, b.name);
        assert.strictEqual(a.value, b.value);
    });
});
