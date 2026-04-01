import * as vscode from 'vscode';
import { clearDecorations, setLinesHeat } from './view';
import { absolutePath, AustinStats } from './model';
import { isPythonExtensionAvailable } from './utils/pythonExtension';
import { AustinProfileTaskProvider } from './providers/task';
import { AustinRuntimeSettings } from './settings';
import { AustinVersionError, checkAustinVersion } from './utils/versionCheck';


export class AustinController {
    private _currentExecution: vscode.TaskExecution | undefined;

    public constructor(
        private stats: AustinStats,
        private provider: AustinProfileTaskProvider,
        private output: vscode.OutputChannel,
    ) { }

    private async checkVersion(): Promise<boolean> {
        try {
            await checkAustinVersion(AustinRuntimeSettings.getPath());
            return true;
        } catch (e) {
            const message = (e instanceof AustinVersionError)
                ? e.message
                : `Could not determine Austin version: ${(e instanceof Error) ? e.message : e}`;
            vscode.window.showErrorMessage(message);
            return false;
        }
    }

    public async profileScript() {
        const currentUri = vscode.window.activeTextEditor?.document.uri;
        if (!isPythonExtensionAvailable()) {
            throw Error("Python extension not available");
        }

        if (!await this.checkVersion()) { return; }

        if (currentUri?.scheme === "file") {
            let task = this.provider.buildTaskFromUri(currentUri);
            this._currentExecution = await vscode.tasks.executeTask(task);
        }
        else {
            vscode.window.showErrorMessage("Please save the file to disk first!");
        }
    }

    public async attachProcess() {
        if (!await this.checkVersion()) { return; }

        const pidStr = await vscode.window.showInputBox({
            prompt: "Enter the PID of the Python process to attach to",
            placeHolder: "e.g. 12345",
            validateInput: (value) => {
                if (!/^\d+$/.test(value) || parseInt(value) <= 0) {
                    return "Please enter a valid process ID (positive integer).";
                }
            },
        });

        if (!pidStr) { return; }

        const pid = parseInt(pidStr);
        const task = this.provider.buildTaskFromPid(pid);
        this._currentExecution = await vscode.tasks.executeTask(task);
    }

    public detach() {
        this._currentExecution?.terminate();
        this._currentExecution = undefined;
    }

    public clearCurrentExecution(execution: vscode.TaskExecution) {
        if (this._currentExecution === execution) {
            this._currentExecution = undefined;
        }
    }

    public get isRunning(): boolean {
        return this._currentExecution !== undefined;
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
                    try {
                        this.stats.readFromFile(austinFile);
                    } catch (e) {
                        let message = (e instanceof Error) ? e.message : e;
                        vscode.window.showErrorMessage(`Failed to parse stats from ${austinFile}: ${message}`);
                        return;
                    }
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
                const lines = this.stats.locationMap.get(module);
                if (lines) {
                    setLinesHeat(lines, this.stats);
                }
            });
        });
    }
}
