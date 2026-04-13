import * as vscode from 'vscode';
import { AustinStats } from '../model';
import { loadWebviewHtml } from '../utils/webviewHtml';

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
        return loadWebviewHtml(this._extensionUri, 'gctop.html', {
            scriptUri:           String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'gctop.js'))),
            codiconsUri:         String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css'))),
            viewsCssUri:         String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'views.css'))),
            cssUri:              String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'gctop.css'))),
            initMsg:             !hasData ? 'No profiling data loaded.' : hasGC ? '' : 'No GC data available in this profile. Enable GC collection with the GC toggle in the status bar.',
            initActionsDisplay:  hasData ? 'none' : '',
        });
    }

}
