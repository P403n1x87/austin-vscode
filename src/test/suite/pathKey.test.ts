import * as assert from 'assert';
import { hashPath } from '../../utils/pathKey';

suite('hashPath', () => {

    test('returns a 32-bit unsigned integer', () => {
        const h = hashPath('hello');
        assert.strictEqual(typeof h, 'number');
        assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xFFFF_FFFF,
            `${h} should be an integer in [0, 2^32)`);
    });

    test('no-seed call is equivalent to seed=0', () => {
        assert.strictEqual(hashPath('foo'), hashPath('foo', 0));
        assert.strictEqual(hashPath('Process 1'), hashPath('Process 1', 0));
    });

    test('is deterministic', () => {
        assert.strictEqual(hashPath('foo', 42), hashPath('foo', 42));
    });

    test('different names produce different hashes', () => {
        assert.notStrictEqual(hashPath('fn'), hashPath('other'));
        assert.notStrictEqual(hashPath('Process 1'), hashPath('Thread 1'));
    });

    test('rolling hash is order-sensitive (A→B ≠ B→A)', () => {
        const ab = hashPath('B', hashPath('A'));
        const ba = hashPath('A', hashPath('B'));
        assert.notStrictEqual(ab, ba);
    });

    test('rolling hash is depth-sensitive (same leaf under different parents)', () => {
        const aFn = hashPath('fn', hashPath('A'));
        const bFn = hashPath('fn', hashPath('B'));
        assert.notStrictEqual(aFn, bFn);
    });

    test('rolling chain matches the path used by the extension and the webview', () => {
        // Simulate the path built for Process 1 → Thread 1 → /a.py:fn.
        // Both callstack.ts (extension host) and flamegraph.js (webview) compute
        // frameKey the same way because they share this function.
        // Process/thread nodes have no module, so their key is the bare scope name.
        // Frame nodes use "module:scope" as their key (matching node.key in the hierarchy).
        const processKey = hashPath('Process 1');
        const threadKey  = hashPath('Thread 1', processKey);
        const fnKey      = hashPath('/a.py:fn', threadKey);

        // All three keys must be distinct
        const keys = new Set([processKey, threadKey, fnKey]);
        assert.strictEqual(keys.size, 3, 'process, thread, and frame keys must all differ');

        // Each level must differ from a flat (unseeded) hash of the same name
        assert.notStrictEqual(threadKey, hashPath('Thread 1'));
        assert.notStrictEqual(fnKey,     hashPath('/a.py:fn'));
    });
});
