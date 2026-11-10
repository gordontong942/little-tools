import os
import requests
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

# 允許目標域
ALLOWED_HOSTS = {"www.geocaching.com", "geocaching.com"}


def create_authenticated_session(cookie_str):
  """建立並初始化帶有完整 Cookie 宣告的 requests.Session"""
  session = requests.Session()
  session.headers.update({
      "User-Agent": (
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML,"
          " like Gecko) Chrome/120.0.0.0 Safari/537.36"
      ),
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
  })

  # 解析並寫入 Cookie jar (支援多欄位如 gspkauth, gspk 等)
  if cookie_str:
    for item in cookie_str.split(";"):
      if "=" in item:
        name, val = item.strip().split("=", 1)
        session.cookies.set(name, val, domain=".geocaching.com", path="/")

  return session


@app.route("/")
def index():
  return render_template("index.html")


@app.route("/api/proxy", methods=["POST"])
def proxy_request():
  """通用後端代理 API：由 Python 統一發起請求，自動附帶 Cookie"""
  data = request.json or {}
  endpoint = data.get("endpoint")
  cookie_str = data.get("cookie", "")

  if not endpoint:
    return jsonify({"error": "Missing endpoint parameter"}), 400

  # 確保完整 URL
  if endpoint.startswith("/"):
    target_url = f"https://www.geocaching.com{endpoint}"
  else:
    target_url = endpoint

  session = create_authenticated_session(cookie_str)

  try:
    # 執行伺服器端請求
    resp = session.get(target_url, timeout=15, allow_redirects=True)

    # 檢查是否被重定向到登入頁
    if "/account/signin" in resp.url or resp.status_code == 401:
      return (
          jsonify({
              "error": (
                  "Authentication Failed: Session expired or redirected to"
                  " sign-in."
              ),
              "status": resp.status_code,
              "url": resp.url,
          }),
          401,
      )

    # 嘗試回傳 JSON 或 Text
    content_type = resp.headers.get("Content-Type", "")
    if "application/json" in content_type:
      return jsonify(resp.json()), resp.status_code
    else:
      return (
          jsonify({"html": resp.text, "status": resp.status_code}),
          resp.status_code,
      )

  except Exception as e:
    return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
  port = int(os.environ.get("PORT", 5000))
  app.run(host="0.0.0.0", port=port, debug=True)