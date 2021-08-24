import * as vscode from 'vscode';
import { AustinStats, TopStats } from '../model';

function _normalizeScope(scope: string) {
    let head = scope.match(/^([PT])([x0-9A-Fa-f]+)$/);
    if (head === null) {
        return scope;
    }

    let [, type, id] = head;
    switch (type) {
        case 'P':
            return `Process ${id}`;
        case 'T':
            return `Thread ${id}`;
        default:
            return scope;
    }
}

export class CallStackItem extends vscode.TreeItem {

    constructor(
        public readonly stats: TopStats,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    ) {
        super(_normalizeScope(stats.scope!), collapsibleState);

        this.tooltip = stats.module ? `in ${stats.module}` : undefined;
        this.command = {
            command: 'austin-vscode.openSourceAtLine',
            title: "open source at line",
            arguments: [this.stats.module, Math.min(...this.stats.lines)]
        };
        // this.description = this.version;
    }

    // iconPath = {
    //     light: path.join(__filename, '..', '..', 'resources', 'light', 'dependency.svg'),
    //     dark: path.join(__filename, '..', '..', 'resources', 'dark', 'dependency.svg')
    // };

    // contextValue = 'dependency';
}



export class CallStackDataProvider implements vscode.TreeDataProvider<TopStats> {

    public static readonly viewType = 'austin-vscode.callStacks';

    private _onDidChangeTreeData: vscode.EventEmitter<TopStats | undefined | void> = new vscode.EventEmitter<TopStats | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<TopStats | undefined | void> = this._onDidChangeTreeData.event;
    private stats: AustinStats | null = null;

    refresh(stats: AustinStats) {
        this.stats = stats;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(v: TopStats): vscode.TreeItem {
        return new CallStackItem(v, v.callees.size > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    }

    getChildren(element?: TopStats): Thenable<TopStats[]> {
        if (!this.stats) {
            return Promise.resolve([]);
        }

        if (!element) {
            let callStack = [...this.stats?.callStack.callees.values()!];
            return Promise.resolve(callStack);
        } else {
            return Promise.resolve([...element.callees.values()]);
        }
    }
}

