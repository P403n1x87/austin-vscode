import * as vscode from 'vscode';
import { clearDecorations, formatInterval } from './view';
import { FlameGraphViewProvider } from './controller';


export function activate(context: vscode.ExtensionContext) {

	vscode.workspace.onDidChangeTextDocument((changeEvent) => {
		clearDecorations();
	});

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
			flameGraphViewProvider.openSampleFile();
		})
	);

	// ---- Interval selector ----
	const config = vscode.workspace.getConfiguration('austin');
	const austinInterval: number = parseInt(config.get("interval") || "100");
	const austinIntervalStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

	austinIntervalStatusBarItem.command = "austin-vscode.interval";
	austinIntervalStatusBarItem.text = formatInterval(austinInterval);
	austinIntervalStatusBarItem.tooltip = "Austin sampling interval";

	context.subscriptions.push(
		vscode.commands.registerCommand(austinIntervalStatusBarItem.command, () => {
			// Show interval dialog
			vscode.window.showInputBox({
				"value": config.get("interval"),
				"prompt": "Enter new Austin sampling inteval",
				"validateInput": (value) => {
					if (isNaN(parseInt(value)) || !/^\d+$/.test(value)) { return "The interval must be an integer."; }
				},
			}).then((value) => {
				if (value) {
					const newInterval = parseInt(value);
					config.update("interval", newInterval);
					austinIntervalStatusBarItem.text = formatInterval(newInterval);
				}
			});
		})
	);


	// ---- Mode selector ----
	const austinMode: string = config.get("mode");
	const austinModeStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);

	austinModeStatusBarItem.command = "austin-vscode.mode";
	austinModeStatusBarItem.text = `$(clock) ${austinMode}`;
	austinModeStatusBarItem.tooltip = "Austin sampling mode";

	context.subscriptions.push(
		vscode.commands.registerCommand(austinModeStatusBarItem.command, () => {
			// Show mode picker
			vscode.window.showQuickPick(
				["Wall time", "CPU time"], { "canPickMany": false }
			).then((value) => {
				if (value) {
					config.update("mode", value);
					austinModeStatusBarItem.text = `$(clock) ${value}`;
				}
			});
		})
	);

	if (vscode.window.activeTextEditor?.document.languageId == "python") {
		austinModeStatusBarItem.show();
		austinIntervalStatusBarItem.show();
	}


	vscode.window.onDidChangeActiveTextEditor((event) => {
		if (event?.document.languageId == "python") {
			austinModeStatusBarItem.show();
			austinIntervalStatusBarItem.show();
		}
		else {
			austinModeStatusBarItem.hide();
			austinIntervalStatusBarItem.hide();
		}
	});

}


export function deactivate() { }
