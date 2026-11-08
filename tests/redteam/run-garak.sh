#!/usr/bin/env bash
# MyHub garak 레드팀 하네스.
#
# 기본 동작은 스텁(내장 test 생성기) 대상 — 실제 모델 호출 없음, 비용 0원:
#   bash tests/redteam/run-garak.sh
#   bash tests/redteam/run-garak.sh --probes promptinject   # 프로브 패밀리 제한
#
# 실제 모델 대상 스캔은 이 스크립트만으로 실행할 수 없다. 별도 승인 절차가 필요하며
# docs/garak-harness-20261027.md "실제 모델 프로브 승인 절차"를 볼 것.
# (의도적으로: --live 플래그는 없고, GARAK_LIVE=1 환경변수 + 명시적 생성기 지정이
#  함께 있어야만 라이브 모드로 전환된다.)
#
# 결과: tests/redteam/results/garak-<타임스탬프>.report.jsonl (+ .report.html)
# 종료 코드: garak 실행·리포트 생성까지 성공하면 0. 스텁 대상의 FAIL 건수는
# 하네스 성공 여부를 가리지 않는다(스텁 응답은 임의의 고정 문자열이라 탐지기
# 판정이 의미가 없음). --fail-on-vuln을 주면 FAIL이 1건이라도 있으면 1로 종료한다
# (라이브 스캔의 CI 게이트용으로 예약 — 스텁 실행에는 쓰지 말 것).

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

VENV="${GARAK_VENV:-$HOME/.venvs/myhub-garak}"
GARAK_BIN="$VENV/bin/garak"
PROBES_FILE="$SCRIPT_DIR/probes.txt"
RESULTS_DIR="$SCRIPT_DIR/results"
FAIL_ON_VULN=0
PROBE_FILTER=()

while [ $# -gt 0 ]; do
  case "$1" in
    --probes)
      IFS=',' read -r -a PROBE_FILTER <<< "${2:-}"
      shift 2
      ;;
    --probes=*)
      IFS=',' read -r -a PROBE_FILTER <<< "${1#--probes=}"
      shift
      ;;
    --fail-on-vuln)
      FAIL_ON_VULN=1
      shift
      ;;
    --venv)
      VENV="${2:-}"
      GARAK_BIN="$VENV/bin/garak"
      shift 2
      ;;
    --help|-h)
      sed -n '2,20p' "$SCRIPT_DIR/run-garak.sh"
      exit 0
      ;;
    *)
      echo "오류: 알 수 없는 인자: $1" >&2
      exit 2
      ;;
  esac
done

if [ ! -x "$GARAK_BIN" ]; then
  echo "오류: garak 가상환경을 찾을 수 없습니다: $GARAK_BIN" >&2
  echo "설치: python3 -m venv ~/.venvs/myhub-garak && TMPDIR=\$HOME/.cache/pip-tmp ~/.venvs/myhub-garak/bin/pip install garak" >&2
  echo "자세한 방법: docs/garak-harness-20261027.md" >&2
  exit 2
fi

# 프로브 목록: probes.txt에서 읽고, --probes가 있으면 그 패밀리로 필터링한다.
if [ ! -f "$PROBES_FILE" ]; then
  echo "오류: 프로브 목록 파일이 없습니다: $PROBES_FILE" >&2
  exit 2
fi
PROBES="$(grep -v '^\s*#' "$PROBES_FILE" | grep -v '^\s*$' | tr '\n' ',' | sed 's/,$//')"
if [ "${#PROBE_FILTER[@]}" -gt 0 ]; then
  FILTERED=""
  for fam in "${PROBE_FILTER[@]}"; do
    for p in $(echo "$PROBES" | tr ',' ' '); do
      case "$p" in
        "$fam"|"$fam".*) FILTERED="$FILTERED,$p" ;;
      esac
    done
  done
  PROBES="${FILTERED#,}"
fi
if [ -z "$PROBES" ]; then
  echo "오류: 실행할 프로브가 없습니다 (probes.txt 또는 --probes 확인)." >&2
  exit 2
fi

# ---- 생성기 결정: 기본은 스텁. 라이브는 GARAK_LIVE=1 + 명시적 지정이 함께 필요 ----
if [ "${GARAK_LIVE:-0}" = "1" ]; then
  if [ -z "${GARAK_GENERATOR_TYPE:-}" ] || [ -z "${GARAK_GENERATOR_NAME:-}" ]; then
    echo "오류: 라이브 모드(GARAK_LIVE=1)에는 GARAK_GENERATOR_TYPE과 GARAK_GENERATOR_NAME이 둘 다 필요합니다." >&2
    echo "라이브 스캔은 별도 승인 절차 대상입니다. docs/garak-harness-20261027.md를 볼 것." >&2
    exit 2
  fi
  MODEL_TYPE="$GARAK_GENERATOR_TYPE"
  MODEL_NAME="$GARAK_GENERATOR_NAME"
  echo "경고: 라이브 모드 — 실제 모델($MODEL_TYPE/$MODEL_NAME)에 프로브를 던집니다. 비용이 발생합니다." >&2
else
  MODEL_TYPE="test"
  MODEL_NAME="Test"
  echo "스텁 모드 — 내장 test 생성기 대상, 실제 모델 호출 없음."
fi

mkdir -p "$RESULTS_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
PREFIX="$RESULTS_DIR/garak-${STAMP}"

echo "probes: $PROBES"
echo "generator: $MODEL_TYPE/$MODEL_NAME"
echo "report: ${PREFIX}.report.jsonl"

# TMPDIR이 512MB tmpfs(/tmp)면 torch 의존성 로딩 등에서 실패할 수 있어
# 홈 디렉토리 기반 임시 디렉토리를 기본으로 쓴다.
export TMPDIR="${TMPDIR:-$HOME/.cache/garak-tmp}"
mkdir -p "$TMPDIR"

# CLI의 --model_type/--model_name/--probes는 garak 0.13/0.15부터 deprecated라
# 설정 파일 방식으로 실행한다 (템플릿 치환 → 임시 설정).
RUN_CONFIG="$RESULTS_DIR/.garak-run-${STAMP}.yaml"
sed -e "s|__TARGET_TYPE__|${MODEL_TYPE}|g" \
    -e "s|__TARGET_NAME__|${MODEL_NAME}|g" \
    -e "s|__PROBE_SPEC__|${PROBES}|g" \
    -e "s|__REPORT_PREFIX__|${PREFIX}|g" \
    "$SCRIPT_DIR/garak-config.yaml" > "$RUN_CONFIG"

"$GARAK_BIN" --config "$RUN_CONFIG" ${GARAK_EXTRA_ARGS:-}
STATUS=$?
rm -f "$RUN_CONFIG"

if [ $STATUS -ne 0 ]; then
  echo "GARAK FAIL (종료 코드 $STATUS)" >&2
  exit $STATUS
fi

REPORT="${PREFIX}.report.jsonl"
if [ ! -f "$REPORT" ]; then
  echo "오류: 리포트 파일이 생성되지 않았습니다: $REPORT" >&2
  exit 1
fi

echo "---- 요약 ----"
"$VENV/bin/python" "$SCRIPT_DIR/summarize.py" "$REPORT"
SUMMARY_STATUS=$?

if [ "$FAIL_ON_VULN" -eq 1 ] && [ "$SUMMARY_STATUS" -ne 0 ]; then
  echo "FAIL 건수가 있어 --fail-on-vuln으로 종료 코드 1을 반환합니다." >&2
  exit 1
fi

echo "GARAK HARNESS OK (결과: $REPORT)"
exit 0
