import * as assert from 'assert';
import { Readable } from 'stream';
import { AustinSample, AustinStats, TopStats } from '../../model';
// Side-effect imports required by model internals
import '../../stringExtension';
import '../../mapExtension';


// ---------------------------------------------------------------------------
// Helper: wrap AustinStats.readFromStream in a Promise that resolves after
// all lines are processed (i.e. after the 'close' callback fires).
// ---------------------------------------------------------------------------
function readStats(lines: string): Promise<AustinStats> {
    return new Promise((resolve) => {
        const stats = new AustinStats();
        stats.registerAfterCallback(() => resolve(stats));
        const stream = new Readable();
        stream.push(lines);
        stream.push(null);
        stats.readFromStream(stream, 'test.austin');
    });
}


// ---------------------------------------------------------------------------
// TopStats
// ---------------------------------------------------------------------------
suite('TopStats', () => {

    test('constructs with default values', () => {
        const ts = new TopStats();
        assert.strictEqual(ts.scope, null);
        assert.strictEqual(ts.module, null);
        assert.strictEqual(ts.own, 0);
        assert.strictEqual(ts.total, 0);
        assert.strictEqual(ts.callees.size, 0);
        assert.strictEqual(ts.callers.size, 0);
        assert.strictEqual(ts.minLine, 0);
    });

    test('constructs with provided scope and module', () => {
        const ts = new TopStats('my_fn', '/path/to/mod.py');
        assert.strictEqual(ts.scope, 'my_fn');
        assert.strictEqual(ts.module, '/path/to/mod.py');
    });

    test('key() returns module:scope', () => {
        const ts = new TopStats('my_fn', '/mod.py');
        assert.strictEqual(ts.key(), '/mod.py:my_fn');
    });

    test('key() with null scope and module', () => {
        const ts = new TopStats();
        assert.strictEqual(ts.key(), 'null:null');
    });
});


// ---------------------------------------------------------------------------
// AustinSample.parse
// ---------------------------------------------------------------------------
suite('AustinSample.parse', () => {

    test('parses pid and tid', () => {
        const sample = AustinSample.parse('1;T42;/mod.py:foo:10 200');
        assert.strictEqual(sample.pid, 1);
        assert.strictEqual(sample.tid, 'T42');
    });

    test('parses metric as array', () => {
        const sample = AustinSample.parse('1;T1;/mod.py:fn:5 300');
        assert.deepStrictEqual(sample.metrics, [300]);
    });

    test('parses a single stack frame', () => {
        const sample = AustinSample.parse('1;T1;/abs/path.py:my_func:42 100');
        assert.strictEqual(sample.stack.length, 1);
        assert.strictEqual(sample.stack[0].scope, 'my_func');
        assert.strictEqual(sample.stack[0].line, 42);
        // absolutePath returns absolute paths unchanged
        assert.strictEqual(sample.stack[0].module, '/abs/path.py');
    });

    test('parses multiple stack frames', () => {
        const sample = AustinSample.parse('1;T1;/a.py:outer:1;/b.py:inner:2 50');
        assert.strictEqual(sample.stack.length, 2);
        assert.strictEqual(sample.stack[0].scope, 'outer');
        assert.strictEqual(sample.stack[1].scope, 'inner');
    });

    test('parses empty stack', () => {
        const sample = AustinSample.parse('1;T1 0');
        assert.strictEqual(sample.stack.length, 0);
    });

    test('idle defaults to false', () => {
        const sample = AustinSample.parse('1;T1;/m.py:f:1 10');
        assert.strictEqual(sample.idle, false);
    });
});


// ---------------------------------------------------------------------------
// AustinStats — single update
// ---------------------------------------------------------------------------
suite('AustinStats.update', () => {

    test('accumulates overallTotal for positive metrics', () => {
        const stats = new AustinStats();
        stats.update(1, 'T1', [], 100);
        stats.update(1, 'T1', [], 50);
        assert.strictEqual(stats.overallTotal, 150);
    });

    test('does not accumulate overallTotal for zero metric', () => {
        const stats = new AustinStats();
        stats.update(1, 'T1', [], 0);
        assert.strictEqual(stats.overallTotal, 0);
    });

    test('does not accumulate overallTotal for negative metric', () => {
        const stats = new AustinStats();
        stats.update(1, 'T1', [], -5);
        assert.strictEqual(stats.overallTotal, 0);
    });

    test('populates top with frame key', () => {
        const stats = new AustinStats();
        const frame = { module: '/m.py', scope: 'fn', line: 1 };
        stats.update(1, 'T1', [frame], 100);
        assert.ok(stats.top.has('/m.py:fn'));
    });

    test('own time is assigned to the innermost (last) frame', () => {
        const stats = new AustinStats();
        const outer = { module: '/m.py', scope: 'outer', line: 1 };
        const inner = { module: '/m.py', scope: 'inner', line: 2 };
        stats.update(1, 'T1', [outer, inner], 100);

        assert.strictEqual(stats.top.get('/m.py:outer')!.rawOwn, 0);
        assert.strictEqual(stats.top.get('/m.py:inner')!.rawOwn, 100);
    });

    test('total time is accumulated on every frame in the stack', () => {
        const stats = new AustinStats();
        const outer = { module: '/m.py', scope: 'outer', line: 1 };
        const inner = { module: '/m.py', scope: 'inner', line: 2 };
        stats.update(1, 'T1', [outer, inner], 100);

        assert.strictEqual(stats.top.get('/m.py:outer')!.rawTotal, 100);
        assert.strictEqual(stats.top.get('/m.py:inner')!.rawTotal, 100);
    });

    test('recursive frames are counted only once (no double-counting)', () => {
        const stats = new AustinStats();
        const frame = { module: '/m.py', scope: 'recursive', line: 5 };
        stats.update(1, 'T1', [frame, frame], 200);

        assert.strictEqual(stats.top.get('/m.py:recursive')!.rawTotal, 200);
        assert.strictEqual(stats.top.get('/m.py:recursive')!.rawOwn, 200);
    });

    test('locationMap is populated with module key', () => {
        const stats = new AustinStats();
        const frame = { module: '/path/mod.py', scope: 'fn', line: 3 };
        stats.update(1, 'T1', [frame], 50);
        assert.ok(stats.locationMap.has('/path/mod.py'));
    });

    test('hierarchy root value accumulates metric', () => {
        const stats = new AustinStats();
        stats.update(1, 'T1', [], 77);
        assert.strictEqual(stats.hierarchy.value, 77);
    });
});


// ---------------------------------------------------------------------------
// AustinStats.readFromStream (text format)
// ---------------------------------------------------------------------------
suite('AustinStats.readFromStream', () => {

    test('parses metadata lines', async () => {
        const stats = await readStats('# mode: wall\n');
        assert.strictEqual(stats.metadata.get('mode'), 'wall');
    });

    test('skips empty lines', async () => {
        const stats = await readStats('\nP1;T1;/abs/m.py:fn:1 100\n\n');
        assert.strictEqual(stats.overallTotal, 100);
    });

    test('accumulates overallTotal across multiple samples', async () => {
        const input = 'P1;T1;/a.py:f:1 100\nP1;T1;/a.py:f:1 200\n';
        const stats = await readStats(input);
        assert.strictEqual(stats.overallTotal, 300);
    });

    test('sets source to provided filename', async () => {
        const stats = await readStats('');
        assert.strictEqual(stats.source, 'test.austin');
    });

    test('normalises top own/total as fractions of overallTotal', async () => {
        const input = 'P1;T1;/a.py:f:1 100\nP1;T1;/a.py:f:1 100\n';
        const stats = await readStats(input);
        const entry = stats.top.get('/a.py:f')!;
        assert.ok(entry, 'top entry should exist');
        // own and total are divided by overallTotal in finalize()
        assert.strictEqual(entry.own, 1.0);   // 200/200
        assert.strictEqual(entry.total, 1.0);
    });

    test('caller/callee relationships are tracked', async () => {
        const input = 'P1;T1;/a.py:outer:1;/a.py:inner:2 50\n';
        const stats = await readStats(input);
        const innerEntry = stats.top.get('/a.py:inner')!;
        assert.ok(innerEntry, 'inner entry should exist');
        assert.ok(innerEntry.callers.has('/a.py:outer'), 'outer should be a caller of inner');
    });

    test('call stack tree is built', async () => {
        const input = 'P1;T1;/a.py:fn:1 100\n';
        const stats = await readStats(input);
        // callStack root → process "1" → thread "1" → fn
        const processNode = stats.callStack.callees.get('1');
        assert.ok(processNode, 'process node should exist');
        const threadNode = processNode.callees.get('1');
        assert.ok(threadNode, 'thread node should exist');
        assert.ok(threadNode.callees.has('/a.py:fn'), 'fn should be in call stack');
    });

    test('multiple threads produce separate call stacks', async () => {
        const input = 'P1;T1;/a.py:fn:1 100\nP1;T2;/b.py:gn:1 50\n';
        const stats = await readStats(input);
        const proc = stats.callStack.callees.get('1')!;
        assert.ok(proc.callees.has('1'));
        assert.ok(proc.callees.has('2'));
    });

    test('clear() resets all accumulated data', async () => {
        const stats = await readStats('P1;T1;/a.py:f:1 100\n');
        stats.clear();
        assert.strictEqual(stats.overallTotal, 0);
        assert.strictEqual(stats.top.size, 0);
        assert.strictEqual(stats.locationMap.size, 0);
    });

    test('setMetadata stores key-value pairs', () => {
        const stats = new AustinStats();
        stats.setMetadata('version', '3');
        assert.strictEqual(stats.metadata.get('version'), '3');
    });
});


// ---------------------------------------------------------------------------
// AustinStats.refresh — normalisation and idempotency
// ---------------------------------------------------------------------------
suite('AustinStats.refresh', () => {

    test('normalises own and total as fractions after update', () => {
        const stats = new AustinStats();
        const outer = { module: '/m.py', scope: 'outer', line: 1 };
        const inner = { module: '/m.py', scope: 'inner', line: 2 };
        stats.update(1, 'T1', [outer, inner], 100);
        stats.refresh();
        assert.strictEqual(stats.top.get('/m.py:outer')!.total, 1.0);
        assert.strictEqual(stats.top.get('/m.py:inner')!.total, 1.0);
        assert.strictEqual(stats.top.get('/m.py:outer')!.own, 0.0);
        assert.strictEqual(stats.top.get('/m.py:inner')!.own, 1.0);
    });

    test('refresh() is idempotent — calling it twice gives the same result', () => {
        const stats = new AustinStats();
        const frame = { module: '/m.py', scope: 'fn', line: 1 };
        stats.update(1, 'T1', [frame], 200);
        stats.refresh();
        const afterFirst = stats.top.get('/m.py:fn')!.own;
        stats.refresh();
        const afterSecond = stats.top.get('/m.py:fn')!.own;
        assert.strictEqual(afterFirst, afterSecond);
    });

    test('raw fields remain unchanged after refresh()', () => {
        const stats = new AustinStats();
        const frame = { module: '/m.py', scope: 'fn', line: 1 };
        stats.update(1, 'T1', [frame], 300);
        stats.refresh();
        assert.strictEqual(stats.top.get('/m.py:fn')!.rawOwn, 300);
        assert.strictEqual(stats.top.get('/m.py:fn')!.rawTotal, 300);
    });

    test('refresh() fires after-callbacks', () => {
        const stats = new AustinStats();
        let called = 0;
        stats.registerAfterCallback(() => { called++; });
        stats.update(1, 'T1', [], 10);
        stats.refresh();
        assert.strictEqual(called, 1);
    });

    test('registerOnceAfterCallback fires exactly once', () => {
        const stats = new AustinStats();
        let called = 0;
        stats.registerOnceAfterCallback(() => { called++; });
        stats.refresh();
        stats.refresh();
        assert.strictEqual(called, 1);
    });
});


// ---------------------------------------------------------------------------
// AustinStats.begin — session initialisation
// ---------------------------------------------------------------------------
suite('AustinStats.begin', () => {

    test('begin() clears previously accumulated data', async () => {
        const stats = await readStats('P1;T1;/a.py:f:1 100\n');
        stats.begin('new.austin');
        assert.strictEqual(stats.overallTotal, 0);
        assert.strictEqual(stats.top.size, 0);
    });

    test('begin() sets the source to the new file name', () => {
        const stats = new AustinStats();
        stats.begin('profile.austin');
        assert.strictEqual(stats.source, 'profile.austin');
    });

    test('begin() fires before-callbacks', () => {
        const stats = new AustinStats();
        let called = 0;
        stats.registerBeforeCallback(() => { called++; });
        stats.begin('x.austin');
        assert.strictEqual(called, 1);
    });
});


// ---------------------------------------------------------------------------
// AustinStats — paused flag
// ---------------------------------------------------------------------------
suite('AustinStats — paused flag', () => {

    test('paused defaults to false', () => {
        const stats = new AustinStats();
        assert.strictEqual(stats.paused, false);
    });

    test('paused can be set to true', () => {
        const stats = new AustinStats();
        stats.paused = true;
        assert.strictEqual(stats.paused, true);
    });

    test('paused can be toggled back to false', () => {
        const stats = new AustinStats();
        stats.paused = true;
        stats.paused = false;
        assert.strictEqual(stats.paused, false);
    });

    test('refresh() still fires after-callbacks regardless of paused (paused is checked by the caller)', () => {
        // The paused flag is intentionally not checked inside refresh() itself —
        // the executor's setInterval is responsible for skipping the call.
        // This test documents that contract.
        const stats = new AustinStats();
        let called = 0;
        stats.registerAfterCallback(() => { called++; });
        stats.paused = true;
        stats.update(1, 'T1', [], 100);
        stats.refresh();
        assert.strictEqual(called, 1, 'refresh() fires callbacks even when paused');
    });

    test('begin() does not reset paused', () => {
        const stats = new AustinStats();
        stats.paused = true;
        stats.begin('new.austin');
        assert.strictEqual(stats.paused, true);
    });
});


// ---------------------------------------------------------------------------
// AustinStats — error callbacks
// ---------------------------------------------------------------------------
suite('AustinStats — error callbacks', () => {

    test('notifyError() fires a registered error callback', () => {
        const stats = new AustinStats();
        let called = 0;
        stats.registerErrorCallback(() => { called++; });
        stats.notifyError();
        assert.strictEqual(called, 1);
    });

    test('notifyError() fires all registered error callbacks', () => {
        const stats = new AustinStats();
        let a = 0, b = 0;
        stats.registerErrorCallback(() => { a++; });
        stats.registerErrorCallback(() => { b++; });
        stats.notifyError();
        assert.strictEqual(a, 1);
        assert.strictEqual(b, 1);
    });

    test('notifyError() does not fire before-callbacks', () => {
        const stats = new AustinStats();
        let called = 0;
        stats.registerBeforeCallback(() => { called++; });
        stats.notifyError();
        assert.strictEqual(called, 0);
    });

    test('notifyError() does not fire after-callbacks', () => {
        const stats = new AustinStats();
        let called = 0;
        stats.registerAfterCallback(() => { called++; });
        stats.notifyError();
        assert.strictEqual(called, 0);
    });

    test('notifyError() can be called multiple times', () => {
        const stats = new AustinStats();
        let called = 0;
        stats.registerErrorCallback(() => { called++; });
        stats.notifyError();
        stats.notifyError();
        assert.strictEqual(called, 2);
    });

    test('notifyError() with no registered callbacks does not throw', () => {
        const stats = new AustinStats();
        assert.doesNotThrow(() => stats.notifyError());
    });
});
