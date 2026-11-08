#!/usr/bin/env python3
"""Clairic vs LLM extraction A/B — live runner (isolated, no prod Worker/D1).

Transport (default: probe): the connected Cloudflare API token returns
401 on Workers AI REST (/ai/run) — it lacks that scope — so live calls go
through a disposable scratch Worker (`clairic-ab-probe-20261028`,
scripts/clairic-ab/probe-worker.js, deleted after the run) whose AI
binding calls env.AI.run. Direct REST remains available via
--transport direct if the token scope is fixed later.
  - Clairic:  env.AI.run("@cf/cloudflare/clairic", {state, fields})
  - LLM arm:  env.AI.run("@cf/zai-org/glm-4.7-flash", {messages, temperature: 0})
  - LLM-fast: env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8", ...) — sensitivity
    check: GLM-4.7-flash is a thinking model (slow, reasoning-token heavy),
    so a fast non-reasoning LLM is measured alongside it.
    (Workers AI LLM, keyless. MyHub has NO wired LLM extractor — the
    memory.llm_extract_enabled flag only gates an injection point that no
    production caller fills. The LLM arms are therefore representative
    Workers AI LLMs running the same field contract, not "the production
    extractor". Gemini was not used: it would need API keys = secrets.)

Input:  tests/fixtures/clairic-ab/eval-set.json (synthetic memos only).
Output: scripts/clairic-ab/results/raw-<timestamp>.json — one record per
        (memo, arm) with latency_ms, usage tokens, and the raw model reply.

Usage:
  python3 scripts/clairic-ab/run_ab.py [--only clairic|llm] [--limit N]
                                       [--sleep SECONDS] [--out FILE]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

ACCOUNT_ID = "59e749ed2e9cdb8b0bf70d47227968a1"  # from the connector's cf_api.py
BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run"
ALLOWED_HOSTS = ["api.cloudflare.com"]
CREDENTIAL = "custom.cloudflare"

ROOT = Path(__file__).resolve().parents[2]
EVAL_SET = ROOT / "tests" / "fixtures" / "clairic-ab" / "eval-set.json"
RESULTS_DIR = Path(__file__).resolve().parent / "results"

CLAIRIC_FIELDS = {
    "person": {"type": "text", "instructions": "Name of a person mentioned in the memo"},
    "event_date": {"type": "date", "instructions": "Date of the main event or appointment, ISO format"},
    "event_time": {"type": "time", "instructions": "Time of the main event or appointment, 24-hour format"},
    "amount": {"type": "number", "decimals": 0, "instructions": "Amount of money mentioned, as a plain number"},
    "task": {"type": "text", "instructions": "The to-do or task mentioned in the memo"},
    "place": {"type": "text", "instructions": "Place or location mentioned in the memo"},
}

LLM_SYSTEM = (
    "Extract the requested fields from the memo and return ONLY a JSON object "
    "with keys person, event_date, event_time, amount, task, place. "
    "Use null for any field not present in the memo. "
    "event_date as YYYY-MM-DD, event_time as HH:MM in 24-hour format, "
    "amount as a plain number without currency symbols or commas. "
    "person/task/place as short strings copied from the memo. "
    "Do not add explanations, markdown, or extra keys."
)


def call_workers_ai(model: str, payload: dict, timeout: float = 60.0) -> dict:
    """One Workers AI REST call. Returns the parsed JSON envelope."""
    url = f"{BASE}/{model}"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    add_surrogate_to_request(req, CREDENTIAL, allowed_hosts=ALLOWED_HOSTS)
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = read_json_response(resp)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"HTTP {e.code}: {detail}") from e
    latency_ms = (time.perf_counter() - t0) * 1000.0
    return data, latency_ms


def call_with_retry(model: str, payload: dict, retries: int = 1) -> tuple[dict, float]:
    last_err: Exception | None = None
    for attempt in range(retries + 1):
        try:
            return call_workers_ai(model, payload)
        except Exception as exc:  # noqa: BLE001 - retry transient 429/5xx only
            last_err = exc
            msg = str(exc)
            if ("429" in msg or "500" in msg or "502" in msg or "503" in msg) and attempt < retries:
                time.sleep(5)
                continue
            raise
    raise last_err  # pragma: no cover


def call_probe(probe_url: str, probe_key: str, arm: str, memo: dict, context: str) -> dict:
    """One call through the scratch probe Worker (env.AI.run binding path).

    Returns the worker's JSON plus client-side round-trip latency. The
    worker-measured latency_ms is the env.AI.run time; client_latency_ms
    is the VM -> probe -> VM round trip.
    """
    body = json.dumps({"arm": arm, "memo": memo, "context": context}).encode("utf-8")
    req = urllib.request.Request(f"{probe_url}/run", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")
    req.add_header("x-clairic-probe", probe_key)
    t0 = time.perf_counter()
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = read_json_response(resp)
            break
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")[:500]
            last_err = RuntimeError(f"probe HTTP {e.code}: {detail}")
            if e.code in (502, 503) and attempt < 2:
                time.sleep(3)
                continue
            raise last_err from e
        except Exception as exc:  # noqa: BLE001 - URLError / RemoteDisconnected: retry
            last_err = exc
            if attempt < 2:
                time.sleep(3)
                continue
            raise
    client_ms = (time.perf_counter() - t0) * 1000.0
    if data.get("error"):
        raise RuntimeError(f"probe error: {data['error']}")
    data["client_latency_ms"] = round(client_ms, 1)
    data["probe_retries"] = attempt
    return data


def run_clairic(memo: dict, context: str) -> dict:
    state = f"{context}\n{memo['text']}"
    data, latency_ms = call_with_retry(
        "@cf/cloudflare/clairic",
        {"model": "clairic", "state": state, "fields": CLAIRIC_FIELDS},
    )
    if not data.get("success"):
        raise RuntimeError(f"Clairic API success=false: {json.dumps(data)[:500]}")
    result = data["result"]
    return {
        "arm": "clairic",
        "latency_ms": round(latency_ms, 1),
        "answers": result.get("answers", {}),
        "usage": result.get("usage", {}),
        "truncated": result.get("truncated"),
        "passes": result.get("usage", {}).get("passes"),
    }


def run_via_probe(probe_url: str, probe_key: str, arm: str, memo: dict, context: str) -> dict:
    """Probe transport: reshape the worker's reply into a run record."""
    data = call_probe(probe_url, probe_key, arm, memo, context)
    rec = {
        "arm": arm,
        "latency_ms": data.get("latency_ms"),
        "client_latency_ms": data.get("client_latency_ms"),
        "probe_retries": data.get("probe_retries", 0),
        "usage": data.get("usage", {}),
    }
    if arm == "clairic":
        rec["answers"] = data.get("answers", {})
        rec["truncated"] = data.get("truncated")
        rec["passes"] = (data.get("usage") or {}).get("passes")
    else:
        rec["raw_response"] = data.get("raw_response", "")
    return rec


def run_llm(memo: dict, context: str, model: str = "@cf/zai-org/glm-4.7-flash") -> dict:
    user = f"{context}\nMemo: {memo['text']}"
    data, latency_ms = call_with_retry(
        model,
        {
            "messages": [
                {"role": "system", "content": LLM_SYSTEM},
                {"role": "user", "content": user},
            ],
            "temperature": 0,
            "max_tokens": 2000 if "glm" in model else 400,
        },
    )
    if not data.get("success"):
        raise RuntimeError(f"LLM API success=false: {json.dumps(data)[:500]}")
    result = data["result"]
    # Workers AI LLMs return either {response} or an OpenAI-compatible
    # chat completion {choices[0].message.content} (GLM-4.7-flash: latter).
    raw = result.get("response", "") or ""
    if not raw and isinstance(result.get("choices"), list) and result["choices"]:
        raw = (result["choices"][0].get("message") or {}).get("content") or ""
    return {
        "arm": "llm" if "glm" in model else "llm-fast",
        "latency_ms": round(latency_ms, 1),
        "raw_response": raw,
        "usage": result.get("usage", {}),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Clairic vs LLM extraction A/B live runner")
    ap.add_argument("--only", choices=["clairic", "llm", "llm-fast", "all"], default="all")
    ap.add_argument("--limit", type=int, default=0, help="run only first N memos (0 = all)")
    ap.add_argument("--sleep", type=float, default=0.5, help="seconds between calls")
    ap.add_argument("--out", type=str, default="", help="output file (default: results/raw-<ts>.json)")
    ap.add_argument("--transport", choices=["probe", "direct"], default="probe",
                    help="probe = scratch Worker env.AI.run (default); direct = CF REST API "
                         "(currently 401: connected token lacks Workers AI REST scope)")
    ap.add_argument("--probe-url", type=str, default="https://clairic-ab-probe-20261028.myhub-app.workers.dev")
    ap.add_argument("--key-file", type=str, default="/tmp/clairic-ab-probe-key")
    ap.add_argument("--resume", action="store_true",
                    help="skip (memo, arm) pairs already present in --out file")
    args = ap.parse_args()

    probe_key = ""
    if args.transport == "probe":
        probe_key = Path(args.key_file).read_text(encoding="utf-8").strip()

    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    out = Path(args.out) if args.out else RESULTS_DIR / f"raw-{ts}.json"
    out.parent.mkdir(parents=True, exist_ok=True)

    eval_set = json.loads(EVAL_SET.read_text(encoding="utf-8"))
    memos = eval_set["memos"]
    if args.limit > 0:
        memos = memos[: args.limit]
    context = eval_set["context"]

    arms = ["clairic", "llm", "llm-fast"] if args.only == "all" else [args.only]
    records: list[dict] = []
    errors: list[dict] = []
    done: set[tuple[str, str]] = set()
    if args.resume and out.exists():
        try:
            prev = json.loads(out.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"resume: cannot read {out} ({exc}); starting fresh", file=sys.stderr, flush=True)
            prev = {}
        records = prev.get("records", [])
        errors = prev.get("errors", [])
        done = {(r["memo_id"], r["arm"]) for r in records} | {
            (e["memo_id"], e["arm"]) for e in errors
        }
        print(f"resume: {len(records)} records, {len(errors)} errors already in {out}", flush=True)

    def checkpoint() -> None:
        # Incremental write after every call, so a killed run keeps its
        # partial results and --resume can finish it. A checkpoint failure
        # must never kill the run: fall back to a direct write, then to
        # warning on stderr (in-memory records are the truth; the final
        # summary is re-derived from the file at the end of a clean run).
        payload = json.dumps(
            {
                "created_utc": ts,
                "eval_set": "tests/fixtures/clairic-ab/eval-set.json",
                "reference_date": eval_set.get("reference_date"),
                "transport": args.transport,
                "arms": arms,
                "records": records,
                "errors": errors,
            },
            ensure_ascii=False,
            indent=2,
        )
        tmp = out.with_suffix(".tmp")
        try:
            tmp.write_text(payload, encoding="utf-8")
            tmp.replace(out)
        except OSError as exc:
            try:
                out.write_text(payload, encoding="utf-8")
            except OSError as exc2:
                print(f"checkpoint failed ({exc}; fallback {exc2}); continuing", file=sys.stderr, flush=True)

    n_calls = 0
    for memo in memos:
        ctx = context[memo["lang"]]
        for arm in arms:
            if (memo["id"], arm) in done:
                continue
            rec: dict | None = None
            err: Exception | None = None
            try:
                if args.transport == "probe":
                    rec = run_via_probe(args.probe_url, probe_key, arm, memo, ctx)
                elif arm == "clairic":
                    rec = run_clairic(memo, ctx)
                elif arm == "llm":
                    rec = run_llm(memo, ctx)
                else:
                    rec = run_llm(memo, ctx, model="@cf/meta/llama-3.1-8b-instruct-fp8")
                rec["memo_id"] = memo["id"]
                rec["lang"] = memo["lang"]
                records.append(rec)
                n_calls += 1
            except Exception as exc:  # noqa: BLE001 - record and continue
                err = exc
                errors.append({"memo_id": memo["id"], "arm": arm, "error": str(exc)})
            finally:
                checkpoint()
            # Progress print lives OUTSIDE the try: a BrokenPipeError from a
            # dead stdout used to be caught as a call error and recorded as
            # a spurious failure for a call that had already succeeded
            # (2026-10-28: EN-06 clairic got both a record and an error).
            try:
                if rec is not None:
                    print(f"{memo['id']} {arm}: {rec['latency_ms']}ms usage={rec['usage']}", flush=True)
                else:
                    print(f"{memo['id']} {arm}: ERROR {err}", file=sys.stderr, flush=True)
            except BrokenPipeError:
                pass
            time.sleep(args.sleep)

    print(f"calls={n_calls} errors={len(errors)} -> {out}")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
