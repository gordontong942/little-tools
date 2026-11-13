import concurrent.futures
import html as html_lib
import json
import os
import re
from flask import Flask, jsonify, render_template, request
import requests
from requests.adapters import HTTPAdapter

app = Flask(__name__)


def create_authenticated_session(cookie_str, pool_size=20):
    session = requests.Session()
    adapter = HTTPAdapter(pool_connections=pool_size, pool_maxsize=pool_size)
    session.mount('https://', adapter)
    session.mount('http://', adapter)

    session.headers.update({
        'User-Agent': (
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML,'
            ' like Gecko) Chrome/124.0.0.0 Safari/537.36'
        ),
        'Accept': (
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        ),
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.geocaching.com/play/map',
    })

    if cookie_str:
        for item in cookie_str.split(';'):
            if '=' in item:
                name, val = item.strip().split('=', 1)
                session.cookies.set(name, val, domain='.geocaching.com', path='/')

    return session


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


@app.route('/api/enrich', methods=['POST'])
def enrich_caches():
    data = request.json or {}
    raw_limit = data.get('limit', -1)
    gc_codes = data.get('gc_codes', [])

    if raw_limit is not None and int(raw_limit) > 0:
        gc_codes = gc_codes[: int(raw_limit)]

    cookie_str = data.get('cookie', '')

    if not gc_codes:
        return jsonify({}), 200

    session = create_authenticated_session(cookie_str, pool_size=20)

    def fetch_cache_details(code):
        url = f'https://www.geocaching.com/geocache/{code}'
        try:
            resp = session.get(url, timeout=10)
            if resp.status_code == 200:
                page_html = resp.text

                personal_note = ''
                has_found = False
                is_owner = False
                found_date = ''
                owner_name = ''

                # 1. Parse Owner Name
                owner_match = re.search(
                    r'id="ctl00_ContentBody_m_PlacedBy"[^>]*>(.*?)</span>',
                    page_html,
                    re.DOTALL,
                ) or re.search(
                    r'class="owner-name"[^>]*>(.*?)</span>', page_html, re.DOTALL
                )
                if owner_match:
                    owner_name = html_lib.unescape(
                        re.sub(r'<[^>]+>', '', owner_match.group(1))
                    ).strip()

                if (
                    'uxOwnerOptions' in page_html
                    or 'You own this' in page_html
                    or 'ctl00_ContentBody_OwnerOptions' in page_html
                    or owner_name.lower() == 'gordon942'
                ):
                    is_owner = True

                # 2. Parse Personal Note & unescape HTML entities (e.g. &#10; -> \n)
                note_match = (
                    re.search(
                        r'<div[^>]*id="srOnlyCacheNote"[^>]*>(.*?)</div>',
                        page_html,
                        re.DOTALL,
                    )
                    or re.search(
                        r'<button[^>]*id="viewCacheNote"[^>]*><span[^>]*>(.*?)</span></button>',
                        page_html,
                        re.DOTALL,
                    )
                    or re.search(
                        r'<textarea[^>]*id="cacheNoteText"[^>]*>(.*?)</textarea>',
                        page_html,
                        re.DOTALL,
                    )
                    or re.search(r'"personalNote"\s*:\s*"([^"]+)"', page_html)
                )
                if note_match:
                    raw_note = note_match.group(1).strip()
                    raw_note = raw_note.replace('\\r\\n', '\n').replace('\\n', '\n')
                    raw_note = raw_note.replace('\\"', '"')
                    personal_note = html_lib.unescape(raw_note).strip()
                    if personal_note in [
                        'Click to enter a note',
                        'Add a personal geocache note.',
                    ]:
                        personal_note = ''

                # 3. Parse User's Own Found Status
                nav_status_match = re.search(
                    r'id="ctl00_ContentBody_GeoNav_foundStatus"[^>]*>(.*?)</(?:div|span|p|strong)>',
                    page_html,
                    re.DOTALL | re.I,
                )
                if nav_status_match and re.search(
                    r'Found It|You found', nav_status_match.group(1), re.I
                ):
                    has_found = True

                if re.search(
                    r'id="ctl00_ContentBody_GeoNav_logText"[^>]*>\s*Found It!',
                    page_html,
                    re.I,
                ):
                    has_found = True

                # 4. Parse Found Date from user's own GeoNav status block
                if nav_status_match:
                    nav_date_match = re.search(
                        r'([0-9]{2}/[A-Za-z]{3}/[0-9]{4}|\d{4}-\d{2}-\d{2})',
                        nav_status_match.group(1),
                    )
                    if nav_date_match:
                        found_date = nav_date_match.group(1)

                if not found_date and has_found:
                    log_date_match = re.search(
                        r'Logged on:\s*([0-9]{2}/[A-Za-z]{3}/[0-9]{4}|\d{4}-\d{2}-\d{2})',
                        page_html,
                        re.I,
                    )
                    if log_date_match:
                        found_date = log_date_match.group(1)

                # 5. Authoritative check via userUserData JSON embedded in page
                user_data_match = re.search(
                    r'"userUserData"\s*:\s*(\{.*?\})\s*,\s*"', page_html
                )
                if user_data_match:
                    try:
                        ud = json.loads(user_data_match.group(1))
                        if 'hasFound' in ud:
                            has_found = bool(ud['hasFound'])
                        if 'isOwner' in ud and ud['isOwner']:
                            is_owner = True
                        if not found_date and ud.get('foundDate'):
                            found_date = ud.get('foundDate', '')
                        if not personal_note and ud.get('personalNote'):
                            personal_note = html_lib.unescape(
                                str(ud.get('personalNote', ''))
                            ).strip()
                    except Exception:
                        pass

                return {
                    'code': code,
                    'ownerName': owner_name,
                    'personalNote': personal_note,
                    'hasFound': has_found,
                    'isOwner': is_owner,
                    'foundDate': found_date,
                }
        except Exception as e:
            print(f'Error enriching {code}: {e}')

        return {
            'code': code,
            'ownerName': '',
            'personalNote': '',
            'hasFound': False,
            'isOwner': False,
        }

    enriched_results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=15) as executor:
        futures = [
            executor.submit(fetch_cache_details, code) for code in gc_codes
        ]
        for future in concurrent.futures.as_completed(futures):
            res = future.result()
            enriched_results[res['code']] = res

    return jsonify(enriched_results)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=True)
