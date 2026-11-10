import concurrent.futures
import json
import os
import re
import requests
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)


def create_authenticated_session(cookie_str):
  session = requests.Session()
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
  session = create_authenticated_session(cookie_str)

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
  limit = int(data.get('limit', 20))
  gc_codes = data.get('gc_codes', [])[:limit]
  cookie_str = data.get('cookie', '')

  if not gc_codes:
    return jsonify({}), 200

  session = create_authenticated_session(cookie_str)

  def fetch_cache_details(code):
    url = f'https://www.geocaching.com/geocache/{code}'
    try:
      resp = session.get(url, timeout=12)
      if resp.status_code == 200:
        html = resp.text

        personal_note = ''
        has_found = False
        is_owner = False
        found_date = ''
        owner_name = ''

        # 1. Parse Owner Name
        owner_match = re.search(
            r'id="ctl00_ContentBody_m_PlacedBy"[^>]*>(.*?)</span>',
            html,
            re.DOTALL,
        ) or re.search(
            r'class="owner-name"[^>]*>(.*?)</span>', html, re.DOTALL
        )
        if owner_match:
          owner_name = re.sub(r'<[^>]+>', '', owner_match.group(1)).strip()

        if (
            'uxOwnerOptions' in html
            or 'You own this' in html
            or 'ctl00_ContentBody_OwnerOptions' in html
            or owner_name.lower() == 'gordon942'
        ):
          is_owner = True

        # 2. Parse Personal Note
        note_match = (
            re.search(
                r'<div[^>]*id="srOnlyCacheNote"[^>]*>(.*?)</div>', html, re.DOTALL
            )
            or re.search(
                r'<button[^>]*id="viewCacheNote"[^>]*><span[^>]*>(.*?)</span></button>',
                html,
                re.DOTALL,
            )
            or re.search(
                r'<textarea[^>]*id="cacheNoteText"[^>]*>(.*?)</textarea>',
                html,
                re.DOTALL,
            )
            or re.search(r'"personalNote"\s*:\s*"([^"]+)"', html)
        )
        if note_match:
          personal_note = (
              note_match.group(1)
              .strip()
              .replace('\\n', ' ')
              .replace('\\"', '"')
          )
          if personal_note in [
              'Click to enter a note',
              'Add a personal geocache note.',
          ]:
            personal_note = ''

        # 3. Parse Found Status & Log Date
        if (
            'ctl00_ContentBody_GeoNav_foundStatus' in html
            or 'Found It!' in html
            or 'Found it' in html
        ):
          has_found = True

        log_date_match = re.search(
            r'Logged on:\s*([0-9]{2}/[A-Za-z]{3}/[0-9]{4}|\d{4}-\d{2}-\d{2})',
            html,
            re.I,
        ) or re.search(
            r'class="LogDate"[^>]*>([0-9]{2}/[A-Za-z]{3}/[0-9]{4}|\d{4}-\d{2}-\d{2})</span>',
            html,
            re.I,
        )
        if log_date_match:
          found_date = log_date_match.group(1)

        # 4. Fallback search for userUserData script object
        user_data_match = re.search(
            r'"userUserData"\s*:\s*(\{.*?\})\s*,\s*"', html
        )
        if user_data_match:
          try:
            ud = json.loads(user_data_match.group(1))
            if not has_found:
              has_found = ud.get('hasFound', False)
            if not is_owner:
              is_owner = ud.get('isOwner', False)
            if not found_date:
              found_date = ud.get('foundDate', '')
            if not personal_note:
              personal_note = ud.get('personalNote', '')
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
  with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
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