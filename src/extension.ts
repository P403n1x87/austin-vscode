import * as vscode from 'vscode';
import { clearDecorations } from './profile';
import { FlameGraphViewProvider } from './flamegraph';


export function activate(context: vscode.ExtensionContext) {

	vscode.workspace.onDidChangeTextDocument((changeEvent) => {
		clearDecorations();
	});
	// vscode.window.showInformationMessage(context.storageUri?.fsPath!);

	const flameGraphViewProvider = new FlameGraphViewProvider(context.extensionUri);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			FlameGraphViewProvider.viewType,
			flameGraphViewProvider,
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('austin-vscode.profile', () => {
			flameGraphViewProvider.profileScript();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('austin-vscode.load', () => {
			flameGraphViewProvider.loadSamples();
		})
	);
}

// this method is called when your extension is deactivated
export function deactivate() { }
