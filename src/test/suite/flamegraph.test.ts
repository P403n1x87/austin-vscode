import * as assert from 'assert';
import * as path from 'path';

// flamegraph-utils.js uses a UMD wrapper that falls back to module.exports in Node.
const utils = require(path.join(__dirname, '..', '..', '..', 'media', 'flamegraph-utils.js')) as {
    hslToHex(h: number, s: number, l: number): string;
    hash(text: string): number;
    colorFor(node: any): string;
    esc(text: string): string;
    basename(path: string): string;
    isEmpty(obj: any): boolean;
    formatValue(v: number, mode: string): string;
    footerText(node: any, rootValue: number, mode: string): string;
    LANE_GAP: number;
    TASK_LANE_INDENT: number;
    NESTED_TASK_SCALE: number;
    layoutTaskTower(taskNode: any, globalScale: number, rowH: number, nestScale?: number, collapseNative?: boolean): any;
    layoutTaskForest(anchors: any[], globalScale: number, rowH: number, startY?: number, nestScale?: number, collapseNative?: boolean): any;
    flattenTaskForest(forest: any, anchorOriginX: number, anchorOriginY: number, towerOriginX: number, towerOriginY: number, rowH: number): any;
    computeFloorY(rowIndex: any[][], x0: number, x1: number, rowH: number, minY: number): number;
    NATIVE_COLLAPSED_COLOR: string;
    isNative(node: any): boolean;
    firstNonNativeDescendants(node: any): any[];
    layoutFrames(zoomRoot: any, cssWidth: number, ancestors: any[], rowH: number, collapseNative?: boolean): any;
    groupAnchorsByPosition(anchors: any[]): Map<string, any[]>;
};

// ── formatValue ───────────────────────────────────────────────────────────────

suite('formatValue — cpu/wall (microseconds)', () => {
    test('sub-millisecond values in μs', () => {
        assert.strictEqual(utils.formatValue(0, 'cpu'), '0 μs');
        assert.strictEqual(utils.formatValue(1, 'cpu'), '1 μs');
        assert.strictEqual(utils.formatValue(999, 'cpu'), '999 μs');
    });

    test('millisecond range in ms', () => {
        assert.strictEqual(utils.formatValue(1000, 'cpu'), '1.00 ms');
        assert.strictEqual(utils.formatValue(500000, 'cpu'), '500.00 ms');
    });

    test('second range in s', () => {
        assert.strictEqual(utils.formatValue(1000000, 'cpu'), '1.00 s');
        assert.strictEqual(utils.formatValue(2500000, 'cpu'), '2.50 s');
    });

    test('minute range in m', () => {
        assert.strictEqual(utils.formatValue(1000000000, 'cpu'), '1.00 m');
        assert.strictEqual(utils.formatValue(60000000000, 'cpu'), '60.00 m');
    });

    test('wall mode uses same time units', () => {
        assert.strictEqual(utils.formatValue(1000, 'wall'), '1.00 ms');
        assert.strictEqual(utils.formatValue(1000000, 'wall'), '1.00 s');
    });
});

suite('formatValue — memory (bytes)', () => {
    test('sub-kilobyte values in B', () => {
        assert.strictEqual(utils.formatValue(0, 'memory'), '0 B');
        assert.strictEqual(utils.formatValue(1023, 'memory'), '1023 B');
    });

    test('kilobyte range in KB', () => {
        assert.strictEqual(utils.formatValue(1024, 'memory'), '1.00 KB');
        assert.strictEqual(utils.formatValue(1536, 'memory'), '1.50 KB');
    });

    test('megabyte range in MB', () => {
        assert.strictEqual(utils.formatValue(1024 * 1024, 'memory'), '1.00 MB');
    });

    test('gigabyte range in GB', () => {
        assert.strictEqual(utils.formatValue(1024 ** 3, 'memory'), '1.00 GB');
    });
});

// ── esc ───────────────────────────────────────────────────────────────────────

suite('esc', () => {
    test('returns empty string for falsy input', () => {
        assert.strictEqual(utils.esc(''), '');
    });

    test('escapes ampersands', () => {
        assert.strictEqual(utils.esc('a&b'), 'a&amp;b');
    });

    test('escapes angle brackets', () => {
        assert.strictEqual(utils.esc('<script>'), '&lt;script&gt;');
    });

    test('leaves plain text unchanged', () => {
        assert.strictEqual(utils.esc('hello world'), 'hello world');
    });

    test('escapes double quotes, so callers can safely embed the result in a quoted attribute', () => {
        // A task's user-set name or a scope/file path can contain a literal
        // `"`, which would otherwise break out of e.g. a `title="..."`
        // attribute. Escaping it is a no-op for the more common text-node
        // usage (a browser renders &quot; and a raw " identically there).
        assert.strictEqual(utils.esc('say "hi"'), 'say &quot;hi&quot;');
    });
});

// ── basename ──────────────────────────────────────────────────────────────────

suite('basename', () => {
    test('returns filename from Unix path', () => {
        assert.strictEqual(utils.basename('/home/user/project/foo.py'), 'foo.py');
    });

    test('returns filename from Windows path', () => {
        assert.strictEqual(utils.basename('C:\\Users\\user\\foo.py'), 'foo.py');
    });

    test('returns the input when there is no separator', () => {
        assert.strictEqual(utils.basename('foo.py'), 'foo.py');
    });

    test('returns empty string for empty input', () => {
        assert.strictEqual(utils.basename(''), '');
    });
});

// ── hash ──────────────────────────────────────────────────────────────────────

suite('hash', () => {
    test('is deterministic', () => {
        assert.strictEqual(utils.hash('hello'), utils.hash('hello'));
    });

    test('different inputs produce different values', () => {
        assert.notStrictEqual(utils.hash('foo'), utils.hash('bar'));
    });

    test('returns a number', () => {
        assert.ok(typeof utils.hash('test') === 'number');
    });
});

// ── hslToHex ──────────────────────────────────────────────────────────────────

suite('hslToHex', () => {
    test('returns a 7-character hex string', () => {
        const c = utils.hslToHex(0, 0, 100);
        assert.ok(/^#[0-9a-f]{6}$/.test(c), `expected hex string, got ${c}`);
    });

    test('white is #ffffff', () => {
        assert.strictEqual(utils.hslToHex(0, 0, 100), '#ffffff');
    });

    test('black is #000000', () => {
        assert.strictEqual(utils.hslToHex(0, 0, 0), '#000000');
    });

    test('is deterministic', () => {
        assert.strictEqual(utils.hslToHex(120, 50, 60), utils.hslToHex(120, 50, 60));
    });
});

// ── colorFor ─────────────────────────────────────────────────────────────────

suite('colorFor', () => {
    test('returns green for process nodes', () => {
        const c = utils.colorFor({ kind: 'process', name: 'Process 123' });
        assert.ok(/^#[0-9a-f]{6}$/.test(c), `expected hex color, got ${c}`);
        assert.strictEqual(c, utils.hslToHex(120, utils.hash('Process 123') % 20, 70));
    });

    test('returns blue for thread nodes', () => {
        const c = utils.colorFor({ kind: 'thread', name: 'Thread 1' });
        assert.ok(/^#[0-9a-f]{6}$/.test(c), `expected hex color, got ${c}`);
        assert.strictEqual(c, utils.hslToHex(240, utils.hash('Thread 1') % 20, 70));
    });

    test('returns a hex string for a Python frame', () => {
        const c = utils.colorFor({ kind: 'frame', name: 'my_func', file: '/app/foo.py' });
        assert.ok(/^#[0-9a-f]{6}$/.test(c), `expected hex color, got ${c}`);
    });

    test('returns a hex string for a non-Python frame', () => {
        const c = utils.colorFor({ kind: 'frame', name: 'cfunc', file: '/lib/bar.so' });
        assert.ok(/^#[0-9a-f]{6}$/.test(c), `expected hex color, got ${c}`);
    });

    test('is deterministic for the same input', () => {
        const node = { kind: 'frame', name: 'func', file: '/app/mod.py' };
        assert.strictEqual(utils.colorFor(node), utils.colorFor(node));
    });

    test('returns a neutral color for a frame with no file', () => {
        const c = utils.colorFor({ kind: 'frame', name: 'unknown' });
        assert.ok(/^#[0-9a-f]{6}$/.test(c));
    });
});

// ── footerText ────────────────────────────────────────────────────────────────

suite('footerText', () => {
    test('uses clock icon for cpu mode', () => {
        const node = { name: 'fn', value: 1000 };
        assert.ok(utils.footerText(node, 10000, 'cpu').startsWith('⏱'));
    });

    test('uses package icon for memory mode', () => {
        const node = { name: 'fn', value: 1024 };
        assert.ok(utils.footerText(node, 10240, 'memory').startsWith('📦'));
    });

    test('includes formatted value and percentage', () => {
        const node = { name: 'fn', value: 1000 };
        const text = utils.footerText(node, 10000, 'cpu');
        assert.ok(text.includes('1.00 ms'), `missing value in: ${text}`);
        assert.ok(text.includes('10.00%'), `missing pct in: ${text}`);
    });

    test('includes scope name', () => {
        const node = { name: 'my_func', value: 500 };
        const text = utils.footerText(node, 1000, 'wall');
        assert.ok(text.includes('my_func'), `missing scope in: ${text}`);
    });

    test('includes greyed file path when present', () => {
        const node = { name: 'fn', value: 500, file: '/app/mod.py' };
        const text = utils.footerText(node, 1000, 'cpu');
        assert.ok(text.includes('/app/mod.py'), `missing file in: ${text}`);
        assert.ok(text.includes('opacity:0.45'), `missing opacity in: ${text}`);
    });

    test('omits file span when no file', () => {
        const node = { name: 'fn', value: 500 };
        const text = utils.footerText(node, 1000, 'cpu');
        assert.ok(!text.includes('opacity'), `unexpected opacity in: ${text}`);
    });

    test('escapes HTML in scope name', () => {
        const node = { name: '<evil>', value: 100 };
        const text = utils.footerText(node, 1000, 'cpu');
        assert.ok(!text.includes('<evil>'), 'raw HTML should be escaped');
        assert.ok(text.includes('&lt;evil&gt;'));
    });
});

// ── Floating task sub-flamegraphs ───────────────────────────────────────────

function frameNode(key: string, value: number, children: any[] = []) {
    return { kind: 'frame', key, name: key, value, children };
}

function nativeFrameNode(key: string, value: number, children: any[] = []) {
    return { kind: 'frame', key, name: key, value, children, file: 'libfoo.so' };
}

function taskNode(key: string, value: number, children: any[] = []) {
    return { kind: 'task', key, name: key, value, children };
}

suite('layoutTaskTower', () => {
    const ROW_H = 24;
    const SCALE = 1; // 1px per unit of value, for arithmetic simplicity

    test('a leafless task is just its own frame row, no children', () => {
        const task = taskNode('t1', 100);
        const tower = utils.layoutTaskTower(task, SCALE, ROW_H);
        assert.strictEqual(tower.ownHeight, ROW_H, 'the task itself is now an ordinary row at depth 0');
        assert.strictEqual(tower.subtreeHeight, ROW_H);
        assert.strictEqual(tower.childForest.towers.length, 0);
        assert.strictEqual(tower.frames.length, 1, 'just the task node\'s own frame');
        assert.strictEqual(tower.frames[0].node, task);
        assert.strictEqual(tower.frames[0].depth, 0);
        assert.strictEqual(tower.width, 100 * utils.NESTED_TASK_SCALE, 'a root-level task is shrunk by one NESTED_TASK_SCALE factor');
    });

    test('own rows scale with call depth, including the task\'s own frame', () => {
        const task = taskNode('t1', 100, [frameNode('a', 100, [frameNode('b', 100)])]);
        const tower = utils.layoutTaskTower(task, SCALE, ROW_H);
        // t1 (depth 0), 'a' (depth 1), 'b' (depth 2)
        assert.strictEqual(tower.ownHeight, 3 * ROW_H);
        assert.strictEqual(tower.subtreeHeight, 3 * ROW_H);
        assert.strictEqual(tower.frames.length, 3);
    });

    test('a nested task attachment adds to subtreeHeight but not ownHeight', () => {
        const nested = taskNode('sub', 50);
        const task = taskNode('t1', 100, [frameNode('a', 100, [nested])]);
        const tower = utils.layoutTaskTower(task, SCALE, ROW_H);
        assert.strictEqual(tower.ownHeight, 2 * ROW_H); // t1 + 'a' -- 'sub' excluded (floats separately)
        assert.strictEqual(tower.childForest.towers.length, 1);
        // t1's own two rows, then the nested sub-task's own single-row tower
        assert.strictEqual(tower.subtreeHeight, 2 * ROW_H + utils.LANE_GAP + ROW_H);
    });

    test('a task-kind child is excluded from the normal width-split frames', () => {
        const nested = taskNode('sub', 50);
        const task = taskNode('t1', 100, [nested]);
        const tower = utils.layoutTaskTower(task, SCALE, ROW_H);
        assert.strictEqual(tower.frames.length, 1, 'just t1\'s own frame -- the nested task is attached directly, not a normal child');
        assert.strictEqual(tower.frames[0].node, task);
        assert.strictEqual(tower.childForest.towers[0].anchor.taskNode, nested);
    });

    test('scale compounds with nesting depth: 95% at the root, 95% of that one level deeper', () => {
        const nested = taskNode('sub', 50);
        const task = taskNode('t1', 100, [nested]);
        const tower = utils.layoutTaskTower(task, SCALE, ROW_H);
        assert.strictEqual(tower.width, 100 * utils.NESTED_TASK_SCALE);

        const nestedTower = tower.childForest.towers[0].tower;
        assert.strictEqual(nestedTower.width, 50 * utils.NESTED_TASK_SCALE * utils.NESTED_TASK_SCALE);
    });

    test('an explicit nestScale of 1 behaves the same as the default (one factor at this level)', () => {
        const task = taskNode('t1', 100);
        const withDefault = utils.layoutTaskTower(task, SCALE, ROW_H);
        const withExplicit = utils.layoutTaskTower(task, SCALE, ROW_H, 1);
        assert.strictEqual(withDefault.width, withExplicit.width);
    });

    // ── children wider than their parent ────────────────────────────────
    // A task's own value is how long that shape was itself observed, not a
    // bottom-up sum of its children -- so its children's combined value can
    // legitimately exceed it (e.g. two branches that each independently
    // dedupe overlapping concurrent instances). See the matching tests on
    // layoutFrames' own scale computation for the general layout rule.

    test('a task\'s own children are shrunk to fit within its box when their combined value exceeds it', () => {
        const task = taskNode('t1', 10, [frameNode('a', 30), frameNode('b', 10)]); // sums to 40, t1 is only 10
        const tower = utils.layoutTaskTower(task, SCALE, ROW_H);
        const a = tower.frames.find((f: any) => f.node.key === 'a')!;
        const b = tower.frames.find((f: any) => f.node.key === 'b')!;
        assert.ok(Math.abs((a.w + b.w) - tower.width) < 1e-6, 'children must fill exactly the task\'s own rendered width');
        assert.ok(Math.abs(a.w - tower.width * 0.75) < 1e-6, 'still proportional to each other (30:10 = 3:1)');
    });

    test('an overrun several levels deep is clamped against its OWN actual (already-shrunk) width, not its raw value', () => {
        // Regression test: a naive fix might re-derive each level's
        // available width from its raw `value` instead of the box width
        // `w` it actually got handed down from its (possibly already
        // shrunk) parent, silently reintroducing overflow at any level
        // whose ancestor was ALSO clamped.
        const grandchild = frameNode('c', 30); // overruns 'b' on its own (b.value=10 < 30)
        const child = frameNode('b', 10, [grandchild]);
        const task = taskNode('t1', 10, [frameNode('a', 30), child]); // 'a'+'b' overrun t1 too (40 > 10)
        const tower = utils.layoutTaskTower(task, SCALE, ROW_H);

        const byKey = new Map<string, any>(tower.frames.map((f: any) => [f.node.key, f]));
        const a = byKey.get('a')!, b = byKey.get('b')!, c = byKey.get('c')!;
        assert.ok(Math.abs((a.w + b.w) - tower.width) < 1e-6, 't1\'s own children must fit within its box');
        assert.ok(c.w <= b.w + 1e-6, 'b\'s own child must fit within b\'s ACTUAL (already-shrunk) width, not b\'s raw value');
    });

    test('a normal (non-overrunning) task tower is unaffected by the overrun guard', () => {
        const task = taskNode('t1', 100, [frameNode('a', 60), frameNode('b', 30)]); // sums to 90 <= 100
        const tower = utils.layoutTaskTower(task, SCALE, ROW_H);
        const a = tower.frames.find((f: any) => f.node.key === 'a')!;
        const b = tower.frames.find((f: any) => f.node.key === 'b')!;
        assert.strictEqual(a.w, 60 * utils.NESTED_TASK_SCALE);
        assert.strictEqual(b.w, 30 * utils.NESTED_TASK_SCALE);
    });

    // ── collapseNative ────────────────────────────────────────────────────
    // Mirrors layoutFrames' own collapseNative behavior inside a task's own
    // internal call chain, so toggling "Collapse native frames" applies to
    // floating task towers too, not just the main tree.

    test('without collapseNative, every frame (including native ones) gets its own row', () => {
        const task = taskNode('t1', 100, [nativeFrameNode('native_call', 100, [frameNode('py_call', 100)])]);
        const tower = utils.layoutTaskTower(task, SCALE, ROW_H);
        assert.strictEqual(tower.frames.length, 3);
        assert.strictEqual(tower.frames.every((f: any) => !f.collapsedNative), true);
    });

    test('collapseNative flags a native frame but still gives it (and its first non-native descendant) their own row', () => {
        // "Collapse" means the native frame's OWN children skip ahead to the
        // first non-native descendants when ITS children are computed -- the
        // native frame itself is still a real row, just flagged, exactly
        // like layoutFrames' main-tree behavior.
        const task = taskNode('t1', 100, [nativeFrameNode('native_call', 100, [frameNode('py_call', 100)])]);
        const tower = utils.layoutTaskTower(task, SCALE, ROW_H, undefined, true);
        assert.strictEqual(tower.frames.length, 3, 'task row + native row + its first non-native descendant');
        const nativeRow = tower.frames.find((f: any) => f.node.key === 'native_call');
        assert.ok(nativeRow, 'the native frame itself is still shown, just flagged as collapsed');
        assert.strictEqual(nativeRow.depth, 1);
        assert.strictEqual(nativeRow.collapsedNative, true);
        const pyRow = tower.frames.find((f: any) => f.node.key === 'py_call');
        assert.ok(pyRow, 'py_call is still reachable, one level deeper than the native frame that hosts it');
        assert.strictEqual(pyRow.depth, 2);
        assert.strictEqual(pyRow.collapsedNative, false);
    });

    test('collapseNative skips over a chain of consecutive native frames to reach the first Python descendant', () => {
        const task = taskNode('t1', 100, [
            nativeFrameNode('native_1', 100, [
                nativeFrameNode('native_2', 100, [frameNode('py_call', 100)]),
            ]),
        ]);
        const tower = utils.layoutTaskTower(task, SCALE, ROW_H, undefined, true);
        // task(0) + native_1(1) -- native_2 is skipped over entirely
        // (firstNonNativeDescendants recurses past it), landing py_call
        // directly under native_1 at depth 2.
        assert.strictEqual(tower.frames.length, 3);
        assert.ok(!tower.frames.some((f: any) => f.node.key === 'native_2'), 'the intermediate native frame is skipped, not shown');
        const pyRow = tower.frames.find((f: any) => f.node.key === 'py_call');
        assert.ok(pyRow);
        assert.strictEqual(pyRow.depth, 2);
    });

    test('collapseNative marks the task\'s own row too when its entry frame is itself native', () => {
        // A task's own file/scope come from whatever frame it was merged
        // into (see AustinStats.finalizeTaskNodes) -- it can be native.
        const task = { kind: 'task', key: 't1', name: 't1', value: 100, children: [], file: 'libfoo.so' };
        const tower = utils.layoutTaskTower(task, SCALE, ROW_H, undefined, true);
        assert.strictEqual(tower.frames[0].collapsedNative, true);
    });

    test('collapseNative is threaded down into nested task towers via layoutTaskForest', () => {
        const nested = { kind: 'task', key: 'sub', name: 'sub', value: 50, children: [], file: 'libfoo.so' };
        const task = taskNode('t1', 100, [frameNode('a', 100, [nested])]);
        const tower = utils.layoutTaskTower(task, SCALE, ROW_H, undefined, true);
        const nestedTower = tower.childForest.towers[0].tower;
        assert.strictEqual(nestedTower.frames[0].collapsedNative, true, 'the nested task\'s own collapseNative-sensitive row must reflect the same flag');
    });
});

// Shared by the main canvas render, the minimap, and the exported static
// SVG's own layout (both the initial render and its embedded re-layout
// script) -- see media/flamegraph.js, src/flamegraph-svg.ts and
// media/flamegraph-embedded.js.
suite('groupAnchorsByPosition', () => {
    test('groups anchors that share the exact same attachment point', () => {
        const a1 = { taskNode: taskNode('a', 10), anchorX: 5, anchorY: 24, anchorW: 100, anchorDepth: 1 };
        const a2 = { taskNode: taskNode('b', 10), anchorX: 5, anchorY: 24, anchorW: 100, anchorDepth: 1 };
        const groups = utils.groupAnchorsByPosition([a1, a2]);
        assert.strictEqual(groups.size, 1);
        assert.deepStrictEqual([...groups.values()][0], [a1, a2]);
    });

    test('keeps anchors at different positions in separate groups', () => {
        const a1 = { taskNode: taskNode('a', 10), anchorX: 5, anchorY: 24, anchorW: 100, anchorDepth: 1 };
        const a2 = { taskNode: taskNode('b', 10), anchorX: 5, anchorY: 48, anchorW: 100, anchorDepth: 2 };
        const groups = utils.groupAnchorsByPosition([a1, a2]);
        assert.strictEqual(groups.size, 2);
    });

    test('returns an empty map for no anchors', () => {
        assert.strictEqual(utils.groupAnchorsByPosition([]).size, 0);
    });
});

suite('layoutTaskForest', () => {
    const ROW_H = 24;
    const SCALE = 1;

    test('stacks sibling towers using full subtreeHeight, not just ownHeight', () => {
        // worker1 has a nested sub-task (so its subtreeHeight > ownHeight);
        // worker2 has none. worker2 must start after worker1's FULL subtree.
        const sub = taskNode('sub', 50);
        const worker1 = taskNode('w1', 300, [frameNode('work', 300, [frameNode('call', 300, [sub])])]);
        const worker2 = taskNode('w2', 300, [frameNode('work2', 300)]);

        const anchors = [
            { taskNode: worker1, anchorX: 0, anchorY: 0, anchorW: 500, anchorDepth: 0 },
            { taskNode: worker2, anchorX: 0, anchorY: 0, anchorW: 500, anchorDepth: 0 },
        ];
        const forest = utils.layoutTaskForest(anchors, SCALE, ROW_H);

        assert.strictEqual(forest.towers[0].offsetY, 0);
        const worker1SubtreeHeight = forest.towers[0].tower.subtreeHeight;
        assert.ok(worker1SubtreeHeight > forest.towers[0].tower.ownHeight, 'worker1 must reserve extra space for its nested sub-task');
        assert.strictEqual(
            forest.towers[1].offsetY,
            worker1SubtreeHeight + utils.LANE_GAP,
            "worker2 must clear worker1's entire subtree, not just its own rows"
        );
    });

    test('every tower gets the same horizontal indent, regardless of literal anchor position', () => {
        const anchors = [
            { taskNode: taskNode('a', 10), anchorX: 5, anchorY: 0, anchorW: 20, anchorDepth: 0 },
            { taskNode: taskNode('b', 10), anchorX: 500, anchorY: 100, anchorW: 20, anchorDepth: 3 },
        ];
        const forest = utils.layoutTaskForest(anchors, SCALE, ROW_H);
        assert.strictEqual(forest.towers[0].offsetX, utils.TASK_LANE_INDENT);
        assert.strictEqual(forest.towers[1].offsetX, utils.TASK_LANE_INDENT);
    });

    test('empty anchor list produces an empty, zero-height forest', () => {
        const forest = utils.layoutTaskForest([], SCALE, ROW_H);
        assert.strictEqual(forest.towers.length, 0);
        assert.strictEqual(forest.totalHeight, 0);
    });
});

suite('flattenTaskForest', () => {
    const ROW_H = 24;
    const SCALE = 1;

    test('spine emanates from the anchor\'s (already-absolute) left edge, bottom of its row, to the tower\'s own top row', () => {
        const worker = taskNode('w1', 100);
        // A top-level anchor's coordinates are already absolute (collected
        // during the main flamegraph's own layout) -- anchorOrigin is (0,0);
        // only the tower itself gets placed at a chosen origin (e.g. just
        // below the anchor's row, which may be far from the anchor's own X).
        const anchors = [{ taskNode: worker, anchorX: 10, anchorY: 20, anchorW: 200, anchorDepth: 1 }];
        const forest = utils.layoutTaskForest(anchors, SCALE, ROW_H);

        const flat = utils.flattenTaskForest(forest, 0, 0, 1000, 2000, ROW_H);
        assert.strictEqual(flat.spines.length, 1);
        const spine = flat.spines[0];
        assert.strictEqual(spine.fromX, 10); // anchor's own left edge, untranslated
        assert.strictEqual(spine.fromY, 20 + ROW_H); // bottom of the anchor's row
        assert.strictEqual(spine.toX, 1000 + utils.TASK_LANE_INDENT); // tower placed at the chosen origin
        assert.strictEqual(spine.toY, 2000 + ROW_H / 2); // vertical center of the tower's own top row (the task's own frame)
    });

    test('the task node itself becomes the tower\'s own top-level frame', () => {
        const worker = taskNode('w1', 100, [frameNode('a', 100)]);
        const anchors = [{ taskNode: worker, anchorX: 0, anchorY: 0, anchorW: 100, anchorDepth: 0 }];
        const forest = utils.layoutTaskForest(anchors, SCALE, ROW_H);
        const flat = utils.flattenTaskForest(forest, 0, 0, 1000, 2000, ROW_H);

        assert.strictEqual(flat.frames.length, 2, 'the task\'s own frame, plus its child \'a\'');
        const ownFrame = flat.frames.find((f: any) => f.node === worker);
        assert.ok(ownFrame, 'the task node itself must appear as an ordinary frame');
        assert.strictEqual(ownFrame.depth, 0);
        assert.strictEqual(ownFrame.x, 1000 + utils.TASK_LANE_INDENT);
        assert.strictEqual(ownFrame.y, 2000);
        assert.strictEqual(ownFrame.w, 100 * utils.NESTED_TASK_SCALE);
    });

    test('content frames start one row below the task\'s own frame, not overlapping it', () => {
        const worker = taskNode('w1', 100, [frameNode('a', 100)]);
        const anchors = [{ taskNode: worker, anchorX: 0, anchorY: 0, anchorW: 100, anchorDepth: 0 }];
        const forest = utils.layoutTaskForest(anchors, SCALE, ROW_H);
        const flat = utils.flattenTaskForest(forest, 0, 0, 0, 0, ROW_H);

        assert.strictEqual(flat.frames.length, 2);
        const childFrame = flat.frames.find((f: any) => f.node !== worker);
        assert.strictEqual(childFrame.y, ROW_H, "frame 'a' starts right below the task's own row");
    });

    test('recurses into nested forests using the tower\'s own absolute content origin for both anchor and tower', () => {
        const sub = taskNode('sub', 50);
        const worker = taskNode('w1', 100, [sub]);
        const anchors = [{ taskNode: worker, anchorX: 0, anchorY: 0, anchorW: 100, anchorDepth: 0 }];
        const forest = utils.layoutTaskForest(anchors, SCALE, ROW_H);

        const flat = utils.flattenTaskForest(forest, 0, 0, 0, 0, ROW_H);
        assert.strictEqual(flat.spines.length, 2, 'one spine for worker, one for the nested sub-task');
        assert.strictEqual(flat.frames.length, 2, 'one own-frame for worker, one for the nested sub-task');
        // Nested spine's toX must be offset from worker's OWN absolute origin (TASK_LANE_INDENT),
        // not from the outer forest's origin directly.
        assert.strictEqual(flat.spines[1].toX, utils.TASK_LANE_INDENT + utils.TASK_LANE_INDENT);
    });

    test('nested frame bottoms match the predicted totalHeight exactly, at any origin', () => {
        // Two levels of nesting, placed at a non-zero origin -- this is the
        // combination that would expose any drift between layoutTaskTower's
        // subtreeHeight prediction and flattenTaskForest's actual placement,
        // which would otherwise crop the deepest content on a canvas sized
        // from forest.totalHeight.
        const sub = taskNode('sub', 50, [frameNode('inner', 50)]);
        const worker = taskNode('w1', 100, [frameNode('call', 100, [sub])]);
        const anchors = [{ taskNode: worker, anchorX: 0, anchorY: 0, anchorW: 100, anchorDepth: 0 }];
        const forest = utils.layoutTaskForest(anchors, SCALE, ROW_H);

        const originY = 1000;
        const flat = utils.flattenTaskForest(forest, 0, 0, 0, originY, ROW_H);

        let maxBottom = 0;
        for (const f of flat.frames) { maxBottom = Math.max(maxBottom, f.y + ROW_H); }
        assert.strictEqual(
            maxBottom, originY + forest.totalHeight,
            'the deepest content\'s actual bottom must match what totalHeight predicted -- a mismatch means the canvas will crop it'
        );
    });

    test('flattened frame count matches every tower\'s own frame plus its nested towers\' own frames', () => {
        const sub = taskNode('sub', 50, [frameNode('inner', 50)]);
        const worker = taskNode('w1', 100, [frameNode('call', 100, [sub])]);
        const anchors = [{ taskNode: worker, anchorX: 0, anchorY: 0, anchorW: 100, anchorDepth: 0 }];
        const forest = utils.layoutTaskForest(anchors, SCALE, ROW_H);
        const flat = utils.flattenTaskForest(forest, 0, 0, 0, 0, ROW_H);
        // worker tower: w1 + 'call'; sub tower: sub + 'inner' -- the task nodes are now ordinary frames too
        assert.strictEqual(flat.frames.length, 4);
    });
});

suite('computeFloorY', () => {
    const ROW_H = 24;

    test('ignores frames with no horizontal overlap, regardless of depth', () => {
        // A very deep frame far to the right must not push the floor down
        // for a range that doesn't overlap it at all.
        const rowIndex = [[{ x: 500, y: 5000, w: 50 }]];
        const floor = utils.computeFloorY(rowIndex, 0, 100, ROW_H, 24);
        assert.strictEqual(floor, 24, 'unrelated deep frame elsewhere must not affect an unrelated column');
    });

    test('accounts for a shallow frame that does overlap horizontally', () => {
        const rowIndex = [[{ x: 0, y: 48, w: 100 }]]; // bottom at 48+24=72
        const floor = utils.computeFloorY(rowIndex, 10, 60, ROW_H, 24);
        assert.strictEqual(floor, 72);
    });

    test('returns minY when nothing overlaps', () => {
        const floor = utils.computeFloorY([], 0, 100, ROW_H, 24);
        assert.strictEqual(floor, 24);
    });

    test('takes the deepest of multiple overlapping frames', () => {
        // One row per frame here (an x-ascending array is all a row needs
        // to be) -- computeFloorY doesn't care what a "row" represents
        // semantically, only that each one is sorted by x.
        const rowIndex = [
            [{ x: 0, y: 24, w: 100 }],  // bottom 48
            [{ x: 20, y: 96, w: 30 }],  // bottom 120, overlaps [10,60]
            [{ x: 90, y: 500, w: 30 }], // bottom 524, does NOT overlap [10,60]
        ];
        const floor = utils.computeFloorY(rowIndex, 10, 60, ROW_H, 24);
        assert.strictEqual(floor, 120);
    });

    test('takes the deepest of multiple overlapping frames within the SAME x-sorted row', () => {
        const rowIndex = [[
            { x: 0, y: 24, w: 15 },   // bottom 48, overlaps [10,60]
            { x: 20, y: 96, w: 30 },  // bottom 120, overlaps [10,60]
            { x: 90, y: 500, w: 30 }, // bottom 524, does NOT overlap [10,60]
        ]];
        const floor = utils.computeFloorY(rowIndex, 10, 60, ROW_H, 24);
        assert.strictEqual(floor, 120);
    });

    test('a hairline (sub-pixel) boundary touch does not count as a clash (regression: unrelated deep sibling branch)', () => {
        // Two unrelated sibling branches under the same parent (e.g. a deep
        // import-machinery chain sitting right next to a wide asyncio call
        // chain) can end up with adjoining edges that differ only by
        // floating-point rounding. A very deep frame (bottom at y=936, depth
        // 38) whose right edge is a hair's width into [x0, x1) must not drag
        // the floor down to clear it -- that's an unrelated branch, not a
        // real visual clash.
        const rowIndex = [[{ x: 0, y: 912, w: 24.5721 }]]; // right edge 0.0001 past x0
        const floor = utils.computeFloorY(rowIndex, 24.5720, 840, ROW_H, 30);
        assert.strictEqual(floor, 30, 'a sub-pixel touch from an unrelated deep branch must not be treated as a clash');
    });

    test('still accounts for a frame that genuinely overlaps by more than a hairline', () => {
        const rowIndex = [[{ x: 0, y: 912, w: 30 }]]; // right edge clearly past x0
        const floor = utils.computeFloorY(rowIndex, 24.572, 840, ROW_H, 30);
        assert.strictEqual(floor, 912 + ROW_H, 'a real overlap must still push the floor down');
    });

    test('a frame just past x1 (start >= x1) is excluded by the forward-scan cutoff', () => {
        const rowIndex = [[
            { x: 0, y: 24, w: 5 },     // overlaps [0,10)
            { x: 10, y: 9999, w: 5 },  // starts exactly at x1 -- must not overlap
        ]];
        const floor = utils.computeFloorY(rowIndex, 0, 10, ROW_H, 0);
        assert.strictEqual(floor, 24 + ROW_H, 'the frame starting at x1 must not affect the floor');
    });
});

// ── layoutFrames (main-tree layout) ──────────────────────────────────────────
//
// Shared by the interactive webview, the exported static SVG's initial
// render, and that SVG's own embedded interactive script -- see
// src/flamegraph-svg.ts and media/flamegraph-embedded.js.

suite('layoutFrames', () => {
    const ROW_H = 24;

    test('lays out the root and its children proportionally to width', () => {
        const root = frameNode('root', 100, [frameNode('a', 60), frameNode('b', 40)]);
        const { frames } = utils.layoutFrames(root, 1000, [], ROW_H);
        assert.strictEqual(frames.length, 3);
        const a = frames.find((f: any) => f.node.key === 'a')!;
        const b = frames.find((f: any) => f.node.key === 'b')!;
        assert.strictEqual(a.w, 600);
        assert.strictEqual(b.w, 400);
        assert.strictEqual(b.x, 600, 'b starts right after a');
    });

    test('renders ancestors as full-width dimmed rows above the zoom root', () => {
        const root = frameNode('root', 100);
        const { frames } = utils.layoutFrames(root, 1000, [{ kind: 'frame', key: 'anc', name: 'anc', value: 1 }], ROW_H);
        const ancestorFrame = frames.find((f: any) => f.node.key === 'anc')!;
        assert.strictEqual(ancestorFrame.ancestor, true);
        assert.strictEqual(ancestorFrame.w, 1000, 'ancestor spans the full width regardless of its own value');
        const rootFrame = frames.find((f: any) => f.node.key === 'root')!;
        assert.strictEqual(rootFrame.depth, 1, 'zoom root sits one row below the ancestor');
    });

    test('task-kind children are collected as anchors, not laid out as width-sharing children', () => {
        const task = taskNode('t1', 50);
        const root = frameNode('root', 100, [frameNode('a', 100, []), task]);
        // Note: task is a direct child of root here for anchor-position simplicity.
        const { frames, anchors } = utils.layoutFrames(root, 1000, [], ROW_H);
        assert.ok(!frames.some((f: any) => f.node === task), 'task node itself must not appear as a normal frame');
        assert.strictEqual(anchors.length, 1);
        assert.strictEqual(anchors[0].taskNode, task);
    });

    test('a child narrower than 1px is dropped, matching the main flamegraph', () => {
        const root = frameNode('root', 10000, [frameNode('big', 9999), frameNode('tiny', 1)]);
        const { frames } = utils.layoutFrames(root, 100, [], ROW_H); // tiny gets 0.01px
        assert.ok(!frames.some((f: any) => f.node.key === 'tiny'), 'sub-pixel child should be dropped');
        assert.ok(frames.some((f: any) => f.node.key === 'big'));
    });

    // Not every node's value is a bottom-up sum of its children -- a task
    // node's value is how long that shape was itself observed, which can be
    // less than the cumulative work of everything it delegated to (see
    // AustinStats.finalizeTaskNodes). Proportional width layout has to stay
    // sane even when children's combined weight exceeds their parent's.
    test('children whose combined value exceeds their parent are shrunk to fit within it', () => {
        const root = frameNode('root', 10, [frameNode('a', 30), frameNode('b', 10)]); // sums to 40, root is only 10
        const { frames } = utils.layoutFrames(root, 1000, [], ROW_H);
        const a = frames.find((f: any) => f.node.key === 'a')!;
        const b = frames.find((f: any) => f.node.key === 'b')!;
        assert.ok(Math.abs((a.w + b.w) - 1000) < 1e-6, 'children must fill exactly the parent\'s own width, not overrun it');
        assert.ok(Math.abs(a.w - 750) < 1e-6, 'still proportional to each other (30:10 = 3:1)');
        assert.ok(Math.abs(b.w - 250) < 1e-6);
    });

    test('a normal (non-overrunning) tree is laid out identically whether or not the overrun guard is exercised elsewhere', () => {
        const root = frameNode('root', 100, [frameNode('a', 60), frameNode('b', 30)]); // sums to 90 <= 100
        const { frames } = utils.layoutFrames(root, 1000, [], ROW_H);
        const a = frames.find((f: any) => f.node.key === 'a')!;
        const b = frames.find((f: any) => f.node.key === 'b')!;
        assert.strictEqual(a.w, 600, 'unaffected: still value/parent.value * width, not value/childrenTotal');
        assert.strictEqual(b.w, 300);
    });
});
