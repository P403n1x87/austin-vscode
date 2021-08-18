import * as vscode from "vscode";
import { getAustinCommand } from "../utils/commandFactory";
import { AustinCommandExecutor } from "./executor";

export class AustinProfileTaskProvider implements vscode.TaskProvider {
  private austinPromise: Thenable<vscode.Task[]> | undefined = undefined;

  constructor(private output: vscode.OutputChannel) {
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
    const command = getAustinCommand(".austin-vscode", definition.file, definition.args, definition.austinArgs);
    return new vscode.Task(
        definition,
        _task.scope ?? vscode.TaskScope.Workspace,
        "profile austin",
        "austin",
        new vscode.CustomExecution(
          async (): Promise<vscode.Pseudoterminal> => {
            return new AustinCommandExecutor(command, this.output);
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
     * Optional arguments to the task
     */
    austinArgs?: string[];
}

