import * as vscode from 'vscode';

import { AustinCommandArguments } from "../utils/commandFactory";

import { ChildProcess, spawn } from 'child_process';

export type ExecutionResult<T extends string | Buffer> = {
    stdout: T;
    stderr?: T;
};

export class AustinCommandExecutor implements vscode.Pseudoterminal  {
    private austinProcess: ChildProcess | undefined;
    stderr: string | undefined;
    stdout: string | undefined;
    result: number | undefined;

    constructor(private command: AustinCommandArguments, private output: vscode.OutputChannel){}

	private writeEmitter = new vscode.EventEmitter<string>();
	onDidWrite: vscode.Event<string> = this.writeEmitter.event;
	private closeEmitter = new vscode.EventEmitter<number>();
	onDidClose?: vscode.Event<number> = this.closeEmitter.event;

	private fileWatcher: vscode.FileSystemWatcher | undefined;

	open(initialDimensions: vscode.TerminalDimensions | undefined): void {
        this.writeEmitter.fire('Starting Profiler.\r\n');
        const callback = (e: any, stdout: any, stderr: any) => {
            if (e && e !== null) {
                this.writeEmitter.fire(`Profiling failed (${e}).\r\n`);
            } else {
                // Make sure stderr is undefined if we actually had none. This is checked
                // elsewhere because that's how exec behaves.
                this.stderr = stderr && stderr.length > 0 ? stderr : undefined;
                this.stdout = stdout;
                this.writeEmitter.fire(`Profiling completed (${stdout}).\r\n`);
            }
        };
		this.austinProcess = spawn(this.command.cmd, this.command.args); // NOSONAR
        if (this.austinProcess){
            this.austinProcess.stdout!.on('data', (data) => {
                this.output.append(data);
            });
            
            this.austinProcess.stderr!.on('data', (data) => {
                this.output.append(data);
            });
            
            this.austinProcess.on('close', (code) => {
                console.log(`austin process exited with code ${code}`);
                this.result = code;
            });
            this.writeEmitter.fire('Profiling complete.\r\n');
        }
	}

	close(): void {
		// The terminal has been closed. Shutdown the build.
		if (this.fileWatcher) {
			this.fileWatcher.dispose();
		}
        if (this.austinProcess && !this.austinProcess.killed) {
            this.austinProcess.kill();
        }
	}
}