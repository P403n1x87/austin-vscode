import * as vscode from 'vscode';
import { AustinRuntimeSettings } from '../settings';
import { AustinMode, AustinSettings } from '../types';

export interface AustinCommandArguments {
    cmd: string
    args: string[]
}


export function getAustinCommand(outputFile: string, pythonFile: string, pythonArgs: string[] | undefined = undefined, austinArgs: string[] | undefined = undefined) : AustinCommandArguments {
    const pythonExtension = vscode.extensions.getExtension("ms-python.python");
    const settings = AustinRuntimeSettings.get().settings;
    if (pythonExtension !== undefined) {
        pythonExtension.exports.settings.getExecutionDetails();
        const interpreter: string = pythonExtension.exports.settings.getExecutionDetails().execCommand[0];
        let sleepless = settings.mode === AustinMode.CpuTime ? "-s" : "";
        let _args: string[] = [`-i ${settings.interval}`, `-o ${outputFile}`, `${sleepless}`];
        if (austinArgs)
            {_args.concat(austinArgs);}
        _args.push(interpreter);
        _args.push(pythonFile);
        if (pythonArgs)
            {_args.concat(pythonArgs);}

        return {
            cmd: `${settings.path}`,
            args: _args
        };
    } else {
        throw Error("Cannot find Python extension");
    }
}