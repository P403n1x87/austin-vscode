import * as assert from 'assert';
import * as http from 'http';
import { Readable } from 'stream';
import { AustinMcpServer } from '../../providers/mcp';
import { AustinStats } from '../../model';
import '../../stringExtension';
import '../../mapExtension';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function post(port: number, body: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request(
            { hostname: '127.0.0.1', port, path: '/mcp', method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
            (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => {
                    if (res.statusCode === 202) { resolve(null); return; }
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(new Error(`Bad JSON: ${data}`)); }
                });
            }
        );
        req.on('error', reject);
        req.end(payload);
    });
}

function makeStats(lines: string): Promise<AustinStats> {
    return new Promise((resolve) => {
        const stats = new AustinStats();
        stats.registerAfterCallback(() => resolve(stats));
        const stream = new Readable();
        stream.push(lines);
        stream.push(null);
        stats.readFromStream(stream, 'test.austin');
    });
}

function startedServer(stats: AustinStats): AustinMcpServer {
    const server = new AustinMcpServer(0); // port 0 = OS-assigned
    server.update(stats);
    return server;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('AustinMcpServer', () => {

    let server: AustinMcpServer | null = null;

    teardown(() => {
        server?.dispose();
        server = null;
    });

    // --- Lifecycle ----------------------------------------------------------

    test('server does not start before update() is called', () => {
        server = new AustinMcpServer(0);
        assert.strictEqual(server.port, 0);
    });

    test('server starts lazily on first update() call', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = startedServer(stats);
        assert.ok(server.port > 0, 'port should be assigned after update()');
    });

    test('dispose() stops the server', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = startedServer(stats);
        const port = server.port;
        server.dispose();
        server = null;

        // After dispose, connections should be refused
        await assert.rejects(
            () => post(port, { jsonrpc: '2.0', method: 'ping', id: 1 }),
            /ECONNREFUSED/
        );
    });

    // --- MCP protocol -------------------------------------------------------

    test('initialize returns server info and capabilities', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = startedServer(stats);
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'initialize', id: 1,
            params: { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0' }, capabilities: {} },
        }) as Record<string, unknown>;

        assert.strictEqual(res.jsonrpc, '2.0');
        assert.strictEqual(res.id, 1);
        const result = res.result as Record<string, unknown>;
        assert.ok(result.protocolVersion);
        assert.ok((result.serverInfo as Record<string, unknown>).name);
    });

    test('ping returns empty result', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = startedServer(stats);
        const res = await post(server.port, { jsonrpc: '2.0', method: 'ping', id: 2 }) as Record<string, unknown>;
        assert.deepStrictEqual(res.result, {});
    });

    test('notifications/initialized returns 202 (no body)', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = startedServer(stats);
        const res = await post(server.port, { jsonrpc: '2.0', method: 'notifications/initialized' });
        assert.strictEqual(res, null);
    });

    test('tools/list returns all three tools', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = startedServer(stats);
        const res = await post(server.port, { jsonrpc: '2.0', method: 'tools/list', id: 3 }) as Record<string, unknown>;
        const tools = (res.result as Record<string, unknown>).tools as Array<{ name: string }>;
        const names = tools.map(t => t.name);
        assert.ok(names.includes('get_top'));
        assert.ok(names.includes('get_call_stacks'));
        assert.ok(names.includes('get_metadata'));
    });

    test('unknown method returns error -32601', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = startedServer(stats);
        const res = await post(server.port, { jsonrpc: '2.0', method: 'nonexistent', id: 4 }) as Record<string, unknown>;
        assert.strictEqual((res.error as Record<string, unknown>).code, -32601);
    });

    test('malformed JSON returns 400', (done) => {
        makeStats('P1;T1;/a.py:fn:1 100\n').then((stats) => {
            server = startedServer(stats);
            const req = http.request(
                { hostname: '127.0.0.1', port: server!.port, path: '/mcp', method: 'POST',
                  headers: { 'Content-Type': 'application/json' } },
                (res) => { assert.strictEqual(res.statusCode, 400); done(); }
            );
            req.end('{bad json');
        });
    });

    // --- get_top ------------------------------------------------------------

    test('get_top returns functions sorted by own% descending', async () => {
        const stats = await makeStats(
            'P1;T1;/a.py:outer:1;/a.py:inner:2 100\n' +
            'P1;T1;/a.py:outer:1 50\n'
        );
        server = startedServer(stats);
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 5,
            params: { name: 'get_top', arguments: {} },
        }) as Record<string, unknown>;

        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        const rows = JSON.parse(content[0].text) as Array<{ key: string; ownPct: number }>;
        assert.ok(rows.length >= 2);
        assert.ok(rows[0].ownPct >= rows[1].ownPct, 'should be sorted descending by ownPct');
    });

    test('get_top respects limit', async () => {
        const stats = await makeStats(
            'P1;T1;/a.py:f1:1 100\n' +
            'P1;T1;/a.py:f2:2 80\n' +
            'P1;T1;/a.py:f3:3 60\n'
        );
        server = startedServer(stats);
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 6,
            params: { name: 'get_top', arguments: { limit: 2 } },
        }) as Record<string, unknown>;

        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        const rows = JSON.parse(content[0].text) as unknown[];
        assert.strictEqual(rows.length, 2);
    });

    test('get_top includes ownPct, totalPct, scope, module, line fields', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:5 200\n');
        server = startedServer(stats);
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 7,
            params: { name: 'get_top', arguments: {} },
        }) as Record<string, unknown>;

        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        const rows = JSON.parse(content[0].text) as Array<Record<string, unknown>>;
        const row = rows[0];
        assert.ok('ownPct' in row);
        assert.ok('totalPct' in row);
        assert.ok('scope' in row);
        assert.ok('module' in row);
        assert.ok('line' in row);
    });

    // --- get_call_stacks ----------------------------------------------------

    test('get_call_stacks returns process/thread/function tree', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = startedServer(stats);
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 8,
            params: { name: 'get_call_stacks', arguments: {} },
        }) as Record<string, unknown>;

        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        const tree = JSON.parse(content[0].text) as Array<Record<string, unknown>>;
        assert.ok(tree.length > 0, 'tree should have at least one process node');
        const processNode = tree[0] as { children: Array<{ children: unknown[] }> };
        assert.ok(processNode.children.length > 0, 'process node should have thread children');
    });

    test('get_call_stacks respects depth=1', async () => {
        const stats = await makeStats('P1;T1;/a.py:outer:1;/a.py:inner:2 100\n');
        server = startedServer(stats);
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 9,
            params: { name: 'get_call_stacks', arguments: { depth: 1 } },
        }) as Record<string, unknown>;

        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        const tree = JSON.parse(content[0].text) as Array<{ children: unknown[] }>;
        // depth=1: process node shown, its children (threads) have empty children
        const processNode = tree[0] as { children: Array<{ children: unknown[] }> };
        assert.strictEqual(processNode.children.length, 0);
    });

    // --- get_metadata -------------------------------------------------------

    test('get_metadata returns source and totalSamples', async () => {
        const stats = await makeStats('# mode: wall\nP1;T1;/a.py:fn:1 100\n');
        server = startedServer(stats);
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 10,
            params: { name: 'get_metadata', arguments: {} },
        }) as Record<string, unknown>;

        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        const meta = JSON.parse(content[0].text) as Record<string, unknown>;
        assert.ok('source' in meta);
        assert.ok('totalSamples' in meta);
        assert.strictEqual(meta.mode, 'wall');
    });

    // --- No-data guard ------------------------------------------------------

    test('tools return a helpful message when no profiling data is available', async () => {
        const stats = new AustinStats(); // empty — overallTotal === 0
        server = startedServer(stats);
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 11,
            params: { name: 'get_top', arguments: {} },
        }) as Record<string, unknown>;

        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        assert.ok(content[0].text.includes('No profiling data'));
    });

    test('unknown tool name returns a helpful message', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = startedServer(stats);
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 12,
            params: { name: 'does_not_exist', arguments: {} },
        }) as Record<string, unknown>;

        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        assert.ok(content[0].text.includes('Unknown tool'));
    });
});
