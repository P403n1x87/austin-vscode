// @ts-check
// Pure utility functions shared by flamegraph.js and the test suite.
// UMD wrapper: works as a browser <script> (exposes window.FlamegraphUtils)
// and as a Node.js require() (module.exports).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        // @ts-ignore
        root.FlamegraphUtils = factory();
    }
// @ts-ignore
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

    /** @param {number} h @param {number} s @param {number} l */
    function hslToHex(h, s, l) {
        l /= 100;
        const a = s * Math.min(l, 1 - l) / 100;
        /** @param {number} n */
        const f = n => {
            const k = (n + h / 30) % 12;
            const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
            return Math.round(255 * color).toString(16).padStart(2, '0');
        };
        return `#${f(0)}${f(8)}${f(4)}`;
    }

    /** @param {string} text */
    function hash(text) {
        let h = 0;
        for (let i = 0; i < text.length; i++) {
            h = text.charCodeAt(i) + ((h << 5) - h);
        }
        return h;
    }

    /**
     * djb2-variant hash returning a 32-bit unsigned integer.
     * Accepts an optional seed so callers can chain calls for path segments
     * (rolling hash) without building intermediate path strings.
     * Same algorithm used in src/utils/pathKey.ts for cross-boundary consistency.
     * @param {string} text
     * @param {number} [seed]
     * @returns {number}
     */
    function hashPath(text, seed) {
        let h = seed | 0;
        for (let i = 0; i < text.length; i++) {
            h = (((h << 5) + h) + text.charCodeAt(i)) | 0;
        }
        return h >>> 0;
    }

    /** @param {any} node */
    function colorFor(node) {
        if (node.kind === 'process') { return hslToHex(120, hash(node.name) % 20, 70); }
        if (node.kind === 'thread')  { return hslToHex(240, hash(node.name) % 20, 70); }
        // Saturation kept well above process/thread's near-gray range, and
        // hue/lightness pulled toward copper rather than hue 30's paler
        // yellow-tan at high lightness, so the task accent reads as a warm
        // amber/orange (the color a task's picture-in-picture panel is
        // built around), not a flat gray box or a washed-out yellow.
        if (node.kind === 'taskRoot' || node.kind === 'task') { return hslToHex(22, 45 + hash(node.name) % 20, 52); }
        if (!node.file) { return hslToHex(0, 10, 70); }
        const h = hash(node.file) % 360;
        const s = hash(node.name || '') % 10;
        const isPy = node.file.endsWith('.py') || (node.file.startsWith('<') && node.file.endsWith('>'));
        return hslToHex(h >= 0 ? h : -h, (isPy ? 60 : 5) + s, isPy ? 60 : 45);
    }

    /**
     * Escapes text for safe use as either HTML text-node content or inside a
     * double-quoted attribute value (e.g. a `title="..."` tooltip) -- a
     * user-controlled string (a task's name, a scope/file path) can contain
     * a literal `"` , which would otherwise break out of an attribute.
     * Escaping quotes is a no-op for the (more common) text-node case: a
     * browser renders `&quot;` and a raw `"` identically there.
     * @param {string} text
     */
    function esc(text) {
        if (!text) { return ''; }
        return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /** @param {string} path */
    function basename(path) {
        return path ? path.replace(/\\/g, '/').split('/').pop() || path : '';
    }

    /** @param {any} obj */
    function isEmpty(obj) {
        return obj && Object.keys(obj).length === 0 && obj.constructor === Object;
    }

    /**
     * Format a raw metric value into a human-readable string.
     * For time modes: μs → ms → s → m.  For memory: B → KB → MB → GB.
     * @param {number} v @param {string} mode
     */
    function formatValue(v, mode) {
        if (mode === 'memory') {
            if (v < 1024)        { return v.toFixed(0) + ' B'; }
            if (v < 1024 * 1024) { return (v / 1024).toFixed(2) + ' KB'; }
            if (v < 1024 ** 3)   { return (v / 1024 ** 2).toFixed(2) + ' MB'; }
            return (v / 1024 ** 3).toFixed(2) + ' GB';
        }
        // cpu / wall — value is in microseconds
        if (v < 1000) { return v.toFixed(0) + ' \u03BCs'; }
        if (v < 1e6)  { return (v / 1000).toFixed(2) + ' ms'; }
        if (v < 1e9)  { return (v / 1e6).toFixed(2) + ' s'; }
        return (v / 1e9).toFixed(2) + ' m';
    }

    /**
     * Build the footer HTML string for a hovered frame.
     * @param {any} node @param {number} rootValue @param {string} mode
     */
    function footerText(node, rootValue, mode) {
        const icon   = mode === 'memory' ? '\u{1F4E6}' : '\u23F1';
        const pct    = (node.value / rootValue * 100).toFixed(2) + '%';
        const metric = icon + '\uFE0E ' + formatValue(node.value, mode) + ' (' + pct + ')';
        const scope  = esc(node.name || '');
        const file   = node.file ? ' <span style="opacity:0.45">' + esc(node.file) + '</span>' : '';
        return metric + ' &nbsp;\u00B7&nbsp; ' + scope + file;
    }

    // \u2500\u2500 Main-tree layout \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    //
    // Shared by the interactive webview (media/flamegraph.js), the exported
    // static SVG's initial (no-JS) render (src/flamegraph-svg.ts), and that
    // SVG's own embedded interactive script (media/flamegraph-embedded.js) --
    // one canonical layout algorithm instead of three hand-copied ones.

    const NATIVE_COLLAPSED_COLOR = '#6f6f6f';  // flat gray for collapsed native frames

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

    /**
     * Partition the hierarchy into a flat array of frame descriptors.
     * Ancestors of the zoom root are rendered at full width above it (dimmed).
     * When `collapseNative` is true, each native frame is drawn as a single
     * cell and its visible children are replaced with the first non-native
     * descendants -- preserving width (and thus metrics) while flattening
     * native call chains. Consecutive native ancestors are also folded.
     * Task-kind children render as independent floating towers (see the
     * task-forest functions below), never as width-sharing children --
     * collected here as `anchors` instead of queued into the recursion.
     * @param {any} zoomRoot
     * @param {number} cssWidth
     * @param {any[]} ancestors  nodes above zoomRoot, root-first
     * @param {number} rowH
     * @param {boolean} [collapseNative]
     */
    function layoutFrames(zoomRoot, cssWidth, ancestors, rowH, collapseNative) {
        /** @type {Array<{node:any,x:number,y:number,w:number,depth:number,color:string,highlighted:boolean,ancestor:boolean,collapsedNative:boolean}>} */
        const frames = [];
        /** @type {Array<typeof frames>} */
        const rowIndex = [];
        /** @type {Array<{taskNode:any,anchorX:number,anchorY:number,anchorW:number,anchorDepth:number}>} */
        const anchors = [];

        /** @param {any} n */
        const displayChildren = (n) => {
            const kids = (collapseNative && isNative(n)) ? firstNonNativeDescendants(n) : (n.children || []);
            return kids.filter((/** @type {any} */ c) => c.kind !== 'task');
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

            for (const t of (node.children || [])) {
                if (t.kind === 'task') {
                    anchors.push({ taskNode: t, anchorX: x, anchorY: depth * rowH, anchorW: w, anchorDepth: depth });
                }
            }

            const children = displayChildren(node);
            if (!children.length) { continue; }

            // Proportional-width layout for an arbitrary weighted tree has
            // to hold up even when children's combined weight exceeds their
            // parent's own -- not every node's value is a bottom-up sum of
            // its children (e.g. a task node's value is how long that task
            // shape was itself observed, which can legitimately be smaller
            // than the cumulative work of everything it delegated to and
            // waited on). Sizing off the larger of the two keeps children
            // within their parent's box in that case, and is a no-op
            // otherwise (the two are equal, or the parent is already
            // larger).
            const scale = w / Math.max(node.value, children.reduce((sum, /** @type {any} */ c) => sum + c.value, 0));
            let childX = x;
            for (const child of children) {
                const childW = child.value * scale;
                if (childW >= 1) {
                    queue.push({ node: child, x: childX, depth: depth + 1, w: childW });
                }
                childX += childW;
            }
        }

        return { frames, rowIndex, anchors };
    }

    // ── Floating task sub-flamegraphs ────────────────────────────────────────
    //
    // Task-kind nodes (see AustinStats.finalizeTaskNodes in src/model.ts) are
    // NOT laid out as width-sharing children of their anchor frame the way
    // regular frames are -- each one renders as its own independent, full-
    // scale "tower" (a self-contained mini flamegraph), stacked vertically
    // below/beside wherever it attaches, connected back by a spine. This
    // keeps every box everywhere (main flamegraph and every floating tower,
    // at any nesting depth) on one shared time scale: value * globalScale.

    const LANE_GAP = 12;         // vertical gap between sibling towers / a tower and its nested children
    const TASK_LANE_INDENT = 8;  // horizontal indent per nesting level -- kept small (and paired with a
                                  // gentle NESTED_TASK_SCALE below) since a wide tower (comparable
                                  // duration to its parent) already extends far to the right on the
                                  // shared time scale; a big indent on top of that risks running into
                                  // unrelated content further right.
    // Extra width shrink applied at every nesting level (compounding: a root
    // task renders at 98% of its raw value*globalScale width, a task nested
    // one level inside it at 98% of that, i.e. 96.04%, and so on). Combined
    // with TASK_LANE_INDENT's horizontal offset, an unshrunk tower could
    // overshoot its container or collide with unrelated content to its
    // right -- shrinking a little at every level keeps that from compounding
    // into a real overflow risk as nesting gets deep. Kept gentle precisely
    // because TASK_LANE_INDENT above is already small -- between the two,
    // there's no need for a dramatic per-level shrink. Only applies to the
    // floating tower layout; a zoomed-in task frame (layoutFrames' zoomRoot)
    // always fills the full available width, unscaled.
    const NESTED_TASK_SCALE = 0.98;

    /**
     * Groups layoutFrames' collected task anchors by exact attachment point
     * (task-kind siblings collected from the same parent frame share one
     * floating region) -- shared by the main canvas render and the minimap,
     * which each lay out and place one region per group afterwards.
     * @param {Array<{taskNode:any,anchorX:number,anchorY:number,anchorW:number,anchorDepth:number}>} anchors
     * @returns {Map<string, typeof anchors>}
     */
    function groupAnchorsByPosition(anchors) {
        const groups = new Map();
        for (const a of anchors) {
            const key = `${a.anchorX}:${a.anchorY}`;
            if (!groups.has(key)) { groups.set(key, []); }
            groups.get(key).push(a);
        }
        return groups;
    }

    /**
     * Lays out one task's own internal call chain as an independent
     * flamegraph (its own x/depth start at 0), using the same proportional-
     * width recursion the main flamegraph uses, but against a shared global
     * scale instead of re-deriving one locally. Any task-kind children found
     * within it are pulled out as anchors and laid out (recursively) as this
     * tower's own nested forest, rather than being queued into this walk.
     *
     * The task node itself is now just an ordinary row at depth 0 (frames[0],
     * spanning the tower's full width) -- since a task's display name is no
     * longer part of the merged main flamegraph (see AustinStats.
     * finalizeTaskNodes), its label there is just its own function/scope
     * name, same as any other frame, so there's nothing left for a separate
     * caption to say that this row doesn't already show.
     * @param {any} taskNode
     * @param {number} globalScale  px per unit of value (time/memory)
     * @param {number} rowH
     * @param {number} [nestScale]  cumulative NESTED_TASK_SCALE factor from
     *   enclosing towers (1 for a forest not itself nested inside a task);
     *   this tower's own factor (nestScale * NESTED_TASK_SCALE) is what
     *   actually scales its width, and is what gets threaded further down
     *   into its own childForest.
     * @param {boolean} [collapseNative]  same meaning as layoutFrames' own
     *   flag: each native frame collapses to a single (flagged) row and its
     *   displayed children skip ahead to the first non-native descendants,
     *   folding native call chains the same way inside a task's own tower
     *   as in the main flamegraph.
     * @returns {{frames: Array<{node:any,x:number,y:number,w:number,depth:number,collapsedNative:boolean}>, width: number, ownHeight: number, subtreeHeight: number, childForest: ReturnType<typeof layoutTaskForest>, taskNode: any}}
     */
    function layoutTaskTower(taskNode, globalScale, rowH, nestScale, collapseNative) {
        const scale = (nestScale === undefined ? 1 : nestScale) * NESTED_TASK_SCALE;
        const width = taskNode.value * globalScale * scale;
        /** @type {Array<{node:any,x:number,y:number,w:number,depth:number,collapsedNative:boolean}>} */
        const frames = [{ node: taskNode, x: 0, y: 0, w: width, depth: 0, collapsedNative: !!(collapseNative && isNative(taskNode)) }];
        /** @type {Array<{taskNode:any,anchorX:number,anchorY:number,anchorW:number,anchorDepth:number}>} */
        const anchors = [];
        let maxDepth = 0; // row 0 is the task node's own frame

        /** @param {any} n @param {number} x @param {number} y @param {number} w @param {number} depth */
        const collectTaskAnchors = (n, x, y, w, depth) => {
            for (const t of (n.children || [])) {
                if (t.kind === 'task') { anchors.push({ taskNode: t, anchorX: x, anchorY: y, anchorW: w, anchorDepth: depth }); }
            }
        };

        /** @param {any} n */
        const displayChildren = (n) => {
            const kids = (collapseNative && isNative(n)) ? firstNonNativeDescendants(n) : (n.children || []);
            return kids.filter((/** @type {any} */ c) => c.kind !== 'task');
        };

        // A task attaching directly to this task with no frame in between is
        // a degenerate edge case (see task_leaves fallback in model.ts), but
        // handled the same way as any other anchor found while walking this
        // tower's own frames: as if the task node's own row (depth 0) were
        // the anchor.
        collectTaskAnchors(taskNode, 0, 0, width, 0);

        // Every box in every tower renders at value * globalScale * scale --
        // one shared absolute rate, so sizes stay comparable across towers
        // (see the module doc comment above). That holds for the
        // overwhelming majority of nodes, whose children's combined weight
        // is at most their own; a node's own children only need a LOCALLY
        // reduced rate on the rare occasion that isn't true (see the
        // matching comment on layoutFrames' own scale computation -- the
        // same "arbitrary weighted tree" caveat applies here), so they stay
        // within `availableW` -- the node's OWN actual rendered width,
        // which may already be narrower than value * globalScale * scale if
        // an ANCESTOR needed the same reduction, not the node's raw value.
        /** @param {number} availableW @param {any[]} kids */
        const childRate = (availableW, kids) => {
            const rate = globalScale * scale;
            const naiveTotal = kids.reduce((sum, /** @type {any} */ c) => sum + c.value * rate, 0);
            return naiveTotal > availableW ? rate * (availableW / naiveTotal) : rate;
        };

        /** @type {Array<{node:any,x:number,depth:number,w:number}>} */
        const queue = [];
        let seedX = 0;
        const seedChildren = displayChildren(taskNode);
        const seedRate = childRate(width, seedChildren);
        for (const child of seedChildren) {
            const childW = child.value * seedRate;
            if (childW >= 1) { queue.push({ node: child, x: seedX, depth: 1, w: childW }); }
            seedX += childW;
        }

        while (queue.length) {
            const { node, x, depth, w } = /** @type {any} */ (queue.shift());
            frames.push({ node, x, y: depth * rowH, w, depth, collapsedNative: !!(collapseNative && isNative(node)) });
            maxDepth = Math.max(maxDepth, depth);

            collectTaskAnchors(node, x, depth * rowH, w, depth);

            const children = displayChildren(node);
            if (!children.length) { continue; }
            const rate = childRate(w, children);
            let childX = x;
            for (const child of children) {
                const childW = child.value * rate;
                if (childW >= 1) { queue.push({ node: child, x: childX, depth: depth + 1, w: childW }); }
                childX += childW;
            }
        }

        const ownHeight = (maxDepth + 1) * rowH;
        // Nested children start right after this tower's own rows -- not at
        // 0, which would coincide with this tower's own top and overlap it
        // (offsetY is relative to this tower's own absolute origin).
        const childForest = layoutTaskForest(anchors, globalScale, rowH, ownHeight + LANE_GAP, scale, collapseNative);
        const subtreeHeight = ownHeight + (childForest.towers.length ? LANE_GAP + childForest.totalHeight : 0);

        return { frames, width, ownHeight, subtreeHeight, childForest, taskNode };
    }

    /**
     * Stacks a list of sibling task anchors (attached to the same parent
     * frame) vertically -- each tower's own subtreeHeight (which already
     * accounts for whatever is nested inside it) determines how far down the
     * next sibling starts, so a sibling is never overlapped by a deeper
     * nesting inside an earlier one.
     * @param {Array<{taskNode:any,anchorX:number,anchorY:number,anchorW:number,anchorDepth:number}>} anchors
     * @param {number} globalScale
     * @param {number} rowH
     * @param {number} [startY]  initial Y cursor -- 0 for a standalone forest
     *   (e.g. top-level anchors, placed by the caller via flattenTaskForest's
     *   towerOrigin), or ownHeight+LANE_GAP when this is a tower's own nested
     *   forest (so it starts below that tower's own rows, not on top of them)
     * @param {number} [nestScale]  cumulative NESTED_TASK_SCALE factor to pass
     *   down to every tower in this forest -- see layoutTaskTower. Defaults to
     *   1 (a top-level forest of root tasks, each still gets its own single
     *   NESTED_TASK_SCALE applied inside layoutTaskTower).
     * @param {boolean} [collapseNative]  passed straight through to every
     *   tower -- see layoutTaskTower.
     * @returns {{towers: Array<{anchor:any, tower:ReturnType<typeof layoutTaskTower>, offsetX:number, offsetY:number}>, totalHeight: number}}
     */
    function layoutTaskForest(anchors, globalScale, rowH, startY, nestScale, collapseNative) {
        const towers = [];
        let yCursor = startY || 0;
        for (const anchor of anchors) {
            const tower = layoutTaskTower(anchor.taskNode, globalScale, rowH, nestScale, collapseNative);
            towers.push({ anchor, tower, offsetX: TASK_LANE_INDENT, offsetY: yCursor });
            yCursor += tower.subtreeHeight + LANE_GAP;
        }
        const totalHeight = towers.length ? yCursor - (startY || 0) - LANE_GAP : 0;
        return { towers, totalHeight };
    }

    /**
     * Walks a (relatively-positioned) forest and produces absolute frames
     * and spine segments connecting each tower back to the point that
     * awaits it.
     * Takes two separate origins because a top-level forest's anchors are
     * already absolute canvas coordinates (collected during the main
     * flamegraph's own layout) while its towers are placed wherever the
     * caller chooses (e.g. just below the anchor's row, not necessarily
     * aligned with anchorOrigin) -- for a NESTED forest (an anchor found
     * inside another tower), both collapse to that tower's own absolute
     * origin, since everything in it (anchors and tower offsets alike) was
     * computed relative to that.
     * @param {ReturnType<typeof layoutTaskForest>} forest
     * @param {number} anchorOriginX  base for interpreting anchor.anchorX/Y
     * @param {number} anchorOriginY
     * @param {number} towerOriginX  base for interpreting each tower's offsetX/Y
     * @param {number} towerOriginY
     * @param {number} rowH
     * @returns {{frames: Array<{node:any,x:number,y:number,w:number,depth:number,collapsedNative:boolean}>, spines: Array<{fromX:number,fromY:number,toX:number,toY:number}>}}
     */
    function flattenTaskForest(forest, anchorOriginX, anchorOriginY, towerOriginX, towerOriginY, rowH) {
        /** @type {Array<{node:any,x:number,y:number,w:number,depth:number,collapsedNative:boolean}>} */
        const frames = [];
        /** @type {Array<{fromX:number,fromY:number,toX:number,toY:number}>} */
        const spines = [];

        for (const { anchor, tower, offsetX, offsetY } of forest.towers) {
            const thisTowerX = towerOriginX + offsetX;
            const thisTowerY = towerOriginY + offsetY;

            for (const f of tower.frames) {
                frames.push({ node: f.node, x: thisTowerX + f.x, y: thisTowerY + f.y, w: f.w, depth: f.depth, collapsedNative: f.collapsedNative });
            }

            spines.push({
                fromX: anchorOriginX + anchor.anchorX,
                fromY: anchorOriginY + anchor.anchorY + rowH,
                toX: thisTowerX,
                toY: thisTowerY + rowH / 2,
            });

            // Nested: anchors recorded inside this tower's own BFS, and the
            // nested forest's own offsetY (layoutTaskForest's startY =
            // ownHeight + LANE_GAP, see layoutTaskTower), are both relative
            // to this tower's own absolute origin -- thisTowerY, now that
            // there's no caption offset to add on top of it.
            const nested = flattenTaskForest(tower.childForest, thisTowerX, thisTowerY, thisTowerX, thisTowerY, rowH);
            frames.push(...nested.frames);
            spines.push(...nested.spines);
        }

        return { frames, spines };
    }

    // Minimum horizontal overlap (CSS px) for a main-tree frame to count as
    // an actual clash. Two unrelated sibling branches under the same parent
    // (e.g. a deep, narrow import-machinery chain sitting right next to a
    // wide asyncio call chain) can end up with adjoining edges that differ
    // by a fraction of a pixel of floating-point rounding -- with a strict
    // `> 0` check, that hairline, meaningless touch is enough to make an
    // otherwise-unrelated, arbitrarily deep branch count as "overlapping",
    // pushing a floating task tower down by that branch's *entire* height
    // for no visible reason. Matches the `childW >= 1` "is this even a
    // renderable box" threshold used elsewhere in this file.
    const FLOOR_OVERLAP_EPSILON = 1;

    /**
     * The Y just below the tallest existing frame that horizontally overlaps
     * [x0, x1) by at least FLOOR_OVERLAP_EPSILON -- lets floating content
     * start right after whatever it would actually clash with, instead of
     * needing to clear the whole tree's deepest stack even when that stack
     * doesn't overlap it at all (or only grazes it by a rounding error).
     *
     * Takes `rowIndex` (layoutFrames' own per-depth grouping) rather than a
     * flat frame list: each row is emitted by layoutFrames' breadth-first
     * walk in strictly x-ascending order (every depth-d node is dequeued,
     * and its children enqueued, before any depth-(d+1) node), so a frame
     * whose right edge is at or before x0 -- and everything before it in
     * that same row -- can never overlap [x0, x1) and is skipped via binary
     * search instead of a full linear scan. Called once per floating task
     * anchor group in a render pass with potentially many rows and
     * thousands of frames, so this turns an O(anchors * frames) scan into
     * O(anchors * (rows * log(frames per row))).
     * @param {Array<Array<{x:number,y:number,w:number}>>} rowIndex
     * @param {number} x0 @param {number} x1 @param {number} rowH @param {number} minY
     */
    function computeFloorY(rowIndex, x0, x1, rowH, minY) {
        let floor = minY;
        for (const row of rowIndex) {
            if (!row.length) { continue; }
            // First index whose right edge could possibly reach x0 -- no
            // epsilon here (unlike the overlap check below): anything
            // before this index has x + w <= x0, so its overlap is <= 0
            // regardless of epsilon, and is safe to skip outright.
            let lo = 0, hi = row.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (row[mid].x + row[mid].w <= x0) { lo = mid + 1; } else { hi = mid; }
            }
            for (let i = lo; i < row.length && row[i].x < x1; i++) {
                const f = row[i];
                const overlap = Math.min(f.x + f.w, x1) - Math.max(f.x, x0);
                if (overlap >= FLOOR_OVERLAP_EPSILON) {
                    floor = Math.max(floor, f.y + rowH);
                }
            }
        }
        return floor;
    }

    return {
        hslToHex, hash, hashPath, colorFor, esc, basename, isEmpty, formatValue, footerText,
        NATIVE_COLLAPSED_COLOR, isNative, firstNonNativeDescendants, layoutFrames,
        LANE_GAP, TASK_LANE_INDENT, NESTED_TASK_SCALE, groupAnchorsByPosition, layoutTaskTower, layoutTaskForest, flattenTaskForest, computeFloorY,
    };
}));
