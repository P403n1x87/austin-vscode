import * as assert from 'assert';
import { getAustinCommand } from '../../utils/commandFactory';
// Side-effect imports required by model internals used by settings
import '../../stringExtension';
import '../../mapExtension';


// The vscode-mock returns all config values as their supplied default, so
// AustinRuntimeSettings uses its own DEFAULT_* constants:
//   path     → "austin"
//   interval → 100
//   mode     → AustinMode.WallTime ("Wall time") — no extra flag


// ---------------------------------------------------------------------------
// getAustinCommand — pid support
// ---------------------------------------------------------------------------
suite('getAustinCommand — pid support', () => {

    test('adds -p flag with the given pid', () => {
        const { args } = getAustinCommand(undefined, undefined, undefined, undefined, undefined, undefined, undefined, 12345);
        const pidIdx = args.indexOf('-p');
        assert.ok(pidIdx >= 0, 'args should contain -p');
        assert.strictEqual(args[pidIdx + 1], '12345');
    });

    test('does not include a python interpreter when pid is given', () => {
        // With pid, getConfiguredInterpreter() must NOT be called (it would throw
        // because ms-python is unavailable in the test environment).
        const { args } = getAustinCommand(undefined, undefined, undefined, undefined, undefined, undefined, undefined, 99);
        // The only positional argument after --pipe and any mode flag should be
        // the -p / pid pair — no interpreter string anywhere.
        const pipeIdx = args.indexOf('--pipe');
        const argsAfterPipe = args.slice(pipeIdx + 1);
        assert.deepStrictEqual(argsAfterPipe, ['-p', '99']);
    });

    test('does not include pythonArgs when pid is given', () => {
        const { args } = getAustinCommand(
            '/some/script.py',          // pythonFile — ignored because pid wins
            undefined,
            ['--my-arg', 'value'],      // pythonArgs — should not appear
            undefined,
            undefined,
            undefined,
            undefined,
            42,
        );
        assert.ok(!args.includes('--my-arg'), 'pythonArgs should not be in the command');
        assert.ok(!args.includes('value'));
    });

    test('pid takes precedence over pythonFile', () => {
        const { args } = getAustinCommand(
            '/some/script.py',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            7,
        );
        assert.ok(!args.includes('/some/script.py'), 'pythonFile should not appear when pid is given');
        assert.ok(args.includes('-p'));
    });

    test('standard flags (-i, --pipe) still appear before -p', () => {
        const { args } = getAustinCommand(undefined, undefined, undefined, undefined, undefined, undefined, undefined, 1);
        assert.ok(args.includes('-i'), 'interval flag should be present');
        assert.ok(args.includes('--pipe'), '--pipe flag should be present');
        const pFlag = args.indexOf('-p');
        const pipeFlag = args.indexOf('--pipe');
        assert.ok(pipeFlag < pFlag, '--pipe should come before -p');
    });

    test('works with a command prefix such as sudo', () => {
        const { cmd, args } = getAustinCommand(
            undefined,
            ['sudo'],                   // command prefix
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            5678,
        );
        assert.strictEqual(cmd, 'sudo');
        assert.ok(args.includes('austin'), 'austin path should be in args when using a command prefix');
        assert.ok(args.includes('-p'));
        assert.strictEqual(args[args.indexOf('-p') + 1], '5678');
    });

    test('envFile is threaded through unchanged', () => {
        const { envFile } = getAustinCommand(
            undefined, undefined, undefined, undefined, undefined, undefined,
            '/path/to/.env',
            1,
        );
        assert.strictEqual(envFile, '/path/to/.env');
    });
});
