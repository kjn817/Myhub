#!/usr/bin/env bash
# MyHub 라이브 eval 실행 스크립트 (promptfoo).
#
# 라이브 실행 (운영 /api/ai/chat 대상, OTP를 쓰지 않음 — 세션 쿠키만 사용):
#   MYHUB_SESSION_COOKIE='myhub_session=<PIN 로그인 후 받은 쿠키 값>' bash tests/evals/run-eval.sh
#   MYHUB_SESSION_COOKIE='...' bash tests/evals/run-eval.sh --filter 'news-freshness'  # promptfoo 인자 전달 가능
#
# 쿠키를 인자로 넘기기 (환경변수 대신):
#   bash tests/evals/run-eval.sh --session-cookie 'myhub_session=...'
#
# 로컬 검증 (라이브 호출 없음, mock 프로바이더):
#   bash tests/evals/run-eval.sh --validate
#
# 결과 JSON: tests/evals/results/promptfoo-<타임스탬프>.json (gitignore 대상)
# 종료 코드: promptfoo eval과 동일 (실패 케이스가 있으면 0이 아님).

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

CONFIG="tests/evals/promptfooconfig.yaml"
VALIDATE=0
SESSION_COOKIE="${MYHUB_SESSION_COOKIE:-}"
EXTRA_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --validate)
      VALIDATE=1
      shift
      ;;
    --session-cookie)
      SESSION_COOKIE="${2:-}"
      shift 2
      ;;
    --session-cookie=*)
      SESSION_COOKIE="${1#--session-cookie=}"
      shift
      ;;
    --help|-h)
      sed -n '2,20p' "$SCRIPT_DIR/run-eval.sh"
      exit 0
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

if [ "$VALIDATE" -eq 1 ]; then
  CONFIG="tests/evals/promptfooconfig.validate.yaml"
else
  if [ -z "$SESSION_COOKIE" ]; then
    echo "오류: MYHUB_SESSION_COOKIE 환경변수 또는 --session-cookie 인자가 필요합니다." >&2
    echo "PIN 로그인 후 myhub_session 쿠키 값을 넘기세요. 자세한 방법: tests/evals/README.md" >&2
    exit 2
  fi
  export MYHUB_SESSION_COOKIE="$SESSION_COOKIE"
fi

export MYHUB_BASE_URL="${MYHUB_BASE_URL:-https://myhub.myhub-app.workers.dev}"

if ! command -v npx >/dev/null 2>&1; then
  echo "오류: npx를 찾을 수 없습니다 (Node.js 필요)." >&2
  exit 2
fi

mkdir -p tests/evals/results
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="tests/evals/results/promptfoo-${STAMP}.json"

echo "config: $CONFIG"
echo "baseUrl: $MYHUB_BASE_URL"
echo "output: $OUT"
npx promptfoo eval --config "$CONFIG" --no-cache --output "$OUT" "${EXTRA_ARGS[@]}"
STATUS=$?

if [ $STATUS -eq 0 ]; then
  echo "EVAL PASS (결과: $OUT)"
else
  echo "EVAL FAIL (종료 코드 $STATUS, 결과: $OUT)" >&2
fi
exit $STATUS
