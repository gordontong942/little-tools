const STORAGE_KEYS = {
    gcCookie: 'gc_extractor_gc_cookie_v1',
    pgcCookie: 'gc_extractor_pgc_cookie_v1'
};

const state = {
    caches: [],
    archivedCaches: [],
    activeTab: 'configTab',
    isExecuting: false,
    sortCol: null,
    sortAsc: true,
    archSortCol: null,
    archSortAsc: true,
    copiedCells: new Set(),
    username: 'gordon942'
};

const TYPE_ID_MAP = {
    2: 'Traditional', 3: 'Multi-cache', 4: 'Virtual', 5: 'Letterbox',
    6: 'Event', 8: 'Mystery', 11: 'Webcam', 13: 'Locationless',
    137: 'Earthcache', 453: 'Mega-Event', 1858: 'Wherigo'
};

function saveCookieToStorage(kind, value) {
    const key = kind === 'pgc' ? STORAGE_KEYS.pgcCookie : STORAGE_KEYS.gcCookie;
    try {
        const trimmed = String(value || '').trim();
        if (trimmed) {
            localStorage.setItem(key, trimmed);
        } else {
            localStorage.removeItem(key);
        }
    } catch (err) {
        console.warn('Unable to write cookie to localStorage:', err);
    }
}

function clearStoredCookies(target = 'all') {
    try {
        if (target === 'gc' || target === 'all') {
            localStorage.removeItem(STORAGE_KEYS.gcCookie);
            const gcEl = document.getElementById('cookieInput');
            if (gcEl) gcEl.value = '';
        }
        if (target === 'pgc' || target === 'all') {
            localStorage.removeItem(STORAGE_KEYS.pgcCookie);
            const pgcEl = document.getElementById('pgcCookieInput');
            if (pgcEl) pgcEl.value = '';
        }
    } catch (err) {
        console.warn('Unable to clear cookies from localStorage:', err);
    }

    showToast(
        target === 'gc'
            ? 'Cleared expired Geocaching.com cookie'
            : target === 'pgc'
              ? 'Cleared expired Project-GC cookie'
              : 'Cleared saved cookies'
    );
}

function initCookiePersistence() {
    const gcEl = document.getElementById('cookieInput');
    const pgcEl = document.getElementById('pgcCookieInput');

    try {
        const savedGc = localStorage.getItem(STORAGE_KEYS.gcCookie);
        const savedPgc = localStorage.getItem(STORAGE_KEYS.pgcCookie);

        if (gcEl && savedGc) {
            gcEl.value = savedGc;
            log('Restored saved Geocaching.com cookie from localStorage.', 'info');
        }
        if (pgcEl && savedPgc) {
            pgcEl.value = savedPgc;
            logPgc('Restored saved Project-GC cookie from localStorage.', 'info');
        }
    } catch (err) {
        console.warn('Unable to read cookies from localStorage:', err);
    }

    if (gcEl) {
        const persistGc = () => saveCookieToStorage('gc', gcEl.value);
        gcEl.addEventListener('input', persistGc);
        gcEl.addEventListener('change', persistGc);
    }
    if (pgcEl) {
        const persistPgc = () => saveCookieToStorage('pgc', pgcEl.value);
        pgcEl.addEventListener('input', persistPgc);
        pgcEl.addEventListener('change', persistPgc);
    }
}

document.addEventListener('DOMContentLoaded', initCookiePersistence);

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function extractValue(val, fallback = 'N/A') {
    if (!val && val !== 0) return fallback;
    if (typeof val === 'string' || typeof val === 'number') return String(val);
    if (typeof val === 'object') {
        return val.username || val.name || val.ownerName || val.placedBy || val.code || fallback;
    }
    return fallback;
}

function parseCacheType(item) {
    const rawType = item.geocacheType || item.cacheType || item.type || item.geocacheTypeId || item.typeId;
    if (typeof rawType === 'number' && TYPE_ID_MAP[rawType]) return TYPE_ID_MAP[rawType];
    if (typeof rawType === 'string') return rawType;
    return 'Traditional';
}

function parseLimitInput(rawStr) {
    const cleaned = String(rawStr || '').trim().toLowerCase();
    if (!cleaned || cleaned === 'all' || cleaned === '-1') return -1;
    const num = parseInt(cleaned, 10);
    if (isNaN(num) || num <= 0) return -1;
    return num;
}

function toDDM(lat, lng) {
    if (lat === undefined || lng === undefined || lat === null || lng === null || isNaN(lat) || isNaN(lng)) return '-';
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    if (Math.abs(latNum) > 90 || Math.abs(lngNum) > 180) return '-';

    const latHemi = latNum >= 0 ? 'N' : 'S';
    const latAbs = Math.abs(latNum);
    const latDeg = Math.floor(latAbs);
    const latMin = ((latAbs - latDeg) * 60).toFixed(3).padStart(6, '0');
    const lngHemi = lngNum >= 0 ? 'E' : 'W';
    const lngAbs = Math.abs(lngNum);
    const lngDeg = Math.floor(lngAbs).toString().padStart(3, '0');
    const lngMin = ((lngAbs - Math.floor(lngAbs)) * 60).toFixed(3).padStart(6, '0');

    return `${latHemi}${latDeg}° ${latMin}'${lngHemi} ${lngDeg}°${lngMin}'`;
}

function extractCoordsFromProxyItem(item) {
    const corr = item.userCorrectedCoordinates;
    if (corr && typeof corr.latitude === 'number' && typeof corr.longitude === 'number') {
        return { ddm: toDDM(corr.latitude, corr.longitude), isCorrected: true };
    }

    const posted = item.postedCoordinates;
    if (posted && typeof posted.latitude === 'number' && typeof posted.longitude === 'number') {
        return { ddm: toDDM(posted.latitude, posted.longitude), isCorrected: false };
    }

    return { ddm: '-', isCorrected: false };
}

function getCacheTypeBadge(typeStr) {
    const raw = String(typeStr || '').toLowerCase();
    const label = typeStr || 'Traditional';

    if (raw.includes('traditional')) {
        return `<span class="inline-flex items-center justify-center h-6 w-6 rounded-full bg-[#02874d] text-white shadow-sm border border-[#03a65f]" title="${escapeHtml(label)}">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M4 7l8-4 8 4v10l-8 4-8-4V7zm8-2.2L6.2 7.5 12 10.2l5.8-2.7L12 4.8zm-6 4.4v6.6l5 2.5v-6.6l-5-2.5zm12 0l-5 2.5v6.6l5-2.5V9.2z"/></svg>
        </span>`;
    }
    if (raw.includes('mystery') || raw.includes('unknown')) {
        return `<span class="inline-flex items-center justify-center h-6 w-6 rounded-full bg-[#12508f] text-white shadow-sm border border-[#1d6ec2]" title="${escapeHtml(label)}">
            <span class="font-sans font-extrabold text-xs leading-none">?</span>
        </span>`;
    }
    if (raw.includes('multi')) {
        return `<span class="inline-flex items-center justify-center h-6 w-6 rounded-full bg-[#e68a00] text-white shadow-sm border border-[#ffaa2b]" title="${escapeHtml(label)}">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M3 6h11v9H3V6zm13 3h5v9H10v-2h6V9z"/></svg>
        </span>`;
    }
    if (raw.includes('earth')) {
        return `<span class="inline-flex items-center justify-center h-6 w-6 rounded-full bg-[#146c94] text-[#6ee7b7] shadow-sm border border-[#2295c9]" title="${escapeHtml(label)}">
            <i class="fa-solid fa-earth-americas text-xs"></i>
        </span>`;
    }
    if (raw.includes('event')) {
        return `<span class="inline-flex items-center justify-center h-6 w-6 rounded-full bg-[#c92a2a] text-white shadow-sm border border-[#e03131]" title="${escapeHtml(label)}">
            <i class="fa-solid fa-comment-dots text-[11px]"></i>
        </span>`;
    }
    if (raw.includes('letterbox')) {
        return `<span class="inline-flex items-center justify-center h-6 w-6 rounded-full bg-[#1864ab] text-white shadow-sm border border-[#228be6]" title="${escapeHtml(label)}">
            <i class="fa-solid fa-envelope text-[11px]"></i>
        </span>`;
    }
    if (raw.includes('virtual')) {
        return `<span class="inline-flex items-center justify-center h-6 w-6 rounded-full bg-[#d97706] text-white shadow-sm border border-[#f59e0b]" title="${escapeHtml(label)}">
            <i class="fa-solid fa-ghost text-[11px]"></i>
        </span>`;
    }
    if (raw.includes('wherigo')) {
        return `<span class="inline-flex items-center justify-center h-6 w-6 rounded-full bg-[#0b7285] text-white shadow-sm border border-[#15aabf]" title="${escapeHtml(label)}">
            <i class="fa-solid fa-compass text-xs"></i>
        </span>`;
    }

    return `<span class="inline-flex items-center justify-center h-6 w-6 rounded-full bg-slate-700 text-slate-200 border border-slate-600" title="${escapeHtml(label)}">
        <i class="fa-solid fa-box text-[11px]"></i>
    </span>`;
}

function toggleCopyCell(cellEl) {
    const text = cellEl.getAttribute('data-copy');
    const cellKey = cellEl.getAttribute('data-key');
    const label = cellEl.getAttribute('data-label');
    const highlightClass = cellEl.getAttribute('data-highlight');

    if (!text || text === '-') return;

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
        fallbackCopy(text);
    }

    if (state.copiedCells.has(cellKey)) {
        state.copiedCells.delete(cellKey);
        cellEl.classList.remove(...highlightClass.split(' '));
        showToast(`Unmarked ${label}`);
    } else {
        state.copiedCells.add(cellKey);
        cellEl.classList.add(...highlightClass.split(' '));
        showToast(`Copied ${label}`);
    }
}

function fallbackCopy(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        document.execCommand('copy');
    } catch (err) {
        console.error('Fallback copy failed', err);
    }
    document.body.removeChild(textArea);
}

function showToast(msg) {
    const toast = document.getElementById('copyToast');
    document.getElementById('copyToastText').textContent = msg;
    toast.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-2');
    toast.classList.add('opacity-100', 'translate-y-0');
    setTimeout(() => {
        toast.classList.remove('opacity-100', 'translate-y-0');
        toast.classList.add('opacity-0', 'pointer-events-none', 'translate-y-2');
    }, 2000);
}

function logTo(targetId, msg, type = 'info') {
    const term = document.getElementById(targetId);
    if (!term) return;
    const div = document.createElement('div');
    let color = 'text-slate-300';
    let prefix = 'INF';

    if (type === 'success') { color = 'text-emerald-400'; prefix = 'OK '; }
    else if (type === 'warn') { color = 'text-amber-400'; prefix = 'WRN'; }
    else if (type === 'error') { color = 'text-rose-400'; prefix = 'ERR'; }

    div.className = `flex items-start gap-2 ${color}`;
    div.innerHTML = `<span class="text-slate-600 select-none">${new Date().toLocaleTimeString()}</span><span class="font-bold text-[10px] px-1 rounded bg-slate-900 border border-slate-800 select-none">${prefix}</span><span class="flex-1 break-all">${escapeHtml(msg)}</span>`;
    term.appendChild(div);
    term.scrollTop = term.scrollHeight;
}

function log(msg, type = 'info') { logTo('terminalOutput', msg, type); }
function logPgc(msg, type = 'info') { logTo('pgcTerminalOutput', msg, type); }

function setStatus(status) {
    const dot = document.getElementById('statusDot');
    document.getElementById('statusText').textContent = status;
    dot.className = status === 'RUNNING' ? "inline-block h-2 w-2 rounded-full bg-indigo-500 animate-ping mr-1.5" :
                    status === 'SUCCESS' ? "inline-block h-2 w-2 rounded-full bg-emerald-500 mr-1.5" :
                    status === 'ERROR' ? "inline-block h-2 w-2 rounded-full bg-rose-500 mr-1.5" : "inline-block h-2 w-2 rounded-full bg-slate-500 mr-1.5";
}

function switchTab(tabId, btn) {
    state.activeTab = tabId;
    document.querySelectorAll('.tab-view').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.remove('bg-slate-800', 'text-white');
        b.classList.add('text-slate-400');
    });
    document.getElementById(tabId).classList.remove('hidden');
    if (btn) {
        btn.classList.add('bg-slate-800', 'text-white');
        btn.classList.remove('text-slate-400');
    }
}

function exportJSON() {
    const isArchivedView = (state.activeTab === 'archivedResultTab' || state.activeTab === 'archivedConfigTab');
    const onlyAfterArchive = document.getElementById('onlyFoundAfterArchiveToggle')?.checked;
    const listToExport = isArchivedView
        ? (onlyAfterArchive ? state.archivedCaches.filter(c => c.foundAfterArchive) : state.archivedCaches)
        : state.caches;

    if (!listToExport.length) return alert('No caches available in this list to export.');
    const prefix = isArchivedView ? 'archived_geocaches' : 'filter_geocaches';
    const blob = new Blob([JSON.stringify(listToExport, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${prefix}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
}