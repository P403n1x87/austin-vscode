import * as vscode from 'vscode';
import { AustinStats, FrameObject } from './model';
import { AustinRuntimeSettings } from './settings';
import { AustinLineStats } from './types';


let decorators: vscode.TextEditorDecorationType[] = [];


export function clearDecorations() {
    decorators.forEach((ld) => ld.dispose());
    decorators = [];
}


export function formatTime(microseconds: number) {
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

export function formatMemory(bytes: number) {
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

function setLineHeat(frame: FrameObject, own: number, _total: number, _overallTotal: number, localTotal: number, mode: string) {
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

function statColor(fraction: number): string | null {
    const pct = fraction * 100;
    if (pct >= 75) { return '#e74c3c'; }
    if (pct >= 50) { return '#e67e22'; }
    if (pct >= 25) { return '#f1c40f'; }
    return null;
}

interface GutterMetrics {
    /** Width of the SVG / visual column (bars + labels). */
    width: number;
    /** Height of the visual column — equals the resolved line height. */
    height: number;
    /** Gap to the left of the visual column (between line-number gutter and column). */
    leftMargin: number;
    /** Gap to the right of the visual column (between column and code text). */
    rightMargin: number;
    /** Total horizontal space reserved by the zero-height spacer:
     *  leftMargin + width + rightMargin. */
    totalWidth: number;
    barH: number;
    barY: number;
    barCenterY: number;
    barTrackW: number;
    col1X: number;
    col2X: number;
    colW: number;
    dividerX: number;
    labelX1: number;
    labelX2: number;
    statsFontSize: number;
    /** Width of the neon glow halo on each edge of the background SVG. */
    glowW: number;
}

/**
 * Derive all gutter dimensions from the current VS Code editor font settings and
 * the actual maximum label length observed in the current profile data, so the
 * column is always just wide enough to show every label without clipping.
 *
 * The visual overlay uses position:absolute (no layout impact), so `height` can
 * safely equal the full resolved line height without ever expanding lines.
 */
function computeGutterMetrics(maxLabelChars: number): GutterMetrics {
    const config = vscode.workspace.getConfiguration('editor');
    const editorFontSize = config.get<number>('fontSize') ?? 14;
    const lineHeightSetting = config.get<number>('lineHeight') ?? 0;

    // VS Code line-height resolution:
    //   0          → auto (Monaco: 1.5× on macOS, 1.35× on Windows/Linux)
    //   0 < v < 8  → multiplier × font size
    //   v >= 8     → absolute px
    let height: number;
    if (lineHeightSetting <= 0) {
        height = Math.round(editorFontSize * 1.5);   // use macOS default (most conservative)
    } else if (lineHeightSetting < 8) {
        height = Math.round(lineHeightSetting * editorFontSize);
    } else {
        height = Math.round(lineHeightSetting);
    }
    // height == full line height.  The visual decorator uses position:absolute so
    // it never participates in line-box layout — no line expansion regardless.

    // Stats font is 90% of the editor font, minimum 8 px.
    const statsFontSize = Math.max(8, Math.round(editorFontSize * 0.9));
    // Monospace char width ≈ 0.65 × font-size.  Use the actual max label length
    // observed in the data so the column width is never more than necessary.
    const charW     = Math.round(statsFontSize * 0.65);
    const labelW    = charW * Math.max(maxLabelChars, 1);
    const barH      = Math.max(5, Math.round(editorFontSize * 0.5));   // chunky bar
    const barTrackW = Math.round(editorFontSize * 1.5);
    const barGap    = Math.max(4, Math.round(editorFontSize * 0.3));
    const divW      = Math.max(10, Math.round(editorFontSize * 0.6));  // wider gap between columns

    // Glow halo width (same formula as gutterBackgroundSvg so pad accounts for it).
    const glowW = Math.max(6, Math.round(height * 0.45));
    // Pad must clear the glow so bars never overlap the neon left border.
    const pad   = glowW + Math.max(3, Math.round(editorFontSize * 0.2));

    const colW      = pad + barTrackW + barGap + labelW;
    const width     = colW * 2 + divW;
    const leftMargin  = Math.max(2, Math.round(editorFontSize * 0.2));
    const rightMargin = Math.max(4, Math.round(editorFontSize * 0.4));
    const totalWidth  = leftMargin + width + rightMargin;

    const barY       = Math.round((height - barH) / 2);
    const barCenterY = barY + Math.round(barH / 2);
    const col1X      = pad;
    const col2X      = colW + divW;
    const dividerX   = colW + Math.round(divW / 2);
    const labelX1    = pad + barTrackW + barGap;
    const labelX2    = col2X + barTrackW + barGap;

    return { width, height, leftMargin, rightMargin, totalWidth, barH, barY, barCenterY, barTrackW, col1X, col2X, colW, dividerX, labelX1, labelX2, statsFontSize, glowW };
}

interface ModeColors {
    bg: string;
    glow: string;
    core: string;
}

function modeColors(mode: string): ModeColors {
    switch (mode) {
        case "cpu":    return { bg: "rgba(127,0,0,0.06)",   glow: "rgba(255,64,64,0.30)",   core: "rgba(255,120,120,0.85)" };
        case "wall":   return { bg: "rgba(100,100,0,0.06)", glow: "rgba(192,192,64,0.30)",  core: "rgba(220,220,120,0.85)" };
        case "memory": return { bg: "rgba(0,100,0,0.06)",   glow: "rgba(64,192,64,0.30)",   core: "rgba(120,220,120,0.85)" };
        default:       return { bg: "rgba(70,40,160,0.06)", glow: "rgba(190,100,255,0.30)", core: "rgba(220,160,255,0.85)" };
    }
}

/** Background panel (no bars): rendered on every line to create the "gap" column. */
function gutterBackgroundSvg(m: GutterMetrics, mode: string): string {
    const { width: W, height: H, glowW } = m;
    const { bg, glow, core } = modeColors(mode);

    return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">` +
        `<defs>` +
        `<linearGradient id="lg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${glowW}" y2="0">` +
        `<stop offset="0%"   stop-color="${glow}"/>` +
        `<stop offset="100%" stop-color="rgba(0,0,0,0)"/>` +
        `</linearGradient>` +
        `<linearGradient id="rg" gradientUnits="userSpaceOnUse" x1="${W}" y1="0" x2="${W - glowW}" y2="0">` +
        `<stop offset="0%"   stop-color="${glow}"/>` +
        `<stop offset="100%" stop-color="rgba(0,0,0,0)"/>` +
        `</linearGradient>` +
        `</defs>` +
        `<rect x="0" y="0" width="${W}" height="${H}" fill="${bg}"/>` +
        `<rect x="0" y="0" width="${glowW}" height="${H}" fill="url(#lg)"/>` +
        `<rect x="0" y="0" width="1.5" height="${H}" fill="${core}"/>` +
        `<rect x="${W - glowW}" y="0" width="${glowW}" height="${H}" fill="url(#rg)"/>` +
        `<rect x="${W - 1.5}" y="0" width="1.5" height="${H}" fill="${core}"/>` +
        `</svg>`;
}

function gutterColumnSvg(m: GutterMetrics, ownFraction: number, totalFraction: number, ownLabel: string, totLabel: string): string {
    const { width: W, height: H, barH, barY, barCenterY, barTrackW, col1X, col2X, colW, dividerX, labelX1, labelX2, statsFontSize } = m;

    const ownFillW = Math.round(Math.min(1, ownFraction)   * barTrackW);
    const totFillW = Math.round(Math.min(1, totalFraction) * barTrackW);

    const NEUTRAL_FILL = 'rgba(128,128,128,0.35)';
    const NEUTRAL_OWN  = 'rgba(180,180,180,0.85)';
    const NEUTRAL_TOT  = 'rgba(150,150,150,0.65)';

    const ownFillColor  = statColor(ownFraction)   ?? NEUTRAL_FILL;
    const totFillColor  = statColor(totalFraction) ?? NEUTRAL_FILL;
    const ownLabelColor = statColor(ownFraction)   ?? NEUTRAL_OWN;
    const totLabelColor = statColor(totalFraction) ?? NEUTRAL_TOT;

    // Each column is clipped to its own region so long labels never bleed across.
    const defs =
        `<defs>` +
        `<clipPath id="c1"><rect x="0" y="0" width="${colW}" height="${H}"/></clipPath>` +
        `<clipPath id="c2"><rect x="${col2X}" y="0" width="${colW}" height="${H}"/></clipPath>` +
        `</defs>`;

    return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${defs}` +
        `<g clip-path="url(#c1)">` +
        `<rect x="${col1X}" y="${barY}" width="${barTrackW}" height="${barH}" rx="2" fill="rgba(128,128,128,0.2)"/>` +
        `<rect x="${col1X}" y="${barY}" width="${ownFillW}" height="${barH}" rx="2" fill="${ownFillColor}"/>` +
        `<text x="${labelX1}" y="${barCenterY}" dominant-baseline="central" font-family="monospace" font-size="${statsFontSize}" fill="${ownLabelColor}">${ownLabel}</text>` +
        `</g>` +
        `<line x1="${dividerX}" y1="3" x2="${dividerX}" y2="${H - 3}" stroke="rgba(128,128,128,0.18)" stroke-width="1"/>` +
        `<g clip-path="url(#c2)">` +
        `<rect x="${col2X}" y="${barY}" width="${barTrackW}" height="${barH}" rx="2" fill="rgba(128,128,128,0.2)"/>` +
        `<rect x="${col2X}" y="${barY}" width="${totFillW}" height="${barH}" rx="2" fill="${totFillColor}"/>` +
        `<text x="${labelX2}" y="${barCenterY}" dominant-baseline="central" font-family="monospace" font-size="${statsFontSize}" fill="${totLabelColor}">${totLabel}</text>` +
        `</g>` +
        `</svg>`;
}

function setLinesStats(lineStats: Map<number, [number, number]>, overallTotal: number, _localTotal: number, mode: string) {
    const editor = vscode.window.activeTextEditor;
    const lineStatsType = AustinRuntimeSettings.get().settings.lineStats;

    if (editor === undefined) {
        return;
    }

    const formatter = mode === "memory" ? formatMemory : formatTime;

    // ── Pass 1: compute labels for every qualifying line and track the longest ──
    type LineEntry = { ownFraction: number; totalFraction: number; ownLabel: string; totLabel: string };
    const entries = new Map<number, LineEntry>();
    let maxLabelChars = 1;

    lineStats.forEach((v, k) => {
        const [own, total] = v;
        if (total === 0) { return; }

        const content = editor.document.lineAt(k - 1).text.trim();
        if (content.length === 0 || content[0] === "#") { return; }

        const ownFraction   = own   / overallTotal;
        const totalFraction = total / overallTotal;
        const ownPct   = (ownFraction   * 100).toFixed(1);
        const totalPct = (totalFraction * 100).toFixed(1);

        if (totalPct === "0.0") { return; }

        let ownLabel: string;
        let totLabel: string;
        switch (lineStatsType) {
            case AustinLineStats.ABSOLUTE:
                ownLabel = formatter(own);
                totLabel = formatter(total);
                break;
            case AustinLineStats.BOTH:
                ownLabel = `${formatter(own)} (${ownPct}%)`;
                totLabel = `${formatter(total)} (${totalPct}%)`;
                break;
            default: // PERCENT
                ownLabel = `${ownPct}%`;
                totLabel = `${totalPct}%`;
        }

        maxLabelChars = Math.max(maxLabelChars, ownLabel.length, totLabel.length);
        entries.set(k, { ownFraction, totalFraction, ownLabel, totLabel });
    });

    // ── Metrics: sized to fit the longest label observed in this profile ──
    const m = computeGutterMetrics(maxLabelChars);

    // ── Build the all-lines range list once ──
    const allRanges: vscode.Range[] = [];
    for (let i = 0; i < editor.document.lineCount; i++) {
        allRanges.push(new vscode.Range(
            editor.document.lineAt(i).range.start,
            editor.document.lineAt(i).range.end
        ));
    }

    // Layer 1 — Spacer (all lines, display:inline-block, height:0).
    // Reserves totalWidth = leftMargin + colWidth + rightMargin of horizontal space
    // without contributing anything to the line-box height.
    const spacerDecorator = vscode.window.createTextEditorDecorationType({
        before: {
            contentText: '',
            width: `${m.totalWidth}px`,
            textDecoration: 'none;display:inline-block;height:0;',
        },
    });
    editor.setDecorations(spacerDecorator, allRanges);
    decorators.push(spacerDecorator);

    // Layer 2 — Background panel (all lines, position:absolute).
    // Creates the visual "gap" column between the gutter and the code text.
    // position:absolute means zero layout impact regardless of height.
    const bgSvg    = gutterBackgroundSvg(m, mode);
    const bgUri    = `url("data:image/svg+xml;utf8,${encodeURIComponent(bgSvg)}")`;
    const bgDecorator = vscode.window.createTextEditorDecorationType({
        before: {
            contentText: '',
            width: `${m.width}px`,
            height: `${m.height}px`,
            textDecoration: `none;position:absolute;left:${m.leftMargin}px;top:0;background:${bgUri};background-repeat:no-repeat;background-size:${m.width}px ${m.height}px`,
        },
    });
    editor.setDecorations(bgDecorator, allRanges);
    decorators.push(bgDecorator);

    // Layer 3 — Bars overlay (stat lines only, position:absolute, on top of background).
    entries.forEach(({ ownFraction, totalFraction, ownLabel, totLabel }, k) => {
        const svg      = gutterColumnSvg(m, ownFraction, totalFraction, ownLabel, totLabel);
        const dataUri  = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
        const ownColor = statColor(ownFraction) ?? undefined;

        const visualDecorator = vscode.window.createTextEditorDecorationType({
            before: {
                contentText: '',
                width: `${m.width}px`,
                height: `${m.height}px`,
                textDecoration: `none;position:absolute;left:${m.leftMargin}px;top:0;background:${dataUri};background-repeat:no-repeat;background-size:${m.width}px ${m.height}px`,
            },
            overviewRulerColor: ownColor,
            overviewRulerLane: vscode.OverviewRulerLane.Right,
        });

        editor.setDecorations(visualDecorator, [new vscode.Range(
            editor.document.lineAt(k - 1).range.start,
            editor.document.lineAt(k - 1).range.end
        )]);
        decorators.push(visualDecorator);
    });
}

export function setLinesHeat(locations: Map<string, [FrameObject, number, number]>, stats: AustinStats) {
    clearDecorations();

    const overallTotal = stats.overallTotal;
    const localTotal = Array.from(locations.values()).map(v => v[1]).reduce((s, c) => s + c, 0);
    let lineStats = new Map<number, [number, number]>();
    let mode = stats.metadata.getDefault("mode", () => "cpu");

    locations.forEach((v, _k) => {
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
