#!/usr/bin/env python3
"""Score Clairic vs LLM A/B raw results against the eval-set ground truth.

Scoring rules (see tests/fixtures/clairic-ab/eval-set.json meta.scoring):
  - date:   exact ISO YYYY-MM-DD (time part / verbose forms normalized first)
  - time:   exact HH:MM 24-hour (am/pm and seconds normalized first)
  - amount: exact numeric equality (currency symbols/commas stripped first)
  - text:   character-level F1 >= 0.5 after normalization
            (lowercase, keep letters/digits only)
  - null:   predicted null matches ground-truth null

Cost/neuron rates are the OFFICIAL Workers AI price table values confirmed
2026-10-28 (https://developers.cloudflare.com/workers-ai/platform/pricing/,
updated 2026-10-20):
  - Clairic:        $0.10/M input tokens, 9091 neurons/M input, $0 output
  - glm-4.7-flash:  $0.06/M input, $0.40/M output,
                    5500 neurons/M input, 36400 neurons/M output

Usage:
  python3 scripts/clairic-ab/score.py <raw-results.json> [--out summary.json]
Prints the A/B table to stdout.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import statistics
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EVAL_SET = ROOT / "tests" / "fixtures" / "clairic-ab" / "eval-set.json"

FIELDS = ["person", "event_date", "event_time", "amount", "task", "place"]
TEXT_FIELDS = {"person", "task", "place"}

# Official Workers AI rates (2026-10-20 price table, confirmed 2026-10-28).
RATES = {
    "clairic": {"usd_per_m_in": 0.10, "usd_per_m_out": 0.0, "neurons_per_m_in": 9091, "neurons_per_m_out": 0},
    "llm": {"usd_per_m_in": 0.06, "usd_per_m_out": 0.40, "neurons_per_m_in": 5500, "neurons_per_m_out": 36400},
    "llm-fast": {"usd_per_m_in": 0.045, "usd_per_m_out": 0.384, "neurons_per_m_in": 4119, "neurons_per_m_out": 34868},
}
FREE_NEURONS_PER_DAY = 10_000


# ---------------------------------------------------------------------------
# Normalization + field comparison (pure — covered by test_scoring.py)
# ---------------------------------------------------------------------------

def norm_text(s: str) -> str:
    """Lowercase, keep letters/digits only (spaces/punctuation removed)."""
    return "".join(ch for ch in str(s).lower() if ch.isalnum())


def char_f1(a: str, b: str) -> float:
    """Character-level F1 between two normalized strings (SQuAD-style)."""
    na, nb = norm_text(a), norm_text(b)
    if not na or not nb:
        return 1.0 if na == nb else 0.0
    ca, cb = Counter(na), Counter(nb)
    overlap = sum((ca & cb).values())
    if overlap == 0:
        return 0.0
    precision = overlap / len(na)
    recall = overlap / len(nb)
    return 2 * precision * recall / (precision + recall)


def norm_date(v) -> str | None:
    """Normalize a date value to YYYY-MM-DD, or None if unparseable."""
    if v is None:
        return None
    s = str(v).strip()
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    for fmt in ("%Y/%m/%d", "%d %B %Y", "%B %d, %Y", "%b %d, %Y"):
        try:
            from datetime import datetime

            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def norm_time(v) -> str | None:
    """Normalize a time value to HH:MM (24h), or None if unparseable."""
    if v is None:
        return None
    s = str(v).strip().lower()
    m = re.match(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$", s)
    if not m:
        return None
    hh, mm = int(m.group(1)), int(m.group(2))
    ampm = m.group(4)
    if ampm == "pm" and hh < 12:
        hh += 12
    if ampm == "am" and hh == 12:
        hh = 0
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        return None
    return f"{hh:02d}:{mm:02d}"


def norm_amount(v) -> float | None:
    """Normalize an amount to a float, or None if unparseable."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(",", "")
    s = re.sub(r"[^\d.\-]", "", s)
    if not s or s in ("-", ".", "-."):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def field_matches(field: str, predicted, expected) -> bool:
    """True when a predicted field value matches ground truth.

    Both None -> True (correct null). One None -> False.
    """
    if expected is None:
        return predicted is None
    if predicted is None:
        return False
    if field == "event_date":
        return norm_date(predicted) == norm_date(expected)
    if field == "event_time":
        return norm_time(predicted) == norm_time(expected)
    if field == "amount":
        pa, ea = norm_amount(predicted), norm_amount(expected)
        return pa is not None and ea is not None and pa == ea
    return char_f1(str(predicted), str(expected)) >= 0.5


def parse_llm_json(raw: str) -> dict:
    """Extract the JSON object from an LLM reply (fences tolerated)."""
    if not raw:
        return {}
    s = raw.strip()
    s = re.sub(r"^```(?:json)?\s*", "", s)
    s = re.sub(r"\s*```$", "", s)
    start, end = s.find("{"), s.rfind("}")
    if start < 0 or end <= start:
        return {}
    try:
        obj = json.loads(s[start : end + 1])
        return obj if isinstance(obj, dict) else {}
    except json.JSONDecodeError:
        return {}


def extract_predictions(record: dict) -> dict:
    """Pull {field: value | None} out of a raw record, per arm."""
    if record["arm"] == "clairic":
        out = {}
        for f in FIELDS:
            ans = (record.get("answers") or {}).get(f) or {}
            out[f] = ans.get("value")
        return out
    parsed = parse_llm_json(record.get("raw_response", ""))
    return {f: parsed.get(f) for f in FIELDS}


def extract_confidence(record: dict) -> dict:
    """Pull {field: (confidence, p_null)} out of a Clairic record."""
    out = {}
    for f in FIELDS:
        ans = (record.get("answers") or {}).get(f) or {}
        out[f] = (ans.get("confidence"), ans.get("p_null"))
    return out


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def score(records: list[dict], memos: dict[str, dict]) -> dict:
    """Per-arm field judgments: list of {memo_id, lang, field, gt, pred, ok}."""
    judgments: dict[str, list[dict]] = {}
    for rec in records:
        arm = rec["arm"]
        memo = memos[rec["memo_id"]]
        pred = extract_predictions(rec)
        conf = extract_confidence(rec) if arm == "clairic" else {}
        for f in FIELDS:
            gt = memo["gt"].get(f)
            judgments.setdefault(arm, []).append(
                {
                    "memo_id": rec["memo_id"],
                    "lang": rec["lang"],
                    "field": f,
                    "gt": gt,
                    "pred": pred.get(f),
                    "ok": field_matches(f, pred.get(f), gt),
                    "confidence": conf.get(f, (None, None))[0],
                    "p_null": conf.get(f, (None, None))[1],
                    "latency_ms": rec.get("latency_ms"),
                }
            )
    return judgments


def summarize(judgments: list[dict]) -> dict:
    n = len(judgments)
    correct = sum(1 for j in judgments if j["ok"])
    gt_present = [j for j in judgments if j["gt"] is not None]
    gt_null = [j for j in judgments if j["gt"] is None]
    pred_present = [j for j in judgments if j["pred"] is not None]
    tp = sum(1 for j in gt_present if j["pred"] is not None and j["ok"])
    # Detection (value present?) precision/recall, independent of value correctness.
    det_tp = sum(1 for j in gt_present if j["pred"] is not None)
    det_fp = sum(1 for j in gt_null if j["pred"] is not None)
    det_fn = sum(1 for j in gt_present if j["pred"] is None)
    null_ok = sum(1 for j in gt_null if j["pred"] is None)
    return {
        "n": n,
        "accuracy": correct / n if n else 0.0,
        "correct": correct,
        "detection_precision": det_tp / (det_tp + det_fp) if (det_tp + det_fp) else 0.0,
        "detection_recall": det_tp / (det_tp + det_fn) if (det_tp + det_fn) else 0.0,
        "null_accuracy": null_ok / len(gt_null) if gt_null else 0.0,
        "value_accuracy_on_present": tp / len(gt_present) if gt_present else 0.0,
        "n_gt_present": len(gt_present),
        "n_gt_null": len(gt_null),
    }


def threshold_sweep(judgments: list[dict], thresholds=(0.5, 0.8, 0.9, 0.95, 0.99, 0.999)) -> list[dict]:
    """Auto-accept rule: accept a non-null prediction iff confidence >= t.

    Reports, per threshold, precision among accepted and recall against all
    ground-truth-present fields, plus the review share (1 - accepted/all).
    """
    present = [j for j in judgments if j["gt"] is not None]
    rows = []
    for t in thresholds:
        accepted = [j for j in present if j["pred"] is not None and (j["confidence"] or 0) >= t]
        ok = sum(1 for j in accepted if j["ok"])
        rows.append(
            {
                "threshold": t,
                "accepted": len(accepted),
                "accepted_correct": ok,
                "precision": ok / len(accepted) if accepted else 0.0,
                "recall_vs_present": ok / len(present) if present else 0.0,
                "auto_share": len(accepted) / len(present) if present else 0.0,
                "review_share": 1 - (len(accepted) / len(present) if present else 0.0),
            }
        )
    return rows


def null_sweep(judgments: list[dict], thresholds=(0.5, 0.8, 0.9, 0.95, 0.99)) -> list[dict]:
    """Auto-accept rule for nulls: accept a null prediction iff p_null >= t."""
    nulls = [j for j in judgments if j["gt"] is None]
    rows = []
    for t in thresholds:
        accepted = [j for j in nulls if j["pred"] is None and (j["p_null"] or 0) >= t]
        ok = sum(1 for j in accepted if j["ok"])
        rows.append(
            {
                "threshold": t,
                "accepted": len(accepted),
                "accepted_correct": ok,
                "null_precision": ok / len(accepted) if accepted else 0.0,
                "null_recall": ok / len(nulls) if nulls else 0.0,
            }
        )
    return rows


def cost_summary(records: list[dict], arm: str) -> dict:
    """Latency + token + neuron + USD totals from raw records."""
    arm_recs = [r for r in records if r["arm"] == arm]
    lat = sorted(r["latency_ms"] for r in arm_recs if r.get("latency_ms") is not None)
    clat = sorted(r["client_latency_ms"] for r in arm_recs if r.get("client_latency_ms") is not None)
    in_tokens = sum((r.get("usage") or {}).get("input_tokens") or (r.get("usage") or {}).get("prompt_tokens") or 0 for r in arm_recs)
    out_tokens = sum((r.get("usage") or {}).get("output_tokens") or (r.get("usage") or {}).get("completion_tokens") or 0 for r in arm_recs)
    rate = RATES[arm]
    # Prefer the live `neurons` value Workers AI reports in usage when
    # present (verified: it equals the price-table computation exactly);
    # fall back to the table rates (Clairic reports tokens only).
    live_neurons = [(r.get("usage") or {}).get("neurons") for r in arm_recs]
    if live_neurons and all(v is not None for v in live_neurons):
        neurons = float(sum(live_neurons))
        neurons_source = "live"
    else:
        neurons = in_tokens * rate["neurons_per_m_in"] / 1e6 + out_tokens * rate["neurons_per_m_out"] / 1e6
        neurons_source = "table"
    usd = in_tokens * rate["usd_per_m_in"] / 1e6 + out_tokens * rate["usd_per_m_out"] / 1e6
    n = len(arm_recs)
    retries = sum(r.get("probe_retries") or 0 for r in arm_recs)
    return {
        "calls": n,
        "probe_retries": retries,
        "neurons_source": neurons_source,
        "latency_mean_ms": round(statistics.mean(lat), 1) if lat else None,
        "latency_p50_ms": round(statistics.median(lat), 1) if lat else None,
        "latency_p90_ms": round(lat[int(0.9 * (len(lat) - 1))], 1) if lat else None,
        "client_latency_mean_ms": round(statistics.mean(clat), 1) if clat else None,
        "input_tokens": in_tokens,
        "output_tokens": out_tokens,
        "neurons_total": round(neurons, 1),
        "neurons_per_call": round(neurons / n, 2) if n else 0,
        "usd_total": round(usd, 6),
        "usd_per_1000_memos": round(usd / n * 1000, 4) if n else 0,
        "memos_per_free_day": math.floor(FREE_NEURONS_PER_DAY / (neurons / n)) if n and neurons > 0 else None,
    }


def pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def main() -> int:
    ap = argparse.ArgumentParser(description="Score Clairic vs LLM A/B raw results")
    ap.add_argument("raw", type=str, help="raw results JSON from run_ab.py")
    ap.add_argument("--out", type=str, default="", help="summary JSON output path")
    args = ap.parse_args()

    raw = json.loads(Path(args.raw).read_text(encoding="utf-8"))
    eval_set = json.loads(EVAL_SET.read_text(encoding="utf-8"))
    memos = {m["id"]: m for m in eval_set["memos"]}
    records = raw["records"]
    judgments = score(records, memos)

    summary: dict = {"raw": args.raw, "arms": {}, "threshold_sweep": {}, "null_sweep": {}}
    for arm, js in judgments.items():
        s = summarize(js)
        s["cost"] = cost_summary(records, arm)
        s["by_field"] = {
            f: round(sum(1 for j in js if j["field"] == f and j["ok"]) / max(1, sum(1 for j in js if j["field"] == f)), 4)
            for f in FIELDS
        }
        s["by_lang"] = {
            lang: round(
                sum(1 for j in js if j["lang"] == lang and j["ok"]) / max(1, sum(1 for j in js if j["lang"] == lang)),
                4,
            )
            for lang in ("ko", "en")
        }
        summary["arms"][arm] = s
        if arm == "clairic":
            summary["threshold_sweep"] = threshold_sweep(js)
            summary["null_sweep"] = null_sweep(js)

    if args.out:
        Path(args.out).write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"summary -> {args.out}")

    print("== A/B: Clairic vs LLM extraction (30 synthetic memos x 6 fields = 180 judgments/arm) ==")
    for arm, s in summary["arms"].items():
        c = s["cost"]
        print(f"\n[{arm}] accuracy={pct(s['accuracy'])} ({s['correct']}/{s['n']}) "
              f"detect P={pct(s['detection_precision'])} R={pct(s['detection_recall'])} "
              f"null_acc={pct(s['null_accuracy'])} value_acc_on_present={pct(s['value_accuracy_on_present'])}")
        print(f"  by field: " + ", ".join(f"{f}={pct(v)}" for f, v in s["by_field"].items()))
        print(f"  by lang:  " + ", ".join(f"{k}={pct(v)}" for k, v in s["by_lang"].items()))
        print(f"  latency: mean={c['latency_mean_ms']}ms p50={c['latency_p50_ms']}ms p90={c['latency_p90_ms']}ms" +
              (f" (client round-trip mean={c['client_latency_mean_ms']}ms)" if c.get("client_latency_mean_ms") else ""))
        print(f"  tokens: in={c['input_tokens']} out={c['output_tokens']} neurons={c['neurons_total']} ({c['neurons_source']}) "
              f"({c['neurons_per_call']}/call) usd=${c['usd_total']} "
              f"(${c['usd_per_1000_memos']}/1k memos) free-day capacity~{c['memos_per_free_day']} memos/day" +
              (f" probe_retries={c['probe_retries']}" if c.get("probe_retries") else ""))
    if summary["threshold_sweep"]:
        print("\n== Clairic confidence threshold sweep (auto-accept non-null iff confidence >= t) ==")
        print("  t      accepted  precision  recall(vs present)  auto_share  review_share")
        for r in summary["threshold_sweep"]:
            print(f"  {r['threshold']:<6} {r['accepted']:<9} {pct(r['precision']):<10} {pct(r['recall_vs_present']):<18} "
                  f"{pct(r['auto_share']):<11} {pct(r['review_share'])}")
        print("\n== Clairic p_null sweep (auto-accept null iff p_null >= t) ==")
        print("  t      accepted  null_precision  null_recall")
        for r in summary["null_sweep"]:
            print(f"  {r['threshold']:<6} {r['accepted']:<9} {pct(r['null_precision']):<15} {pct(r['null_recall'])}")
    if raw.get("errors"):
        print(f"\nERRORS ({len(raw['errors'])}):")
        for e in raw["errors"]:
            print(f"  {e}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
