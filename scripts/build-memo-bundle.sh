#!/bin/bash
# memo-bundle.js 빌드 스크립트 (DEPLOY-002 수정)
# 원본: public/js/memo/*.js → 출력: public/js/memo-bundle.js
set -e

cd "$(dirname "$0")/.."

# 번들 순서 (원본 번들과 동일)
ORDER=(
  "public/js/memo/utils.js"        # 섹션 1
  "public/js/memo/header.js"       # 섹션 없음 (전역)
  "public/js/memo/editor-toolbar.js" # 섹션 2
  "public/js/memo/md.js"           # 섹션 3
  "public/js/memo/composer.js"     # 섹션 4
  "public/js/memo/filter.js"       # 섹션 5
  "public/js/memo/tags.js"         # 섹션 6
  "public/js/memo/calendar.js"     # 섹션 7
  "public/js/memo/list.js"         # 섹션 8
  "public/js/memo/inedit.js"       # 섹션 9
  "public/js/memo/imgtools.js"     # 섹션 10
  "public/js/memo/lightbox.js"     # 섹션 11
  "public/js/memo/editor-core.js"  # 섹션 없음
  "public/js/memo/toolbar.js"      # 섹션 없음
  "public/js/memo/pane.js"         # 섹션 없음
  "public/js/memo/init.js"         # 섹션 11 (시작)
)

OUTPUT="public/js/memo-bundle.js"

echo "Building $OUTPUT..."
> "$OUTPUT"
for f in "${ORDER[@]}"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: $f not found" >&2
    exit 1
  fi
  cat "$f" >> "$OUTPUT"
  echo "" >> "$OUTPUT"
done

# 문법 검증
npx esbuild "$OUTPUT" --bundle --format=iife --outfile=/dev/null 2>&1 | head -3
if [ $? -eq 0 ]; then
  echo "BUILD PASS: $OUTPUT"
else
  echo "BUILD FAIL" >&2
  exit 1
fi
