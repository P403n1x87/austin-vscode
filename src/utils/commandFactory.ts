import * as vscode from 'vscode';

export interface AustinCommandArguments {
    cmd: string
    args: string[]
}

export function getAustinCommand(outputFile: string, pythonFile: string, pythonArgs: string[] | undefined = undefined, austinArgs: string[] | undefined = undefined) : AustinCommandArguments {
    const pythonExtension = vscode.extensions.getExtension("ms-python.python");
    if (pythonExtension !== undefined) {
        pythonExtension.exports.settings.getExecutionDetails();
        const interpreter: string = pythonExtension.exports.settings.getExecutionDetails().execCommand[0];
        const config = vscode.workspace.getConfiguration('austin');
        const austinPath = config.get("path") || "austin";
        const sleepless = config.get("mode") === "CPU time" ? "-s" : "";
        const austinInterval: number = parseInt(config.get("interval") || "100");
        let _args: string[] = [`-i ${austinInterval}`,`-o ${outputFile}`, `${sleepless}`];
        if (austinArgs)
            {_args.concat(austinArgs);}
        _args.push(interpreter);
        _args.push(pythonFile);
        if (pythonArgs)
            {_args.concat(pythonArgs);}

        return {
            cmd: `${austinPath}`,
            args: _args
        };
    } else {
        throw Error("Cannot find Python extension");
    }
}