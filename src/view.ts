import * as vscode from 'vscode';
import { AustinStats, FrameObject } from './model';
import { AustinRuntimeSettings } from './settings';
import { AustinLineStats } from './types';


let decorators: vscode.TextEditorDecorationType[] = [];


export function clearDecorations() {
    decorators.forEach((ld) => ld.dispose());
    decorators = [];
}


function formatTime(microseconds: number) {
    // Convert microseconds to a string, choosing units that are the most
    // appropriate for the magnitude of the time.
    if (microseconds < 1000) {
        return microseconds.toFixed(0) + "μs";
    }
    if (microseconds < 1000 * 1000) {
        return (microseconds / 1000).toFixed(2) + "ms";
    }
    if (microseconds < 1000 * 1000 * 1000) {
        return (microseconds / (1000 * 1000)).toFixed(2) + "s";
    }
    return (microseconds / (1000 * 1000 * 1000)).toFixed(2) + "m";
}

function formatMemory(bytes: number) {
    // Convert bytes to a string, choosing units that are the most
    // appropriate for the magnitude of the memory.
    if (bytes < 1024) {
        return bytes.toFixed(0) + "B";
    }
    if (bytes < 1024 * 1024) {
        return (bytes / 1024).toFixed(2) + "KB";
    }
    if (bytes < 1024 * 1024 * 1024) {
        return (bytes / (1024 * 1024)).toFixed(2) + "MB";
    }
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + "GB";
}

function setLineHeat(frame: FrameObject, own: number, total: number, overallTotal: number, localTotal: number, mode: string) {
    const editor = vscode.window.activeTextEditor;
    if (editor !== undefined) {
        const opacity = 0.6 * Math.sqrt(own / localTotal);
        var color: string | undefined = undefined;

        switch (mode) {
            case "cpu":
                color = `rgba(255, 64, 64, ${opacity})`;
                break;
            case "wall":
                color = `rgba(192, 192, 64, ${opacity})`;
                break;
            case "memory":
                color = `rgba(64, 192, 64, ${opacity})`;
                break;
        }

        const columnDelta = (frame.columnEnd || 0) - (frame.column || 0);
        const lineDecorator = vscode.window.createTextEditorDecorationType({
            backgroundColor: color,
            overviewRulerColor: color,
            overviewRulerLane: 1,
            isWholeLine: !columnDelta,
        });

        if (!columnDelta) {
            editor.setDecorations(lineDecorator, [new vscode.Range(
                editor.document.lineAt(frame.line - 1).range.start,
                editor.document.lineAt((frame.lineEnd ? Math.max(frame.lineEnd, frame.line) : frame.line) - 1).range.end
            )]);
        }
        else {
            // If we have column data we must have full line data too.
            let start = new vscode.Position(Math.max(frame.line - 1, 0), Math.max(frame.column! - 1, 0));
            let end = new vscode.Position(Math.max(frame.lineEnd! - 1, 0), Math.max(frame.columnEnd! - 1, 0));
            editor.setDecorations(lineDecorator, [new vscode.Range(start, end)]);
        }

        decorators.push(lineDecorator);
    }
}

function setLinesStats(lineStats: Map<number, [number, number]>, overallTotal: number, localTotal: number, mode: string) {
    const editor = vscode.window.activeTextEditor;
    const lineStatsType = AustinRuntimeSettings.get().settings.lineStats;

    if (editor === undefined) {
        return;
    }

    lineStats.forEach((v, k) => {
        let [own, total] = v;
        if (total === 0) {
            return;
        }

        let ownString = null;
        let totalString = null;

        const ownp = (own * 100 / overallTotal).toFixed(2);
        const totalp = (total * 100 / overallTotal).toFixed(2);

        const formatter = mode === "memory" ? formatMemory : formatTime;

        switch (lineStatsType) {
            case AustinLineStats.PERCENT:
                if (totalp === "0.00") {
                    return;
                }

                ownString = `${ownp}%`;
                totalString = `${totalp}%`;

                break;

            case AustinLineStats.ABSOLUTE:
                ownString = formatter(own);
                totalString = formatter(total);

                break;

            case AustinLineStats.BOTH:
                ownString = `${formatter(own)} (${ownp}%)`;
                totalString = `${formatter(total)} (${totalp}%)`;
        }

        const lineDecorator = vscode.window.createTextEditorDecorationType({
            after: {
                contentText: `    own: ${ownString}, total: ${totalString}`,
                color: "rgb(128,128,128)",
                margin: "8px",
            },
        });

        let content = editor.document.lineAt(k - 1).text.trim();

        if (content.length === 0 || content[0] === "#") {
            // Skip empty lines and comments
            return;
        }

        editor.setDecorations(lineDecorator, [new vscode.Range(
            editor.document.lineAt(k - 1).range.start,
            editor.document.lineAt(k - 1).range.end
        )]);

        decorators.push(lineDecorator);
    });
}

export function setLinesHeat(locations: Map<string, [FrameObject, number, number]>, stats: AustinStats) {
    clearDecorations();

    const overallTotal = stats.overallTotal;
    const localTotal = Array.from(locations.values()).map(v => v[1]).reduce((s, c) => s + c, 0);
    let lineStats = new Map<number, [number, number]>();
    let mode = stats.metadata.getDefault("mode", () => "cpu");

    locations.forEach((v, k) => {
        let [fo, own, total] = v;

        setLineHeat(fo, own, total, overallTotal, localTotal, mode);

        for (let i = fo.line; i <= (fo.lineEnd ? Math.max(fo.lineEnd, fo.line) : fo.line); i++) {
            if (lineStats.has(i)) {
                let [ownSum, totalSum] = lineStats.get(i)!;
                lineStats.set(i, [ownSum + own, totalSum + total]);
            }
            else {
                lineStats.set(i, [own, total]);
            }
        }
    });

    setLinesStats(lineStats, overallTotal, localTotal, mode);
}


export function formatInterval(interval: number) {
    if (interval >= 10000000) {
        return `${Math.floor(interval / 1000000)} s`;
    }
    if (interval >= 1000000) {
        return `${(interval / 1000000).toFixed(1)} s`;
    }

    if (interval >= 10000) {
        return `${Math.floor(interval / 1000)} ms`;
    }
    if (interval >= 1000) {
        return `${(interval / 1000).toFixed(1)} ms`;
    }

    return `${interval} μs`;
};
