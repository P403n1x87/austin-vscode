import * as vscode from 'vscode';
import { clearDecorations, formatInterval, setLinesHeat } from './view';
import { FlameGraphViewProvider } from './providers/flamegraph';
import { AustinController } from './controller';
import { AustinStats } from './model';
import { TopViewProvider } from './providers/top';
import { GCTopViewProvider } from './providers/gctop';
import { MetadataViewProvider } from './providers/metadata';
import { CallStackViewProvider } from './providers/callstack';
import { AustinProfileTaskProvider } from './providers/task';
import { AustinRuntimeSettings } from './settings';
import { AustinMode } from './types';
import { onAustinTerminated, getCurrentExecutor } from './providers/executor';
import { AUSTIN_MIN_MAJOR, AustinVersionError, checkAustinVersion } from './utils/versionCheck';
import { AustinMcpServer } from './providers/mcp';
import { updateMcpJsonIfPresent, writeMcpJson } from './utils/mcpJson';


export async function activate(context: vscode.ExtensionContext) {
	vscode.workspace.onDidChangeTextDocument((_changeEvent) => {
		clearDecorations();
	});

	const stats = new AustinStats();

	const mcpServer = new AustinMcpServer();
	await mcpServer.start();
	stats.registerAfterCallback((s) => mcpServer.update(s));
	const mcpNeverChange = new vscode.EventEmitter<void>();
	context.subscriptions.push(
		mcpNeverChange,
		{ dispose: () => mcpServer.dispose() },
		vscode.lm.registerMcpServerDefinitionProvider('austin', {
			onDidChangeMcpServerDefinitions: mcpNeverChange.event,
			provideMcpServerDefinitions() {
				return [new vscode.McpHttpServerDefinition(
					'Austin',
					vscode.Uri.parse(`http://127.0.0.1:${mcpServer.port}/mcp`),
				)];
			},
		})
	);

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor?.document.uri.scheme === "file") {
				const lines = stats.locationMap.get(editor.document.uri.fsPath);
				if (lines) { setLinesHeat(lines, stats); }
				else { clearDecorations(); }
			}
		})
	);

	updateMcpJsonIfPresent(mcpServer.port);

	const output = vscode.window.createOutputChannel("Austin");
	output.appendLine(`Austin MCP server listening on http://127.0.0.1:${mcpServer.port}/mcp`);

	const austinProfileProvider = new AustinProfileTaskProvider(stats, output);
	const controller = new AustinController(stats, austinProfileProvider, output);

	const flameGraphViewProvider = new FlameGraphViewProvider(context.extensionUri);
	const topProvider = new TopViewProvider(context.extensionUri);
	const callStackProvider = new CallStackViewProvider(context.extensionUri);
	const gcTopProvider = new GCTopViewProvider(context.extensionUri);
	const metadataProvider = new MetadataViewProvider(context.extensionUri);

	stats.registerBeforeCallback(() => flameGraphViewProvider.showLoading());
	stats.registerBeforeCallback(() => topProvider.showLoading());
	stats.registerBeforeCallback(() => callStackProvider.showLoading());
	stats.registerBeforeCallback(() => metadataProvider.showLoading());
	stats.registerBeforeCallback(() => gcTopProvider.showLoading());
	stats.registerAfterCallback((stats) => flameGraphViewProvider.refresh(stats));
	stats.registerAfterCallback((stats) => topProvider.refresh(stats));
	stats.registerAfterCallback((stats) => callStackProvider.refresh(stats));
	stats.registerAfterCallback((stats) => metadataProvider.refresh(stats));
	stats.registerAfterCallback((stats) => gcTopProvider.refresh(stats));
	stats.registerErrorCallback(() => flameGraphViewProvider.showError());
	stats.registerErrorCallback(() => topProvider.showError());
	stats.registerErrorCallback(() => callStackProvider.showError());
	stats.registerErrorCallback(() => metadataProvider.showError());
	stats.registerErrorCallback(() => gcTopProvider.showError());
	stats.registerAfterCallback((stats) => {
		const editor = vscode.window.activeTextEditor;
		if (editor?.document.uri.scheme === "file") {
			const lines = stats.locationMap.get(editor.document.uri.fsPath);
			if (lines) { setLinesHeat(lines, stats); }
		}
	});

	flameGraphViewProvider.onFrameSelected((frameKey) => callStackProvider.focusPath(frameKey));
	callStackProvider.onFrameSelected((frameKey) => flameGraphViewProvider.focusFrame(frameKey));
	gcTopProvider.onThreadSelected((threadKey) => flameGraphViewProvider.focusThread(threadKey));

	mcpServer.setActions({
		loadFile: (path) => {
			try {
				stats.readFromFile(path);
			} catch (e) {
				vscode.window.showErrorMessage(`Failed to load profile: ${(e instanceof Error) ? e.message : e}`);
				return;
			}
			vscode.commands.executeCommand('austin-vscode.flame-graph.focus');
		},
		focusFrame: (frameKey) => {
			flameGraphViewProvider.focusFrame(frameKey);
			vscode.commands.executeCommand('austin-vscode.flame-graph.focus');
		},
		searchFrames: (term) => {
			flameGraphViewProvider.search(term);
			vscode.commands.executeCommand('austin-vscode.flame-graph.focus');
		},
	});

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
		vscode.window.registerWebviewViewProvider(GCTopViewProvider.viewType, gcTopProvider)
	);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(MetadataViewProvider.viewType, metadataProvider)
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
		vscode.commands.registerCommand('austin-vscode.generateMcpJson', async () => {
			const folders = vscode.workspace.workspaceFolders;
			if (!folders || folders.length === 0) {
				vscode.window.showErrorMessage('Austin: no workspace folder is open.');
				return;
			}
			const folder = folders.length === 1
				? folders[0]
				: await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select workspace folder for .mcp.json' });
			if (!folder) { return; }
			writeMcpJson(folder, mcpServer.port);
			vscode.window.showInformationMessage(`Austin: .mcp.json written to ${folder.uri.fsPath}`);
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

	// Note: We don't use controller.detach() which would call task.terminate().
	// Instead, we call requestDetach() directly on the executor to attempt killing
	// the austin process. The task only ends when the process actually exits
	// (via onAustinTerminated event). This allows the user to retry detaching
	// if the first attempt fails (e.g., wrong password in askpass).
	context.subscriptions.push(
		vscode.commands.registerCommand('austin-vscode.detach', () => {
			const executor = getCurrentExecutor();
			if (executor) {
				executor.requestDetach();
			}
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
				gcTopProvider.showLive();
				metadataProvider.showLive();
			}
		})
	);

	context.subscriptions.push(
		vscode.tasks.onDidEndTask((e) => {
			if (e.execution.task.definition.type === "austin") {
				controller.clearCurrentExecution(e.execution);
			}
		})
	);

	context.subscriptions.push(
		onAustinTerminated.event(() => {
			detachStatusBarItem.hide();
			pauseStatusBarItem.hide();
			stats.paused = false;
			pauseStatusBarItem.text = "$(debug-pause) Pause";
			pauseStatusBarItem.tooltip = "Pause UI refreshes (data collection continues)";
			flameGraphViewProvider.showOpenButton();
			topProvider.hideLive();
			callStackProvider.hideLive();
			gcTopProvider.hideLive();
			metadataProvider.hideLive();
		})
	);

	// ---- Consolidated Austin settings status bar item ----
	const austinSettingsStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	austinSettingsStatusBarItem.command = "austin-vscode.austinSettings";
	austinSettingsStatusBarItem.tooltip = "Austin profiler settings";

	let currentMode = AustinRuntimeSettings.getMode();
	let currentInterval = AustinRuntimeSettings.getInterval();
	let childrenEnabled = AustinRuntimeSettings.getChildren();
	let gcEnabled = AustinRuntimeSettings.getGC();

	const modeIcons: Record<string, string> = {
		[AustinMode.WallTime]: "$(clock)",
		[AustinMode.CpuTime]: "$(server-process)",
		[AustinMode.Memory]: "$(database)",
	};

	function updateAustinSettingsStatusBar() {
		const icon = modeIcons[currentMode] ?? "$(clock)";
		const interval = formatInterval(currentInterval);
		const flags = [
			...(childrenEnabled ? ["$(repo-forked)"] : []),
			...(gcEnabled ? ["$(trash)"] : []),
		];
		const flagsSuffix = flags.length > 0 ? ` ${flags.join(" ")}` : "";
		austinSettingsStatusBarItem.text = `Austin: ${icon} ${interval}${flagsSuffix}`;

		const tooltip = new vscode.MarkdownString(undefined, true);
		tooltip.isTrusted = true;
		tooltip.appendMarkdown(`**Austin VS Code Settings**\n\n`);
		tooltip.appendMarkdown(`| | |\n|---|---|\n`);
		tooltip.appendMarkdown(`| Mode | [${currentMode}](command:austin-vscode.mode) |\n`);
		tooltip.appendMarkdown(`| Interval | [${interval}](command:austin-vscode.interval) |\n`);
		tooltip.appendMarkdown(`| Children | [Toggle](command:austin-vscode.toggleChildren) |\n`);
		tooltip.appendMarkdown(`| GC | [Toggle](command:austin-vscode.toggleGC) |\n`);
		austinSettingsStatusBarItem.tooltip = tooltip;
	}
	updateAustinSettingsStatusBar();

	context.subscriptions.push(
		vscode.commands.registerCommand("austin-vscode.austinSettings", async () => {
			const interval = formatInterval(currentInterval);

			const items: vscode.QuickPickItem[] = [
				{ label: `$(clock) Mode: ${currentMode}`, description: "Change sampling mode" },
				{ label: `$(watch) Interval: ${interval}`, description: "Change sampling interval" },
				{ label: `$(type-hierarchy-sub) Children: ${childrenEnabled ? "ON" : "OFF"}`, description: "Toggle child process profiling (-C)" },
				{ label: `$(trash) GC: ${gcEnabled ? "ON" : "OFF"}`, description: "Toggle GC data collection (-g)" },
			];

			const selected = await vscode.window.showQuickPick(items, {
				title: "Austin VS Code Settings",
				placeHolder: "Select a setting to change",
			});

			if (!selected) { return; }

			if (selected.label.includes("Mode:")) {
				vscode.commands.executeCommand("austin-vscode.mode");
			} else if (selected.label.includes("Interval:")) {
				vscode.commands.executeCommand("austin-vscode.interval");
			} else if (selected.label.includes("Children:")) {
				vscode.commands.executeCommand("austin-vscode.toggleChildren");
			} else if (selected.label.includes("GC:")) {
				vscode.commands.executeCommand("austin-vscode.toggleGC");
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("austin-vscode.interval", () => {
			vscode.window.showInputBox({
				"value": currentInterval.toString(),
				"prompt": "Enter new Austin sampling interval",
				"validateInput": (value) => {
					if (isNaN(parseInt(value)) || !/^\d+$/.test(value)) { return "The interval must be an integer."; }
				},
			}).then((value) => {
				if (value) {
					const newInterval = parseInt(value);
					currentInterval = newInterval;
					AustinRuntimeSettings.setInterval(newInterval);
					updateAustinSettingsStatusBar();
				}
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("austin-vscode.mode", () => {
			vscode.window.showQuickPick(
				["Wall time", "CPU time", "Memory"],
				{
					"title": "Pick Austin sampling mode",
					"canPickMany": false
				}
			).then((value) => {
				if (value) {
					currentMode = value as AustinMode;
					AustinRuntimeSettings.setMode(currentMode);
					updateAustinSettingsStatusBar();
				}
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("austin-vscode.toggleChildren", () => {
			childrenEnabled = !childrenEnabled;
			AustinRuntimeSettings.setChildren(childrenEnabled);
			updateAustinSettingsStatusBar();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("austin-vscode.toggleGC", () => {
			gcEnabled = !gcEnabled;
			AustinRuntimeSettings.setGC(gcEnabled);
			updateAustinSettingsStatusBar();
		})
	);

	austinSettingsStatusBarItem.show();

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
