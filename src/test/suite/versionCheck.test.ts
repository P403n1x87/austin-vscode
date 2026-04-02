import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { AUSTIN_MIN_MAJOR, checkAustinVersion, AustinVersionError } from '../../utils/versionCheck';


// ---------------------------------------------------------------------------
// Helper: create a fake "austin" executable that prints `versionLine` to
// stdout and exits 0, ignoring any arguments passed to it.
//
// On Unix: a shebang script (directly executable via execFile).
// On Windows: a .cmd file — Node's execFile spawns .cmd/.bat files through
// cmd.exe automatically, so no shell:true is required.
// ---------------------------------------------------------------------------
function makeFakeAustin(versionLine: string): string {
    const dir = os.tmpdir();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    if (process.platform === 'win32') {
        const scriptPath = path.join(dir, `fake-austin-${id}.cmd`);
        fs.writeFileSync(scriptPath, `@echo off\necho ${versionLine}\n`);
        return scriptPath;
    }

    const scriptPath = path.join(dir, `fake-austin-${id}.sh`);
    fs.writeFileSync(
        scriptPath,
        `#!/bin/sh\necho '${versionLine}'\n`
    );
    fs.chmodSync(scriptPath, 0o755);
    return scriptPath;
}


// ---------------------------------------------------------------------------
// AUSTIN_MIN_MAJOR
// ---------------------------------------------------------------------------
suite('AUSTIN_MIN_MAJOR', () => {

    test('is a positive integer', () => {
        assert.ok(Number.isInteger(AUSTIN_MIN_MAJOR) && AUSTIN_MIN_MAJOR > 0);
    });

    test('AustinVersionError message references AUSTIN_MIN_MAJOR', () => {
        const err = new AustinVersionError('3.6.0');
        assert.ok(
            err.message.includes(`${AUSTIN_MIN_MAJOR}.0.0`),
            `expected message to contain '${AUSTIN_MIN_MAJOR}.0.0', got: ${err.message}`
        );
    });

    test('version equal to AUSTIN_MIN_MAJOR resolves', () => {
        return assert.doesNotReject(
            checkAustinVersion(makeFakeAustin(`austin ${AUSTIN_MIN_MAJOR}.0.0`))
        );
    });

    test('version one major below AUSTIN_MIN_MAJOR rejects with AustinVersionError', () => {
        return assert.rejects(
            checkAustinVersion(makeFakeAustin(`austin ${AUSTIN_MIN_MAJOR - 1}.9.9`)),
            (err: unknown) => err instanceof AustinVersionError
        );
    });
});


// ---------------------------------------------------------------------------
// checkAustinVersion
// ---------------------------------------------------------------------------
suite('checkAustinVersion', () => {

    test('resolves for austin 4.0.0', () => {
        return assert.doesNotReject(
            checkAustinVersion(makeFakeAustin('austin 4.0.0'))
        );
    });

    test('resolves for a newer version like 5.1.2', () => {
        return assert.doesNotReject(
            checkAustinVersion(makeFakeAustin('austin 5.1.2'))
        );
    });

    test('rejects with AustinVersionError for version 3.6.0', () => {
        return assert.rejects(
            checkAustinVersion(makeFakeAustin('austin 3.6.0')),
            (err: unknown) => err instanceof AustinVersionError
        );
    });

    test('AustinVersionError carries the version string', async () => {
        try {
            await checkAustinVersion(makeFakeAustin('austin 3.6.0'));
            assert.fail('should have thrown');
        } catch (err) {
            assert.ok(err instanceof AustinVersionError);
            assert.strictEqual(err.version, '3.6.0');
        }
    });

    test('rejects with a generic Error for unparseable output', () => {
        return assert.rejects(
            checkAustinVersion(makeFakeAustin('not a version string')),
            /Could not parse Austin version/
        );
    });

    test('rejects when the binary cannot be found', () => {
        return assert.rejects(
            checkAustinVersion('/non/existent/binary'),
            /Failed to run/
        );
    });
});
