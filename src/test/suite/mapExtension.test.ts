import * as assert from 'assert';
import '../../mapExtension';

suite('Map Extension (getDefault)', () => {

    test('returns existing value when key is present', () => {
        const map = new Map<string, number>([['a', 42]]);
        assert.strictEqual(map.getDefault('a', () => 0), 42);
    });

    test('inserts and returns default when key is missing', () => {
        const map = new Map<string, number>();
        const result = map.getDefault('x', () => 99);
        assert.strictEqual(result, 99);
        assert.strictEqual(map.get('x'), 99);
    });

    test('default factory is not called when key exists', () => {
        const map = new Map<string, number>([['a', 1]]);
        let called = false;
        map.getDefault('a', () => { called = true; return 0; });
        assert.strictEqual(called, false);
    });

    test('default factory is called exactly once when key is missing', () => {
        const map = new Map<string, number>();
        let callCount = 0;
        map.getDefault('k', () => { callCount++; return 5; });
        assert.strictEqual(callCount, 1);
    });

    test('subsequent access returns the previously inserted default', () => {
        const map = new Map<string, number>();
        map.getDefault('k', () => 7);
        const second = map.getDefault('k', () => 99);
        assert.strictEqual(second, 7);
    });

    test('works with object values', () => {
        const map = new Map<string, string[]>();
        const arr = map.getDefault('list', () => []);
        arr.push('item');
        assert.deepStrictEqual(map.get('list'), ['item']);
    });

    test('works with numeric keys', () => {
        const map = new Map<number, string>();
        assert.strictEqual(map.getDefault(1, () => 'one'), 'one');
        assert.strictEqual(map.get(1), 'one');
    });
});
