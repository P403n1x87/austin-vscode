import * as vscode from 'vscode';
import { dirname, join } from 'path';
import { setLineHeat, clearDecorations } from './view';
import { aggregateByLine, makeHierarchy } from './model';



function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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

        this._setWelcomeHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(data => {
            const source = data.source;
            const module = data.file;
            const minLine = data.lines ? Math.min(...data.lines) : 0;
            const line = Math.max(minLine - 4, 1);
            if (!source || !module) {
                return;
            }
            aggregateByLine(source, (stats, overallTotal) => {
                vscode.workspace.openTextDocument(module).then((doc) => {
                    vscode.window.showTextDocument(doc, vscode.ViewColumn.One, false).then((editor) => {
                        clearDecorations();
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
        });

        webviewView.show(true);
    }

    public async profileScript() {
        if (this._view) {
            const pythonExtension = vscode.extensions.getExtension("ms-python.python");
            // TODO: Check that extension is loaded and active
            if (pythonExtension !== undefined) {
                pythonExtension.exports.settings.getExecutionDetails();
                const interpreter: string = pythonExtension.exports.settings.getExecutionDetails().execCommand[0];
                // vscode.window.showInformationMessage("Selected Python interpreter: " + interpreter);

                const currentUri = vscode.window.activeTextEditor?.document.uri;
                if (currentUri?.scheme === "file") {
                    const outputFile = join(dirname(currentUri.fsPath), ".austin-vscode");

                    // vscode.window.showInformationMessage("Profiling " + currentUri.fsPath);
                    const terminal = vscode.window.createTerminal("Austin");
                    terminal.show();
                    const config = vscode.workspace.getConfiguration('austin');
                    const austinPath = config.get("path") || "austin";
                    const austinInterval: number = parseInt(config.get("interval") || "100");
                    terminal.sendText(`${austinPath} -i ${austinInterval} -o ${outputFile} ${interpreter} ${currentUri.fsPath}` + "; exit $LastExitCode");

                    while (terminal.exitStatus === undefined) {
                        await delay(1);
                    }

                    const exitCode = terminal.exitStatus.code;
                    if (exitCode !== 0) {
                        vscode.window.showErrorMessage("Austin terminated with code " + exitCode?.toString());
                    }
                    else {
                        vscode.window.showInformationMessage("Austin has finished profiling.");
                        clearDecorations();
                        aggregateByLine(outputFile, (stats, overallTotal) => {
                            const lines = stats.get(currentUri.fsPath);
                            lines?.forEach((v, k) => {
                                let own: number, total: number;
                                [own, total] = v;
                                setLineHeat(k, own, total, overallTotal);
                                makeHierarchy(outputFile, (data) => {
                                    if (this._view) {
                                        this._setFlameGraphHtml(this._view.webview);
                                        this._view.show?.();
                                        this._view.webview.postMessage(data);
                                    }
                                });
                            });
                        });
                    }

                    return outputFile;
                }
                else {
                    vscode.window.showErrorMessage("Please save the file to disk first!");
                }
            }
        }
    }

    public openSampleFile() {
        if (this._view) {
            vscode.window.showOpenDialog({
                "canSelectFiles": true,
                "canSelectMany": false,
                "title": "Pick an Austin samples file",
                "filters": {
                    "Austin files": ["austin", "aprof"],
                    "All files": ["*"]
                }
            }).then((uris) => {
                if (uris) {
                    const currentUri = uris[0];
                    if (currentUri?.scheme === "file") {
                        const outputFile = currentUri.fsPath;
                        makeHierarchy(outputFile, (data) => {
                            if (this._view) {
                                this._setFlameGraphHtml(this._view.webview);
                                this._view.show?.(true);
                                this._view.webview.postMessage(data);
                            }
                        });
                    }
                }
            });
        }

    }

    private _setFlameGraphHtml(webview: vscode.Webview) {
        // Use a nonce to only allow a specific script to be run.
        const nonce = getNonce();

        const d3ScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'd3', 'dist', 'd3.js'));
        const d3FlameGraphScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'd3-flame-graph', 'dist', 'd3-flamegraph.js'));
        const d3FlameGraphCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'd3-flame-graph', 'dist', 'd3-flamegraph.css'));
        const flameGraphScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'flamegraph.js'));
        const austinCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'austin.css'));

        webview.html = `<!DOCTYPE html>
			<html lang="en">
            <head>
                <link rel="stylesheet" type="text/css" href="${d3FlameGraphCssUri}">
                <link rel="stylesheet" type="text/css" href="${austinCssUri}">
            </head>
            <body>
                <div id="chart"></div>

                <script type="text/javascript" src="${d3ScriptUri}"></script>
                <script type="text/javascript" src="${d3FlameGraphScriptUri}"></script>
                <script type="text/javascript" src="${flameGraphScriptUri}"></script>
            </body>
			</html>`;
    }

    private _setWelcomeHtml(webview: vscode.Webview) {
        const austinCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'austin.css'));

        webview.html = `<!DOCTYPE html>
			<html lang="en">
            <head>
                <link rel="stylesheet" type="text/css" href="${austinCssUri}">
            </head>
            <body>
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