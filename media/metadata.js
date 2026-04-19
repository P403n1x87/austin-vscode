// @ts-check
(function () {
    // @ts-ignore
    const vscode = acquireVsCodeApi();

    const empty = document.getElementById('empty');
    const emptyMsg = document.getElementById('empty-msg');
    const content = document.getElementById('content');
    const tbody = document.getElementById('tbody');
    const loading = document.getElementById('loading');

    document.getElementById('open-btn')?.addEventListener('click', () => vscode.postMessage('open'));
    document.getElementById('attach-btn')?.addEventListener('click', () => vscode.postMessage('attach'));

    window.addEventListener('message', (event) => {
        const msg = event.data;

        if (msg.loading) {
            loading.classList.add('active');
            return;
        }
        loading.classList.remove('active');

        if (msg.error) {
            empty.style.display = '';
            emptyMsg.textContent = 'Failed to load profiling data.';
            content.style.display = 'none';
            return;
        }

        if (msg.noData) {
            empty.style.display = '';
            emptyMsg.textContent = 'No metadata available in this profile.';
            content.style.display = 'none';
            return;
        }

        if (msg.entries) {
            render(msg.entries);
        }
    });

    /** @param {{ key: string; value: string; kind?: string; parsed?: any }[]} entries */
    function render(entries) {
        empty.style.display = 'none';
        content.style.display = '';

        tbody.innerHTML = '';
        for (const entry of entries) {
            const tr = document.createElement('tr');

            const tdKey = document.createElement('td');
            tdKey.className = 'meta-key';
            tdKey.textContent = entry.key;

            const tdValue = document.createElement('td');
            tdValue.className = 'meta-value';
            tdValue.innerHTML = formatValue(entry);

            tr.appendChild(tdKey);
            tr.appendChild(tdValue);
            tbody.appendChild(tr);
        }
    }

    /** @param {{ key: string; value: string; kind?: string; parsed?: any }} entry */
    function formatValue(entry) {
        if (entry.kind === 'mode' && entry.parsed) {
            return escapeHtml(entry.parsed.display);
        }
        if (entry.kind === 'sampling' && entry.parsed) {
            const { min, avg, max } = entry.parsed;
            return `<span class="sampling">`
                + `<span class="sampling-label">min</span> <span class="sampling-value">${min}</span> `
                + `<span class="sampling-label">avg</span> <span class="sampling-value">${avg}</span> `
                + `<span class="sampling-label">max</span> <span class="sampling-value">${max}</span>`
                + `</span>`;
        }
        if (entry.kind === 'duration' && entry.parsed) {
            return escapeHtml(entry.parsed.display);
        }
        if (entry.kind === 'interval' && entry.parsed) {
            return `<span class="interval">`
                + `<span class="interval-time">${escapeHtml(entry.parsed.display)}</span>`
                + `<span class="interval-hz">${escapeHtml(entry.parsed.hzDisplay)}</span>`
                + `</span>`;
        }
        if (entry.kind === 'fraction' && entry.parsed) {
            const { n, count, pct } = entry.parsed;
            return `<span class="fraction">`
                + `<span class="fraction-pct">${pct.toFixed(2)}%</span>`
                + `<span class="fraction-detail">${n} / ${count}</span>`
                + `</span>`;
        }
        return escapeHtml(entry.value);
    }

    /** @param {string} s */
    function escapeHtml(s) {
        const el = document.createElement('span');
        el.textContent = s;
        return el.innerHTML;
    }

    vscode.postMessage('initialized');
})();
