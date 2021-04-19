import * as vscode from 'vscode';
import * as fs from 'fs';
import { dirname, join } from 'path';
import { profile, setLineHeat, clearDecorations } from './profile';
import { aggregateByLine, makeHierarchy } from './model';

// export function createFlameGraphPanel() {
//     const flameGraphPanel = vscode.window.createWebviewPanel(
//         "flameGraph",
//         "Flame Graph",
//         vscode.ViewColumn.Beside,
//         { enableScripts: true },
//     );

//     const extensionPath = vscode.extensions.getExtension('undefined_publisher.austin-vscode')?.extensionPath;
//     if (extensionPath) {
//         fs.readFile(path.join(extensionPath, 'resources', 'flamegraph.html'), (err, data) => {
//             if (err) { console.error(err); }
//             flameGraphPanel.webview.html = data.toString();
//         });
//     }
// }

export class FlameGraphViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'austin-vscode.flameGraph';

    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
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

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(data => {
            const source = data.source;
            const module = data.file;
            const minLine = data.lines ? Math.min(...data.lines) : 0;
            const line = Math.max(minLine - 4, 1);
            if (!source || !module) {
                return;
            }
            aggregateByLine(source, (stats, overallTotal) => {
                vscode.workspace.openTextDocument(module).then((value) => {
                    clearDecorations();
                    const editor = vscode.window.activeTextEditor;
                    editor?.revealRange(new vscode.Range(
                        editor.document.lineAt(line - 1).range.start,
                        editor.document.lineAt(line - 1).range.end
                    ));
                    const lines = stats.get(module);
                    lines?.forEach((v, k) => {
                        let own: number, total: number;
                        [own, total] = v;
                        setLineHeat(k, own, total, overallTotal);
                    });
                });
            });
        });
    }

    public profileScript() {
        if (this._view) {
            this._view.show?.(true); // `show` is not implemented in 1.49 but is for 1.50 insiders
            profile().then((_) => this.loadSamples());
        }
    }

    private postData(data: any) {
        if (this._view) {
            this._view.webview.postMessage(data);
        }
    }

    public loadSamples() {
        if (this._view) {
            this._view.show?.(true);
            const currentUri = vscode.window.activeTextEditor?.document.uri;
            if (currentUri?.scheme === "file") {
                const outputFile = join(dirname(currentUri.fsPath), ".austin-vscode");
                makeHierarchy(outputFile, (data) => { this.postData(data); });
            }
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        // Get the local path to main script run in the webview, then convert it to a uri we can use in the webview.
        // const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));

        // Do the same for the stylesheet.
        // const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css'));
        // const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css'));
        // const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));

        // Use a nonce to only allow a specific script to be run.
        const nonce = getNonce();

        const d3ScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'd3', 'dist', 'd3.js'));
        const d3FlameGraphScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'd3-flame-graph', 'dist', 'd3-flamegraph.js'));
        const d3FlameGraphCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'd3-flame-graph', 'dist', 'd3-flamegraph.css'));
        const flameGraphScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'flamegraph.js'));

        return `<!DOCTYPE html>
			<html lang="en">
            <head>
                <link rel="stylesheet" type="text/css" href="${d3FlameGraphCssUri}">
            </head>
            <body onresize="onresize()">
                <div id="chart"></div>

                <script type="text/javascript" src="${d3ScriptUri}"></script>
                <script type="text/javascript" src="${d3FlameGraphScriptUri}"></script>
                <script type="text/javascript">
                const vscode = acquireVsCodeApi();

                var flameGraph = flamegraph()
                    .width(document.getElementById('chart').offsetWidth)
                    .transitionDuration(250)
                    .minFrameSize(0)
                    .transitionEase(d3.easeCubic)
                    .inverted(true)
            
                flameGraph.setWidth = function (width) {
                    flameGraph.width(width);
                    d3.select("#chart svg").style("width", width);
                    flameGraph.resetZoom();
                }

                var stringToColour = function(str) {
                    var hash = 0;
                    for (var i = 0; i < str.length; i++) {
                      hash = str.charCodeAt(i) + ((hash << 5) - hash);
                    }
                    var colour = '#';
                    for (var i = 0; i < 3; i++) {
                      var value = (hash >> (i * 8)) & 0xFF;
                      colour += ('00' + value.toString(16)).substr(-2);
                    }
                    return colour;
                  }


                flameGraph.setColorMapper(function(d, originalColor) {
                    return d.highlight ? "#E600E6" : stringToColour(d.data.name);
                });

                flameGraph.onClick(function (d) {
                    console.info("You clicked on frame " + JSON.stringify(d.data.data));
                    vscode.postMessage(d.data.data);
                });

                data = vscode.getState() || {
                    "name": "root",
                    "value": 0,
                    "children": []
                };

                d3.select("#chart")
                    .datum(data)
                    .call(flameGraph)
                
                function onresize() {
                    flameGraph.setWidth(document.getElementById('chart').offsetWidth);
                }

                window.addEventListener('message', event => {
                    const message = event.data; // The json data that the extension sent
                    flameGraph.update(message);
                    vscode.setState(message);
                });

                </script>
            </body>
			</html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}