function handleCountryChange() {
    const country = document.getElementById('countrySelect').value;
    const limitInput = document.getElementById('cacheLimitInput');

    if (country === 'Taiwan' || country === 'Japan') {
        limitInput.value = '1000';
    } else {
        limitInput.value = 'all';
    }

    updateRegionDropdown();
}

function updateRegionDropdown() {
    const country = document.getElementById('countrySelect').value;
    const regionSelect = document.getElementById('regionSelect');
    const regions = (typeof COUNTRY_CONFIG !== 'undefined' && COUNTRY_CONFIG[country]?.regions) || [];

    regionSelect.innerHTML = regions.map((r, idx) =>
        `<option value="${idx}">${escapeHtml(r.name)}</option>`
    ).join('');
}

document.addEventListener('DOMContentLoaded', handleCountryChange);

function buildQueryParamSets(countryCfg, regionObj, foundFilter, username) {
    const targetOt = regionObj.ot || 'country';
    const targetOid = regionObj.oid !== undefined ? regionObj.oid : countryCfg.oid;

    const makeBase = () => {
        const p = new URLSearchParams();
        p.set('sort', 'distance');
        p.set('asc', 'true');
        if (regionObj.st) p.set('st', regionObj.st);
        p.set('ot', targetOt);
        p.set('oid', String(targetOid));
        p.set('r', String(regionObj.r));
        if (regionObj.lat !== undefined) p.set('lat', String(regionObj.lat));
        if (regionObj.lng !== undefined) p.set('lng', String(regionObj.lng));
        if (regionObj.zoom !== undefined) p.set('zoom', String(regionObj.zoom));
        if (regionObj.bbox) p.set('box', regionObj.bbox);
        return p;
    };

    switch (foundFilter) {
        case 'NOT_FOUND': {
            const p = makeBase();
            p.set('hf', '1');
            p.set('nfb', username || 'gordon942');
            return [p];
        }
        case 'FOUND': {
            const pFound = makeBase();
            pFound.set('hf', '1');
            const pOwned = makeBase();
            pOwned.set('ho', '1');
            return [pFound, pOwned];
        }
        case 'FOUND_EXCLUDE_OWNED': {
            const p = makeBase();
            p.set('hf', '1');
            return [p];
        }
        case 'SOLVED': {
            const p = makeBase();
            p.set('hc', '1');
            return [p];
        }
        case 'OWNED': {
            const p = makeBase();
            p.set('ho', '1');
            return [p];
        }
        case 'ALL':
        default: {
            return [makeBase()];
        }
    }
}

function checkItemIsOwner(item) {
    const ownerName = extractValue(item.owner || item.ownerName || item.placedBy, '');
    const activeUser = (state.username || 'gordon942').toLowerCase();
    return Boolean(item.isOwner || item.userState?.isOwner) || ownerName.toLowerCase() === activeUser;
}

function checkItemIsFound(item) {
    return Boolean(
        item.userState?.hasFound === true ||
        item.userState?.isFound === true ||
        item.userState?.found === true ||
        Boolean(item.userState?.foundDate) ||
        item.hasFound === true ||
        item.isFound === true ||
        item.found === true ||
        (typeof item.userState?.logType === 'number' && item.userState.logType === 2)
    );
}

function checkItemIsSolved(item) {
    const corr = item.userCorrectedCoordinates;
    return Boolean(corr && typeof corr.latitude === 'number' && typeof corr.longitude === 'number');
}

function matchesStatusFilter(filterMode, isFound, isOwner, isSolved) {
    switch (filterMode) {
        case 'FOUND': return isFound || isOwner;
        case 'FOUND_EXCLUDE_OWNED': return isFound && !isOwner;
        case 'NOT_FOUND': return !isFound && !isOwner;
        case 'SOLVED': return isSolved;
        case 'OWNED': return isOwner;
        case 'ALL':
        default: return true;
    }
}

async function startExtraction() {
    if (state.isExecuting) return;
    const cookie = document.getElementById('cookieInput').value.trim();
    const country = document.getElementById('countrySelect').value;
    const countryCfg = COUNTRY_CONFIG[country];
    const regionIdx = parseInt(document.getElementById('regionSelect').value, 10) || 0;
    const regionObj = countryCfg.regions[regionIdx];
    const foundFilter = document.getElementById('foundFilterConfig').value;
    const limitVal = parseLimitInput(document.getElementById('cacheLimitInput').value);
    const shouldEnrich = document.getElementById('enrichToggle').checked;

    if (!cookie) { alert('Please input your Geocaching cookie string.'); return; }

    state.isExecuting = true;
    setStatus('RUNNING');
    document.getElementById('submitBtn').disabled = true;
    document.getElementById('pgcSubmitBtn').disabled = true;

    const filterLabelMap = {
        ALL: 'All Caches',
        FOUND: 'Found (Include Owned)',
        FOUND_EXCLUDE_OWNED: 'Found (Exclude Owned)',
        NOT_FOUND: 'Not Found Only',
        SOLVED: 'Only Solved Caches',
        OWNED: 'Owned Caches Only'
    };
    const limitLabel = limitVal === -1 ? 'All' : `First ${limitVal}`;
    document.getElementById('batchSizeBadge').textContent = `Filter: ${filterLabelMap[foundFilter]} | Limit: ${limitLabel} (${country} - ${regionObj.name})`;

    try {
        const targetOt = regionObj.ot || 'country';
        const targetOid = regionObj.oid !== undefined ? regionObj.oid : countryCfg.oid;
        log(`Target: ${country} -> ${regionObj.name} (ot=${targetOt}, oid=${targetOid}) | Filter: ${filterLabelMap[foundFilter]} | Limit: ${limitLabel}`, 'info');
        log('Step 1: Fetching map page for Next.js buildId & username...', 'info');
        const mapRes = await fetch('/api/proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: '/play/map', cookie })
        });
        const mapData = await mapRes.json();
        if (!mapRes.ok) throw new Error(mapData.error || 'Failed to load /play/map');

        const html = mapData.html || '';
        const buildIdMatch = html.match(/"buildId"\s*:\s*"([^"]+)"/) || html.match(/\/_next\/static\/([^/]+)\/_buildManifest/);
        if (!buildIdMatch) throw new Error('Failed to parse buildId. Check cookie validity.');
        const buildId = buildIdMatch[1];

        const userMatch = html.match(/"username"\s*:\s*"([^"]+)"/) || html.match(/data-username="([^"]+)"/);
        if (userMatch && userMatch[1]) {
            state.username = userMatch[1];
        }

        const paramSets = buildQueryParamSets(countryCfg, regionObj, foundFilter, state.username);
        const seenCodes = new Set();
        let searchResults = [];

        for (const params of paramSets) {
            let skip = 0;
            const take = 500;
            let keepPaging = true;

            while (keepPaging) {
                const pageParams = new URLSearchParams(params.toString());
                pageParams.set('take', String(take));
                if (skip > 0) pageParams.set('skip', String(skip));

                const qs = pageParams.toString();
                const jsonEndpoint = `/_next/data/${buildId}/en/play/map.json?${qs}`;
                log(`Step 2: Requesting -> ?${qs}`, 'info');

                const jsonRes = await fetch('/api/proxy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ endpoint: jsonEndpoint, cookie })
                });

                const jsonData = await jsonRes.json();
                const searchObj = jsonData?.pageProps?.searchResults || {};
                const batch = searchObj.results || jsonData?.pageProps?.mapData?.geocaches || [];
                const totalAvailable = searchObj.total || batch.length;

                for (const item of batch) {
                    const code = item.code || item.gcCode;
                    if (code && !seenCodes.has(code)) {
                        seenCodes.add(code);
                        searchResults.push(item);
                    }
                }

                const currentFilteredCount = searchResults.filter(item =>
                    matchesStatusFilter(
                        foundFilter,
                        checkItemIsFound(item),
                        checkItemIsOwner(item),
                        checkItemIsSolved(item)
                    )
                ).length;

                const reachedLimit = (limitVal !== -1 && currentFilteredCount >= limitVal);
                if (reachedLimit || batch.length === 0 || skip + batch.length >= totalAvailable || batch.length < 50) {
                    keepPaging = false;
                } else {
                    skip += batch.length;
                }
            }
        }

        searchResults = searchResults.filter(item => {
            const isOwner = checkItemIsOwner(item);
            const isFound = checkItemIsFound(item);
            const isSolved = checkItemIsSolved(item);
            return matchesStatusFilter(foundFilter, isFound, isOwner, isSolved);
        });

        const matchedCount = searchResults.length;
        if (limitVal !== -1 && searchResults.length > limitVal) {
            searchResults = searchResults.slice(0, limitVal);
        }

        log(`Received ${matchedCount} matching caches -> taking ${searchResults.length}.`, 'success');

        state.caches = searchResults.map(item => {
            const ownerName = extractValue(item.owner || item.ownerName || item.placedBy, '-');
            const isOwner = checkItemIsOwner(item);
            const hasFound = checkItemIsFound(item);
            const coordsData = extractCoordsFromProxyItem(item);

            let statusLabel = 'Unfound';
            let badgeClass = 'bg-slate-900 text-slate-500 border-slate-800';
            let icon = 'fa-circle';

            if (isOwner) {
                statusLabel = 'Owner';
                badgeClass = 'bg-amber-950/80 text-amber-400 border-amber-800';
                icon = 'fa-user-gear';
            } else if (hasFound) {
                statusLabel = 'Found';
                badgeClass = 'bg-emerald-950/80 text-emerald-400 border-emerald-800';
                icon = 'fa-check-circle';
            }

            return {
                code: item.code || item.gcCode,
                owner: ownerName,
                name: extractValue(item.name || item.geocacheName, 'N/A'),
                type: parseCacheType(item),
                difficulty: extractValue(item.difficulty, '-'),
                terrain: extractValue(item.terrain, '-'),
                ddmCoords: coordsData.ddm,
                isCorrected: coordsData.isCorrected,
                personalNote: '',
                status: statusLabel,
                isOwner: isOwner,
                hasFound: hasFound,
                logDate: '',
                statusBadgeClass: badgeClass,
                statusIcon: icon
            };
        });

        renderCachesTable();

        const gcCodes = state.caches.map(c => c.code);
        if (shouldEnrich && gcCodes.length > 0) {
            log(`Step 3: Enriching ${gcCodes.length} caches (15 parallel workers)...`, 'info');
            const enrichRes = await fetch('/api/enrich', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ gc_codes: gcCodes, cookie, limit: limitVal })
            });

            if (enrichRes.ok) {
                const enrichedData = await enrichRes.json();
                const activeUser = (state.username || 'gordon942').toLowerCase();

                state.caches.forEach(cache => {
                    const details = enrichedData[cache.code];
                    if (details) {
                        if (details.ownerName) cache.owner = details.ownerName;
                        cache.personalNote = details.personalNote || '';
                        cache.logDate = details.foundDate || '';

                        if (details.isOwner || (cache.owner && cache.owner.toLowerCase() === activeUser)) {
                            cache.isOwner = true;
                            cache.hasFound = false;
                            cache.status = 'Owner';
                            cache.statusBadgeClass = 'bg-amber-950/80 text-amber-400 border-amber-800';
                            cache.statusIcon = 'fa-user-gear';
                        } else if (details.hasFound) {
                            cache.hasFound = true;
                            cache.status = 'Found';
                            cache.statusBadgeClass = 'bg-emerald-950/80 text-emerald-400 border-emerald-800';
                            cache.statusIcon = 'fa-check-circle';
                        } else {
                            cache.hasFound = false;
                            cache.status = 'Unfound';
                            cache.statusBadgeClass = 'bg-slate-900 text-slate-500 border-slate-800';
                            cache.statusIcon = 'fa-circle';
                        }
                    }
                });

                state.caches = state.caches.filter(c =>
                    matchesStatusFilter(foundFilter, c.hasFound, c.isOwner, c.isCorrected)
                );
            }
        } else if (!shouldEnrich && gcCodes.length > 0) {
            log('Step 3: Skipped deep HTML enrichment (fast mode enabled).', 'info');
        }

        renderCachesTable();
        log('Extraction complete! Switching to Filter Cache Result...', 'success');
        setStatus('SUCCESS');

        switchTab('cachesTab', document.getElementById('btnCachesTab'));
    } catch (err) {
        log(`Error: ${err.message}`, 'error');
        setStatus('ERROR');
    } finally {
        state.isExecuting = false;
        document.getElementById('submitBtn').disabled = false;
        document.getElementById('pgcSubmitBtn').disabled = false;
    }
}

function renderCachesTable() {
    const tbody = document.getElementById('cachesTableBody');
    document.getElementById('statCaches').textContent = state.caches.length;

    if (state.caches.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" class="text-center py-12 text-slate-600 font-sans">No filter geocaches found matching criteria.</td></tr>`;
        return;
    }

    const fragment = document.createDocumentFragment();
    state.caches.forEach(cache => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-900/50 transition border-b border-slate-800/60';
        tr.setAttribute('data-type', cache.type);

        const coordKey = `${cache.code}-coord`;
        const noteKey = `${cache.code}-note`;
        const isCoordCopied = state.copiedCells.has(coordKey);
        const isNoteCopied = state.copiedCells.has(noteKey);

        tr.innerHTML = `
            <td class="py-2.5 px-3 border-r border-slate-800/70 align-top">
                <a href="https://www.geocaching.com/geocache/${cache.code}" target="_blank" class="font-bold text-indigo-400 hover:underline">${escapeHtml(cache.code)}</a>
            </td>
            <td class="py-2.5 px-3 border-r border-slate-800/70 text-slate-300 font-sans align-top">${escapeHtml(cache.owner)}</td>
            <td class="py-2.5 px-3 border-r border-slate-800/70 align-top">
                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono border ${cache.statusBadgeClass}">
                    <i class="fa-solid ${cache.statusIcon} text-[9px]"></i> ${cache.status}
                </span>
            </td>
            <td class="py-2.5 px-3 border-r border-slate-800/70 text-slate-400 font-mono text-[11px] align-top">
                ${cache.logDate ? escapeHtml(cache.logDate) : '<span class="text-slate-600">-</span>'}
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
    applyFilters();
}

function sortTable(columnKey) {
    if (state.sortCol === columnKey) state.sortAsc = !state.sortAsc;
    else { state.sortCol = columnKey; state.sortAsc = true; }

    state.caches.sort((a, b) => {
        const valA = a[columnKey] || '', valB = b[columnKey] || '';
        const cmp = String(valA).localeCompare(String(valB), undefined, { numeric: true });
        return state.sortAsc ? cmp : -cmp;
    });
    renderCachesTable();
}

function applyFilters() {
    const query = document.getElementById('searchInput').value.toLowerCase();
    const selectedType = document.getElementById('typeFilter').value.toLowerCase();
    document.querySelectorAll('#cachesTableBody tr').forEach(row => {
        if (row.cells.length === 1) return;
        const textMatch = row.textContent.toLowerCase().includes(query);
        const rowType = (row.getAttribute('data-type') || '').toLowerCase();
        row.style.display = (textMatch && (selectedType === 'all' || rowType.includes(selectedType))) ? '' : 'none';
    });
}

function clearFilterData() {
    state.caches = [];
    renderCachesTable();
    document.getElementById('terminalOutput').innerHTML = '<div class="text-slate-600">[System Cleared] Map filter list reset.</div>';
    setStatus('Ready');
}