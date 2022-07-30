import * as vscode from 'vscode';
import { clearDecorations, setLinesHeat } from './view';
import { absolutePath, AustinStats } from './model';
import { isPythonExtensionAvailable } from './utils/pythonExtension';
import { AustinProfileTaskProvider } from './providers/task';


export class AustinController {
    public constructor(
        private stats: AustinStats,
        private provider: AustinProfileTaskProvider,
        private output: vscode.OutputChannel,
    ) { }

    public async profileScript() {
        const currentUri = vscode.window.activeTextEditor?.document.uri;
        if (!isPythonExtensionAvailable()) {
            throw Error("Python extension not available");
        }
        if (currentUri?.scheme === "file") {
            let task = this.provider.buildTaskFromUri(currentUri);
            await vscode.tasks.executeTask(task);
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
                "Austin files": ["austin", "aprof", "mojo"],
                // eslint-disable-next-line @typescript-eslint/naming-convention
                "All files": ["*"]
            }
        }).then((uris) => {
            if (uris) {
                this.output.appendLine(`Loading ${uris[0].fsPath}`);
                const currentUri = uris[0];
                if (currentUri?.scheme === "file") {
                    const austinFile = currentUri.fsPath;
                    this.output.appendLine(`Loading Austin File ${austinFile}`);
                    this.stats.readFromFile(austinFile);
                }
                this.output.appendLine(`Completed Loading Austin File.`);
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
