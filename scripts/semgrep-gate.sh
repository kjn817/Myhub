#!/usr/bin/env bash
# MyHub Semgrep 베이스라인 게이트 (2026-10-29, 트랙 D)
#
# 목적: docs/semgrep-recheck-20261029.md에서 전수 오탐 판정된 46건을
# 베이스라인(.semgrep/baseline.json)으로 고정하고, 이후 스캔에서
# "베이스라인에 없는 신규 검출"이 있을 때만 실패시키는 로컬 게이트.
# 이 저장소에는 CI(GitHub Actions 등)가 없으므로 자동 차단은 되지 않는다.
# 배포 전 수동 실행이 전제이며, 한계는 docs/semgrep-gate-20261029.md 참조.
#
# 사용법:
#   bash scripts/semgrep-gate.sh                     # 게이트 검사 (신규 검출 시 exit 1)
#   bash scripts/semgrep-gate.sh --update-baseline   # 현재 스캔 결과로 베이스라인 재생성
#   bash scripts/semgrep-gate.sh --baseline <path>   # 베이스라인 파일 지정 (테스트용)
#   bash scripts/semgrep-gate.sh --scan-json <path>  # 스캔 생략, 저장된 semgrep JSON으로 대조 (테스트/디버그용)
#
# 종료 코드: 0=통과(신규 검출 없음) / 1=신규 검출 있음 / 2=게이트 자체 오류
#            (semgrep 실행 실패, 스캔 errors 존재, 베이스라인 없음/파손)
#
# 식별자 설계: check_id + path + snippet_hash + occurrence
#   - snippet_hash = 검출 구간 소스 라인을 공백 정규화한 sha256 앞 16자.
#     줄번호를 식별자에 넣지 않으므로, 무관한 코드 삽입으로 줄이 밀려도
#     베이스라인이 깨지지 않는다 (줄번호만 쓰면 2026-10-27→29 사이
#     memo/routes.ts 157→215 이동 같은 churn이 전건을 신규로 만든다).
#   - Semgrep OSS(미로그인)는 JSON의 extra.lines/fingerprint를
#     "requires login"으로 가리므로 스니펫 해시는 소스 파일에서 직접 계산한다.
#   - 같은 파일에 동일 코드 라인이 반복 검출되면(예: deploy_full.py의
#     urlopen 3건) occurrence(동일 키 내 등장 순번)로 구분한다. 멀티셋
#     대조라 동일 복사본이 추가되면 개수 증가로 신규 검출이 된다.
#   - 한계: 검출 라인 자체의 토큰이 바뀌면 신규+소실 쌍으로 나타난다
#     (fail-closed — 판정 후 베이스라인 갱신이 정당한 절차).
#     파일 rename, 규칙 ID 변경도 같은 쌍으로 나타난다. 상세는 게이트 문서.
#
# JSON 파싱은 python3를 쓴다 (jq 1.7도 있으나 스니펫 해시 계산에 소스 파일
# 읽기가 필요해 python3 하나로 통일; 이 환경에서 python3 3.12.3 실측 확인).
set -uo pipefail
cd "$(dirname "$0")/.."

MODE=check
BASELINE=".semgrep/baseline.json"
SCAN_JSON=""
while [ $# -gt 0 ]; do
  case "$1" in
    --update-baseline) MODE=update ;;
    --baseline) BASELINE="${2:?--baseline에는 경로가 필요합니다}"; shift ;;
    --scan-json) SCAN_JSON="${2:?--scan-json에는 경로가 필요합니다}"; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "알 수 없는 옵션: $1 (허용: --update-baseline, --baseline <path>, --scan-json <path>)" >&2; exit 2 ;;
  esac
  shift
done

TMPJSON=""
cleanup() { [ -n "$TMPJSON" ] && rm -f "$TMPJSON"; }
trap cleanup EXIT

if [ -z "$SCAN_JSON" ]; then
  TMPJSON="$(mktemp /tmp/semgrep-gate-XXXXXX.json)"
  echo "[semgrep-gate] 스캔 실행 중 (scripts/run-semgrep.sh --json) ..." >&2
  if ! bash scripts/run-semgrep.sh --json > "$TMPJSON"; then
    echo "[semgrep-gate] 오류: semgrep 스캔 실행 실패 — 게이트 판정 불가 (exit 2)" >&2
    exit 2
  fi
  SCAN_JSON="$TMPJSON"
fi

GATE_HEAD="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
export GATE_HEAD

python3 - "$MODE" "$BASELINE" "$SCAN_JSON" <<'PYEOF'
import hashlib
import json
import os
import sys
from collections import Counter
from datetime import date
from pathlib import Path

mode, baseline_path, scan_path = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
root = Path.cwd()

try:
    scan = json.loads(scan_path.read_text())
except Exception as e:
    print(f"[semgrep-gate] 오류: 스캔 JSON을 읽을 수 없음 ({scan_path}): {e}")
    sys.exit(2)

errors = scan.get("errors") or []
if errors:
    print(f"[semgrep-gate] 오류: semgrep 스캔 errors {len(errors)}건 — 결과를 신뢰할 수 없어 중단 (exit 2)")
    for err in errors[:5]:
        print(f"  - {err.get('message', err)}")
    sys.exit(2)

_file_cache = {}

def source_lines(path_str):
    if path_str not in _file_cache:
        try:
            _file_cache[path_str] = (root / path_str).read_text(errors="replace").splitlines()
        except OSError:
            _file_cache[path_str] = None
    return _file_cache[path_str]

def compute_entries(results):
    """스캔 결과 -> 베이스라인 항목 목록. occurrence는 (check_id, path, hash)
    동일 키 안에서 line 순 등장 번호 (멀티셋 대조용)."""
    ordered = sorted(
        results,
        key=lambda r: (r["path"], r["start"]["line"], r["check_id"]),
    )
    seen = Counter()
    entries = []
    unreadable = 0
    for r in ordered:
        start, end = r["start"]["line"], r["end"]["line"]
        lines = source_lines(r["path"])
        if lines is None or start < 1 or start > len(lines):
            # 소스를 못 읽으면 줄번호 기반 해시로 강등 (취약성은 문서에 명시)
            normalized = f"<unreadable:{r['path']}:{start}>"
            unreadable += 1
        else:
            chunk = lines[start - 1 : end]
            normalized = "\n".join(" ".join(line.split()) for line in chunk)
        digest = hashlib.sha256(normalized.encode()).hexdigest()[:16]
        key = (r["check_id"], r["path"], digest)
        seen[key] += 1
        entries.append(
            {
                "check_id": r["check_id"],
                "path": r["path"],
                "line": start,
                "snippet_hash": digest,
                "occurrence": seen[key],
                "snippet": normalized.split("\n")[0][:120],
            }
        )
    return entries, unreadable

def entry_key(e):
    return (e["check_id"], e["path"], e["snippet_hash"], e["occurrence"])

current, unreadable = compute_entries(scan.get("results") or [])
if unreadable:
    print(f"[semgrep-gate] 경고: 소스를 읽지 못해 줄번호 기반으로 강등된 검출 {unreadable}건")

if mode == "update":
    baseline = {
        "version": 1,
        "tool": "semgrep",
        "semgrep_version": scan.get("version", "unknown"),
        "generated_at": date.today().isoformat(),
        "generated_from_commit": os.environ.get("GATE_HEAD", "unknown"),
        "rulesets": [
            "p/security-audit",
            "p/secrets",
            "p/javascript",
            "p/typescript",
            ".semgrep/myhub-rules.yaml",
        ],
        "identity": "check_id + path + snippet_hash(sha256(normalized matched source lines)[:16]) + occurrence",
        "adjudication": "docs/semgrep-recheck-20261029.md — 생성 시점 검출 전건 오탐 판정 기록",
        "count": len(current),
        "entries": sorted(current, key=lambda e: (e["check_id"], e["path"], e["line"])),
    }
    baseline_path.parent.mkdir(parents=True, exist_ok=True)
    baseline_path.write_text(json.dumps(baseline, indent=2, ensure_ascii=False) + "\n")
    print(f"[semgrep-gate] 베이스라인 재생성 완료: {baseline_path} ({len(current)}건, semgrep {baseline['semgrep_version']}, commit {baseline['generated_from_commit']})")
    print("[semgrep-gate] 주의: 재생성 전 신규 검출 전건을 건별로 판정했는지 확인할 것 — 판정 없는 재생성은 게이트를 무력화한다 (docs/semgrep-gate-20261029.md).")
    sys.exit(0)

# --- check mode ---
if not baseline_path.exists():
    print(f"[semgrep-gate] 오류: 베이스라인이 없음 ({baseline_path}) — 먼저 --update-baseline으로 생성할 것 (exit 2)")
    sys.exit(2)
try:
    baseline_doc = json.loads(baseline_path.read_text())
    baseline_entries = baseline_doc["entries"]
except Exception as e:
    print(f"[semgrep-gate] 오류: 베이스라인을 읽을 수 없음 ({baseline_path}): {e} (exit 2)")
    sys.exit(2)

base_map = {entry_key(e): e for e in baseline_entries}
cur_map = {entry_key(e): e for e in current}
new_keys = sorted(set(cur_map) - set(base_map))
gone_keys = sorted(set(base_map) - set(cur_map))

base_ver = baseline_doc.get("semgrep_version", "unknown")
cur_ver = scan.get("version", "unknown")
if base_ver != cur_ver:
    print(f"[semgrep-gate] 경고: semgrep 버전 불일치 (베이스라인 {base_ver} vs 현재 {cur_ver}) — 규칙/ID 변경으로 신규 검출이 늘 수 있다")

for k in gone_keys:
    e = base_map[k]
    print(f"[semgrep-gate] 경고(소실): {e['check_id']} {e['path']}:{e['line']} — 베이스라인에 있었으나 현재 검출 안 됨 (통과, 베이스라인 정리 대상)")

if new_keys:
    print(f"[semgrep-gate] FAIL: 베이스라인에 없는 신규 검출 {len(new_keys)}건")
    for k in new_keys:
        e = cur_map[k]
        print(f"  NEW {e['check_id']} {e['path']}:{e['line']} :: {e['snippet']}")
    print("[semgrep-gate] 조치: 각 건을 코드로 확인해 진짜 결함이면 수정하고, 오탐이면 docs에 건별 판정을 남긴 뒤 --update-baseline으로 갱신할 것")
    sys.exit(1)

print(f"[semgrep-gate] PASS: 신규 검출 0건 (현재 {len(current)}건 = 베이스라인 {len(baseline_entries)}건 중 소실 {len(gone_keys)}건)")
sys.exit(0)
PYEOF
exit $?
