(function () {
    const vscode = acquireVsCodeApi();

    // @ts-ignore -- loaded from flamegraph-utils.js
    const { esc } = FlamegraphUtils;

    let idCounter = 0;
    let expanded = new Set();
    let expandedPaths = new Set();
    let treeData = null;
    let sortCol = 'total';
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
            emptyEl.textContent = 'No asyncio tasks observed in this profile.';
            emptyEl.style.color = '';
            render();
        } else if (msg.focus) {
            if (syncToggle.checked) { focusPath(msg.focus.frameKey); }
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

        for (const task of sorted(treeData)) {
            appendNode(tbody, task, null, 0);
        }

        restoreExpanded();
    }

    function restoreExpanded() {
        if (expandedPaths.size === 0) { return; }
        document.querySelectorAll('tr[data-expandable][data-row-key]').forEach(tr => {
            if (!expandedPaths.has(tr.dataset.rowKey)) { return; }
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
        const hasChildren = node.children && node.children.length > 0;

        const tr = document.createElement('tr');
        tr.dataset.rowId = rowId;
        tr.dataset.rowKey = node.rowKey;
        tr.dataset.level = String(level);
        if (parentId !== null) {
            tr.dataset.parentId = parentId;
            tr.style.display = 'none';
        }
        if (hasChildren) { tr.dataset.expandable = '1'; }
        if (node.frameKey !== undefined) { tr.dataset.frameKey = String(node.frameKey); }

        const indent = level * 10;

        tr.innerHTML =
            `<td style="padding-left:${indent + 4}px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">` +
                `<span class="chevron">&#9654;</span>` +
                `<span class="scope-name" title="${esc(node.name)}">${esc(node.name)}</span>` +
            `</td>` +
            statCell(node.own, node.ownText) +
            statCell(node.total, node.totalText);

        tr.addEventListener('click', () => {
            if (node.module) { navigate(node.module, node.line); }
            if (hasChildren) { toggleRow(rowId); }
            if (node.frameKey !== undefined && syncToggle.checked) { vscode.postMessage({ frameKey: node.frameKey }); }
        });

        parent.appendChild(tr);

        if (node.children) {
            for (const child of sorted(node.children)) {
                appendNode(document.getElementById('tbody'), child, rowId, level + 1);
            }
        }
    }

    // Reveals rowId's direct children and marks it expanded -- shared by
    // toggleRow's expand branch and focusPath's ancestor walk, so both stay
    // in sync (e.g. both persisting the expansion in expandedPaths, so it
    // survives the next full re-render -- see restoreExpanded).
    function expandRow(rowId, row) {
        document.querySelectorAll(`tr[data-parent-id="${rowId}"]`).forEach(tr => {
            tr.style.display = '';
        });
        expanded.add(rowId);
        if (row) {
            row.dataset.open = '1';
            if (row.dataset.rowKey) { expandedPaths.add(row.dataset.rowKey); }
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
                if (row.dataset.rowKey) { expandedPaths.delete(row.dataset.rowKey); }
            }
        } else {
            expandRow(rowId, row);
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
            if (tr.dataset.rowKey) { expandedPaths.delete(tr.dataset.rowKey); }
        });
    }

    function statCell(value, text) {
        return `<td class="stat${value > 0 ? '' : ' zero'}">${esc(text)}</td>`;
    }

    function navigate(module, line) {
        vscode.postMessage({ module, line });
    }

    function focusPath(frameKey) {
        if (frameKey === undefined || frameKey === null) { return; }
        let target = null;
        for (const tr of document.querySelectorAll('tr[data-frame-key]')) {
            if (parseInt(tr.dataset.frameKey, 10) === frameKey) { target = tr; break; }
        }
        if (!target) { return; }

        // Expand all ancestors so the target row is visible
        let parentId = target.dataset.parentId;
        while (parentId) {
            const parentRow = document.querySelector(`tr[data-row-id="${parentId}"]`);
            if (!parentRow) { break; }
            if (!expanded.has(parentId)) {
                expandRow(parentId, parentRow);
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

    document.getElementById('attach-btn').addEventListener('click', () => {
        vscode.postMessage('attach');
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
