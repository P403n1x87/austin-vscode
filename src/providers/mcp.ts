import * as http from 'http';
import { AustinStats, TopStats } from '../model';

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
        description: 'Returns the process→thread→function call-stack tree. Each node has scope, module, own%, total%, and children.',
        inputSchema: {
            type: 'object',
            properties: {
                depth: {
                    type: 'number',
                    description: 'Maximum tree depth to expand (default: 5).',
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
];

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------
interface CallStackNode {
    scope: string | null;
    module: string | null;
    own: number;
    total: number;
    children: CallStackNode[];
}

function serializeCallStackNode(node: TopStats, depth: number): CallStackNode {
    return {
        scope: node.scope,
        module: node.module,
        own: parseFloat((node.own * 100).toFixed(2)),
        total: parseFloat((node.total * 100).toFixed(2)),
        children: depth > 0
            ? [...node.callees.values()].map(child => serializeCallStackNode(child, depth - 1))
            : [],
    };
}

// ---------------------------------------------------------------------------
// AustinMcpServer
// ---------------------------------------------------------------------------
export class AustinMcpServer {
    private _httpServer: http.Server | null = null;
    private _stats: AustinStats | null = null;

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
        if (!this._stats || this._stats.overallTotal === 0) {
            return [{ type: 'text', text: 'No profiling data available yet. Run a profiling session first.' }];
        }

        switch (name) {
            case 'get_top':
                return this._getTop(args.limit as number | undefined);
            case 'get_call_stacks':
                return this._getCallStacks(args.depth as number | undefined);
            case 'get_metadata':
                return this._getMetadata();
            default:
                return [{ type: 'text', text: `Unknown tool: ${name}` }];
        }
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

        const result = limit != null && limit > 0 ? entries.slice(0, limit) : entries;
        return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
    }

    private _getCallStacks(depth: number = 5): Array<{ type: string; text: string }> {
        const stats = this._stats!;
        const tree = [...stats.callStack.callees.values()].map(n => serializeCallStackNode(n, depth - 1));
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

    private _error(
        id: string | number | null,
        code: number,
        message: string,
    ): Record<string, unknown> {
        return { jsonrpc: '2.0', id, error: { code, message } };
    }
}
