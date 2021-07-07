import * as vscode from 'vscode';


let decorators: vscode.TextEditorDecorationType[] = [];


export function clearDecorations() {
    decorators.forEach((ld) => ld.dispose());
    decorators = [];
}


export function setLineHeat(line: number, own: number, total: number, overallTotal: number, localTotal: number) {
    const ownp = (own * 100 / overallTotal).toFixed(2);
    const totalp = (total * 100 / overallTotal).toFixed(2);
    const editor = vscode.window.activeTextEditor;
    if (editor !== undefined) {
        const color: string = `rgba(192, 64, 64, ${own / localTotal})`;
        const lineDecorator = vscode.window.createTextEditorDecorationType({
            backgroundColor: color,
            after: {
                contentText: `    own: ${ownp}%, total: ${totalp}%`,
                color: "rgba(128,128,128,0.7)",
                margin: "8px"
            },
            overviewRulerColor: color,
            overviewRulerLane: 1,
            isWholeLine: true,
        });
        editor.setDecorations(lineDecorator, [new vscode.Range(
            editor.document.lineAt(line - 1).range.start,
            editor.document.lineAt(line - 1).range.end
        )]);
        decorators.push(lineDecorator);
    }
}

export function setLinesHeat(lines: Map<number, [number, number]>, overallTotal: number) {
    const localTotal = Array.from(lines.values()).map(v => v[0]).reduce((s, c) => s + c, 0);
    lines.forEach((v, k) => {
        let own: number, total: number;
        [own, total] = v;
        setLineHeat(k, own, total, overallTotal, localTotal);
    });
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