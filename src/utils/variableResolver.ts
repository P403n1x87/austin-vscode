import * as vscode from "vscode";


async function resolveInputVariable(name: string): Promise<string | undefined> {
    const inputs: any[] = vscode.workspace.getConfiguration("tasks").get("inputs") ?? [];
    const input = inputs.find((i) => i.id === name);
    if (!input) { return undefined; }

    if (input.type === "pickString") {
        return vscode.window.showQuickPick(input.options ?? [], {
            placeHolder: input.description,
        });
    } else if (input.type === "promptString") {
        return vscode.window.showInputBox({
            prompt: input.description,
            password: input.password === true,
            value: input.default,
        });
    } else if (input.type === "command") {
        return vscode.commands.executeCommand<string>(input.command, input.args);
    }

    return undefined;
}


export async function resolveVariable(value: string, cwd?: string): Promise<string> {
    if (value.includes("${workspaceFolder}")) {
        const folders = vscode.workspace.workspaceFolders;
        if (folders?.length === 1) {
            value = value.replace(/\$\{workspaceFolder\}/g, folders[0].uri.fsPath);
        }
    }

    if (value.includes("${cwd}") && cwd) {
        value = value.replace(/\$\{cwd\}/g, cwd);
    }

    if (value.includes("${file}") && vscode.window.activeTextEditor) {
        value = value.replace(/\$\{file\}/g, vscode.window.activeTextEditor.document.fileName);
    }

    const envPattern = /\$\{env:([^}]+)\}/g;
    let match: RegExpExecArray | null;
    while ((match = envPattern.exec(value)) !== null) {
        const envValue = process.env[match[1]] ?? "";
        value = value.replace(match[0], envValue);
        envPattern.lastIndex = 0;
    }

    const inputPattern = /\$\{input:([^}]+)\}/g;
    while ((match = inputPattern.exec(value)) !== null) {
        const resolved = await resolveInputVariable(match[1]);
        if (resolved !== undefined) {
            value = value.replace(match[0], resolved);
            // Reset lastIndex since the string changed
            inputPattern.lastIndex = 0;
        }
    }

    return value;
}


export async function resolveVariables(values: string[], cwd?: string): Promise<string[]> {
    const resolved: string[] = [];
    for (const v of values) {
        resolved.push(await resolveVariable(v, cwd));
    }
    return resolved;
}
