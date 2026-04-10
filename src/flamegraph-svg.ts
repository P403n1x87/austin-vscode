// Generates a self-contained interactive SVG flamegraph, similar to Brendan Gregg's
// flamegraph.pl. When opened directly in a browser the embedded JavaScript provides
// zoom-on-click, search/highlight, hover tooltips, and keyboard shortcuts.

const CELL_H = 24;
const HEADER_H = 32;
const FOOTER_H = 28;
const LABEL_MIN_W = 30;
const INIT_W = 1200;   // coordinate width used for initial (pre-JS) layout

// ── Utilities (mirrors flamegraph-utils.js) ────────────────────────────────────

function hslToHex(h: number, s: number, l: number): string {
    l /= 100;
    const a = s * Math.min(l, 1 - l) / 100;
    const f = (n: number) => {
        const k = (n + h / 30) % 12;
        const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

function nodeHash(text: string): number {
    let h = 0;
    for (let i = 0; i < text.length; i++) { h = text.charCodeAt(i) + ((h << 5) - h); }
    return h;
}

function colorFor(node: any): string {
    if (node.kind === 'process') { return hslToHex(120, nodeHash(node.name) % 20, 70); }
    if (node.kind === 'thread')  { return hslToHex(240, nodeHash(node.name) % 20, 70); }
    if (!node.file) { return hslToHex(0, 10, 70); }
    const h = nodeHash(node.file) % 360;
    const s = nodeHash(node.name || '') % 10;
    const isPy = node.file.endsWith('.py') || (node.file.startsWith('<') && node.file.endsWith('>'));
    return hslToHex(h >= 0 ? h : -h, (isPy ? 60 : 5) + s, isPy ? 60 : 45);
}

function nodeBasename(p: string): string {
    return p ? p.replace(/\\/g, '/').split('/').pop() || p : '';
}

function escXml(s: string): string {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatValue(v: number, mode: string): string {
    if (mode === 'memory') {
        if (v < 1024)            { return v.toFixed(0) + ' B'; }
        if (v < 1024 * 1024)     { return (v / 1024).toFixed(2) + ' KB'; }
        if (v < Math.pow(1024, 3)) { return (v / Math.pow(1024, 2)).toFixed(2) + ' MB'; }
        return (v / Math.pow(1024, 3)).toFixed(2) + ' GB';
    }
    if (v < 1000) { return v.toFixed(0) + ' \u03BCs'; }
    if (v < 1e6)  { return (v / 1000).toFixed(2) + ' ms'; }
    if (v < 1e9)  { return (v / 1e6).toFixed(2) + ' s'; }
    return (v / 1e9).toFixed(2) + ' m';
}

// ── Layout (mirrors flamegraph.js) ─────────────────────────────────────────────

interface Frame {
    node: any;
    x: number;
    y: number;
    w: number;
    depth: number;
    color: string;
    ancestor: boolean;
}

function layoutFrames(zoomRoot: any, cssWidth: number, ancestors: any[]): { frames: Frame[]; rows: number } {
    const frames: Frame[] = [];
    let maxDepth = 0;

    for (let i = 0; i < ancestors.length; i++) {
        frames.push({ node: ancestors[i], x: 0, y: i * CELL_H, w: cssWidth, depth: i, color: colorFor(ancestors[i]), ancestor: true });
        maxDepth = Math.max(maxDepth, i);
    }

    const offset = ancestors.length;
    const queue: Array<{ node: any; x: number; depth: number; w: number }> = [
        { node: zoomRoot, x: 0, depth: offset, w: cssWidth }
    ];

    while (queue.length) {
        const { node, x, depth, w } = queue.shift()!;
        frames.push({ node, x, y: depth * CELL_H, w, depth, color: colorFor(node), ancestor: false });
        maxDepth = Math.max(maxDepth, depth);
        if (!node.children?.length) { continue; }
        const scale = w / node.value;
        let childX = x;
        for (const child of node.children) {
            const childW = child.value * scale;
            if (childW >= 1) { queue.push({ node: child, x: childX, depth: depth + 1, w: childW }); }
            childX += childW;
        }
    }

    return { frames, rows: maxDepth + 1 };
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function generateInteractiveSVG(hierarchy: any, mode: string, logoB64?: string): string {
    // Deep-clone and stamp a stable numeric _id on every node so the embedded JS
    // can map SVG element IDs back to tree nodes in O(1).
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

    // Initial layout at INIT_W so the SVG is meaningful without JS.
    const { frames, rows } = layoutFrames(root, INIT_W, []);
    const svgH = HEADER_H + rows * CELL_H + FOOTER_H;

    // ── Generate per-frame SVG elements ──────────────────────────────────────

    const clipDefs: string[] = [];
    const frameEls: string[] = [];

    for (const f of frames) {
        const id: number = f.node._id;
        const fy = HEADER_H + f.y;
        const opacity = f.ancestor ? 0.45 : 1;
        const funcName: string = f.node.name || '';
        const file: string = f.node.file ? nodeBasename(f.node.file) : '';
        const pct = (f.node.value / root.value * 100).toFixed(2) + '%';
        const titleText = escXml(
            funcName + (f.node.file ? '\n' + f.node.file : '') + '\n' + formatValue(f.node.value, mode) + ' (' + pct + ')'
        );
        const labelAlpha = f.ancestor ? 0.6 : 0.9;

        // Clip path — kept in sync by JS on every render.
        clipDefs.push(
            `<clipPath id="c${id}">` +
            `<rect id="cr${id}" x="${f.x.toFixed(1)}" y="${fy}" ` +
            `width="${Math.max(0, f.w - 4).toFixed(1)}" height="${CELL_H}"/>` +
            `</clipPath>`
        );

        const textContent = escXml(funcName) +
            (file ? ` <tspan opacity="0.5">${escXml(file)}</tspan>` : '');
        const textHide = f.w < LABEL_MIN_W ? ' display="none"' : '';

        const isNative = f.node.file && !f.node.file.endsWith('.py');
        frameEls.push(
            `<g class="frame" id="f${id}" data-id="${id}" style="cursor:pointer">` +
            `<rect id="r${id}" x="${f.x.toFixed(1)}" y="${fy}" ` +
            `width="${f.w.toFixed(1)}" height="${CELL_H}" ` +
            `fill="${f.color}" opacity="${opacity}" ` +
            `stroke="rgba(0,0,0,0.18)" stroke-width="0.5"/>` +
            (isNative
                ? `<rect id="nh${id}" x="${f.x.toFixed(1)}" y="${fy}" ` +
                  `width="${f.w.toFixed(1)}" height="${CELL_H}" ` +
                  `fill="url(#native-hatch)" opacity="${opacity}" pointer-events="none"/>`
                : '') +
            `<text id="t${id}" clip-path="url(#c${id})" ` +
            `x="${(f.x + 4).toFixed(1)}" y="${(fy + CELL_H / 2).toFixed(1)}" ` +
            `dominant-baseline="middle" font-size="13" ` +
            `fill="rgba(255,255,255,${labelAlpha})"${textHide}>${textContent}</text>` +
            `<title>${titleText}</title>` +
            `</g>`
        );
    }

    // Embed data as base64 to sidestep all XML/CDATA escaping concerns.
    const dataB64 = Buffer.from(JSON.stringify({ hierarchy: root, mode })).toString('base64');

    return [
        `<svg xmlns="http://www.w3.org/2000/svg"`,
        `     width="100%" height="${svgH}"`,
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
        `        font-size="13" font-weight="bold" fill="antiquewhite">${escXml(modeLabel)}</text>`,
        `  <foreignObject id="fo-search" x="${INIT_W - 210}" y="5" width="160" height="22">`,
        `    <input xmlns="http://www.w3.org/1999/xhtml" id="search-input" type="text"`,
        `           placeholder="Search\u2026"`,
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
// Written with String.raw to avoid double-escaping backslashes.

function buildEmbeddedScript(): string {
    return String.raw`
(function () {
    // ── Data ──────────────────────────────────────────────────────────────────
    const { hierarchy, mode } = JSON.parse(atob(document.getElementById('fg-data').textContent.trim()));
    const TOTAL = hierarchy.value;

    // O(1) node lookup by _id
    const nodeMap = new Map();
    (function index(n) { nodeMap.set(n._id, n); if (n.children) n.children.forEach(index); })(hierarchy);

    // ── Constants ─────────────────────────────────────────────────────────────
    const CELL_H = 24, HEADER_H = 32, FOOTER_H = 28, LABEL_MIN_W = 30;

    // ── Utilities ─────────────────────────────────────────────────────────────
    function hslToHex(h, s, l) {
        l /= 100;
        const a = s * Math.min(l, 1 - l) / 100;
        const f = n => { const k = (n + h / 30) % 12; const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1); return Math.round(255 * c).toString(16).padStart(2, '0'); };
        return '#' + f(0) + f(8) + f(4);
    }
    function nhash(t) { let h = 0; for (let i = 0; i < t.length; i++) { h = t.charCodeAt(i) + ((h << 5) - h); } return h; }
    function colorFor(n) {
        if (n.kind === 'process') { return hslToHex(120, nhash(n.name) % 20, 70); }
        if (n.kind === 'thread')  { return hslToHex(240, nhash(n.name) % 20, 70); }
        if (!n.file) { return hslToHex(0, 10, 70); }
        const h = nhash(n.file) % 360;
        const ip = n.file.endsWith('.py') || (n.file.startsWith('<') && n.file.endsWith('>'));
        return hslToHex(h >= 0 ? h : -h, (ip ? 60 : 5) + nhash(n.name || '') % 10, ip ? 60 : 45);
    }
    function basename(p) { return p ? p.replace(/\\/g, '/').split('/').pop() || p : ''; }
    function fmt(v) {
        if (mode === 'memory') {
            if (v < 1024)       { return v.toFixed(0) + ' B'; }
            if (v < 1048576)    { return (v / 1024).toFixed(2) + ' KB'; }
            if (v < 1073741824) { return (v / 1048576).toFixed(2) + ' MB'; }
            return (v / 1073741824).toFixed(2) + ' GB';
        }
        if (v < 1000) { return v.toFixed(0) + ' \u03BCs'; }
        if (v < 1e6)  { return (v / 1000).toFixed(2) + ' ms'; }
        if (v < 1e9)  { return (v / 1e6).toFixed(2) + ' s'; }
        return (v / 1e9).toFixed(2) + ' m';
    }

    // ── Layout ────────────────────────────────────────────────────────────────
    function findAncestors(root, target) {
        const path = [];
        function walk(n) {
            if (n === target) { return true; }
            if (n.children) { for (const c of n.children) { path.push(n); if (walk(c)) { return true; } path.pop(); } }
            return false;
        }
        walk(root);
        return path;
    }

    function doLayout(zoomRoot, w, ancestors) {
        const frames = [];
        let maxD = 0;
        ancestors.forEach((a, i) => {
            frames.push({ node: a, x: 0, y: i * CELL_H, w, depth: i, ancestor: true });
            maxD = Math.max(maxD, i);
        });
        const q = [{ node: zoomRoot, x: 0, depth: ancestors.length, w }];
        while (q.length) {
            const { node, x, depth, w: fw } = q.shift();
            frames.push({ node, x, y: depth * CELL_H, w: fw, depth, ancestor: false });
            maxD = Math.max(maxD, depth);
            if (!node.children || !node.children.length) { continue; }
            const scale = fw / node.value;
            let cx = x;
            for (const child of node.children) {
                const cw = child.value * scale;
                if (cw >= 1) { q.push({ node: child, x: cx, depth: depth + 1, w: cw }); }
                cx += cw;
            }
        }
        return { frames, rows: maxD + 1 };
    }

    // ── State ─────────────────────────────────────────────────────────────────
    let zoomNode = null;
    let searchTerm = '';
    const svg = document.querySelector('svg');

    // ── Render ────────────────────────────────────────────────────────────────
    function render() {
        const w = svg.getBoundingClientRect().width || 1200;
        const ancestors = zoomNode ? findAncestors(hierarchy, zoomNode) : [];
        const { frames, rows } = doLayout(zoomNode || hierarchy, w, ancestors);
        const totalH = HEADER_H + rows * CELL_H + FOOTER_H;

        svg.setAttribute('height', totalH);

        // Reposition footer
        const fb = document.getElementById('footer-bg');
        const ft = document.getElementById('footer-text');
        if (fb) { fb.setAttribute('y', totalH - FOOTER_H); }
        if (ft) { ft.setAttribute('y', totalH - FOOTER_H / 2); ft.textContent = ''; }

        // Keep header-right elements anchored to the right edge
        const foSearch = document.getElementById('fo-search');
        const resetBtn = document.getElementById('reset-btn');
        if (foSearch) { foSearch.setAttribute('x', w - 210); }
        if (resetBtn) { resetBtn.setAttribute('transform', 'translate(' + (w - 46) + ',4)'); }

        // Build the set of node IDs visible in this layout
        const visible = new Set(frames.map(f => f.node._id));

        // Hide frames not in current layout
        document.querySelectorAll('.frame').forEach(el => {
            el.style.display = visible.has(+el.getAttribute('data-id')) ? '' : 'none';
        });

        // Update each visible frame's geometry
        for (const f of frames) {
            const id   = f.node._id;
            const fy   = HEADER_H + f.y;
            const op   = f.ancestor ? 0.45 : 1;
            const alpha = f.ancestor ? 0.6 : 0.9;

            const rect = document.getElementById('r' + id);
            const cr   = document.getElementById('cr' + id);
            const text = document.getElementById('t' + id);

            if (rect) {
                rect.setAttribute('x',       f.x);
                rect.setAttribute('y',       fy);
                rect.setAttribute('width',   f.w);
                rect.setAttribute('opacity', op);
                rect.setAttribute('fill',    colorFor(f.node));
            }
            const hatch = document.getElementById('nh' + id);
            if (hatch) {
                hatch.setAttribute('x',       f.x);
                hatch.setAttribute('y',       fy);
                hatch.setAttribute('width',   f.w);
                hatch.setAttribute('opacity', op);
            }
            if (cr) {
                cr.setAttribute('x',     f.x);
                cr.setAttribute('y',     fy);
                cr.setAttribute('width', Math.max(0, f.w - 4));
            }
            if (text) {
                text.setAttribute('x',    f.x + 4);
                text.setAttribute('y',    fy + CELL_H / 2);
                text.setAttribute('fill', 'rgba(255,255,255,' + alpha + ')');
                text.style.display = f.w >= LABEL_MIN_W ? 'inline' : 'none';
            }
        }

        applySearch();
    }

    // ── Search ────────────────────────────────────────────────────────────────
    function applySearch() {
        document.querySelectorAll('.frame').forEach(el => {
            const id   = +el.getAttribute('data-id');
            const node = nodeMap.get(id);
            const rect = document.getElementById('r' + id);
            if (!node || !rect) { return; }
            if (!searchTerm) {
                rect.setAttribute('stroke',       'rgba(0,0,0,0.18)');
                rect.setAttribute('stroke-width', '0.5');
                return;
            }
            const match = (node.name || '').toLowerCase().includes(searchTerm) ||
                          (node.file || '').toLowerCase().includes(searchTerm);
            rect.setAttribute('stroke',       match ? 'rgba(255,230,80,0.95)' : 'rgba(0,0,0,0.18)');
            rect.setAttribute('stroke-width', match ? '2' : '0.5');
        });
    }

    // ── Events ────────────────────────────────────────────────────────────────
    document.querySelectorAll('.frame').forEach(el => {
        // Click: zoom in (or back out if clicking the current zoom root)
        el.addEventListener('click', function () {
            const node = nodeMap.get(+this.getAttribute('data-id'));
            if (!node) { return; }
            zoomNode = (zoomNode === node) ? null : node;
            render();
        });

        // Hover: show details in footer
        el.addEventListener('mouseenter', function () {
            const node = nodeMap.get(+this.getAttribute('data-id'));
            if (!node) { return; }
            const pct  = (node.value / TOTAL * 100).toFixed(2) + '%';
            const icon = mode === 'memory' ? '\u{1F4E6}\uFE0E' : '\u23F1\uFE0E';
            const ft   = document.getElementById('footer-text');
            if (ft) {
                ft.textContent = icon + ' ' + fmt(node.value) + ' (' + pct + ')' +
                    '  \u00B7  ' + (node.name || '') +
                    (node.file ? '  ' + basename(node.file) : '');
            }
        });
        el.addEventListener('mouseleave', function () {
            const ft = document.getElementById('footer-text');
            if (ft) { ft.textContent = ''; }
        });
    });

    // Reset button
    const resetBtn = document.getElementById('reset-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', function () { zoomNode = null; render(); });
    }

    // Search input
    const si = document.getElementById('search-input');
    if (si) {
        si.addEventListener('input', function () {
            searchTerm = this.value.toLowerCase();
            applySearch();
        });
        si.addEventListener('keydown', function (e) { e.stopPropagation(); });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', function (e) {
        if (e.ctrlKey || e.metaKey) { return; }
        if (e.key === 'r' || e.key === 'R') { zoomNode = null; render(); }
        if (e.key === 'f' || e.key === 'F') { if (si) { si.focus(); e.preventDefault(); } }
        if (e.key === 'Escape') {
            zoomNode = null;
            searchTerm = '';
            if (si) { si.value = ''; }
            render();
        }
    });

    // Reflow on resize
    window.addEventListener('resize', render);

    // ── Init ──────────────────────────────────────────────────────────────────
    render();
})();
`;
}
