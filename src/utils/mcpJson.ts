import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const AUSTIN_KEY = 'austin';
const MCP_JSON = '.mcp.json';

interface McpServerEntry {
    type: string;
    url: string;
    [key: string]: unknown;
}

interface McpConfig {
    mcpServers?: Record<string, McpServerEntry>;
    [key: string]: unknown;
}

function austinEntry(port: number): McpServerEntry {
    return { type: 'http', url: `http://127.0.0.1:${port}/mcp` };
}

function readConfig(filePath: string): McpConfig {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as McpConfig;
    } catch {
        return {};
    }
}

function writeConfig(filePath: string, config: McpConfig): void {
    fs.writeFileSync(filePath, JSON.stringify(config, null, 4) + '\n');
}

/** Writes or updates the austin entry in `.mcp.json` for the given folder. */
export function writeMcpJson(folder: vscode.WorkspaceFolder, port: number): void {
    const filePath = path.join(folder.uri.fsPath, MCP_JSON);
    const config = readConfig(filePath);
    if (!config.mcpServers) { config.mcpServers = {}; }
    config.mcpServers[AUSTIN_KEY] = austinEntry(port);
    writeConfig(filePath, config);
}

/**
 * Scans all workspace folders for an existing `.mcp.json` that already has an
 * austin entry and updates the port in each one found.
 */
export function updateMcpJsonIfPresent(port: number): void {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const filePath = path.join(folder.uri.fsPath, MCP_JSON);
        if (!fs.existsSync(filePath)) { continue; }
        const config = readConfig(filePath);
        if (!config.mcpServers?.[AUSTIN_KEY]) { continue; }
        config.mcpServers[AUSTIN_KEY] = {
            ...config.mcpServers[AUSTIN_KEY],
            ...austinEntry(port),
        };
        writeConfig(filePath, config);
    }
}
