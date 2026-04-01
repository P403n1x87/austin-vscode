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
