#!/usr/bin/env python3
"""Unit tests for scripts/clairic-ab/score.py (pure scoring functions).

Run: python3 scripts/clairic-ab/test_scoring.py
No third-party deps. Every test pins a property that must break if the
scoring logic is inverted, loosened, or replaced with a stub.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from score import (  # noqa: E402
    char_f1,
    extract_confidence,
    extract_predictions,
    field_matches,
    norm_amount,
    norm_date,
    norm_time,
    norm_text,
    parse_llm_json,
    threshold_sweep,
)


def test_norm_text_strips_spaces_punct_and_case() -> None:
    assert norm_text("Gangnam Study Cafe!") == "gangnamstudycafe"
    assert norm_text("김민수 씨") == "김민수씨"
    assert norm_text("") == ""


def test_char_f1_exact_partial_disjoint() -> None:
    assert char_f1("김민수", "김민수") == 1.0
    # No shared characters at all -> exactly 0.
    assert char_f1("김민수", "박지훈") == 0.0
    # One shared char ("수") in 3-char names -> F1 1/3, still below the 0.5 bar.
    assert char_f1("김민수", "이수진") < 0.5
    # "김민수 씨" shares 3 of 4 chars with "김민수": F1 = 2*(0.75*1)/(1.75) > 0.8
    assert char_f1("김민수", "김민수 씨") > 0.8
    # unrelated long strings stay near zero
    assert char_f1("회의 자료 준비", "도시락 준비") < 0.5


def test_norm_date() -> None:
    assert norm_date("2026-10-29") == "2026-10-29"
    assert norm_date("2026-10-29T00:00:00") == "2026-10-29"
    assert norm_date("not a date") is None
    assert norm_date(None) is None


def test_norm_time_am_pm_and_seconds() -> None:
    assert norm_time("15:00") == "15:00"
    assert norm_time("3:00 PM") == "15:00"
    assert norm_time("3:00 pm") == "15:00"
    assert norm_time("12:00 AM") == "00:00"
    assert norm_time("12:30 PM") == "12:30"
    assert norm_time("09:00:00") == "09:00"
    assert norm_time("25:00") is None
    assert norm_time("lunch") is None


def test_norm_amount_strips_currency_and_commas() -> None:
    assert norm_amount(45000) == 45000.0
    assert norm_amount("45,000원") == 45000.0
    assert norm_amount("$120") == 120.0
    assert norm_amount("3,500") == 3500.0
    assert norm_amount(None) is None
    assert norm_amount("no money") is None


def test_field_matches_null_semantics() -> None:
    # correct null
    assert field_matches("amount", None, None) is True
    # false positive / false negative
    assert field_matches("amount", 100, None) is False
    assert field_matches("amount", None, 100) is False
    # exact value
    assert field_matches("amount", 45000, 45000) is True
    assert field_matches("amount", "45,000원", 45000) is True
    assert field_matches("amount", 45001, 45000) is False
    assert field_matches("event_date", "2026-10-29", "2026-10-29") is True
    assert field_matches("event_date", "2026-10-30", "2026-10-29") is False
    assert field_matches("event_time", "3:00 PM", "15:00") is True
    assert field_matches("event_time", "16:00", "15:00") is False


def test_field_matches_text_uses_f1_threshold() -> None:
    assert field_matches("person", "김민수", "김민수") is True
    assert field_matches("person", "이수진", "김민수") is False
    # paraphrase with shared core words passes the 0.5 F1 bar
    assert field_matches("task", "운동화 끈을 새로 사야 한다", "운동화 끈 사기") is True
    # unrelated task fails
    assert field_matches("task", "케이크 주문", "운동화 끈 사기") is False


def test_parse_llm_json_tolerates_fences_and_prose() -> None:
    assert parse_llm_json('```json\n{"person": "김민수", "amount": null}\n```') == {
        "person": "김민수",
        "amount": None,
    }
    assert parse_llm_json('Here is the result: {"person": "A"} done.') == {"person": "A"}
    assert parse_llm_json("no json here") == {}
    assert parse_llm_json("") == {}


def test_extract_predictions_clairic_and_llm() -> None:
    clairic_rec = {
        "arm": "clairic",
        "answers": {
            "person": {"value": "김민수", "confidence": 0.99, "p_null": 0.001},
            "amount": {"value": None, "confidence": 0.4, "p_null": 0.98},
        },
    }
    assert extract_predictions(clairic_rec)["person"] == "김민수"
    assert extract_predictions(clairic_rec)["amount"] is None
    assert extract_predictions(clairic_rec)["place"] is None  # missing field -> None
    conf = extract_confidence(clairic_rec)
    assert conf["person"] == (0.99, 0.001)
    assert conf["amount"] == (0.4, 0.98)

    llm_rec = {"arm": "llm", "raw_response": '{"person": "A", "event_date": "2026-10-29"}'}
    assert extract_predictions(llm_rec)["person"] == "A"
    assert extract_predictions(llm_rec)["event_date"] == "2026-10-29"
    assert extract_predictions(llm_rec)["amount"] is None


def test_threshold_sweep_hand_computed() -> None:
    # 3 GT-present fields: 2 correct with conf 0.99/0.7, 1 wrong with conf 0.99.
    js = [
        {"gt": "a", "pred": "a", "ok": True, "confidence": 0.99, "p_null": 0.0},
        {"gt": "b", "pred": "b", "ok": True, "confidence": 0.7, "p_null": 0.0},
        {"gt": "c", "pred": "WRONG", "ok": False, "confidence": 0.99, "p_null": 0.0},
    ]
    rows = {r["threshold"]: r for r in threshold_sweep(js, thresholds=(0.9, 0.6))}
    # t=0.9: accepts the 0.99 correct + 0.99 wrong -> precision 1/2, recall 1/3
    assert rows[0.9]["accepted"] == 2
    assert rows[0.9]["precision"] == 0.5
    assert abs(rows[0.9]["recall_vs_present"] - 1 / 3) < 1e-9
    # t=0.6: accepts all 3 -> precision 2/3, recall 2/3
    assert rows[0.6]["accepted"] == 3
    assert abs(rows[0.6]["precision"] - 2 / 3) < 1e-9
    assert abs(rows[0.6]["recall_vs_present"] - 2 / 3) < 1e-9


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in tests:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"FAIL {fn.__name__}: {exc}")
    print(f"{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
