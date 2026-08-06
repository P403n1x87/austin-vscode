import * as assert from 'assert';
import { sudoCommand } from '../../providers/task';

suite('sudoCommand', () => {

    test('attaching needs elevation on linux and macOS', () => {
        assert.deepStrictEqual(sudoCommand(true, 'linux'), ['sudo']);
        assert.deepStrictEqual(sudoCommand(true, 'darwin'), ['sudo']);
    });

    test('profiling a script needs elevation only on macOS', () => {
        assert.deepStrictEqual(sudoCommand(false, 'darwin'), ['sudo']);
        assert.strictEqual(sudoCommand(false, 'linux'), undefined);
    });

    test('never uses sudo on Windows', () => {
        // Windows has no sudo to prefix with, so attaching would fail to spawn
        // before Austin ever ran.
        assert.strictEqual(sudoCommand(true, 'win32'), undefined);
        assert.strictEqual(sudoCommand(false, 'win32'), undefined);
    });
});
