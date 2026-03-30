(function () {
    const vscode = acquireVsCodeApi();

    let data = [];
    let sortCol = 'own';
    let sortAsc = false;
    let expanded = new Set();
    let idCounter = 0;

    window.addEventListener('message', event => {
        const message = event.data;
        if (message.top !== undefined) {
            data = message.top;
            render();
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

        idCounter = 0;
        expanded.clear();

        const tbody = document.getElementById('tbody');
        tbody.innerHTML = '';

        for (const item of sorted) {
            const rowId = String(idCounter++);
            appendTopRow(tbody, item, rowId);
            appendCallerRows(tbody, item.callers, rowId, 1);
        }
    }

    function appendTopRow(tbody, item, rowId) {
        const hasCallers = item.callers && item.callers.length > 0;

        const tr = document.createElement('tr');
        tr.className = 'top-row';
        tr.dataset.rowId = rowId;
        if (hasCallers) { tr.dataset.expandable = '1'; }
        tr.innerHTML =
            numCell(item.own, 'own', fmt(item.own)) +
            numCell(item.total, 'total', fmt(item.total)) +
            funcCell(item.scope, 0) +
            modCell(item.module);

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
            const hasCallers = caller.callers && caller.callers.length > 0;

            const tr = document.createElement('tr');
            tr.className = 'caller-row';
            tr.dataset.rowId = rowId;
            tr.dataset.parentId = parentId;
            tr.dataset.level = String(level);
            if (hasCallers) { tr.dataset.expandable = '1'; }
            tr.style.display = 'none';
            tr.innerHTML =
                contribCell(caller.contribution, fmt(caller.contribution)) +
                numCell(caller.total, 'total', fmt(caller.total)) +
                funcCell(caller.scope, level) +
                modCell(caller.module);

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
            if (row) { row.dataset.open = ''; delete row.dataset.open; }
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

    // ---- cell builders ----

    function numCell(value, kind, label) {
        const w = Math.min(100, value * 100).toFixed(1);
        return `<td class="num"><div class="bar-row">` +
            `<div class="bar-bg"><div class="bar-fill ${kind}" style="width:${w}%"></div></div>` +
            `<span class="pct">${label}%</span>` +
            `</div></td>`;
    }

    function contribCell(value, label) {
        const w = Math.min(100, value * 100).toFixed(1);
        return `<td class="num" title="% of parent&#39;s time attributed to this caller">` +
            `<div class="bar-row">` +
            `<div class="bar-bg"><div class="bar-fill contrib" style="width:${w}%"></div></div>` +
            `<span class="pct">${label}%</span>` +
            `</div></td>`;
    }

    function funcCell(scope, level) {
        const indent = level * 14;
        return `<td class="func" style="padding-left:${indent + 6}px" title="${esc(scope)}">${esc(scope || '')}</td>`;
    }

    function modCell(module) {
        return `<td class="mod" title="${esc(module)}">${esc(basename(module || ''))}</td>`;
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
