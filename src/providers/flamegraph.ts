import * as vscode from 'vscode';
import { AustinStats } from '../model';
import { generateInteractiveSVG } from '../flamegraph-svg';

export interface GCTopFrame {
    scope: string;
    module: string;
    fraction: number;  // metric / span duration
}

export interface GCSpan {
    startFraction: number;    // startMetric / threadTotalMetric
    durationFraction: number; // duration    / threadTotalMetric
    durationPct: string;      // pre-formatted "X.Y"
    topFrames: GCTopFrame[];
}

export interface GCThreadSpans {
    label: string;     // "P{pid} T{tid}"
    threadKey: string;
    spans: GCSpan[];
}

export const GC_MIN_FRACTION = 0.001; // drop spans < 0.1% of thread timeline

export function computeGCSpans(stats: AustinStats): GCThreadSpans[] {
    // Group events by thread, preserving temporal order
    const threadEvents = new Map<string, typeof stats.gcEvents>();
    for (const ev of stats.gcEvents) {
        const key = `${ev.pid}:${ev.tid}`;
        if (!threadEvents.has(key)) { threadEvents.set(key, []); }
        threadEvents.get(key)!.push(ev);
    }

    const result: GCThreadSpans[] = [];

    for (const [threadKey, evs] of threadEvents) {
        const rawSpans: { startMetric: number; duration: number; frameCount: Map<string, number> }[] = [];
        let totalMetric = 0;
        let spanActive = false;
        let spanStart = 0;
        let spanDuration = 0;
        let frameCount = new Map<string, number>();

        const closeSpan = () => {
            rawSpans.push({ startMetric: spanStart, duration: spanDuration, frameCount });
            spanActive = false;
        };

        for (const ev of evs) {
            if (ev.metric <= 0) { continue; }
            if (ev.gc) {
                if (!spanActive) {
                    spanActive = true;
                    spanStart = totalMetric;
                    spanDuration = 0;
                    frameCount = new Map();
                }
                spanDuration += ev.metric;
                // Only attribute to the leaf (innermost) frame so fractions are
                // mutually exclusive and sum to ≤ 100% across top contributors.
                const leaf = ev.frameKeys.length > 0 ? ev.frameKeys[ev.frameKeys.length - 1] : null;
                if (leaf) {
                    frameCount.set(leaf, (frameCount.get(leaf) ?? 0) + ev.metric);
                }
            } else {
                if (spanActive) { closeSpan(); }
            }
            totalMetric += ev.metric;
        }
        if (spanActive) { closeSpan(); }

        if (totalMetric === 0) { continue; }

        const spans: GCSpan[] = rawSpans
            .filter(s => s.duration / totalMetric >= GC_MIN_FRACTION)
            .map(s => {
                const topFrames: GCTopFrame[] = [...s.frameCount.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 3)
                    .map(([key, metric]) => {
                        const topStats = stats.top.get(key);
                        const lastColon = key.lastIndexOf(':');
                        return {
                            scope: topStats?.scope ?? (lastColon >= 0 ? key.slice(lastColon + 1) : key),
                            module: topStats?.module ?? (lastColon >= 0 ? key.slice(0, lastColon) : ''),
                            fraction: s.duration > 0 ? metric / s.duration : 0,
                        };
                    });
                return {
                    startFraction: s.startMetric / totalMetric,
                    durationFraction: s.duration / totalMetric,
                    durationPct: (s.duration / totalMetric * 100).toFixed(1),
                    topFrames,
                };
            });

        if (spans.length === 0) { continue; }

        const parts = threadKey.split(':');
        result.push({
            label: `P${parts[0]} T${parts.slice(1).join(':')}`,
            threadKey,
            spans,
        });
    }

    return result;
}



export class FlameGraphViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'austin-vscode.flame-graph';

    private _view?: vscode.WebviewView;
    private _source: string | null = null;
    private _lines: boolean = false;
    private _stats: AustinStats | null = null;
    private _initialized: boolean = false;
    private _onFrameSelected?: (frameKey: number) => void;
    private _sessionActive: boolean = false;
    private _isAttach: boolean = false;
    private _flameHtmlSet: boolean = false;

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) {
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        this._initialized = false;
        this._flameHtmlSet = false;

        webviewView.webview.options = {
            // Allow scripts in the webview
            enableScripts: true,

            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.onDidReceiveMessage(data => {
            if (data === "initialized") {
                this._initialized = true;
                if (this._stats) {
                    this.refresh(this._stats);
                }
                // Sync live/button state in case it changed while the webview was (re)loading
                if (this._sessionActive) {
                    this._view?.webview.postMessage(this._isAttach ? 'showDetach' : 'showTerminate');
                } else {
                    this._view?.webview.postMessage('showOpen');
                }
                return;
            }

            if (data === "open") {
                vscode.commands.executeCommand('austin-vscode.load');
                return;
            }

            if (data === "attach") {
                vscode.commands.executeCommand('austin-vscode.attach');
                return;
            }

            if (data === "run") {
                vscode.commands.executeCommand('austin-vscode.profile');
                return;
            }

            if (data === "detach") {
                vscode.commands.executeCommand('austin-vscode.detach');
                return;
            }

            if (data === "share") {
                this._exportSVG();
                return;
            }

            const webview = webviewView.webview;
            if (data.event === "keydown") {
                switch (data.name) {
                    case "f":
                        vscode.window.showInputBox({
                            "prompt": "Search frames",
                        }).then((value) => {
                            if (value) {
                                webview.postMessage({ "search": value });
                            }
                        });
                        break;

                    case "l":
                        this._lines = !this._lines;
                        if (this._source) {
                            this.refresh(this._stats!);
                        }
                        break;

                    case "o":
                        vscode.commands.executeCommand('austin-vscode.load');
                        break;

                    case "r":
                        webview.postMessage("reset");
                }
                return;
            }

            const source = data.source;
            const module = data.file;
            if (source && module) {
                vscode.commands.executeCommand('austin-vscode.openSourceAtLine', module, data.line || 0);
                if (this._onFrameSelected && data.frameKey !== undefined) {
                    this._onFrameSelected(data.frameKey);
                }
            }
        });

        this._stats ? this._setFlameGraphHtml() : this._setWelcomeHtml();

        webviewView.show(true);
    }

    public onFrameSelected(cb: (frameKey: number) => void) {
        this._onFrameSelected = cb;
    }

    public search(term: string) {
        this._view?.webview.postMessage({ search: term });
    }

    public focusFrame(frameKey: number) {
        this._view?.webview.postMessage({ focus: frameKey });
    }

    public focusThread(threadKey: string) {
        this._view?.webview.postMessage({ focusThread: threadKey });
    }

    public showDetachButton(isAttach: boolean = true) {
        this._sessionActive = true;
        this._isAttach = isAttach;
        if (this._initialized) {
            this._view?.webview.postMessage(isAttach ? 'showDetach' : 'showTerminate');
        }
    }

    public showOpenButton() {
        this._sessionActive = false;
        if (this._initialized) {
            this._view?.webview.postMessage('showOpen');
        }
    }

    public refresh(stats: AustinStats) {
        this._stats = stats;
        if (this._view) {
            if (!this._flameHtmlSet) {
                this._setFlameGraphHtml();
                this._flameHtmlSet = true;
            }

            if (this._initialized) {
                this._view.webview.postMessage({
                    "meta": { "mode": stats.metadata.get("mode") },
                    "hierarchy": stats.hierarchy,
                    "gcSpans": computeGCSpans(stats),
                });
            }
        }
    }

    private _setFlameGraphHtml() {
        if (this._view === undefined || this._view.webview === undefined) {
            return;
        }
        const webview = this._view.webview;

        const flameGraphUtilsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'flamegraph-utils.js'));
        const flameGraphScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'flamegraph.js'));
        const austinCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'austin.css'));
        const austinLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'austin-light.svg'));

        const btnText = this._sessionActive ? (this._isAttach ? 'Detach' : 'Terminate') : 'Open';
        const btnOnclick = this._sessionActive ? 'onDetach()' : 'onOpen()';
        const liveClass = this._sessionActive ? ' live' : '';

        webview.html = `<!DOCTYPE html>
			<html lang="en">
            <head>
                <link rel="stylesheet" type="text/css" href="${austinCssUri}">
            </head>
            <body class="logo">
                <div id="header"><img id="austin-logo" class="${liveClass}" src="${austinLogoUri}" /><span class="vc" id="mode"></span><input id="search-box" type="text" placeholder="Search…" /><button id="header-share" onclick="onShare()">SHARE</button><button id="header-open" onclick="${btnOnclick}">${btnText}</button></div>
                <div id="chart">
                    <div id="gc-panel">
                        <details id="gc-details">
                            <summary id="gc-summary">GC Activity</summary>
                            <div id="gc-swimlanes"></div>
                        </details>
                    </div>
                </div>
                <div id="minimap-panel" class="hidden">
                    <div id="minimap-header">
                        <span id="minimap-title">Minimap <kbd>M</kbd></span>
                        <div id="minimap-controls">
                            <button id="minimap-snap-left" class="minimap-btn" title="Snap to left">⇤</button>
                            <button id="minimap-snap-right" class="minimap-btn" title="Snap to right">⇥</button>
                            <button id="minimap-toggle" class="minimap-btn" title="Collapse minimap (M)">▾</button>
                        </div>
                    </div>
                    <canvas id="minimap"></canvas>
                </div>
                <div id="footer"></div>

                <script type="text/javascript" src="${flameGraphUtilsUri}"></script>
                <script type="text/javascript" src="${flameGraphScriptUri}"></script>
                <script>
                function onOpen() { window.vscode.postMessage("open"); }
                function onDetach() { window.vscode.postMessage("detach"); }
                function onShare() { window.vscode.postMessage("share"); }
                window.addEventListener('message', function(e) {
                    var btn = document.getElementById('header-open');
                    var logo = document.getElementById('austin-logo');
                    if (e.data === 'showDetach') {
                        btn.textContent = 'Detach';
                        btn.onclick = onDetach;
                        logo.classList.add('live');
                    } else if (e.data === 'showTerminate') {
                        btn.textContent = 'Terminate';
                        btn.onclick = onDetach;
                        logo.classList.add('live');
                    } else if (e.data === 'showOpen') {
                        btn.textContent = 'Open';
                        btn.onclick = onOpen;
                        logo.classList.remove('live');
                    }
                });
                </script>
            </body>
			</html>`;
    }

    private async _exportSVG(): Promise<void> {
        if (!this._stats) {
            vscode.window.showInformationMessage('No flamegraph data to export. Load a profile first.');
            return;
        }
        const mode = this._stats.metadata.get('mode') || 'cpu';
        const logoBytes = await vscode.workspace.fs.readFile(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'austin-light.svg')
        );
        const logoB64 = Buffer.from(logoBytes).toString('base64');
        const svg = generateInteractiveSVG(this._stats.hierarchy, mode, logoB64);

        const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri
            ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'flamegraph.svg')
            : vscode.Uri.file('flamegraph.svg');

        const dest = await vscode.window.showSaveDialog({
            title: 'Export Flamegraph as Interactive SVG',
            defaultUri,
            filters: { 'SVG files': ['svg'] },
        });
        if (!dest) { return; }

        await vscode.workspace.fs.writeFile(dest, Buffer.from(svg, 'utf8'));

        vscode.window.showInformationMessage(
            `Flamegraph exported to ${dest.fsPath} — open in a browser for full interactivity.`
        );
    }

    public showLoading() {
        if (this._view === undefined || this._view.webview === undefined) {
            return;
        }
        this._initialized = false;
        this._flameHtmlSet = false;
        const webview = this._view.webview;
        const austinCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'austin.css'));

        webview.html = `<!DOCTYPE html>
			<html lang="en">
            <head>
                <link rel="stylesheet" type="text/css" href="${austinCssUri}">
                <style>
                    @keyframes spin { to { transform: rotate(360deg); } }
                    .spinner {
                        width: 28px; height: 28px;
                        border: 3px solid rgba(255,255,255,0.15);
                        border-top-color: rgba(255,255,255,0.7);
                        border-radius: 50%;
                        animation: spin 0.7s linear infinite;
                        margin: 0 auto 10px;
                    }
                    .loading-label { color: rgba(255,255,255,0.6); font-size: 12px; }
                </style>
            </head>
            <body>
                <div class="box">
                    <div class="spinner"></div>
                    <div class="center loading-label">Crunching the numbers…</div>
                </div>
                <script>
                const vscode = acquireVsCodeApi();
                </script>
            </body>
			</html>`;
    }

    public showError() {
        if (this._view === undefined || this._view.webview === undefined) {
            return;
        }
        this._initialized = false;
        this._flameHtmlSet = false;
        this._sessionActive = false;
        const webview = this._view.webview;
        const austinCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'austin.css'));

        webview.html = `<!DOCTYPE html>
        <html lang="en">
        <head>
            <link rel="stylesheet" type="text/css" href="${austinCssUri}">
            <style>
                .error-label { color: rgba(239,68,68,0.8); font-size: 12px; margin-top: 8px; }
            </style>
        </head>
        <body>
            <div class="box">
                <div class="center">
                    <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" fill="rgba(239,68,68,0.12)" stroke="rgba(239,68,68,0.7)" stroke-width="1.5"/>
                        <line x1="8" y1="8" x2="16" y2="16" stroke="rgba(239,68,68,0.8)" stroke-width="2" stroke-linecap="round"/>
                        <line x1="16" y1="8" x2="8" y2="16" stroke="rgba(239,68,68,0.8)" stroke-width="2" stroke-linecap="round"/>
                    </svg>
                </div>
                <div class="center error-label">Profiling failed. Check the Austin output channel for details.</div>
                <div class="center" style="margin-top:12px"><button onclick="onOpen()">OPEN</button></div>
            </div>
            <script>
            const vscode = acquireVsCodeApi();
            function onOpen() { vscode.postMessage("open"); }
            </script>
        </body>
        </html>`;
    }

    private _setWelcomeHtml() {
        if (this._view === undefined || this._view.webview === undefined) {
            return;
        }
        const webview = this._view.webview;
        const austinCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'austin.css'));
        const austinLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'austin.svg'));
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'codicons', 'codicon.css'));
        const modKey = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';

        webview.html = `<!DOCTYPE html>
			<html lang="en">
            <head>
                <link rel="stylesheet" type="text/css" href="${codiconsUri}">
                <link rel="stylesheet" type="text/css" href="${austinCssUri}">
            </head>
            <body>
                <div class="welcome">
                    <div class="welcome-left">
                        <img src="${austinLogoUri}" alt="Austin logo" width="192px" />
                    </div>
                    <div class="welcome-right">
                        <div class="welcome-title">Austin VS Code</div>
                        <div class="welcome-links">
                            <div class="welcome-item" onclick="onOpen()">
                                <span class="codicon codicon-folder-opened welcome-icon"></span>
                                <span class="welcome-link">Open</span> an existing profile
                                <span class="welcome-key"><kbd>${modKey}</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd></span>
                            </div>
                            <div class="welcome-item" onclick="onAttach()">
                                <span class="codicon codicon-plug welcome-icon"></span>
                                <span class="welcome-link">Attach</span> to a running process
                                <span class="welcome-key"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F5</kbd></span>
                            </div>
                            <div class="welcome-item" onclick="onRun()">
                                <span class="codicon codicon-play welcome-icon"></span>
                                <span class="welcome-link">Run</span> the current script
                                <span class="welcome-key"><kbd>Shift</kbd>+<kbd>F5</kbd></span>
                            </div>
                        </div>
                    </div>
                </div>

                <script>
                const vscode = acquireVsCodeApi();

                function onOpen() {
                    vscode.postMessage("open");
                }
                function onAttach() {
                    vscode.postMessage("attach");
                }
                function onRun() {
                    vscode.postMessage("run");
                }
                </script>
            </body>
			</html>`;
    }
}
