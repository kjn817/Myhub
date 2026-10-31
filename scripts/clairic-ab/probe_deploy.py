#!/usr/bin/env python3
"""Deploy the Clairic A/B scratch probe Worker (isolated, deleted after use).

Creates workers script `clairic-ab-probe-20261028` via the Cloudflare API
(same PUT pattern as the RSS probe track), enables its workers.dev
subdomain, and waits for /health. The probe key is generated fresh, kept
in /tmp only (never committed), and embedded into the uploaded JS in
memory — the file scripts/clairic-ab/probe-worker.js is never modified.

Usage:
  python3 scripts/clairic-ab/probe_deploy.py
  -> prints the probe URL; key is saved to /tmp/clairic-ab-probe-key
"""
from __future__ import annotations

import json
import secrets
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / ".scratch"))
from cfapi import call, put_script  # noqa: E402

NAME = "clairic-ab-probe-20261028"
KEY_FILE = Path("/tmp/clairic-ab-probe-key")
WORKER_JS = Path(__file__).resolve().parent / "probe-worker.js"


def main() -> int:
    # Reuse the existing key across redeploys: a fresh key per PUT would
    # 401 the first calls until the new version propagates to all edges.
    if KEY_FILE.exists():
        key = KEY_FILE.read_text(encoding="utf-8").strip()
    else:
        key = secrets.token_hex(16)
    js = WORKER_JS.read_text(encoding="utf-8")
    # PROBE_KEY is a placeholder replaced in memory only (all occurrences).
    assert js.count("PROBE_KEY") >= 1, "probe-worker.js PROBE_KEY placeholder missing"
    js = js.replace("PROBE_KEY", json.dumps(key))
    metadata = {
        "main_module": "index.js",
        "compatibility_date": "2026-10-01",
        "bindings": [{"type": "ai", "name": "AI"}],
    }
    st, r = put_script(NAME, js, metadata)
    print(f"PUT script: {st} {json.dumps(r)[:300]}")
    if st not in (200, 201):
        return 1
    st, r = call("POST", f"/accounts/59e749ed2e9cdb8b0bf70d47227968a1/workers/scripts/{NAME}/subdomain",
                 json_body={"enabled": True})
    print(f"subdomain: {st} {json.dumps(r)[:300]}")
    if st not in (200, 201):
        return 1
    url = f"https://{NAME}.myhub-app.workers.dev/health"
    KEY_FILE.write_text(key, encoding="utf-8")
    KEY_FILE.chmod(0o600)
    for _ in range(20):
        try:
            req = urllib.request.Request(url)
            req.add_header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status == 200:
                    print(f"HEALTH OK {url}")
                    print(f"probe base: https://{NAME}.myhub-app.workers.dev")
                    print(f"key file: {KEY_FILE} (mode 600, /tmp only)")
                    return 0
        except Exception:  # noqa: BLE001 - keep polling
            pass
        time.sleep(3)
    print("health check timed out", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
