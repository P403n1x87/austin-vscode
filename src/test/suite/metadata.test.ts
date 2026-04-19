import * as assert from 'assert';
import { AustinStats } from '../../model';
import { MetadataViewProvider } from '../../providers/metadata';
import '../../mapExtension';

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

function initProvider() {
    const extensionUri = { fsPath: process.cwd() };
    const provider = new MetadataViewProvider(extensionUri as any);

    const mock = createMockWebviewView();
    provider.resolveWebviewView(mock.view as any, {} as any, {} as any);
    mock.sendMessage('initialized');

    // Clear the initialization messages
    mock.messages.length = 0;

    return { provider, mock };
}

function makeStatsWithMetadata(entries: [string, string][]): AustinStats {
    const stats = new AustinStats();
    stats.begin('test.austin');
    for (const [k, v] of entries) {
        stats.setMetadata(k, v);
    }
    stats.refresh();
    return stats;
}

suite('MetadataViewProvider', () => {

    test('posts entries when metadata is present', () => {
        const { provider, mock } = initProvider();
        const stats = makeStatsWithMetadata([
            ['mode', 'wall'],
            ['austin', '3.4.0'],
            ['interval', '100'],
        ]);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.entries !== undefined) as any;
        assert.ok(msg, 'should post an entries message');
        assert.strictEqual(msg.entries.length, 3);
        assert.strictEqual(msg.entries[0].key, 'mode');
        assert.strictEqual(msg.entries[0].kind, 'mode');
        assert.strictEqual(msg.entries[0].parsed.display, 'Wall time');
        assert.deepStrictEqual(msg.entries[1], { key: 'austin', value: '3.4.0' });
        assert.strictEqual(msg.entries[2].key, 'interval');
        assert.strictEqual(msg.entries[2].kind, 'interval');
    });

    test('posts noData when metadata is empty', () => {
        const { provider, mock } = initProvider();
        const stats = makeStatsWithMetadata([]);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.noData === true) as any;
        assert.ok(msg, 'should post a noData message');
    });

    test('refresh updates cached stats and re-posts on second call', () => {
        const { provider, mock } = initProvider();
        const stats1 = makeStatsWithMetadata([['mode', 'cpu']]);
        provider.refresh(stats1);

        const stats2 = makeStatsWithMetadata([['mode', 'wall'], ['austin', '3.5.0']]);
        provider.refresh(stats2);

        const msgs = mock.messages.filter((m: any) => m.entries !== undefined) as any[];
        assert.strictEqual(msgs.length, 2);
        assert.strictEqual(msgs[0].entries.length, 1);
        assert.strictEqual(msgs[1].entries.length, 2);
    });

    test('deferred refresh posts data after initialization', () => {
        const extensionUri = { fsPath: process.cwd() };
        const provider = new MetadataViewProvider(extensionUri as any);

        const mock = createMockWebviewView();
        provider.resolveWebviewView(mock.view as any, {} as any, {} as any);

        // Refresh before initialized
        const stats = makeStatsWithMetadata([['mode', 'wall']]);
        provider.refresh(stats);

        // No entries message yet
        assert.ok(!mock.messages.some((m: any) => m.entries !== undefined));

        // Now initialize
        mock.sendMessage('initialized');

        const msg = mock.messages.find((m: any) => m.entries !== undefined) as any;
        assert.ok(msg, 'should post entries after initialization');
        assert.strictEqual(msg.entries.length, 1);
    });

    test('parses mode wall as Wall time', () => {
        const { provider, mock } = initProvider();
        const stats = makeStatsWithMetadata([['mode', 'wall']]);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.entries !== undefined) as any;
        assert.strictEqual(msg.entries[0].kind, 'mode');
        assert.strictEqual(msg.entries[0].parsed.display, 'Wall time');
    });

    test('parses mode cpu as CPU time', () => {
        const { provider, mock } = initProvider();
        const stats = makeStatsWithMetadata([['mode', 'cpu']]);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.entries !== undefined) as any;
        assert.strictEqual(msg.entries[0].parsed.display, 'CPU time');
    });

    test('parses mode memory as Memory', () => {
        const { provider, mock } = initProvider();
        const stats = makeStatsWithMetadata([['mode', 'memory']]);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.entries !== undefined) as any;
        assert.strictEqual(msg.entries[0].parsed.display, 'Memory');
    });

    test('parses mode full as Full metrics', () => {
        const { provider, mock } = initProvider();
        const stats = makeStatsWithMetadata([['mode', 'full']]);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.entries !== undefined) as any;
        assert.strictEqual(msg.entries[0].parsed.display, 'Full metrics');
    });

    test('unknown mode falls back to plain value', () => {
        const { provider, mock } = initProvider();
        const stats = makeStatsWithMetadata([['mode', 'exotic']]);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.entries !== undefined) as any;
        assert.strictEqual(msg.entries[0].kind, undefined);
        assert.strictEqual(msg.entries[0].value, 'exotic');
    });

    test('parses sampling metadata as min/avg/max', () => {
        const { provider, mock } = initProvider();
        const stats = makeStatsWithMetadata([['sampling', '50,100,200']]);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.entries !== undefined) as any;
        assert.ok(msg);
        const entry = msg.entries[0];
        assert.strictEqual(entry.kind, 'sampling');
        assert.deepStrictEqual(entry.parsed, { min: '50 µs', avg: '100 µs', max: '200 µs' });
    });

    test('parses interval in microseconds', () => {
        const { provider, mock } = initProvider();
        const stats = makeStatsWithMetadata([['interval', '100']]);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.entries !== undefined) as any;
        const entry = msg.entries[0];
        assert.strictEqual(entry.kind, 'interval');
        assert.strictEqual(entry.parsed.us, 100);
        assert.strictEqual(entry.parsed.display, '100 µs');
        assert.strictEqual(entry.parsed.hzDisplay, '10 kHz');
    });

    test('formats interval as milliseconds when >= 1000', () => {
        const { provider, mock } = initProvider();
        const stats = makeStatsWithMetadata([['interval', '10000']]);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.entries !== undefined) as any;
        assert.strictEqual(msg.entries[0].parsed.display, '10 ms');
        assert.strictEqual(msg.entries[0].parsed.hzDisplay, '100 Hz');
    });

    test('formats interval as seconds when >= 1000000', () => {
        const { provider, mock } = initProvider();
        const stats = makeStatsWithMetadata([['interval', '2500000']]);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.entries !== undefined) as any;
        assert.strictEqual(msg.entries[0].parsed.display, '2.5 s');
        assert.strictEqual(msg.entries[0].parsed.hzDisplay, '0.4 Hz');
    });

    test('formats interval frequency as MHz when very small interval', () => {
        const { provider, mock } = initProvider();
        const stats = makeStatsWithMetadata([['interval', '0.5']]);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.entries !== undefined) as any;
        assert.strictEqual(msg.entries[0].parsed.hzDisplay, '2 MHz');
    });

    test('parses duration in microseconds', () => {
        const { provider, mock } = initProvider();
        const stats = makeStatsWithMetadata([['duration', '5000000']]);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.entries !== undefined) as any;
        const entry = msg.entries[0];
        assert.strictEqual(entry.kind, 'duration');
        assert.strictEqual(entry.parsed.display, '5 s');
        assert.strictEqual(entry.parsed.hzDisplay, undefined);
    });

    test('formats duration as milliseconds', () => {
        const { provider, mock } = initProvider();
        const stats = makeStatsWithMetadata([['duration', '1500']]);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.entries !== undefined) as any;
        assert.strictEqual(msg.entries[0].parsed.display, '1.5 ms');
    });

    test('parses saturation metadata as fraction percentage', () => {
        const { provider, mock } = initProvider();
        const stats = makeStatsWithMetadata([['saturation', '3/200']]);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.entries !== undefined) as any;
        assert.ok(msg);
        const entry = msg.entries[0];
        assert.strictEqual(entry.kind, 'fraction');
        assert.strictEqual(entry.parsed.n, 3);
        assert.strictEqual(entry.parsed.count, 200);
        assert.strictEqual(entry.parsed.pct, 1.5);
    });

    test('parses errors metadata as fraction percentage', () => {
        const { provider, mock } = initProvider();
        const stats = makeStatsWithMetadata([['errors', '0/500']]);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.entries !== undefined) as any;
        assert.ok(msg);
        const entry = msg.entries[0];
        assert.strictEqual(entry.kind, 'fraction');
        assert.strictEqual(entry.parsed.n, 0);
        assert.strictEqual(entry.parsed.count, 500);
        assert.strictEqual(entry.parsed.pct, 0);
    });

    test('fraction with zero count yields 0%', () => {
        const { provider, mock } = initProvider();
        const stats = makeStatsWithMetadata([['saturation', '0/0']]);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.entries !== undefined) as any;
        const entry = msg.entries[0];
        assert.strictEqual(entry.parsed.pct, 0);
    });

    test('malformed sampling falls back to plain value', () => {
        const { provider, mock } = initProvider();
        const stats = makeStatsWithMetadata([['sampling', 'bad']]);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.entries !== undefined) as any;
        const entry = msg.entries[0];
        assert.strictEqual(entry.kind, undefined);
        assert.strictEqual(entry.value, 'bad');
    });

    test('malformed fraction falls back to plain value', () => {
        const { provider, mock } = initProvider();
        const stats = makeStatsWithMetadata([['saturation', 'not-a-fraction']]);
        provider.refresh(stats);

        const msg = mock.messages.find((m: any) => m.entries !== undefined) as any;
        const entry = msg.entries[0];
        assert.strictEqual(entry.kind, undefined);
        assert.strictEqual(entry.value, 'not-a-fraction');
    });

    test('showLoading posts loading message', () => {
        const { provider, mock } = initProvider();
        provider.showLoading();

        const msg = mock.messages.find((m: any) => m.loading === true);
        assert.ok(msg);
    });

    test('showError posts error message', () => {
        const { provider, mock } = initProvider();
        provider.showError();

        const msg = mock.messages.find((m: any) => m.error === true);
        assert.ok(msg);
    });

    test('showLive and hideLive post live messages', () => {
        const { provider, mock } = initProvider();
        provider.showLive();
        provider.hideLive();

        assert.ok(mock.messages.some((m: any) => m.live === true));
        assert.ok(mock.messages.some((m: any) => m.live === false));
    });
});
