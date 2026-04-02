import * as vscode from 'vscode';
import { AustinStats, TopStats } from '../model';

interface CallerNode {
    key: string;
    scope: string | null;
    module: string | null;
    own: number;
    total: number;
    contribution: number;
    line: number;
    callers: CallerNode[];
    callersPending?: boolean;
}

interface TopItemData {
    key: string;
    scope: string | null;
    module: string | null;
    own: number;
    total: number;
    line: number;
    callers: CallerNode[];
}

export class TopViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'austin-vscode.top';

    private _view?: vscode.WebviewView;
    private _stats: AustinStats | null = null;
    private _initialized: boolean = false;

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
                if (this._stats) {
                    this._postData(this._stats);
                }
                return;
            }
            if (data.module !== undefined) {
                vscode.commands.executeCommand('austin-vscode.openSourceAtLine', data.module, data.line || 0);
            }
            if (data.requestCallers && this._stats) {
                const { rowId, key, ancestorKeys } = data.requestCallers;
                const topStats = this._stats.top.get(key);
                if (topStats) {
                    const path = new Set([key, ...(ancestorKeys as string[])]);
                    const callers = this._serializeCallers(topStats, path, 3);
                    this._view?.webview.postMessage({ callersFor: rowId, callers });
                }
            }
        });

        webviewView.webview.html = this._getHtml(webviewView.webview);
    }

    public showLoading() {
        this._view?.webview.postMessage({ loading: true });
    }

    public showError() {
        this._view?.webview.postMessage({ error: true });
    }

    public showLive() {
        this._view?.webview.postMessage({ live: true });
    }

    public hideLive() {
        this._view?.webview.postMessage({ live: false });
    }

    public refresh(stats: AustinStats) {
        this._stats = stats;
        if (this._view && this._initialized) {
            this._postData(stats);
        }
    }

    private _serializeCallers(stats: TopStats, path: Set<string>, depth: number): CallerNode[] {
        if (stats.total < 1e-10) { return []; }

        const result: CallerNode[] = [];
        for (const [key, callerStats] of stats.callers) {
            const rawContrib = stats.callerContributions.get(key) ?? 0;
            const fraction = rawContrib / stats.total;
            const isCycle = path.has(key);
            let callerCallers: CallerNode[] = [];
            let callersPending = false;
            if (!isCycle) {
                if (depth <= 0) {
                    callersPending = callerStats.callers.size > 0;
                } else {
                    path.add(key);
                    callerCallers = this._serializeCallers(callerStats, path, depth - 1);
                    path.delete(key);
                }
            }
            result.push({
                key,
                scope: callerStats.scope,
                module: callerStats.module,
                own: callerStats.own,
                total: callerStats.total,
                contribution: fraction,
                line: callerStats.minLine,
                callers: callerCallers,
                callersPending,
            });
        }
        return result.sort((a, b) => b.contribution - a.contribution);
    }

    private _postData(stats: AustinStats) {
        const top: TopItemData[] = [...stats.top.values()]
            .sort((a, b) => b.own - a.own)
            .map(s => {
                const key = s.key();
                return {
                    key,
                    scope: s.scope,
                    module: s.module,
                    own: s.own,
                    total: s.total,
                    line: s.minLine,
                    callers: this._serializeCallers(s, new Set([key]), 3),
                };
            });
        this._view!.webview.postMessage({ top });
    }

    private _getHtml(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'top.js')
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
            overflow-x: hidden;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            table-layout: auto;
        }
        thead {
            position: sticky;
            top: var(--toolbar-h, 32px);
            background: var(--vscode-sideBar-background, var(--vscode-editor-background));
            z-index: 1;
        }
        th {
            text-align: left;
            padding: 5px 6px;
            border-bottom: 1px solid var(--vscode-panel-border, #444);
            font-weight: 600;
            font-size: 0.9em;
            color: var(--vscode-foreground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        th[data-col] {
            cursor: pointer;
            user-select: none;
        }
        th[data-col]:hover { background: var(--vscode-list-hoverBackground); }
        th.desc::after { content: " ▼"; font-size: 9px; }
        th.asc::after  { content: " ▲"; font-size: 9px; }
        td {
            padding: 3px 4px;
            border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground, rgba(128,128,128,0.1));
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            vertical-align: middle;
        }
        .top-row > td,
        .caller-row > td { cursor: pointer; }
        .top-row:hover > td,
        .caller-row:hover > td { background: var(--vscode-list-hoverBackground); }
        .top-row[data-expandable]:hover > td,
        .caller-row[data-expandable]:hover > td { background: var(--vscode-list-hoverBackground); }
        .top-row[data-open] > td,
        .caller-row[data-open] > td {
            background: var(--vscode-list-inactiveSelectionBackground, rgba(128,128,128,0.08));
            border-bottom-color: transparent;
        }
        col.func  { width: 100%; }
        .bar-row { display: flex; align-items: center; gap: 4px; }
        .bar-bg {
            flex: 0 0 24px;
            height: 5px;
            background: var(--vscode-progressBar-background, rgba(128,128,128,0.2));
            border-radius: 3px;
            overflow: hidden;
        }
        .bar-fill { height: 5px; border-radius: 3px; background: var(--vscode-descriptionForeground); opacity: 0.4; }
        .bar-fill[style] { opacity: 1; }
        .pct {
            width: 40px;
            text-align: right;
            font-variant-numeric: tabular-nums;
            font-family: var(--vscode-editor-font-family, monospace);
            flex-shrink: 0;
            font-size: var(--vscode-editor-font-size, 1em);
        }
        .func { font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 1em); }
        .scope-name {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: var(--vscode-editor-font-size, 1em);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .scope-module {
            margin-left: 6px;
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
        }
        .caller-row > td {
            font-size: 0.9em;
            border-bottom-color: transparent;
        }
        /* depth guide lines: left border on the func cell steps in per level */
        .caller-row .func {
            border-left: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
            font-size: 0.9em;
        }
        .caller-row .pct { font-size: 0.85em; width: 36px; }
        .toolbar {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 4px 6px;
            border-bottom: 1px solid var(--vscode-panel-border, #444);
            user-select: none;
            position: sticky;
            top: 0;
            z-index: 2;
            background: var(--vscode-sideBar-background, var(--vscode-editor-background));
        }
        .filter-wrap {
            flex: 1;
            min-width: 0;
            position: relative;
            display: flex;
            align-items: center;
        }
        #filter-input {
            width: 100%;
            background: rgba(128,128,128,0.1);
            border: 1px solid rgba(128,128,128,0.25);
            border-radius: 3px;
            color: var(--vscode-foreground);
            font-size: 0.9em;
            font-family: inherit;
            padding: 2px 22px 2px 6px;
            height: 20px;
            outline: none;
        }
        #filter-input:focus { border-color: var(--vscode-focusBorder, rgba(0,120,215,0.8)); }
        #filter-input::placeholder { color: var(--vscode-descriptionForeground); opacity: 0.6; }
        #filter-clear {
            position: absolute;
            right: 3px;
            display: none;
            align-items: center;
            justify-content: center;
            width: 14px;
            height: 14px;
            padding: 0;
            border: none;
            background: none;
            cursor: pointer;
            color: var(--vscode-descriptionForeground);
            border-radius: 2px;
            opacity: 0.6;
            line-height: 1;
        }
        #filter-clear:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
        #filter-clear.visible { display: flex; }
        .toolbar-btn {
            flex-shrink: 0;
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
        #live-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #e74c3c;
            flex-shrink: 0;
            display: none;
            margin-left: 2px;
        }
        #live-dot.active { display: block; animation: live-pulse 1.4s ease-in-out infinite; }
        @keyframes live-pulse {
            0%, 100% { opacity: 1; }
            50%       { opacity: 0.3; }
        }
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
        <div class="filter-wrap">
            <input id="filter-input" type="text" placeholder="Filter…" autocomplete="off" spellcheck="false" />
            <button id="filter-clear" title="Clear filter">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                    <line x1="1.5" y1="1.5" x2="8.5" y2="8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                    <line x1="8.5" y1="1.5" x2="1.5" y2="8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
            </button>
        </div>
        <button class="toolbar-btn" id="collapse-all" title="Collapse all">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <rect x="2" y="2" width="12" height="1.5" rx="0.75"/>
                <rect x="2" y="12.5" width="12" height="1.5" rx="0.75"/>
                <path d="M5.5 5L8 7.5L10.5 5M5.5 11L8 8.5L10.5 11" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        </button>
        <span id="live-dot" title="Live session active"></span>
    </div>
    <div id="empty" class="empty">No profiling data loaded.</div>
    <table id="table" style="display:none">
        <colgroup>
            <col class="own">
            <col class="total">
            <col class="func">
        </colgroup>
        <thead>
            <tr>
                <th data-col="own" class="desc">Own</th>
                <th data-col="total">Total</th>
                <th data-col="scope">Scope</th>
            </tr>
        </thead>
        <tbody id="tbody"></tbody>
    </table>
    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
