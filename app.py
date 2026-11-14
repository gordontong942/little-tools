import concurrent.futures
from datetime import datetime, timezone
import html as html_lib
import json
import os
import re
from flask import Flask, jsonify, render_template, request
import requests
from requests.adapters import HTTPAdapter

app = Flask(__name__)

WPT_TYPE_MAP = {
    2: 'Traditional',
    3: 'Multi-cache',
    4: 'Virtual',
    5: 'Letterbox Hybrid',
    6: 'Event',
    8: 'Mystery',
    9: 'Project APE',
    11: 'Webcam',
    12: 'Locationless',
    13: 'CITO',
    137: 'Earthcache',
    453: 'Mega-Event',
    1304: 'GPS Adventures Exhibit',
    1858: 'Wherigo',
    3653: 'Lost and Found Event',
    3773: 'Geocaching HQ',
    3774: 'Geocaching HQ Celebration',
    4738: 'Geocaching HQ Block Party',
    7005: 'Giga-Event',
}


def create_authenticated_session(
    cookie_str,
    domain='.geocaching.com',
    referer='https://www.geocaching.com/play/map',
    pool_size=20,
):
    session = requests.Session()
    adapter = HTTPAdapter(pool_connections=pool_size, pool_maxsize=pool_size)
    session.mount('https://', adapter)
    session.mount('http://', adapter)

    session.headers.update({
        'User-Agent': (
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            ' (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        ),
        'Accept': (
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        ),
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': referer,
    })

    if cookie_str:
        for item in cookie_str.split(';'):
            if '=' in item:
                name, val = item.strip().split('=', 1)
                session.cookies.set(name, val, domain=domain, path='/')

    return session


def parse_gc_date(raw_str):
    if not raw_str:
        return None
    s = str(raw_str).strip()

    epoch_match = re.search(r'/Date\((-?\d+)', s)
    if epoch_match:
        try:
            ms = int(epoch_match.group(1))
            return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).replace(tzinfo=None)
        except Exception:
            pass

    iso_match = re.match(r'^(\d{4}-\d{2}-\d{2})', s)
    if iso_match:
        try:
            return datetime.strptime(iso_match.group(1), '%Y-%m-%d')
        except Exception:
            pass

    for fmt in ('%m/%d/%Y', '%d/%b/%Y', '%Y/%m/%d', '%b %d, %Y', '%d %b %Y'):
        try:
            return datetime.strptime(s, fmt)
        except Exception:
            continue
    return None


def parse_ddm_to_decimal(ddm_str):
    if not ddm_str:
        return None, None
    m = re.search(
        r'([NS])\s*(\d{1,2})°\s*([0-9.]+)\s+([EW])\s*(\d{1,3})°\s*([0-9.]+)',
        ddm_str,
        re.I,
    )
    if not m:
        return None, None
    lat = int(m.group(2)) + float(m.group(3)) / 60.0
    if m.group(1).upper() == 'S':
        lat = -lat
    lng = int(m.group(5)) + float(m.group(6)) / 60.0
    if m.group(4).upper() == 'W':
        lng = -lng
    return round(lat, 6), round(lng, 6)


def classify_logbook_entry(entry):
    if not isinstance(entry, dict):
        return None

    lt_id = entry.get('LogTypeID') or entry.get('LogTypeId') or entry.get('logTypeId')
    if lt_id == 5 or str(lt_id) == '5':
        return 'archive'
    if lt_id == 2 or str(lt_id) == '2':
        return 'found'

    lt_str = str(entry.get('LogType') or '').strip().lower()
    if lt_str in ('archive', 'archived'):
        return 'archive'
    if lt_str == 'found it':
        return 'found'

    return None


def extract_log_dates_from_page(page_html, session=None, code=''):
    last_found_dt = None
    last_found_str = ''
    archive_dt = None
    archive_str = ''

    token_match = re.search(r"userToken\s*=\s*'([^']+)'", page_html) or re.search(
        r'"userToken"\s*:\s*"([^"]+)"', page_html
    )
    if not token_match or session is None:
        return '', '', False

    try:
        lb_url = (
            f'https://www.geocaching.com/seek/geocache.logbook'
            f'?tkn={token_match.group(1)}&idx=1&num=50&decrypt=false'
        )
        lb_resp = session.get(
            lb_url,
            headers={
                'Accept': 'application/json',
                'Referer': f'https://www.geocaching.com/geocache/{code}',
                'X-Requested-With': 'XMLHttpRequest',
            },
            timeout=10,
        )
        if lb_resp.status_code != 200:
            return '', '', False

        lb_json = lb_resp.json()
        entries = lb_json.get('data', []) if isinstance(lb_json, dict) else []

        for entry in entries:
            kind = classify_logbook_entry(entry)
            if not kind:
                continue

            visited_raw = entry.get('Visited') or entry.get('Created') or ''
            dt = parse_gc_date(visited_raw)
            if not dt:
                continue

            formatted = dt.strftime('%Y-%m-%d')
            if kind == 'archive':
                if archive_dt is None or dt > archive_dt:
                    archive_dt = dt
                    archive_str = formatted
            elif kind == 'found':
                if last_found_dt is None or dt > last_found_dt:
                    last_found_dt = dt
                    last_found_str = formatted

    except Exception as exc:
        print(f'Error fetching logbook for {code}: {exc}')

    found_after_archive = bool(
        last_found_dt is not None
        and archive_dt is not None
        and last_found_dt > archive_dt
    )

    return last_found_str, archive_str, found_after_archive


def normalize_cache_type(raw_type):
    if not raw_type:
        return 'Traditional'
    ct_lower = str(raw_type).lower()
    if 'traditional' in ct_lower:
        return 'Traditional'
    if 'unknown' in ct_lower or 'mystery' in ct_lower:
        return 'Mystery'
    if 'multi' in ct_lower:
        return 'Multi-cache'
    if 'earth' in ct_lower:
        return 'Earthcache'
    if 'virtual' in ct_lower:
        return 'Virtual'
    if 'letterbox' in ct_lower:
        return 'Letterbox Hybrid'
    if 'wherigo' in ct_lower:
        return 'Wherigo'
    if 'webcam' in ct_lower:
        return 'Webcam'
    if 'cito' in ct_lower:
        return 'CITO'
    if 'mega' in ct_lower:
        return 'Mega-Event'
    if 'giga' in ct_lower:
        return 'Giga-Event'
    if 'event' in ct_lower:
        return 'Event'
    return str(raw_type).strip()


def clean_note_text(raw_html):
    if not raw_html:
        return ''
    with_newlines = re.sub(r'<(?:br|/p|/div|/li)[^>]*>', '\n', str(raw_html), flags=re.I)
    stripped = re.sub(r'<[^>]+>', '', with_newlines)
    unescaped = html_lib.unescape(stripped)
    lines = [re.sub(r'[ \t]+', ' ', line).strip() for line in unescaped.splitlines()]
    cleaned = '\n'.join(line for line in lines if line).strip()
    if cleaned in ('Click to enter a note', 'Add a personal geocache note.', 'No personal note'):
        return ''
    return cleaned


def extract_full_html_metadata(page_html):
    name = ''
    owner = ''
    c_type = 'Traditional'
    diff = '-'
    terr = '-'
    lat = None
    lng = None
    is_corr = False
    note = ''
    has_found = False

    name_m = (
        re.search(r'id=["\']ctl00_ContentBody_CacheName["\'][^>]*>(.*?)</span>', page_html, re.DOTALL | re.I)
        or re.search(r'<h1[^>]*class=["\'][^"\']*sr-only[^"\']*["\'][^>]*>(.*?)</h1>', page_html, re.DOTALL | re.I)
        or re.search(r'<title>(.*?)(?:\s*-\s*Geocaching|\s*\|\s*Geocaching)</title>', page_html, re.I)
    )
    if name_m:
        clean = re.sub(r'<[^>]+>', '', name_m.group(1))
        clean = re.sub(r'^GC[A-Z0-9]+\s*[-–:]\s*', '', clean).strip()
        name = html_lib.unescape(clean)

    owner_m = (
        re.search(r'id=["\']ctl00_ContentBody_mcd1["\'][^>]*>.*?<a[^>]*>(.*?)</a>', page_html, re.DOTALL | re.I)
        or re.search(r'id=["\']ctl00_ContentBody_m_PlacedBy["\'][^>]*>(.*?)</span>', page_html, re.DOTALL | re.I)
    )
    if owner_m:
        owner = html_lib.unescape(re.sub(r'<[^>]+>', '', owner_m.group(1))).strip()

    type_m = (
        re.search(r'class=["\'][^"\']*cacheImage[^"\']*["\'][^>]*title=["\']([^"\']+)["\']', page_html, re.I)
        or re.search(r'href=["\'][^"\']*cache_types\.aspx[^"\']*["\'][^>]*title=["\']([^"\']+)["\']', page_html, re.I)
        or re.search(r'/images/WptTypes/(?:sm/)?(\d+)\.(?:gif|png|svg)', page_html, re.I)
    )
    if type_m:
        if type_m.lastindex == 1 and type_m.group(1).isdigit():
            c_type = WPT_TYPE_MAP.get(int(type_m.group(1)), 'Traditional')
        else:
            c_type = html_lib.unescape(type_m.group(1)).strip()

    diff_m = re.search(r'id=["\']ctl00_ContentBody_uxLegendScale["\'][^>]*>.*?alt=["\']([0-9.]+)\s+out of', page_html, re.DOTALL | re.I)
    if diff_m:
        diff = diff_m.group(1)

    terr_m = re.search(r'id=["\']ctl00_ContentBody_Localize12["\'][^>]*>.*?alt=["\']([0-9.]+)\s+out of', page_html, re.DOTALL | re.I)
    if terr_m:
        terr = terr_m.group(1)

    udc_block = re.search(r'userDefinedCoords\s*=\s*(\{.*?\});', page_html, re.DOTALL)
    if udc_block:
        try:
            udc_data = json.loads(udc_block.group(1)).get('data') or {}
            if udc_data.get('isUserDefined') and isinstance(udc_data.get('newLatLng'), list):
                lat = float(udc_data['newLatLng'][0])
                lng = float(udc_data['newLatLng'][1])
                is_corr = True
        except Exception:
            pass

    if lat is None or lng is None:
        map_ll = re.search(r'mapLatLng\s*=\s*\{\s*"?lat"?\s*:\s*([-0-9.]+)\s*,\s*"?lng"?\s*:\s*([-0-9.]+)', page_html)
        if map_ll:
            lat = float(map_ll.group(1))
            lng = float(map_ll.group(2))

    if lat is None or lng is None:
        ux_latlon = re.search(r'id=["\']uxLatLon["\'][^>]*>(.*?)</span>', page_html, re.DOTALL | re.I)
        if ux_latlon:
            ddm_text = html_lib.unescape(re.sub(r'<[^>]+>', '', ux_latlon.group(1))).strip()
            lat, lng = parse_ddm_to_decimal(ddm_text)

    note_m = (
        re.search(r'id=["\']srOnlyCacheNote["\'][^>]*>(.*?)</(?:div|span|p|section)>', page_html, re.DOTALL | re.I)
        or re.search(r'id=["\']cache_note["\'][^>]*>(.*?)</(?:div|span|p|section)>', page_html, re.DOTALL | re.I)
    )
    if note_m:
        note = clean_note_text(note_m.group(1))

    if (
        '"isUserFound":true' in page_html
        or '"hasFound":true' in page_html
        or 'id="ctl00_ContentBody_LoggedItImage"' in page_html
        or 'class="found-status"' in page_html
    ):
        has_found = True

    return {
        'name': name,
        'ownerName': owner,
        'type': normalize_cache_type(c_type),
        'difficulty': diff,
        'terrain': terr,
        'lat': lat,
        'lng': lng,
        'isCorrected': is_corr,
        'personalNote': note,
        'hasFound': has_found,
    }


def fetch_search_v2_metadata(session, code):
    search_url = 'https://www.geocaching.com/api/proxy/web/search/v2'
    params = {
        'q': f'code:{code}',
        'take': 1,
        'skip': 0,
        'fields': (
            'code,name,type,geocacheType,difficulty,terrain,'
            'owner,placedBy,postedCoordinates,userData,status'
        ),
    }
    try:
        resp = session.get(
            search_url,
            params=params,
            headers={'Accept': 'application/json'},
            timeout=10,
        )
        if resp.status_code != 200:
            return None

        payload = resp.json()
        results = payload.get('results', []) if isinstance(payload, dict) else []
        if not results:
            return None

        item = results[0]
        user_data = item.get('userData') or {}
        posted = item.get('postedCoordinates') or {}
        corrected = user_data.get('correctedCoordinates') or {}

        lat = None
        lng = None
        is_corrected = False

        if corrected.get('latitude') is not None and corrected.get('longitude') is not None:
            lat = float(corrected['latitude'])
            lng = float(corrected['longitude'])
            is_corrected = True
        elif posted.get('latitude') is not None and posted.get('longitude') is not None:
            lat = float(posted['latitude'])
            lng = float(posted['longitude'])

        raw_note = user_data.get('note') or user_data.get('personalNote') or ''
        personal_note = clean_note_text(raw_note)

        owner_obj = item.get('owner') or {}
        owner_name = owner_obj.get('username') or item.get('placedBy') or ''

        gt = item.get('geocacheType')
        cache_type = item.get('type') or ''
        if isinstance(gt, dict):
            cache_type = gt.get('name') or WPT_TYPE_MAP.get(gt.get('id'), cache_type)
        elif isinstance(gt, int):
            cache_type = WPT_TYPE_MAP.get(gt, cache_type)

        has_found = bool(
            user_data.get('isFound')
            or user_data.get('hasFound')
            or user_data.get('foundDate')
        )
        is_owned = bool(
            user_data.get('isOwned')
            or user_data.get('isOwner')
        )

        return {
            'name': item.get('name') or '',
            'ownerName': str(owner_name).strip(),
            'type': normalize_cache_type(cache_type),
            'difficulty': str(item.get('difficulty') or '-'),
            'terrain': str(item.get('terrain') or '-'),
            'lat': lat,
            'lng': lng,
            'isCorrected': is_corrected,
            'personalNote': personal_note,
            'hasFound': has_found,
            'isOwned': is_owned,
            'foundDate': str(user_data.get('foundDate') or ''),
            'status': item.get('status'),
        }
    except Exception as exc:
        print(f'Search v2 lookup failed for {code}: {exc}')
        return None


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/proxy', methods=['POST'])
def proxy_request():
    data = request.json or {}
    endpoint = data.get('endpoint')
    cookie_str = data.get('cookie', '')

    if not endpoint:
        return jsonify({'error': 'Missing endpoint parameter'}), 400

    target_url = (
        f'https://www.geocaching.com{endpoint}'
        if endpoint.startswith('/')
        else endpoint
    )
    session = create_authenticated_session(cookie_str, pool_size=5)

    try:
        resp = session.get(target_url, timeout=15, allow_redirects=True)

        if '/account/signin' in resp.url or resp.status_code == 401:
            return (
                jsonify({
                    'error': (
                        'Authentication Failed: Session expired or redirected to'
                        ' sign-in page.'
                    ),
                    'status': resp.status_code,
                    'url': resp.url,
                }),
                401,
            )

        content_type = resp.headers.get('Content-Type', '')
        if 'application/json' in content_type:
            return jsonify(resp.json()), resp.status_code
        else:
            return (
                jsonify({'html': resp.text, 'status': resp.status_code}),
                resp.status_code,
            )

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/projectgc', methods=['POST'])
def fetch_projectgc_archived():
    data = request.json or {}
    pgc_url = data.get('url', '').strip()
    pgc_cookie = data.get('cookie', '').strip()

    if not pgc_url:
        return jsonify({'error': 'Missing Project-GC URL'}), 400

    session = create_authenticated_session(
        pgc_cookie,
        domain='.project-gc.com',
        referer='https://project-gc.com/Tools/MapCompare',
        pool_size=5,
    )

    try:
        resp = session.get(pgc_url, timeout=25, allow_redirects=True)
        if resp.status_code != 200:
            return (
                jsonify({'error': f'Project-GC returned HTTP {resp.status_code}'}),
                resp.status_code,
            )

        page_html = resp.text

        tab_match = re.search(
            r'id=["\']myTabContent["\'][^>]*>(.*)',
            page_html,
            re.DOTALL | re.I,
        )
        search_scope = tab_match.group(1) if tab_match else page_html

        cell_matches = re.findall(
            r'tabulator-field=["\']gccode["\'][^>]*>(.*?)</div',
            search_scope,
            re.DOTALL | re.I,
        )

        gc_codes = []
        seen = set()

        for cell_html in cell_matches:
            clean_text = re.sub(r'<[^>]+>', '', cell_html).strip()
            code_match = re.search(r'\b(GC[A-Z0-9]+)\b', clean_text, re.I)
            if code_match:
                code = code_match.group(1).upper()
                if code not in seen:
                    seen.add(code)
                    gc_codes.append(code)

        if not gc_codes:
            json_matches = re.findall(
                r'["\']gccode["\']\s*:\s*["\'](GC[A-Z0-9]+)["\']',
                search_scope,
                re.I,
            )
            for code in json_matches:
                code_up = code.upper()
                if code_up not in seen:
                    seen.add(code_up)
                    gc_codes.append(code_up)

        return jsonify({
            'gc_codes': gc_codes,
            'count': len(gc_codes),
            'found_myTabContent': bool(tab_match),
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/enrich', methods=['POST'])
def enrich_caches():
    data = request.json or {}
    raw_limit = data.get('limit', 100)
    gc_codes = data.get('gc_codes', [])
    archived_only = bool(data.get('archived_only', False))
    active_user = str(data.get('username') or 'gordon942').strip().lower()

    if raw_limit is not None and int(raw_limit) > 0:
        gc_codes = gc_codes[: int(raw_limit)]

    cookie_str = data.get('cookie', '')

    if not gc_codes:
        return jsonify({}), 200

    session = create_authenticated_session(cookie_str, pool_size=20)

    def fetch_cache_details(code):
        url = f'https://www.geocaching.com/geocache/{code}'
        try:
            v2_meta = fetch_search_v2_metadata(session, code) or {}

            resp = session.get(url, timeout=10)
            page_html = resp.text if resp.status_code == 200 else ''

            html_meta = extract_full_html_metadata(page_html) if page_html else {}
            last_found_date, archive_date, found_after_archive = (
                extract_log_dates_from_page(page_html, session=session, code=code)
                if page_html
                else ('', '', False)
            )

            is_truly_archived = False
            if archive_date:
                is_truly_archived = True
            elif (
                'This cache has been archived' in page_html
                or 'class="OldWarning"' in page_html
                or '"isArchived":true' in page_html
            ):
                is_truly_archived = True
            elif v2_meta and v2_meta.get('status') == 3:
                is_truly_archived = True

            if archived_only and not is_truly_archived:
                return None

            meta = {}
            for key in (
                'name',
                'ownerName',
                'type',
                'difficulty',
                'terrain',
                'lat',
                'lng',
                'isCorrected',
                'personalNote',
                'hasFound',
                'foundDate',
            ):
                html_val = html_meta.get(key)
                if html_val is not None and html_val != '' and html_val != '-':
                    meta[key] = html_val
                else:
                    meta[key] = v2_meta.get(key)

            if not meta.get('name') and v2_meta.get('name'):
                meta['name'] = v2_meta['name']
            if not meta.get('ownerName') and v2_meta.get('ownerName'):
                meta['ownerName'] = v2_meta['ownerName']
            if (not meta.get('difficulty') or meta.get('difficulty') == '-') and v2_meta.get('difficulty'):
                meta['difficulty'] = v2_meta['difficulty']
            if (not meta.get('terrain') or meta.get('terrain') == '-') and v2_meta.get('terrain'):
                meta['terrain'] = v2_meta['terrain']
            if meta.get('lat') is None and v2_meta.get('lat') is not None:
                meta['lat'] = v2_meta['lat']
                meta['lng'] = v2_meta['lng']
                meta['isCorrected'] = v2_meta['isCorrected']
            if not meta.get('personalNote') and v2_meta.get('personalNote'):
                meta['personalNote'] = v2_meta['personalNote']

            owner_name = meta.get('ownerName', '')
            is_owner = bool(
                (owner_name and owner_name.lower() == active_user)
                or v2_meta.get('isOwned')
                or 'uxOwnerOptions' in page_html
                or 'You own this' in page_html
            )

            has_found = bool(
                meta.get('hasFound')
                or v2_meta.get('hasFound')
                or last_found_date
            )

            return {
                'code': code,
                'name': meta.get('name', code),
                'type': meta.get('type', 'Traditional'),
                'difficulty': meta.get('difficulty', '-'),
                'terrain': meta.get('terrain', '-'),
                'lat': meta.get('lat'),
                'lng': meta.get('lng'),
                'isCorrected': bool(meta.get('isCorrected')),
                'ownerName': owner_name,
                'personalNote': meta.get('personalNote') or '',
                'hasFound': has_found,
                'isOwner': is_owner,
                'isArchived': is_truly_archived,
                'foundDate': meta.get('foundDate', v2_meta.get('foundDate', '')),
                'lastFoundDate': last_found_date,
                'archiveDate': archive_date,
                'foundAfterArchive': found_after_archive,
            }
        except Exception as e:
            print(f'Error enriching {code}: {e}')
            return None

    enriched_results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=15) as executor:
        futures = [
            executor.submit(fetch_cache_details, code) for code in gc_codes
        ]
        for future in concurrent.futures.as_completed(futures):
            res = future.result()
            if res is not None:
                enriched_results[res['code']] = res

    return jsonify(enriched_results)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=True)