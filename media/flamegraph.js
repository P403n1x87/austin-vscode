// @ts-check
(function () {
    // @ts-ignore
    const vscode = window.vscode = acquireVsCodeApi();

    // ── Utilities (loaded from flamegraph-utils.js) ───────────────────────────
    // @ts-ignore
    const { colorFor, basename, isEmpty, footerText, esc, hashPath } = FlamegraphUtils;

    /** @param {any} node @param {number} parentHash */
    function addPathKeys(node, parentHash) {
        // Use node.key (module:scope for frames, bare name for process/thread) so that
        // two functions with the same name in different modules get distinct frameKeys.
        node.frameKey = hashPath(node.key, parentHash);
        if (node.children) {
            for (const child of node.children) { addPathKeys(child, node.frameKey); }
        }
    }

    /** A frame node counts as native when it has a source file that isn't Python. @param {any} node */
    function isNative(node) {
        return !!(node.file && !node.file.endsWith('.py'));
    }

    /**
     * Walk the subtree of a native node and return the first non-native
     * descendants along each branch (stopping at the first Python frame).
     * Used to skip over consecutive native frames when the collapse toggle
     * is active.
     * @param {any} nativeNode
     * @returns {any[]}
     */
    function firstNonNativeDescendants(nativeNode) {
        /** @type {any[]} */
        const result = [];
        if (!nativeNode.children) { return result; }
        for (const child of nativeNode.children) {
            if (isNative(child)) {
                for (const d of firstNonNativeDescendants(child)) { result.push(d); }
            } else {
                result.push(child);
            }
        }
        return result;
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
    const NATIVE_COLLAPSED_COLOR = '#6f6f6f';  // flat gray for collapsed native frames

    let currentMode = 'cpu';

    // ── Layout engine ─────────────────────────────────────────────────────────

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

    /**
     * Partition the hierarchy into a flat array of frame descriptors.
     * Ancestors of the zoom root are rendered at full width above it (dimmed).
     * All coordinates are in CSS pixels; the canvas buffer is DPR× larger.
     * When `collapseNative` is true, each native frame is drawn as a single
     * cell and its visible children are replaced with the first non-native
     * descendants — preserving width (and thus metrics) while flattening
     * native call chains. Consecutive native ancestors are also folded.
     * @param {any} zoomRoot
     * @param {number} cssWidth
     * @param {any[]} ancestors  nodes above zoomRoot, root-first
     * @param {number} [cellH]   row height to use (defaults to global CELL_H)
     * @param {boolean} [collapseNative]
     */
    function layoutFrames(zoomRoot, cssWidth, ancestors, cellH, collapseNative) {
        const rowH = cellH || CELL_H;
        /** @type {Array<{node:any,x:number,y:number,w:number,depth:number,color:string,highlighted:boolean,ancestor:boolean,collapsedNative:boolean}>} */
        const frames = [];
        /** @type {Array<typeof frames>} */
        const rowIndex = [];

        /** @param {any} n */
        const displayChildren = (n) => {
            if (collapseNative && isNative(n)) { return firstNonNativeDescendants(n); }
            return n.children || [];
        };

        /** @param {any} n */
        const colorFrame = (n) => {
            if (collapseNative && isNative(n)) { return NATIVE_COLLAPSED_COLOR; }
            return colorFor(n);
        };

        let effectiveAncestors = ancestors;
        if (collapseNative && ancestors.length > 1) {
            effectiveAncestors = [];
            for (const a of ancestors) {
                const prev = effectiveAncestors[effectiveAncestors.length - 1];
                if (isNative(a) && prev && isNative(prev)) { continue; }
                effectiveAncestors.push(a);
            }
        }

        // Ancestors: full-width, dimmed context rows
        for (let i = 0; i < effectiveAncestors.length; i++) {
            const a = effectiveAncestors[i];
            while (rowIndex.length <= i) { rowIndex.push([]); }
            const frame = { node: a, x: 0, y: i * rowH, w: cssWidth,
                depth: i, color: colorFrame(a), highlighted: false, ancestor: true,
                collapsedNative: !!(collapseNative && isNative(a)) };
            frames.push(frame);
            rowIndex[i].push(frame);
        }

        // Zoom root and its descendants
        const offset = effectiveAncestors.length;
        const queue = [{ node: zoomRoot, x: 0, depth: offset, w: cssWidth }];
        while (queue.length) {
            const { node, x, depth, w } = /** @type {any} */ (queue.shift());

            while (rowIndex.length <= depth) { rowIndex.push([]); }
            const frame = { node, x, y: depth * rowH, w, depth, color: colorFrame(node),
                highlighted: false, ancestor: false,
                collapsedNative: !!(collapseNative && isNative(node)) };
            frames.push(frame);
            rowIndex[depth].push(frame);

            const children = displayChildren(node);
            if (!children.length) { continue; }

            const scale = w / node.value;
            let childX = x;
            for (const child of children) {
                const childW = child.value * scale;
                if (childW >= 1) {
                    queue.push({ node: child, x: childX, depth: depth + 1, w: childW });
                }
                childX += childW;
            }
        }

        return { frames, rowIndex };
    }

    // ── Render engine ─────────────────────────────────────────────────────────

    /** @param {number} a @param {number} b @param {number} t */
    function lerp(a, b, t) { return a + (b - a) * t; }

    /** Ease-in-out quad. @param {number} t */
    function easeInOut(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }

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

            ctx.globalAlpha = f.ancestor ? 0.45 : 1;
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

        if (hoveredFrame && t === 1) {
            ctx.shadowColor = 'rgba(255,255,255,0.7)';
            ctx.shadowBlur = 8;
            ctx.strokeStyle = 'rgba(255,255,255,0.9)';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(
                hoveredFrame.x + 0.75, hoveredFrame.y + 0.75,
                hoveredFrame.w - 1.5, CELL_H - 1.5
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

    // ── Controller ────────────────────────────────────────────────────────────

    /** @type {any} */ let rootNode = null;
    /** @type {any} */ let zoomNode = null;
    /** @type {ReturnType<typeof layoutFrames>['frames']} */ let frames = [];
    /** @type {ReturnType<typeof layoutFrames>['rowIndex']} */ let rowIndex = [];
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

        canvas.style.width = cssWidth + 'px';
        canvas.width = Math.round(cssWidth * DPR);

        const ancestors = zoomNode ? findAncestors(rootNode, zoomNode) : [];
        const layout = layoutFrames(zoomRoot, cssWidth, ancestors, undefined, collapseNative);
        frames = layout.frames;
        rowIndex = layout.rowIndex;

        applySearch();

        const cssHeight = rowIndex.length * CELL_H;
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
        for (const f of frames) {
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
        const f = hitTest(rowIndex, e.clientX - rect.left, e.clientY - rect.top);
        if (!f) { return; }
        zoomTo(f.node);
        if (f.node.file) {
            vscode.postMessage({ file: f.node.file, name: f.node.name, line: f.node.line, source: f.node.source, frameKey: f.node.frameKey });
        }
    });

    canvas.addEventListener('mousemove', e => {
        const rect = canvas.getBoundingClientRect();
        const f = hitTest(rowIndex, e.clientX - rect.left, e.clientY - rect.top);
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

    const MINI_MAX_H       = 120;  // max CSS height of minimap canvas
    const MINI_CELL_H_MAX  = 5;    // max row height in minimap
    const MINI_CELL_H_MIN  = 2;    // min row height in minimap

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
    /** @type {{frames: ReturnType<typeof layoutFrames>['frames'], rowIndex: ReturnType<typeof layoutFrames>['rowIndex'], cellH: number, width: number, height: number} | null} */
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
        let cssHeight = rowCount * cellH;
        if (cssHeight > MINI_MAX_H) {
            cellH = Math.max(MINI_CELL_H_MIN, Math.floor(MINI_MAX_H / rowCount));
            layout = layoutFrames(rootNode, cssWidth, [], cellH, collapseNative);
            rowCount = layout.rowIndex.length;
            cssHeight = rowCount * cellH;
        }

        miniLayout = { frames: layout.frames, rowIndex: layout.rowIndex, cellH, width: cssWidth, height: cssHeight };

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

        // Bounding box around the zoomed subtree
        if (zoomNode && subtree) {
            let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
            for (const f of layout.frames) {
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
            const f = hitTest(miniLayout.rowIndex, e.clientX - rect.left, e.clientY - rect.top, miniLayout.cellH);
            if (f) { zoomTo(f.node); }
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
    }
    applyMinimapSide();
    applyMinimapCollapsed();
    applyNativeToggle();

    vscode.postMessage('initialized');

    // Exposed globally for the Open button's onclick attribute
    /** @type {any} */ (window).onOpen = function () { vscode.postMessage('open'); };
})();
