import * as assert from 'assert';
import { formatTime, formatMemory, formatInterval } from '../../view';

suite('formatTime', () => {

    test('formats sub-millisecond values in microseconds', () => {
        assert.strictEqual(formatTime(0), '0μs');
        assert.strictEqual(formatTime(1), '1μs');
        assert.strictEqual(formatTime(999), '999μs');
    });

    test('formats millisecond-range values in ms', () => {
        assert.strictEqual(formatTime(1000), '1.00ms');
        assert.strictEqual(formatTime(1500), '1.50ms');
        assert.strictEqual(formatTime(999999), '1000.00ms');
    });

    test('formats second-range values in s', () => {
        assert.strictEqual(formatTime(1000000), '1.00s');
        assert.strictEqual(formatTime(1500000), '1.50s');
        assert.strictEqual(formatTime(999999999), '1000.00s');
    });

    test('formats very large values in minutes notation', () => {
        // ≥ 1_000_000_000 μs
        assert.strictEqual(formatTime(1000000000), '1.00m');
        assert.strictEqual(formatTime(60000000000), '60.00m');
    });
});

suite('formatMemory', () => {

    test('formats sub-kilobyte values in bytes', () => {
        assert.strictEqual(formatMemory(0), '0B');
        assert.strictEqual(formatMemory(1), '1B');
        assert.strictEqual(formatMemory(1023), '1023B');
    });

    test('formats kilobyte-range values in KB', () => {
        assert.strictEqual(formatMemory(1024), '1.00KB');
        assert.strictEqual(formatMemory(1536), '1.50KB');
        assert.strictEqual(formatMemory(1024 * 1024 - 1), '1024.00KB');
    });

    test('formats megabyte-range values in MB', () => {
        assert.strictEqual(formatMemory(1024 * 1024), '1.00MB');
        assert.strictEqual(formatMemory(1024 * 1024 * 1.5), '1.50MB');
    });

    test('formats gigabyte-range values in GB', () => {
        assert.strictEqual(formatMemory(1024 * 1024 * 1024), '1.00GB');
        assert.strictEqual(formatMemory(1024 * 1024 * 1024 * 2), '2.00GB');
    });
});

suite('formatInterval', () => {

    test('formats sub-millisecond intervals in μs', () => {
        assert.strictEqual(formatInterval(1), '1 μs');
        assert.strictEqual(formatInterval(999), '999 μs');
    });

    test('formats 1000–9999 μs with one decimal in ms', () => {
        assert.strictEqual(formatInterval(1000), '1.0 ms');
        assert.strictEqual(formatInterval(1500), '1.5 ms');
        assert.strictEqual(formatInterval(9999), '10.0 ms');
    });

    test('formats 10000–999999 μs as whole ms', () => {
        assert.strictEqual(formatInterval(10000), '10 ms');
        assert.strictEqual(formatInterval(50000), '50 ms');
        assert.strictEqual(formatInterval(999999), '999 ms');
    });

    test('formats 1_000_000–9_999_999 μs with one decimal in s', () => {
        assert.strictEqual(formatInterval(1000000), '1.0 s');
        assert.strictEqual(formatInterval(2500000), '2.5 s');
    });

    test('formats ≥ 10_000_000 μs as whole seconds', () => {
        assert.strictEqual(formatInterval(10000000), '10 s');
        assert.strictEqual(formatInterval(60000000), '60 s');
    });
});
