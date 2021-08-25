import { AustinRuntimeSettings } from '../settings';
import { AustinMode } from '../types';
import { getConfiguredInterpreter } from './pythonExtension';

export interface AustinCommandArguments {
    cmd: string
    args: string[]
}


export function getAustinCommand(
        pythonFile: string, 
        pythonArgs: string[] | undefined = undefined, 
        austinArgs: string[] | undefined = undefined,
        interval: number | undefined = undefined,
        mode: AustinMode | undefined = undefined
        ) : AustinCommandArguments {
    const settings = AustinRuntimeSettings.get().settings;
    const _mode = mode ? mode : settings.mode;
    const _interval = interval ? interval : settings.interval;
    let sleepless = _mode === AustinMode.CpuTime ? "-s" : "";
    let _args: string[] = [`-i ${_interval}`, `--pipe`, `${sleepless}`];
    if (austinArgs)
        {_args.concat(austinArgs);}
    _args.push(getConfiguredInterpreter());
    _args.push(pythonFile);
    if (pythonArgs)
        {_args.concat(pythonArgs);}

    return {
        cmd: `${settings.path}`,
        args: _args
    };
}
