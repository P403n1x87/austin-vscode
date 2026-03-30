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
        });

        webviewView.webview.html = this._getHtml(webviewView.webview);
    }

    public refresh(stats: AustinStats) {
        this._stats = stats;
        if (this._view && this._initialized) {
            this._postData(stats);
        }
    }

    private _serializeCallers(stats: TopStats, path: Set<string>): CallerNode[] {
        if (stats.total < 1e-10) { return []; }

        const result: CallerNode[] = [];
        for (const [key, callerStats] of stats.callers) {
            const rawContrib = stats.callerContributions.get(key) ?? 0;
            const fraction = rawContrib / stats.total;
            const newPath = new Set(path).add(key);
            const callerCallers = path.has(key)
                ? []
                : this._serializeCallers(callerStats, newPath);
            result.push({
                key,
                scope: callerStats.scope,
                module: callerStats.module,
                own: callerStats.own,
                total: callerStats.total,
                contribution: fraction,
                line: callerStats.lines.size > 0 ? Math.min(...callerStats.lines) : 0,
                callers: callerCallers,
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
                    line: s.lines.size > 0 ? Math.min(...s.lines) : 0,
                    callers: this._serializeCallers(s, new Set([key])),
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
        }
        table {
            width: 100%;
            border-collapse: collapse;
            table-layout: fixed;
        }
        thead {
            position: sticky;
            top: 0;
            background: var(--vscode-sideBar-background, var(--vscode-editor-background));
            z-index: 1;
        }
        th {
            text-align: left;
            padding: 5px 6px;
            border-bottom: 1px solid var(--vscode-panel-border, #444);
            font-weight: 600;
            font-size: 11px;
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
        col.own   { width: 88px; }
        col.total { width: 88px; }
        col.func  { width: auto; }
        col.mod   { width: 100px; }
        .bar-row { display: flex; align-items: center; gap: 4px; }
        .bar-bg {
            flex: 1;
            height: 5px;
            background: var(--vscode-progressBar-background, rgba(128,128,128,0.2));
            border-radius: 3px;
            overflow: hidden;
            min-width: 14px;
        }
        .bar-fill { height: 5px; border-radius: 3px; }
        .bar-fill.own    { background: #c0392b; }
        .bar-fill.total  { background: #e67e22; }
        .bar-fill.contrib { background: #3794ff; }
        .pct {
            width: 40px;
            text-align: right;
            font-variant-numeric: tabular-nums;
            font-family: var(--vscode-editor-font-family, monospace);
            flex-shrink: 0;
            font-size: 11px;
        }
        .func { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
        .mod  { color: var(--vscode-descriptionForeground); font-size: 11px; }
        .caller-row > td {
            font-size: 11px;
            border-bottom-color: transparent;
        }
        /* depth guide lines: left border on the func cell steps in per level */
        .caller-row .func {
            border-left: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
            font-size: 11px;
        }
        .caller-row .pct { font-size: 10px; width: 36px; }
        .empty {
            padding: 24px 16px;
            color: var(--vscode-descriptionForeground);
            text-align: center;
            font-style: italic;
        }
    </style>
</head>
<body>
    <div id="empty" class="empty">No profiling data loaded.</div>
    <table id="table" style="display:none">
        <colgroup>
            <col class="own">
            <col class="total">
            <col class="func">
            <col class="mod">
        </colgroup>
        <thead>
            <tr>
                <th data-col="own" class="desc">Own</th>
                <th data-col="total">Total</th>
                <th data-col="scope">Function</th>
                <th data-col="module">Module</th>
            </tr>
        </thead>
        <tbody id="tbody"></tbody>
    </table>
    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
