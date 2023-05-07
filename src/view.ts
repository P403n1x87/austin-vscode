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

function setLineHeat(frame: FrameObject, own: number, total: number, overallTotal: number, localTotal: number, mode: string) {
    const editor = vscode.window.activeTextEditor;
    if (editor !== undefined) {
        const opacity = own / localTotal;
        const color: string = mode === "cpu"
            ? `rgba(255, 64, 64, ${opacity})`
            : `rgba(192, 192, 64, ${opacity})`;
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
                editor.document.lineAt((frame.lineEnd ? frame.lineEnd : frame.line) - 1).range.end
            )]);
        }
        else {
            let start = new vscode.Position(frame.line - 1, frame.column! - 1);
            let end = new vscode.Position(frame.lineEnd! - 1, frame.columnEnd! - 1);
            editor.setDecorations(lineDecorator, [new vscode.Range(start, end)]);
        }

        decorators.push(lineDecorator);
    }
}

function setLinesStats(lineStats: Map<number, [number, number]>, overallTotal: number, localTotal: number) {
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

        switch (lineStatsType) {
            case AustinLineStats.PERCENT:
                if (totalp === "0.00") {
                    return;
                }

                ownString = `${ownp}%`;
                totalString = `${totalp}%`;

                break;

            case AustinLineStats.ABSOLUTE:
                ownString = formatTime(own);
                totalString = formatTime(total);

                break;

            case AustinLineStats.BOTH:
                ownString = `${formatTime(own)} (${ownp}%)`;
                totalString = `${formatTime(total)} (${totalp}%)`;
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

    locations.forEach((v, k) => {
        let [fo, own, total] = v;

        setLineHeat(fo, own, total, overallTotal, localTotal, stats.metadata.getDefault("mode", () => "cpu"));

        for (let i = fo.line; i <= (fo.lineEnd ? fo.lineEnd : fo.line); i++) {
            if (lineStats.has(i)) {
                let [ownSum, totalSum] = lineStats.get(i)!;
                lineStats.set(i, [ownSum + own, totalSum + total]);
            }
            else {
                lineStats.set(i, [own, total]);
            }
        }
    });

    setLinesStats(lineStats, overallTotal, localTotal);
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
