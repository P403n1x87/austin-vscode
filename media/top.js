(function () {
    const vscode = acquireVsCodeApi();

    let data = [];
    let sortCol = 'own';
    let sortAsc = false;
    let filterTerm = '';
    let expanded = new Set();
    let expandedKeys = new Set();
    let idCounter = 0;

    const loading     = document.getElementById('loading');
    const filterInput = document.getElementById('filter-input');
    const filterClear = document.getElementById('filter-clear');

    const liveDot = document.getElementById('live-dot');

    window.addEventListener('message', event => {
        const message = event.data;
        if (message.loading) {
            data = [];
            filterTerm = '';
            filterInput.value = '';
            filterClear.classList.remove('visible');
            expandedKeys.clear();
            render();
            loading.classList.add('active');
        } else if (message.top !== undefined) {
            loading.classList.remove('active');
            data = message.top;
            render();
        } else if (message.callersFor !== undefined) {
            insertLazyCallers(message.callersFor, message.callers);
        } else if (message.live !== undefined) {
            liveDot.classList.toggle('active', !!message.live);
        }
    });

    function render() {
        const empty = document.getElementById('empty');
        const table = document.getElementById('table');

        if (data.length === 0) {
            empty.style.display = '';
            table.style.display = 'none';
            return;
        }

        empty.style.display = 'none';
        table.style.display = '';

        const sorted = [...data].sort((a, b) => {
            const av = a[sortCol];
            const bv = b[sortCol];
            if (typeof av === 'number') { return sortAsc ? av - bv : bv - av; }
            return sortAsc
                ? String(av).localeCompare(String(bv))
                : String(bv).localeCompare(String(av));
        });

        const term = filterTerm.toLowerCase();
        const filtered = term ? sorted.filter(item =>
            (item.scope  && item.scope.toLowerCase().includes(term)) ||
            (item.module && item.module.toLowerCase().includes(term))
        ) : sorted;

        idCounter = 0;
        expanded.clear();

        const tbody = document.getElementById('tbody');
        tbody.innerHTML = '';

        for (const item of filtered) {
            const rowId = String(idCounter++);
            appendTopRow(tbody, item, rowId);
            appendCallerRows(tbody, item.callers, rowId, 1);
        }

        restoreExpanded();
    }

    function restoreExpanded() {
        if (expandedKeys.size === 0) { return; }
        document.querySelectorAll('tr[data-expandable][data-caller-key]').forEach(tr => {
            const k = tr.dataset.callerKey;
            if (!k || !expandedKeys.has(k)) { return; }
            const rowId = tr.dataset.rowId;
            document.querySelectorAll(`tr[data-parent-id="${rowId}"]`).forEach(child => {
                child.style.display = '';
            });
            expanded.add(rowId);
            tr.dataset.open = '1';
        });
    }

    function appendTopRow(tbody, item, rowId) {
        const hasCallers = item.callers && item.callers.length > 0;

        const tr = document.createElement('tr');
        tr.className = 'top-row';
        tr.dataset.rowId = rowId;
        tr.dataset.level = '0';
        tr.dataset.callerKey = item.key;
        if (hasCallers) { tr.dataset.expandable = '1'; }
        tr.innerHTML =
            numCell(item.own, 'own', fmt(item.own)) +
            numCell(item.total, 'total', fmt(item.total)) +
            funcCell(item.scope, item.module, 0);

        tr.addEventListener('click', () => {
            if (item.module) { navigate(item.module, item.line); }
            if (hasCallers) { toggleRow(rowId); }
        });

        tbody.appendChild(tr);
    }

    function appendCallerRows(tbody, callers, parentId, level) {
        if (!callers || callers.length === 0) { return; }

        for (const caller of callers) {
            const rowId = String(idCounter++);
            const hasCallers = (caller.callers && caller.callers.length > 0) || caller.callersPending;

            const tr = document.createElement('tr');
            tr.className = 'caller-row';
            tr.dataset.rowId = rowId;
            tr.dataset.parentId = parentId;
            tr.dataset.level = String(level);
            tr.dataset.callerKey = caller.key;
            if (hasCallers) { tr.dataset.expandable = '1'; }
            if (caller.callersPending) { tr.dataset.callersPending = '1'; }
            tr.style.display = 'none';
            tr.innerHTML =
                contribCell(caller.contribution, fmt(caller.contribution)) +
                numCell(caller.total, 'total', fmt(caller.total)) +
                funcCell(caller.scope, caller.module, level);

            tr.addEventListener('click', () => {
                if (caller.module) { navigate(caller.module, caller.line); }
                if (hasCallers) { toggleRow(rowId); }
            });

            tbody.appendChild(tr);
            appendCallerRows(tbody, caller.callers, rowId, level + 1);
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
                if (row.dataset.callerKey) { expandedKeys.delete(row.dataset.callerKey); }
            }
        } else {
            if (row && row.dataset.callersPending) {
                vscode.postMessage({ requestCallers: {
                    rowId,
                    key: row.dataset.callerKey,
                    ancestorKeys: collectAncestorKeys(row),
                }});
                return;
            }
            document.querySelectorAll(`tr[data-parent-id="${rowId}"]`).forEach(tr => {
                tr.style.display = '';
            });
            expanded.add(rowId);
            if (row) {
                row.dataset.open = '1';
                if (row.dataset.callerKey) { expandedKeys.add(row.dataset.callerKey); }
            }
        }
    }

    function collectAncestorKeys(row) {
        const keys = [];
        let parentId = row.dataset.parentId;
        while (parentId) {
            const parentRow = document.querySelector(`tr[data-row-id="${parentId}"]`);
            if (!parentRow) { break; }
            if (parentRow.dataset.callerKey) { keys.push(parentRow.dataset.callerKey); }
            parentId = parentRow.dataset.parentId;
        }
        return keys;
    }

    function insertLazyCallers(rowId, callers) {
        const parentRow = document.querySelector(`tr[data-row-id="${rowId}"]`);
        if (!parentRow) { return; }
        const parentLevel = parseInt(parentRow.dataset.level || '0', 10);
        delete parentRow.dataset.callersPending;

        // Find insertion point: first row at same or lower level after the parent
        let insertBefore = parentRow.nextElementSibling;
        while (insertBefore) {
            if (parseInt(insertBefore.dataset.level || '0', 10) <= parentLevel) { break; }
            insertBefore = insertBefore.nextElementSibling;
        }

        const tbody = document.getElementById('tbody');
        for (const caller of callers) {
            insertCallerBefore(tbody, insertBefore, caller, rowId, parentLevel + 1);
        }

        // Expand the row
        document.querySelectorAll(`tr[data-parent-id="${rowId}"]`).forEach(tr => {
            tr.style.display = '';
        });
        expanded.add(rowId);
        parentRow.dataset.open = '1';
        if (parentRow.dataset.callerKey) { expandedKeys.add(parentRow.dataset.callerKey); }
    }

    function insertCallerBefore(tbody, refNode, caller, parentId, level) {
        const rowId = String(idCounter++);
        const hasCallers = (caller.callers && caller.callers.length > 0) || caller.callersPending;

        const tr = document.createElement('tr');
        tr.className = 'caller-row';
        tr.dataset.rowId = rowId;
        tr.dataset.parentId = parentId;
        tr.dataset.level = String(level);
        tr.dataset.callerKey = caller.key;
        if (hasCallers) { tr.dataset.expandable = '1'; }
        if (caller.callersPending) { tr.dataset.callersPending = '1'; }
        tr.style.display = 'none';
        tr.innerHTML =
            contribCell(caller.contribution, fmt(caller.contribution)) +
            numCell(caller.total, 'total', fmt(caller.total)) +
            funcCell(caller.scope, caller.module, level);

        tr.addEventListener('click', () => {
            if (caller.module) { navigate(caller.module, caller.line); }
            if (hasCallers) { toggleRow(rowId); }
        });

        tbody.insertBefore(tr, refNode || null);

        if (!caller.callersPending && caller.callers) {
            for (const child of caller.callers) {
                insertCallerBefore(tbody, refNode, child, rowId, level + 1);
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
            if (tr.dataset.callerKey) { expandedKeys.delete(tr.dataset.callerKey); }
        });
    }

    // ---- cell builders ----

    function numCell(value, kind, label) {
        const w = Math.min(100, value * 100).toFixed(1);
        const c = statColor(value);
        const fillStyle = c ? `width:${w}%;background:${c}` : `width:${w}%`;
        return `<td class="num"><div class="bar-row">` +
            `<div class="bar-bg"><div class="bar-fill ${kind}" style="${fillStyle}"></div></div>` +
            `<span class="pct"${c ? ` style="color:${c}"` : ''}>${label}%</span>` +
            `</div></td>`;
    }

    function contribCell(value, label) {
        const w = Math.min(100, value * 100).toFixed(1);
        const c = statColor(value);
        const fillStyle = c ? `width:${w}%;background:${c}` : `width:${w}%`;
        return `<td class="num" title="% of parent&#39;s time attributed to this caller">` +
            `<div class="bar-row">` +
            `<div class="bar-bg"><div class="bar-fill contrib" style="${fillStyle}"></div></div>` +
            `<span class="pct"${c ? ` style="color:${c}"` : ''}>${label}%</span>` +
            `</div></td>`;
    }

    function funcCell(scope, module, level) {
        const indent = level * 10;
        const mod = module ? basename(module) : '';
        return `<td class="func" style="padding-left:${indent + 6}px">` +
            `<span class="scope-name" title="${esc(scope)}">${esc(scope || '')}</span>` +
            (mod ? `<span class="scope-module" title="${esc(module)}">${esc(mod)}</span>` : '') +
            `</td>`;
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

    document.getElementById('collapse-all').addEventListener('click', () => {
        if (data.length > 0) { render(); }
    });

    filterInput.addEventListener('input', e => {
        filterTerm = e.target.value.trim();
        filterClear.classList.toggle('visible', filterTerm.length > 0);
        render();
    });

    filterClear.addEventListener('click', () => {
        filterInput.value = '';
        filterTerm = '';
        filterClear.classList.remove('visible');
        filterInput.focus();
        render();
    });

    // Keep thead positioned just below the sticky toolbar regardless of its height.
    const toolbar = document.querySelector('.toolbar');
    const updateToolbarHeight = () => {
        document.documentElement.style.setProperty('--toolbar-h', toolbar.offsetHeight + 'px');
    };
    updateToolbarHeight();
    new ResizeObserver(updateToolbarHeight).observe(toolbar);

    // ---- sortable headers ----

    document.querySelectorAll('th[data-col]').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.col;
            if (sortCol === col) {
                sortAsc = !sortAsc;
            } else {
                sortCol = col;
                sortAsc = col === 'scope' || col === 'module';
            }
            document.querySelectorAll('th[data-col]').forEach(t => t.classList.remove('asc', 'desc'));
            th.classList.add(sortAsc ? 'asc' : 'desc');
            render();
        });
    });

    vscode.postMessage('initialized');
})();
