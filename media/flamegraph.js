// @ts-check
(function () {
    // @ts-ignore
    const vscode = acquireVsCodeApi();

    // ── Utilities (loaded from flamegraph-utils.js) ───────────────────────────
    // @ts-ignore
    const { colorFor, basename, isEmpty, footerText } = FlamegraphUtils;

    /** @param {any} node @param {string} parentKey */
    function addPathKeys(node, parentKey) {
        const myKey = parentKey ? parentKey + '/' + node.name : node.name;
        if (node.data && typeof node.data === 'object') { node.data.pathKey = myKey; }
        if (node.children) {
            for (const child of node.children) { addPathKeys(child, myKey); }
        }
    }

    // ── Constants ─────────────────────────────────────────────────────────────

    let CELL_H = 24;            // row height in CSS px — updated before each rebuild
    let FONT_SIZE = 13;         // editor font size in px — updated before each rebuild
    let FONT_FAMILY = 'system-ui, sans-serif';
    const LABEL_MIN_W = 30;     // minimum frame width (CSS px) to draw a text label
    const DPR = window.devicePixelRatio || 1;

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
     * @param {any} zoomRoot
     * @param {number} cssWidth
     * @param {any[]} ancestors  nodes above zoomRoot, root-first
     */
    function layoutFrames(zoomRoot, cssWidth, ancestors) {
        /** @type {Array<{node:any,x:number,y:number,w:number,depth:number,color:string,highlighted:boolean,ancestor:boolean}>} */
        const frames = [];
        /** @type {Array<typeof frames>} */
        const rowIndex = [];

        // Ancestors: full-width, dimmed context rows
        for (let i = 0; i < ancestors.length; i++) {
            while (rowIndex.length <= i) { rowIndex.push([]); }
            const frame = { node: ancestors[i], x: 0, y: i * CELL_H, w: cssWidth,
                depth: i, color: colorFor(ancestors[i]), highlighted: false, ancestor: true };
            frames.push(frame);
            rowIndex[i].push(frame);
        }

        // Zoom root and its descendants
        const offset = ancestors.length;
        const queue = [{ node: zoomRoot, x: 0, depth: offset, w: cssWidth }];
        while (queue.length) {
            const { node, x, depth, w } = /** @type {any} */ (queue.shift());

            while (rowIndex.length <= depth) { rowIndex.push([]); }
            const frame = { node, x, y: depth * CELL_H, w, depth, color: colorFor(node), highlighted: false, ancestor: false };
            frames.push(frame);
            rowIndex[depth].push(frame);

            if (!node.children || !node.children.length) { continue; }

            const scale = w / node.value;
            let childX = x;
            for (const child of node.children) {
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
                const funcName = f.node.name || '';
                const data = (f.node.data && typeof f.node.data === 'object') ? f.node.data : {};
                const file = data.file ? basename(data.file) : '';

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
     */
    function hitTest(rowIndex, cx, cy) {
        const depth = Math.floor(cy / CELL_H);
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
        const layout = layoutFrames(zoomRoot, cssWidth, ancestors);
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
    }

    function applySearch() {
        for (const f of frames) {
            if (!searchTerm) { f.highlighted = false; continue; }
            const data = (f.node.data && typeof f.node.data === 'object') ? f.node.data : {};
            if (searchMode === 'path') {
                f.highlighted = data.pathKey === searchTerm;
            } else {
                f.highlighted = (f.node.name || '').indexOf(searchTerm) !== -1 ||
                    !!(data.file && data.file.indexOf(searchTerm) !== -1);
            }
        }
    }

    /** @param {any} hierarchy */
    function loadData(hierarchy) {
        if (!hierarchy || isEmpty(hierarchy)) { return; }
        if (hierarchy.children) {
            for (const child of hierarchy.children) { addPathKeys(child, ''); }
        }
        rootNode = hierarchy;
        zoomNode = null;
        hoveredFrame = null;
        searchTerm = '';
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
    }

    function clearSearch() {
        searchTerm = '';
        applySearch();
        render(canvas, ctx, frames, hoveredFrame, null, 1);
    }

    /** @param {any} node @param {string} pathKey @returns {any} */
    function findByPathKey(node, pathKey) {
        if (node.data && typeof node.data === 'object' && node.data.pathKey === pathKey) {
            return node;
        }
        if (node.children) {
            for (const child of node.children) {
                const found = findByPathKey(child, pathKey);
                if (found) { return found; }
            }
        }
        return null;
    }

    /** @param {string} pathKey */
    function focusByPathKey(pathKey) {
        if (!rootNode) { return; }
        const target = findByPathKey(rootNode, pathKey);
        // Set state in one shot to avoid double animation
        zoomNode = target || null;
        hoveredFrame = null;
        searchTerm = pathKey;
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
        if (f.node.data && typeof f.node.data === 'object' && f.node.data.file) {
            vscode.postMessage(f.node.data);
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

    // ── Messages ──────────────────────────────────────────────────────────────

    window.addEventListener('message', event => {
        const msg = event.data;
        if (msg === 'reset') {
            resetZoom();
            clearSearch();
        } else if (msg.focus) {
            focusByPathKey(msg.focus);
        } else if (msg.search) {
            setSearch(msg.search, 'text');
        } else if (msg.meta !== undefined) {
            setMetadata(msg.meta);
            loadData(msg.hierarchy);
            vscode.setState(msg);
        } else if (msg.hierarchy) {
            loadData(msg.hierarchy);
            vscode.setState(msg);
        }
    });

    document.addEventListener('keydown', e => {
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
        setMetadata(state.meta);
        loadData(state.hierarchy);
    }

    vscode.postMessage('initialized');

    // Exposed globally for the Open button's onclick attribute
    /** @type {any} */ (window).onOpen = function () { vscode.postMessage('open'); };
})();
