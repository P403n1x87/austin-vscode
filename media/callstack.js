(function () {
    const vscode = acquireVsCodeApi();

    let idCounter = 0;
    let expanded = new Set();
    let treeData = null;
    let sortCol = 'own';
    let sortAsc = false;

    const syncToggle = document.getElementById('sync-toggle');

    window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.tree !== undefined) {
            treeData = msg.tree;
            render();
        } else if (msg.focus) {
            if (syncToggle.checked) { focusPath(msg.focus.pathKey); }
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
    }

    function sorted(nodes) {
        return [...nodes].sort((a, b) => sortAsc ? a[sortCol] - b[sortCol] : b[sortCol] - a[sortCol]);
    }

    function appendNode(tbody, node, parentId, level) {
        const rowId = String(idCounter++);
        const hasChildren = node.children && node.children.length > 0;

        const tr = document.createElement('tr');
        tr.dataset.rowId = rowId;
        if (parentId !== null) {
            tr.dataset.parentId = parentId;
            tr.style.display = 'none';
        }
        if (hasChildren) { tr.dataset.expandable = '1'; }
        tr.dataset.pathKey = node.pathKey || '';

        const indent = level * 10;
        const ownText   = node.own   > 0 ? fmt(node.own)   + '%' : '';
        const totalText = node.total > 0 ? fmt(node.total) + '%' : '';
        const mod = node.module ? basename(node.module) : '';

        tr.innerHTML =
            `<td><div class="scope-cell" style="padding-left:${indent}px">` +
                `<span class="chevron">&#9654;</span>` +
                `<span class="scope-name" title="${esc(node.scope)}">${esc(node.scope)}</span>` +
                (mod ? `<span class="scope-module" title="${esc(node.module)}">${esc(mod)}</span>` : '') +
            `</div></td>` +
            statCell(node.own, ownText) +
            statCell(node.total, totalText);

        tr.addEventListener('click', () => {
            if (node.module) { navigate(node.module, node.line); }
            if (hasChildren) { toggleRow(rowId); }
            if (node.pathKey && syncToggle.checked) { vscode.postMessage({ pathKey: node.pathKey }); }
        });

        tbody.appendChild(tr);

        for (const child of sorted(node.children)) {
            appendNode(tbody, child, rowId, level + 1);
        }
    }

    function toggleRow(rowId) {
        const isExpanded = expanded.has(rowId);
        const row = document.querySelector(`tr[data-row-id="${rowId}"]`);

        if (isExpanded) {
            collapseDescendants(rowId);
            expanded.delete(rowId);
            if (row) { delete row.dataset.open; }
        } else {
            document.querySelectorAll(`tr[data-parent-id="${rowId}"]`).forEach(tr => {
                tr.style.display = '';
            });
            expanded.add(rowId);
            if (row) { row.dataset.open = '1'; }
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
        });
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

    vscode.postMessage('initialized');
})();
