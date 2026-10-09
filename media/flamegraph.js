// @ts-check
(function () {
    // @ts-ignore
    const vscode = window.vscode = acquireVsCodeApi();

    // ── Utilities (loaded from flamegraph-utils.js) ───────────────────────────
    // @ts-ignore
    const {
        colorFor, basename, isEmpty, footerText, esc, hashPath,
        isNative, NATIVE_COLLAPSED_COLOR, layoutFrames, groupAnchorsByPosition,
        layoutTaskForest, flattenTaskForest, computeFloorY, LANE_GAP,
    } = FlamegraphUtils;

    /** @param {any} node @param {number} parentHash */
    function addPathKeys(node, parentHash) {
        // Use node.key (module:scope for frames, bare name for process/thread) so that
        // two functions with the same name in different modules get distinct frameKeys.
        node.frameKey = hashPath(node.key, parentHash);
        if (node.children) {
            for (const child of node.children) { addPathKeys(child, node.frameKey); }
        }
    }

    /** @param {any} node */
    function hasAnyNativeFrame(node) {
        if (isNative(node)) { return true; }
        if (node.children) {
            for (const c of node.children) { if (hasAnyNativeFrame(c)) { return true; } }
        }
        return false;
    }

    // ── Constants ─────────────────────────────────────────────────────────────

    let CELL_H = 24;            // row height in CSS px — updated before each rebuild
    let FONT_SIZE = 13;         // editor font size in px — updated before each rebuild
    let FONT_FAMILY = 'system-ui, sans-serif';
    const LABEL_MIN_W = 30;     // minimum frame width (CSS px) to draw a text label
    const DPR = window.devicePixelRatio || 1;

    let currentMode = 'cpu';

    // ── Layout engine ─────────────────────────────────────────────────────────
    // The frame-partitioning algorithm itself (layoutFrames) lives in
    // flamegraph-utils.js, shared with the exported static SVG.

    /**
     * Walk from root toward target, collecting the ancestor chain
     * (root inclusive, target exclusive).
     * @param {any} root @param {any} target @returns {any[]}
     */
    function findAncestors(root, target) {
        /** @type {any[]} */
        const path = [];
        /** @param {any} node @returns {boolean} */
        function search(node) {
            if (node === target) { return true; }
            if (node.children) {
                for (const child of node.children) {
                    path.push(node);
                    if (search(child)) { return true; }
                    path.pop();
                }
            }
            return false;
        }
        search(root);
        return path;
    }

    // ── Render engine ─────────────────────────────────────────────────────────

    /** @param {number} a @param {number} b @param {number} t */
    function lerp(a, b, t) { return a + (b - a) * t; }

    /** Ease-in-out quad. @param {number} t */
    function easeInOut(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }

    /**
     * Draws one frame box (fill, native hatch, border, highlight glow, label)
     * at already-resolved coordinates. Shared by the main flamegraph's
     * (possibly animated) frames and floating task frames (never animated).
     * @param {CanvasRenderingContext2D} ctx
     * @param {any} f
     * @param {number} x @param {number} y @param {number} w
     * @param {string} primaryFont @param {string} secondaryFont
     * @param {number} [baseAlpha]  fill alpha for a non-ancestor frame (default 1)
     */
    function drawFrameBox(ctx, f, x, y, w, primaryFont, secondaryFont, baseAlpha) {
        ctx.globalAlpha = f.ancestor ? 0.45 : (baseAlpha === undefined ? 1 : baseAlpha);
        ctx.fillStyle = f.color;
        ctx.fillRect(x, y, w, CELL_H);

        // Uncollapsed native (non-Python) frames get a diagonal hatch overlay;
        // collapsed natives are drawn flat gray without the hatch.
        if (!f.collapsedNative && f.node.file && !f.node.file.endsWith('.py')) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, y, w, CELL_H);
            ctx.clip();
            ctx.strokeStyle = 'rgba(0,0,0,0.22)';
            ctx.lineWidth = 1.5;
            const step = 5;
            for (let ox = -CELL_H; ox < w + CELL_H; ox += step) {
                ctx.beginPath();
                ctx.moveTo(x + ox, y);
                ctx.lineTo(x + ox + CELL_H, y + CELL_H);
                ctx.stroke();
            }
            ctx.restore();
        }

        ctx.strokeStyle = 'rgba(0,0,0,0.18)';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(x + 0.25, y + 0.25, w - 0.5, CELL_H - 0.5);

        // Glow overlay for search-highlighted frames
        if (f.highlighted) {
            ctx.shadowColor = 'rgba(255,230,80,0.95)';
            ctx.shadowBlur = 6;
            ctx.strokeStyle = 'rgba(255,230,80,0.95)';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, CELL_H - 1.5);
            ctx.shadowBlur = 0;
        }

        if (w >= LABEL_MIN_W) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x + 2, y + 1, w - 4, CELL_H - 2);
            ctx.clip();

            const cy = y + CELL_H / 2;
            const labelAlpha = f.ancestor ? 0.6 : 0.9;
            const funcName = f.collapsedNative ? 'native' : (f.node.name || '');
            const file = f.collapsedNative ? '' : (f.node.file ? basename(f.node.file) : '');

            // Function name — prominent
            ctx.font = primaryFont;
            ctx.fillStyle = `rgba(255,255,255,${labelAlpha})`;
            ctx.fillText(funcName, x + 4, cy);

            // File name — dimmer, only if space remains
            if (file) {
                const funcW = ctx.measureText(funcName).width;
                const fileX = x + 4 + funcW + 6;
                if (fileX + 20 < x + w - 2) {
                    ctx.font = secondaryFont;
                    ctx.fillStyle = `rgba(255,255,255,${labelAlpha * 0.55})`;
                    ctx.fillText(file, fileX, cy);
                }
            }

            ctx.restore();
        }

        ctx.globalAlpha = 1;
    }

    /**
     * Builds a rounded-rectangle path without relying on CanvasRenderingContext2D.roundRect
     * (not universally available across embedding engines).
     * @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r
     */
    function roundedRectPath(x, y, w, h, r) {
        const rr = Math.max(0, Math.min(r, w / 2, h / 2));
        const path = new Path2D();
        path.moveTo(x + rr, y);
        path.lineTo(x + w - rr, y);
        path.arcTo(x + w, y, x + w, y + rr, rr);
        path.lineTo(x + w, y + h - rr);
        path.arcTo(x + w, y + h, x + w - rr, y + h, rr);
        path.lineTo(x + rr, y + h);
        path.arcTo(x, y + h, x, y + h - rr, rr);
        path.lineTo(x, y + rr);
        path.arcTo(x, y, x + rr, y, rr);
        path.closePath();
        return path;
    }


    /**
     * @param {HTMLCanvasElement} canvas
     * @param {CanvasRenderingContext2D} ctx
     * @param {ReturnType<typeof layoutFrames>['frames']} frames
     * @param {any} hoveredFrame
     * @param {Map<any,{x:number,y:number,w:number}> | null} prevPos  for animation interpolation
     * @param {number} t  interpolation factor 0→1
     */
    function render(canvas, ctx, frames, hoveredFrame, prevPos, t) {
        const cssW = canvas.width / DPR;
        const cssH = canvas.height / DPR;

        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        const primaryFont   = `${FONT_SIZE}px ${FONT_FAMILY}`;
        const secondaryFont = `${Math.max(10, FONT_SIZE - 1)}px ${FONT_FAMILY}`;
        ctx.textBaseline = 'middle';

        for (const f of frames) {
            const prev = prevPos && prevPos.get(f.node);
            const x = prev ? lerp(prev.x, f.x, t) : f.x;
            const y = prev ? lerp(prev.y, f.y, t) : f.y;
            const w = prev ? lerp(prev.w, f.w, t) : f.w;
            drawFrameBox(ctx, f, x, y, w, primaryFont, secondaryFont);
        }

        // Floating task frames never animate in this pass — drawn at their
        // resolved position directly, at full opacity like any other frame
        // (the task's own root frame IS its label now, no separate glass
        // panel drawn behind it any more -- see AustinStats.
        // finalizeTaskNodes and layoutTaskTower).
        for (const f of taskFrames) {
            drawFrameBox(ctx, f, f.x, f.y, f.w, primaryFont, secondaryFont);
        }

        if (hoveredFrame && t === 1) {
            ctx.shadowColor = 'rgba(255,255,255,0.7)';
            ctx.shadowBlur = 8;
            ctx.strokeStyle = 'rgba(255,255,255,0.9)';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(
                hoveredFrame.x + 0.75, hoveredFrame.y + 0.75,
                hoveredFrame.w - 1.5, (hoveredFrame.h || CELL_H) - 1.5
            );
            ctx.shadowBlur = 0;
        }
    }

    // ── Hit testing ───────────────────────────────────────────────────────────

    /**
     * @param {ReturnType<typeof layoutFrames>['rowIndex']} rowIndex
     * @param {number} cx  CSS px from canvas left
     * @param {number} cy  CSS px from canvas top
     * @param {number} [cellH]  row height used for the layout (defaults to global CELL_H)
     */
    function hitTest(rowIndex, cx, cy, cellH) {
        const rowH = cellH || CELL_H;
        const depth = Math.floor(cy / rowH);
        const row = rowIndex[depth];
        if (!row) { return null; }
        for (const f of row) {
            if (cx >= f.x && cx < f.x + f.w) { return f; }
        }
        return null;
    }

    /**
     * Combined hit test for the main canvas: the row-bucketed main flamegraph
     * frames, falling back to a bounding-box scan over floating task frames
     * (which don't fit the "y = depth * rowH" bucketing, since each tower
     * has its own depth-0-relative rows at an arbitrary absolute Y).
     * @param {number} cx @param {number} cy
     */
    function hitTestMain(cx, cy) {
        const mainHit = hitTest(rowIndex, cx, cy);
        if (mainHit) { return mainHit; }
        for (const f of taskFrames) {
            if (cx >= f.x && cx < f.x + f.w && cy >= f.y && cy < f.y + CELL_H) { return f; }
        }
        return null;
    }

    // ── Controller ────────────────────────────────────────────────────────────

    /** @type {any} */ let rootNode = null;
    /** @type {any} */ let zoomNode = null;
    /** @type {ReturnType<typeof layoutFrames>['frames']} */ let frames = [];
    /** @type {ReturnType<typeof layoutFrames>['rowIndex']} */ let rowIndex = [];
    /** @type {Array<{node:any,x:number,y:number,w:number,depth:number,color:string,highlighted:boolean,ancestor:boolean,collapsedNative:boolean}>} */ let taskFrames = [];
    /** @type {any} */ let hoveredFrame = null;
    let searchTerm = '';
    let searchMode = 'text'; // 'text' | 'path'
    let rafId = 0;
    let collapseNative = false;
    let hasNative = false;

    const ANIM_MS = 220;

    const chartEl = /** @type {HTMLElement} */ (document.getElementById('chart'));
    const footer  = document.getElementById('footer');

    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    chartEl.appendChild(canvas);
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));

    /**
     * @param {boolean} animate  false on initial load (nothing to interpolate from)
     */
    function rebuildAndRender(animate) {
        if (!rootNode) { return; }
        const root = document.documentElement;
        const rootStyle = getComputedStyle(root);
        const bodyFs = parseFloat(getComputedStyle(document.body).fontSize) || 13;
        FONT_SIZE   = bodyFs;
        FONT_FAMILY = rootStyle.getPropertyValue('--vscode-font-family').trim() || 'system-ui, sans-serif';
        CELL_H = Math.max(20, Math.ceil(FONT_SIZE * 1.8));
        if (footer) { footer.style.fontSize = Math.round(FONT_SIZE * 0.95) + 'px'; }
        const zoomRoot = zoomNode || rootNode;
        const cssWidth = chartEl.clientWidth;

        // Snapshot previous positions before recomputing layout
        /** @type {Map<any,{x:number,y:number,w:number}>} */
        const prevPos = new Map();
        if (animate) {
            for (const f of frames) { prevPos.set(f.node, { x: f.x, y: f.y, w: f.w }); }
        }

        const ancestors = zoomNode ? findAncestors(rootNode, zoomNode) : [];
        const layout = layoutFrames(zoomRoot, cssWidth, ancestors, CELL_H, collapseNative);
        frames = layout.frames;
        rowIndex = layout.rowIndex;

        // Floating task towers: one shared absolute time scale (px per unit
        // of value) across the main flamegraph and every floating tower, so
        // box widths stay comparable everywhere — see flamegraph-utils.js.
        // Each distinct anchor point (grouped by its exact frame position —
        // task-kind siblings collected from the same parent frame share one)
        // gets its own floating region, placed right below that frame (a
        // small gap, not the whole tree's deepest stack) and only pushed
        // further down if something else actually overlaps it horizontally.
        const globalScale = rootNode.value > 0 ? cssWidth / rootNode.value : 0;
        const mainRows = rowIndex.length;
        const mainBottom = mainRows * CELL_H;

        const anchorGroups = groupAnchorsByPosition(layout.anchors);

        taskFrames = [];
        let taskRegionBottom = mainBottom;
        // A tower renders at its own true width (value * globalScale),
        // starting from wherever its anchor frame sits -- which can put
        // anchorX + groupWidth well past cssWidth (e.g. a task spanning
        // most of the capture, anchored anywhere but the very start). The
        // main layout above is intentionally NOT rescaled to make that fit
        // (that would break the "one shared time scale" comparability the
        // towers are for); the canvas just needs to be wide enough to draw
        // the rest, same as taskRegionBottom already does for height.
        let taskRegionRight = cssWidth;

        for (const group of anchorGroups.values()) {
            const [anchor] = group;
            const forest = layoutTaskForest(group, globalScale, CELL_H, undefined, undefined, collapseNative);
            if (!forest.towers.length) { continue; }

            const groupWidth = Math.max(...forest.towers.map(t => t.offsetX + t.tower.width));
            const floorY = computeFloorY(
                rowIndex, anchor.anchorX, anchor.anchorX + groupWidth, CELL_H,
                anchor.anchorY + CELL_H
            ) + LANE_GAP;

            // Anchors here are already absolute (collected during the main
            // flamegraph's own layout above) -- only the towers themselves
            // get placed at a chosen origin (just below the anchor's row).
            const flattened = flattenTaskForest(forest, 0, 0, anchor.anchorX, floorY, CELL_H);
            for (const f of flattened.frames) {
                taskFrames.push({
                    node: f.node, x: f.x, y: f.y, w: f.w, depth: f.depth,
                    color: f.collapsedNative ? NATIVE_COLLAPSED_COLOR : colorFor(f.node),
                    highlighted: false, ancestor: false, collapsedNative: f.collapsedNative,
                });
            }
            taskRegionBottom = Math.max(taskRegionBottom, floorY + forest.totalHeight);
            taskRegionRight = Math.max(taskRegionRight, anchor.anchorX + groupWidth);
        }

        applySearch();

        const cssHeight = taskRegionBottom;
        const cssCanvasWidth = taskRegionRight;
        canvas.style.width = cssCanvasWidth + 'px';
        canvas.width = Math.round(cssCanvasWidth * DPR);
        canvas.style.height = cssHeight + 'px';
        canvas.height = Math.round(cssHeight * DPR);

        // Cancel any in-progress animation
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }

        if (!animate || prevPos.size === 0) {
            render(canvas, ctx, frames, hoveredFrame, null, 1);
            renderMinimap();
            return;
        }

        let startTime = 0;
        /** @param {number} ts */
        function step(ts) {
            if (!startTime) { startTime = ts; }
            const t = easeInOut(Math.min(1, (ts - startTime) / ANIM_MS));
            render(canvas, ctx, frames, null, prevPos, t);
            rafId = t < 1 ? requestAnimationFrame(step) : 0;
        }
        rafId = requestAnimationFrame(step);
        renderMinimap();
    }

    function applySearch() {
        // Covers floating task frames too, not just the main tree -- a
        // search term that only appears inside a task's coroutine stack
        // must still find and highlight it.
        for (const f of frames.concat(taskFrames)) {
            if (searchMode === 'path') {
                f.highlighted = f.node.frameKey === searchTerm;
            } else {
                if (!searchTerm) { f.highlighted = false; continue; }
                f.highlighted = (f.node.name || '').indexOf(searchTerm) !== -1 ||
                    !!(f.node.file && f.node.file.indexOf(searchTerm) !== -1);
            }
        }
    }

    /** @param {any} hierarchy */
    function loadData(hierarchy) {
        if (!hierarchy || isEmpty(hierarchy)) { return; }
        if (hierarchy.children) {
            for (const child of hierarchy.children) { addPathKeys(child, 0); }
        }
        // Preserve zoom and search across live updates by re-finding the node
        const prevZoomKey = zoomNode ? zoomNode.frameKey : null;
        rootNode = hierarchy;
        hasNative = hasAnyNativeFrame(rootNode);
        if (!hasNative) { collapseNative = false; }
        applyNativeToggle();
        hoveredFrame = null;
        if (prevZoomKey !== null && prevZoomKey !== undefined) {
            zoomNode = findByKey(rootNode, prevZoomKey) || null;
        } else {
            zoomNode = null;
            searchTerm = '';
        }
        rebuildAndRender(false);
    }

    /** @param {any} node */
    function zoomTo(node) {
        zoomNode = node;
        hoveredFrame = null;
        rebuildAndRender(true);
    }

    function resetZoom() {
        zoomNode = null;
        hoveredFrame = null;
        rebuildAndRender(true);
    }

    /** @param {string} term @param {string} mode */
    function setSearch(term, mode) {
        searchTerm = term;
        searchMode = mode || 'text';
        applySearch();
        render(canvas, ctx, frames, hoveredFrame, null, 1);
        renderMinimap();
    }

    function clearSearch() {
        searchTerm = '';
        applySearch();
        render(canvas, ctx, frames, hoveredFrame, null, 1);
        renderMinimap();
    }

    /** @param {any} node @param {number} frameKey @returns {any} */
    function findByKey(node, frameKey) {
        if (node.frameKey === frameKey) { return node; }
        if (node.children) {
            for (const child of node.children) {
                const found = findByKey(child, frameKey);
                if (found) { return found; }
            }
        }
        return null;
    }

    /** @param {number} frameKey */
    function focusByKey(frameKey) {
        if (!rootNode) { return; }
        const target = findByKey(rootNode, frameKey);
        // Set state in one shot to avoid double animation
        zoomNode = target || null;
        hoveredFrame = null;
        searchTerm = frameKey;
        searchMode = 'path';
        rebuildAndRender(true);
        if (target) {
            setTimeout(() => canvas.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), ANIM_MS + 30);
        }
    }

    // ── Events ────────────────────────────────────────────────────────────────

    canvas.addEventListener('click', e => {
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
        const f = hitTestMain(cx, cy);
        if (!f) { return; }
        // zoomTo works uniformly here: the clicked node (whether a main-tree
        // frame, a floating task frame, or a task's own caption/border) is
        // still reachable from rootNode via the underlying tree structure
        // (task-kind children are only excluded from the main flamegraph's
        // own WIDTH split, not from the tree itself), so findAncestors/
        // layoutFrames zoom into it exactly like any other node.
        zoomTo(f.node);
        if (f.node.file) {
            vscode.postMessage({ file: f.node.file, name: f.node.name, line: f.node.line, source: f.node.source, frameKey: f.node.frameKey });
        }
    });

    canvas.addEventListener('mousemove', e => {
        const rect = canvas.getBoundingClientRect();
        const f = hitTestMain(e.clientX - rect.left, e.clientY - rect.top);
        if (f === hoveredFrame) { return; }
        hoveredFrame = f;
        if (footer) { footer.innerHTML = f ? footerText(f.node, rootNode.value, currentMode) : ''; }
        render(canvas, ctx, frames, hoveredFrame, null, 1);
    });

    canvas.addEventListener('mouseleave', () => {
        hoveredFrame = null;
        if (footer) { footer.innerHTML = ''; }
        render(canvas, ctx, frames, null, null, 1);
    });

    new ResizeObserver(() => { if (rootNode) { rebuildAndRender(false); } }).observe(chartEl);

    // ── Metadata ──────────────────────────────────────────────────────────────

    /** @param {any} meta */
    function setMetadata(meta) {
        if (!meta || isEmpty(meta)) { return; }
        currentMode = meta.mode || 'cpu';
        const modeSpan = document.getElementById('mode');
        const header   = document.getElementById('header');
        let mode;
        switch (meta.mode) {
            case 'cpu':
                mode = 'CPU Time Profile';
                document.body.style.backgroundColor = 'rgba(127, 0, 0, .15)';
                if (header) { header.style.backgroundColor = 'rgba(192, 64, 64, .8)'; }
                break;
            case 'wall':
                mode = 'Wall Time Profile';
                document.body.style.backgroundColor = 'rgba(127, 127, 0, .15)';
                if (header) { header.style.backgroundColor = 'rgba(192, 192, 64, .8)'; }
                break;
            case 'memory':
                mode = 'Memory Allocations Profile';
                document.body.style.backgroundColor = 'rgba(0, 127, 0, .15)';
                if (header) { header.style.backgroundColor = 'rgba(64, 192, 64, .8)'; }
                break;
            default:
                mode = '[unsupported profile mode]';
        }
        if (modeSpan) { modeSpan.innerHTML = mode; }
    }

    /** Returns the [r,g,b] triple for the current profile mode. */
    function modeRgb() {
        switch (currentMode) {
            case 'wall':   return [192, 192, 64];
            case 'memory': return [64,  192, 64];
            default:       return [192, 64,  64];  // cpu
        }
    }

    // ── Minimap ───────────────────────────────────────────────────────────────

    const MINI_MAX_H       = 120;  // max CSS height of the frame portion of the minimap canvas
    const MINI_CELL_H_MAX  = 5;    // max row height in minimap
    const MINI_CELL_H_MIN  = 2;    // min row height in minimap
    const MINI_TASK_MAX_H  = 60;   // extra CSS height budget for the task-tower overlay, clipped past this

    const minimapPanel     = document.getElementById('minimap-panel');
    const minimap          = /** @type {HTMLCanvasElement|null} */ (document.getElementById('minimap'));
    const minimapToggle    = document.getElementById('minimap-toggle');
    const minimapSnapLeft  = document.getElementById('minimap-snap-left');
    const minimapSnapRight = document.getElementById('minimap-snap-right');
    const minimapCtx       = minimap ? minimap.getContext('2d') : null;
    const nativeToggle      = document.getElementById('native-toggle');
    const nativeToggleInput = /** @type {HTMLInputElement|null} */ (document.getElementById('native-toggle-input'));

    let minimapCollapsed = false;
    /** @type {'left'|'right'} */
    let minimapSide = 'right';

    function applyMinimapSide() {
        if (!minimapPanel) { return; }
        minimapPanel.classList.toggle('snap-left', minimapSide === 'left');
        if (minimapSnapLeft)  { minimapSnapLeft.classList.toggle('active',  minimapSide === 'left'); }
        if (minimapSnapRight) { minimapSnapRight.classList.toggle('active', minimapSide === 'right'); }
    }

    function applyMinimapCollapsed() {
        if (!minimapPanel) { return; }
        minimapPanel.classList.toggle('collapsed', minimapCollapsed);
        if (minimapToggle) {
            minimapToggle.textContent = minimapCollapsed ? '▴' : '▾';
            minimapToggle.title = minimapCollapsed ? 'Expand minimap (M)' : 'Collapse minimap (M)';
        }
    }

    function applyNativeToggle() {
        if (!nativeToggle) { return; }
        nativeToggle.classList.toggle('hidden', !hasNative);
        // "Native" toggle ON means native frames are visible (uncollapsed).
        nativeToggle.classList.toggle('active', !collapseNative);
        nativeToggle.title = collapseNative ? 'Show native frames (N)' : 'Collapse native frames (N)';
        if (nativeToggleInput) { nativeToggleInput.checked = !collapseNative; }
    }

    function savePrefs() {
        const current = vscode.getState() || {};
        vscode.setState(Object.assign({}, current, { minimapSide, minimapCollapsed, collapseNative }));
    }
    /** @type {{frames: ReturnType<typeof layoutFrames>['frames'], rowIndex: ReturnType<typeof layoutFrames>['rowIndex'], taskFrames: Array<{node:any,x:number,y:number,w:number}>, cellH: number, width: number, height: number} | null} */
    let miniLayout = null;

    /** Collect a node and all its descendants into a Set. @param {any} node */
    function subtreeSet(node) {
        const set = new Set();
        /** @param {any} n */
        function walk(n) { set.add(n); if (n.children) { for (const c of n.children) { walk(c); } } }
        walk(node);
        return set;
    }

    function renderMinimap() {
        if (!minimapPanel || !minimap || !minimapCtx) { return; }

        const shouldShow = !!(rootNode && zoomNode);
        if (!shouldShow) {
            minimapPanel.classList.add('hidden');
            miniLayout = null;
            return;
        }
        minimapPanel.classList.remove('hidden');
        applyMinimapCollapsed();
        if (minimapCollapsed) { miniLayout = null; return; }

        const cssWidth = minimap.clientWidth || 232;

        // Provisional layout at max cell height, then shrink if it overflows MINI_MAX_H
        let cellH = MINI_CELL_H_MAX;
        let layout = layoutFrames(rootNode, cssWidth, [], cellH, collapseNative);
        let rowCount = layout.rowIndex.length;
        let frameCssHeight = rowCount * cellH;
        if (frameCssHeight > MINI_MAX_H) {
            cellH = Math.max(MINI_CELL_H_MIN, Math.floor(MINI_MAX_H / rowCount));
            layout = layoutFrames(rootNode, cssWidth, [], cellH, collapseNative);
            rowCount = layout.rowIndex.length;
            frameCssHeight = rowCount * cellH;
        }

        // Floating task towers, at the minimap's own scale -- same anchors
        // layoutFrames already collected, grouped and flattened the same
        // way the main canvas does (see render()), just clipped to a small
        // extra height budget so the panel stays "mini".
        const miniScale = rootNode.value > 0 ? cssWidth / rootNode.value : 0;
        const anchorGroups = groupAnchorsByPosition(layout.anchors);
        const taskFrames = [];
        let taskRegionBottom = frameCssHeight;
        for (const group of anchorGroups.values()) {
            const [anchor] = group;
            const forest = layoutTaskForest(group, miniScale, cellH, undefined, undefined, collapseNative);
            if (!forest.towers.length) { continue; }
            const groupWidth = Math.max(...forest.towers.map(t => t.offsetX + t.tower.width));
            const floorY = computeFloorY(
                layout.rowIndex, anchor.anchorX, anchor.anchorX + groupWidth, cellH, anchor.anchorY + cellH
            );
            const flattened = flattenTaskForest(forest, 0, 0, anchor.anchorX, floorY, cellH);
            taskFrames.push(...flattened.frames);
            taskRegionBottom = Math.max(taskRegionBottom, floorY + forest.totalHeight);
        }
        const taskCssHeight = Math.min(MINI_TASK_MAX_H, Math.max(0, taskRegionBottom - frameCssHeight));
        const cssHeight = frameCssHeight + taskCssHeight;

        miniLayout = { frames: layout.frames, rowIndex: layout.rowIndex, taskFrames, cellH, width: cssWidth, height: cssHeight };

        minimap.style.width  = cssWidth + 'px';
        minimap.style.height = cssHeight + 'px';
        minimap.width  = Math.round(cssWidth * DPR);
        minimap.height = Math.round(cssHeight * DPR);

        const ctx = minimapCtx;
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        ctx.clearRect(0, 0, cssWidth, cssHeight);

        const subtree = zoomNode ? subtreeSet(zoomNode) : null;

        /** @param {any} node */
        function matchesSearch(node) {
            if (!searchTerm) { return false; }
            if (searchMode === 'path') { return node.frameKey === searchTerm; }
            return (node.name || '').indexOf(searchTerm) !== -1 ||
                !!(node.file && node.file.indexOf(searchTerm) !== -1);
        }

        for (const f of layout.frames) {
            const dim = subtree ? !subtree.has(f.node) : false;
            ctx.globalAlpha = dim ? 0.28 : 1;
            ctx.fillStyle = f.color;
            ctx.fillRect(f.x, f.y, f.w, cellH);

            if (matchesSearch(f.node)) {
                ctx.fillStyle = 'rgba(255,230,80,0.8)';
                ctx.fillRect(f.x, f.y, f.w, cellH);
            }
        }
        ctx.globalAlpha = 1;

        // Task towers occupy the region below the frame rows, clipped to
        // the budget reserved above -- deep nesting is truncated here
        // (it's an overview, not the primary view) rather than growing the
        // floating panel without bound.
        if (taskFrames.length && taskCssHeight > 0) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, frameCssHeight, cssWidth, taskCssHeight);
            ctx.clip();
            for (const f of taskFrames) {
                const dim = subtree ? !subtree.has(f.node) : false;
                ctx.globalAlpha = dim ? 0.28 : 1;
                ctx.fillStyle = f.collapsedNative ? NATIVE_COLLAPSED_COLOR : colorFor(f.node);
                ctx.fillRect(f.x, f.y, f.w, cellH);

                if (matchesSearch(f.node)) {
                    ctx.fillStyle = 'rgba(255,230,80,0.8)';
                    ctx.fillRect(f.x, f.y, f.w, cellH);
                }
            }
            ctx.globalAlpha = 1;
            ctx.restore();
        }

        // Bounding box around the zoomed subtree. Checks taskFrames too, not
        // just the main-tree layout.frames -- zoomNode (set by zoomTo/
        // focusByKey for a task selected from the Tasks view or a task-trace
        // block) can itself be a task, or live inside one, and task-kind
        // nodes never appear in layout.frames (layoutFrames excludes them,
        // see its own doc comment). Without this, subtree's members are
        // never found, xMin stays Infinity, and the box is silently skipped
        // -- selecting or scrolling to a task frame looks unsynced because
        // no highlight ever appears for it.
        if (zoomNode && subtree) {
            let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
            for (const f of layout.frames.concat(taskFrames)) {
                if (subtree.has(f.node)) {
                    if (f.x < xMin) { xMin = f.x; }
                    if (f.x + f.w > xMax) { xMax = f.x + f.w; }
                    if (f.y < yMin) { yMin = f.y; }
                    if (f.y + cellH > yMax) { yMax = f.y + cellH; }
                }
            }
            if (xMin !== Infinity) {
                const pad = 1;
                const bx = Math.max(0, xMin - pad);
                const by = Math.max(0, yMin - pad);
                const bw = Math.min(cssWidth, xMax + pad) - bx;
                const bh = Math.min(cssHeight, yMax + pad) - by;
                ctx.strokeStyle = 'rgba(255,255,255,0.95)';
                ctx.lineWidth = 1.2;
                ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
                ctx.strokeStyle = 'rgba(0,0,0,0.5)';
                ctx.lineWidth = 0.8;
                ctx.strokeRect(bx - 0.5, by - 0.5, bw + 1, bh + 1);
            }
        }
    }

    if (minimap) {
        minimap.addEventListener('click', e => {
            if (!miniLayout) { return; }
            const rect = minimap.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const f = hitTest(miniLayout.rowIndex, cx, cy, miniLayout.cellH);
            if (f) { zoomTo(f.node); return; }
            for (const tf of miniLayout.taskFrames) {
                if (cx >= tf.x && cx < tf.x + tf.w && cy >= tf.y && cy < tf.y + miniLayout.cellH) {
                    zoomTo(tf.node);
                    return;
                }
            }
        });
    }
    if (minimapToggle) {
        minimapToggle.addEventListener('click', e => {
            e.stopPropagation();
            minimapCollapsed = !minimapCollapsed;
            renderMinimap();
            savePrefs();
        });
    }
    if (minimapSnapLeft) {
        minimapSnapLeft.addEventListener('click', e => {
            e.stopPropagation();
            minimapSide = 'left';
            applyMinimapSide();
            savePrefs();
        });
    }
    if (minimapSnapRight) {
        minimapSnapRight.addEventListener('click', e => {
            e.stopPropagation();
            minimapSide = 'right';
            applyMinimapSide();
            savePrefs();
        });
    }
    if (nativeToggleInput) {
        nativeToggleInput.addEventListener('change', () => {
            if (!hasNative) {
                nativeToggleInput.checked = true;
                return;
            }
            collapseNative = !nativeToggleInput.checked;
            applyNativeToggle();
            rebuildAndRender(true);
            savePrefs();
        });
    }

    // ── GC Swimlanes ──────────────────────────────────────────────────────────

    const gcPanel   = document.getElementById('gc-panel');
    const gcDetails = /** @type {HTMLDetailsElement|null} */ (document.getElementById('gc-details'));
    const gcLanes   = document.getElementById('gc-swimlanes');

    const gcTooltip = (() => {
        const el = document.createElement('div');
        el.id = 'gc-tooltip';
        document.body.appendChild(el);
        return el;
    })();

    /** @param {MouseEvent} e */
    function positionGCTooltip(e) {
        const margin = 14;
        const tw = gcTooltip.offsetWidth;
        const th = gcTooltip.offsetHeight;
        let x = e.clientX + margin;
        let y = e.clientY + margin;
        if (x + tw > window.innerWidth)  { x = e.clientX - tw - margin; }
        if (y + th > window.innerHeight) { y = e.clientY - th - margin; }
        gcTooltip.style.left = x + 'px';
        gcTooltip.style.top  = y + 'px';
    }

    /**
     * Walk the hierarchy to find a thread node by pid:tid key.
     * @param {string} threadKey  "${pid}:${iid}:${tid}"
     * @returns {any|null}
     */
    function findThreadNode(threadKey) {
        if (!rootNode) { return null; }
        const colonIdx = threadKey.indexOf(':');
        if (colonIdx < 0) { return null; }
        const pid = threadKey.slice(0, colonIdx);
        const tid = threadKey.slice(colonIdx + 1);
        for (const proc of (rootNode.children || [])) {
            if (proc.name === `Process ${pid}`) {
                for (const thread of (proc.children || [])) {
                    if (thread.name === `Thread ${tid}`) { return thread; }
                }
            }
        }
        return null;
    }

    /**
     * Render pre-computed GC spans (built by the extension backend).
     * @param {any[]} threadSpans
     */
    function loadGCSpans(threadSpans) {
        if (!gcLanes || !gcPanel) { return; }
        gcLanes.innerHTML = '';

        if (!threadSpans || threadSpans.length === 0) {
            gcPanel.style.display = 'none';
            return;
        }

        const [mr, mg, mb] = modeRgb();
        const spanColor      = `rgba(${mr},${mg},${mb},0.75)`;
        const highlightColor = `rgba(${mr},${mg},${mb},0.15)`;

        for (const { label, threadKey, spans } of threadSpans) {
            const row = document.createElement('div');
            row.className = 'swimlane-row';

            const labelEl = document.createElement('span');
            labelEl.className = 'swimlane-label';
            labelEl.textContent = label;
            labelEl.title = 'Click to focus thread in flame graph';
            labelEl.style.cursor = 'pointer';
            labelEl.addEventListener('click', () => {
                // Deactivate all rows, activate this one
                gcLanes.querySelectorAll('.swimlane-row').forEach(r => {
                    r.classList.remove('active');
                    /** @type {HTMLElement} */ (r).style.background = '';
                });
                row.classList.add('active');
                row.style.background = highlightColor;
                const node = findThreadNode(threadKey);
                if (node) { zoomTo(node); }
            });
            row.appendChild(labelEl);

            const track = document.createElement('div');
            track.className = 'swimlane-track';

            for (const span of spans) {
                const block = document.createElement('div');
                block.className = 'swimlane-block';
                block.style.left       = (span.startFraction * 100).toFixed(3) + '%';
                block.style.width      = `max(2px, ${(span.durationFraction * 100).toFixed(3)}%)`;
                block.style.background = spanColor;

                block.addEventListener('mouseenter', (e) => {
                    let html = `<div style="font-weight:600;margin-bottom:3px">${esc(label)}</div>`;
                    html += `<div>GC span: <b>${span.durationPct}%</b> of thread time</div>`;
                    if (span.topFrames.length > 0) {
                        html += `<div style="margin-top:5px;opacity:0.65;font-size:10px;text-transform:uppercase;letter-spacing:0.05em">Top contributors</div>`;
                        for (const { scope, module: mod, fraction } of span.topFrames) {
                            html += `<div style="opacity:0.85;font-size:10px">· ${esc(scope)} <span style="opacity:0.6">(${(fraction * 100).toFixed(0)}%)</span></div>`;
                        }
                    }
                    gcTooltip.innerHTML = html;
                    gcTooltip.style.display = 'block';
                    positionGCTooltip(/** @type {MouseEvent} */ (e));
                });
                block.addEventListener('mousemove', (e) => positionGCTooltip(/** @type {MouseEvent} */ (e)));
                block.addEventListener('mouseleave', () => { gcTooltip.style.display = 'none'; });

                track.appendChild(block);
            }

            row.appendChild(track);
            gcLanes.appendChild(row);
        }

        gcPanel.style.display = gcLanes.children.length > 0 ? 'block' : 'none';
    }

    // ── Task Trace ────────────────────────────────────────────────────────────

    const taskPanel = document.getElementById('task-panel');
    const taskLanes = document.getElementById('task-swimlanes');

    const taskTooltip = (() => {
        const el = document.createElement('div');
        el.id = 'task-tooltip';
        document.body.appendChild(el);
        return el;
    })();

    /** @param {MouseEvent} e */
    function positionTaskTooltip(e) {
        const margin = 14;
        const tw = taskTooltip.offsetWidth;
        const th = taskTooltip.offsetHeight;
        let x = e.clientX + margin;
        let y = e.clientY + margin;
        if (x + tw > window.innerWidth)  { x = e.clientX - tw - margin; }
        if (y + th > window.innerHeight) { y = e.clientY - th - margin; }
        taskTooltip.style.left = x + 'px';
        taskTooltip.style.top  = y + 'px';
    }

    const TASK_TRACE_BLOCK_H = 16; // px, must match .task-trace-block's height
    // Compact stacking (single child, no spine needed) uses NO gap at all --
    // same idea as the main flamegraph's directly-touching call frames,
    // distinguished only by the color/border change between them. A spine
    // needs a little more room to actually read as a connector.
    const TASK_TRACE_GAP_THIN = 0;
    const TASK_TRACE_GAP_WIDE = 6;

    // One color per await-nesting level -- siblings (same parent) share a
    // color, children use the next one, so depth reads at a glance instead
    // of only from indentation/position. Cycles if nesting goes deeper.
    const TASK_LEVEL_COLORS = [
        { bg: 'rgba(220, 140, 30, 0.82)',  fg: '#1a1200' }, // amber
        { bg: 'rgba(88, 175, 205, 0.82)',  fg: '#04222c' }, // teal
        { bg: 'rgba(175, 120, 210, 0.82)', fg: '#1f0f2e' }, // violet
        { bg: 'rgba(130, 190, 110, 0.82)', fg: '#0f2a08' }, // green
        { bg: 'rgba(220, 100, 110, 0.82)', fg: '#2a0508' }, // rose
    ];

    /** @param {number} depth */
    function taskLevelColor(depth) {
        return TASK_LEVEL_COLORS[depth % TASK_LEVEL_COLORS.length];
    }

    /**
     * Whether ANY two of these (start/end-fraction) nodes overlap in time.
     * Sequential siblings (e.g. one task awaiting several subtasks one
     * after another, never concurrently) don't need a spine to tell them
     * apart -- their positions alone already read as a plain sequence.
     * Checking only ADJACENT pairs once sorted by start is enough: if node
     * i's range reached far enough to overlap some LATER node k, it would
     * already have to overlap every node between them too (their start
     * time is >= i's and <= k's, which is inside i's still-open range).
     * @param {any[]} nodes
     * @returns {boolean}
     */
    function childrenOverlap(nodes) {
        if (nodes.length <= 1) {
            return false;
        }
        const sorted = [...nodes].sort((a, b) => a.startFraction - b.startFraction);
        for (let i = 0; i < sorted.length - 1; i++) {
            if (sorted[i].endFraction > sorted[i + 1].startFraction) {
                return true;
            }
        }
        return false;
    }

    /**
     * Lays out a set of siblings (a task's awaited children, or a thread's
     * root tasks) starting at `y`, appending {node, y, depth} placement
     * entries and, if a spine is needed, one edge to `edges`.
     *
     * When NONE of them overlap in time -- a plain sequence, nothing to
     * disambiguate -- they all share the exact same row, like a normal
     * flame graph's non-overlapping callee frames: there's no need to
     * push any of them further down, and no spine. Safe because each
     * one's entire (already parent-bounds-clipped) subtree stays within
     * its own [start, end], so siblings that don't overlap can never have
     * descendants that do either.
     *
     * When at least one pair DOES overlap, every sibling gets its own
     * exclusive row instead, ordered by DESCENDING start time (latest
     * shallow, earliest deep), and a spine connects the parent's bottom
     * edge to each of them. This is deliberately NOT "pack whatever
     * doesn't overlap, one row per remaining conflict": once genuine
     * overlap exists, lanes could hold several siblings each spread across
     * disjoint stretches of time, and ordering lanes by e.g. their
     * earliest child no longer guarantees a deeper lane's peg stays
     * strictly left of every shallower lane's boxes -- only the simple
     * one-sibling-per-row rule has that guarantee (a deeper sibling's own
     * single x is always <= every shallower sibling's).
     * `leadingGap` says whether a gap is owed BEFORE the very first sibling
     * too: yes for a task's own children (there's a real parent block right
     * above to leave a gap after), no for a thread's root tasks (nothing
     * sits above the first one -- it starts right where the thread's own
     * label, a separate DOM element, already ends).
     * @param {any[]} siblings
     * @param {number} y
     * @param {number} depth
     * @param {{node: any, y: number, depth: number}[]} placements
     * @param {{parentY: number, children: {node: any, y: number, depth: number}[]}[]} edges
     * @param {boolean} leadingGap
     * @returns {number} px height consumed
     */
    function layoutSiblings(siblings, y, depth, placements, edges, leadingGap) {
        const needsSpine = childrenOverlap(siblings);
        const gap = needsSpine ? TASK_TRACE_GAP_WIDE : TASK_TRACE_GAP_THIN;
        const childEntries = [];
        let used;

        if (!needsSpine) {
            const rowY = y + (leadingGap ? gap : 0);
            let rowHeight = 0;
            for (const sibling of siblings) {
                childEntries.push({ node: sibling, y: rowY, depth });
                rowHeight = Math.max(rowHeight, layoutTaskTraceSubtree(sibling, rowY, depth, placements, edges));
            }
            used = (leadingGap ? gap : 0) + rowHeight;
        } else {
            const ordered = [...siblings].sort((a, b) => b.startFraction - a.startFraction);
            used = 0;
            ordered.forEach((sibling, idx) => {
                const thisGap = idx === 0 && !leadingGap ? 0 : gap;
                const siblingY = y + used + thisGap;
                childEntries.push({ node: sibling, y: siblingY, depth });
                used += thisGap + layoutTaskTraceSubtree(sibling, siblingY, depth, placements, edges);
            });
            edges.push({ parentY: y, children: childEntries });
        }

        return used;
    }

    /**
     * Lays out one task's subtree, appending {node, y, depth} entries to
     * `placements` (y in px from the cluster's top) -- see layoutSiblings
     * for how its children are placed relative to it.
     * @param {any} node
     * @param {number} y
     * @param {number} depth
     * @param {{node: any, y: number, depth: number}[]} placements
     * @param {{parentY: number, children: {node: any, y: number, depth: number}[]}[]} edges
     * @returns {number} px height of this node's subtree, including its own block
     */
    function layoutTaskTraceSubtree(node, y, depth, placements, edges) {
        placements.push({ node, y, depth });

        const children = node.children || [];
        if (children.length === 0) {
            return TASK_TRACE_BLOCK_H;
        }

        return TASK_TRACE_BLOCK_H
            + layoutSiblings(children, y + TASK_TRACE_BLOCK_H, depth + 1, placements, edges, true);
    }

    /**
     * Lays out every root task owned by one thread. A thread can have
     * several root tasks (nothing awaits any of them directly) -- the
     * effective "root" of this whole visualization is really the thread,
     * not any single task, so its root tasks get exactly the same
     * treatment as any other set of siblings (see layoutSiblings),
     * starting right at the top of the cluster (where the thread's own
     * label sits, just above).
     * @param {any[]} roots
     * @param {{node: any, y: number, depth: number}[]} placements
     * @param {{parentY: number, children: {node: any, y: number, depth: number}[]}[]} edges
     * @returns {number} total px height of the cluster
     */
    function layoutTaskTraceGroup(roots, placements, edges) {
        if (roots.length === 0) {
            return 0;
        }
        return layoutSiblings(roots, 0, 0, placements, edges, false);
    }

    /**
     * Builds the SVG spine overlay for one cluster: for a parent with
     * multiple children (a task with several awaited children, or a
     * thread with several root tasks), one independent straight vertical
     * line PER child, dropped from the parent's bottom edge down to that
     * child's own row, at the child's own x -- not a shared trunk fanning
     * out to each child (that reads as a pstree; this is meant to look
     * like flags mounted directly on their own poles). Each peg is colored
     * to match the level it leads to, via the same taskLevelColor as the
     * child's own block.
     *
     * This only stays collision-free because of the row order chosen in
     * layoutTaskTraceSubtree/layoutTaskTraceGroup: the deepest child is
     * always the EARLIEST-starting one, so its peg -- drawn at that small
     * x -- passes down through rows occupied only by siblings (and their
     * clipped-in descendants) that start at an x at least as large, and
     * therefore never crosses through any of their bars.
     * @param {{parentY: number, children: {node: any, y: number, depth: number}[]}[]} edges
     * @param {number} totalHeight
     * @returns {SVGSVGElement}
     */
    function renderTaskTraceSpines(edges, totalHeight) {
        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('class', 'task-trace-spines');
        svg.setAttribute('viewBox', `0 0 100 ${totalHeight}`);
        svg.setAttribute('preserveAspectRatio', 'none');

        for (const { parentY, children } of edges) {
            for (const { node: child, y, depth } of children) {
                const x = child.startFraction * 100;
                const peg = document.createElementNS(svgNS, 'line');
                peg.setAttribute('class', 'task-trace-spine-line');
                peg.style.stroke = taskLevelColor(depth).bg;
                peg.setAttribute('x1', String(x));
                peg.setAttribute('y1', String(parentY));
                peg.setAttribute('x2', String(x));
                // -1: land on the block's own bottom border rather than
                // one px past it (its rendered box is box-sizing:border-box,
                // so the border sits INSIDE the last pixel row of height).
                peg.setAttribute('y2', String(y + TASK_TRACE_BLOCK_H - 1));
                svg.appendChild(peg);
            }
        }

        return svg;
    }

    /**
     * Render one thread's task-trace cluster: every root task it owns (see
     * layoutTaskTraceGroup), each a flame chart of its own awaited
     * children, positioned by real observed time and colored by
     * await-nesting level.
     * @param {any[]} roots
     * @returns {HTMLElement}
     */
    function renderTaskTraceCluster(roots) {
        const placements = [];
        const edges = [];
        const totalHeight = layoutTaskTraceGroup(roots, placements, edges);

        const cluster = document.createElement('div');
        cluster.className = 'task-trace-cluster';
        cluster.style.height = `${totalHeight}px`;
        cluster.appendChild(renderTaskTraceSpines(edges, totalHeight));

        for (const { node, y, depth } of placements) {
            const block = document.createElement('div');
            block.className = 'task-trace-block';
            const startPct = node.startFraction * 100;
            const widthPct = Math.max(0, node.endFraction - node.startFraction) * 100;
            const colors = taskLevelColor(depth);
            block.style.top        = y + 'px';
            block.style.left       = startPct.toFixed(3) + '%';
            block.style.width      = `max(2px, ${widthPct.toFixed(3)}%)`;
            block.style.background = colors.bg;
            block.style.color      = colors.fg;
            block.textContent = node.name || `Task ${node.taskId}`;

            if (node.frameKey !== undefined) {
                block.title = 'Click to focus task in flame graph';
                block.style.cursor = 'pointer';
                block.addEventListener('click', () => {
                    const target = findByKey(rootNode, node.frameKey);
                    if (target) { zoomTo(target); }
                });
            }

            block.addEventListener('mouseenter', (e) => {
                let html = `<div style="font-weight:600;margin-bottom:3px">${esc(node.name || `Task ${node.taskId}`)}</div>`;
                html += `<div>Active for <b>${widthPct.toFixed(1)}%</b> of this thread's runtime</div>`;
                taskTooltip.innerHTML = html;
                taskTooltip.style.display = 'block';
                positionTaskTooltip(/** @type {MouseEvent} */ (e));
            });
            block.addEventListener('mousemove', (e) => positionTaskTooltip(/** @type {MouseEvent} */ (e)));
            block.addEventListener('mouseleave', () => { taskTooltip.style.display = 'none'; });

            cluster.appendChild(block);
        }

        return cluster;
    }

    /**
     * Render pre-computed task-trace trees (built by the extension backend)
     * as one flame-chart cluster per thread, grouped under a non-
     * interactive thread label. Positions are fractions of each cluster's
     * OWN owning thread's clock (see AustinStats.getTaskTraces), not a
     * single timeline shared by every thread -- concurrent tasks within the
     * SAME thread's cluster show up as overlapping in time, but two
     * different threads' clusters are not positioned on one directly-
     * comparable timeline.
     * @param {any[]} threadGroups
     */
    function loadTaskTraces(threadGroups) {
        if (!taskLanes || !taskPanel) { return; }
        taskLanes.innerHTML = '';

        if (!threadGroups || threadGroups.length === 0) {
            taskPanel.style.display = 'none';
            return;
        }

        let clusterCount = 0;

        for (const { pid, tid, roots } of threadGroups) {
            if (!roots || roots.length === 0) { continue; }

            const groupLabel = document.createElement('div');
            groupLabel.className = 'swimlane-group-label';
            groupLabel.textContent = pid === -1 ? 'Orphaned tasks' : `Process ${pid} · Thread ${tid}`;
            taskLanes.appendChild(groupLabel);

            taskLanes.appendChild(renderTaskTraceCluster(roots));
            clusterCount++;
        }

        taskPanel.style.display = clusterCount > 0 ? 'block' : 'none';
    }

    // ── Messages ──────────────────────────────────────────────────────────────

    window.addEventListener('message', event => {
        const msg = event.data;
        if (msg === 'reset') {
            resetZoom();
            clearSearch();
        } else if (msg.focusThread) {
            const node = findThreadNode(msg.focusThread);
            if (node) { zoomTo(node); }
        } else if (msg.focus !== undefined) {
            focusByKey(msg.focus);
        } else if (msg.search) {
            setSearch(msg.search, 'text');
        } else if (msg.meta !== undefined) {
            setMetadata(msg.meta);
            loadData(msg.hierarchy);
            loadGCSpans(msg.gcSpans);
            loadTaskTraces(msg.taskTraces);
            vscode.setState(Object.assign({}, msg, { minimapSide, minimapCollapsed, collapseNative }));
        } else if (msg.hierarchy) {
            loadData(msg.hierarchy);
            vscode.setState(Object.assign({}, msg, { minimapSide, minimapCollapsed, collapseNative }));
        }
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'm' && zoomNode) {
            minimapCollapsed = !minimapCollapsed;
            renderMinimap();
            savePrefs();
            return;
        }
        if (e.key === 'n' && hasNative) {
            collapseNative = !collapseNative;
            applyNativeToggle();
            rebuildAndRender(true);
            savePrefs();
            return;
        }
        vscode.postMessage({ event: 'keydown', name: e.key });
    });

    const searchBox = /** @type {HTMLInputElement|null} */ (document.getElementById('search-box'));
    if (searchBox) {
        searchBox.addEventListener('input', () => {
            searchBox.value ? setSearch(searchBox.value, 'text') : clearSearch();
        });
        searchBox.addEventListener('keydown', e => e.stopPropagation());
    }

    // Restore persisted state on webview reload
    const state = vscode.getState();
    if (state) {
        if (state.minimapSide === 'left' || state.minimapSide === 'right') {
            minimapSide = state.minimapSide;
        }
        if (typeof state.minimapCollapsed === 'boolean') {
            minimapCollapsed = state.minimapCollapsed;
        }
        if (typeof state.collapseNative === 'boolean') {
            collapseNative = state.collapseNative;
        }
        setMetadata(state.meta);
        try { loadData(state.hierarchy); } catch (e) { vscode.setState(null); }
        loadGCSpans(state.gcSpans);
        loadTaskTraces(state.taskTraces);
    }
    applyMinimapSide();
    applyMinimapCollapsed();
    applyNativeToggle();

    vscode.postMessage('initialized');

    // Exposed globally for the Open button's onclick attribute
    /** @type {any} */ (window).onOpen = function () { vscode.postMessage('open'); };
})();
