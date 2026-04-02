import * as vscode from 'vscode';
import { clearDecorations, formatInterval, setLinesHeat } from './view';
import { FlameGraphViewProvider } from './providers/flamegraph';
import { AustinController } from './controller';
import { AustinStats } from './model';
import { TopViewProvider } from './providers/top';
import { CallStackViewProvider } from './providers/callstack';
import { AustinProfileTaskProvider } from './providers/task';
import { AustinRuntimeSettings } from './settings';
import { AustinMode } from './types';
import { AUSTIN_MIN_MAJOR, AustinVersionError, checkAustinVersion } from './utils/versionCheck';
import { AustinMcpServer } from './providers/mcp';


export function activate(context: vscode.ExtensionContext) {
	vscode.workspace.onDidChangeTextDocument((_changeEvent) => {
		clearDecorations();
	});

	const stats = new AustinStats();

	const mcpPort = AustinRuntimeSettings.getMcpPort();
	if (mcpPort > 0) {
		const mcpServer = new AustinMcpServer(mcpPort);
		stats.registerAfterCallback((s) => mcpServer.update(s));
		context.subscriptions.push({ dispose: () => mcpServer.dispose() });
	}

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor?.document.uri.scheme === "file") {
				const lines = stats.locationMap.get(editor.document.uri.fsPath);
				if (lines) { setLinesHeat(lines, stats); }
				else { clearDecorations(); }
			}
		})
	);

	const output = vscode.window.createOutputChannel("Austin");

	const austinProfileProvider = new AustinProfileTaskProvider(stats, output);
	const controller = new AustinController(stats, austinProfileProvider, output);

	const flameGraphViewProvider = new FlameGraphViewProvider(context.extensionUri);
	const topProvider = new TopViewProvider(context.extensionUri);
	const callStackProvider = new CallStackViewProvider(context.extensionUri);

	stats.registerBeforeCallback(() => flameGraphViewProvider.showLoading());
	stats.registerBeforeCallback(() => topProvider.showLoading());
	stats.registerBeforeCallback(() => callStackProvider.showLoading());
	stats.registerAfterCallback((stats) => flameGraphViewProvider.refresh(stats));
	stats.registerAfterCallback((stats) => topProvider.refresh(stats));
	stats.registerAfterCallback((stats) => callStackProvider.refresh(stats));
	stats.registerErrorCallback(() => flameGraphViewProvider.showError());
	stats.registerErrorCallback(() => topProvider.showError());
	stats.registerErrorCallback(() => callStackProvider.showError());
	stats.registerAfterCallback((stats) => {
		const editor = vscode.window.activeTextEditor;
		if (editor?.document.uri.scheme === "file") {
			const lines = stats.locationMap.get(editor.document.uri.fsPath);
			if (lines) { setLinesHeat(lines, stats); }
		}
	});

	flameGraphViewProvider.onFrameSelected((pathKey) => callStackProvider.focusPath(pathKey));
	callStackProvider.onFrameSelected((pathKey) => flameGraphViewProvider.focusFrame(pathKey));

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			FlameGraphViewProvider.viewType,
			flameGraphViewProvider,
		)
	);

	context.subscriptions.push(
		vscode.tasks.registerTaskProvider("austin", austinProfileProvider)
	);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(TopViewProvider.viewType, topProvider)
	);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(CallStackViewProvider.viewType, callStackProvider)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('austin-vscode.profile', () => {
			controller.profileScript();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('austin-vscode.attach', () => {
			controller.attachProcess();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('austin-vscode.load', () => {
			controller.openSampleFile();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('austin-vscode.openSourceAtLine', (module: string, line: number) => {
			controller.openSourceFileAtLine(module, line);
		})
	);

	// ---- Stop/detach status bar item (shown while a profiling session is active) ----
	const detachStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 200);
	detachStatusBarItem.command = "austin-vscode.detach";
	detachStatusBarItem.tooltip = "Stop Austin";
	detachStatusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");

	context.subscriptions.push(
		vscode.commands.registerCommand('austin-vscode.detach', () => {
			controller.detach();
		})
	);

	// ---- Pause/resume status bar item ----
	const pauseStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 199);
	pauseStatusBarItem.command = "austin-vscode.togglePause";
	pauseStatusBarItem.text = "$(debug-pause) Pause";
	pauseStatusBarItem.tooltip = "Pause UI refreshes (data collection continues)";

	context.subscriptions.push(
		vscode.commands.registerCommand('austin-vscode.togglePause', () => {
			stats.paused = !stats.paused;
			if (stats.paused) {
				pauseStatusBarItem.text = "$(debug-continue) Resume";
				pauseStatusBarItem.tooltip = "Resume UI refreshes";
			} else {
				pauseStatusBarItem.text = "$(debug-pause) Pause";
				pauseStatusBarItem.tooltip = "Pause UI refreshes (data collection continues)";
				stats.refresh();
			}
		})
	);

	context.subscriptions.push(
		vscode.tasks.onDidStartTask((e) => {
			if (e.execution.task.definition.type === "austin") {
				const isAttach = e.execution.task.definition.pid !== undefined;
				detachStatusBarItem.text = isAttach
					? "$(debug-disconnect) Detach Austin"
					: "$(debug-stop) Terminate Austin";
				detachStatusBarItem.show();
				pauseStatusBarItem.show();
				flameGraphViewProvider.showDetachButton(isAttach);
				topProvider.showLive();
				callStackProvider.showLive();
			}
		})
	);

	context.subscriptions.push(
		vscode.tasks.onDidEndTask((e) => {
			if (e.execution.task.definition.type === "austin") {
				controller.clearCurrentExecution(e.execution);
				detachStatusBarItem.hide();
				pauseStatusBarItem.hide();
				stats.paused = false;
				pauseStatusBarItem.text = "$(debug-pause) Pause";
				pauseStatusBarItem.tooltip = "Pause UI refreshes (data collection continues)";
				flameGraphViewProvider.showOpenButton();
				topProvider.hideLive();
				callStackProvider.hideLive();
			}
		})
	);

	// ---- Interval selector ----
	const austinIntervalStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

	austinIntervalStatusBarItem.command = "austin-vscode.interval";
	austinIntervalStatusBarItem.text = formatInterval(AustinRuntimeSettings.getInterval());
	austinIntervalStatusBarItem.tooltip = "Austin sampling interval";

	context.subscriptions.push(
		vscode.commands.registerCommand(austinIntervalStatusBarItem.command, () => {
			// Show interval dialog
			vscode.window.showInputBox({
				"value": AustinRuntimeSettings.getInterval().toString(),
				"prompt": "Enter new Austin sampling interval",
				"validateInput": (value) => {
					if (isNaN(parseInt(value)) || !/^\d+$/.test(value)) { return "The interval must be an integer."; }
				},
			}).then((value) => {
				if (value) {
					const newInterval = parseInt(value);
					AustinRuntimeSettings.setInterval(newInterval);
					austinIntervalStatusBarItem.text = formatInterval(newInterval);
				}
			});
		})
	);


	// ---- Children toggle ----
	const childrenStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	childrenStatusBarItem.command = "austin-vscode.toggleChildren";
	childrenStatusBarItem.tooltip = "Toggle profiling of child processes (-C)";

	let childrenEnabled = AustinRuntimeSettings.getChildren();

	function updateChildrenStatusBar() {
		childrenStatusBarItem.text = childrenEnabled
			? "$(type-hierarchy-sub) Children: ON"
			: "$(type-hierarchy-sub) Children: OFF";
	}
	updateChildrenStatusBar();

	context.subscriptions.push(
		vscode.commands.registerCommand("austin-vscode.toggleChildren", () => {
			childrenEnabled = !childrenEnabled;
			AustinRuntimeSettings.setChildren(childrenEnabled);
			updateChildrenStatusBar();
		})
	);

	childrenStatusBarItem.show();

	// ---- Mode selector ----
	const austinModeStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

	austinModeStatusBarItem.command = "austin-vscode.mode";
	austinModeStatusBarItem.text = `$(clock) ${AustinRuntimeSettings.getMode()}`;
	austinModeStatusBarItem.tooltip = "Austin sampling mode";

	context.subscriptions.push(
		vscode.commands.registerCommand(austinModeStatusBarItem.command, () => {
			// Show mode picker
			vscode.window.showQuickPick(
				["Wall time", "CPU time", "Memory"],
				{
					"title": "Pick Austin sampling mode",
					"canPickMany": false
				}
			).then((value) => {
				if (value) {
					AustinRuntimeSettings.setMode(value as AustinMode);
					austinModeStatusBarItem.text = `$(clock) ${value}`;
				}
			});
		})
	);

	austinModeStatusBarItem.show();
	austinIntervalStatusBarItem.show();

	// Detect austin on activation
	(async () => {
		try {
			await checkAustinVersion(AustinRuntimeSettings.getPath());
		} catch (e) {
			if (e instanceof AustinVersionError) {
				const selection = await vscode.window.showWarningMessage(
					`${e.message} Upgrade it via pip or point the extension to a newer binary via the austin.path setting.`,
					'Upgrade via pip',
					'Set Austin path',
					'Installation guide'
				);
				if (selection === 'Upgrade via pip') {
					const terminal = vscode.window.createTerminal({ name: 'Upgrade Austin' });
					terminal.sendText('pip install --upgrade austin-dist');
					terminal.show();
				} else if (selection === 'Set Austin path') {
					vscode.commands.executeCommand('workbench.action.openSettings', 'austin.path');
				} else if (selection === 'Installation guide') {
					vscode.env.openExternal(vscode.Uri.parse('https://github.com/P403n1x87/austin?tab=readme-ov-file#installation'));
				}
			} else {
				const selection = await vscode.window.showInformationMessage(
					`Austin profiler was not detected. Install it via pip (requires Austin >= ${AUSTIN_MIN_MAJOR}.0.0). For custom installations, set the path to the binary via the austin.path extension setting.`,
					'Install via pip',
					'Set Austin path',
					'Installation guide'
				);
				if (selection === 'Install via pip') {
					const terminal = vscode.window.createTerminal({ name: 'Install Austin' });
					terminal.sendText('pip install austin-dist');
					terminal.show();
				} else if (selection === 'Set Austin path') {
					vscode.commands.executeCommand('workbench.action.openSettings', 'austin.path');
				} else if (selection === 'Installation guide') {
					vscode.env.openExternal(vscode.Uri.parse('https://github.com/P403n1x87/austin?tab=readme-ov-file#installation'));
				}
			}
		}
	})();
}


export function deactivate() { }
