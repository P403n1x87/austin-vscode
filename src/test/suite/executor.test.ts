import * as assert from 'assert';
import { findAskpass } from '../../providers/executor';

// Side-effect imports required by model internals
import '../../stringExtension';
import '../../mapExtension';

// ---------------------------------------------------------------------------
// findAskpass
// ---------------------------------------------------------------------------

suite('findAskpass', () => {

    // Save and restore SUDO_ASKPASS around each test so tests are isolated.
    let savedAskpass: string | undefined;

    setup(() => {
        savedAskpass = process.env.SUDO_ASKPASS;
        delete process.env.SUDO_ASKPASS;
    });

    teardown(() => {
        if (savedAskpass === undefined) {
            delete process.env.SUDO_ASKPASS;
        } else {
            process.env.SUDO_ASKPASS = savedAskpass;
        }
    });

    test('returns SUDO_ASKPASS env var when set, regardless of platform', () => {
        process.env.SUDO_ASKPASS = '/usr/lib/openssh/gnome-ssh-askpass';
        assert.strictEqual(findAskpass(), '/usr/lib/openssh/gnome-ssh-askpass');
    });

    test('SUDO_ASKPASS takes precedence over any bundled or discovered helper', () => {
        process.env.SUDO_ASKPASS = '/custom/my-askpass.sh';
        const result = findAskpass();
        assert.strictEqual(result, '/custom/my-askpass.sh');
    });

    test('returns a string or undefined (never throws)', () => {
        // SUDO_ASKPASS unset - result depends on platform and installed tools,
        // but the function must not throw.
        assert.doesNotThrow(() => findAskpass());
        const result = findAskpass();
        assert.ok(result === undefined || typeof result === 'string');
    });

    test('on darwin, returns a string path when bundled script exists', function () {
        if (process.platform !== 'darwin') { this.skip(); }
        // The compiled extension's bundled script lives at out/askpass/macos-askpass.sh
        // relative to out/providers/executor.js (__dirname).  Only assert that the
        // returned path (when present) is a non-empty string.
        const result = findAskpass();
        if (result !== undefined) {
            assert.ok(result.length > 0);
            assert.ok(result.endsWith('.sh') || result.endsWith('askpass'));
        }
    });

    test('returned path, when defined, does not contain shell-injectable characters', () => {
        process.env.SUDO_ASKPASS = '/usr/bin/ssh-askpass';
        const result = findAskpass()!;
        // PATHs are passed via env var, not shell-interpolated, but sanity-check.
        assert.ok(!result.includes('\n'), 'path must not contain newlines');
        assert.ok(!result.includes('\0'), 'path must not contain null bytes');
    });
});
