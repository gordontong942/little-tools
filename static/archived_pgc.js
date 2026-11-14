async function startProjectGcExtraction() {
    if (state.isExecuting) return;
    const pgcCookie = document.getElementById('pgcCookieInput').value.trim();
    const pgcUrl = document.getElementById('pgcUrlInput').value.trim();
    const gcCookie = document.getElementById('cookieInput').value.trim();
    const limitVal = parseLimitInput(document.getElementById('pgcLimitInput').value);

    if (!pgcUrl) { alert('Please provide the Project-GC MapCompare URL.'); return; }
    if (!pgcCookie) { alert('Please provide your Project-GC cookie string.'); return; }
    if (!gcCookie) { alert('Please also paste your Geocaching.com cookie string in Tab 1 so each cache can be enriched.'); return; }

    saveCookieToStorage('pgc', pgcCookie);
    saveCookieToStorage('gc', gcCookie);

    state.isExecuting = true;
    setStatus('RUNNING');
    document.getElementById('pgcSubmitBtn').disabled = true;
    document.getElementById('submitBtn').disabled = true;

    try {
        logPgc('Step 1: Requesting Project-GC MapCompare URL...', 'info');
        const pgcRes = await fetch('/api/projectgc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: pgcUrl, cookie: pgcCookie })
        });
        const pgcData = await pgcRes.json();
        if (!pgcRes.ok) {
            if (pgcRes.status === 401 || pgcRes.status === 403) {
                clearStoredCookies('pgc');
            }
            throw new Error(pgcData.error || 'Failed to fetch Project-GC page');
        }

        let gcCodes = pgcData.gc_codes || [];
        logPgc(`Found #myTabContent: ${pgcData.found_myTabContent ? 'Yes' : 'Fallback'} | Extracted ${gcCodes.length} GC codes.`, 'success');

        if (limitVal !== -1 && gcCodes.length > limitVal) {
            gcCodes = gcCodes.slice(0, limitVal);
            logPgc(`Applying limit -> taking first ${gcCodes.length} GC codes.`, 'info');
        }

        if (gcCodes.length === 0) {
            logPgc('No GC codes found in #myTabContent. Verify your Project-GC cookie and URL.', 'warn');
            setStatus('SUCCESS');
            return;
        }

        logPgc(`Step 2: Enriching ${gcCodes.length} archived caches via Geocaching.com...`, 'info');
        const enrichRes = await fetch('/api/enrich', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gc_codes: gcCodes, cookie: gcCookie, limit: limitVal })
        });

        if (!enrichRes.ok) {
            if (enrichRes.status === 401) {
                clearStoredCookies('gc');
            }
            throw new Error('Failed to enrich caches on Geocaching.com');
        }

        const enrichedData = await enrichRes.json();
        const allArchived = [];

        gcCodes.forEach(code => {
            const details = enrichedData[code] || {};
            const hasCoords = (details.lat !== null && details.lat !== undefined && details.lng !== null && details.lng !== undefined);
            allArchived.push({
                code,
                owner: details.ownerName || '-',
                name: details.name || 'N/A',
                type: details.type || 'Traditional',
                difficulty: details.difficulty || '-',
                terrain: details.terrain || '-',
                ddmCoords: hasCoords ? toDDM(details.lat, details.lng) : '-',
                isCorrected: Boolean(details.isCorrected),
                personalNote: details.personalNote || '',
                lastFoundDate: details.lastFoundDate || '',
                archiveDate: details.archiveDate || '',
                foundAfterArchive: Boolean(details.foundAfterArchive)
            });
        });

        state.archivedCaches = allArchived;
        const matchedCount = allArchived.filter(c => c.foundAfterArchive).length;

        renderArchivedTable();
        logPgc(`Complete! Fetched ${allArchived.length} archived caches (${matchedCount} with Found It log after Archive date).`, 'success');
        setStatus('SUCCESS');

        switchTab('archivedResultTab');
    } catch (err) {
        const msg = String(err.message || '').toLowerCase();
        if (msg.includes('401') || msg.includes('authentication failed') || msg.includes('sign-in')) {
            clearStoredCookies('gc');
            logPgc('Geocaching.com cookie appears invalid or expired — cleared from localStorage.', 'warn');
        } else if (msg.includes('403') || msg.includes('project-gc')) {
            clearStoredCookies('pgc');
            logPgc('Project-GC cookie appears invalid or expired — cleared from localStorage.', 'warn');
        }
        logPgc(`Error: ${err.message}`, 'error');
        setStatus('ERROR');
    } finally {
        state.isExecuting = false;
        document.getElementById('pgcSubmitBtn').disabled = false;
        document.getElementById('submitBtn').disabled = false;
    }
}

function renderArchivedTable() {
    const tbody = document.getElementById('archivedTableBody');
    const onlyAfterArchive = document.getElementById('onlyFoundAfterArchiveToggle').checked;

    const matchingAll = state.archivedCaches.filter(c => c.foundAfterArchive);
    document.getElementById('statArchived').textContent = state.archivedCaches.length;
    document.getElementById('archivedSummaryBadge').textContent = `Total Fetched: ${state.archivedCaches.length} | Found After Archive: ${matchingAll.length}`;

    const displayList = onlyAfterArchive ? matchingAll : state.archivedCaches;

    if (displayList.length === 0) {
        const emptyMsg = state.archivedCaches.length === 0
            ? 'No archived geocaches fetched yet.'
            : 'No archived caches matched Found It after Archive date (uncheck filter above to inspect all).';
        tbody.innerHTML = `<tr><td colspan="10" class="text-center py-12 text-slate-600 font-sans">${emptyMsg}</td></tr>`;
        return;
    }

    const fragment = document.createDocumentFragment();
    displayList.forEach(cache => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-900/50 transition border-b border-slate-800/60';
        tr.setAttribute('data-type', cache.type);

        const coordKey = `arch-${cache.code}-coord`;
        const noteKey = `arch-${cache.code}-note`;
        const isCoordCopied = state.copiedCells.has(coordKey);
        const isNoteCopied = state.copiedCells.has(noteKey);

        tr.innerHTML = `
            <td class="py-2.5 px-3 border-r border-slate-800/70 align-top">
                <a href="https://www.geocaching.com/geocache/${cache.code}" target="_blank" class="font-bold text-rose-400 hover:underline">${escapeHtml(cache.code)}</a>
            </td>
            <td class="py-2.5 px-3 border-r border-slate-800/70 text-slate-300 font-sans align-top">${escapeHtml(cache.owner)}</td>
            <td class="py-2.5 px-3 border-r border-slate-800/70 font-mono text-[11px] align-top ${cache.foundAfterArchive ? 'text-emerald-400 font-bold' : 'text-slate-300'}">
                ${cache.lastFoundDate ? escapeHtml(cache.lastFoundDate) : '<span class="text-slate-600">-</span>'}
            </td>
            <td class="py-2.5 px-3 border-r border-slate-800/70 text-rose-300 font-mono text-[11px] align-top">
                ${cache.archiveDate ? escapeHtml(cache.archiveDate) : '<span class="text-slate-600">-</span>'}
            </td>
            <td class="py-2.5 px-2 border-r border-slate-800/70 text-center align-top">${getCacheTypeBadge(cache.type)}</td>
            <td class="py-2.5 px-3 border-r border-slate-800/70 font-sans text-white align-top">${escapeHtml(cache.name)}</td>
            <td class="py-2.5 px-2 border-r border-slate-800/70 text-center text-slate-300 align-top">${escapeHtml(cache.difficulty)}</td>
            <td class="py-2.5 px-2 border-r border-slate-800/70 text-center text-slate-300 align-top">${escapeHtml(cache.terrain)}</td>
            <td onclick="toggleCopyCell(this)"
                data-key="${coordKey}"
                data-copy="${escapeHtml(cache.ddmCoords)}"
                data-label="${cache.code} Coords"
                data-highlight="bg-emerald-950/70"
                class="py-2 px-3 border-r border-slate-800/70 align-top transition-colors duration-150 ${cache.ddmCoords !== '-' ? 'cursor-pointer hover:bg-slate-800/60' : ''} ${isCoordCopied ? 'bg-emerald-950/70' : ''}">
                ${cache.ddmCoords !== '-' ? `
                    <div class="flex items-center justify-between gap-2">
                        <div class="flex items-center gap-1.5">
                            <span class="inline-block text-[9px] font-mono px-1.5 py-0.2 rounded border ${cache.isCorrected ? 'bg-emerald-950/80 text-emerald-400 border-emerald-800' : 'bg-slate-900 text-slate-500 border-slate-800'} select-none">
                                ${cache.isCorrected ? 'Corrected' : 'Posted'}
                            </span>
                            <span class="${cache.isCorrected ? 'text-emerald-400 font-bold' : 'text-slate-300'} font-mono whitespace-nowrap">${escapeHtml(cache.ddmCoords)}</span>
                        </div>
                        <i class="fa-regular fa-copy text-slate-500 text-xs shrink-0"></i>
                    </div>
                ` : '<span class="text-slate-600">-</span>'}
            </td>
            <td onclick="toggleCopyCell(this)"
                data-key="${noteKey}"
                data-copy="${escapeHtml(cache.personalNote)}"
                data-label="${cache.code} Note"
                data-highlight="bg-amber-950/70"
                class="py-2 px-3 align-top transition-colors duration-150 ${cache.personalNote ? 'cursor-pointer hover:bg-slate-800/60' : ''} ${isNoteCopied ? 'bg-amber-950/70' : ''}">
                ${cache.personalNote ? `
                    <div class="flex items-start justify-between gap-2">
                        <span class="text-amber-400 font-sans text-xs whitespace-pre-line break-words max-w-[260px]"><i class="fa-solid fa-sticky-note mr-1"></i>${escapeHtml(cache.personalNote)}</span>
                        <i class="fa-regular fa-copy text-slate-500 text-xs mt-0.5 shrink-0"></i>
                    </div>
                ` : '<span class="text-slate-600">-</span>'}
            </td>
        `;
        fragment.appendChild(tr);
    });

    tbody.innerHTML = '';
    tbody.appendChild(fragment);
    applyArchivedFilters();
}

function sortArchivedTable(columnKey) {
    if (state.archSortCol === columnKey) state.archSortAsc = !state.archSortAsc;
    else { state.archSortCol = columnKey; state.archSortAsc = true; }

    state.archivedCaches.sort((a, b) => {
        const valA = a[columnKey] || '', valB = b[columnKey] || '';
        const cmp = String(valA).localeCompare(String(valB), undefined, { numeric: true });
        return state.archSortAsc ? cmp : -cmp;
    });
    renderArchivedTable();
}

function applyArchivedFilters() {
    const query = document.getElementById('archivedSearchInput').value.toLowerCase();
    const selectedType = document.getElementById('archivedTypeFilter').value.toLowerCase();
    document.querySelectorAll('#archivedTableBody tr').forEach(row => {
        if (row.cells.length === 1) return;
        const textMatch = row.textContent.toLowerCase().includes(query);
        const rowType = (row.getAttribute('data-type') || '').toLowerCase();
        row.style.display = (textMatch && (selectedType === 'all' || rowType.includes(selectedType))) ? '' : 'none';
    });
}

function clearArchivedData() {
    state.archivedCaches = [];
    renderArchivedTable();
    document.getElementById('pgcTerminalOutput').innerHTML = '<div class="text-slate-600">[System Cleared] Archived list reset.</div>';
    setStatus('Ready');
}