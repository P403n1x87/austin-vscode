import * as vscode from 'vscode';
import { AustinStats, TopStats } from '../model';
import { loadWebviewHtml } from '../utils/webviewHtml';

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
            if (data === 'open') {
                vscode.commands.executeCommand('austin-vscode.load');
                return;
            }
            if (data === 'attach') {
                vscode.commands.executeCommand('austin-vscode.attach');
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
        return loadWebviewHtml(this._extensionUri, 'top.html', {
            scriptUri:   String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'top.js'))),
            codiconsUri: String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'codicons', 'codicon.css'))),
            viewsCssUri: String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'views.css'))),
            cssUri:      String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'top.css'))),
        });
    }

}
