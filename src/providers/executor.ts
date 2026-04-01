import * as vscode from "vscode";

import { AustinCommandArguments } from "../utils/commandFactory";

import { ChildProcess, spawn } from "child_process";
import { AustinStats } from "../model";
import { StreamingMojoParser } from "../utils/mojo";
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
  private _killed: boolean = false;
  private _processExited: boolean = false;
  result: number = 0;

  constructor(
    private command: AustinCommandArguments,
    private cwd: string,
    private output: vscode.OutputChannel,
    private stats: AustinStats,
    private fileName: string | undefined,
    private isAttach: boolean = false,
  ) { }

  private writeEmitter = new vscode.EventEmitter<string>();
  onDidWrite: vscode.Event<string> = this.writeEmitter.event;
  private closeEmitter = new vscode.EventEmitter<number>();
  onDidClose?: vscode.Event<number> = this.closeEmitter.event;

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    this.writeEmitter.fire(`Starting Profiler in ${this.cwd}.\r\n`);
    let resolvedArgs = resolveArgs(this.command.args);

    let env: DotenvPopulateInput = {};
    for (let key in process.env) {
      let value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }
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
    const fileName = this.fileName;

    if (this.austinProcess) {
      this.austinProcess.on("error", (err) => {
        this.writeEmitter.fire(err.message);
      });

      this.austinProcess.stderr!.on("data", (data) => {
        this.output.append(data.toString());
      });

      clearDecorations();
      this.stats.begin(fileName);
      const parser = new StreamingMojoParser(this.stats);

      this.austinProcess.stdout!.on("data", (chunk: Buffer) => {
        parser.push(chunk);
      });

      let lastTotal = 0;
      let firstTick = true;
      const refreshInterval = setInterval(() => {
        const hasNewData = this.stats.overallTotal > lastTotal;
        if (!this.stats.paused && (firstTick || hasNewData)) {
          firstTick = false;
          lastTotal = this.stats.overallTotal;
          this.stats.refresh();
        }
      }, 1000);

      this.austinProcess.on("close", (code) => {
        this._processExited = true;
        clearInterval(refreshInterval);
        if (this._killed) {
          // Intentional stop: we sent a kill signal before the process exited
          this.closeEmitter.fire(0);
          const label = fileName ?? "process";
          if (this.isAttach) {
            this.writeEmitter.fire("Austin detached.\r\n");
            vscode.window.showInformationMessage(`Austin detached from ${label}.`);
          } else {
            this.writeEmitter.fire("Austin terminated.\r\n");
            vscode.window.showInformationMessage(`Austin terminated ${label}.`);
          }
          parser.finalize();
          this.stats.refresh();
        } else if (code !== 0) {
          this.writeEmitter.fire(`austin process exited with code ${code}\r\n`);
          this.result = code!;
          this.closeEmitter.fire(code!);
          vscode.window.showErrorMessage(`Austin exited with code ${code}. Check the Austin output channel for details.`);
          parser.finalize();
          this.stats.refresh();
        } else {
          this.writeEmitter.fire("Profiling complete.\r\n");
          this.closeEmitter.fire(0);
          const label = fileName ? vscode.workspace.asRelativePath(fileName) : "script";
          vscode.window.showInformationMessage(`Profiling of ${label} done.`);
          parser.finalize();
          this.stats.refresh();
          if (fileName) {
            const lines = this.stats.locationMap.get(fileName);
            if (lines) { setLinesHeat(lines, this.stats); }
          }
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
    if (this.austinProcess && !this.austinProcess.killed) {
      if (!this._processExited) {
        this._killed = true;
      }
      this.austinProcess.kill();
    }
  }
}
