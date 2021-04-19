import * as vscode from 'vscode';
import { dirname, join } from 'path';
// import { createFlameGraphPanel } from './flamegraph';
import { aggregateByLine } from './model';


let decorators: vscode.TextEditorDecorationType[] = [];


export function clearDecorations() {
    decorators.forEach((ld) => ld.dispose());
    decorators = [];
}

function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


export function setLineHeat(line: number, own: number, total: number, overallTotal: number) {
    const ownp = (own * 100 / overallTotal).toFixed(2);
    const totalp = (total * 100 / overallTotal).toFixed(2);
    const editor = vscode.window.activeTextEditor;
    if (editor !== undefined) {
        const color: string = `rgba(192, 64, 64, ${own / overallTotal})`;
        const lineDecorator = vscode.window.createTextEditorDecorationType({
            backgroundColor: color,
            after: {
                contentText: `    own: ${ownp}%, total: ${totalp}%`,
                color: "rgba(128,128,128,0.7)",
                margin: "8px"
            },
            overviewRulerColor: color,
            overviewRulerLane: 1
        });
        editor.setDecorations(lineDecorator, [new vscode.Range(
            editor.document.lineAt(line - 1).range.start,
            editor.document.lineAt(line - 1).range.end
        )]);
        decorators.push(lineDecorator);
    }
}


export async function profile() {
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
            terminal.sendText(`${austinPath} -i 50ms -o ${outputFile} ${interpreter} ${currentUri.fsPath}` + "; exit $LastExitCode");

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
                    });
                });
            }
        }
        else {
            vscode.window.showErrorMessage("Please save the file to disk first!");
        }
    }
}