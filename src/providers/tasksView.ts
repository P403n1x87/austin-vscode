import * as vscode from 'vscode';
import { AustinStats, TaskSummary } from '../model';
import { formatMemory, formatTime } from '../view';
import { loadWebviewHtml } from '../utils/webviewHtml';

// The shape sent to the webview mirrors CallStackNode (see callstack.ts) --
// same field names (own/total/file/line/frameKey/children) so tasks.js can
// reuse callstack.js's row-rendering conventions almost verbatim, with
// pre-formatted text instead of a raw fraction since task own/total are
// absolute durations (or bytes), not shares of a whole.
interface TaskRowNode {
    frameKey?: number;
    rowKey: string; // stable even when frameKey is absent (task not yet attached)
    name: string;
    module: string | null;
    line: number;
    own: number;
    total: number;
    ownText: string;
    totalText: string;
    children: TaskRowNode[];
}

export class TasksViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'austin-vscode.tasks';

    private _view?: vscode.WebviewView;
    private _stats: AustinStats | null = null;
    private _initialized: boolean = false;
    private _onFrameSelected?: (frameKey: number) => void;

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        this._initialized = false;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.onDidReceiveMessage(data => {
            if (data === 'initialized') {
                this._initialized = true;
                if (this._stats) { this._postData(this._stats); }
                return;
            }
            if (data === 'open') {
                vscode.commands.executeCommand('austin-vscode.load');
                return;
            }
            if (data === 'attach') {
                vscode.commands.executeCommand('austin-vscode.attach');
                return;
            }
            if (data.module) {
                vscode.commands.executeCommand('austin-vscode.openSourceAtLine', data.module, data.line || 0);
            }
            if (data.frameKey !== undefined && this._onFrameSelected) {
                this._onFrameSelected(data.frameKey);
            }
        });

        webviewView.webview.html = this._getHtml(webviewView.webview);
    }

    public onFrameSelected(cb: (frameKey: number) => void) {
        this._onFrameSelected = cb;
    }

    public showLoading() {
        this._view?.webview.postMessage({ loading: true });
    }

    public showError() {
        this._view?.webview.postMessage({ error: true });
    }

    public showLive() {
        this._view?.webview.postMessage({ live: true });
    }

    public hideLive() {
        this._view?.webview.postMessage({ live: false });
    }

    public focusPath(frameKey: number) {
        this._view?.webview.postMessage({ focus: { frameKey } });
    }

    public refresh(stats: AustinStats) {
        this._stats = stats;
        if (this._view && this._initialized) { this._postData(stats); }
    }

    private _formatter(stats: AustinStats): (n: number) => string {
        const mode = stats.metadata.getDefault("mode", () => "cpu");
        return mode === "memory" ? formatMemory : formatTime;
    }

    private _serializeTask(task: TaskSummary, fmt: (n: number) => string): TaskRowNode {
        return {
            frameKey: task.frameKey,
            rowKey: task.id,
            name: task.name,
            module: task.file ?? null,
            line: task.line ?? 0,
            own: task.own,
            total: task.total,
            ownText: task.own > 0 ? fmt(task.own) : '',
            totalText: task.total > 0 ? fmt(task.total) : '',
            children: task.children.map(child => this._serializeTask(child, fmt)),
        };
    }

    private _postData(stats: AustinStats) {
        const fmt = this._formatter(stats);
        const tree = stats.getTaskForest()
            .flatMap(group => group.tasks)
            .map(task => this._serializeTask(task, fmt));
        this._view!.webview.postMessage({ tree });
    }

    private _getHtml(webview: vscode.Webview): string {
        return loadWebviewHtml(this._extensionUri, 'tasks.html', {
            // Loaded before scriptUri so tasks.js can use the same shared
            // esc()/etc. helpers as the flamegraph webview instead of its
            // own hand-copied duplicates.
            utilsScriptUri: String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'flamegraph-utils.js'))),
            scriptUri:   String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'tasks.js'))),
            codiconsUri: String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'codicons', 'codicon.css'))),
            viewsCssUri: String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'views.css'))),
            cssUri:      String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'tasks.css'))),
        });
    }
}
