import * as vscode from 'vscode';
import { createReadStream } from 'fs';
import { dirname, join } from 'path';
import { createInterface } from 'readline';


let decorators: vscode.TextEditorDecorationType[] = [];


export function clearDecorations() {
    decorators.forEach((ld) => ld.dispose());
    decorators = [];
}

function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


function setLineHeat(line: number, own: number, total: number, overallTotal: number) {
    const ownp = (own * 100 / overallTotal).toFixed(2);
    const totalp = (total * 100 / overallTotal).toFixed(2);
    const editor = vscode.window.activeTextEditor;
    if (editor !== undefined) {
        const color: string = `rgba(192, 64, 64, ${own / overallTotal})`;
        const lineDecorator = vscode.window.createTextEditorDecorationType({
            backgroundColor: color,
            after: {
                contentText: `own: ${ownp}%, total: ${totalp}%`,
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


interface FrameObject {
    scope: string;
    lineNumber: number;
    module: string;
};

function parseFrame(frame: string): FrameObject {
    let scope: string, rest: string;
    [scope, rest] = frame.slice(0, -1).split(" (");
    const c = rest.lastIndexOf(":");
    const module: string = rest.slice(0, c);
    const lineNumber: number = Number(rest.slice(c + 1));
    return { "scope": scope, "lineNumber": lineNumber, "module": module };
}


function aggregate(file: string, cb: (stats: Map<string, Map<number, [number, number]>>, overallTotal: number) => void) {
    const readInterface = createInterface({
        input: createReadStream(file)
    });

    let stats = new Map<string, Map<number, [number, number]>>();
    let overallTotal = 0;

    readInterface.on("line", (line) => {
        const n: number = line.lastIndexOf(' ');
        const frames: string = line.slice(0, n);
        const metric: number = Number(line.slice(n + 1));
        overallTotal += metric;

        let fo: FrameObject | undefined = undefined;
        let module: Map<number, [number, number]> | undefined = undefined;
        let frameList: FrameObject[] = frames.split(';').slice(2).map(parseFrame);
        let seenFrames = new Set<string>(); // Prefent inflating times (e.g. recursive functions)
        frameList.forEach((fo) => {
            if (seenFrames.has(`${fo.module}:${fo.lineNumber}`)) {
                return;
            }
            seenFrames.add(`${fo.module}:${fo.lineNumber}`);
            if (!(stats.has(fo.module))) {
                stats.set(fo.module, new Map<number, [number, number]>());
            }
            let module = stats.get(fo.module);
            if (!(module?.has(fo.lineNumber))) {
                module?.set(fo.lineNumber, [0, 0]);
            }
            let own: number, total: number;
            [own, total] = module?.get(fo.lineNumber)!;
            total += metric;
            module?.set(fo.lineNumber, [own, total]);
        });
        if (frameList.length > 0) {
            fo = frameList[frameList.length - 1];
            let module = stats.get(fo.module);
            let own: number, total: number;
            [own, total] = module?.get(fo.lineNumber)!;
            own += metric;
            module?.set(fo.lineNumber, [own, total]);
        }
    });

    readInterface.on("close", () => { cb(stats, overallTotal); });
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
            terminal.sendText(`c:\\Users\\Gabriele\\Projects\\austin\\src\\austin.exe -i 50000 -ao ${outputFile} ${interpreter} ${currentUri.fsPath}` + "; exit $LastExitCode");

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
                aggregate(outputFile, (stats, overallTotal) => {
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