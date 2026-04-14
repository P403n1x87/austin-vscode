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
    // Remove viewBox (used only for static/no-JS rendering) so the JS layout
    // works in CSS-pixel coordinates matching the full container width.
    svg.removeAttribute('viewBox');
    render();
})();
