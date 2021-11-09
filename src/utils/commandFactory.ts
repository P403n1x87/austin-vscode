import { AustinRuntimeSettings } from '../settings';
import { AustinMode } from '../types';
import { getConfiguredInterpreter } from './pythonExtension';

export interface AustinCommandArguments {
    cmd: string
    args: string[]
}


export function getAustinCommand(
    pythonFile: string | undefined = undefined,
    command: string[] | undefined = undefined,
    pythonArgs: string[] | undefined = undefined,
    austinArgs: string[] | undefined = undefined,
    interval: number | undefined = undefined,
    mode: AustinMode | undefined = undefined
): AustinCommandArguments {
    const settings = AustinRuntimeSettings.get().settings;
    let _args: string[] = [];
    let cmd = null;
    if (command) {
        cmd = command[0];
        _args = _args.concat(command.slice(1));
        _args.push(settings.path);
    }
    else {
        cmd = settings.path;
    }
    const _mode = mode ? mode : settings.mode;
    const _interval = interval ? interval : settings.interval;
    let sleepless = _mode === AustinMode.CpuTime ? "-s" : "";
    _args = _args.concat(["-i", `${_interval}`, `--pipe`, sleepless]);


    if (austinArgs) { _args = _args.concat(austinArgs); }
    if (pythonFile) {
        _args.push(getConfiguredInterpreter());
        _args.push(pythonFile);
    }
    if (pythonArgs) { _args = _args.concat(pythonArgs); }

    return {
        cmd: cmd,
        args: _args
    };
}
