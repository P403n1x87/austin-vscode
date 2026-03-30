import * as assert from 'assert';
import '../../stringExtension';

suite('String Extension (rsplit)', () => {

    test('splits at last occurrence when maxsplit=1', () => {
        assert.deepStrictEqual('a:b:c'.rsplit(':', 1), ['a:b', 'c']);
    });

    test('splits at last two occurrences when maxsplit=2', () => {
        assert.deepStrictEqual('a:b:c:d'.rsplit(':', 2), ['a:b', 'c', 'd']);
    });

    test('maxsplit=0 behaves like a full split', () => {
        assert.deepStrictEqual('a:b:c'.rsplit(':', 0), ['a', 'b', 'c']);
    });

    test('returns whole string in first element when separator not found', () => {
        assert.deepStrictEqual('abc'.rsplit(':', 1), ['abc']);
    });

    test('handles separator at the very end', () => {
        assert.deepStrictEqual('a:b:'.rsplit(':', 1), ['a:b', '']);
    });

    test('handles separator at the very start', () => {
        assert.deepStrictEqual(':a:b'.rsplit(':', 1), [':a', 'b']);
    });

    test('handles multi-char separator', () => {
        assert.deepStrictEqual('a::b::c'.rsplit('::', 1), ['a::b', 'c']);
    });

    test('handles space as separator (as used in sample parsing)', () => {
        assert.deepStrictEqual('P1;T1;mod:fn:10 100'.rsplit(' ', 1), ['P1;T1;mod:fn:10', '100']);
    });

    test('maxsplit larger than split count returns full split with empty first element', () => {
        // 'a:b' split on ':' gives ['a', 'b'], maxsplit=5 → slice(0,-5)=[] joined=""
        assert.deepStrictEqual('a:b'.rsplit(':', 5), ['', 'a', 'b']);
    });
});
