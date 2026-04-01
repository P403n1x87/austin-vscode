import { AustinLineStats, AustinMode, AustinSettings } from "./types";
import * as vscode from 'vscode';

export const DEFAULT_PATH = "austin";
export const DEFAULT_INTERVAL = 100;
export const DEFAULT_MODE = AustinMode.WallTime;
export const DEFAULT_LINE_STATS = AustinLineStats.PERCENT;

export class AustinRuntimeSettings {
    private static config = vscode.workspace.getConfiguration('austin');
    // Keep me private
    private constructor() {
        // Get the latest settings
        AustinRuntimeSettings.config = vscode.workspace.getConfiguration('austin');

        let austinPath = AustinRuntimeSettings.config.get<string>("path", DEFAULT_PATH);
        if (austinPath === "") {
            austinPath = DEFAULT_PATH;
        }
        const austinInterval: number = AustinRuntimeSettings.config.get<number>("interval", DEFAULT_INTERVAL);
        const austinMode: AustinMode = AustinRuntimeSettings.config.get("mode", DEFAULT_MODE);
        const austinLineStats: AustinLineStats = AustinRuntimeSettings.config.get("lineStats", DEFAULT_LINE_STATS);
        const austinChildren: boolean = AustinRuntimeSettings.config.get("children", false);

        this.settings = {
            path: austinPath,
            mode: austinMode,
            interval: austinInterval,
            lineStats: austinLineStats,
            children: austinChildren,
        };
    }

    public static get(): AustinRuntimeSettings {
        return new AustinRuntimeSettings();
    }

    settings: AustinSettings;

    public static getPath(): string {
        return AustinRuntimeSettings.get().settings.path;
    }

    public static setPath(newPath: string) {
        AustinRuntimeSettings.config.update("path", newPath, vscode.ConfigurationTarget.Global);
    }

    public static getInterval(): number {
        return AustinRuntimeSettings.get().settings.interval;
    }

    public static setInterval(newInterval: number) {
        AustinRuntimeSettings.config.update("interval", newInterval, vscode.ConfigurationTarget.Global);
    }

    public static getMode(): AustinMode {
        return AustinRuntimeSettings.get().settings.mode;
    }

    public static setMode(newMode: AustinMode) {
        AustinRuntimeSettings.config.update("mode", newMode, vscode.ConfigurationTarget.Global);
    }

    public static getLineStats(): AustinLineStats {
        return AustinRuntimeSettings.get().settings.lineStats;
    }

    public static setLineStats(newLineStats: AustinLineStats) {
        AustinRuntimeSettings.config.update("lineStats", newLineStats, vscode.ConfigurationTarget.Global);
    }

    public static getChildren(): boolean {
        return AustinRuntimeSettings.get().settings.children;
    }

    public static setChildren(children: boolean) {
        AustinRuntimeSettings.config.update("children", children, vscode.ConfigurationTarget.Global);
    }
}
