import * as http from 'http';
import { existsSync } from 'fs';
import { AustinStats, TopStats } from '../model';
import { hashPath } from '../utils/pathKey';

export interface McpActions {
    loadFile: (path: string) => void;
    focusFrame: (frameKey: number) => void;
    searchFrames: (term: string) => void;
}

function normalizeScope(scope: string): string {
    const match = scope.match(/^([PT])([x0-9A-Fa-f]+)$/);
    if (!match) { return scope; }
    const [, type, id] = match;
    return type === 'P' ? `Process ${id}` : `Thread ${id}`;
}

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'austin-vscode';
const SERVER_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Tool definitions (static, sent in tools/list responses)
// ---------------------------------------------------------------------------
const TOOLS = [
    {
        name: 'get_top',
        description: 'Returns the top functions by own CPU/wall/memory time, sorted descending. Own time is the time spent directly in the function body; total time includes callees.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: {
                    type: 'number',
                    description: 'Maximum number of functions to return. Omit for all.',
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'get_call_stacks',
        description: [
            'Returns the process→thread→function call-stack tree for flame graph analysis.',
            'Each node has: scope (function name), module (source file path), own (fraction of',
            'total profiling time spent directly in this function body), total (fraction spent in',
            'this function and everything it calls — this is the flame graph width, i.e. the',
            '"plateau" size), children, and nodeId (pass directly to focus_flamegraph).',
            '',
            'To find the most interesting plateau in user code:',
            '1. Follow the child with the highest total down from the thread node.',
            '2. Stop when own becomes significant (the function itself is doing real work) or',
            '   when children fragment into many branches each with low total.',
            '3. Prefer nodes whose module does not contain "site-packages" or "/lib/python"',
            '   (those are third-party or stdlib frames — keep descending past them).',
            '',
            'Use a larger depth for framework-heavy code (Django, Flask, pytest, etc. add many',
            'layers of library frames before reaching user code).',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                depth: {
                    type: 'number',
                    description: 'Maximum tree depth to expand (default: 15). Increase for deeply nested or framework-heavy call stacks.',
                },
                threshold: {
                    type: 'number',
                    description: 'Minimum total% a node must account for to be included (default: 0 — no filtering). For example, 0.1 drops every call-stack branch that accounts for less than 0.1% of total profiling time, keeping the response compact for large profiles.',
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'get_metadata',
        description: 'Returns profiling session metadata: source file, sampling mode, interval, total sample count, and any other metadata emitted by Austin.',
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
    {
        name: 'get_gc_data',
        description: 'Returns garbage collector activity data. Includes per-thread GC time fractions and the top functions that were on the stack while the GC was running, ranked by own GC time. Returns an empty result if GC data collection was not enabled for this session (use the GC toggle in the status bar to enable it).',
        inputSchema: {
            type: 'object',
            properties: {
                limit: {
                    type: 'number',
                    description: 'Maximum number of top GC frames to return. Omit for all.',
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'search_flamegraph',
        description: 'Highlights every flame graph frame whose function name contains the given term (case-sensitive substring match) and reveals the flame graph view. Unlike focus_flamegraph, which zooms to a single node by exact path key, this highlights all occurrences of a function across every thread and call chain. Use this to show the user all places a given function appears — for example after identifying a hot function via get_call_stacks.',
        inputSchema: {
            type: 'object',
            properties: {
                term: {
                    type: 'string',
                    description: 'Substring to match against function names in the flame graph.',
                },
            },
            required: ['term'],
            additionalProperties: false,
        },
    },
    {
        name: 'load_profile',
        description: 'Loads an Austin profile file from the given path and opens it in the flamegraph view for the user to inspect. Call this after collecting profiling data with Austin to display the results. The file is loaded asynchronously; call get_metadata shortly after to confirm the data is available.',
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Absolute path to the Austin profile file (.austin, .aprof, or .mojo).',
                },
            },
            required: ['path'],
            additionalProperties: false,
        },
    },
    {
        name: 'focus_flamegraph',
        description: 'Zooms the flame graph to a specific node, identified by the nodeId returned in the get_call_stacks response. Call get_call_stacks first to obtain valid node IDs.',
        inputSchema: {
            type: 'object',
            properties: {
                nodeId: {
                    type: 'number',
                    description: 'The nodeId of the flame graph node to focus, as returned by get_call_stacks.',
                },
            },
            required: ['nodeId'],
            additionalProperties: false,
        },
    },
];

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------
interface CallStackNode {
    nodeId: number;
    scope: string | null;
    module: string | null;
    own: number;
    total: number;
    children: CallStackNode[];
}

function serializeCallStackNode(
    node: TopStats,
    depth: number,
    parentHash: number,
    threshold: number,
    assignId: (frameKey: number) => number,
): CallStackNode {
    const scope = normalizeScope(node.scope ?? '');
    const key = node.module ? `${node.module}:${scope}` : scope;
    const myKey = hashPath(key, parentHash);
    const children = depth > 0
        ? [...node.callees.values()]
            .filter(child => child.total * 100 >= threshold)
            .map(child => serializeCallStackNode(child, depth - 1, myKey, threshold, assignId))
        : [];
    return {
        nodeId: assignId(myKey),
        scope: node.scope,
        module: node.module,
        own: parseFloat((node.own * 100).toFixed(2)),
        total: parseFloat((node.total * 100).toFixed(2)),
        children,
    };
}

// ---------------------------------------------------------------------------
// AustinMcpServer
// ---------------------------------------------------------------------------
export class AustinMcpServer {
    private _httpServer: http.Server | null = null;
    private _stats: AustinStats | null = null;
    private _actions: McpActions | null = null;
    /** Maps nodeId → flamegraph frameKey (hash). Rebuilt on each get_call_stacks call. */
    private _nodeIdMap: Map<number, number> = new Map();

    /** Registers callbacks for UI actions the MCP tools can trigger. */
    setActions(actions: McpActions): void {
        this._actions = actions;
    }

    /** Starts the server on an OS-assigned port. Resolves once the port is known. */
    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => this._handleRequest(req, res));
            server.on('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.removeListener('error', reject);
                server.on('error', (err: NodeJS.ErrnoException) => {
                    console.error(`Austin MCP server error: ${err.message}`);
                });
                resolve();
            });
            this._httpServer = server;
        });
    }

    /** Updates the stats served by this server. Called on every profiling refresh. */
    update(stats: AustinStats): void {
        this._stats = stats;
    }

    /** Returns the port the server is listening on. */
    get port(): number {
        const addr = this._httpServer?.address();
        if (addr && typeof addr === 'object') { return addr.port; }
        return 0;
    }

    dispose(): void {
        this._httpServer?.close();
        this._httpServer = null;
        this._stats = null;
    }

    private _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(this._error(null, -32600, 'Only POST is supported')));
            return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
            let msg: unknown;
            try {
                msg = JSON.parse(body);
            } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(this._error(null, -32700, 'Parse error')));
                return;
            }

            const response = this._dispatch(msg as Record<string, unknown>);
            if (response === null) {
                // Notification — no body expected
                res.writeHead(202);
                res.end();
                return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
        });
    }

    private _dispatch(msg: Record<string, unknown>): Record<string, unknown> | null {
        const id = (msg.id ?? null) as string | number | null;
        const method = msg.method as string | undefined;
        const params = (msg.params ?? {}) as Record<string, unknown>;

        switch (method) {
            case 'initialize':
                return {
                    jsonrpc: '2.0', id,
                    result: {
                        protocolVersion: MCP_PROTOCOL_VERSION,
                        capabilities: { tools: {} },
                        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
                    },
                };

            case 'ping':
                return { jsonrpc: '2.0', id, result: {} };

            case 'notifications/initialized':
            case 'notifications/cancelled':
                return null; // Notifications require no response

            case 'tools/list':
                return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

            case 'tools/call': {
                const toolName = params.name as string | undefined;
                const args = (params.arguments ?? {}) as Record<string, unknown>;
                if (!toolName) {
                    return this._error(id, -32602, 'Missing tool name');
                }
                const content = this._callTool(toolName, args);
                return { jsonrpc: '2.0', id, result: { content } };
            }

            default:
                return this._error(id, -32601, `Method not found: ${method}`);
        }
    }

    private _callTool(name: string, args: Record<string, unknown>): Array<{ type: string; text: string }> {
        // These tools work regardless of whether profiling data is loaded.
        if (name === 'load_profile') {
            return this._loadProfile(args.path as string | undefined);
        }

        if (!this._stats || this._stats.overallTotal === 0) {
            return [{ type: 'text', text: 'No profiling data available yet. Run a profiling session first.' }];
        }

        switch (name) {
            case 'get_top':
                return this._getTop(args.limit as number | undefined);
            case 'get_call_stacks':
                return this._getCallStacks(args.depth as number | undefined, args.threshold as number | undefined);
            case 'get_metadata':
                return this._getMetadata();
            case 'get_gc_data':
                return this._getGCData(args.limit as number | undefined);
            case 'focus_flamegraph':
                return this._focusFlamegraph(args.nodeId as number | undefined);
            case 'search_flamegraph':
                return this._searchFlamegraph(args.term as string | undefined);
            default:
                return [{ type: 'text', text: `Unknown tool: ${name}` }];
        }
    }

    private _loadProfile(path?: string): Array<{ type: string; text: string }> {
        if (!path) {
            return [{ type: 'text', text: 'Missing required argument: path' }];
        }
        if (!existsSync(path)) {
            return [{ type: 'text', text: `File not found: ${path}` }];
        }
        if (!this._actions) {
            return [{ type: 'text', text: 'Profile loading is not available.' }];
        }
        this._actions.loadFile(path);
        return [{ type: 'text', text: `Loading profile from ${path}. The flamegraph view will update once parsing is complete.` }];
    }

    private _focusFlamegraph(nodeId?: number): Array<{ type: string; text: string }> {
        if (nodeId === undefined) {
            return [{ type: 'text', text: 'Missing required argument: nodeId' }];
        }
        const frameKey = this._nodeIdMap.get(nodeId);
        if (frameKey === undefined) {
            return [{ type: 'text', text: 'Unknown nodeId. Call get_call_stacks first to obtain valid node IDs.' }];
        }
        if (!this._actions) {
            return [{ type: 'text', text: 'Flamegraph focus is not available.' }];
        }
        this._actions.focusFrame(frameKey);
        return [{ type: 'text', text: `Focused flamegraph node ${nodeId}.` }];
    }

    private _searchFlamegraph(term?: string): Array<{ type: string; text: string }> {
        if (!term) {
            return [{ type: 'text', text: 'Missing required argument: term' }];
        }
        if (!this._actions) {
            return [{ type: 'text', text: 'Flamegraph search is not available.' }];
        }
        this._actions.searchFrames(term);
        return [{ type: 'text', text: `Searching flamegraph for: ${term}` }];
    }

    private _getTop(limit?: number): Array<{ type: string; text: string }> {
        const stats = this._stats!;
        const entries = [...stats.top.entries()]
            .map(([key, s]) => ({
                key,
                scope: s.scope,
                module: s.module,
                ownPct: parseFloat((s.own * 100).toFixed(2)),
                totalPct: parseFloat((s.total * 100).toFixed(2)),
                line: s.minLine,
            }))
            .sort((a, b) => b.ownPct - a.ownPct);

        // eslint-disable-next-line eqeqeq
        const result = limit != null && limit > 0 ? entries.slice(0, limit) : entries;
        return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
    }

    private _getCallStacks(depth: number = 15, threshold: number = 0): Array<{ type: string; text: string }> {
        const stats = this._stats!;
        this._nodeIdMap.clear();
        let nextId = 0;
        const assignId = (frameKey: number) => {
            const id = nextId++;
            this._nodeIdMap.set(id, frameKey);
            return id;
        };
        const tree = [...stats.callStack.callees.values()]
            .filter(n => n.total * 100 >= threshold)
            .map(n => serializeCallStackNode(n, depth - 1, 0, threshold, assignId));
        return [{ type: 'text', text: JSON.stringify(tree, null, 2) }];
    }

    private _getMetadata(): Array<{ type: string; text: string }> {
        const stats = this._stats!;
        const meta: Record<string, unknown> = {
            source: stats.source,
            totalSamples: stats.overallTotal,
        };
        for (const [k, v] of stats.metadata) { meta[k] = v; }
        return [{ type: 'text', text: JSON.stringify(meta, null, 2) }];
    }

    private _getGCData(limit?: number): Array<{ type: string; text: string }> {
        const stats = this._stats!;

        if (!stats.gcEvents.length) {
            return [{ type: 'text', text: JSON.stringify({ available: false, reason: 'No GC data in this profile. Enable GC collection with the GC toggle in the status bar.' }) }];
        }

        // Accumulate per-thread and per-frame GC metrics from the event log
        const threadMap = new Map<string, { pid: number; tid: string; gcMetric: number; totalMetric: number }>();
        const frameOwn = new Map<string, number>();
        const frameAll = new Map<string, number>();

        for (const ev of stats.gcEvents) {
            if (ev.metric <= 0) { continue; }
            const threadKey = `${ev.pid}:${ev.tid}`;
            if (!threadMap.has(threadKey)) {
                threadMap.set(threadKey, { pid: ev.pid, tid: ev.tid, gcMetric: 0, totalMetric: 0 });
            }
            const thread = threadMap.get(threadKey)!;
            thread.totalMetric += ev.metric;

            if (!ev.gc) { continue; }
            thread.gcMetric += ev.metric;

            const seen = new Set<string>();
            for (let i = 0; i < ev.frameKeys.length; i++) {
                const key = ev.frameKeys[i];
                if (seen.has(key)) { continue; }
                seen.add(key);
                frameAll.set(key, (frameAll.get(key) ?? 0) + ev.metric);
                if (i === ev.frameKeys.length - 1) {
                    frameOwn.set(key, (frameOwn.get(key) ?? 0) + ev.metric);
                }
            }
        }

        const threads = [...threadMap.values()]
            .filter(t => t.gcMetric > 0)
            .map(t => ({
                pid: t.pid,
                tid: t.tid,
                gcPct: parseFloat((t.gcMetric / t.totalMetric * 100).toFixed(2)),
            }))
            .sort((a, b) => b.gcPct - a.gcPct);

        if (threads.length === 0) {
            return [{ type: 'text', text: JSON.stringify({ available: false, reason: 'GC data was collected but no GC activity was recorded.' }) }];
        }

        const denom = stats.overallTotal || 1;
        let frames = [...frameAll.entries()]
            .map(([key, totalMetric]) => {
                const topStats = stats.top.get(key);
                const lastColon = key.lastIndexOf(':');
                return {
                    scope:    topStats?.scope  ?? (lastColon >= 0 ? key.slice(lastColon + 1) : key),
                    module:   topStats?.module ?? (lastColon >= 0 ? key.slice(0, lastColon)  : ''),
                    line:     topStats?.minLine ?? 0,
                    ownGcPct:   parseFloat(((frameOwn.get(key) ?? 0) / denom * 100).toFixed(2)),
                    totalGcPct: parseFloat((totalMetric / denom * 100).toFixed(2)),
                };
            })
            .sort((a, b) => b.ownGcPct - a.ownGcPct);

        // eslint-disable-next-line eqeqeq
        if (limit != null && limit > 0) { frames = frames.slice(0, limit); }

        return [{ type: 'text', text: JSON.stringify({ available: true, threads, frames }, null, 2) }];
    }

    private _error(
        id: string | number | null,
        code: number,
        message: string,
    ): Record<string, unknown> {
        return { jsonrpc: '2.0', id, error: { code, message } };
    }
}
