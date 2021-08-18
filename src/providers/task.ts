import * as vscode from "vscode";
import * as path from "path";
import { getAustinCommand } from "../utils/commandFactory";
import { AustinCommandExecutor } from "./executor";
import { AustinStats } from "../model";

export class AustinProfileTaskProvider implements vscode.TaskProvider {
  private austinPromise: Thenable<vscode.Task[]> | undefined = undefined;

  constructor(private output: vscode.OutputChannel, private stats: AustinStats, private workspaceRoot: string | undefined) {
  }

  public provideTasks(): Thenable<vscode.Task[]> | undefined {
    if (!this.austinPromise) {
        // TODO: get automatic tasks, like "profile current file"
    }
    return this.austinPromise;
  }

  public resolveTask(_task: vscode.Task): vscode.Task | undefined {
    // resolveTask requires that the same definition object be used.
    const definition: AustinProfileTaskDefinition = <any>_task.definition;
    const profileName = definition.profileName ? definition.profileName : definition.file.replace(".py", "") + ".austin";
    const resolvedPath = this.workspaceRoot ? path.join(this.workspaceRoot, definition.file) : definition.file;
    const outputFile = this.workspaceRoot ? path.join(this.workspaceRoot, profileName) : profileName;
    const command = getAustinCommand(outputFile, resolvedPath, definition.args, definition.austinArgs);
    return new vscode.Task(
        definition,
        _task.scope ?? vscode.TaskScope.Workspace,
        `profile ${resolvedPath}`,
        "austin",
        new vscode.CustomExecution(
          async (): Promise<vscode.Pseudoterminal> => {
            return new AustinCommandExecutor(command, this.output, this.stats, outputFile);
          }
        )
    );
  }
}

interface AustinProfileTaskDefinition extends vscode.TaskDefinition {
    /**
     * The python file to profile
     */
    file: string;

    /**
     * Optional arguments to the python file
     */
    args?: string[];

    /**
     * Optional arguments to austin
     */
    austinArgs?: string[];

    /**
     * Name of the generated profile 
     */
    profileName?: string;
}

