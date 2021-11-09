import * as vscode from "vscode";
import { getAustinCommand } from "../utils/commandFactory";
import { AustinCommandExecutor } from "./executor";
import { AustinStats } from "../model";
import { isPythonExtensionAvailable } from "../utils/pythonExtension";
import { AustinMode } from "../types";

export class AustinProfileTaskProvider implements vscode.TaskProvider {
  private austinPromise: Thenable<vscode.Task[]> | undefined = undefined;
  private workspaceRoot: vscode.Uri | undefined;
  private output = vscode.window.createOutputChannel("Austin");

  constructor(
    private stats: AustinStats,
  ) {
    this.workspaceRoot = vscode.workspace.workspaceFolders
      ? vscode.workspace.workspaceFolders[0].uri
      : undefined;
  }

  public provideTasks(): Thenable<vscode.Task[]> | undefined {
    if (!this.austinPromise) {
      // TODO: get automatic tasks, like "profile current file"
    }
    return this.austinPromise;
  }

  public buildTaskFromUri(path: vscode.Uri) {
    return this.buildTask(
      { file: path.fsPath, type: "austin" },
      vscode.TaskScope.Workspace,
      path);
  }

  public buildTask(
    definition: AustinProfileTaskDefinition,
    scope: vscode.WorkspaceFolder | vscode.TaskScope,
    resolvedPath: vscode.Uri | undefined): vscode.Task {

    const command = getAustinCommand(
      resolvedPath?.fsPath,
      definition.command,
      definition.args,
      definition.austinArgs,
      definition.interval,
      definition.mode
    );
    return new vscode.Task(
      definition,
      scope,
      resolvedPath ? `profile ${resolvedPath.fsPath}` : "profile", // TODO: add better logging
      "austin",
      new vscode.CustomExecution(async (): Promise<vscode.Pseudoterminal> => {
        return new AustinCommandExecutor(
          command,
          this.output,
          this.stats,
          resolvedPath?.fsPath
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

    let resolvedPath: vscode.Uri | undefined = undefined;
    // resolveTask requires that the same definition object be used.
    if (definition.file) {
      resolvedPath = this.workspaceRoot
        ? vscode.Uri.joinPath(this.workspaceRoot, definition.file)
        : vscode.Uri.parse(definition.file);
    }

    return this.buildTask(
      definition,
      _task.scope ?? vscode.TaskScope.Workspace,
      resolvedPath);
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
