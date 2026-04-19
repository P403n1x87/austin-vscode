import * as vscode from 'vscode';
import { AustinStats } from '../model';
import { loadWebviewHtml } from '../utils/webviewHtml';

export class MetadataViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'austin-vscode.metadata';

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
        const entries: { key: string; value: string; kind?: string; parsed?: unknown }[] = [];
        for (const [key, value] of stats.metadata) {
            entries.push({ key, value, ...MetadataViewProvider._parseEntry(key, value) });
        }

        if (entries.length === 0) {
            this._view!.webview.postMessage({ noData: true });
            return;
        }

        this._view!.webview.postMessage({ entries });
    }

    /** Parse well-known metadata values into structured form. */
    static _parseEntry(key: string, value: string): { kind?: string; parsed?: unknown } {
        if (key === 'mode') {
            const labels: Record<string, string> = {
                wall: 'Wall time',
                cpu: 'CPU time',
                memory: 'Memory',
                full: 'Full metrics',
            };
            if (value in labels) {
                return { kind: 'mode', parsed: { display: labels[value] } };
            }
        }
        if (key === 'sampling') {
            const parts = value.split(',');
            if (parts.length === 3) {
                const [min, avg, max] = parts.map(Number);
                if ([min, avg, max].every(n => !isNaN(n))) {
                    const fmt = MetadataViewProvider._formatMicroseconds;
                    return { kind: 'sampling', parsed: { min: fmt(min), avg: fmt(avg), max: fmt(max) } };
                }
            }
        }
        if (key === 'interval' || key === 'duration') {
            const us = Number(value);
            if (!isNaN(us) && us >= 0) {
                const display = MetadataViewProvider._formatMicroseconds(us);
                if (key === 'duration') {
                    return { kind: 'duration', parsed: { us, display } };
                }
                const hz = us > 0 ? 1_000_000 / us : 0;
                let hzDisplay: string;
                if (hz >= 1_000_000) {
                    hzDisplay = `${+(hz / 1_000_000).toPrecision(4)} MHz`;
                } else if (hz >= 1_000) {
                    hzDisplay = `${+(hz / 1_000).toPrecision(4)} kHz`;
                } else {
                    hzDisplay = `${+hz.toPrecision(4)} Hz`;
                }
                return { kind: 'interval', parsed: { us, display, hzDisplay } };
            }
        }
        if (key === 'saturation' || key === 'errors') {
            const m = value.match(/^(\d+)\/(\d+)$/);
            if (m) {
                const n = Number(m[1]);
                const count = Number(m[2]);
                const pct = count > 0 ? (n / count) * 100 : 0;
                return { kind: 'fraction', parsed: { n, count, pct } };
            }
        }
        return {};
    }

    static _formatMicroseconds(us: number): string {
        if (us >= 1_000_000) {
            return `${+(us / 1_000_000).toPrecision(4)} s`;
        } else if (us >= 1_000) {
            return `${+(us / 1_000).toPrecision(4)} ms`;
        }
        return `${us} µs`;
    }

    private _getHtml(webview: vscode.Webview, stats: AustinStats | null): string {
        const hasData = stats !== null && stats.metadata.size > 0;
        return loadWebviewHtml(this._extensionUri, 'metadata.html', {
            scriptUri:          String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'metadata.js'))),
            codiconsUri:        String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css'))),
            viewsCssUri:        String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'views.css'))),
            cssUri:             String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'metadata.css'))),
            initMsg:            !stats ? 'No profiling data loaded.' : hasData ? '' : 'No metadata available in this profile.',
            initActionsDisplay: stats ? 'none' : '',
        });
    }

}
