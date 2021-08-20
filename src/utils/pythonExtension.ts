import * as vscode from 'vscode';

export function isPythonExtensionAvailable() : boolean {
    return vscode.extensions.getExtension("ms-python.python") !== undefined;
}

export function getConfiguredInterpreter(): string {
    const pythonExtension = vscode.extensions.getExtension("ms-python.python");
    if (!pythonExtension){
        throw Error("Python extension not ready/available");
    }
    pythonExtension.exports.settings.getExecutionDetails();
    return pythonExtension.exports.settings.getExecutionDetails().execCommand[0];
}
