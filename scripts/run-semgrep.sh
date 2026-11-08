#!/usr/bin/env bash
# MyHub Semgrep 정적 보안 스캔
# 사용법:
#   bash scripts/run-semgrep.sh            # 전체 스캔 (텍스트 출력)
#   bash scripts/run-semgrep.sh --json     # JSON 출력 (docs 기록용)
#   bash scripts/run-semgrep.sh --sarif    # SARIF 출력
# semgrep 설치: python3 -m venv ~/.venvs/myhub-semgrep && ~/.venvs/myhub-semgrep/bin/pip install semgrep
# (버전은 docs/semgrep-YYYYMMDD.md에 기록)
set -euo pipefail
cd "$(dirname "$0")/.."

SEMGREP="${SEMGREP_BIN:-$HOME/.venvs/myhub-semgrep/bin/semgrep}"
if ! [ -x "$SEMGREP" ]; then
  if command -v semgrep >/dev/null 2>&1; then
    SEMGREP="$(command -v semgrep)"
  else
    echo "semgrep을 찾을 수 없습니다. SEMGREP_BIN 환경변수를 지정하거나 ~/.venvs/myhub-semgrep에 설치하세요." >&2
    echo "  python3 -m venv ~/.venvs/myhub-semgrep && ~/.venvs/myhub-semgrep/bin/pip install semgrep" >&2
    exit 1
  fi
fi

# 제외: 백업 데이터(사용자 데이터 수출물, 코드 아님), 생성 번들/산출물(원본을 스캔),
# 스크래치 실험 코드(운영 코드 아님)
EXCLUDES=(
  --exclude 'backups/'
  --exclude 'coverage/'
  --exclude 'dist/'
  --exclude '.wrangler/'
  --exclude 'node_modules/'
  --exclude '.scratch/'
  --exclude '*-bundle.cjs'
  --exclude '*-bundle.js'
  --exclude 'src/index-inline.ts'
)

FORMAT=text
OUT_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --json)  FORMAT=json ;;
    --sarif) FORMAT=sarif ;;
    *) echo "알 수 없는 옵션: $arg (허용: --json, --sarif)" >&2; exit 1 ;;
  esac
done

if [ "$FORMAT" = json ]; then OUT_ARGS=(--json); fi
if [ "$FORMAT" = sarif ]; then OUT_ARGS=(--sarif); fi

exec "$SEMGREP" scan \
  --config p/security-audit \
  --config p/secrets \
  --config p/javascript \
  --config p/typescript \
  --config .semgrep/myhub-rules.yaml \
  "${EXCLUDES[@]}" \
  "${OUT_ARGS[@]}" \
  .
