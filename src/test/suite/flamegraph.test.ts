import * as assert from 'assert';
import * as path from 'path';

// flamegraph-utils.js uses a UMD wrapper that falls back to module.exports in Node.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const utils = require(path.join(__dirname, '..', '..', '..', 'media', 'flamegraph-utils.js')) as {
    hslToHex(h: number, s: number, l: number): string;
    hash(text: string): number;
    colorFor(node: any): string;
    esc(text: string): string;
    basename(path: string): string;
    isEmpty(obj: any): boolean;
    formatValue(v: number, mode: string): string;
    footerText(node: any, rootValue: number, mode: string): string;
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
