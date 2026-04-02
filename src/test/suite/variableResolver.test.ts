import * as assert from 'assert';
import { resolveVariable, resolveVariables } from '../../utils/variableResolver';

const vscode = require('vscode');


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withWorkspaceFolder(fsPath: string, fn: () => Promise<void>): Promise<void> {
    const original = vscode.workspace.workspaceFolders;
    vscode.workspace.workspaceFolders = [{ uri: { fsPath } }];
    return fn().finally(() => { vscode.workspace.workspaceFolders = original; });
}

function withActiveFile(fileName: string, fn: () => Promise<void>): Promise<void> {
    const descriptor = Object.getOwnPropertyDescriptor(vscode.window, 'activeTextEditor');
    Object.defineProperty(vscode.window, 'activeTextEditor', {
        get: () => ({ document: { fileName } }),
        configurable: true,
    });
    return fn().finally(() => {
        Object.defineProperty(vscode.window, 'activeTextEditor', descriptor!);
    });
}

function withTaskInputs(inputs: unknown[], fn: () => Promise<void>): Promise<void> {
    const original = vscode.workspace.getConfiguration;
    vscode.workspace.getConfiguration = (section: string) => {
        if (section === 'tasks') {
            return { get: (key: string) => key === 'inputs' ? inputs : undefined };
        }
        return original(section);
    };
    return fn().finally(() => { vscode.workspace.getConfiguration = original; });
}


// ---------------------------------------------------------------------------
// ${workspaceFolder}
// ---------------------------------------------------------------------------
suite('resolveVariable — ${workspaceFolder}', () => {

    test('substitutes when there is exactly one workspace folder', async () => {
        await withWorkspaceFolder('/workspace', async () => {
            assert.strictEqual(
                await resolveVariable('${workspaceFolder}/src/main.py'),
                '/workspace/src/main.py',
            );
        });
    });

    test('substitutes all occurrences', async () => {
        await withWorkspaceFolder('/ws', async () => {
            assert.strictEqual(
                await resolveVariable('${workspaceFolder} and ${workspaceFolder}'),
                '/ws and /ws',
            );
        });
    });

    test('leaves token unchanged when no workspace folder is set', async () => {
        const original = vscode.workspace.workspaceFolders;
        vscode.workspace.workspaceFolders = undefined;
        try {
            assert.strictEqual(
                await resolveVariable('${workspaceFolder}/main.py'),
                '${workspaceFolder}/main.py',
            );
        } finally {
            vscode.workspace.workspaceFolders = original;
        }
    });

    test('leaves token unchanged when multiple workspace folders are present', async () => {
        const original = vscode.workspace.workspaceFolders;
        vscode.workspace.workspaceFolders = [
            { uri: { fsPath: '/ws1' } },
            { uri: { fsPath: '/ws2' } },
        ];
        try {
            assert.strictEqual(
                await resolveVariable('${workspaceFolder}/main.py'),
                '${workspaceFolder}/main.py',
            );
        } finally {
            vscode.workspace.workspaceFolders = original;
        }
    });
});


// ---------------------------------------------------------------------------
// ${cwd}
// ---------------------------------------------------------------------------
suite('resolveVariable — ${cwd}', () => {

    test('substitutes the provided cwd', async () => {
        assert.strictEqual(
            await resolveVariable('${cwd}/main.py', '/project'),
            '/project/main.py',
        );
    });

    test('substitutes all occurrences', async () => {
        assert.strictEqual(
            await resolveVariable('${cwd} + ${cwd}', '/proj'),
            '/proj + /proj',
        );
    });

    test('leaves token unchanged when cwd is not provided', async () => {
        assert.strictEqual(
            await resolveVariable('${cwd}/main.py'),
            '${cwd}/main.py',
        );
    });
});


// ---------------------------------------------------------------------------
// ${file}
// ---------------------------------------------------------------------------
suite('resolveVariable — ${file}', () => {

    test('substitutes the active editor file path', async () => {
        await withActiveFile('/project/src/main.py', async () => {
            assert.strictEqual(
                await resolveVariable('${file}'),
                '/project/src/main.py',
            );
        });
    });

    test('leaves token unchanged when no editor is active', async () => {
        assert.strictEqual(
            await resolveVariable('${file}'),
            '${file}',
        );
    });
});


// ---------------------------------------------------------------------------
// ${env:NAME}
// ---------------------------------------------------------------------------
suite('resolveVariable — ${env:NAME}', () => {

    test('substitutes a set environment variable', async () => {
        process.env['__AUSTIN_TEST_VAR__'] = 'hello';
        try {
            assert.strictEqual(
                await resolveVariable('--arg=${env:__AUSTIN_TEST_VAR__}'),
                '--arg=hello',
            );
        } finally {
            delete process.env['__AUSTIN_TEST_VAR__'];
        }
    });

    test('substitutes an empty string for an unset variable', async () => {
        delete process.env['__AUSTIN_MISSING__'];
        assert.strictEqual(
            await resolveVariable('${env:__AUSTIN_MISSING__}'),
            '',
        );
    });

    test('substitutes multiple distinct env vars in one string', async () => {
        process.env['__AUSTIN_A__'] = 'foo';
        process.env['__AUSTIN_B__'] = 'bar';
        try {
            assert.strictEqual(
                await resolveVariable('${env:__AUSTIN_A__}/${env:__AUSTIN_B__}'),
                'foo/bar',
            );
        } finally {
            delete process.env['__AUSTIN_A__'];
            delete process.env['__AUSTIN_B__'];
        }
    });
});


// ---------------------------------------------------------------------------
// ${input:NAME}
// ---------------------------------------------------------------------------
suite('resolveVariable — ${input:NAME}', () => {

    test('resolves a promptString input', async () => {
        const inputs = [{ id: 'myInput', type: 'promptString', description: 'Enter value' }];
        await withTaskInputs(inputs, async () => {
            vscode.window.showInputBox = async () => 'typed-value';
            const result = await resolveVariable('--flag=${input:myInput}');
            assert.strictEqual(result, '--flag=typed-value');
        });
    });

    test('resolves a pickString input', async () => {
        const inputs = [{ id: 'myPick', type: 'pickString', options: ['a', 'b', 'c'] }];
        await withTaskInputs(inputs, async () => {
            vscode.window.showQuickPick = async () => 'b';
            const result = await resolveVariable('${input:myPick}');
            assert.strictEqual(result, 'b');
        });
    });

    test('resolves a command input', async () => {
        const inputs = [{ id: 'myCmd', type: 'command', command: 'extension.myCommand' }];
        await withTaskInputs(inputs, async () => {
            vscode.commands = { executeCommand: async () => 'cmd-result' };
            const result = await resolveVariable('${input:myCmd}');
            assert.strictEqual(result, 'cmd-result');
        });
    });

    test('leaves token unchanged when input id is not found', async () => {
        await withTaskInputs([], async () => {
            const result = await resolveVariable('${input:unknown}');
            assert.strictEqual(result, '${input:unknown}');
        });
    });

    test('leaves token unchanged when no inputs are configured', async () => {
        const result = await resolveVariable('${input:whatever}');
        assert.strictEqual(result, '${input:whatever}');
    });
});


// ---------------------------------------------------------------------------
// Mixed variables and resolveVariables
// ---------------------------------------------------------------------------
suite('resolveVariable — mixed', () => {

    test('resolves multiple variable types in a single string', async () => {
        process.env['__AUSTIN_MIX__'] = 'envval';
        try {
            await withWorkspaceFolder('/ws', async () => {
                assert.strictEqual(
                    await resolveVariable('${workspaceFolder}/${env:__AUSTIN_MIX__}', '/ws'),
                    '/ws/envval',
                );
            });
        } finally {
            delete process.env['__AUSTIN_MIX__'];
        }
    });

    test('passes through plain strings unchanged', async () => {
        assert.strictEqual(await resolveVariable('no-variables-here'), 'no-variables-here');
    });
});

suite('resolveVariables', () => {

    test('resolves each element independently', async () => {
        process.env['__AUSTIN_V1__'] = 'x';
        process.env['__AUSTIN_V2__'] = 'y';
        try {
            const result = await resolveVariables(
                ['${env:__AUSTIN_V1__}', '${env:__AUSTIN_V2__}', 'plain'],
            );
            assert.deepStrictEqual(result, ['x', 'y', 'plain']);
        } finally {
            delete process.env['__AUSTIN_V1__'];
            delete process.env['__AUSTIN_V2__'];
        }
    });

    test('returns an empty array for an empty input', async () => {
        assert.deepStrictEqual(await resolveVariables([]), []);
    });
});
