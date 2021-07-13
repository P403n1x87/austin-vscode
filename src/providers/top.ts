import * as vscode from 'vscode';
import { AustinStats, TopStats } from '../model';

export class TopItem extends vscode.TreeItem {

    constructor(
        public readonly stats: TopStats,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    ) {
        super(`[ ${(stats.own * 100).toFixed(2)}% | ${(stats.total * 100).toFixed(2)}% ] ${stats.scope}`, collapsibleState);

        this.tooltip = `in ${stats.module}`;
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


export class TopDataProvider implements vscode.TreeDataProvider<TopStats> {

    public static readonly viewType = 'austin-vscode.top';

    private _onDidChangeTreeData: vscode.EventEmitter<TopStats | undefined | void> = new vscode.EventEmitter<TopStats | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<TopStats | undefined | void> = this._onDidChangeTreeData.event;
    private stats: AustinStats | null = null;

    refresh(stats: AustinStats) {
        this.stats = stats;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(v: TopStats): vscode.TreeItem {
        return new TopItem(v, v.callers.size > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    }

    getChildren(element?: TopStats): Thenable<TopStats[]> {
        if (!this.stats) {
            return Promise.resolve([]);
        }

        if (!element) {
            let top = [...this.stats?.top.values()!].sort((a, b) => b.own - a.own);
            return Promise.resolve(top);
        } else {
            return Promise.resolve([...element.callers.values()]);
        }
    }
}
