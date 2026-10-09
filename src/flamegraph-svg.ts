// Generates a self-contained interactive SVG flamegraph, similar to Brendan Gregg's
// flamegraph.pl. When opened directly in a browser the embedded JavaScript provides
// zoom-on-click, search/highlight, hover tooltips, and keyboard shortcuts.

import * as fs from 'fs';
import * as path from 'path';

// The canonical color/format/layout logic lives in media/flamegraph-utils.js, the
// UMD module shared by the interactive webview and (via the embedded script built
// below) this exported SVG's own client-side re-layout -- one implementation kept
// in sync everywhere instead of several hand-copied ones. See src/utils/pathKey.ts
// for the same require pattern.
const FlamegraphUtils = require('../media/flamegraph-utils.js') as {
    colorFor: (node: any) => string;
    esc: (text: string) => string;
    basename: (p: string) => string;
    formatValue: (v: number, mode: string) => string;
    isNative: (node: any) => boolean;
    layoutFrames: (zoomRoot: any, cssWidth: number, ancestors: any[], rowH: number) => {
        frames: Array<{ node: any; x: number; y: number; w: number; depth: number; color: string; ancestor: boolean }>;
        rowIndex: any[][];
        anchors: Array<{ taskNode: any; anchorX: number; anchorY: number; anchorW: number; anchorDepth: number }>;
    };
    groupAnchorsByPosition: (anchors: any[]) => Map<string, any[]>;
    layoutTaskForest: (anchors: any[], globalScale: number, rowH: number) => {
        towers: Array<{ anchor: any; tower: { width: number }; offsetX: number; offsetY: number }>;
        totalHeight: number;
    };
    flattenTaskForest: (
        forest: any, anchorOriginX: number, anchorOriginY: number, towerOriginX: number, towerOriginY: number, rowH: number
    ) => {
        frames: Array<{ node: any; x: number; y: number; w: number; depth: number }>;
        spines: Array<{ fromX: number; fromY: number; toX: number; toY: number }>;
    };
    computeFloorY: (rowIndex: any[][], x0: number, x1: number, rowH: number, minY: number) => number;
    LANE_GAP: number;
};

const {
    colorFor, esc, basename: nodeBasename, formatValue, isNative,
    layoutFrames, groupAnchorsByPosition, layoutTaskForest, flattenTaskForest, computeFloorY, LANE_GAP,
} = FlamegraphUtils;

const CELL_H = 24;
const HEADER_H = 32;
const FOOTER_H = 28;
const LABEL_MIN_W = 30;
const INIT_W = 1200;   // coordinate width used for initial (pre-JS) layout

interface Frame {
    node: any;
    x: number;
    y: number;
    w: number;
    depth: number;
    color: string;
    ancestor: boolean;
}

/**
 * Renders one frame's SVG elements (clip path + rect/hatch/text/title group).
 * Shared by the main tree and floating task-tower frames -- both are laid
 * out identically once merged into a flat frame list.
 */
function renderFrameElements(f: Frame, mode: string, rootValue: number): { clipDef: string; frameEl: string } {
    const id: number = f.node._id;
    const fy = HEADER_H + f.y;
    const opacity = f.ancestor ? 0.45 : 1;
    const funcName: string = f.node.name || '';
    const file: string = f.node.file ? nodeBasename(f.node.file) : '';
    const pct = (f.node.value / rootValue * 100).toFixed(2) + '%';
    const titleText = esc(
        funcName + (f.node.file ? '\n' + f.node.file : '') + '\n' + formatValue(f.node.value, mode) + ' (' + pct + ')'
    );
    const labelAlpha = f.ancestor ? 0.6 : 0.9;

    const clipDef =
        `<clipPath id="c${id}">` +
        `<rect id="cr${id}" x="${f.x.toFixed(1)}" y="${fy}" ` +
        `width="${Math.max(0, f.w - 4).toFixed(1)}" height="${CELL_H}"/>` +
        `</clipPath>`;

    const textContent = esc(funcName) +
        (file ? ` <tspan opacity="0.5">${esc(file)}</tspan>` : '');
    const textHide = f.w < LABEL_MIN_W ? ' display="none"' : '';

    const frameIsNative = isNative(f.node);
    const frameEl =
        `<g class="frame" id="f${id}" data-id="${id}" style="cursor:pointer">` +
        `<rect id="r${id}" x="${f.x.toFixed(1)}" y="${fy}" ` +
        `width="${f.w.toFixed(1)}" height="${CELL_H}" ` +
        `fill="${f.color}" opacity="${opacity}" ` +
        `stroke="rgba(0,0,0,0.18)" stroke-width="0.5"/>` +
        (frameIsNative
            ? `<rect id="nh${id}" x="${f.x.toFixed(1)}" y="${fy}" ` +
              `width="${f.w.toFixed(1)}" height="${CELL_H}" ` +
              `fill="url(#native-hatch)" opacity="${opacity}" pointer-events="none"/>`
            : '') +
        `<text id="t${id}" clip-path="url(#c${id})" ` +
        `x="${(f.x + 4).toFixed(1)}" y="${(fy + CELL_H / 2).toFixed(1)}" ` +
        `dominant-baseline="middle" font-size="13" ` +
        `fill="rgba(255,255,255,${labelAlpha})"${textHide}>${textContent}</text>` +
        `<title>${titleText}</title>` +
        `</g>`;

    return { clipDef, frameEl };
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function generateInteractiveSVG(hierarchy: any, mode: string, logoB64?: string): string {
    // Deep-clone and stamp a stable numeric _id on every node (including
    // task-kind ones) so the embedded JS can map SVG element IDs back to
    // tree nodes in O(1).
    const root: any = JSON.parse(JSON.stringify(hierarchy));
    let idCounter = 0;
    function assignIds(node: any): void {
        node._id = idCounter++;
        if (node.children) { node.children.forEach(assignIds); }
    }
    assignIds(root);

    const modeLabels: Record<string, string> = {
        cpu: 'CPU Time Profile', wall: 'Wall Time Profile', memory: 'Memory Allocations Profile',
    };
    const headerColors: Record<string, string> = {
        cpu: 'rgba(192,64,64,0.85)', wall: 'rgba(160,160,48,0.85)', memory: 'rgba(48,160,48,0.85)',
    };
    const bgColors: Record<string, string> = {
        cpu: '#1a0505', wall: '#1a1a05', memory: '#051a05',
    };

    const modeLabel  = modeLabels[mode]  || mode;
    const headerColor = headerColors[mode] || headerColors.cpu;
    const bgColor     = bgColors[mode]    || bgColors.cpu;

    // Initial layout at INIT_W so the SVG is meaningful without JS. This is
    // always the FULL, unzoomed tree, so every task anchor (at any nesting
    // depth, via each tower's own recursively-flattened childForest) is
    // captured up front -- exactly the superset the embedded script's own
    // re-layout on zoom will ever need to update by id (see
    // flamegraph-embedded.js).
    const layout = layoutFrames(root, INIT_W, [], CELL_H);
    const mainFrames = layout.frames;
    const mainRows = layout.rowIndex.length;

    // Floating task towers -- same anchor-grouping/placement logic as
    // media/flamegraph.js's rebuildAndRender, so the exported SVG matches
    // the interactive webview instead of silently dropping task data.
    const globalScale = root.value > 0 ? INIT_W / root.value : 0;
    const anchorGroups = groupAnchorsByPosition(layout.anchors);

    const taskFrames: Frame[] = [];
    let taskRegionBottom = mainRows * CELL_H;
    for (const group of anchorGroups.values()) {
        const [anchor] = group;
        const forest = layoutTaskForest(group, globalScale, CELL_H);
        if (!forest.towers.length) { continue; }

        const groupWidth = Math.max(...forest.towers.map(t => t.offsetX + t.tower.width));
        const floorY = computeFloorY(
            layout.rowIndex, anchor.anchorX, anchor.anchorX + groupWidth, CELL_H, anchor.anchorY + CELL_H
        ) + LANE_GAP;

        const flattened = flattenTaskForest(forest, 0, 0, anchor.anchorX, floorY, CELL_H);
        for (const f of flattened.frames) {
            taskFrames.push({ node: f.node, x: f.x, y: f.y, w: f.w, depth: f.depth, color: colorFor(f.node), ancestor: false });
        }
        taskRegionBottom = Math.max(taskRegionBottom, floorY + forest.totalHeight);
    }

    const svgH = HEADER_H + taskRegionBottom + FOOTER_H;

    // ── Generate per-frame SVG elements ──────────────────────────────────────

    const clipDefs: string[] = [];
    const frameEls: string[] = [];

    for (const f of [...mainFrames, ...taskFrames]) {
        const { clipDef, frameEl } = renderFrameElements(f, mode, root.value);
        clipDefs.push(clipDef);
        frameEls.push(frameEl);
    }

    // Embed data as base64 to sidestep all XML/CDATA escaping concerns.
    const dataB64 = Buffer.from(JSON.stringify({ hierarchy: root, mode })).toString('base64');

    return [
        `<svg xmlns="http://www.w3.org/2000/svg"`,
        `     width="100%" viewBox="0 0 ${INIT_W} ${svgH}"`,
        `     style="background:${bgColor};font-family:system-ui,sans-serif;display:block">`,
        ``,
        `  <defs>`,
        `    <pattern id="native-hatch" patternUnits="userSpaceOnUse" width="6" height="6">` +
        `<path d="M-1,1 l2,-2 M0,6 l6,-6 M5,7 l2,-2" stroke="rgba(0,0,0,0.2)" stroke-width="1.5" stroke-linecap="square"/></pattern>`,
        ...clipDefs.map(d => `    ${d}`),
        `  </defs>`,
        ``,
        `  <!-- Header -->`,
        `  <rect x="0" y="0" width="100%" height="${HEADER_H}" fill="${headerColor}"`,
        `        style="filter:drop-shadow(0 0 6px #000)"/>`,
        ...(logoB64 ? [
            `  <image href="data:image/svg+xml;base64,${logoB64}" x="4" y="4" width="24" height="24"/>`,
        ] : []),
        `  <text x="${logoB64 ? 32 : 8}" y="${HEADER_H / 2}" dominant-baseline="middle"`,
        `        font-size="13" font-weight="bold" fill="antiquewhite">${esc(modeLabel)}</text>`,
        `  <foreignObject id="fo-search" x="${INIT_W - 210}" y="5" width="160" height="22">`,
        `    <input xmlns="http://www.w3.org/1999/xhtml" id="search-input" type="text"`,
        `           placeholder="Search…"`,
        `           style="width:100%;box-sizing:border-box;background:rgba(0,0,0,0.3);` +
        `border:1px solid rgba(255,255,255,0.25);border-radius:4px;` +
        `color:antiquewhite;font-size:11px;padding:2px 6px;outline:none"/>`,
        `  </foreignObject>`,
        `  <g id="reset-btn" style="cursor:pointer" transform="translate(${INIT_W - 46},4)">`,
        `    <rect rx="4" width="40" height="24" fill="none"`,
        `          stroke="rgba(255,255,255,0.3)" stroke-width="1"/>`,
        `    <text x="20" y="16" text-anchor="middle" font-size="10" font-weight="600"`,
        `          fill="antiquewhite" letter-spacing="0.04em">RESET</text>`,
        `  </g>`,
        ``,
        `  <!-- Frames -->`,
        `  <g id="frames-group">`,
        ...frameEls.map(el => `    ${el}`),
        `  </g>`,
        ``,
        `  <!-- Footer -->`,
        `  <rect id="footer-bg" x="0" y="${svgH - FOOTER_H}" width="100%"`,
        `        height="${FOOTER_H}" fill="rgba(46,53,58,0.9)"`,
        `        style="filter:drop-shadow(0 0 6px #000)"/>`,
        `  <text id="footer-text" x="6" y="${svgH - FOOTER_H / 2}"`,
        `        dominant-baseline="middle" font-size="12" fill="antiquewhite"/>`,
        ``,
        `  <!-- Embedded profile data (base64 JSON) -->`,
        `  <script type="application/json" id="fg-data">${dataB64}</script>`,
        ``,
        `  <!-- Interactive script -->`,
        `  <script><![CDATA[`,
        buildEmbeddedScript(),
        `  ]]></script>`,
        `</svg>`,
    ].join('\n');
}

// ── Embedded JavaScript ────────────────────────────────────────────────────────

function buildEmbeddedScript(): string {
    // flamegraph-utils.js is a UMD module: as a plain browser <script> (which
    // is exactly what this exported, standalone SVG file provides -- no
    // bundler, no other <script src>, and no Node require available at
    // runtime) it defines window.FlamegraphUtils, which flamegraph-embedded.js
    // then calls into for layout/color/format -- the same functions this
    // Node-side generator itself uses above, kept in sync in one place.
    const utils = fs.readFileSync(path.join(__dirname, '..', 'media', 'flamegraph-utils.js'), 'utf8');
    const embedded = fs.readFileSync(path.join(__dirname, '..', 'media', 'flamegraph-embedded.js'), 'utf8');
    return `${utils}\n${embedded}`;
}
