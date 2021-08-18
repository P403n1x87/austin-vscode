import { AustinMode, AustinSettings } from "./types";
import * as vscode from 'vscode';

export const DEFAULT_PATH = "austin";
export const DEFAULT_INTERVAL = 100;
export const DEFAULT_MODE = AustinMode.WallTime;

export class AustinRuntimeSettings {
    private static config = vscode.workspace.getConfiguration('austin');
    private static instance: AustinRuntimeSettings;
    // Keep me private
    private constructor() {
        const austinPath = AustinRuntimeSettings.config.get<string>("path", DEFAULT_PATH);
        const austinInterval: number = AustinRuntimeSettings.config.get<number>("interval",  DEFAULT_INTERVAL);
        const austinMode: AustinMode = AustinRuntimeSettings.config.get("mode", DEFAULT_MODE);

        this.settings = {
            path: austinPath,
            mode: austinMode,
            interval: austinInterval
        };
    }

    public static get(): AustinRuntimeSettings {
        if (!AustinRuntimeSettings.instance) {
            AustinRuntimeSettings.instance = new AustinRuntimeSettings();
        }

        return AustinRuntimeSettings.instance;
    }

    settings: AustinSettings;

    public static getPath(): string { 
        return AustinRuntimeSettings.get().settings.path;
    }

    public static setPath(newPath: string) { 
        AustinRuntimeSettings.config.update("path", newPath);
        AustinRuntimeSettings.get().settings.path = newPath;
    }

    public static resetPath() {
        AustinRuntimeSettings.get().settings.path = AustinRuntimeSettings.config.get<string>("path", DEFAULT_PATH);
    }

    public static getInterval(): number { 
        return AustinRuntimeSettings.get().settings.interval;
    }

    public static setInterval(newInterval: number) { 
        AustinRuntimeSettings.config.update("interval", newInterval);
        AustinRuntimeSettings.get().settings.interval = newInterval;
    }

    public static resetInterval() {
        AustinRuntimeSettings.get().settings.interval = AustinRuntimeSettings.config.get<number>("interval",  DEFAULT_INTERVAL);
    }

    public static getMode(): AustinMode {
        return AustinRuntimeSettings.get().settings.mode;
    }

    public static setMode(newMode: AustinMode) {
        AustinRuntimeSettings.config.update("mode", newMode);
        AustinRuntimeSettings.get().settings.mode = newMode;
    }

    public static resetMode() {
        AustinRuntimeSettings.get().settings.mode = AustinRuntimeSettings.config.get("mode", DEFAULT_MODE);
    }
}
