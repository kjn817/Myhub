#!/usr/bin/env bash
# MyHub E2E 테스트 — API 전체 플로우 검증
# 사용법: ./scripts/e2e.sh [base_url]
# 테스트 데이터는 모두 정리하고 종료한다. 실패 시 0이 아닌 코드로 종료.
set -u
BASE="${1:-https://myhub.myhub-app.workers.dev}"
PASS=0; FAIL=0

# 쿼리스트링 한글 인코딩 (curl은 raw UTF-8을 보내면 엣지에서 연결이 끊김)
urlencode() { python3 -c "import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))" "$1"; }

ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

echo "== MyHub E2E: $BASE =="

# 1. 헬스체크
echo "-- health --"
[ "$(curl -s "$BASE/api/health" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))")" = "True" ] \
  && ok "health ok" || fail "health"

# 2. 메모 생성 (JSON)
echo "-- create --"
MID=$(curl -s -X POST "$BASE/api/memo" -H 'Content-Type: application/json' \
  -d '{"text":"e2e 검증용 고유문자열_zz9"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
[ -n "$MID" ] && [ "$MID" != "" ] && ok "created memo $MID" || { fail "create memo"; MID=""; }

# 3. 검색 (본문)
echo "-- search --"
FOUND=$(curl -s "$BASE/api/memo?q=$(urlencode "고유문자열_zz9")" | python3 -c "
import sys,json
ds=json.load(sys.stdin); print('yes' if any('고유문자열_zz9' in d.get('text','') for d in ds) else 'no')")
[ "$FOUND" = "yes" ] && ok "search found" || fail "search"

# 4. 수정 (PUT) + 재검색
echo "-- update --"
if [ -n "$MID" ]; then
  curl -s -X PUT "$BASE/api/memo/$MID" -H 'Content-Type: application/json' \
    -d '{"text":"e2e 수정됨_qq8"}' | grep -q '"ok":true' && ok "put ok" || fail "put"
  sleep 2
  FOUND2=$(curl -s "$BASE/api/memo?q=$(urlencode "수정됨_qq8")" | python3 -c "
import sys,json
ds=json.load(sys.stdin); print('yes' if any('수정됨_qq8' in d.get('text','') for d in ds) else 'no')")
  [ "$FOUND2" = "yes" ] && ok "search after update" || fail "search after update"
fi

# 5. 파일 업로드 (이미지) + 목록/썸네일/다운로드
echo "-- file upload --"
python3 -c "
from PIL import Image, ImageDraw
img = Image.new('RGB', (200, 150), color=(246,130,31))
ImageDraw.Draw(img).text((40, 65), 'E2E', fill=(255,255,255))
img.save('/tmp/myhub-e2e.png')" 2>/dev/null || echo "  (PIL 없음 — 업로드 단계 건너뜀)"
if [ -f /tmp/myhub-e2e.png ] && [ -n "$MID" ]; then
  FID=$(curl -s -X POST "$BASE/api/memo/$MID/files" -F "files=@/tmp/myhub-e2e.png" \
    | python3 -c "import sys,json; fs=json.load(sys.stdin).get('files',[]); print(fs[0]['id'] if fs else '')")
  [ -n "$FID" ] && ok "uploaded file $FID" || fail "upload file"
  if [ -n "$FID" ]; then
    curl -s "$BASE/api/memo/$MID/files" | python3 -c "
import sys,json
fs=json.load(sys.stdin); f=fs[0] if fs else {}
assert f.get('url','').startswith('https://'), 'no url'
assert f.get('thumb','').startswith('https://'), 'no thumb'
print('urls ok')" >/dev/null 2>&1 && ok "file list has url+thumb" || fail "file list urls"
    CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/memo/files/$FID")
    [ "$CODE" = "302" ] && ok "download redirects (302)" || fail "download redirect ($CODE)"
    # 파일명으로 검색
    FF=$(curl -s "$BASE/api/memo?q=$(urlencode "myhub-e2e.png")" | python3 -c "
import sys,json
ds=json.load(sys.stdin); print('yes' if any(d.get('id')==$MID for d in ds) else 'no')")
    [ "$FF" = "yes" ] && ok "filename search" || fail "filename search"
    # 파일 삭제
    curl -s -X DELETE "$BASE/api/memo/files/$FID" | grep -q '"ok":true' \
      && ok "file deleted" || fail "file delete"
  fi
  rm -f /tmp/myhub-e2e.png
fi

# 5c. 인라인 이미지 마커 (WYSIWYG 저장 포맷: ![이름](file:ID))
echo "-- inline image marker --"
MID2=$(curl -s -X POST "$BASE/api/memo" -H 'Content-Type: application/json' \
  -d '{"text":"마커테스트_qq9"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
if [ -n "$MID2" ]; then
  python3 -c "
from PIL import Image, ImageDraw
img = Image.new('RGB', (120, 90), color=(37,99,235))
ImageDraw.Draw(img).text((30, 35), 'E2E2', fill=(255,255,255))
img.save('/tmp/myhub-e2e2.png')" 2>/dev/null
  if [ -f /tmp/myhub-e2e2.png ]; then
    FID2=$(curl -s -X POST "$BASE/api/memo/$MID2/files" -F "files=@/tmp/myhub-e2e2.png" \
      | python3 -c "import sys,json; fs=json.load(sys.stdin).get('files',[]); print(fs[0]['id'] if fs else '')")
    if [ -n "$FID2" ]; then
      curl -s -X PUT "$BASE/api/memo/$MID2" -H 'Content-Type: application/json' \
        -d "{\"text\":\"마커본문_qq9 위에 텍스트\\n\\n![myhub-e2e2.png|250](file:$FID2)\\n\\n아래 텍스트 #e2emark\"}" >/dev/null
      MARK=$(curl -s "$BASE/api/memo?q=$(urlencode "마커본문_qq9")" | FID2="$FID2" python3 -c "
import sys,json,os
ds=json.load(sys.stdin); t=ds[0]['text'] if ds else ''
print('yes' if '(file:%s)'%os.environ['FID2'] in t and '|250' in t and '#e2emark' in t else 'no')")
      [ "$MARK" = "yes" ] && ok "marker saved in text (with width)" || fail "marker save"
      TAGM=$(curl -s "$BASE/api/memo?tag=e2emark" | MID2="$MID2" python3 -c "
import sys,json,os
ds=json.load(sys.stdin); print('yes' if any(d.get('id')==int(os.environ['MID2']) for d in ds) else 'no')")
      [ "$TAGM" = "yes" ] && ok "tag filter with marker" || fail "tag with marker"
    else
      fail "marker image upload"
    fi
    rm -f /tmp/myhub-e2e2.png
  fi
  curl -s -X DELETE "$BASE/api/memo/$MID2" | grep -q '"ok":true' \
    && ok "marker memo cleaned" || fail "marker cleanup"
fi

# 5d. 태그 + 달력 + 날짜필터
echo "-- tags/calendar --"
if [ -n "$MID" ]; then
  curl -s -X PUT "$BASE/api/memo/$MID" -H 'Content-Type: application/json' \
    -d '{"text":"e2e 태그검증_qq8 #e2etag1 #e2etag2"}' >/dev/null
  sleep 1
  TAGOK=$(curl -s "$BASE/api/memo/tags" | python3 -c "
import sys,json
ts={t['tag']:t['n'] for t in json.load(sys.stdin)}
print('yes' if ts.get('e2etag1',0)>=1 and ts.get('e2etag2',0)>=1 else 'no')")
  [ "$TAGOK" = "yes" ] && ok "tags api lists new tags" || fail "tags api"
  TAGF=$(curl -s "$BASE/api/memo?tag=e2etag1" | python3 -c "
import sys,json
ds=json.load(sys.stdin); print('yes' if any(d.get('id')==$MID for d in ds) else 'no')")
  [ "$TAGF" = "yes" ] && ok "tag filter" || fail "tag filter"
  # 날짜 필터 (KST 기준 오늘)
  TODAY=$(TZ=Asia/Seoul date +%F)
  DATEF=$(curl -s "$BASE/api/memo?date=$TODAY" | python3 -c "
import sys,json
ds=json.load(sys.stdin); print('yes' if any(d.get('id')==$MID for d in ds) else 'no')")
  [ "$DATEF" = "yes" ] && ok "date filter ($TODAY)" || fail "date filter"
  # 달력 카운트
  YM=$(TZ=Asia/Seoul date +"%Y %m")
  CALOK=$(curl -s "$BASE/api/memo/calendar?y=${YM% *}&m=${YM#* }" | TODAY="$TODAY" python3 -c "
import sys,json,os
ds={d['day']:d['n'] for d in json.load(sys.stdin)}
print('yes' if ds.get(os.environ['TODAY'],0)>=1 else 'no')")
  [ "$CALOK" = "yes" ] && ok "calendar counts" || fail "calendar counts"
fi

# 6. 통계 API
echo "-- stats --"
curl -s "$BASE/api/memo/stats" | python3 -c "
import sys,json
s=json.load(sys.stdin); assert isinstance(s.get('memos'),int); print('stats ok')" >/dev/null 2>&1 \
  && ok "stats api" || fail "stats api"

# 7. 메모 삭제 + 정리 확인
echo "-- cleanup --"
if [ -n "$MID" ]; then
  curl -s -X DELETE "$BASE/api/memo/$MID" | grep -q '"ok":true' && ok "memo deleted" || fail "memo delete"
  sleep 1
  GONE=$(curl -s "$BASE/api/memo?q=$(urlencode "수정됨_qq8")" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
  [ "$GONE" = "0" ] && ok "cleanup verified" || fail "cleanup ($GONE left)"
  TAGGONE=$(curl -s "$BASE/api/memo?tag=e2etag1" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
  [ "$TAGGONE" = "0" ] && ok "tag cleanup verified" || fail "tag cleanup ($TAGGONE left)"
fi

echo ""
echo "== 결과: PASS $PASS / FAIL $FAIL =="
[ "$FAIL" = "0" ]
