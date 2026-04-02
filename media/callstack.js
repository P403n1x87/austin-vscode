(function () {
    const vscode = acquireVsCodeApi();

    let idCounter = 0;
    let expanded = new Set();
    let expandedPaths = new Set();
    let treeData = null;
    let sortCol = 'own';
    let sortAsc = false;

    const syncToggle = document.getElementById('sync-toggle');
    const loading = document.getElementById('loading');
    const liveDot = document.getElementById('live-dot');

    window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.loading) {
            treeData = null;
            expandedPaths.clear();
            const emptyEl = document.getElementById('empty');
            emptyEl.textContent = 'No profiling data loaded.';
            emptyEl.style.color = '';
            render();
            loading.classList.add('active');
        } else if (msg.tree !== undefined) {
            loading.classList.remove('active');
            treeData = msg.tree;
            const emptyEl = document.getElementById('empty');
            emptyEl.textContent = 'No profiling data loaded.';
            emptyEl.style.color = '';
            render();
        } else if (msg.childrenFor !== undefined) {
            insertLazyChildren(msg.childrenFor, msg.children);
        } else if (msg.focus) {
            if (syncToggle.checked) { focusPath(msg.focus.pathKey); }
        } else if (msg.live !== undefined) {
            liveDot.classList.toggle('active', !!msg.live);
        } else if (msg.error) {
            loading.classList.remove('active');
            treeData = null;
            render();
            const emptyEl = document.getElementById('empty');
            emptyEl.textContent = 'Profiling failed. Check the Austin output channel for details.';
            emptyEl.style.color = 'var(--vscode-errorForeground, #f48771)';
        }
    });

    function render() {
        const empty = document.getElementById('empty');
        const table = document.getElementById('table');

        if (!treeData || treeData.length === 0) {
            empty.style.display = '';
            table.style.display = 'none';
            return;
        }

        empty.style.display = 'none';
        table.style.display = '';

        idCounter = 0;
        expanded.clear();

        const tbody = document.getElementById('tbody');
        tbody.innerHTML = '';

        for (const node of sorted(treeData)) {
            appendNode(tbody, node, null, 0);
        }

        restoreExpanded();
    }

    function restoreExpanded() {
        if (expandedPaths.size === 0) { return; }
        document.querySelectorAll('tr[data-expandable][data-path-key]').forEach(tr => {
            const pk = tr.dataset.pathKey;
            if (!pk || !expandedPaths.has(pk)) { return; }
            const rowId = tr.dataset.rowId;
            document.querySelectorAll(`tr[data-parent-id="${rowId}"]`).forEach(child => {
                child.style.display = '';
            });
            expanded.add(rowId);
            tr.dataset.open = '1';
        });
    }

    function sorted(nodes) {
        return [...nodes].sort((a, b) => sortAsc ? a[sortCol] - b[sortCol] : b[sortCol] - a[sortCol]);
    }

    function appendNode(parent, node, parentId, level) {
        const rowId = String(idCounter++);
        const hasChildren = (node.children && node.children.length > 0) || node.childrenPending;

        const tr = document.createElement('tr');
        tr.dataset.rowId = rowId;
        tr.dataset.level = String(level);
        if (parentId !== null) {
            tr.dataset.parentId = parentId;
            tr.style.display = 'none';
        }
        if (hasChildren) { tr.dataset.expandable = '1'; }
        tr.dataset.pathKey = node.pathKey || '';
        if (node.childrenPending) { tr.dataset.childrenPending = '1'; }

        const indent = level * 10;
        const ownText   = node.own   > 0 ? fmt(node.own)   + '%' : '';
        const totalText = node.total > 0 ? fmt(node.total) + '%' : '';
        const mod = node.module ? basename(node.module) : '';

        tr.innerHTML =
            `<td style="padding-left:${indent + 4}px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">` +
                `<span class="chevron">&#9654;</span>` +
                `<span class="scope-name" title="${esc(node.scope)}">${esc(node.scope)}</span>` +
                (mod ? `<span class="scope-module" title="${esc(node.module)}">${esc(mod)}</span>` : '') +
            `</td>` +
            statCell(node.own, ownText) +
            statCell(node.total, totalText);

        tr.addEventListener('click', () => {
            if (node.module) { navigate(node.module, node.line); }
            if (hasChildren) { toggleRow(rowId); }
            if (node.pathKey && syncToggle.checked) { vscode.postMessage({ pathKey: node.pathKey }); }
        });

        if (typeof parent.appendChild === 'function') {
            parent.appendChild(tr);
        } else {
            // parent is a reference row — insert after it
            parent.parentNode.insertBefore(tr, parent.nextSibling);
            parent = tr; // subsequent siblings insert after this
        }

        if (!node.childrenPending && node.children) {
            for (const child of sorted(node.children)) {
                appendNode(document.getElementById('tbody'), child, rowId, level + 1);
            }
        }
    }

    function toggleRow(rowId) {
        const isExpanded = expanded.has(rowId);
        const row = document.querySelector(`tr[data-row-id="${rowId}"]`);

        if (isExpanded) {
            collapseDescendants(rowId);
            expanded.delete(rowId);
            if (row) {
                delete row.dataset.open;
                if (row.dataset.pathKey) { expandedPaths.delete(row.dataset.pathKey); }
            }
        } else {
            if (row && row.dataset.childrenPending) {
                // Children not yet loaded — request from extension
                vscode.postMessage({ requestChildren: row.dataset.pathKey });
                return;
            }
            document.querySelectorAll(`tr[data-parent-id="${rowId}"]`).forEach(tr => {
                tr.style.display = '';
            });
            expanded.add(rowId);
            if (row) {
                row.dataset.open = '1';
                if (row.dataset.pathKey) { expandedPaths.add(row.dataset.pathKey); }
            }
        }
    }

    function collapseDescendants(rowId) {
        document.querySelectorAll(`tr[data-parent-id="${rowId}"]`).forEach(tr => {
            tr.style.display = 'none';
            const childId = tr.dataset.rowId;
            if (expanded.has(childId)) {
                collapseDescendants(childId);
                expanded.delete(childId);
                delete tr.dataset.open;
            }
            if (tr.dataset.pathKey) { expandedPaths.delete(tr.dataset.pathKey); }
        });
    }

    function insertLazyChildren(parentPathKey, children) {
        const parentRow = document.querySelector(`tr[data-path-key="${CSS.escape(parentPathKey)}"]`);
        if (!parentRow) { return; }
        const parentId = parentRow.dataset.rowId;
        const parentLevel = parseInt(parentRow.dataset.level || '0', 10);

        // Clear the pending flag
        delete parentRow.dataset.childrenPending;

        // Find the first row that is NOT a descendant (level <= parentLevel)
        let insertBefore = parentRow.nextElementSibling;
        while (insertBefore) {
            if (parseInt(insertBefore.dataset.level || '0', 10) <= parentLevel) { break; }
            insertBefore = insertBefore.nextElementSibling;
        }

        const tbody = document.getElementById('tbody');

        // Insert children rows before insertBefore (or at end if null)
        for (const child of sorted(children)) {
            insertNodeBefore(tbody, insertBefore, child, parentId, parentLevel + 1);
        }

        // Now expand
        document.querySelectorAll(`tr[data-parent-id="${parentId}"]`).forEach(tr => {
            tr.style.display = '';
        });
        expanded.add(parentId);
        parentRow.dataset.open = '1';
        expandedPaths.add(parentPathKey);
    }

    function insertNodeBefore(tbody, refNode, node, parentId, level) {
        const rowId = String(idCounter++);
        const hasChildren = (node.children && node.children.length > 0) || node.childrenPending;

        const tr = document.createElement('tr');
        tr.dataset.rowId = rowId;
        tr.dataset.level = String(level);
        tr.dataset.parentId = parentId;
        tr.style.display = 'none';
        if (hasChildren) { tr.dataset.expandable = '1'; }
        tr.dataset.pathKey = node.pathKey || '';
        if (node.childrenPending) { tr.dataset.childrenPending = '1'; }

        const indent = level * 10;
        const ownText   = node.own   > 0 ? fmt(node.own)   + '%' : '';
        const totalText = node.total > 0 ? fmt(node.total) + '%' : '';
        const mod = node.module ? basename(node.module) : '';

        tr.innerHTML =
            `<td style="padding-left:${indent + 4}px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">` +
                `<span class="chevron">&#9654;</span>` +
                `<span class="scope-name" title="${esc(node.scope)}">${esc(node.scope)}</span>` +
                (mod ? `<span class="scope-module" title="${esc(node.module)}">${esc(mod)}</span>` : '') +
            `</td>` +
            statCell(node.own, ownText) +
            statCell(node.total, totalText);

        tr.addEventListener('click', () => {
            if (node.module) { navigate(node.module, node.line); }
            if (hasChildren) { toggleRow(rowId); }
            if (node.pathKey && syncToggle.checked) { vscode.postMessage({ pathKey: node.pathKey }); }
        });

        tbody.insertBefore(tr, refNode || null);

        if (!node.childrenPending && node.children) {
            for (const child of sorted(node.children)) {
                // Children of lazy-inserted nodes also go before refNode
                insertNodeBefore(tbody, refNode, child, rowId, level + 1);
            }
        }
    }

    function statCell(value, text) {
        const c = statColor(value);
        return `<td class="stat${value > 0 ? '' : ' zero'}"${c ? ` style="color:${c}"` : ''}>${esc(text)}</td>`;
    }

    function statColor(value) {
        const pct = value * 100;
        if (pct >= 75) { return '#e74c3c'; }
        if (pct >= 50) { return '#e67e22'; }
        if (pct >= 25) { return '#f1c40f'; }
        return null;
    }

    function fmt(v) { return (v * 100).toFixed(2); }

    function esc(str) {
        if (!str) { return ''; }
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function basename(path) {
        return path.replace(/\\/g, '/').split('/').pop() || path;
    }

    function navigate(module, line) {
        vscode.postMessage({ module, line });
    }

    function focusPath(pathKey) {
        if (!pathKey) { return; }
        let target = null;
        for (const tr of document.querySelectorAll('tr[data-path-key]')) {
            if (tr.dataset.pathKey === pathKey) { target = tr; break; }
        }
        if (!target) { return; }

        // Expand all ancestors so the target row is visible
        let parentId = target.dataset.parentId;
        while (parentId) {
            const parentRow = document.querySelector(`tr[data-row-id="${parentId}"]`);
            if (!parentRow) { break; }
            if (!expanded.has(parentId)) {
                document.querySelectorAll(`tr[data-parent-id="${parentId}"]`).forEach(tr => {
                    tr.style.display = '';
                });
                expanded.add(parentId);
                parentRow.dataset.open = '1';
            }
            parentId = parentRow.dataset.parentId;
        }
        target.style.display = '';

        target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        target.classList.remove('focused');
        void target.offsetWidth;
        target.classList.add('focused');
    }

    document.getElementById('collapse-all').addEventListener('click', () => {
        if (treeData) { expandedPaths.clear(); render(); }
    });

    document.getElementById('open-btn').addEventListener('click', () => {
        vscode.postMessage('open');
    });

    document.querySelectorAll('th[data-col]').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.col;
            sortAsc = sortCol === col ? !sortAsc : false;
            sortCol = col;
            document.querySelectorAll('th[data-col]').forEach(t => t.classList.remove('asc', 'desc'));
            th.classList.add(sortAsc ? 'asc' : 'desc');
            render();
        });
    });

    const toolbar = document.querySelector('.toolbar');
    const updateToolbarHeight = () => {
        document.documentElement.style.setProperty('--toolbar-h', toolbar.offsetHeight + 'px');
    };
    updateToolbarHeight();
    new ResizeObserver(updateToolbarHeight).observe(toolbar);

    vscode.postMessage('initialized');
})();
