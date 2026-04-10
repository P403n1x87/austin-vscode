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
        if (!node.file) { return hslToHex(0, 10, 70); }
        const h = hash(node.file) % 360;
        const s = hash(node.name || '') % 10;
        return hslToHex(h >= 0 ? h : -h, (node.file.endsWith('.py') ? 60 : 20) + s, 60);
    }

    /** @param {string} text */
    function esc(text) {
        if (!text) { return ''; }
        return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

    return { hslToHex, hash, hashPath, colorFor, esc, basename, isEmpty, formatValue, footerText };
}));
