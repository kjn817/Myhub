#!/usr/bin/env python3
"""garak 리포트(.report.jsonl) 요약.

사용법: python summarize.py <리포트.jsonl>
출력: 프로브별 평가 수 / PASS / FAIL / NONE 건수 + 전체 합계.
종료 코드: FAIL이 0건이면 0, 1건 이상이면 1 (run-garak.sh --fail-on-vuln용).
리포트 형식이 바뀌어 eval 항목을 찾지 못하면 종료 코드 2 + 경고.

참고: garak 0.17.1의 eval 항목은 시도별이 아니라 프로브×탐지기별 집계다.
  {"entry_type": "eval", "probe": "promptinject.HijackLongPrompt",
   "detector": "promptinject.AttackRogueString",
   "passed": 256, "fails": 0, "nones": 0, "total_evaluated": 256, ...}
"""
import json
import sys
from collections import Counter, defaultdict


def main() -> int:
    if len(sys.argv) != 2:
        print(f"사용법: {sys.argv[0]} <리포트.jsonl>", file=sys.stderr)
        return 2
    path = sys.argv[1]
    per_probe: dict[str, Counter] = defaultdict(Counter)
    total = Counter()
    eval_entries = 0
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("entry_type") != "eval":
                continue
            eval_entries += 1
            probe = entry.get("probe", "unknown")
            per_probe[probe]["PASS"] += int(entry.get("passed", 0) or 0)
            per_probe[probe]["FAIL"] += int(entry.get("fails", 0) or 0)
            per_probe[probe]["NONE"] += int(entry.get("nones", 0) or 0)
            total["PASS"] += int(entry.get("passed", 0) or 0)
            total["FAIL"] += int(entry.get("fails", 0) or 0)
            total["NONE"] += int(entry.get("nones", 0) or 0)

    if eval_entries == 0:
        print("경고: 리포트에서 eval 항목을 찾지 못했습니다 (garak 버전별 형식 차이 가능).", file=sys.stderr)
        return 2

    print(f"{'probe':<55} {'evaluated':>10} {'PASS':>6} {'FAIL':>6} {'NONE':>6}")
    for probe in sorted(per_probe):
        c = per_probe[probe]
        evaluated = sum(c.values())
        print(f"{probe:<55} {evaluated:>10} {c['PASS']:>6} {c['FAIL']:>6} {c['NONE']:>6}")
    print(f"{'TOTAL':<55} {sum(total.values()):>10} {total['PASS']:>6} {total['FAIL']:>6} {total['NONE']:>6}")
    print(f"eval 항목(프로브 x 탐지기): {eval_entries}개")
    return 0 if total["FAIL"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
