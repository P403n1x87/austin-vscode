import * as assert from 'assert';
import { MojoParser } from '../../utils/mojo';
import { AustinStats } from '../../model';
import '../../stringExtension';
import '../../mapExtension';


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a small non-negative integer as a single-byte MOJO varInt.
 *  Only valid for values 0–63 (no continuation bit, positive). */
function vi(n: number): number {
    assert.ok(n >= 0 && n <= 63, `vi() only handles 0–63, got ${n}`);
    return n;
}

/** Encode a positive integer that may require two bytes as MOJO varInt. */
function varIntBytes(n: number): number[] {
    assert.ok(n >= 0, 'varIntBytes only handles non-negative');
    if (n <= 63) { return [n]; }
    // First byte: continuation=1 (bit7), sign=0 (bit6), low-6 bits
    const lo = 0x80 | (n & 0x3F);
    // Second byte: remaining bits (no continuation needed for n < 8192)
    const hi = (n >> 6) & 0x7F;
    return [lo, hi];
}

/** Null-terminated ASCII string. */
function str(s: string): number[] {
    return [...s].map(c => c.charCodeAt(0)).concat([0]);
}

function parseWith(bytes: number[]): AustinStats {
    const stats = new AustinStats();
    stats.readFromMojoStream(bytes.values() as IterableIterator<number>, 'test.mojo');
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
        ...str('mode'),            // key
        ...str('wall'),            // value

        // stack: pid=1, tid="T1"
        vi(2),                     // MOJO_EVENT.stack
        vi(1),                     // pid = 1
        ...str('T1'),              // tid

        // string: pid=1, key=2 → "/test.py"
        vi(11),                    // MOJO_EVENT.string
        vi(2),                     // key = 2
        ...str('/test.py'),        // value

        // string: pid=1, key=3 → "foo"
        vi(11),                    // MOJO_EVENT.string
        vi(3),                     // key = 3
        ...str('foo'),             // value

        // frame: key=1, filenameKey=2, scopeKey=3, line=10
        vi(3),                     // MOJO_EVENT.frame
        vi(1),                     // frame key = 1
        vi(2),                     // filenameKey = 2
        vi(3),                     // scopeKey = 3
        vi(10),                    // line = 10

        // frameReference: key=1
        vi(5),                     // MOJO_EVENT.frameReference
        vi(1),                     // ref key = 1

        // time: 100
        vi(9),                     // MOJO_EVENT.time
        ...varIntBytes(100),       // 100 μs
    ];
}


// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------
suite('MojoParser — error cases', () => {

    test('throws on invalid header magic bytes', () => {
        assert.throws(
            () => new MojoParser([0x41, 0x41, 0x41, vi(1)].values() as IterableIterator<number>),
            /Invalid header/
        );
    });

    test('throws when frame event arrives before any stack event', () => {
        const bytes = [
            0x4D, 0x4F, 0x4A, vi(1),  // MOJ v1
            vi(3),                      // MOJO_EVENT.frame — no stack first
        ];
        const stats = new AustinStats();
        assert.throws(
            () => new MojoParser(bytes.values() as IterableIterator<number>).parseInto(stats),
            /Frame event before stack event/
        );
    });

    test('throws on unknown event type', () => {
        const bytes = [
            0x4D, 0x4F, 0x4A, vi(1),  // MOJ v1
            0xFF,                       // unknown event
        ];
        const stats = new AustinStats();
        assert.throws(
            () => new MojoParser(bytes.values() as IterableIterator<number>).parseInto(stats),
            /unknown MOJO event/
        );
    });
});


// ---------------------------------------------------------------------------
// v1 format
// ---------------------------------------------------------------------------
suite('MojoParser — v1 format', () => {

    test('parses metadata', () => {
        const stats = parseWith(buildV1Stream());
        assert.strictEqual(stats.metadata.get('mode'), 'wall');
    });

    test('accumulates overallTotal', () => {
        const stats = parseWith(buildV1Stream());
        assert.strictEqual(stats.overallTotal, 100);
    });

    test('populates top with correct scope and module', () => {
        const stats = parseWith(buildV1Stream());
        // After finalize, top entries have own/total normalised by overallTotal
        const entry = stats.top.get('/test.py:foo')!;
        assert.ok(entry, 'top entry for /test.py:foo should exist');
        assert.strictEqual(entry.scope, 'foo');
        assert.strictEqual(entry.module, '/test.py');
    });

    test('own and total equal 1.0 when single sample', () => {
        const stats = parseWith(buildV1Stream());
        const entry = stats.top.get('/test.py:foo')!;
        assert.strictEqual(entry.own, 1.0);
        assert.strictEqual(entry.total, 1.0);
    });

    test('populates locationMap for module', () => {
        const stats = parseWith(buildV1Stream());
        assert.ok(stats.locationMap.has('/test.py'));
    });

    test('v1 frame has lineEnd/column/columnEnd defaulting to 0', () => {
        const stats = parseWith(buildV1Stream());
        const moduleMap = stats.locationMap.get('/test.py')!;
        const entry = [...moduleMap.values()][0];
        const [frame] = entry;
        assert.strictEqual(frame.lineEnd, 0);
        assert.strictEqual(frame.column, 0);
        assert.strictEqual(frame.columnEnd, 0);
    });

    test('sets source to provided filename', () => {
        const stats = parseWith(buildV1Stream());
        assert.strictEqual(stats.source, 'test.mojo');
    });
});


// ---------------------------------------------------------------------------
// v2 format — extra line/column data in frame events
// ---------------------------------------------------------------------------
suite('MojoParser — v2 format', () => {

    function buildV2Stream(): number[] {
        return [
            0x4D, 0x4F, 0x4A,   // "MOJ"
            vi(2),               // version = 2

            vi(1), ...str('mode'), ...str('cpu'),   // metadata

            vi(2), vi(1), ...str('T1'),             // stack: pid=1, tid="T1"

            vi(11), vi(2), ...str('/v2.py'),        // string key=2
            vi(11), vi(3), ...str('bar'),           // string key=3

            // frame: key=1, file=2, scope=3, line=5, lineEnd=7, col=3, colEnd=15
            vi(3),
            vi(1),   // frame key = 1
            vi(2),   // filenameKey = 2
            vi(3),   // scopeKey = 3
            vi(5),   // line = 5
            vi(7),   // lineEnd = 7
            vi(3),   // column = 3
            vi(15),  // columnEnd = 15

            vi(5), vi(1),           // frameReference: key=1
            vi(9), ...varIntBytes(200),  // time: 200
        ];
    }

    test('parses frame with lineEnd, column and columnEnd', () => {
        const stats = parseWith(buildV2Stream());
        const moduleMap = stats.locationMap.get('/v2.py')!;
        assert.ok(moduleMap, 'locationMap entry should exist for /v2.py');
        const entry = [...moduleMap.values()][0];
        const [frame] = entry;
        assert.strictEqual(frame.line, 5);
        assert.strictEqual(frame.lineEnd, 7);
        assert.strictEqual(frame.column, 3);
        assert.strictEqual(frame.columnEnd, 15);
    });

    test('accumulates overallTotal with v2 stream', () => {
        const stats = parseWith(buildV2Stream());
        assert.strictEqual(stats.overallTotal, 200);
    });
});


// ---------------------------------------------------------------------------
// v3 format — adds iid to stack event
// ---------------------------------------------------------------------------
suite('MojoParser — v3 format', () => {

    function buildV3Stream(): number[] {
        return [
            0x4D, 0x4F, 0x4A,   // "MOJ"
            vi(3),               // version = 3

            vi(1), ...str('mode'), ...str('wall'),  // metadata

            // stack v3: pid=1, iid=5, tid="T3"
            vi(2), vi(1), vi(5), ...str('T3'),

            vi(11), vi(2), ...str('/v3.py'),
            vi(11), vi(3), ...str('baz'),

            vi(3), vi(1), vi(2), vi(3), vi(1), vi(0), vi(0), vi(0),  // frame v2+ fields
            vi(5), vi(1),           // frameReference
            vi(9), vi(50),          // time: 50
        ];
    }

    test('parses v3 stream and accumulates total', () => {
        const stats = parseWith(buildV3Stream());
        assert.strictEqual(stats.overallTotal, 50);
    });

    test('v3 tid in top key includes iid prefix', () => {
        const stats = parseWith(buildV3Stream());
        // tid passed to update is `${iid}:${tid}` = "5:T3"
        // hierarchy should have a "Thread 5:T3" group
        const procChildren = stats.hierarchy.children[0]?.children;
        assert.ok(procChildren, 'process level should exist');
        const threadNode = procChildren.find(c => c.name === 'Thread 5:T3');
        assert.ok(threadNode, 'Thread 5:T3 node should exist in hierarchy');
    });
});


// ---------------------------------------------------------------------------
// Special frame types
// ---------------------------------------------------------------------------
suite('MojoParser — special frame types', () => {

    function buildStreamWithEvent(eventBytes: number[]): number[] {
        return [
            0x4D, 0x4F, 0x4A, vi(1),               // MOJ v1
            vi(1), ...str('mode'), ...str('wall'),   // metadata
            vi(2), vi(1), ...str('T1'),              // stack
            ...eventBytes,
            vi(9), vi(10),                           // time: 10
        ];
    }

    test('INVALID frame is pushed onto stack when no previous stack exists', () => {
        const bytes = buildStreamWithEvent([vi(4)]);  // MOJO_EVENT.invalidFrame
        const stats = parseWith(bytes);
        // INVALID frame has scope "INVALID", module ""
        assert.ok(stats.top.has(':INVALID'));
    });

    test('invalid frame back-attributes to previous stack of same thread', () => {
        // Stream: two stacks for pid=1, tid=T1.
        // First stack has frame /a.py:foo, time=10.
        // Second stack has an invalid frame — should be attributed to /a.py:foo.
        const bytes = [
            0x4D, 0x4F, 0x4A, vi(1),                    // MOJ v1
            vi(1), ...str('mode'), ...str('wall'),        // metadata

            // First stack for T1
            vi(2), vi(1), ...str('T1'),                  // stack: pid=1, tid=T1
            vi(11), vi(2), ...str('/a.py'),              // string key=2 → "/a.py"
            vi(11), vi(3), ...str('foo'),                // string key=3 → "foo"
            vi(3), vi(5), vi(2), vi(3), vi(1),          // frame: key=5, file=2, scope=3, line=1
            vi(5), vi(5),                                // frameRef: key=5
            vi(9), vi(10),                               // time: 10

            // Second stack for T1 — invalid frame (back-attributed to first)
            vi(2), vi(1), ...str('T1'),                  // stack: pid=1, tid=T1
            vi(4),                                       // MOJO_EVENT.invalidFrame
            vi(9), vi(20),                               // time: 20
        ];
        const stats = parseWith(bytes);
        // Back-attributed: /a.py:foo should accumulate 10 + 20 = 30 overall
        assert.strictEqual(stats.overallTotal, 30);
        assert.ok(stats.top.has('/a.py:foo'));
        // Normalized total for foo should be 1.0 (100% of overall)
        assert.strictEqual(stats.top.get('/a.py:foo')!.total, 1);
        // No INVALID frame should appear
        assert.ok(!stats.top.has(':INVALID'));
    });

    test('frames after invalid frame are skipped', () => {
        // After back-attribution, any additional frameReferences in the same
        // stack event must be discarded (they belong to the invalid capture).
        const bytes = [
            0x4D, 0x4F, 0x4A, vi(1),                    // MOJ v1
            vi(1), ...str('mode'), ...str('wall'),        // metadata

            // First stack for T1
            vi(2), vi(1), ...str('T1'),                  // stack: pid=1, tid=T1
            vi(11), vi(2), ...str('/a.py'),              // string key=2
            vi(11), vi(3), ...str('foo'),                // string key=3
            vi(3), vi(5), vi(2), vi(3), vi(1),          // frame key=5
            vi(5), vi(5),                                // frameRef key=5
            vi(9), vi(10),                               // time: 10

            // Second stack for T1 — invalid frame then a stray frameRef
            vi(2), vi(1), ...str('T1'),                  // stack
            vi(4),                                       // invalidFrame
            vi(5), vi(5),                                // frameRef key=5 (must be ignored)
            vi(9), vi(5),                                // time: 5
        ];
        const stats = parseWith(bytes);
        // Total should be 10 + 5 = 15 (back-attribution)
        assert.strictEqual(stats.overallTotal, 15);
        // foo should be the only entry (100% of total)
        assert.strictEqual(stats.top.get('/a.py:foo')!.total, 1);
    });

    test('invalid frame back-attribution is per-thread (interleaved threads)', () => {
        // T1 has a valid first stack (/a.py:foo), then an invalid second stack.
        // T2 appears between them. T2's stack must NOT be used for T1's back-attribution.
        const bytes = [
            0x4D, 0x4F, 0x4A, vi(1),                    // MOJ v1
            vi(1), ...str('mode'), ...str('wall'),        // metadata

            // First stack for T1
            vi(2), vi(1), ...str('T1'),                  // stack: pid=1, tid=T1
            vi(11), vi(2), ...str('/a.py'),              // string key=2
            vi(11), vi(3), ...str('foo'),                // string key=3
            vi(3), vi(5), vi(2), vi(3), vi(1),          // frame key=5
            vi(5), vi(5),                                // frameRef key=5
            vi(9), vi(10),                               // time: 10

            // First stack for T2 (interleaved)
            vi(2), vi(1), ...str('T2'),                  // stack: pid=1, tid=T2
            vi(11), vi(4), ...str('/b.py'),              // string key=4
            vi(11), vi(6), ...str('bar'),                // string key=6
            vi(3), vi(7), vi(4), vi(6), vi(1),          // frame key=7
            vi(5), vi(7),                                // frameRef key=7
            vi(9), vi(5),                                // time: 5

            // Second stack for T1 — invalid (should back-attribute to T1's foo, not T2's bar)
            vi(2), vi(1), ...str('T1'),                  // stack: pid=1, tid=T1
            vi(4),                                       // invalidFrame
            vi(9), vi(20),                               // time: 20
        ];
        const stats = parseWith(bytes);
        // Overall: 10 + 5 + 20 = 35
        assert.strictEqual(stats.overallTotal, 35);
        // T1's invalid stack back-attributed to foo: foo gets 10 + 20 = 30 → 30/35
        assert.ok(stats.top.has('/a.py:foo'));
        assert.ok(stats.top.has('/b.py:bar'));
        assert.ok(!stats.top.has(':INVALID'));
        // foo has 30/35 of total, bar has 5/35
        assert.ok(Math.abs(stats.top.get('/a.py:foo')!.total - 30 / 35) < 1e-9);
        assert.ok(Math.abs(stats.top.get('/b.py:bar')!.total - 5 / 35) < 1e-9);
    });

    test('GC frame is pushed onto stack', () => {
        const bytes = buildStreamWithEvent([vi(7)]);  // MOJO_EVENT.gc
        const stats = parseWith(bytes);
        assert.ok(stats.top.has(':GC'));
    });

    test('kernel frame is pushed with module="kernel"', () => {
        const bytes = buildStreamWithEvent([
            vi(6),               // MOJO_EVENT.kernelFrame
            ...str('sys_read'),  // kernel scope name
        ]);
        const stats = parseWith(bytes);
        assert.ok(stats.top.has('kernel:sys_read'));
    });

    test('unknown scope key 1 maps to <unknown>', () => {
        // Build a frame event where scopeKey=1 (special "unknown" sentinel)
        const bytes = [
            0x4D, 0x4F, 0x4A, vi(1),                      // MOJ v1
            vi(1), ...str('mode'), ...str('wall'),          // metadata
            vi(2), vi(1), ...str('T1'),                     // stack: pid=1
            vi(11), vi(2), ...str('/a.py'),                 // string key=2
            // frame: key=5, filenameKey=2, scopeKey=1 (unknown), line=1
            vi(3), vi(5), vi(2), vi(1), vi(1),
            vi(5), vi(5),                                   // frameRef: key=5
            vi(9), vi(20),                                  // time: 20
        ];
        const stats = parseWith(bytes);
        assert.ok(stats.top.has('/a.py:<unknown>'));
    });
});


// ---------------------------------------------------------------------------
// Memory mode
// ---------------------------------------------------------------------------
suite('MojoParser — memory mode', () => {

    test('uses memory metric when mode=memory', () => {
        const bytes = [
            0x4D, 0x4F, 0x4A, vi(1),                       // MOJ v1
            vi(1), ...str('mode'), ...str('memory'),        // mode=memory
            vi(2), vi(1), ...str('T1'),                     // stack
            vi(11), vi(2), ...str('/m.py'),
            vi(11), vi(3), ...str('fn'),
            vi(3), vi(1), vi(2), vi(3), vi(1),             // frame
            vi(5), vi(1),                                   // frameRef
            vi(10), vi(50),                                 // MOJO_EVENT.memory = 10, value=50
        ];
        const stats = parseWith(bytes);
        assert.strictEqual(stats.overallTotal, 50);
    });

    test('time metric is ignored when mode=memory', () => {
        const bytes = [
            0x4D, 0x4F, 0x4A, vi(1),
            vi(1), ...str('mode'), ...str('memory'),
            vi(2), vi(1), ...str('T1'),
            vi(11), vi(2), ...str('/m.py'),
            vi(11), vi(3), ...str('fn'),
            vi(3), vi(1), vi(2), vi(3), vi(1),
            vi(5), vi(1),
            vi(9), ...varIntBytes(999),   // time event (should be ignored in memory mode)
            vi(10), vi(40),   // memory event: 40
        ];
        const stats = parseWith(bytes);
        assert.strictEqual(stats.overallTotal, 40);
    });
});


// ---------------------------------------------------------------------------
// Multiple samples
// ---------------------------------------------------------------------------
suite('MojoParser — multiple samples', () => {

    test('two samples in sequence are both processed', () => {
        const bytes = [
            0x4D, 0x4F, 0x4A, vi(1),
            vi(1), ...str('mode'), ...str('wall'),

            // Sample 1: pid=1, tid="T1", /a.py:fn:1, time=100
            vi(2), vi(1), ...str('T1'),
            vi(11), vi(2), ...str('/a.py'),
            vi(11), vi(3), ...str('fn'),
            vi(3), vi(1), vi(2), vi(3), vi(1),
            vi(5), vi(1),
            vi(9), ...varIntBytes(100),

            // Sample 2: new stack event triggers flush of sample 1
            vi(2), vi(1), ...str('T1'),
            // Reuse existing string refs — push another frameRef
            vi(5), vi(1),
            vi(9), vi(50),
        ];
        const stats = parseWith(bytes);
        assert.strictEqual(stats.overallTotal, 150);
        const entry = stats.top.get('/a.py:fn')!;
        assert.ok(entry);
        // Both samples hit the same frame: own=150, total=150 before finalize
        // After finalize: own/total = 150/150 = 1.0
        assert.strictEqual(entry.own, 1.0);
    });

    test('idle event does not prevent stack from being processed', () => {
        const bytes = [
            0x4D, 0x4F, 0x4A, vi(1),
            vi(1), ...str('mode'), ...str('wall'),
            vi(2), vi(1), ...str('T1'),
            vi(11), vi(2), ...str('/b.py'),
            vi(11), vi(3), ...str('gn'),
            vi(3), vi(1), vi(2), vi(3), vi(1),
            vi(8),                          // MOJO_EVENT.idle
            vi(5), vi(1),
            vi(9), vi(30),
        ];
        const stats = parseWith(bytes);
        assert.strictEqual(stats.overallTotal, 30);
    });
});
