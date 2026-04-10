import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { hashPath } from '../../utils/pathKey';
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

async function startedServer(stats: AustinStats): Promise<AustinMcpServer> {
    const server = new AustinMcpServer();
    await server.start();
    server.update(stats);
    return server;
}

/** Creates a temp .austin file with the given content and returns its path. */
function makeTmpAustinFile(content: string = 'P1;T1;/a.py:fn:1 100\n'): string {
    const p = path.join(os.tmpdir(), `austin-mcp-test-${Math.random().toString(36).slice(2)}.austin`);
    fs.writeFileSync(p, content);
    return p;
}

/** Build stats with GC events directly (text parser strips GC frames). */
function makeGCStats(): AustinStats {
    const stats = new AustinStats();
    // 300 units total: 100 non-gc, 100 gc on fn1, 100 gc on fn2
    stats.update(1, 'T1', [{ module: '/a.py', scope: 'fn1', line: 1 }], 100, false);
    stats.update(1, 'T1', [{ module: '/a.py', scope: 'fn1', line: 1 }], 100, true);
    stats.update(1, 'T1', [{ module: '/b.py', scope: 'fn2', line: 1 }], 100, true);
    stats.refresh();
    return stats;
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

    test('port is 0 before start() is called', () => {
        server = new AustinMcpServer();
        assert.strictEqual(server.port, 0);
    });

    test('start() assigns a non-zero port', async () => {
        server = new AustinMcpServer();
        await server.start();
        assert.ok(server.port > 0, 'port should be assigned after start()');
    });

    test('dispose() stops the server', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = await startedServer(stats);
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
        server = await startedServer(stats);
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
        server = await startedServer(stats);
        const res = await post(server.port, { jsonrpc: '2.0', method: 'ping', id: 2 }) as Record<string, unknown>;
        assert.deepStrictEqual(res.result, {});
    });

    test('notifications/initialized returns 202 (no body)', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = await startedServer(stats);
        const res = await post(server.port, { jsonrpc: '2.0', method: 'notifications/initialized' });
        assert.strictEqual(res, null);
    });

    test('tools/list returns all tools', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = await startedServer(stats);
        const res = await post(server.port, { jsonrpc: '2.0', method: 'tools/list', id: 3 }) as Record<string, unknown>;
        const tools = (res.result as Record<string, unknown>).tools as Array<{ name: string }>;
        const names = tools.map(t => t.name);
        assert.ok(names.includes('get_top'));
        assert.ok(names.includes('get_call_stacks'));
        assert.ok(names.includes('get_metadata'));
        assert.ok(names.includes('get_gc_data'));
        assert.ok(names.includes('load_profile'));
        assert.ok(names.includes('focus_flamegraph'));
        assert.ok(names.includes('search_flamegraph'));
    });

    test('unknown method returns error -32601', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = await startedServer(stats);
        const res = await post(server.port, { jsonrpc: '2.0', method: 'nonexistent', id: 4 }) as Record<string, unknown>;
        assert.strictEqual((res.error as Record<string, unknown>).code, -32601);
    });

    test('malformed JSON returns 400', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = await startedServer(stats);
        await new Promise<void>((resolve, reject) => {
            const req = http.request(
                { hostname: '127.0.0.1', port: server!.port, path: '/mcp', method: 'POST',
                  headers: { 'Content-Type': 'application/json' } },
                (res) => { assert.strictEqual(res.statusCode, 400); resolve(); }
            );
            req.on('error', reject);
            req.end('{bad json');
        });
    });

    // --- get_top ------------------------------------------------------------

    test('get_top returns functions sorted by own% descending', async () => {
        const stats = await makeStats(
            'P1;T1;/a.py:outer:1;/a.py:inner:2 100\n' +
            'P1;T1;/a.py:outer:1 50\n'
        );
        server = await startedServer(stats);
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
        server = await startedServer(stats);
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
        server = await startedServer(stats);
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
        server = await startedServer(stats);
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
        server = await startedServer(stats);
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
        server = await startedServer(stats);
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
        server = await startedServer(stats);
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 11,
            params: { name: 'get_top', arguments: {} },
        }) as Record<string, unknown>;

        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        assert.ok(content[0].text.includes('No profiling data'));
    });

    test('unknown tool name returns a helpful message', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = await startedServer(stats);
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 12,
            params: { name: 'does_not_exist', arguments: {} },
        }) as Record<string, unknown>;

        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        assert.ok(content[0].text.includes('Unknown tool'));
    });

    // --- get_gc_data ---------------------------------------------------------

    test('get_gc_data returns available:false when no GC events exist', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = await startedServer(stats);
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 13,
            params: { name: 'get_gc_data', arguments: {} },
        }) as Record<string, unknown>;

        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        const data = JSON.parse(content[0].text) as Record<string, unknown>;
        assert.strictEqual(data.available, false);
    });

    test('get_gc_data returns available:true with threads and frames when GC data present', async () => {
        server = await startedServer(makeGCStats());
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 14,
            params: { name: 'get_gc_data', arguments: {} },
        }) as Record<string, unknown>;

        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        const data = JSON.parse(content[0].text) as Record<string, unknown>;
        assert.strictEqual(data.available, true);
        assert.ok(Array.isArray(data.threads), 'threads should be an array');
        assert.ok(Array.isArray(data.frames),  'frames should be an array');
    });

    test('get_gc_data threads include pid, tid, and gcPct', async () => {
        server = await startedServer(makeGCStats());
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 15,
            params: { name: 'get_gc_data', arguments: {} },
        }) as Record<string, unknown>;

        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        const { threads } = JSON.parse(content[0].text) as { threads: Array<Record<string, unknown>> };
        assert.strictEqual(threads.length, 1);
        assert.ok('pid'   in threads[0]);
        assert.ok('tid'   in threads[0]);
        assert.ok('gcPct' in threads[0]);
        // 200 gc / 300 total ≈ 66.67%
        assert.ok((threads[0].gcPct as number) > 60 && (threads[0].gcPct as number) < 70);
    });

    test('get_gc_data frames include scope, module, ownGcPct, totalGcPct, line', async () => {
        server = await startedServer(makeGCStats());
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 16,
            params: { name: 'get_gc_data', arguments: {} },
        }) as Record<string, unknown>;

        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        const { frames } = JSON.parse(content[0].text) as { frames: Array<Record<string, unknown>> };
        assert.ok(frames.length > 0);
        const frame = frames[0];
        assert.ok('scope'      in frame);
        assert.ok('module'     in frame);
        assert.ok('ownGcPct'   in frame);
        assert.ok('totalGcPct' in frame);
        assert.ok('line'       in frame);
    });

    test('get_gc_data frames are sorted by ownGcPct descending', async () => {
        server = await startedServer(makeGCStats());
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 17,
            params: { name: 'get_gc_data', arguments: {} },
        }) as Record<string, unknown>;

        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        const { frames } = JSON.parse(content[0].text) as { frames: Array<{ ownGcPct: number }> };
        for (let i = 1; i < frames.length; i++) {
            assert.ok(frames[i - 1].ownGcPct >= frames[i].ownGcPct, 'frames should be sorted descending');
        }
    });

    test('get_gc_data respects limit argument', async () => {
        server = await startedServer(makeGCStats());
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 18,
            params: { name: 'get_gc_data', arguments: { limit: 1 } },
        }) as Record<string, unknown>;

        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        const { frames } = JSON.parse(content[0].text) as { frames: unknown[] };
        assert.strictEqual(frames.length, 1);
    });

    // --- get_call_stacks nodeId ---------------------------------------------

    test('get_call_stacks nodes include a unique numeric nodeId', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = await startedServer(stats);
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 19,
            params: { name: 'get_call_stacks', arguments: {} },
        }) as Record<string, unknown>;

        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        type Node = { nodeId: number; children: Node[] };
        const tree = JSON.parse(content[0].text) as Node[];
        const processNode = tree[0];
        const threadNode = processNode.children[0];
        const frameNode = threadNode.children[0];
        assert.strictEqual(typeof processNode.nodeId, 'number');
        assert.strictEqual(typeof threadNode.nodeId, 'number');
        assert.strictEqual(typeof frameNode.nodeId, 'number');
        const ids = new Set([processNode.nodeId, threadNode.nodeId, frameNode.nodeId]);
        assert.strictEqual(ids.size, 3, 'nodeIds should be unique');
    });

    test('get_call_stacks nodeId resolves to the correct flamegraph path via focus_flamegraph', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = await startedServer(stats);

        const csRes = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 20,
            params: { name: 'get_call_stacks', arguments: {} },
        }) as Record<string, unknown>;
        const csContent = (csRes.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        type Node = { nodeId: number; scope: string; children: Node[] };
        const tree = JSON.parse(csContent[0].text) as Node[];
        const frameNode = tree[0].children[0].children[0]; // process → thread → frame
        assert.strictEqual(frameNode.scope, 'fn');

        let calledWith: number | null = null;
        server.setActions({ loadFile: () => {}, focusFrame: (k) => { calledWith = k; }, searchFrames: () => {} });
        await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 20,
            params: { name: 'focus_flamegraph', arguments: { nodeId: frameNode.nodeId } },
        });
        // Verify the exact frameKey: rolling hash matching flamegraph.js for P1→T1→/a.py:fn.
        // The parser strips the leading "P"/"T" from pid/tid, so pid="1" → "Process 1",
        // tid="1" → "Thread 1". Process/thread nodes have no module so their key is the
        // bare scope; frames use "module:scope" (matching node.key in the flamegraph hierarchy).
        const expectedKey = hashPath('/a.py:fn', hashPath('Thread 1', hashPath('Process 1')));
        assert.strictEqual(calledWith, expectedKey,
            `focusFrame should receive frameKey=${expectedKey} (Process 1 → Thread 1 → /a.py:fn), got: ${calledWith}`);
    });

    // --- load_profile -------------------------------------------------------

    test('load_profile bypasses the no-data guard', async () => {
        const stats = new AustinStats(); // empty — overallTotal === 0
        server = await startedServer(stats);
        server.setActions({ loadFile: () => {}, focusFrame: () => {}, searchFrames: () => {} });
        const tmpFile = makeTmpAustinFile();
        try {
            const res = await post(server.port, {
                jsonrpc: '2.0', method: 'tools/call', id: 21,
                params: { name: 'load_profile', arguments: { path: tmpFile } },
            }) as Record<string, unknown>;
            const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
            assert.ok(!content[0].text.includes('No profiling data'));
        } finally {
            fs.unlinkSync(tmpFile);
        }
    });

    test('load_profile returns error for missing path argument', async () => {
        const stats = new AustinStats();
        server = await startedServer(stats);
        server.setActions({ loadFile: () => {}, focusFrame: () => {}, searchFrames: () => {} });
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 22,
            params: { name: 'load_profile', arguments: {} },
        }) as Record<string, unknown>;
        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        assert.ok(content[0].text.toLowerCase().includes('missing'));
    });

    test('load_profile returns error when file does not exist', async () => {
        const stats = new AustinStats();
        server = await startedServer(stats);
        server.setActions({ loadFile: () => {}, focusFrame: () => {}, searchFrames: () => {} });
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 23,
            params: { name: 'load_profile', arguments: { path: '/no/such/file.austin' } },
        }) as Record<string, unknown>;
        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        assert.ok(content[0].text.toLowerCase().includes('not found'));
    });

    test('load_profile invokes loadFile action with the given path', async () => {
        const stats = new AustinStats();
        server = await startedServer(stats);
        const tmpFile = makeTmpAustinFile();
        try {
            let calledWith: string | null = null;
            server.setActions({ loadFile: (p) => { calledWith = p; }, focusFrame: () => {}, searchFrames: () => {} });
            await post(server.port, {
                jsonrpc: '2.0', method: 'tools/call', id: 24,
                params: { name: 'load_profile', arguments: { path: tmpFile } },
            });
            assert.strictEqual(calledWith, tmpFile);
        } finally {
            fs.unlinkSync(tmpFile);
        }
    });

    test('load_profile returns not-available message when no actions are set', async () => {
        const stats = new AustinStats();
        server = await startedServer(stats);
        // Deliberately do not call setActions
        const tmpFile = makeTmpAustinFile();
        try {
            const res = await post(server.port, {
                jsonrpc: '2.0', method: 'tools/call', id: 25,
                params: { name: 'load_profile', arguments: { path: tmpFile } },
            }) as Record<string, unknown>;
            const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
            assert.ok(content[0].text.toLowerCase().includes('not available'));
        } finally {
            fs.unlinkSync(tmpFile);
        }
    });

    // --- focus_flamegraph ---------------------------------------------------

    test('focus_flamegraph hits no-data guard when no stats are loaded', async () => {
        const stats = new AustinStats(); // empty
        server = await startedServer(stats);
        server.setActions({ loadFile: () => {}, focusFrame: () => {}, searchFrames: () => {} });
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 26,
            params: { name: 'focus_flamegraph', arguments: { nodeId: 0 } },
        }) as Record<string, unknown>;
        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        assert.ok(content[0].text.includes('No profiling data'));
    });

    test('focus_flamegraph returns error for missing nodeId argument', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = await startedServer(stats);
        server.setActions({ loadFile: () => {}, focusFrame: () => {}, searchFrames: () => {} });
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 27,
            params: { name: 'focus_flamegraph', arguments: {} },
        }) as Record<string, unknown>;
        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        assert.ok(content[0].text.toLowerCase().includes('missing'));
    });

    test('focus_flamegraph returns error for unknown nodeId', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = await startedServer(stats);
        server.setActions({ loadFile: () => {}, focusFrame: () => {}, searchFrames: () => {} });
        // 9999 was never returned by get_call_stacks
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 28,
            params: { name: 'focus_flamegraph', arguments: { nodeId: 9999 } },
        }) as Record<string, unknown>;
        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        assert.ok(content[0].text.toLowerCase().includes('unknown'));
    });

    test('focus_flamegraph returns not-available message when no actions are set', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = await startedServer(stats);
        // Populate _nodeIdMap via get_call_stacks, then attempt focus without actions
        const csRes = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 29,
            params: { name: 'get_call_stacks', arguments: {} },
        }) as Record<string, unknown>;
        const csContent = (csRes.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        type Node = { nodeId: number; children: Node[] };
        const nodeId = (JSON.parse(csContent[0].text) as Node[])[0].nodeId;

        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 29,
            params: { name: 'focus_flamegraph', arguments: { nodeId } },
        }) as Record<string, unknown>;
        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        assert.ok(content[0].text.toLowerCase().includes('not available'));
    });

    // --- get_call_stacks threshold ------------------------------------------

    test('get_call_stacks threshold filters out low-contribution branches', async () => {
        // heavy: 99 samples (~99%), light: 1 sample (~1%)
        const stats = await makeStats(
            'P1;T1;/a.py:heavy:1 99\n' +
            'P1;T1;/a.py:light:1 1\n'
        );
        server = await startedServer(stats);
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 30,
            params: { name: 'get_call_stacks', arguments: { threshold: 2 } },
        }) as Record<string, unknown>;

        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        const text = content[0].text;
        assert.ok(text.includes('heavy'), 'heavy (99%) should survive the threshold');
        assert.ok(!text.includes('light'), 'light (1%) should be pruned by threshold=2');
    });

    test('get_call_stacks threshold=0 keeps everything', async () => {
        const stats = await makeStats(
            'P1;T1;/a.py:heavy:1 99\n' +
            'P1;T1;/a.py:light:1 1\n'
        );
        server = await startedServer(stats);
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 31,
            params: { name: 'get_call_stacks', arguments: { threshold: 0 } },
        }) as Record<string, unknown>;

        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        const text = content[0].text;
        assert.ok(text.includes('heavy'));
        assert.ok(text.includes('light'), 'light should be kept when threshold=0');
    });

    test('get_call_stacks threshold prunes entire subtree of a low-contribution node', async () => {
        // outer calls inner; outer has 1% total — both should be pruned
        const stats = await makeStats(
            'P1;T1;/a.py:heavy:1 99\n' +
            'P1;T1;/a.py:outer:1;/a.py:inner:2 1\n'
        );
        server = await startedServer(stats);
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 32,
            params: { name: 'get_call_stacks', arguments: { threshold: 2 } },
        }) as Record<string, unknown>;

        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        const text = content[0].text;
        assert.ok(!text.includes('outer'), 'outer (1%) should be pruned');
        assert.ok(!text.includes('inner'), 'inner should be pruned as part of outer\'s subtree');
    });

    // --- get_call_stacks default depth --------------------------------------

    test('get_call_stacks expands significantly deeper than the old default', async () => {
        // Build a 20-frame deep stack
        const frames = Array.from({ length: 20 }, (_, i) => `/a.py:f${i}:${i + 1}`).join(';');
        const stats = await makeStats(`P1;T1;${frames} 100\n`);
        server = await startedServer(stats);
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 30,
            params: { name: 'get_call_stacks', arguments: {} },
        }) as Record<string, unknown>;

        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        const text = content[0].text;
        // depth=15: serializeCallStackNode starts at depth-1=14, consuming 2 levels for
        // process+thread, leaving 13 levels for frames → f0..f12 are visible.
        assert.ok(text.includes('"f12"'), 'depth=15 should reach frame f12');
        // The old depth=5 only reached f2; f12 proves the new default is much deeper.
        assert.ok(!text.includes('"f13"'), 'f13 should be just beyond the default depth');
    });

    // --- search_flamegraph --------------------------------------------------

    test('search_flamegraph hits no-data guard when no stats are loaded', async () => {
        const stats = new AustinStats();
        server = await startedServer(stats);
        server.setActions({ loadFile: () => {}, focusFrame: () => {}, searchFrames: () => {} });
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 31,
            params: { name: 'search_flamegraph', arguments: { term: 'fn' } },
        }) as Record<string, unknown>;
        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        assert.ok(content[0].text.includes('No profiling data'));
    });

    test('search_flamegraph returns error for missing term argument', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = await startedServer(stats);
        server.setActions({ loadFile: () => {}, focusFrame: () => {}, searchFrames: () => {} });
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 32,
            params: { name: 'search_flamegraph', arguments: {} },
        }) as Record<string, unknown>;
        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        assert.ok(content[0].text.toLowerCase().includes('missing'));
    });

    test('search_flamegraph invokes searchFrames action with the given term', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = await startedServer(stats);
        let calledWith: string | null = null;
        server.setActions({ loadFile: () => {}, focusFrame: () => {}, searchFrames: (t) => { calledWith = t; } });
        await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 33,
            params: { name: 'search_flamegraph', arguments: { term: 'my_func' } },
        });
        assert.strictEqual(calledWith, 'my_func');
    });

    test('search_flamegraph returns not-available message when no actions are set', async () => {
        const stats = await makeStats('P1;T1;/a.py:fn:1 100\n');
        server = await startedServer(stats);
        const res = await post(server.port, {
            jsonrpc: '2.0', method: 'tools/call', id: 34,
            params: { name: 'search_flamegraph', arguments: { term: 'fn' } },
        }) as Record<string, unknown>;
        const content = (res.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
        assert.ok(content[0].text.toLowerCase().includes('not available'));
    });
});
