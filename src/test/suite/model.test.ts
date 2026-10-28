import * as assert from 'assert';
import { Readable } from 'stream';
import { AustinSample, AustinStats, TopStats } from '../../model';
import type { FlameNode } from '../../model';
import { hashPath } from '../../utils/pathKey';
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
// AustinStats — GC event collection
// ---------------------------------------------------------------------------
suite('AustinStats — gcEvents', () => {

    test('gcEvents is empty on construction', () => {
        const stats = new AustinStats();
        assert.strictEqual(stats.gcEvents.length, 0);
    });

    test('update() appends a gcEvent for every call', () => {
        const stats = new AustinStats();
        stats.update(1, 'T1', [], 100);
        stats.update(1, 'T1', [], 200);
        assert.strictEqual(stats.gcEvents.length, 2);
    });

    test('gc flag defaults to false', () => {
        const stats = new AustinStats();
        stats.update(1, 'T1', [], 100);
        assert.strictEqual(stats.gcEvents[0].gc, false);
    });

    test('gc flag is stored when true', () => {
        const stats = new AustinStats();
        stats.update(1, 'T1', [], 100, true);
        assert.strictEqual(stats.gcEvents[0].gc, true);
    });

    test('pid and tid are recorded correctly', () => {
        const stats = new AustinStats();
        stats.update(42, 'T99', [], 100);
        assert.strictEqual(stats.gcEvents[0].pid, 42);
        assert.strictEqual(stats.gcEvents[0].tid, 'T99');
    });

    test('metric is recorded correctly', () => {
        const stats = new AustinStats();
        stats.update(1, 'T1', [], 777);
        assert.strictEqual(stats.gcEvents[0].metric, 777);
    });

    test('frameKeys are built as module:scope', () => {
        const stats = new AustinStats();
        const frames = [
            { module: '/a.py', scope: 'outer', line: 1 },
            { module: '/b.py', scope: 'inner', line: 2 },
        ];
        stats.update(1, 'T1', frames, 100);
        assert.deepStrictEqual(stats.gcEvents[0].frameKeys, ['/a.py:outer', '/b.py:inner']);
    });

    test('temporal order is preserved across multiple updates', () => {
        const stats = new AustinStats();
        stats.update(1, 'T1', [], 10, false);
        stats.update(1, 'T1', [], 20, true);
        stats.update(1, 'T1', [], 30, false);
        assert.strictEqual(stats.gcEvents[0].gc, false);
        assert.strictEqual(stats.gcEvents[1].gc, true);
        assert.strictEqual(stats.gcEvents[2].gc, false);
    });

    test('clear() resets gcEvents to empty', () => {
        const stats = new AustinStats();
        stats.update(1, 'T1', [], 100, true);
        stats.clear();
        assert.strictEqual(stats.gcEvents.length, 0);
    });

    test('gcEvents from multiple threads are interleaved in call order', () => {
        const stats = new AustinStats();
        stats.update(1, 'T1', [], 10, true);
        stats.update(1, 'T2', [], 20, false);
        stats.update(1, 'T1', [], 30, false);
        assert.strictEqual(stats.gcEvents[0].tid, 'T1');
        assert.strictEqual(stats.gcEvents[1].tid, 'T2');
        assert.strictEqual(stats.gcEvents[2].tid, 'T1');
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


// ---------------------------------------------------------------------------
// AustinStats.getTaskForest()
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Task helpers: tasks get time from their owning thread's samples, the way
// the MOJO parser feeds them in -- a task report sets a task's position, and
// every later sample of its thread gives it that sample's time there.
// ---------------------------------------------------------------------------
const taskFrame = (scope: string, line = 1) => ({ module: '/mod.py', scope, line });

// MOJO_TASK_STACK: task `id` is at `frames`, reported with a sample of `pid:tid`.
function at(stats: AustinStats, id: string, frames: { module: string, scope: string, line: number }[], pid = 1, tid = 'A') {
    stats.updateTaskPosition(id, frames, pid, tid);
}

// A sample of thread `pid:tid` taking `metric`, running task `running` if any.
function sample(stats: AustinStats, metric: number, pid = 1, tid = 'A', running: string | null = null, frames = [taskFrame('loop')]) {
    stats.update(pid, tid, frames, metric, false, running);
}

suite('AustinStats.getTaskForest()', () => {

    const frame = taskFrame;

    test('a single root task with no waiter groups under its owner thread', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'main');
        at(stats, 't1', [frame('main')], 123, '0x1');
        sample(stats, 100, 123, '0x1', 't1');
        stats.refresh();

        const forest = stats.getTaskForest();
        assert.strictEqual(forest.length, 1);
        assert.strictEqual(forest[0].pid, 123);
        assert.strictEqual(forest[0].tid, '0x1');
        assert.strictEqual(forest[0].tasks.length, 1);
        assert.strictEqual(forest[0].tasks[0].id, 't1');
        assert.strictEqual(forest[0].tasks[0].name, 'main');
        assert.strictEqual(forest[0].tasks[0].own, 100);
        assert.strictEqual(forest[0].tasks[0].total, 100);
        assert.strictEqual(forest[0].tasks[0].children.length, 0);
    });

    test('a task awaited by another nests under its awaiter, not the fallback root', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('parent', 'main');
        stats.setTaskName('child', 'worker-0');
        // MOJO_TASK_WAITER(task_id=child, waiter_id=parent): parent awaits child.
        stats.updateTaskWaiter('child', 'parent');
        at(stats, 'parent', [frame('main')]);
        at(stats, 'child', [frame('worker')]);
        sample(stats, 100);
        stats.refresh();

        const forest = stats.getTaskForest();
        assert.strictEqual(forest.length, 1, 'only the parent is a root; the child nests under it');
        const parent = forest[0].tasks[0];
        assert.strictEqual(parent.id, 'parent');
        assert.strictEqual(parent.children.length, 1);
        assert.strictEqual(parent.children[0].id, 'child');
    });

    test('own is running time; in wall time, total is the time alive, not inflated by awaited tasks', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setMetadata('mode', 'wall');
        stats.setTaskName('parent', 'main');
        stats.setTaskName('child', 'worker-0');
        stats.updateTaskWaiter('child', 'parent');
        at(stats, 'parent', [frame('main')]);
        sample(stats, 10, 1, 'A', 'parent');  // parent running
        at(stats, 'child', [frame('worker')]);
        sample(stats, 20, 1, 'A', 'child');   // parent awaiting child, child running
        sample(stats, 30);                    // both awaiting
        stats.closeTask('child');
        sample(stats, 40, 1, 'A', 'parent');  // parent running again
        stats.refresh();

        const [parent] = stats.getTaskForest()[0].tasks;
        assert.strictEqual(parent.own, 50);
        assert.strictEqual(parent.total, 100, 'alive for the whole profile; the child\'s time is already in it');
        const [child] = parent.children;
        assert.strictEqual(child.own, 20);
        assert.strictEqual(child.total, 50);
    });

    test('in CPU time, total is own plus every (transitively) awaited task\'s total', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setMetadata('mode', 'cpu');
        stats.setTaskName('grandparent', 'main');
        stats.setTaskName('parent', 'worker-0');
        stats.setTaskName('child', 'leaf');
        stats.updateTaskWaiter('parent', 'grandparent');
        stats.updateTaskWaiter('child', 'parent');
        at(stats, 'grandparent', [frame('main')]);
        at(stats, 'parent', [frame('worker')]);
        at(stats, 'child', [frame('leaf')]);
        sample(stats, 10, 1, 'A', 'grandparent');
        sample(stats, 20, 1, 'A', 'parent');
        sample(stats, 30, 1, 'A', 'child');
        stats.refresh();

        const [grandparent] = stats.getTaskForest()[0].tasks;
        assert.strictEqual(grandparent.own, 10);
        assert.strictEqual(grandparent.total, 60, 'own + parent.total (20 + 30)');
        const [parent] = grandparent.children;
        assert.strictEqual(parent.own, 20);
        assert.strictEqual(parent.total, 50);
        const [child] = parent.children;
        assert.strictEqual(child.own, 30);
        assert.strictEqual(child.total, 30);
    });

    test('a waiter cycle does not infinite-loop and still returns a tree', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('a', 'a');
        stats.setTaskName('b', 'b');
        // Garbled/concurrently-mutated remote memory: a awaits b and b awaits a.
        stats.updateTaskWaiter('b', 'a');
        stats.updateTaskWaiter('a', 'b');
        at(stats, 'a', [frame('a')]);
        at(stats, 'b', [frame('b')]);
        sample(stats, 10);

        assert.doesNotThrow(() => stats.refresh());
        const forest = stats.getTaskForest();
        // Both tasks have a parent (each awaits the other), so neither is a
        // root -- the cycle is simply never reachable from a root, which is
        // an acceptable outcome for garbled data (never a crash or a hang).
        assert.strictEqual(forest.length, 0);
    });

    test('multiple root tasks under different threads produce separate groups', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'loop0-worker');
        stats.setTaskName('t2', 'loop1-worker');
        at(stats, 't1', [frame('worker')], 1, 'Loop0-Thread');
        at(stats, 't2', [frame('worker')], 1, 'Loop1-Thread');
        sample(stats, 10, 1, 'Loop0-Thread');
        sample(stats, 10, 1, 'Loop1-Thread');
        stats.refresh();

        const forest = stats.getTaskForest();
        assert.strictEqual(forest.length, 2);
        const tids = forest.map(g => g.tid).sort();
        assert.deepStrictEqual(tids, ['Loop0-Thread', 'Loop1-Thread']);
    });

    test('with no tasks recorded, returns an empty forest', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.refresh();
        assert.deepStrictEqual(stats.getTaskForest(), []);
    });

    test('a task and its owning thread group carry the same frameKey the flame graph would assign', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        // The thread's samples are what actually create the Process/Thread
        // nodes in the hierarchy. The task attaches under the thread's own
        // last frame ("select", resolveTaskParent's threadLeaves lookup) --
        // the thread stack waiting on its tasks genuinely ends there.
        stats.setTaskName('t1', 'worker-0');
        at(stats, 't1', [frame('worker')], 7, '0x1');
        sample(stats, 50, 7, '0x1', null, [frame('select')]);
        stats.refresh();

        const [group] = stats.getTaskForest();
        const expectedThreadKey = hashPath('Thread 0x1', hashPath('Process 7', 0));
        assert.strictEqual(group.frameKey, expectedThreadKey);

        const [task] = group.tasks;
        // The task's own entry frame is merged by shape (see
        // finalizeTaskNodes), so its key is its first frame's content key
        // ("/mod.py:worker"), nested under "select" (the thread's own last
        // frame), since that's where it's attached.
        const expectedLeafKey = hashPath('/mod.py:select', expectedThreadKey);
        assert.strictEqual(task.frameKey, hashPath('/mod.py:worker', expectedLeafKey));
    });

    test('a task whose thread has no frames of its own still gets a frameKey via the fallback root', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'worker-0');
        at(stats, 't1', [frame('worker')], 7, '0x1');
        sample(stats, 50, 7, '0x1', null, []);
        stats.refresh();

        // The thread's samples carry no frames, so there's no thread leaf
        // for the task to attach to -- it attaches under the flamegraph's
        // "__tasks__" fallback root instead (resolveTaskParent), so it's
        // still navigable.
        const [group] = stats.getTaskForest();
        assert.strictEqual(group.tasks[0].frameKey, hashPath('/mod.py:worker', hashPath('__tasks__', 0)));
    });
});


// ---------------------------------------------------------------------------
// Task time: where it comes from
// ---------------------------------------------------------------------------
suite('AustinStats — task time from thread samples', () => {

    const frame = taskFrame;

    // None of these tasks await each other, so total is the task's own time.
    function own(stats: AustinStats, id: string): number {
        return stats.getTaskForest().flatMap(g => g.tasks).find(t => t.id === id)!.total;
    }

    test('every live task of the sample\'s thread gets its time, at its current position', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        at(stats, 'running', [frame('work')]);
        at(stats, 'waiting', [frame('wait')]);
        at(stats, 'other', [frame('wait')], 1, 'B');
        sample(stats, 10, 1, 'A', 'running');
        stats.refresh();

        assert.strictEqual(own(stats, 'running'), 10, 'running time');
        assert.strictEqual(own(stats, 'waiting'), 10, 'await time');
        assert.strictEqual(own(stats, 'other'), 0, 'another thread\'s task gets nothing');
    });

    test('in CPU mode, only the running task gets time', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setMetadata('mode', 'cpu');
        at(stats, 'running', [frame('work')]);
        at(stats, 'waiting', [frame('wait')]);
        sample(stats, 10, 1, 'A', 'running');
        stats.refresh();

        assert.strictEqual(own(stats, 'running'), 10);
        assert.strictEqual(own(stats, 'waiting'), 0, 'a task that isn\'t running uses no CPU');
    });

    test('a task gets time at the position it holds, until its next report or its closing', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        at(stats, 't1', [frame('outer'), frame('first')]);
        sample(stats, 10);
        at(stats, 't1', [frame('outer'), frame('second')]);
        sample(stats, 20);
        stats.closeTask('t1');
        sample(stats, 40);
        stats.refresh();

        const outer = stats.locationMap.get('/mod.py')!;
        const timeAt = (scope: string) => [...outer.values()].find(([fo]) => fo.scope === scope)!;
        assert.strictEqual(timeAt('first')[1], 10);
        assert.strictEqual(timeAt('second')[1], 20);
        assert.strictEqual(own(stats, 't1'), 30, 'nothing once closed');
    });

    test('a task frame is recorded in locationMap like a regular sample', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        at(stats, 't1', [frame('outer', 1), frame('leaf', 2)]);
        sample(stats, 100, 1, 'A', null, [frame('loop', 3)]);
        stats.refresh();

        const moduleMap = stats.locationMap.get('/mod.py')!;
        const entry = (scope: string) => [...moduleMap.values()].find(([fo]) => fo.scope === scope)!;
        assert.strictEqual(entry('outer')[2], 100, 'every frame in the chain gets total time');
        assert.strictEqual(entry('outer')[1], 0, 'only the leaf frame gets own time');
        assert.strictEqual(entry('leaf')[1], 100, 'the leaf frame gets own time');
        assert.strictEqual(entry('leaf')[2], 100);
    });

    test('task time is not added to overallTotal: it is the thread\'s own time, seen per task', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        at(stats, 't1', [frame('task-work')]);
        sample(stats, 50, 1, 'A', 't1');
        stats.refresh();

        assert.strictEqual(stats.overallTotal, 50);
    });
});


// ---------------------------------------------------------------------------
// AustinStats.getTaskTraces()
// ---------------------------------------------------------------------------
suite('AustinStats.getTaskTraces()', () => {

    const frame = taskFrame;

    test('a single root task spans from its first report to its last sample, on its owning thread\'s own clock', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'worker-0');
        at(stats, 't1', [frame('a')], 1, '0x1'); // first reported at thread clock 0
        sample(stats, 25, 1, '0x1');              // thread clock -> 25, t1 alive until then
        stats.closeTask('t1');
        sample(stats, 25, 1, '0x1');              // thread clock -> 50
        stats.refresh();

        const [group] = stats.getTaskTraces();
        assert.strictEqual(group.pid, 1);
        assert.strictEqual(group.tid, '0x1');
        const [root] = group.roots;
        assert.strictEqual(root.taskId, 't1');
        assert.strictEqual(root.name, 'worker-0');
        assert.strictEqual(root.startFraction, 0);
        assert.strictEqual(root.endFraction, 0.5, 'last seen (25) over the thread\'s own total (50)');
        assert.strictEqual(root.children.length, 0);
    });

    test('a task awaited by another nests under its awaiter, not as a separate root', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('parent', 'main');
        stats.setTaskName('child', 'worker-0');
        stats.updateTaskWaiter('child', 'parent');
        at(stats, 'parent', [frame('main')]); // parent first reported at clock 0
        sample(stats, 25);                     // clock -> 25
        at(stats, 'child', [frame('worker')]); // child first reported at clock 25
        sample(stats, 25);                     // clock -> 50
        stats.closeTask('child');              // child last seen at clock 50
        sample(stats, 25);                     // clock -> 75, parent last seen
        stats.refresh();

        const [group] = stats.getTaskTraces();
        assert.strictEqual(group.roots.length, 1, 'only the parent is a root; the child nests under it');
        const [root] = group.roots;
        assert.strictEqual(root.taskId, 'parent');
        assert.strictEqual(root.endFraction, 1);
        assert.strictEqual(root.children.length, 1);
        const [child] = root.children;
        assert.strictEqual(child.taskId, 'child');
        assert.strictEqual(child.startFraction, 1 / 3);
        assert.strictEqual(child.endFraction, 2 / 3);
    });

    test('a child on another thread is clipped into its parent\'s window, never sticking out to the left', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('parent', 'gather-root');
        stats.setTaskName('child', 'worker-0');
        stats.updateTaskWaiter('child', 'parent');

        sample(stats, 50, 1, 'A');                       // A-clock -> 50
        at(stats, 'parent', [frame('main')], 1, 'A');    // parent first reported at A-clock 50
        // The child's range is on ITS thread's clock, which starts at 0.
        at(stats, 'child', [frame('worker')], 1, 'B');
        sample(stats, 10, 1, 'B');
        sample(stats, 50, 1, 'A');                       // A-clock -> 100
        stats.refresh();

        const [group] = stats.getTaskTraces().filter(g => g.tid === 'A');
        const [root] = group.roots;
        assert.strictEqual(root.startFraction, 0.5);
        const [child] = root.children;
        // Without the parent-bounds clip this would be 0 -- clipped into the
        // parent's [0.5, 1] window, it can't render to the left of its parent.
        assert.strictEqual(child.startFraction, root.startFraction);
    });

    test('two root tasks on different threads are normalized against their OWN thread\'s clock, independently', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'early');
        at(stats, 't1', [frame('a')], 1, 'A'); // first reported at A-clock 0
        sample(stats, 40, 1, 'A');              // A-clock -> 40
        stats.closeTask('t1');
        sample(stats, 40, 1, 'A');              // A-clock -> 80

        stats.setTaskName('t2', 'late');
        at(stats, 't2', [frame('b')], 2, 'B'); // first reported at B-clock 0
        sample(stats, 5, 2, 'B');               // B-clock -> 5
        stats.closeTask('t2');
        sample(stats, 5, 2, 'B');               // B-clock -> 10
        stats.refresh();

        const groups = stats.getTaskTraces();
        const early = groups.find(g => g.tid === 'A')!.roots[0];
        const late = groups.find(g => g.tid === 'B')!.roots[0];

        // Thread A's total (80) and thread B's total (10) are wildly
        // different, yet both tasks land at the same 50% mark -- each is
        // normalized against its OWN thread's clock, not a shared one.
        assert.strictEqual(early.startFraction, 0);
        assert.strictEqual(early.endFraction, 0.5);
        assert.strictEqual(late.startFraction, 0);
        assert.strictEqual(late.endFraction, 0.5);
    });

    test('a task parked at a single position the whole time spans its whole life', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'gather-root');
        sample(stats, 10);                    // clock -> 10
        at(stats, 't1', [frame('main')]);     // its only report
        sample(stats, 80);                    // clock -> 90
        stats.closeTask('t1');
        sample(stats, 10);                    // clock -> 100
        stats.refresh();

        const [root] = stats.getTaskTraces()[0].roots;
        assert.strictEqual(root.startFraction, 0.1);
        assert.strictEqual(root.endFraction, 0.9);
    });

    test('a task still alive when sampling stops spans up to the end', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'driver');
        at(stats, 't1', [frame('main')]);
        sample(stats, 95);
        sample(stats, 5);
        stats.refresh();

        const [root] = stats.getTaskTraces()[0].roots;
        assert.strictEqual(root.startFraction, 0);
        assert.strictEqual(root.endFraction, 1);
    });

    test('a task carries its running and total time, liveness, coroutine and last location', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setMetadata('mode', 'wall');
        stats.setTaskName('t1', 'worker-0');
        stats.setTaskName('t2', 'driver');
        at(stats, 't1', [frame('work', 10), frame('fetch', 20)]);
        at(stats, 't2', [frame('main', 5)]);
        sample(stats, 30, 1, 'A', 't1');      // t1 running, t2 awaiting
        sample(stats, 20);                     // both awaiting
        stats.closeTask('t1');
        sample(stats, 50);                     // only t2 left
        stats.refresh();

        const roots = stats.getTaskTraces()[0].roots;
        const t1 = roots.find(r => r.taskId === 't1')!;
        assert.strictEqual(t1.runningFraction, 0.3);
        assert.strictEqual(t1.totalFraction, 0.5, 'wall mode: running plus awaiting');
        assert.strictEqual(t1.alive, false);
        assert.deepStrictEqual(t1.coroutine, { scope: 'work', module: '/mod.py', line: 10 });
        assert.deepStrictEqual(t1.location, { scope: 'fetch', module: '/mod.py', line: 20 });

        const t2 = roots.find(r => r.taskId === 't2')!;
        assert.strictEqual(t2.runningFraction, 0);
        assert.strictEqual(t2.totalFraction, 1);
        assert.strictEqual(t2.alive, true);
        assert.deepStrictEqual(t2.coroutine, t2.location, 'a single-frame task is at its own coroutine');
    });

    test('with no tasks recorded, returns an empty list', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.refresh();
        assert.deepStrictEqual(stats.getTaskTraces(), []);
    });

    test('a task on a thread with no samples (its clock stays 0) is kept, with zero fractions', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'worker-0');
        at(stats, 't1', [frame('a')]);
        stats.refresh();
        const [root] = stats.getTaskTraces()[0].roots;
        assert.strictEqual(root.taskId, 't1');
        assert.strictEqual(root.startFraction, 0);
        assert.strictEqual(root.endFraction, 0);
        assert.strictEqual(root.runningFraction, 0);
        assert.strictEqual(root.totalFraction, 0);
        // The Tasks view lists the same task: both views agree on which
        // tasks exist.
        assert.strictEqual(stats.getTaskForest()[0].tasks[0].id, 't1');
    });

    test('a task\'s location has the line of its last report, not of the frame\'s first one', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        at(stats, 't1', [frame('main', 5), frame('fetch', 20)]);
        sample(stats, 10);
        at(stats, 't1', [frame('main', 5), frame('fetch', 25)]); // same function, another await
        sample(stats, 10);
        stats.refresh();
        const [root] = stats.getTaskTraces()[0].roots;
        assert.deepStrictEqual(root.location, { scope: 'fetch', module: '/mod.py', line: 25 });
    });
});

// ---------------------------------------------------------------------------
// AustinStats -- frame-key cache shared by getTaskForest and getTaskTraces
// ---------------------------------------------------------------------------
// _computeFrameKeys does a full hierarchy walk; it's cached per refresh tick
// (invalidated in refresh()/clear()) so calling both getTaskForest and
// getTaskTraces off the same tick -- as the Tasks view and flamegraph
// providers both do on every refresh -- doesn't redo that walk twice.
suite('AustinStats -- frame key cache', () => {

    const frame = taskFrame;

    test('getTaskForest and getTaskTraces agree on the same task\'s frameKey within one refresh', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'worker-0');
        at(stats, 't1', [frame('a')], 1, '0x1');
        sample(stats, 25, 1, '0x1');
        stats.refresh();

        const forestKey = stats.getTaskForest()[0].tasks[0].frameKey;
        const traceKey = stats.getTaskTraces()[0].roots[0].frameKey;
        assert.strictEqual(typeof forestKey, 'number', 'expected a resolved frameKey from getTaskForest');
        assert.strictEqual(forestKey, traceKey, 'both views must agree on the same node\'s frameKey');
    });

    test('frameKey is recomputed (not stale) after a second refresh reshapes the hierarchy', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'worker-0');
        at(stats, 't1', [frame('a')], 1, '0x1');
        sample(stats, 10, 1, '0x1');
        stats.refresh();
        const firstKey = stats.getTaskForest()[0].tasks[0].frameKey;

        // A second task attaches to the SAME thread before the next refresh,
        // changing the hierarchy's shape (a new sibling branch) without
        // touching t1's own path -- t1's frameKey must still resolve
        // correctly (i.e. not fall back to a stale cached map missing the
        // now-different node identities finalizeTaskNodes rebuilt). t1 is
        // done by then, so the two don't overlap and need no shim.
        stats.closeTask('t1');
        stats.setTaskName('t2', 'worker-1');
        at(stats, 't2', [frame('b')], 1, '0x1');
        sample(stats, 10, 1, '0x1');
        stats.refresh();

        const forest = stats.getTaskForest();
        const t1 = forest[0].tasks.find(t => t.id === 't1')!;
        const t2 = forest[0].tasks.find(t => t.id === 't2')!;
        assert.strictEqual(typeof t1.frameKey, 'number', 'frameKey must still resolve after a second refresh');
        assert.strictEqual(t1.frameKey, firstKey, 'unchanged path should hash the same');
        assert.strictEqual(typeof t2.frameKey, 'number', 'newly-added task must resolve too, not be missing from a stale cache');
        assert.notStrictEqual(t1.frameKey, t2.frameKey);
    });

    test('frameKey still resolves correctly after clear() starts a new profile', () => {
        // clear() also resets the cache directly (belt-and-braces alongside
        // refresh()'s own reset), so a stale entry from a finished profile
        // can never surface even if something reads the cache between
        // clear() and the next refresh().
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'worker-0');
        at(stats, 't1', [frame('a')], 1, '0x1');
        sample(stats, 10, 1, '0x1');
        stats.refresh();
        stats.getTaskForest(); // populate the cache before starting a new profile

        stats.begin('test2.austin'); // calls clear() internally
        stats.setTaskName('t9', 'worker-9');
        at(stats, 't9', [frame('c')], 2, '0x2');
        sample(stats, 10, 2, '0x2');
        stats.refresh();

        const key = stats.getTaskForest()[0].tasks[0].frameKey;
        assert.strictEqual(typeof key, 'number', 'frameKey must resolve for the new profile, not miss on a stale cache from the old one');
    });
});

// ---------------------------------------------------------------------------
// AustinStats -- task shape merging (finalizeTaskNodes)
// ---------------------------------------------------------------------------
suite('AustinStats — task shape merging in the main flamegraph', () => {

    const frame = taskFrame;

    // Same-shape task nodes attach directly under the thread's own last
    // frame (resolveTaskParent's threadLeaves fallback), possibly behind a
    // "(awaiting N tasks)" shim if there happen to be several concurrent
    // roots there. Search by content key rather than assuming a fixed kind
    // or depth, since which of those applies isn't what these tests are
    // about.
    function findShapeNode(stats: AustinStats, threadKey: string): FlameNode | undefined {
        const [pid, tid] = threadKey.split(':');
        const processNode = stats.hierarchy.children.find(c => c.key === `Process ${pid}`);
        const threadNode = processNode?.children.find(c => c.key === `Thread ${tid}`);
        if (!threadNode) {
            return undefined;
        }
        const stack = [...threadNode.children];
        while (stack.length > 0) {
            const node = stack.pop()!;
            if (node.key === '/mod.py:worker') {
                return node;
            }
            stack.push(...node.children);
        }
        return undefined;
    }

    test('two CONCURRENT instances of the same shape merge to a union, not a sum, in wall-time mode', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setMetadata('mode', 'wall');

        // t1 is alive over [0, 30), t2 over [20, 30) -- they overlap for
        // [20, 30), so their union is [0, 30) = 30, not the naive sum (40).
        at(stats, 't1', [frame('worker')]);
        sample(stats, 20);
        at(stats, 't2', [frame('worker')]);
        sample(stats, 10);
        stats.refresh();

        const shape = findShapeNode(stats, '1:A');
        assert.ok(shape, 'expected the two instances to merge into one shared shape node');
        assert.strictEqual(shape!.value, 30);
    });

    test('two SEQUENTIAL (non-overlapping) instances of the same shape merge to a plain sum', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setMetadata('mode', 'wall');

        // t1 over [0, 20), t2 over [20, 40) -- back-to-back, no overlap, so
        // the union equals the sum (40).
        at(stats, 't1', [frame('worker')]);
        sample(stats, 20);
        stats.closeTask('t1');
        at(stats, 't2', [frame('worker')]);
        sample(stats, 20);
        stats.refresh();

        const shape = findShapeNode(stats, '1:A');
        assert.ok(shape);
        assert.strictEqual(shape!.value, 40);
    });

    test('in CPU-time mode only running time counts, each sample to the one task running', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setMetadata('mode', 'cpu');

        at(stats, 't1', [frame('worker')]);
        at(stats, 't2', [frame('worker')]);
        sample(stats, 20, 1, 'A', 't1');
        sample(stats, 10, 1, 'A', 't2');
        sample(stats, 5);                // neither running: no task time
        stats.refresh();

        const shape = findShapeNode(stats, '1:A');
        assert.ok(shape);
        assert.strictEqual(shape!.value, 30);
    });

    test('a task instance never seen concurrently with another keeps its own exact value', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setMetadata('mode', 'wall');

        sample(stats, 30);
        at(stats, 't1', [frame('worker')]);
        sample(stats, 20);               // [30, 50)
        stats.refresh();

        const shape = findShapeNode(stats, '1:A');
        assert.ok(shape);
        assert.strictEqual(shape!.value, 20);
    });

    test('different names, same coroutine shape: merge into one node, keyed by frame content not name', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setMetadata('mode', 'wall');
        stats.setTaskName('t1', 'alpha');
        stats.setTaskName('t2', 'beta');

        at(stats, 't1', [frame('worker')]);
        sample(stats, 20);
        stats.closeTask('t1');
        at(stats, 't2', [frame('worker')]);
        sample(stats, 20);
        stats.refresh();

        const processNode = stats.hierarchy.children.find(c => c.key === 'Process 1')!;
        const threadNode = processNode.children.find(c => c.key === 'Thread A')!;
        const loopFrame = threadNode.children.find(c => c.key === '/mod.py:loop')!;
        // t1 [0,20) and t2 [20,40) don't overlap, so both attach directly to
        // the thread's own last frame (threadLeaves) and, sharing the exact
        // same shape (kind:'task', key '/mod.py:worker'), merge into ONE
        // node regardless of their different display names.
        const workerNodes = loopFrame.children.filter(c => c.key === '/mod.py:worker');
        assert.strictEqual(workerNodes.length, 1, 'both instances should merge into a single node, regardless of their different names');
        assert.strictEqual(workerNodes[0].name, 'worker', "the merged node's label is the function's own name, not either task's display name");
    });
});

// ---------------------------------------------------------------------------
// AustinStats -- single-child blending and the "(awaiting N tasks)" shim
// ---------------------------------------------------------------------------
suite('AustinStats — task shape merging: single-child blend vs. concurrent shim', () => {

    const frame = taskFrame;

    // "parent" is a genuine root task (no waiter) so it always anchors
    // directly under the thread's own last frame (resolveTaskParent's
    // threadLeaves lookup) as kind:'task' -- never blended into an ordinary
    // frame, since there's no floating tower to blend INTO.
    function rootTaskNode(stats: AustinStats): FlameNode {
        const processNode = stats.hierarchy.children.find(c => c.key === 'Process 1')!;
        const threadNode = processNode.children.find(c => c.key === 'Thread A')!;
        const loopFrame = threadNode.children.find(c => c.key === '/mod.py:loop')!;
        return loopFrame.children.find(c => c.key === '/mod.py:outer')!;
    }

    test('a task awaiting exactly one child blends its frames into the same tower', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setMetadata('mode', 'wall');
        stats.updateTaskWaiter('child', 'parent');

        at(stats, 'parent', [frame('outer')]);
        sample(stats, 20);                      // parent [0,20)
        at(stats, 'child', [frame('inner')]);
        sample(stats, 20);                      // parent and child [20,40)
        stats.refresh();

        const parent = rootTaskNode(stats);
        assert.strictEqual(parent.name, 'outer');
        // The child blends in directly as a plain nested frame, not a
        // separate floating 'task' -- no concurrency to disambiguate,
        // since parent was only ever waiting on this one thing.
        const child = parent.children.find(c => c.key === '/mod.py:inner')!;
        assert.ok(child, 'expected the single child to blend into the parent tower');
        assert.strictEqual(child.kind, 'frame');
        assert.strictEqual(parent.children.some(c => c.kind === 'task'), false, 'no separate floating tower, and no shim needed for a single child');
    });

    test('a task awaiting several GENUINELY CONCURRENT children keeps them separate, with an "(awaiting N tasks)" shim', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setMetadata('mode', 'wall');
        stats.updateTaskWaiter('childA', 'parent');
        stats.updateTaskWaiter('childB', 'parent');

        at(stats, 'parent', [frame('outer')]);
        sample(stats, 20);                      // parent [0,20)
        // Both children alive over the same later window -- genuinely concurrent.
        at(stats, 'childA', [frame('workA')]);
        at(stats, 'childB', [frame('workB')]);
        sample(stats, 20);                      // all three [20,40)
        stats.refresh();

        const parent = rootTaskNode(stats);
        const shim = parent.children.find(c => c.name === '(awaiting 2 tasks)')!;
        assert.ok(shim, 'expected a shim frame explaining the plateau');
        assert.strictEqual(shim.kind, 'frame');
        assert.strictEqual(shim.value, parent.value, "the shim mirrors the parent's own value, not an additional quantity");

        const childTowers = shim.children.filter(c => c.kind === 'task');
        assert.strictEqual(childTowers.length, 2, 'both children stay as separate floating towers under the shim');
    });

    test('a task awaiting one fresh child at a time, repeatedly (never concurrently), blends every occurrence -- no shim', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setMetadata('mode', 'wall');
        // Three DIFFERENT children, all sharing "parent" as their waiter --
        // but strictly one at a time, never overlapping, like a loop that
        // awaits a fresh task each iteration.
        stats.updateTaskWaiter('child1', 'parent');
        stats.updateTaskWaiter('child2', 'parent');
        stats.updateTaskWaiter('child3', 'parent');

        at(stats, 'parent', [frame('outer')]);
        sample(stats, 10);                      // [0,10)
        for (const child of ['child1', 'child2', 'child3']) {
            at(stats, child, [frame('worker')]);
            sample(stats, 10);                  // [10,20), [20,30), [30,40)
            stats.closeTask(child);
        }
        stats.refresh();

        const parent = rootTaskNode(stats);
        assert.strictEqual(
            parent.children.some(c => c.name.startsWith('(awaiting')), false,
            'three sequential, non-overlapping occurrences of the same waiter should not read as concurrency'
        );
        // All three occurrences blend into the SAME shared 'worker' frame
        // (same shape), continuing the parent's own tower.
        const worker = parent.children.find(c => c.key === '/mod.py:worker')!;
        assert.ok(worker, 'expected the repeated single-child occurrences to blend in');
        assert.strictEqual(worker.kind, 'frame');
        assert.strictEqual(worker.value, 30, 'the three non-overlapping windows sum without deduplication');
    });
});

// ---------------------------------------------------------------------------
// AustinStats -- concurrent ROOT tasks (no waiter at all) on the same thread
// ---------------------------------------------------------------------------
// Mirrors the waiter-based suite above one level up: root tasks attach at
// the thread's own last frame (threadLeaves) -- a genuine leaf, so it's
// always the SOLE occupant there (never competing with unrelated regular
// content like <module>, which sits higher up, closer to the thread's own
// root). A solo (or sequential, non-overlapping) root task attaches
// directly; several GENUINELY concurrent ones get a real "(awaiting N
// tasks)" frame appended there instead, mirroring the leaf's own value so
// it renders at full width without distorting anything updateHierarchy
// owns (see finalizeTaskNodes/resolveTaskParent).
suite('AustinStats — concurrent root tasks', () => {

    const frame = taskFrame;
    const moduleSample = (stats: AustinStats, metric: number) => sample(stats, metric, 1, 'A', null, [frame('module')]);

    function threadLeaf(stats: AustinStats): FlameNode {
        const processNode = stats.hierarchy.children.find(c => c.key === 'Process 1')!;
        const threadNode = processNode.children.find(c => c.key === 'Thread A')!;
        return threadNode.children.find(c => c.key === '/mod.py:module')!;
    }

    test('a solo root task attaches directly to the thread\'s own last frame', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setMetadata('mode', 'wall');

        at(stats, 'root', [frame('work')]);
        moduleSample(stats, 20);
        stats.refresh();

        const leaf = threadLeaf(stats);
        const root = leaf.children.find(c => c.key === '/mod.py:work')!;
        assert.ok(root, 'expected the solo root task attached directly under the thread leaf');
        assert.strictEqual(root.kind, 'task');
        assert.strictEqual(leaf.children.some(c => c.name.startsWith('(awaiting')), false,
            'no shim needed for a single root task');
    });

    test('genuinely concurrent root tasks get a real "(awaiting N tasks)" frame mirroring the leaf\'s value', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setMetadata('mode', 'wall');

        at(stats, 'rootA', [frame('workA')]);
        moduleSample(stats, 20);                // rootA [0,20)
        at(stats, 'rootB', [frame('workB')]);
        moduleSample(stats, 10);                // both [20,30) -- overlapping
        stats.refresh();

        const leaf = threadLeaf(stats);
        const shim = leaf.children.find(c => c.name === '(awaiting 2 tasks)')!;
        assert.ok(shim, 'expected a real "(awaiting N tasks)" frame appended to the thread leaf');
        assert.strictEqual(shim.kind, 'frame');
        assert.strictEqual(shim.value, leaf.value, "the shim mirrors the leaf's own value, not a derived quantity");

        const rootA = shim.children.find(c => c.key === '/mod.py:workA')!;
        const rootB = shim.children.find(c => c.key === '/mod.py:workB')!;
        assert.ok(rootA && rootB, 'both root tasks attach under the shim, as separate floating towers');
        assert.strictEqual(rootA.kind, 'task');
        assert.strictEqual(rootB.kind, 'task');
    });

    test('sequential (non-overlapping) root tasks on the same thread attach directly, no shim', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setMetadata('mode', 'wall');

        at(stats, 'rootA', [frame('workA')]);
        moduleSample(stats, 10);                // rootA [0,10)
        stats.closeTask('rootA');
        moduleSample(stats, 5);
        at(stats, 'rootB', [frame('workB')]);
        moduleSample(stats, 5);                 // rootB [15,20) -- strictly after
        stats.refresh();

        const leaf = threadLeaf(stats);
        assert.strictEqual(leaf.children.some(c => c.name.startsWith('(awaiting')), false,
            'two sequential, non-overlapping root tasks should not read as concurrency');
        const rootA = leaf.children.find(c => c.key === '/mod.py:workA')!;
        const rootB = leaf.children.find(c => c.key === '/mod.py:workB')!;
        assert.ok(rootA && rootB, 'both root tasks attach directly under the thread leaf');
        assert.strictEqual(rootA.kind, 'task');
        assert.strictEqual(rootB.kind, 'task');
    });
});
