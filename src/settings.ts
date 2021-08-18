import { AustinMode, AustinSettings } from "./types";
import * as vscode from 'vscode';

export class AustinRuntimeSettings {
    private static config = vscode.workspace.getConfiguration('austin');
    private static instance: AustinRuntimeSettings;
    // Keep me private
    private constructor() {
        const austinPath = AustinRuntimeSettings.config.get<string>("path") || "austin";
        const austinInterval: number = parseInt(AustinRuntimeSettings.config.get("interval") || "100");
        const austinMode: AustinMode = AustinRuntimeSettings.config.get("mode") || AustinMode.WallTime;

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

    public static getInterval(): number { 
        return AustinRuntimeSettings.get().settings.interval;
    }

    public static updateInterval(newInterval: number) { 
        AustinRuntimeSettings.config.update("interval", newInterval);
        AustinRuntimeSettings.get().settings.interval = newInterval;
    }

    public static getMode(): AustinMode {
        return AustinRuntimeSettings.get().settings.mode;
    }

    public static setMode(newMode: AustinMode) {
        AustinRuntimeSettings.config.update("mode", newMode);
    }
}