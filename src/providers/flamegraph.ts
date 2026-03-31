import * as vscode from 'vscode';
import { setLinesHeat } from '../view';
import { AustinStats } from '../model';



export class FlameGraphViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'austin-vscode.flame-graph';

    private _view?: vscode.WebviewView;
    private _source: string | null = null;
    private _lines: boolean = false;
    private _stats: AustinStats | null = null;
    private _initialized: boolean = false;
    private _onFrameSelected?: (pathKey: string) => void;

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
                return;
            }

            if (data === "open") {
                vscode.commands.executeCommand('austin-vscode.load');
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
                if (this._onFrameSelected && data.pathKey) {
                    this._onFrameSelected(data.pathKey);
                }
            }
        });

        this._stats ? this._setFlameGraphHtml() : this._setWelcomeHtml();

        webviewView.show(true);
    }

    public onFrameSelected(cb: (pathKey: string) => void) {
        this._onFrameSelected = cb;
    }

    public search(term: string) {
        this._view?.webview.postMessage({ search: term });
    }

    public focusFrame(pathKey: string) {
        this._view?.webview.postMessage({ focus: pathKey });
    }

    public refresh(stats: AustinStats) {
        this._stats = stats;
        if (this._view) {
            this._setFlameGraphHtml();
            this._view.show?.(true);

            if (this._initialized) {
                this._view.webview.postMessage({
                    "meta": { "mode": stats.metadata.get("mode") },
                    "hierarchy": stats.hierarchy,
                });
            }
            // this._source = austinFile;
        }
        const currentUri = vscode.window.activeTextEditor?.document.uri;
        if (currentUri?.scheme === "file") {
            const lines = stats.locationMap.get(currentUri.fsPath);
            if (lines) {
                setLinesHeat(lines, stats);
            }
        }
    }

    private _setFlameGraphHtml() {
        if (this._view === undefined || this._view.webview === undefined) {
            return;
        }
        const webview = this._view.webview;

        const d3ScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'd3', 'dist', 'd3.js'));
        const d3FlameGraphScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'd3-flame-graph', 'dist', 'd3-flamegraph.js'));
        const d3FlameGraphCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'd3-flame-graph', 'dist', 'd3-flamegraph.css'));
        const flameGraphScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'flamegraph.js'));
        const austinCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'austin.css'));
        const austinLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'austin-light.svg'));

        webview.html = `<!DOCTYPE html>
			<html lang="en">
            <head>
                <link rel="stylesheet" type="text/css" href="${d3FlameGraphCssUri}">
                <link rel="stylesheet" type="text/css" href="${austinCssUri}">
            </head>
            <body class="logo">
                <div id="header"><img src="${austinLogoUri}" /><span class="vc" id="mode"></span><input id="search-box" type="text" placeholder="Search…" /><button id="header-open" onclick="onOpen()">Open</button></div>
                <div id="chart"></div>
                <div id="footer"></div>

                <script type="text/javascript" src="${d3ScriptUri}"></script>
                <script type="text/javascript" src="${d3FlameGraphScriptUri}"></script>
                <script type="text/javascript" src="${flameGraphScriptUri}"></script>
            </body>
			</html>`;
    }

    public showLoading() {
        if (this._view === undefined || this._view.webview === undefined) {
            return;
        }
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

    private _setWelcomeHtml() {
        if (this._view === undefined || this._view.webview === undefined) {
            return;
        }
        const webview = this._view.webview;
        const austinCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'austin.css'));
        const austinLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'austin.svg'));

        webview.html = `<!DOCTYPE html>
			<html lang="en">
            <head>
                <link rel="stylesheet" type="text/css" href="${austinCssUri}">
            </head>
            <body>
                <div class="box">
                    <div><img src="${austinLogoUri}" alt="Austin logo" width="192px" /></div>
                    <div class="center"><button onclick="onOpen()">OPEN</button></div>
                </div>

                <script>
                const vscode = acquireVsCodeApi();
                
                function onOpen() {
                    vscode.postMessage("open");;
                }
                </script>
            </body>
			</html>`;
    }
}
