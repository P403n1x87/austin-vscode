import * as vscode from 'vscode';
import { clearDecorations, profile } from './profile';

export function activate(context: vscode.ExtensionContext) {

	vscode.workspace.onDidChangeTextDocument((changeEvent) => {
		clearDecorations();
	});
	// vscode.window.showInformationMessage(context.storageUri?.fsPath!);

	context.subscriptions.push(vscode.commands.registerCommand('austin-vscode.profile', profile));
}

// this method is called when your extension is deactivated
export function deactivate() { }
