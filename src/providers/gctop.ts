import * as vscode from 'vscode';
import { AustinStats } from '../model';

interface GCThreadSummary {
    pid: number;
    tid: string;
    gcFraction: number;
}

interface GCFrameItem {
    key: string;
    scope: string;
    module: string;
    line: number;
    gcOwn: number;   // fraction of overallTotal
    gcTotal: number; // fraction of overallTotal
}

export class GCTopViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'austin-vscode.gctop';

    private _view?: vscode.WebviewView;
    private _stats: AustinStats | null = null;
    private _initialized: boolean = false;
    private _onThreadSelected?: (threadKey: string) => void;

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) { }

    public onThreadSelected(cb: (threadKey: string) => void) {
        this._onThreadSelected = cb;
    }

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
            if (data === 'open') {
                vscode.commands.executeCommand('austin-vscode.load');
                return;
            }
            if (data === 'attach') {
                vscode.commands.executeCommand('austin-vscode.attach');
                return;
            }
            if (data.focusThread !== undefined) {
                this._onThreadSelected?.(data.focusThread);
                return;
            }
            if (data.module !== undefined) {
                vscode.commands.executeCommand('austin-vscode.openSourceAtLine', data.module, data.line || 0);
            }
        });

        webviewView.webview.html = this._getHtml(webviewView.webview, this._stats);
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

    private _postData(stats: AustinStats) {
        if (!stats.gcEvents.length) {
            this._view!.webview.postMessage({ noGC: true });
            return;
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

        const threads: GCThreadSummary[] = [...threadMap.values()]
            .filter(t => t.gcMetric > 0)
            .map(t => ({
                pid: t.pid,
                tid: t.tid,
                gcFraction: t.gcMetric / t.totalMetric,
            }))
            .sort((a, b) => b.gcFraction - a.gcFraction);

        if (threads.length === 0) {
            this._view!.webview.postMessage({ noGC: true });
            return;
        }

        const denom = stats.overallTotal || 1;

        const topFrames: GCFrameItem[] = [...frameAll.entries()]
            .map(([key, totalMetric]) => {
                const topStats = stats.top.get(key);
                // Safely split key into module + scope: module is everything up to the
                // last ':', scope is what follows (Python names won't contain '/').
                const lastColon = key.lastIndexOf(':');
                return {
                    key,
                    scope: topStats?.scope ?? (lastColon >= 0 ? key.slice(lastColon + 1) : key),
                    module: topStats?.module ?? (lastColon >= 0 ? key.slice(0, lastColon) : ''),
                    line: topStats?.minLine ?? 0,
                    gcOwn: (frameOwn.get(key) ?? 0) / denom,
                    gcTotal: totalMetric / denom,
                };
            })
            .sort((a, b) => b.gcOwn - a.gcOwn);

        this._view!.webview.postMessage({ threads, topFrames });
    }

    private _getHtml(webview: vscode.Webview, stats: AustinStats | null): string {
        const hasData = stats !== null;
        const hasGC   = hasData && stats.gcEvents.some(e => e.gc);
        const initMsg = !hasData
            ? 'No profiling data loaded.'
            : hasGC
                ? ''   // will be replaced by _postData immediately
                : 'No GC data available in this profile. Enable GC collection with the GC toggle in the status bar.';
        const initActionsDisplay = hasData ? 'none' : '';
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'gctop.js')
        );
        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" type="text/css" href="${codiconsUri}">
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
            white-space: nowrap;
        }
        th[data-col] { cursor: pointer; user-select: none; }
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
        .frame-row > td { cursor: pointer; }
        .frame-row:hover > td { background: var(--vscode-list-hoverBackground); }
        col.func { width: 100%; }
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
        }
        /* Thread summary section */
        #thread-summary {
            padding: 6px 8px 4px 8px;
            border-bottom: 1px solid var(--vscode-panel-border, #444);
        }
        .thread-row {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-bottom: 4px;
            cursor: pointer;
            border-radius: 3px;
            padding: 1px 2px;
        }
        .thread-row:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .thread-label {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            flex-shrink: 0;
            width: 110px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .thread-bar-bg {
            flex: 1;
            height: 6px;
            background: rgba(128,128,128,0.15);
            border-radius: 3px;
            overflow: hidden;
        }
        .thread-bar-fill {
            height: 6px;
            border-radius: 3px;
            background: var(--vscode-descriptionForeground);
            opacity: 0.4;
        }
        .thread-bar-fill[style] { opacity: 1; }
        .thread-pct {
            font-size: 0.85em;
            font-variant-numeric: tabular-nums;
            font-family: var(--vscode-editor-font-family, monospace);
            flex-shrink: 0;
            width: 38px;
            text-align: right;
        }
        /* Toolbar */
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
        .open-btn {
            display: inline-block;
            padding: 4px 14px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 0.06em;
        }
        .open-btn:hover { background: var(--vscode-button-hoverBackground); }
        .empty-actions {
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            margin-top: 10px;
            gap: 4px;
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
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                    <line x1="1.5" y1="1.5" x2="8.5" y2="8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                    <line x1="8.5" y1="1.5" x2="1.5" y2="8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
            </button>
        </div>
        <span id="live-dot" title="Live session active"></span>
    </div>
    <div id="empty" class="empty">
        <div id="empty-msg">${initMsg}</div>
        <div id="empty-actions" class="empty-actions" style="display:${initActionsDisplay}">
            <button class="open-btn" id="open-btn">OPEN</button>
            <button class="open-btn" id="attach-btn">ATTACH</button>
        </div>
    </div>
    <div id="content" style="display:none">
        <div id="thread-summary"></div>
        <table id="table">
            <colgroup>
                <col class="own">
                <col class="total">
                <col class="func">
            </colgroup>
            <thead>
                <tr>
                    <th data-col="gcOwn" class="desc">Own GC</th>
                    <th data-col="gcTotal">Total GC</th>
                    <th data-col="scope">Scope</th>
                </tr>
            </thead>
            <tbody id="tbody"></tbody>
        </table>
    </div>
    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
