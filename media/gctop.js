(function () {
    const vscode = acquireVsCodeApi();

    let topFrames = [];
    let hasThreadData = false;
    let sortCol = 'gcOwn';
    let sortAsc = false;
    let filterTerm = '';

    const loading        = document.getElementById('loading');
    const filterInput    = document.getElementById('filter-input');
    const filterClear    = document.getElementById('filter-clear');
    const liveDot        = document.getElementById('live-dot');
    const emptyEl        = document.getElementById('empty');
    const emptyMsgEl     = document.getElementById('empty-msg');
    const emptyActionsEl = document.getElementById('empty-actions');
    const contentEl      = document.getElementById('content');
    const threadSummary  = document.getElementById('thread-summary');

    function setEmptyState(msg, showActions, color) {
        emptyMsgEl.textContent = msg;
        emptyMsgEl.style.color = color || '';
        emptyActionsEl.style.display = showActions ? '' : 'none';
    }

    window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.loading) {
            topFrames = [];
            hasThreadData = false;
            filterTerm = '';
            filterInput.value = '';
            filterClear.classList.remove('visible');
            setEmptyState('No profiling data loaded.', true);
            render();
            loading.classList.add('active');
        } else if (msg.noGC) {
            loading.classList.remove('active');
            topFrames = [];
            hasThreadData = false;
            setEmptyState('No GC data available in this profile. Enable GC collection with the GC toggle in the status bar.', false);
            render();
        } else if (msg.threads !== undefined) {
            loading.classList.remove('active');
            topFrames = msg.topFrames || [];
            hasThreadData = true;
            renderThreadSummary(msg.threads || []);
            render();
        } else if (msg.live !== undefined) {
            liveDot.classList.toggle('active', !!msg.live);
        } else if (msg.error) {
            loading.classList.remove('active');
            topFrames = [];
            hasThreadData = false;
            setEmptyState('Profiling failed. Check the Austin output channel for details.', false, 'var(--vscode-errorForeground, #f48771)');
            render();
        }
    });

    function renderThreadSummary(threads) {
        threadSummary.innerHTML = '';
        for (const t of threads) {
            const pct = (t.gcFraction * 100).toFixed(1);
            const row = document.createElement('div');
            row.className = 'thread-row';
            row.style.cursor = 'pointer';
            row.title = 'Click to focus thread in flame graph';
            const c = statColor(t.gcFraction);
            row.innerHTML =
                `<span class="thread-label">P${t.pid} T${t.tid}</span>` +
                `<div class="thread-bar-bg"><div class="thread-bar-fill" style="width:${Math.min(100, t.gcFraction * 100).toFixed(1)}%${c ? `;background:${c}` : ''}"></div></div>` +
                `<span class="thread-pct"${c ? ` style="color:${c}"` : ''}>${pct}%</span>`;
            const threadKey = `${t.pid}:${t.tid}`;
            row.addEventListener('click', () => vscode.postMessage({ focusThread: threadKey }));
            threadSummary.appendChild(row);
        }
    }

    function render() {
        if (!hasThreadData) {
            emptyEl.style.display = '';
            contentEl.style.display = 'none';
            return;
        }

        emptyEl.style.display = 'none';
        contentEl.style.display = '';

        if (topFrames.length === 0) {
            document.getElementById('tbody').innerHTML = '';
            return;
        }

        const sorted = [...topFrames].sort((a, b) => {
            const av = a[sortCol];
            const bv = b[sortCol];
            if (typeof av === 'number') { return sortAsc ? av - bv : bv - av; }
            return sortAsc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
        });

        const term = filterTerm.toLowerCase();
        const filtered = term
            ? sorted.filter(item =>
                (item.scope  && item.scope.toLowerCase().includes(term)) ||
                (item.module && item.module.toLowerCase().includes(term)))
            : sorted;

        const tbody = document.getElementById('tbody');
        tbody.innerHTML = '';

        for (const item of filtered) {
            const tr = document.createElement('tr');
            tr.className = 'frame-row';
            if (item.module) { tr.title = item.module; }
            tr.innerHTML =
                gcCell(item.gcOwn) +
                gcCell(item.gcTotal) +
                funcCell(item.scope, item.module);
            tr.addEventListener('click', () => {
                if (item.module) { vscode.postMessage({ module: item.module, line: item.line }); }
            });
            tbody.appendChild(tr);
        }
    }

    function gcCell(value) {
        const pct = (value * 100).toFixed(2);
        const w = Math.min(100, value * 100).toFixed(1);
        const c = statColor(value);
        const fillStyle = c ? `width:${w}%;background:${c}` : `width:${w}%`;
        return `<td class="num"><div class="bar-row">` +
            `<div class="bar-bg"><div class="bar-fill" style="${fillStyle}"></div></div>` +
            `<span class="pct"${c ? ` style="color:${c}"` : ''}>${pct}%</span>` +
            `</div></td>`;
    }

    function funcCell(scope, module) {
        const mod = module ? basename(module) : '';
        return `<td class="func" style="padding-left:6px">` +
            `<span class="scope-name">${esc(scope || '')}</span>` +
            (mod ? `<span class="scope-module">${esc(mod)}</span>` : '') +
            `</td>`;
    }

    function statColor(value) {
        const pct = value * 100;
        if (pct >= 75) { return '#e74c3c'; }
        if (pct >= 50) { return '#e67e22'; }
        if (pct >= 25) { return '#f1c40f'; }
        return null;
    }

    function esc(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function basename(path) {
        return path.replace(/\\/g, '/').split('/').pop() || path;
    }

    // Sortable headers
    document.querySelectorAll('th[data-col]').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.col;
            if (sortCol === col) {
                sortAsc = !sortAsc;
            } else {
                sortCol = col;
                sortAsc = col === 'scope';
            }
            document.querySelectorAll('th[data-col]').forEach(t => t.classList.remove('asc', 'desc'));
            th.classList.add(sortAsc ? 'asc' : 'desc');
            render();
        });
    });

    // Filter
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

    document.getElementById('open-btn').addEventListener('click', () => vscode.postMessage('open'));
    document.getElementById('attach-btn').addEventListener('click', () => vscode.postMessage('attach'));

    // Keep thead positioned below sticky toolbar
    const toolbar = document.querySelector('.toolbar');
    const updateToolbarHeight = () => {
        document.documentElement.style.setProperty('--toolbar-h', toolbar.offsetHeight + 'px');
    };
    updateToolbarHeight();
    new ResizeObserver(updateToolbarHeight).observe(toolbar);

    vscode.postMessage('initialized');
})();
