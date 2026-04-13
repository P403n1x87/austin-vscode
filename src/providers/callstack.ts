import * as vscode from 'vscode';
import { AustinStats, TopStats } from '../model';
import { hashPath } from '../utils/pathKey';
import { loadWebviewHtml } from '../utils/webviewHtml';

interface CallStackNode {
    frameKey: number;
    scope: string;
    module: string | null;
    own: number;
    total: number;
    line: number;
    children: CallStackNode[];
    childrenPending?: boolean;
}

function normalizeScope(scope: string): string {
    const match = scope.match(/^([PT])([x0-9A-Fa-f]+)$/);
    if (!match) { return scope; }
    const [, type, id] = match;
    return type === 'P' ? `Process ${id}` : `Thread ${id}`;
}

function serializeNode(node: TopStats, parentHash: number, depth: number): CallStackNode {
    const scope = normalizeScope(node.scope ?? '');
    const key = node.module ? `${node.module}:${scope}` : scope;
    const frameKey = hashPath(key, parentHash);
    const hasChildren = node.callees.size > 0;
    return {
        frameKey,
        scope,
        module: node.module || null,
        own: node.own,
        total: node.total,
        line: node.minLine,
        children: depth > 0
            ? [...node.callees.values()].map(child => serializeNode(child, frameKey, depth - 1))
            : [],
        childrenPending: hasChildren && depth <= 0,
    };
}

export class CallStackViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'austin-vscode.callStacks';

    private _view?: vscode.WebviewView;
    private _stats: AustinStats | null = null;
    private _initialized: boolean = false;
    private _onFrameSelected?: (frameKey: number) => void;
    private _nodeMap: Map<number, TopStats> = new Map();

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
            if (data.requestChildren !== undefined) {
                const parentFrameKey = data.requestChildren as number;
                const node = this._nodeMap.get(parentFrameKey);
                if (node) {
                    const children = [...node.callees.values()].map(child => serializeNode(child, parentFrameKey, 3));
                    this._view?.webview.postMessage({ childrenFor: parentFrameKey, children });
                }
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

    private _buildNodeMap(node: TopStats, parentHash: number): void {
        const scope = normalizeScope(node.scope ?? '');
        const key = node.module ? `${node.module}:${scope}` : scope;
        const frameKey = hashPath(key, parentHash);
        this._nodeMap.set(frameKey, node);
        for (const child of node.callees.values()) {
            this._buildNodeMap(child, frameKey);
        }
    }

    private _postData(stats: AustinStats) {
        this._nodeMap.clear();
        for (const node of stats.callStack.callees.values()) {
            this._buildNodeMap(node, 0);
        }
        const tree = [...stats.callStack.callees.values()].map(node => serializeNode(node, 0, 3));
        this._view!.webview.postMessage({ tree });
    }

    private _getHtml(webview: vscode.Webview): string {
        return loadWebviewHtml(this._extensionUri, 'callstack.html', {
            scriptUri:   String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'callstack.js'))),
            codiconsUri: String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'codicons', 'codicon.css'))),
            viewsCssUri: String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'views.css'))),
            cssUri:      String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'callstack.css'))),
        });
    }
}
