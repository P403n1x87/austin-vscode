import * as vscode from "vscode";
import { getAustinCommand } from "../utils/commandFactory";
import { AustinCommandExecutor } from "./executor";
import { AustinStats } from "../model";
import { isPythonExtensionAvailable } from "../utils/pythonExtension";
import { AustinMode } from "../types";
import { isAbsolute } from "path";
import { platform } from "os";

export class AustinProfileTaskProvider implements vscode.TaskProvider {
  private austinPromise: Thenable<vscode.Task[]> | undefined = undefined;

  constructor(
    private stats: AustinStats,
    private output: vscode.OutputChannel,
  ) { }

  public provideTasks(): Thenable<vscode.Task[]> | undefined {
    if (!this.austinPromise) {
      // TODO: get automatic tasks, like "profile current file"
    }
    return this.austinPromise;
  }

  public buildTaskFromUri(path: vscode.Uri) {
    return this.buildTask(
      { file: path.fsPath, type: "austin", command: platform() === "darwin" ? ["sudo"] : undefined },
      vscode.TaskScope.Workspace,
    );
  }

  public buildTask(
    definition: AustinProfileTaskDefinition,
    scope: vscode.WorkspaceFolder | vscode.TaskScope,
  ): vscode.Task {
    return new vscode.Task(
      definition,
      scope,
      definition.file ? `profile ${definition.file}` : "profile", // TODO: add better logging
      "austin",
      new vscode.CustomExecution(async (): Promise<vscode.Pseudoterminal> => {
        let cwd: string | undefined = undefined;

        if (vscode.workspace.workspaceFolders) {
          if (vscode.workspace.workspaceFolders.length === 1) {
            cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;
          } else {
            cwd = await vscode.window.showQuickPick(
              vscode.workspace.workspaceFolders.map(f => f.uri.fsPath),
              {
                "title": "Pick the working directory for the task",
                "canPickMany": false,
              }
            );
          }
        } else if (vscode.window.activeTextEditor) {
          cwd = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)?.uri.fsPath;
        }

        let resolvedPath: vscode.Uri | undefined = undefined;
        if (definition.file) {
          resolvedPath = isAbsolute(definition.file)
            ? vscode.Uri.file(definition.file)
            : vscode.Uri.joinPath(vscode.Uri.file(cwd!), definition.file);
        }

        const command = getAustinCommand(
          resolvedPath?.fsPath,
          definition.command,
          definition.args,
          definition.austinArgs,
          definition.interval,
          definition.mode
        );

        return new AustinCommandExecutor(
          command,
          cwd!,
          this.output,
          this.stats,
          resolvedPath?.fsPath,
        );
      })
    );
  }

  public resolveTask(_task: vscode.Task): vscode.Task | undefined {
    if (!isPythonExtensionAvailable()) {
      this.output.appendLine("Python extension not available.");
      return;
    }
    const definition: AustinProfileTaskDefinition = <any>_task.definition;

    return this.buildTask(definition, _task.scope ?? vscode.TaskScope.Workspace);
  }
}

interface AustinProfileTaskDefinition extends vscode.TaskDefinition {
  /**
   * The python file to profile
   */
  file?: string;

  /**
   * Optional arguments to the python file
   */
  args?: string[];

  /** 
   * Polling interval
   */
  interval?: number;

  /** 
   * Mode, either "Wall time" or "CPU time"
   */
  mode?: AustinMode;

  /**
   * Optional arguments to austin
   */
  austinArgs?: string[];

  /**
   * Optional command to run before austin, including its arguments
   */
  command?: string[];
}
