import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

import { ChildProcess, spawn, spawnSync } from "child_process";

import { AustinCommandArguments } from "../utils/commandFactory";
import { AustinStats } from "../model";
import { StreamingMojoParser } from "../utils/mojo";
import { clearDecorations, setLinesHeat } from "../view";

import { DotenvPopulateInput, config } from "dotenv";

export const onAustinTerminated = new vscode.EventEmitter<boolean>();
let currentExecutor: AustinCommandExecutor | undefined;

export function setCurrentExecutor(executor: AustinCommandExecutor | undefined) {
  currentExecutor = executor;
}

export function getCurrentExecutor(): AustinCommandExecutor | undefined {
  return currentExecutor;
}


function maybeEnquote(arg: string): string {
  return arg.indexOf(' ') >= 0 ? `"${arg}"` : arg;
}

/**
 * Finite-state machine for AustinCommandExecutor lifecycle management.
 *
 * States:
 * - Running: austin is actively profiling
 * - Stopping: kill has been requested but process hasn't exited yet
 * - Terminated: process has exited
 *
 * State Transitions:
 *
 * Running -> Stopping:
 *   - Triggered by: user clicking "Detach Austin" or terminal closing
 *   - Action: attempt to kill the austin process (via requestDetach() or close())
 *
 * Stopping -> Terminated:
 *   - Triggered by: austin process exiting after kill was requested
 *   - Action: onAustinTerminated event fires, status bar hides
 *
 * Stopping -> Running:
 *   - Triggered by: sudo kill fails (wrong password, user cancels, etc.)
 *   - Action: state reset via onFailure callback, user can retry
 *
 * Running -> Terminated:
 *   - Triggered by: austin process exiting unexpectedly (success, error, or crash)
 *   - Action: appropriate message shown, task ends
 */

enum ExecutorState {
  Running = "running",
  Stopping = "stopping",
  Terminated = "terminated"
}

export class AustinCommandExecutor implements vscode.Pseudoterminal {
  private austinProcess: ChildProcess | undefined;
  private state: ExecutorState = ExecutorState.Running;
  // Set to true after the first attempt fails with a "no tty/no askpass" sudo
  // error, so that the retry in open() knows to use our bundled askpass.
  private _triedAskpass: boolean = false;
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
    let resolvedArgs = this.command.args;

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

    const childEnv: DotenvPopulateInput = {};
    for (let k in env) { childEnv[k] = env[k]; }

    if (this.command.cmd === 'sudo' && this._triedAskpass) {
      // Retry: vanilla sudo failed because no system auth mechanism was available.
      // Fall back to our bundled askpass.
      const askpass = findAskpass();
      if (askpass) {
        childEnv["SUDO_ASKPASS"] = askpass;
        resolvedArgs = ['-A', ...resolvedArgs];
      }
    }
    // On first attempt: no -A, no SUDO_ASKPASS — let the system handle auth
    // (e.g., PrivilegesCLI, sudoers-configured askpass, cached credentials).

    this.austinProcess = spawn(this.command.cmd, resolvedArgs, {
      cwd: this.cwd,
      env: childEnv,
    }); // NOSONAR
    const args = resolvedArgs.map(maybeEnquote).join(' ');
    this.writeEmitter.fire(`Running '${maybeEnquote(this.command.cmd)}' with args '${args}'.\r\n`);
    if (!this.fileName) {
      this.fileName = `${this.command.cmd} ${args}`;
    }
    const fileName = this.fileName;

    if (this.austinProcess) {
      // Triggered when the austin child process crashes or fails to start
      this.austinProcess.on("error", (err) => {
        this.writeEmitter.fire(err.message);
      });

      // Triggered when austin writes to stderr (e.g., error messages)
      let stderrData = '';
      this.austinProcess.stderr!.on("data", (data) => {
        const s = data.toString();
        stderrData += s;
        this.output.append(s);
      });

      clearDecorations();
      this.stats.begin(fileName);
      const parser = new StreamingMojoParser(this.stats);

      // Triggered when austin writes profiling data to stdout
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

      // Triggered when the austin process exits (for any reason)
      this.austinProcess.on("close", (code) => {
        const wasStopping = this.state === ExecutorState.Stopping;
        this.state = ExecutorState.Terminated;
        clearInterval(refreshInterval);

        // If vanilla sudo failed because no password mechanism was available,
        // retry once with our bundled askpass before reporting an error.
        if (!wasStopping && code !== 0 && !this._triedAskpass &&
            this.command.cmd === 'sudo' && sudoNeedsAskpass(stderrData)) {
          this._triedAskpass = true;
          this.state = ExecutorState.Running;
          this.open(undefined);
          return;
        }

        onAustinTerminated.fire(true);
        if (wasStopping) {
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
          this.stats.notifyError();
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

  // Called when user clicks the "Detach Austin" status bar item
  public requestDetach(): void {
    // Request detachment - try to kill but don't end the task
    if (this.state !== ExecutorState.Running || !this.austinProcess || this.austinProcess.killed) {
      return;
    }
    this.state = ExecutorState.Stopping;
    const pid = this.austinProcess.pid;

    if (this.command.cmd === 'sudo' && pid) {
      // For sudo, the attemptSudoKill runs asynchronously.
      // If it fails, onAustinTerminated won't fire, so we stay in Stopping.
      // Allow user to retry - if they do, we'll try again.
      attemptSudoKill(pid, this.cwd, () => {
        // Callback when sudo fails - reset state to allow retry
        this.state = ExecutorState.Running;
      });
    } else {
      try {
        this.austinProcess.kill();
      } catch (err: any) {
        if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
          if (pid) {
            attemptSudoKill(pid, this.cwd, () => {
              this.state = ExecutorState.Running;
            });
          }
        }
      }
    }
  }

  // Called when the terminal is closed (pseudoterminal is disposed)
  close(): void {
    // Terminal closed - same as requestDetach for sudo case
    if (this.state !== ExecutorState.Running || !this.austinProcess || this.austinProcess.killed) {
      return;
    }
    this.state = ExecutorState.Stopping;
    const pid = this.austinProcess.pid;

    if (this.command.cmd === 'sudo' && pid) {
      attemptSudoKill(pid, this.cwd);
      return;
    }

    try {
      this.austinProcess.kill();
    } catch (err: any) {
      if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
        if (pid) {
          attemptSudoKill(pid, this.cwd);
          return;
        }
      }
      this.writeEmitter.fire(err?.message ?? String(err));
    }
    // Let the "close" event on the process fire closeEmitter, same as requestDetach().
  }
}

/** @internal exported for testing */
export function findAskpass(): string | undefined {
  // Respect existing environment in case the user set a custom askpass
  if (process.env.SUDO_ASKPASS) { return process.env.SUDO_ASKPASS; }

  const platform = process.platform;
  if (platform === 'darwin') {
    const p = path.join(__dirname, '..', 'askpass', 'macos-askpass.sh');
    if (fs.existsSync(p)) { return p; }
  }

  if (platform === 'linux') {
    const candidates = ['ssh-askpass', 'ksshaskpass', 'ssh-askpass-gnome'];
    for (const cmd of candidates) {
      try {
        const which = spawnSync('which', [cmd]);
        if (which.status === 0) {
          const resolved = which.stdout.toString().trim();
          if (resolved) { return resolved; }
        }
      } catch {
        // ignore
      }
    }
    // Fallback: bundled askpass for linux if present
    const p = path.join(__dirname, '..', 'askpass', 'linux-askpass.sh');
    if (fs.existsSync(p)) { return p; }
  }

  return undefined;
}

/** Returns true when sudo stderr indicates it had no way to prompt for a password. */
function sudoNeedsAskpass(stderr: string): boolean {
  return stderr.includes('no tty present') ||
    stderr.includes('no askpass program') ||
    stderr.includes('a terminal is required') ||
    stderr.includes('must be run from a terminal');
}

function attemptSudoKill(pid: number, cwd: string, onFailure?: () => void) {
  const env: NodeJS.ProcessEnv = {};
  for (const k of Object.keys(process.env)) { env[k] = process.env[k]; }

  // First try vanilla sudo — respects cached credentials and any system-level
  // auth mechanism (e.g., PrivilegesCLI, sudoers-configured password helper).
  let stderrData = '';
  const child = spawn('sudo', ['kill', '-TERM', String(pid)], {
    env, cwd, stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr!.on('data', (d: Buffer) => { stderrData += d.toString(); });

  child.on('close', (code) => {
    if (code === 0) { return; }

    if (sudoNeedsAskpass(stderrData)) {
      // No system auth mechanism; retry with our bundled password helper.
      const askpass = findAskpass();
      if (askpass) {
        const retryEnv = { ...env };
        retryEnv['SUDO_ASKPASS'] = askpass;
        const retry = spawn('sudo', ['-A', 'kill', '-TERM', String(pid)], {
          env: retryEnv, cwd, stdio: 'ignore',
        });
        retry.on('close', (retryCode) => {
          if (retryCode !== 0) {
            vscode.window.showWarningMessage(
              'Failed to stop Austin (authentication failed or was cancelled). Click "Stop Austin" to try again.'
            );
            if (onFailure) { onFailure(); }
          }
        });
        retry.on('error', () => {
          vscode.window.showWarningMessage(
            'Failed to stop Austin (sudo not available). Add Austin to the sudoers file.'
          );
          if (onFailure) { onFailure(); }
        });
        return;
      }

      // No password helper available — open a minimal terminal for manual auth.
      vscode.window.showWarningMessage('Elevated privileges required to stop Austin. Check the terminal.');
      const shellEnv: NodeJS.ProcessEnv = {};
      for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL']) {
        if (process.env[key] !== undefined) { shellEnv[key] = process.env[key]; }
      }
      const terminal = vscode.window.createTerminal({ cwd, env: shellEnv });
      terminal.show();
      terminal.sendText(`sudo kill -TERM ${pid}`);
      if (onFailure) { onFailure(); }
    } else {
      // Vanilla sudo ran but authentication failed or was cancelled.
      vscode.window.showWarningMessage(
        'Failed to stop Austin (authentication failed or was cancelled). Click "Stop Austin" to try again.'
      );
      if (onFailure) { onFailure(); }
    }
  });

  child.on('error', () => {
    vscode.window.showWarningMessage(
      'Failed to stop Austin (sudo not available). Add Austin to the sudoers file.'
    );
    if (onFailure) { onFailure(); }
  });
}
