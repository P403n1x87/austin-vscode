import * as vscode from 'vscode';
import { AustinStats, TopStats } from '../model';

function _normalizeScope(scope: string) {
    switch (scope?.charAt(0)) {
        case 'P':
            return `Process ${scope.slice(1)}`;
        case 'T':
            return `Thread ${scope.slice(1)}`;
        default:
            return scope;
    }
}

export class CallStackItem extends vscode.TreeItem {

    constructor(
        public readonly stats: TopStats,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        // public readonly command?: vscode.Command
    ) {
        super(_normalizeScope(stats.scope!), collapsibleState);

        this.tooltip = stats.module ? `in ${stats.module}` : undefined;
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

