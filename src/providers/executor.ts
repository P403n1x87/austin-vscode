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

/**
 * How far we have escalated the sudo authentication strategy.
 *
 * None -> Askpass -> Password, each stage being tried only after the previous
 * one failed to authenticate. Password is the last resort: it always works as
 * long as the user knows their password, including on headless machines and
 * over Remote SSH, where no graphical helper is available.
 */
enum SudoAuth {
  None = "none",
  Askpass = "askpass",
  Password = "password"
}

export class AustinCommandExecutor implements vscode.Pseudoterminal {
  private austinProcess: ChildProcess | undefined;
  private state: ExecutorState = ExecutorState.Running;
  // Escalated by retrySudo() when an attempt fails to authenticate, so that
  // the retry in open() knows which mechanism to use next.
  private _sudoStage: SudoAuth = SudoAuth.None;
  private _password: string | undefined;
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

    // On the first attempt we use no -A and no -S, letting the system handle
    // auth (e.g. PrivilegesCLI, sudoers-configured askpass, cached credentials).
    if (this.command.cmd === 'sudo') {
      if (this._sudoStage === SudoAuth.Askpass) {
        const askpass = findAskpass();
        if (askpass) {
          childEnv["SUDO_ASKPASS"] = askpass;
          resolvedArgs = ['-A', ...resolvedArgs];
        }
      } else if (this._sudoStage === SudoAuth.Password) {
        // Read the password from stdin rather than passing it in argv, where it
        // would be visible to any user running ps. An empty prompt keeps sudo
        // from writing "[sudo] password for ..." to the output channel, where
        // it could not be answered anyway.
        resolvedArgs = ['-S', '-p', '', ...resolvedArgs];
      }
    }

    this.austinProcess = spawn(this.command.cmd, resolvedArgs, {
      cwd: this.cwd,
      env: childEnv,
    }); // NOSONAR

    if (this._sudoStage === SudoAuth.Password && this._password !== undefined) {
      const password = this._password;
      // Do not keep the password around any longer than needed: this is the
      // last authentication stage, so it is never replayed.
      this._password = undefined;
      // EPIPE if sudo exits before reading the password; the close handler
      // already reports that, so there is nothing to do here.
      this.austinProcess.stdin?.on('error', () => { });
      // stdin must be closed after the password, otherwise sudo blocks waiting
      // to re-read it when the password turns out to be wrong.
      this.austinProcess.stdin?.end(`${password}\n`);
    }
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

      const reportTermination = (code: number | null, wasStopping: boolean) => {
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
      };

      // Triggered when the austin process exits (for any reason)
      this.austinProcess.on("close", (code) => {
        const wasStopping = this.state === ExecutorState.Stopping;
        this.state = ExecutorState.Terminated;
        clearInterval(refreshInterval);

        // If sudo could not authenticate, escalate to the next mechanism and
        // start over before reporting an error.
        if (!wasStopping && code !== 0 && this.command.cmd === 'sudo' &&
            this._sudoStage !== SudoAuth.Password) {
          void this.retrySudo(stderrData).then(
            (retrying) => {
              if (retrying) {
                this.state = ExecutorState.Running;
                this.open(undefined);
              } else {
                reportTermination(code, false);
              }
            },
            () => reportTermination(code, false),
          );
          return;
        }

        reportTermination(code, wasStopping);
      });
    } else {
      this.writeEmitter.fire(`Could not launch austin process ${this.command.cmd}.`);
      this.result = 35;
      this.closeEmitter.fire(35);
    }
  }

  /**
   * Escalate the sudo authentication strategy after a failed attempt.
   *
   * Returns true when a further attempt is worth making, in which case open()
   * should be called again to run it.
   */
  private async retrySudo(stderr: string): Promise<boolean> {
    if (this._sudoStage === SudoAuth.None) {
      // sudo ran but authentication failed or was cancelled through a working
      // system mechanism: there is nothing to escalate to.
      if (!sudoNeedsAskpass(stderr)) { return false; }

      const askpass = findAskpass();
      if (askpass) {
        this._sudoStage = SudoAuth.Askpass;
        this.writeEmitter.fire("sudo could not prompt for a password; retrying with a password helper.\r\n");
        return true;
      }
    }

    // No password helper was available, or the one we found could not be used
    // (no graphical session, helper missing, wrong password). Ask for the
    // password through VS Code, which works even on a headless machine.
    const password = await promptForSudoPassword(this._sudoStage === SudoAuth.Askpass);
    if (password === undefined) { return false; }

    this._password = password;
    this._sudoStage = SudoAuth.Password;
    this.writeEmitter.fire("Retrying with the password provided.\r\n");
    return true;
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

/**
 * Locate one of the bundled askpass scripts.
 *
 * The scripts are packaged at out/askpass, but __dirname depends on how the
 * extension was built: it is out/ in the esbuild bundle that ships to users,
 * and out/providers/ in the tsc build used by the tests. Both layouts have to
 * be tried, or the helper is silently never found in released builds.
 */
function bundledAskpass(name: string): string | undefined {
  for (const dir of [__dirname, path.join(__dirname, '..')]) {
    const candidate = path.join(dir, 'askpass', name);
    if (fs.existsSync(candidate)) { return candidate; }
  }
  return undefined;
}

/** @internal exported for testing */
export function findAskpass(): string | undefined {
  // Respect existing environment in case the user set a custom askpass
  if (process.env.SUDO_ASKPASS) { return process.env.SUDO_ASKPASS; }

  const platform = process.platform;
  if (platform === 'darwin') {
    return bundledAskpass('macos-askpass.sh');
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
    return bundledAskpass('linux-askpass.sh');
  }

  return undefined;
}

/** Ask the user for their sudo password through the VS Code UI. */
async function promptForSudoPassword(afterFailure: boolean): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: 'Austin',
    prompt: afterFailure
      ? 'Authentication failed. Enter your password to try again.'
      : 'Austin needs elevated privileges. Enter your password.',
    password: true,
    ignoreFocusOut: true,
  });
}

/** Returns true when sudo stderr indicates it had no way to prompt for a password. */
function sudoNeedsAskpass(stderr: string): boolean {
  return stderr.includes('no tty present') ||
    stderr.includes('no askpass program') ||
    stderr.includes('a terminal is required') ||
    stderr.includes('must be run from a terminal') ||
    stderr.includes('must have a tty');
}

/** Outcome of a single sudo invocation. */
interface SudoResult {
  code: number | null;
  stderr: string;
  spawnFailed?: boolean;
}

function runSudo(
  args: string[],
  cwd: string,
  extraEnv?: NodeJS.ProcessEnv,
  password?: string,
): Promise<SudoResult> {
  const env: NodeJS.ProcessEnv = {};
  for (const k of Object.keys(process.env)) { env[k] = process.env[k]; }
  Object.assign(env, extraEnv ?? {});

  return new Promise<SudoResult>((resolve) => {
    const child = spawn('sudo', args, {
      env, cwd, stdio: [password === undefined ? 'ignore' : 'pipe', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', () => resolve({ code: null, stderr, spawnFailed: true }));
    child.on('close', (code) => resolve({ code, stderr }));

    if (password !== undefined) {
      child.stdin?.on('error', () => { });
      // See open(): stdin must be closed so a wrong password fails instead of
      // leaving sudo blocked on a re-read.
      child.stdin?.end(`${password}\n`);
    }
  });
}

/**
 * Fire-and-forget wrapper: callers request a kill and react through onFailure,
 * so nothing is left to reject unhandled if the UI or a spawn misbehaves.
 */
function attemptSudoKill(pid: number, cwd: string, onFailure?: () => void) {
  sudoKill(pid, cwd, onFailure).catch(() => {
    vscode.window.showWarningMessage(
      'Failed to stop Austin. Click "Stop Austin" to try again.'
    );
    if (onFailure) { onFailure(); }
  });
}

async function sudoKill(pid: number, cwd: string, onFailure?: () => void) {
  const kill = ['kill', '-TERM', String(pid)];

  const fail = (message: string) => {
    vscode.window.showWarningMessage(message);
    if (onFailure) { onFailure(); }
  };

  // First try vanilla sudo — respects cached credentials and any system-level
  // auth mechanism (e.g., PrivilegesCLI, sudoers-configured password helper).
  let result = await runSudo(kill, cwd);
  if (result.code === 0) { return; }
  if (result.spawnFailed) {
    fail('Failed to stop Austin (sudo not available). Add Austin to the sudoers file.');
    return;
  }

  if (!sudoNeedsAskpass(result.stderr)) {
    fail('Failed to stop Austin (authentication failed or was cancelled). Click "Stop Austin" to try again.');
    return;
  }

  // No system auth mechanism; retry with a password helper if we have one.
  const askpass = findAskpass();
  if (askpass) {
    result = await runSudo(['-A', ...kill], cwd, { SUDO_ASKPASS: askpass });
    if (result.code === 0) { return; }
  }

  // Fall back to asking for the password through VS Code, which works with no
  // graphical session and over Remote SSH.
  const password = await promptForSudoPassword(askpass !== undefined);
  if (password !== undefined) {
    result = await runSudo(['-S', '-p', '', ...kill], cwd, undefined, password);
    if (result.code === 0) { return; }
  }

  if (sudoNeedsAskpass(result.stderr)) {
    // sudo insists on a real terminal — open one for manual authentication.
    vscode.window.showWarningMessage('Elevated privileges required to stop Austin. Check the terminal.');
    const shellEnv: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL']) {
      if (process.env[key] !== undefined) { shellEnv[key] = process.env[key]; }
    }
    const terminal = vscode.window.createTerminal({ cwd, env: shellEnv });
    terminal.show();
    terminal.sendText(`sudo kill -TERM ${pid}`);
    if (onFailure) { onFailure(); }
    return;
  }

  fail('Failed to stop Austin (authentication failed or was cancelled). Click "Stop Austin" to try again.');
}
