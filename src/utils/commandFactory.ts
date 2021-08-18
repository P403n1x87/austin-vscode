import * as vscode from 'vscode';


export function getAustinCommand(outputFile: string, pythonFile: string, pythonArgs: string[] | undefined = undefined, austinArgs: string[] | undefined = undefined) : string {
    const pythonExtension = vscode.extensions.getExtension("ms-python.python");
    if (pythonExtension !== undefined) {
        pythonExtension.exports.settings.getExecutionDetails();
        const interpreter: string = pythonExtension.exports.settings.getExecutionDetails().execCommand[0];
        const config = vscode.workspace.getConfiguration('austin');
        const austinPath = config.get("path") || "austin";
        const sleepless = config.get("mode") === "CPU time" ? "-s" : "";
        const austinInterval: number = parseInt(config.get("interval") || "100");
        const args = pythonArgs ? pythonArgs.join(" ") : "";
        const _austinArgs = austinArgs ? austinArgs.join(" ") : "";
        // TODO 
        return `${austinPath} -i ${austinInterval} -o ${outputFile} ${sleepless} ${_austinArgs} ${interpreter} ${pythonFile} ${args}`;
    } else {
        throw Error("Cannot find Python extension");
    }
}