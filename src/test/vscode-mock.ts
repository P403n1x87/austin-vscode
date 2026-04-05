/**
 * Minimal vscode module mock for running unit tests in plain Node.js
 * (without launching a full VS Code instance via @vscode/test-electron).
 *
 * Loaded automatically via .mocharc.js before any test file so that the
 * interception is in place before any source file does
 * `import * as vscode from 'vscode'`.
 */

/* eslint-disable @typescript-eslint/naming-convention */
const nodeModule = require('module') as { _resolveFilename: (request: string, ...rest: unknown[]) => string };

// Redirect any `require('vscode')` call to this file so that the exports
// below are returned instead of the real (unavailable) VS Code native module.
const MOCK_PATH = __filename;
const origResolve = nodeModule._resolveFilename;
nodeModule._resolveFilename = function (request: string, ...rest: unknown[]) {
    if (request === 'vscode') { return MOCK_PATH; }
    return origResolve.call(this, request, ...rest);
};

class EventEmitter<T> {
    private listeners: Array<(e: T) => unknown> = [];
    event = (listener: (e: T) => unknown) => {
        this.listeners.push(listener);
        return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    };
    fire(data: T) { this.listeners.forEach(l => l(data)); }
    dispose() { this.listeners = []; }
}

const mock = {
    workspace: {
        workspaceFolders: undefined as undefined,
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue,
            update: () => undefined,
        }),
        asRelativePath: (p: string) => p,
    },
    window: {
        showErrorMessage: () => undefined,
        showWarningMessage: () => undefined,
        showInformationMessage: () => undefined,
        showInputBox: () => Promise.resolve(undefined),
        showQuickPick: () => Promise.resolve(undefined),
        get activeTextEditor() { return undefined; },
        createTextEditorDecorationType: () => ({ dispose: () => undefined }),
        createTerminal: () => ({ show: () => undefined, sendText: () => undefined }),
    },
    commands: {
        executeCommand: () => Promise.resolve(undefined),
    },
    Uri: {
        joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
            fsPath: [base.fsPath, ...parts].join('/'),
        }),
    },
    EventEmitter,
    Range: class Range {
        constructor(public start: unknown, public end: unknown) {}
    },
    Position: class Position {
        constructor(public line: number, public character: number) {}
    },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
};

// Seed the cache so that the redirected path resolves to this mock.
require.cache[MOCK_PATH] = Object.assign(Object.create(null), {
    id: MOCK_PATH,
    filename: MOCK_PATH,
    loaded: true,
    exports: mock,
}) as NodeJS.Module;

module.exports = mock;
