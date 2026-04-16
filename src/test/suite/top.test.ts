import * as assert from 'assert';
import { AustinStats, FrameObject } from '../../model';
import { TopViewProvider } from '../../providers/top';
import '../../stringExtension';
import '../../mapExtension';

const vscodeMock = require('vscode') as {
    workspace: { getConfiguration: () => { get: (key: string, def: unknown) => unknown; update: () => void } };
    commands: { executeCommand: (...args: unknown[]) => Promise<unknown> };
};

function createMockWebviewView() {
    const messages: unknown[] = [];
    let messageHandler: (data: unknown) => void = () => { };

    const view = {
        webview: {
            options: {} as Record<string, unknown>,
            onDidReceiveMessage: (handler: (data: unknown) => void) => {
                messageHandler = handler;
            },
            postMessage: (data: unknown) => {
                messages.push(data);
                return Promise.resolve(true);
            },
            html: '',
            asWebviewUri: (uri: { fsPath: string }) => uri.fsPath,
        },
    };

    return {
        view,
        messages,
        sendMessage: (data: unknown) => messageHandler(data),
    };
}

function makeStats(count: number): AustinStats {
    const stats = new AustinStats();
    stats.begin('test.austin');
    for (let i = 0; i < count; i++) {
        const frame: FrameObject = {
            module: `/test/module${i}.py`,
            scope: `func${i}`,
            line: i + 1,
        };
        // Give each frame a unique own-time so sort order is deterministic
        stats.update(0, '0', [frame], (count - i) * 100);
    }
    stats.refresh();
    return stats;
}

function makeStatsWithCallers(count: number): AustinStats {
    const stats = new AustinStats();
    stats.begin('test.austin');
    for (let i = 0; i < count; i++) {
        const caller: FrameObject = {
            module: `/test/caller${i}.py`,
            scope: `caller_func${i}`,
            line: 1,
        };
        const callee: FrameObject = {
            module: `/test/module${i}.py`,
            scope: `func${i}`,
            line: i + 1,
        };
        stats.update(0, '0', [caller, callee], (count - i) * 100);
    }
    stats.refresh();
    return stats;
}

function initProvider(topRowsOverride?: number) {
    const extensionUri = { fsPath: process.cwd() };
    const provider = new TopViewProvider(extensionUri as any);

    const mock = createMockWebviewView();
    provider.resolveWebviewView(mock.view as any, {} as any, {} as any);
    mock.sendMessage('initialized');

    // Clear the initialization messages
    mock.messages.length = 0;

    if (topRowsOverride !== undefined) {
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key: string, def: unknown) =>
                key === 'topRows' ? topRowsOverride : def,
            update: () => undefined,
        });
    }

    return { provider, mock };
}

suite('TopViewProvider — truncation', () => {
    let savedGetConfig: typeof vscodeMock.workspace.getConfiguration;

    setup(() => {
        savedGetConfig = vscodeMock.workspace.getConfiguration;
    });

    teardown(() => {
        vscodeMock.workspace.getConfiguration = savedGetConfig;
    });

    test('includes all items when count is below default limit', () => {
        const { provider, mock } = initProvider();
        const stats = makeStats(10);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.top !== undefined) as any;
        assert.ok(msg, 'should post a top message');
        assert.strictEqual(msg.top.length, 10);
        assert.strictEqual(msg.totalCount, 10);
    });

    test('includes all items when count equals the limit', () => {
        const { provider, mock } = initProvider(20);
        const stats = makeStats(20);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.top !== undefined) as any;
        assert.ok(msg);
        assert.strictEqual(msg.top.length, 20);
        assert.strictEqual(msg.totalCount, 20);
    });

    test('truncates items when count exceeds the limit', () => {
        const { provider, mock } = initProvider(5);
        const stats = makeStats(20);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.top !== undefined) as any;
        assert.ok(msg);
        assert.strictEqual(msg.top.length, 5);
        assert.strictEqual(msg.totalCount, 20);
    });

    test('keeps items sorted by own time descending after truncation', () => {
        const { provider, mock } = initProvider(3);
        const stats = makeStats(10);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.top !== undefined) as any;
        assert.ok(msg);
        for (let i = 1; i < msg.top.length; i++) {
            assert.ok(msg.top[i - 1].own >= msg.top[i].own,
                `item ${i - 1} (own=${msg.top[i - 1].own}) should be >= item ${i} (own=${msg.top[i].own})`);
        }
    });

    test('all items included when limit is 0 (unlimited)', () => {
        const { provider, mock } = initProvider(0);
        const stats = makeStats(200);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.top !== undefined) as any;
        assert.ok(msg);
        assert.strictEqual(msg.top.length, 200);
        assert.strictEqual(msg.totalCount, 200);
    });

    test('totalCount reflects total entries before truncation', () => {
        const { provider, mock } = initProvider(2);
        const stats = makeStats(100);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.top !== undefined) as any;
        assert.ok(msg);
        assert.strictEqual(msg.top.length, 2);
        assert.strictEqual(msg.totalCount, 100);
    });

    test('serialized items include caller data', () => {
        const { provider, mock } = initProvider(3);
        const stats = makeStatsWithCallers(5);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.top !== undefined) as any;
        assert.ok(msg);
        assert.strictEqual(msg.top.length, 3);
        for (const item of msg.top) {
            assert.ok(item.callers !== undefined, 'each item should have callers');
            assert.ok(Array.isArray(item.callers));
        }
    });
});

suite('TopViewProvider — openSettings message', () => {
    let savedExecCommand: typeof vscodeMock.commands.executeCommand;
    let executedCommands: unknown[][];

    setup(() => {
        savedExecCommand = vscodeMock.commands.executeCommand;
        executedCommands = [];
        vscodeMock.commands.executeCommand = (...args: unknown[]) => {
            executedCommands.push(args);
            return Promise.resolve(undefined);
        };
    });

    teardown(() => {
        vscodeMock.commands.executeCommand = savedExecCommand;
    });

    test('openSettings message opens settings filtered to austin.topRows', () => {
        const { mock } = initProvider();
        mock.sendMessage('openSettings');

        assert.strictEqual(executedCommands.length, 1);
        assert.strictEqual(executedCommands[0][0], 'workbench.action.openSettings');
        assert.strictEqual(executedCommands[0][1], 'austin.topRows');
    });
});
