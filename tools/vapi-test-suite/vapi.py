"""Minimal Vapi REST helper for the test suite (stdlib only).

The API key is read from the VAPI_API_KEY environment variable, or, failing that, from the single
`VAPI_API_KEY=` line of the repo's .env. It is never printed, logged or written to disk.
"""
import json
import os
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(HERE, "out")  # generated files (targets, ids, raw runs); gitignored
BASE = "https://api.vapi.ai"


def _key():
    key = os.environ.get("VAPI_API_KEY")
    if key:
        return key.strip()
    env_path = os.path.join(REPO, ".env")
    if os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as handle:
            for line in handle:  # extract ONE variable; never source the whole file (it holds other secrets)
                if line.startswith("VAPI_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("VAPI_API_KEY is not set (environment or .env)")


def api(method, path, body=None, headers=None, timeout=120):
    """Returns (status, parsed_json_or_text). Raises on network errors (callers decide about retries)."""
    # api.vapi.ai answers 403 to Python's default User-Agent, so send an explicit one.
    all_headers = {"Authorization": "Bearer " + _key(), "Content-Type": "application/json", "User-Agent": "curl/8.5.0"}
    all_headers.update(headers or {})
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(BASE + path, method=method, headers=all_headers, data=data)
    try:
        response = urllib.request.urlopen(request, timeout=timeout)
        raw = response.read()
        return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode(errors="replace")[:1500]


def safe_api(method, path, body=None, headers=None, timeout=120):
    """Like api() but converts network errors (timeouts) into a (599, message) tuple."""
    try:
        return api(method, path, body, headers, timeout)
    except Exception as exc:  # noqa: BLE001 - report and continue; never blind-retry a POST
        return 599, "%s: %s" % (type(exc).__name__, exc)


def list_all(path, page_size=100):
    """Every item of a paginated list endpoint."""
    items, page = [], 1
    while True:
        status, result = safe_api("GET", "%s?limit=%d&page=%d" % (path, page_size, page))
        if status >= 300:
            return items
        items += result["results"]
        if len(result["results"]) < page_size:
            return items
        page += 1
