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
		this.austinProcess = spawn(this.command.cmd, this.command.args, {shell: true}); // NOSONAR
        if (this.austinProcess){
            this.austinProcess.stdout!.on('data', (data) => {
                this.output.append(data);
            });
            
            this.austinProcess.stderr!.on('data', (data) => {
                this.output.append(data);
            });
            
            this.austinProcess.on('close', (code) => {
                this.writeEmitter.fire(`austin process exited with code ${code}\r\n`);
                this.result = code;
                this.writeEmitter.fire('Profiling complete.\r\n');
                this.closeEmitter.fire(code);
            });
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