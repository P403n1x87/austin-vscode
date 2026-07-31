import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { AustinCommandExecutor } from '../../providers/executor';
import { AustinStats } from '../../model';

import '../../stringExtension';
import '../../mapExtension';

// ---------------------------------------------------------------------------
// sudo authentication escalation
//
// These tests stand in a fake sudo on PATH so the full None -> Askpass ->
// Password escalation can be exercised without ever invoking the real sudo.
// The fake reproduces the failure the extension hits on a machine with no
// terminal and no working password helper:
//
//   sudo: a terminal is required to read the password; either use the -S
//   option to read from standard input or configure an askpass helper
// ---------------------------------------------------------------------------

const FAKE_SUDO = `#!/bin/sh
# Refuse an askpass-based attempt, as a broken/cancelled helper would.
for a in "$@"; do
  if [ "$a" = "-A" ]; then
    echo "sudo: Sorry, try again." >&2
    exit 1
  fi
done
# Accept a password on stdin.
for a in "$@"; do
  if [ "$a" = "-S" ]; then
    read -r pw
    if [ "$pw" = "s3cret" ]; then
      exit 0
    fi
    echo "sudo: Sorry, try again." >&2
    exit 1
  fi
done
# No -A and no -S: exactly what the user saw on Ubuntu.
echo "sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper" >&2
exit 1
`;

// An askpass helper that fails, standing in for a missing GUI toolkit.
const FAILING_ASKPASS = `#!/bin/sh
echo "no GUI password helper found" >&2
exit 1
`;

suite('sudo authentication escalation', () => {

    let tmpDir: string;
    let savedPath: string | undefined;
    let savedAskpass: string | undefined;
    let savedInputBox: typeof vscode.window.showInputBox;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'austin-sudo-'));

        const sudo = path.join(tmpDir, 'sudo');
        fs.writeFileSync(sudo, FAKE_SUDO);
        fs.chmodSync(sudo, 0o755);

        const askpass = path.join(tmpDir, 'askpass.sh');
        fs.writeFileSync(askpass, FAILING_ASKPASS);
        fs.chmodSync(askpass, 0o755);

        savedPath = process.env.PATH;
        savedAskpass = process.env.SUDO_ASKPASS;
        savedInputBox = vscode.window.showInputBox;

        // spawn() resolves the command through the PATH we hand the child, so
        // the fake is picked up without the shell being involved.
        process.env.PATH = `${tmpDir}${path.delimiter}${savedPath ?? ''}`;
        process.env.SUDO_ASKPASS = askpass;
    });

    teardown(() => {
        if (savedPath === undefined) { delete process.env.PATH; } else { process.env.PATH = savedPath; }
        if (savedAskpass === undefined) { delete process.env.SUDO_ASKPASS; } else { process.env.SUDO_ASKPASS = savedAskpass; }
        (vscode.window as { showInputBox: unknown }).showInputBox = savedInputBox;
        // fs.rm is not in the @types/node version pinned here.
        const rm = (fs as unknown as { rmSync?: typeof fs.rmdirSync }).rmSync;
        if (rm) { rm(tmpDir, { recursive: true }); } else { fs.rmdirSync(tmpDir, { recursive: true }); }
    });

    /** Run an executor to completion, returning the exit code it reported. */
    function run(password: string | undefined): Promise<{ code: number, prompts: number }> {
        let prompts = 0;
        (vscode.window as { showInputBox: unknown }).showInputBox = () => {
            prompts += 1;
            return Promise.resolve(password);
        };

        const output = { append: () => undefined, appendLine: () => undefined } as unknown as vscode.OutputChannel;
        const executor = new AustinCommandExecutor(
            { cmd: 'sudo', args: ['/usr/bin/true'], envFile: undefined },
            tmpDir,
            output,
            new AustinStats(),
            'test-target',
            true,
        );

        return new Promise((resolve) => {
            executor.onDidClose!((code) => resolve({ code, prompts }));
            executor.open(undefined);
        });
    }

    test('prompts for a password and succeeds when the helper cannot be used', async () => {
        const { code, prompts } = await run('s3cret');
        assert.strictEqual(prompts, 1, 'the user should be asked for a password exactly once');
        assert.strictEqual(code, 0, 'austin should start once the password is accepted');
    });

    test('reports failure without re-prompting when the password is wrong', async () => {
        const { code, prompts } = await run('wrong');
        assert.strictEqual(prompts, 1, 'a wrong password must not trigger an endless prompt loop');
        assert.notStrictEqual(code, 0);
    });

    test('gives up quietly when the user cancels the prompt', async () => {
        const { code, prompts } = await run(undefined);
        assert.strictEqual(prompts, 1);
        assert.notStrictEqual(code, 0);
    });
});
