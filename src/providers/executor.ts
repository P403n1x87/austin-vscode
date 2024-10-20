import * as vscode from "vscode";

import { AustinCommandArguments } from "../utils/commandFactory";

import { ChildProcess, spawn } from "child_process";
import { AustinStats } from "../model";
import { clearDecorations, setLinesHeat } from "../view";

import { DotenvPopulateInput, config } from "dotenv";


function maybeEnquote(arg: string): string {
  return arg.indexOf(' ') >= 0 ? `"${arg}"` : arg;
}


function resolveArgs(args: string[]): string[] {
  const resolvedArgs: string[] = [];
  args.forEach((arg) => {
    if (arg.indexOf("${workspaceFolder}") >= 0 && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length === 1) {
      resolvedArgs.push(arg.replace("${workspaceFolder}", vscode.workspace.workspaceFolders[0].uri.fsPath));
    } else if (arg.indexOf("${file}") >= 0 && vscode.window.activeTextEditor) {
      resolvedArgs.push(arg.replace("${file}", vscode.window.activeTextEditor.document.fileName));
    } else {
      resolvedArgs.push(arg);
    }
  });
  return resolvedArgs;
}

export class AustinCommandExecutor implements vscode.Pseudoterminal {
  private austinProcess: ChildProcess | undefined;
  stderr: string | undefined;
  stdout: string | undefined;
  result: number = 0;
  buffer: Buffer = Buffer.alloc(0);

  constructor(
    private command: AustinCommandArguments,
    private cwd: string,
    private output: vscode.OutputChannel,
    private stats: AustinStats,
    private fileName: string | undefined
  ) { }

  private writeEmitter = new vscode.EventEmitter<string>();
  onDidWrite: vscode.Event<string> = this.writeEmitter.event;
  private closeEmitter = new vscode.EventEmitter<number>();
  onDidClose?: vscode.Event<number> = this.closeEmitter.event;

  private fileWatcher: vscode.FileSystemWatcher | undefined;

  private showStats() {
    clearDecorations();
    try {
      this.stats.readFromBuffer(this.buffer, this.fileName || "");
    } catch (e) {
      let message = (e instanceof Error) ? e.message : e;
      vscode.window.showErrorMessage(`Failed to parse stats from ${this.fileName}: ${message}`);
      return;
    }
    if (this.fileName) {
      const lines = this.stats.locationMap.get(this.fileName);
      if (lines) {
        setLinesHeat(lines, this.stats);
      }
    }
  }

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    this.writeEmitter.fire(`Starting Profiler in ${this.cwd}.\r\n`);
    let resolvedArgs = resolveArgs(this.command.args);

    // Make a copy of all defined environment variables
    let env: DotenvPopulateInput = {};
    for (let key in process.env) {
      let value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }

    // Add any environment variables defined in the envFile, if any given
    if (this.command.envFile) {
      config({ path: this.command.envFile, processEnv: env });
    }

    this.austinProcess = spawn(this.command.cmd, resolvedArgs, {
      "cwd": this.cwd,
      "env": env,
    }); // NOSONAR
    const args = resolvedArgs.map(maybeEnquote).join(' ');
    this.writeEmitter.fire(`Running '${maybeEnquote(this.command.cmd)}' with args '${args}'.\r\n`);
    if (!this.fileName) {
      this.fileName = `${this.command.cmd} ${args}`;
    }
    if (this.austinProcess) {
      this.austinProcess.on("error", (err) => {
        this.writeEmitter.fire(err.message);
      });
      this.austinProcess.stdout!.on("data", (data) => {
        this.buffer = Buffer.concat([this.buffer, data]);
      });

      this.austinProcess.stderr!.on("data", (data) => {
        this.output.append(data.toString());
      });

      this.austinProcess.on("close", (code) => {
        if (code !== 0) {
          this.writeEmitter.fire(`austin process exited with code ${code}\r\n`);
          this.result = code;
          this.closeEmitter.fire(code);
        } else {
          this.writeEmitter.fire("Profiling complete.\r\n");
          this.closeEmitter.fire(code);
          this.showStats();
        }
      });
    } else {
      this.writeEmitter.fire(`Could not launch austin process ${this.command.cmd}.`);
      this.result = 35;
      this.closeEmitter.fire(35);
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
