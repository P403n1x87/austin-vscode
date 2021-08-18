import * as vscode from 'vscode';
import { dirname, join } from 'path';
import { clearDecorations, setLinesHeat } from './view';
import { absolutePath, AustinStats } from './model';
import { getAustinCommand } from './utils/commandFactory';


function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


export class AustinController {

    public constructor(private stats: AustinStats, private output: vscode.OutputChannel) { }

    public async profileScript() {
        const currentUri = vscode.window.activeTextEditor?.document.uri;

        if (currentUri?.scheme === "file") {
            const outputFile = join(dirname(currentUri.fsPath), ".austin-vscode");

            const terminal = vscode.window.createTerminal({name: "Austin", hideFromUser: false});
            const commandToRun = getAustinCommand(outputFile, currentUri.fsPath);
            terminal.show();
            terminal.sendText(commandToRun + "; exit $LastExitCode");
            this.output.appendLine("Running austin");
            this.output.appendLine(commandToRun);
            while (terminal.exitStatus === undefined) {
                await delay(1);
            }

            const exitCode = terminal.exitStatus.code;
            this.output.appendLine(`Command returned ${terminal.exitStatus.code}`);
            if (exitCode !== 0) {
                vscode.window.showErrorMessage("Austin terminated with code " + exitCode?.toString());
            }
            else {
                clearDecorations();
                this.stats.readFromFile(outputFile);
            }

            return outputFile;
        }
        else {
            vscode.window.showErrorMessage("Please save the file to disk first!");
        }
    }



    public openSampleFile() {
        vscode.window.showOpenDialog({
            "canSelectFiles": true,
            "canSelectMany": false,
            "title": "Pick an Austin samples file",
            "filters": {
                // eslint-disable-next-line @typescript-eslint/naming-convention
                "Austin files": ["austin", "aprof"],
                // eslint-disable-next-line @typescript-eslint/naming-convention
                "All files": ["*"]
            }
        }).then((uris) => {
            if (uris) {
                const currentUri = uris[0];
                if (currentUri?.scheme === "file") {
                    const austinFile = currentUri.fsPath;
                    this.stats.readFromFile(austinFile);
                }
            }
        });
    }

    public openSourceFileAtLine(module: string, line: number) {
        vscode.workspace.openTextDocument(absolutePath(module)).then((doc) => {
            vscode.window.showTextDocument(doc, vscode.ViewColumn.One, false).then((editor) => {
                clearDecorations();
                editor?.revealRange(new vscode.Range(
                    editor.document.lineAt(line - 1).range.start,
                    editor.document.lineAt(line - 1).range.end
                ));
                const lines = this.stats.lineMap.get(module);
                if (lines) {
                    setLinesHeat(lines, this.stats.overallTotal);
                }
            });
        });
    }
}
