import * as vscode from 'vscode';
import { AustinStats, TopStats } from '../model';

interface CallStackNode {
    pathKey: string;
    scope: string;
    module: string | null;
    own: number;
    total: number;
    line: number;
    children: CallStackNode[];
    childrenPending?: boolean;
}

function normalizeScope(scope: string): string {
    const match = scope.match(/^([PT])([x0-9A-Fa-f]+)$/);
    if (!match) { return scope; }
    const [, type, id] = match;
    return type === 'P' ? `Process ${id}` : `Thread ${id}`;
}

function serializeNode(node: TopStats, parentPath: string, depth: number): CallStackNode {
    const scope = normalizeScope(node.scope ?? '');
    const pathKey = parentPath ? `${parentPath}/${scope}` : scope;
    const hasChildren = node.callees.size > 0;
    return {
        pathKey,
        scope,
        module: node.module || null,
        own: node.own,
        total: node.total,
        line: node.minLine,
        children: depth > 0
            ? [...node.callees.values()].map(child => serializeNode(child, pathKey, depth - 1))
            : [],
        childrenPending: hasChildren && depth <= 0,
    };
}

export class CallStackViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'austin-vscode.callStacks';

    private _view?: vscode.WebviewView;
    private _stats: AustinStats | null = null;
    private _initialized: boolean = false;
    private _onFrameSelected?: (pathKey: string) => void;
    private _nodeMap: Map<string, TopStats> = new Map();

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        this._initialized = false;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.onDidReceiveMessage(data => {
            if (data === 'initialized') {
                this._initialized = true;
                if (this._stats) { this._postData(this._stats); }
                return;
            }
            if (data.module) {
                vscode.commands.executeCommand('austin-vscode.openSourceAtLine', data.module, data.line || 0);
            }
            if (data.pathKey && this._onFrameSelected) {
                this._onFrameSelected(data.pathKey);
            }
            if (data.requestChildren) {
                const node = this._nodeMap.get(data.requestChildren);
                if (node) {
                    const parentPathKey = data.requestChildren;
                    const children = [...node.callees.values()].map(child => serializeNode(child, parentPathKey, 3));
                    this._view?.webview.postMessage({ childrenFor: parentPathKey, children });
                }
            }
        });

        webviewView.webview.html = this._getHtml(webviewView.webview);
    }

    public onFrameSelected(cb: (pathKey: string) => void) {
        this._onFrameSelected = cb;
    }

    public showLoading() {
        this._view?.webview.postMessage({ loading: true });
    }

    public focusPath(pathKey: string) {
        this._view?.webview.postMessage({ focus: { pathKey } });
    }

    public refresh(stats: AustinStats) {
        this._stats = stats;
        if (this._view && this._initialized) { this._postData(stats); }
    }

    private _buildNodeMap(node: TopStats, parentPath: string): void {
        const scope = normalizeScope(node.scope ?? '');
        const pathKey = parentPath ? `${parentPath}/${scope}` : scope;
        this._nodeMap.set(pathKey, node);
        for (const child of node.callees.values()) {
            this._buildNodeMap(child, pathKey);
        }
    }

    private _postData(stats: AustinStats) {
        this._nodeMap.clear();
        for (const node of stats.callStack.callees.values()) {
            this._buildNodeMap(node, '');
        }
        const tree = [...stats.callStack.callees.values()].map(node => serializeNode(node, '', 3));
        this._view!.webview.postMessage({ tree });
    }

    private _getHtml(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'callstack.js')
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { box-sizing: border-box; }
        body {
            padding: 0;
            margin: 0;
            font-size: var(--vscode-font-size, 12px);
            font-family: var(--vscode-font-family, sans-serif);
            color: var(--vscode-foreground);
            background: transparent;
        }
        .toolbar {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 4px 6px;
            border-bottom: 1px solid var(--vscode-panel-border, #444);
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
            user-select: none;
            position: sticky;
            top: 0;
            z-index: 2;
            background: var(--vscode-sideBar-background, var(--vscode-editor-background));
        }
        .toolbar label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
        .toolbar input[type=checkbox] { cursor: pointer; accent-color: var(--vscode-focusBorder); }
        .toolbar-btn {
            margin-left: auto;
            background: none;
            border: none;
            padding: 2px;
            cursor: pointer;
            color: var(--vscode-descriptionForeground);
            display: flex;
            align-items: center;
            border-radius: 3px;
            opacity: 0.7;
        }
        .toolbar-btn:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
        table {
            width: 100%;
            border-collapse: collapse;
            table-layout: fixed;
        }
        thead {
            position: sticky;
            top: var(--toolbar-h, 32px);
            background: var(--vscode-sideBar-background, var(--vscode-editor-background));
            z-index: 1;
        }
        th {
            padding: 5px 6px;
            border-bottom: 1px solid var(--vscode-panel-border, #444);
            font-weight: 600;
            font-size: 0.9em;
            color: var(--vscode-foreground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        th.scope-header { text-align: left; }
        th.stat-header  { text-align: right; width: 64px; cursor: pointer; user-select: none; }
        th.stat-header:hover { background: var(--vscode-list-hoverBackground); }
        th.desc::after { content: " ▼"; font-size: 9px; }
        th.asc::after  { content: " ▲"; font-size: 9px; }
        td {
            padding: 2px 6px;
            border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground, rgba(128,128,128,0.1));
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            vertical-align: middle;
            cursor: pointer;
        }
        tr:hover > td { background: var(--vscode-list-hoverBackground); }
        tr[data-open] > td {
            background: var(--vscode-list-inactiveSelectionBackground, rgba(128,128,128,0.08));
        }
        tr[data-open]:hover > td { background: var(--vscode-list-hoverBackground); }
        /* scope cell */
        .scope-cell { display: flex; align-items: baseline; gap: 0; min-width: 0; }
        .chevron {
            flex-shrink: 0;
            display: inline-block;
            width: 14px;
            font-size: 8px;
            color: var(--vscode-descriptionForeground);
            transition: transform 0.12s ease;
            user-select: none;
        }
        tr[data-open] .chevron { transform: rotate(90deg); }
        tr:not([data-expandable]) .chevron { visibility: hidden; }
        .scope-name {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: var(--vscode-editor-font-size, 1em);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            flex-shrink: 1;
            min-width: 0;
        }
        .scope-module {
            flex-shrink: 0;
            margin-left: 6px;
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
        }
        /* stat cells */
        td.stat {
            text-align: right;
            width: 64px;
            font-size: var(--vscode-editor-font-size, 1em);
            font-family: var(--vscode-editor-font-family, monospace);
            font-variant-numeric: tabular-nums;
            color: var(--vscode-foreground);
        }
        td.stat.zero { color: var(--vscode-descriptionForeground); }
        @keyframes focus-flash {
            0%   { background: rgba(55,148,255,0.35) !important; }
            100% { background: transparent; }
        }
        tr.focused > td { animation: focus-flash 1.4s ease-out forwards; }
        .empty {
            padding: 24px 16px;
            color: var(--vscode-descriptionForeground);
            text-align: center;
            font-style: italic;
        }
        #loading {
            display: none;
            position: fixed;
            inset: 0;
            align-items: center;
            justify-content: center;
            background: rgba(0,0,0,0.12);
            z-index: 10;
        }
        #loading.active { display: flex; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spinner {
            width: 20px;
            height: 20px;
            border: 2px solid rgba(128,128,128,0.25);
            border-top-color: var(--vscode-progressBar-background, #007acc);
            border-radius: 50%;
            animation: spin 0.7s linear infinite;
        }
    </style>
</head>
<body>
    <div id="loading"><div class="spinner"></div></div>
    <div class="toolbar">
        <label>
            <input type="checkbox" id="sync-toggle" checked>
            Sync with flame graph
        </label>
        <button class="toolbar-btn" id="collapse-all" title="Collapse all">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <rect x="2" y="2" width="12" height="1.5" rx="0.75"/>
                <rect x="2" y="12.5" width="12" height="1.5" rx="0.75"/>
                <path d="M8 4.5 L5 7.5 L8 7.5 L8 8.5 L5 8.5 L8 11.5 L11 8.5 L8 8.5 L8 7.5 L11 7.5 Z" opacity="0"/>
                <path d="M5.5 5L8 7.5L10.5 5M5.5 11L8 8.5L10.5 11" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        </button>
    </div>
    <div id="empty" class="empty">No profiling data loaded.</div>
    <table id="table" style="display:none">
        <colgroup>
            <col>
            <col style="width:64px">
            <col style="width:64px">
        </colgroup>
        <thead>
            <tr>
                <th class="scope-header">Scope</th>
                <th class="stat-header desc" data-col="own">Own</th>
                <th class="stat-header" data-col="total">Total</th>
            </tr>
        </thead>
        <tbody id="tbody"></tbody>
    </table>
    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
