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
suite('AustinStats.getTaskForest()', () => {

    const frame = (scope: string, line = 1) => ({ module: '/mod.py', scope, line });

    test('a single root task with no waiter groups under its owner thread', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'main');
        stats.setTaskOwner('t1', 123, '0x1');
        stats.updateTaskStack('t1', [frame('main')], 100);
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

    test('a task with no captured owner lands in a synthetic orphaned group', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'stuck_worker');
        stats.updateTaskStack('t1', [frame('stuck_worker')], 50);
        stats.refresh();

        const forest = stats.getTaskForest();
        assert.strictEqual(forest.length, 1);
        assert.strictEqual(forest[0].pid, -1);
        assert.strictEqual(forest[0].tid, 'orphaned');
        assert.strictEqual(forest[0].tasks[0].id, 't1');
    });

    test('a task awaited by another nests under its awaiter, not the fallback root', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('parent', 'main');
        stats.setTaskName('child', 'worker-0');
        stats.setTaskOwner('parent', 1, 'A');
        // MOJO_TASK_WAITER(task_id=child, waiter_id=parent): parent awaits child.
        stats.updateTaskWaiter('child', 'parent');
        stats.updateTaskStack('parent', [frame('main')], 100);
        stats.updateTaskStack('child', [frame('worker')], 40);
        stats.refresh();

        const forest = stats.getTaskForest();
        assert.strictEqual(forest.length, 1, 'only the parent is a root; the child nests under it');
        const parent = forest[0].tasks[0];
        assert.strictEqual(parent.id, 'parent');
        assert.strictEqual(parent.children.length, 1);
        assert.strictEqual(parent.children[0].id, 'child');
    });

    test('total is own plus every (transitively) awaited task, own is unaffected', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('grandparent', 'main');
        stats.setTaskName('parent', 'worker-0');
        stats.setTaskName('child', 'leaf');
        stats.setTaskOwner('grandparent', 1, 'A');
        stats.updateTaskWaiter('parent', 'grandparent');
        stats.updateTaskWaiter('child', 'parent');
        stats.updateTaskStack('grandparent', [frame('main')], 10);
        stats.updateTaskStack('parent', [frame('worker')], 20);
        stats.updateTaskStack('child', [frame('leaf')], 30);
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
        stats.updateTaskStack('a', [frame('a')], 10);
        stats.updateTaskStack('b', [frame('b')], 10);

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
        stats.setTaskOwner('t1', 1, 'Loop0-Thread');
        stats.setTaskOwner('t2', 1, 'Loop1-Thread');
        stats.updateTaskStack('t1', [frame('worker')], 10);
        stats.updateTaskStack('t2', [frame('worker')], 10);
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
        // A regular sample is what actually creates the Process/Thread nodes
        // in the hierarchy -- without one, there's nothing for the group
        // header to cross-navigate to, so its frameKey stays undefined (see
        // the next test). The task itself attaches under the thread's own
        // last frame ("select", resolveTaskParent's threadLeaves lookup) --
        // the thread stack waiting on its tasks genuinely ends there.
        stats.update(7, '0x1', [frame('select')], 50);
        stats.setTaskName('t1', 'worker-0');
        stats.setTaskOwner('t1', 7, '0x1');
        stats.updateTaskStack('t1', [frame('worker')], 100);
        stats.refresh();

        const [group] = stats.getTaskForest();
        const expectedThreadKey = hashPath('Thread 0x1', hashPath('Process 7', 0));
        assert.strictEqual(group.frameKey, expectedThreadKey);

        const [task] = group.tasks;
        // The task's own entry frame is now merged by shape (see
        // finalizeTaskNodes), so its key is its first frame's content key
        // ("/mod.py:worker"), nested under "select" (the thread's own last
        // frame), since that's where it's attached.
        const expectedLeafKey = hashPath('/mod.py:select', expectedThreadKey);
        assert.strictEqual(task.frameKey, hashPath('/mod.py:worker', expectedLeafKey));
    });

    test('a task never attached to a real thread node still gets a frameKey via the fallback root', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'worker-0');
        stats.setTaskOwner('t1', 7, '0x1');
        stats.updateTaskStack('t1', [frame('worker')], 100);
        stats.refresh();

        // No regular sample was ever recorded for "7:0x1", so there's no
        // real Process/Thread node for the group header to point at -- but
        // the task itself still attaches under the flamegraph's "__tasks__"
        // fallback root (resolveTaskParent falls back to it when the
        // owner's threadLeaves entry is missing), so it's still navigable.
        const [group] = stats.getTaskForest();
        assert.strictEqual(group.frameKey, undefined);
        // Merged by shape (see finalizeTaskNodes): the key is the task's
        // first frame's content key, not the raw task id.
        assert.strictEqual(group.tasks[0].frameKey, hashPath('/mod.py:worker', hashPath('__tasks__', 0)));
    });

    test('the orphaned group frameKey matches the flame graph fallback root', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'stuck_worker');
        stats.updateTaskStack('t1', [frame('stuck_worker')], 50);
        stats.refresh();

        // A task with no waiter and no owner attaches under the flamegraph's
        // own "__tasks__" fallback root (see resolveTaskParent), which
        // finalizeTaskNodes creates during refresh() -- the orphaned group
        // here is meant to match that exact node.
        const [group] = stats.getTaskForest();
        assert.strictEqual(group.pid, -1);
        assert.strictEqual(group.frameKey, hashPath('__tasks__', 0));
    });
});


// ---------------------------------------------------------------------------
// AustinStats.updateTaskStack() — editor stats integration
// ---------------------------------------------------------------------------
suite('AustinStats.updateTaskStack() feeds editor stats', () => {

    const frame = (scope: string, line = 1) => ({ module: '/mod.py', scope, line });

    test('a task frame is recorded in locationMap like a regular sample', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'worker-0');
        stats.updateTaskStack('t1', [frame('outer', 1), frame('leaf', 2)], 100);
        stats.refresh();

        const moduleMap = stats.locationMap.get('/mod.py');
        assert.ok(moduleMap, 'module should be present in locationMap');
        const [, outerOwn, outerTotal] = [...moduleMap!.values()][0];
        assert.strictEqual(outerTotal, 100, 'every frame in the chain gets total time');
        assert.strictEqual(outerOwn, 0, 'only the leaf frame gets own time');
        const leafEntry = [...moduleMap!.values()].find(([fo]) => fo.scope === 'leaf')!;
        assert.strictEqual(leafEntry[1], 100, 'the leaf frame gets own time');
        assert.strictEqual(leafEntry[2], 100);
    });

    test('task time is added to overallTotal alongside regular sample time', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.update(1, '0x1', [frame('regular')], 50);
        stats.setTaskName('t1', 'worker-0');
        stats.updateTaskStack('t1', [frame('task-work')], 30);
        stats.refresh();

        assert.strictEqual(stats.overallTotal, 80);
    });

    test('an elapsed of null falls back to the recorded sampling interval', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setMetadata('interval', '250');
        stats.setTaskName('t1', 'worker-0');
        stats.updateTaskStack('t1', [frame('leaf')], null);
        stats.refresh();

        assert.strictEqual(stats.overallTotal, 250);
    });
});


// ---------------------------------------------------------------------------
// AustinStats.getTaskTraces()
// ---------------------------------------------------------------------------
suite('AustinStats.getTaskTraces()', () => {

    const frame = (scope: string, line = 1) => ({ module: '/mod.py', scope, line });

    test('a single root task spans from its first to its last observed position on its owning thread\'s own clock', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'worker-0');
        stats.setTaskOwner('t1', 1, '0x1');
        stats.updateTaskStack('t1', [frame('a')], 10); // t1 first-seen at thread clock 0
        stats.update(1, '0x1', [frame('loop')], 25);   // thread clock -> 25 (the ONLY thing that advances it)
        stats.updateTaskStack('t1', [frame('b')], 10); // t1 last-seen at thread clock 25
        stats.update(1, '0x1', [frame('loop')], 25);   // thread clock -> 50
        stats.refresh();

        const [group] = stats.getTaskTraces();
        assert.strictEqual(group.pid, 1);
        assert.strictEqual(group.tid, '0x1');
        const [root] = group.roots;
        assert.strictEqual(root.taskId, 't1');
        assert.strictEqual(root.name, 'worker-0');
        assert.strictEqual(root.startFraction, 0);
        assert.strictEqual(root.endFraction, 0.5, 'last-seen position (25) over the thread\'s own total (50)');
        assert.strictEqual(root.children.length, 0);
    });

    test('a task awaited by another nests under its awaiter, not as a separate root', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('parent', 'main');
        stats.setTaskName('child', 'worker-0');
        stats.setTaskOwner('parent', 1, 'A');
        stats.updateTaskWaiter('child', 'parent');
        stats.updateTaskStack('parent', [frame('main')], 10); // parent first-seen at clock 0
        stats.update(1, 'A', [frame('loop')], 25);             // clock -> 25
        stats.setTaskOwner('child', 1, 'A');
        stats.updateTaskStack('child', [frame('worker')], 10); // child first-seen at clock 25
        stats.update(1, 'A', [frame('loop')], 25);             // clock -> 50
        stats.updateTaskStack('child', [frame('worker')], 10); // child last-seen at clock 50
        stats.update(1, 'A', [frame('loop')], 25);             // clock -> 75
        stats.updateTaskStack('parent', [frame('main')], 65); // parent last-seen at clock 75, comfortably enclosing the child
        stats.refresh();

        const [group] = stats.getTaskTraces();
        assert.strictEqual(group.roots.length, 1, 'only the parent is a root; the child nests under it');
        const [root] = group.roots;
        assert.strictEqual(root.taskId, 'parent');
        assert.strictEqual(root.children.length, 1);
        const [child] = root.children;
        assert.strictEqual(child.taskId, 'child');
        // child's first flush is a single dwell block of weight 10, ending
        // at clock 25 -- its start is back-computed as 25 - 10 = 15, not 25
        // (see updateTaskStack's blockStart), so it doesn't collapse to a
        // zero-width point at its first (and, here, only early) observation.
        assert.strictEqual(child.startFraction, 15 / 75);
        assert.strictEqual(child.endFraction, 2 / 3);
    });

    test('a child\'s own back-computed start is clipped into its parent\'s window, never sticking out to the left', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('parent', 'gather-root');
        stats.setTaskName('child', 'worker-0');
        stats.setTaskOwner('parent', 1, 'A');
        stats.updateTaskWaiter('child', 'parent');

        // Parent's own single flush already covers nearly the whole window
        // (weight close to the clock at flush time -- see the eviction test
        // above), giving it a small but nonzero start.
        stats.update(1, 'A', [frame('loop')], 90);
        stats.updateTaskStack('parent', [frame('main')], 80); // parent: clock=90, weight=80 -> raw start=10

        // Child's OWN first (and only) flush has a weight far bigger than
        // the thread's elapsed clock at that early point -- its back-
        // computed start clamps to 0 on its own terms, even though it
        // logically cannot have started before the task that awaits it.
        stats.setTaskOwner('child', 1, 'A');
        stats.updateTaskStack('child', [frame('worker')], 500); // clock=90, weight=500 -> raw start clamps to 0

        stats.update(1, 'A', [frame('loop')], 10); // clock -> 100
        stats.refresh();

        const [group] = stats.getTaskTraces();
        const [root] = group.roots;
        assert.strictEqual(root.startFraction, 0.1, 'parent: (90 - 80) / 100');
        const [child] = root.children;
        // Without the parent-bounds clip this would be 0 (its own raw,
        // unclipped back-computed start) -- clipped into the parent's
        // [0.1, 0.9] window, it can't render to the left of its parent.
        assert.strictEqual(child.startFraction, root.startFraction);
    });

    test('two root tasks on different threads are normalized against their OWN thread\'s clock, independently', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'early');
        stats.setTaskOwner('t1', 1, 'A');
        stats.updateTaskStack('t1', [frame('a')], 10); // first-seen at A-clock 0
        stats.update(1, 'A', [frame('loop')], 40);      // A-clock -> 40
        stats.updateTaskStack('t1', [frame('a')], 10); // last-seen at A-clock 40
        stats.update(1, 'A', [frame('loop')], 40);      // A-clock -> 80

        stats.setTaskName('t2', 'late');
        stats.setTaskOwner('t2', 2, 'B');
        stats.updateTaskStack('t2', [frame('b')], 10); // first-seen at B-clock 0
        stats.update(2, 'B', [frame('loop')], 5);       // B-clock -> 5
        stats.updateTaskStack('t2', [frame('b')], 10); // last-seen at B-clock 5
        stats.update(2, 'B', [frame('loop')], 5);       // B-clock -> 10
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

    test('a task flushed only once (e.g. at eviction) still spans its whole reported dwell, not a zero-width point', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'gather-root');
        stats.setTaskOwner('t1', 1, 'A');
        // Austin only re-emits a task's stack when its coroutine identity
        // changes (see _py_asyncio__emit_task's fingerprint check) -- a task
        // blocked at the same await point the whole time gets exactly ONE
        // flush, typically at eviction, whose weight covers its ENTIRE
        // observed dwell rather than just the instant of this one flush.
        stats.update(1, 'A', [frame('loop')], 90); // thread clock runs ahead to 90 first
        stats.updateTaskStack('t1', [frame('main')], 80); // single flush, weight=80, at clock=90
        stats.update(1, 'A', [frame('loop')], 10); // thread clock -> 100
        stats.refresh();

        const [group] = stats.getTaskTraces();
        const [root] = group.roots;
        // Back-computed start (90 - 80 = 10) over end (90), out of a total
        // of 100 -- a real, non-degenerate span, not startFraction === endFraction.
        assert.strictEqual(root.startFraction, 0.1);
        assert.strictEqual(root.endFraction, 0.9);
    });

    test('a task never evicted (still alive when sampling stops) uses its discovery time, not a one-interval guess', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setMetadata('interval', '5'); // tiny, to make the wrong fallback obviously wrong if it were used
        stats.setTaskName('t1', 'driver');
        // Discovered near the very start of the profile...
        stats.setTaskOwner('t1', 1, 'A');
        stats.update(1, 'A', [frame('loop')], 95); // thread clock runs on for a long time
        // ...but its coroutine never changes identity again, so Austin never
        // gets a real measured dwell for it -- the only data point is the
        // end-of-stream carry flush (elapsed=null), which the naive
        // interval-based fallback would place almost entirely at the very
        // end (clock=95, weight=5 -> start=90) despite it having been
        // discovered at clock 0.
        stats.updateTaskStack('t1', [frame('main')], null);
        stats.update(1, 'A', [frame('loop')], 5); // thread clock -> 100
        stats.refresh();

        const [group] = stats.getTaskTraces();
        const [root] = group.roots;
        assert.strictEqual(root.startFraction, 0, 'uses taskDiscoveredAt (0), not the interval-based guess (90)');
        assert.strictEqual(root.endFraction, 0.95);
    });

    test('orphaned (ownerless) tasks land in a synthetic group, denominated by overallTotal', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'stuck_worker');
        stats.updateTaskStack('t1', [frame('a')], 10); // no owner -- falls back to overallTotal
        stats.update(99, 'X', [frame('other')], 20);   // unrelated sample, just to keep overallTotal nonzero
        stats.refresh();

        const [group] = stats.getTaskTraces();
        assert.strictEqual(group.pid, -1);
        assert.strictEqual(group.tid, 'orphaned');
        assert.strictEqual(group.roots[0].taskId, 't1');
    });

    test('with no tasks recorded, returns an empty list', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.refresh();
        assert.deepStrictEqual(stats.getTaskTraces(), []);
    });

    test('a task recorded with zero elapsed (overallTotal stays 0) does not divide by zero', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'worker-0');
        // elapsed=0 is a valid, distinct-from-null value: updateTaskStack
        // still creates the task node, but the `weight > 0` guard leaves
        // overallTotal at 0 -- exactly the case getTaskTraces must not
        // divide by.
        stats.updateTaskStack('t1', [frame('a')], 0);
        stats.refresh();
        assert.deepStrictEqual(stats.getTaskTraces(), []);
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

    const frame = (scope: string, line = 1) => ({ module: '/mod.py', scope, line });

    test('getTaskForest and getTaskTraces agree on the same task\'s frameKey within one refresh', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setTaskName('t1', 'worker-0');
        stats.setTaskOwner('t1', 1, '0x1');
        stats.updateTaskStack('t1', [frame('a')], 10);
        stats.update(1, '0x1', [frame('loop')], 25); // advances the thread clock so getTaskTraces' denom isn't 0
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
        stats.setTaskOwner('t1', 1, '0x1');
        stats.updateTaskStack('t1', [frame('a')], 10);
        stats.refresh();
        const firstKey = stats.getTaskForest()[0].tasks[0].frameKey;

        // A second task attaches to the SAME thread before the next refresh,
        // changing the hierarchy's shape (a new sibling branch) without
        // touching t1's own path -- t1's frameKey must still resolve
        // correctly (i.e. not fall back to a stale cached map missing the
        // now-different node identities finalizeTaskNodes rebuilt).
        stats.setTaskName('t2', 'worker-1');
        stats.setTaskOwner('t2', 1, '0x1');
        stats.updateTaskStack('t2', [frame('b')], 10);
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
        stats.setTaskOwner('t1', 1, '0x1');
        stats.updateTaskStack('t1', [frame('a')], 10);
        stats.refresh();
        stats.getTaskForest(); // populate the cache before starting a new profile

        stats.begin('test2.austin'); // calls clear() internally
        stats.setTaskName('t9', 'worker-9');
        stats.setTaskOwner('t9', 2, '0x2');
        stats.updateTaskStack('t9', [frame('c')], 10);
        stats.refresh();

        const key = stats.getTaskForest()[0].tasks[0].frameKey;
        assert.strictEqual(typeof key, 'number', 'frameKey must resolve for the new profile, not miss on a stale cache from the old one');
    });
});

// ---------------------------------------------------------------------------
// AustinStats -- task shape merging (finalizeTaskNodes)
// ---------------------------------------------------------------------------
suite('AustinStats — task shape merging in the main flamegraph', () => {

    const frame = (scope: string, line = 1) => ({ module: '/mod.py', scope, line });

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
        stats.setTaskOwner('t1', 1, 'A');
        stats.setTaskOwner('t2', 1, 'A');

        // t1's dwell block is [0, 20); t2's is [10, 30) -- they overlap for
        // [10, 20), so their union is [0, 30) = 30, not the naive sum (40).
        stats.update(1, 'A', [frame('loop')], 20);
        stats.updateTaskStack('t1', [frame('worker')], 20); // clock=20, weight=20
        stats.update(1, 'A', [frame('loop')], 10);
        stats.updateTaskStack('t2', [frame('worker')], 20); // clock=30, weight=20
        stats.refresh();

        const shape = findShapeNode(stats, '1:A');
        assert.ok(shape, 'expected the two instances to merge into one shared shape node');
        assert.strictEqual(shape!.value, 30);
    });

    test('two SEQUENTIAL (non-overlapping) instances of the same shape merge to a plain sum', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setMetadata('mode', 'wall');
        stats.setTaskOwner('t1', 1, 'A');
        stats.setTaskOwner('t2', 1, 'A');

        // t1's dwell block is [0, 20); t2's is [20, 40) -- back-to-back,
        // no overlap, so the union equals the sum (40).
        stats.update(1, 'A', [frame('loop')], 20);
        stats.updateTaskStack('t1', [frame('worker')], 20); // clock=20, weight=20
        stats.update(1, 'A', [frame('loop')], 20);
        stats.updateTaskStack('t2', [frame('worker')], 20); // clock=40, weight=20
        stats.refresh();

        const shape = findShapeNode(stats, '1:A');
        assert.ok(shape);
        assert.strictEqual(shape!.value, 40);
    });

    test('the same concurrent overlap is NOT deduplicated in CPU-time mode -- summed as-is', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setMetadata('mode', 'cpu');
        stats.setTaskOwner('t1', 1, 'A');
        stats.setTaskOwner('t2', 1, 'A');

        // Same overlapping windows as the wall-time test above ([0,20) and
        // [10,30)) -- but CPU time is already exclusive per thread (only
        // one task can be on-CPU at once), so deduplicating here would be
        // wrong; the value should be the plain sum (40), matching what
        // Austin actually measured for each.
        stats.update(1, 'A', [frame('loop')], 20);
        stats.updateTaskStack('t1', [frame('worker')], 20);
        stats.update(1, 'A', [frame('loop')], 10);
        stats.updateTaskStack('t2', [frame('worker')], 20);
        stats.refresh();

        const shape = findShapeNode(stats, '1:A');
        assert.ok(shape);
        assert.strictEqual(shape!.value, 40);
    });

    test('a task instance never seen concurrently with another keeps its own exact value', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setMetadata('mode', 'wall');
        stats.setTaskOwner('t1', 1, 'A');

        stats.update(1, 'A', [frame('loop')], 50);
        stats.updateTaskStack('t1', [frame('worker')], 20); // clock=50, weight=20 -> [30,50)
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
        stats.setTaskOwner('t1', 1, 'A');
        stats.setTaskOwner('t2', 1, 'A');

        stats.update(1, 'A', [frame('loop')], 20);
        stats.updateTaskStack('t1', [frame('worker')], 20);
        stats.update(1, 'A', [frame('loop')], 20);
        stats.updateTaskStack('t2', [frame('worker')], 20);
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

    const frame = (scope: string, line = 1) => ({ module: '/mod.py', scope, line });

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
        stats.setTaskOwner('parent', 1, 'A');
        stats.updateTaskWaiter('child', 'parent');

        stats.update(1, 'A', [frame('loop')], 20);
        stats.updateTaskStack('parent', [frame('outer')], 20); // clock=20 -> [0,20)
        stats.setTaskOwner('child', 1, 'A');
        stats.update(1, 'A', [frame('loop')], 20);
        stats.updateTaskStack('child', [frame('inner')], 20); // clock=40 -> [20,40)
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
        stats.setTaskOwner('parent', 1, 'A');
        stats.updateTaskWaiter('childA', 'parent');
        stats.updateTaskWaiter('childB', 'parent');

        stats.update(1, 'A', [frame('loop')], 20);
        stats.updateTaskStack('parent', [frame('outer')], 20); // clock=20 -> [0,20)
        stats.setTaskOwner('childA', 1, 'A');
        stats.setTaskOwner('childB', 1, 'A');
        // Both children observed within the SAME later window -- genuinely
        // concurrent (childA: [20,40), childB: [30,50), overlapping).
        stats.update(1, 'A', [frame('loop')], 20);
        stats.updateTaskStack('childA', [frame('workA')], 20); // clock=40 -> [20,40)
        stats.update(1, 'A', [frame('loop')], 10);
        stats.updateTaskStack('childB', [frame('workB')], 20); // clock=50 -> [30,50)
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
        stats.setTaskOwner('parent', 1, 'A');
        // Three DIFFERENT children, all sharing "parent" as their waiter --
        // but strictly one at a time, never overlapping, like a loop that
        // awaits a fresh task each iteration.
        stats.updateTaskWaiter('child1', 'parent');
        stats.updateTaskWaiter('child2', 'parent');
        stats.updateTaskWaiter('child3', 'parent');

        stats.update(1, 'A', [frame('loop')], 10);
        stats.updateTaskStack('parent', [frame('outer')], 10); // [0,10)
        stats.setTaskOwner('child1', 1, 'A');
        stats.update(1, 'A', [frame('loop')], 10);
        stats.updateTaskStack('child1', [frame('worker')], 10); // [10,20)
        stats.setTaskOwner('child2', 1, 'A');
        stats.update(1, 'A', [frame('loop')], 10);
        stats.updateTaskStack('child2', [frame('worker')], 10); // [20,30)
        stats.setTaskOwner('child3', 1, 'A');
        stats.update(1, 'A', [frame('loop')], 10);
        stats.updateTaskStack('child3', [frame('worker')], 10); // [30,40)
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
        assert.strictEqual(worker.value, 30, 'the three non-overlapping [10,20)+[20,30)+[30,40) windows sum without deduplication');
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

    const frame = (scope: string, line = 1) => ({ module: '/mod.py', scope, line });

    function threadLeaf(stats: AustinStats): FlameNode {
        const processNode = stats.hierarchy.children.find(c => c.key === 'Process 1')!;
        const threadNode = processNode.children.find(c => c.key === 'Thread A')!;
        return threadNode.children.find(c => c.key === '/mod.py:module')!;
    }

    test('a solo root task attaches directly to the thread\'s own last frame', () => {
        const stats = new AustinStats();
        stats.begin('test.austin');
        stats.setMetadata('mode', 'wall');
        stats.setTaskOwner('root', 1, 'A');

        stats.update(1, 'A', [frame('module')], 20);
        stats.updateTaskStack('root', [frame('work')], 20); // clock=20 -> [0,20)
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
        stats.setTaskOwner('rootA', 1, 'A');
        stats.setTaskOwner('rootB', 1, 'A');

        stats.update(1, 'A', [frame('module')], 20);
        stats.updateTaskStack('rootA', [frame('workA')], 20); // clock=20 -> [0,20)
        stats.update(1, 'A', [frame('module')], 10);
        stats.updateTaskStack('rootB', [frame('workB')], 20); // clock=30 -> [10,30) -- overlaps rootA's [0,20)
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
        stats.setTaskOwner('rootA', 1, 'A');
        stats.setTaskOwner('rootB', 1, 'A');

        stats.update(1, 'A', [frame('module')], 10);
        stats.updateTaskStack('rootA', [frame('workA')], 10); // clock=10 -> [0,10)
        stats.update(1, 'A', [frame('module')], 10);
        stats.updateTaskStack('rootB', [frame('workB')], 5); // clock=20 -> [15,20) -- strictly after [0,10)
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
