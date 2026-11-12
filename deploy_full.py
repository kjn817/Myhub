#!/usr/bin/env python3
"""MyHub 전체 배포: 정적 파일 ASSETS 업로드 + 캐시 무효화(?v=) + esbuild 번들 + Worker 업로드 (바인딩 포함).

정식 사용법 (단일 경로): python3 deploy_full.py production

정적 파일은 번들에 인라인하지 않고 Cloudflare Static Assets로 업로드한다
(audit P-1, 2026-10-28 — 번들 4.2 MB → 약 1.8 MB). NODE_GEN이
scripts/static-assets.json 집합을 .deploy-assets/ 스테이징에 복사(?v= 변환 포함)
하고, upload_assets()가 Direct Uploads 3단계로 업로드한 뒤 Worker 업로드
메타데이터에 assets.jwt + run_worker_first:true + ASSETS 바인딩을 함께 넣는다.
run_worker_first가 없으면 에셋이 인증 미들웨어를 우회하므로 필수다.

DEPLOY-003 개정 (2026-10-21): 환경변수 게이트(MYHUB_ALLOW_IMMEDIATE_DEPLOY) 제거.
- 후보 버전(POST /versions) 방식은 secret_text 바인딩을 유지할 수 없어 채택 불가
  (실측: name-only secret은 text 필수로 400/code 10021, keep_bindings는 무시됨).
  PUT 업로드 + keep_bindings가 Secrets를 보존하는 유일한 경로다.
- 대신 안전장치를 스크립트에 내장했다: 업로드 전 활성 버전 기록 →
  업로드 → 명시 승격 → 라이브 검증 → 실패 시 이전 버전으로 자동 롤백.
  (버전 바인딩 API 조회는 런타임 secret 가용성을 반영하지 않아 게이트로 쓰지 않는다.)
- 시크릿 소실 가드 (2026-10-22 추가): 업로드 전후로 스크립트 시크릿 '이름' 목록을
  비교해, 업로드로 사라진 이름이 있으면 승격하지 않고 중단+이전 버전 재확인.
  2026-10-21 사고(keep_bindings 없는 업로드 3회가 시크릿 세트를 교체)의 재발 방지용.
- verify 모드 (2026-10-29 추가): `python3 deploy_full.py verify` — 업로드·승격·
  스케줄 등록 등 변경 API를 일절 호출하지 않고(GET·읽기 전용), 현재 라이브의
  활성 버전·시크릿 이름·Cron 스케줄·라이브 QA만 검증한다. 배포 중단 후
  "현재 라이브가 정상인가"를 확인할 때 쓴다. production 흐름과 독립 진입점이다.
"""
import sys, json, subprocess, urllib.request, urllib.error, base64, hashlib, mimetypes
from pathlib import Path

sys.path.insert(0, '/opt/hatch/skills/skill-creator/bin')
from dynamic_credentials import add_surrogate_to_request, read_json_response

CREDENTIAL = 'custom.cloudflare'
ALLOWED_HOSTS = ['api.cloudflare.com']
BASE = 'https://api.cloudflare.com/client/v4'
ACCOUNT_ID = '59e749ed2e9cdb8b0bf70d47227968a1'

# 배포 대상 설정 (단일 환경: myhub)
TARGETS = {
    'production': {
        'SCRIPT_NAME': 'myhub',
        'BASE_URL': 'https://myhub.myhub-app.workers.dev',
        'DB_ID': '0dd871c5-3d1c-4cea-bfbe-3e258f477106',
        'KV_ID': '83d3e9027c9145ae89c15df3bdee9999',
        'ENVIRONMENT': 'production',
        'APP_NAME': 'MyHub',
    },
}

# verify 모드 (검증 전용, 2026-10-29): 'verify' 인자는 아래 기존 파싱을 그대로
# 통과시키기 위해 'production'으로 정규화한다. 실제 분기는 파일 끝 __main__
# 블록 앞의 독립 진입점에서 일어나며, main()(배포 흐름)은 실행되지 않는다.
VERIFY_ONLY = len(sys.argv) >= 2 and sys.argv[1] == 'verify'
if VERIFY_ONLY:
    sys.argv[1] = 'production'

# 명령줄 인자로 대상 지정 (필수)
if len(sys.argv) < 2 or sys.argv[1] not in TARGETS:
    print(f"사용법: {sys.argv[0]} <staging|production>", file=sys.stderr)
    print("대상 지정을 생략하면 배포를 거부합니다.", file=sys.stderr)
    sys.exit(1)

TARGET = sys.argv[1]
CONFIG = TARGETS[TARGET]
SCRIPT_NAME = CONFIG['SCRIPT_NAME']

project = Path('/home/hatch/workspace/myhub')

NODE_GEN = r'''
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
let ts = fs.readFileSync("./src/index.ts", "utf-8");
const marker = "// [STATIC_INJECT]";
if (!ts.includes(marker)) { console.error("MARKER NOT FOUND"); process.exit(1); }
const pub = "./public";
// 업로드 집합의 유일한 기준 (scripts/static-assets.json — 테스트도 같은 파일을 읽는다)
const assetList = JSON.parse(fs.readFileSync("./scripts/static-assets.json", "utf-8"));
const files = assetList.files;
const versioned = new Set(assetList.versioned);
// 캐시 무효화용 콘텐츠 기반 버전: 업로드 파일 중 하나라도 바뀌면 버전이 바뀜
const staticBufs = files.map((p) => fs.readFileSync(pub + p));
const AV = crypto.createHash("sha1").update(Buffer.concat(staticBufs)).digest("hex").slice(0, 8);
// HTML/manifest 안의 로컬 정적 에셋 참조에 ?v= 버전을 붙여 구버전 캐시 무효화.
// 부착 기준은 scripts/asset-version.cjs의 createVersioner — 매니페스트 집합
// 전체가 기준이다 (고정 목록 시절 목록에 없던 데스크톱 에셋이 빠져 구버전
// 캐시가 계속 실행된 2026-11-01 사고의 재발 방지. 회귀 가드는
// tests/asset-version.test.ts). 새 에셋은 매니페스트 등록만으로 자동 포함된다.
// 주의: NODE_GEN은 plain node로 실행되므로 require 대상은 반드시 .cjs다
// (package.json "type": "module"이라 .js는 ESM으로 해석돼 실패한다).
const { createVersioner } = require("./scripts/asset-version.cjs");
const ver = createVersioner(assetList, AV);
// 스테이징 디렉토리: ?v= 변환본을 담은 업로드용 복사본 (public/ 원본은 절대 수정하지 않음)
const staging = "./.deploy-assets";
fs.rmSync(staging, { recursive: true, force: true });
for (const p of files) {
  const src = fs.readFileSync(pub + p);
  const dst = path.join(staging, p);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, versioned.has(p) ? ver(src.toString("utf-8")) : src);
}
// 정적 파일은 ASSETS 바인딩으로만 서빙한다 — 번들에 base64 인라인을 두지 않는다.
const routes = "// Static served via ASSETS binding (asset ver "+AV+")\n" + marker;
ts = ts.replace(marker, routes);
fs.writeFileSync("./src/index-inline.ts", ts);
console.log("written");
console.log("ASSET_VER=" + AV);
console.log("ASSETS_DIR=" + staging);
'''

# 85차: urllib의 chunked 응답 처리 문제를 우회하기 위한 헬퍼
# Python urllib은 Cloudflare의 Transfer-Encoding: chunked 응답에서
# IncompleteRead(partial=0 bytes)가 발생함. curl은 정상 동작.
def _fetch_with_curl(url, timeout=30):
    """curl을 사용한 HTTP GET. Returns (status, body_bytes, headers_dict) or (None, None, {})."""
    import tempfile, os
    headers_file = tempfile.mktemp()
    body_file = tempfile.mktemp()
    try:
        result = subprocess.run(
            ['curl', '--http1.1', '-s', '-A', 'MyHubDeploy/1.0',
             '-H', 'Accept-Encoding: identity',
             '-D', headers_file, '-o', body_file,
             '-w', '%{http_code}', '--max-time', str(timeout), url],
            capture_output=True, text=True, timeout=timeout+5)
        if result.returncode != 0:
            return None, None, {}
        try:
            status = int(result.stdout.strip().split('\n')[-1])
        except:
            return None, None, {}
        with open(body_file, 'rb') as f:
            body = f.read()
        headers = {}
        try:
            with open(headers_file, 'r', encoding='utf-8', errors='ignore') as f:
                for line in f:
                    if ':' in line:
                        k, v = line.split(':', 1)
                        headers[k.strip()] = v.strip()
        except:
            pass
        return status, body, headers
    except Exception:
        return None, None, {}
    finally:
        for fp in (headers_file, body_file):
            try: os.remove(fp)
            except: pass

def _fetch_url(url, timeout=30, max_retries=3):
    """URL 본문 가져오기. urllib 시도 후 chunked 문제 시 curl 폴백.
    Returns (status_code, body_bytes, headers_dict) or (None, None, {})."""
    import http.client, socket, time
    headers = {'User-Agent': 'MyHubDeploy/1.0', 'Accept-Encoding': 'identity'}
    for attempt in range(1, max_retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.read(), dict(r.headers.items())
        except (http.client.IncompleteRead, http.client.RemoteDisconnected,
                ConnectionResetError, socket.timeout, TimeoutError,
                urllib.error.URLError, OSError) as e:
            print(f"    [urllib 실패 {attempt}/{max_retries}: {type(e).__name__}, curl 폴백]",
                  file=sys.stderr)
            status, body, resp_headers = _fetch_with_curl(url, timeout)
            if status is not None and body is not None:
                print(f"    [curl 성공: HTTP {status}, {len(body)} bytes]", file=sys.stderr)
                return status, body, resp_headers
            if attempt < max_retries:
                time.sleep(2 ** (attempt - 1))
        except urllib.error.HTTPError as e:
            return e.code, b'', dict(e.headers.items()) if e.headers else {}
        except Exception as e:
            print(f"    [오류: {type(e).__name__}: {e}]", file=sys.stderr)
            if attempt < max_retries:
                time.sleep(2 ** (attempt - 1))
    return None, None, {}

def verify_deployment(project, base_url, asset_ver, assets_dir=None):
    """배포 후 검증. 전체 PASS면 True, 하나라도 FAIL이면 False.

    정적 에셋 검증은 두 층위로 분리한다 (2026-10-13):
    (a) 공개 에셋 /manifest.json: 미인증 200 + immutable 헤더 + 서빙 본문이
        이번에 업로드한 스테이징 에셋(.deploy-assets/manifest.json)과 바이트 일치
        (ver() 변환 포함 — 스테이징 파일이 곧 업로드된 바이트다)
    (b) 보호 에셋 /shell.css: 미인증 302 → Location /login.html (인증 보호 PASS)
        보호 에셋의 본문 검증은 인증 세션이 필요하므로 스크립트 범위 밖 → 사용자 PC 브라우저 QA 트랙
    """
    import time
    time.sleep(2)

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    _nr_opener = urllib.request.build_opener(_NoRedirect)

    checks = {
        '/api/health': 200,
        '/wallpaper.webp': 200,
        '/icon-192.png': 200,
        '/apple-touch-icon.png': 200,
        '/manifest.json': 200,
    }
    failed = False
    # 85차: urllib chunked 문제 우회를 위해 _fetch_url 사용
    for path, want in checks.items():
        code, _, _ = _fetch_url(base_url + path + '?vfy=1', timeout=15)
        if code is None:
            code = 'ERR fetch failed'
        ok = (code == want)
        print(f"  verify {path}: {code} {'OK' if ok else 'FAIL'}", file=sys.stderr)
        if not ok:
            failed = True
    # (a) 공개 에셋 본문 검증 — 이번에 업로드한 스테이징 에셋 기준 (실제 파일 검증, 인증 불필요)
    # 85차: _fetch_url 사용 (curl 폴백 포함)
    try:
        staging_dir = Path(assets_dir) if assets_dir else project / ASSETS_DIR_NAME
        expected_body = (staging_dir / 'manifest.json').read_bytes()
        man_code, man_body, man_headers = _fetch_url(base_url + '/manifest.json?vfy=1', timeout=15)
        man_cc = man_headers.get('Cache-Control', '') if man_headers else ''
        if man_code is None:
            ok, detail = False, 'ERR fetch failed'
        else:
            body_match = (expected_body is not None and man_body == expected_body)
            ok = ('immutable' in man_cc) and body_match
            detail = f"cc={man_cc!r} body_match={body_match}"
    except Exception as e:
        ok, detail = False, f'ERR {e}'
    print(f"  verify /manifest.json (public static): {detail} {'OK' if ok else 'FAIL'}", file=sys.stderr)
    if not ok:
        failed = True
    # (b) 보호 에셋 인증 보호 검증 — 미인증 302가 정상 (FAIL이 아님)
    # 85차: curl 사용 (리다이렉트 미추적, urllib chunked 문제 우회)
    try:
        css_code, _, css_headers = _fetch_with_curl(base_url + '/shell.css?vfy=1', timeout=15)
        css_loc = css_headers.get('Location', '') if css_headers else ''
        if css_code is None:
            ok, detail = False, 'ERR fetch failed'
        else:
            ok = (css_code == 302) and ('/login.html' in css_loc)
            detail = f"{css_code} loc={css_loc!r}"
    except Exception as e:
        ok, detail = False, f'ERR {e}'
    print(f"  verify /shell.css (unauth -> login): {detail} {'OK' if ok else 'FAIL'}", file=sys.stderr)
    if not ok:
        failed = True
    # /api/system은 인증 필요 → 401이어야 정상
    # 85차: _fetch_url 사용
    sys_code, _, _ = _fetch_url(base_url + '/api/system?vfy=1', timeout=15)
    if sys_code is None:
        sys_code = 'ERR fetch failed'
    ok = (sys_code == 401)
    print(f"  verify /api/system (unauth): {sys_code} {'OK' if ok else 'FAIL'}", file=sys.stderr)
    if not ok:
        failed = True
    # / (no auth) → 로그인 리다이렉트(302)여야 정상
    # 85차: curl 사용 (리다이렉트 미추적)
    page_code, _, _ = _fetch_with_curl(base_url + '/?vfy=1', timeout=15)
    if page_code is None:
        page_code = 'ERR fetch failed'
    ok = (page_code == 302)
    print(f"  verify / (unauth): {page_code} {'OK' if ok else 'FAIL'}", file=sys.stderr)
    if not ok:
        failed = True
    # 콘텐츠 검증: /login.html(공개·no-cache) 본문에 이번 배포의 에셋 버전(?v=)이 있어야 함.
    # 상태 코드만으로는 구버전 Worker가 계속 서빙되는지 알 수 없어서, 실제 본문으로 반영 확인.
    # 85차: urllib chunked 문제 우회를 위해 _fetch_url 사용 (curl 폴백 포함)
    if asset_ver:
        marker = f'?v={asset_ver}'
        login_code, login_body_bytes, _ = _fetch_url(base_url + '/login.html?vfy=1', timeout=30)
        if login_code is None:
            login_code = 'ERR fetch failed'
            login_body = ''
        else:
            login_body = login_body_bytes.decode('utf-8', 'replace') if login_body_bytes else ''
        ok = (login_code == 200 and marker in login_body)
        print(f"  verify /login.html content {marker!r}: {login_code} {'OK' if ok else 'FAIL'}", file=sys.stderr)
        if not ok:
            failed = True
    if failed:
        print("DEPLOY VERIFY FAIL — 배포 검증 실패", file=sys.stderr)
        print("검증 실패: 호출자가 이전 버전으로 자동 롤백합니다.", file=sys.stderr)
        return False
    print("DEPLOY VERIFY PASS")
    return True

# ---------------------------------------------------------------------------
# 배포 안전장치 헬퍼 (DEPLOY-003 개정, 2026-10-21)
# PUT 업로드는 즉시 활성화되므로, 안전성은 사후 검증 + 자동 롤백으로 확보한다.
# ---------------------------------------------------------------------------

def api_json(method, path, payload=None):
    """Cloudflare API JSON 호출. 성공 시 result, 실패 시 None."""
    url = BASE + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    add_surrogate_to_request(req, CREDENTIAL, allowed_hosts=ALLOWED_HOSTS)
    try:
        with urllib.request.urlopen(req) as resp:
            result = read_json_response(resp)
        return result.get('result') if result.get('success') else None
    except Exception:
        return None

def get_active_version_id():
    """현재 100% 트래픽을 서빙 중인 버전 ID (롤백 대상). 없으면 None."""
    result = api_json('GET', f'/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}/deployments')
    if not result:
        return None
    for dep in result.get('deployments', []):
        for v in dep.get('versions', []):
            if v.get('percentage') == 100 and v.get('version_id'):
                return v['version_id']
    return None

def get_latest_version_id():
    """가장 최근에 업로드된 버전 ID. 없으면 None."""
    result = api_json('GET', f'/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}/versions?page=1&per_page=1')
    if not result:
        return None
    items = result.get('items', [])
    return items[0]['id'] if items else None

def wait_for_new_version(prev_version_id, timeout=90, interval=3):
    """PUT 직후 새 버전 ID가 versions 목록에 나타날 때까지 폴링한다.

    2026-11-12 실측: PUT이 버전 1185(80dd0313)를 만들고 즉시 활성화했는데도
    직후 get_latest_version_id()는 stale한 1184(896b514d)를 반환했다. 스크립트는
    그 stale ID를 승격했고, 라이브 검증은 구버전 에셋을 보고 실패해 a2702ca4로
    롤백됐다. versions 목록의 eventual consistency lag이 원인이며, 승격 전
    새 ID가 목록 최상단에 나타나는 것을 확인하는 것이 유일한 방책이다.
    타임아웃 시 None을 반환한다 (호출자가 폴백·종료 판단)."""
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        latest = get_latest_version_id()
        if latest and latest != prev_version_id:
            return latest
        time.sleep(interval)
    return None


def deploy_version(version_id):
    """지정 버전을 100%로 배포 (승격·롤백 공용). 성공 여부 반환."""
    result = api_json('POST', f'/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}/deployments',
                      {'strategy': 'percentage',
                       'versions': [{'version_id': version_id, 'percentage': 100}]})
    return result is not None


# Cron 트리거 (5분 틱) — src/index.ts scheduled 핸들러 기동용.
# 2026-10-26 실측: versions 업로드 메타데이터의 'triggers' 필드는 schedules를
# 등록하지 않는다 (triggers를 넣고 배포해도 GET schedules는 빈 배열).
# schedules API(PUT /workers/scripts/{name}/schedules, 본문은 [{"cron": ...}]
# 배열 — {"crons": [...]}나 ["..."]는 400)가 유일한 등록 경로다.
CRON_SCHEDULES = ['*/5 * * * *']


def ensure_cron_schedules():
    """Cron 트리거 등록 + GET 재확인. 성공 여부 반환.

    실패해도 배포 자체를 롤백하지 않는다 — 트리거 누락은 배포 실패가 아니라
    별도 경고로 남기고, 다음 배포에서 다시 시도한다.
    """
    path = f'/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}/schedules'
    body = [{'cron': c} for c in CRON_SCHEDULES]
    result = api_json('PUT', path, body)
    if result is None:
        print("  경고: Cron 트리거 등록(PUT schedules) 실패 — schedules API로 직접 등록 필요", file=sys.stderr)
        return False
    check = api_json('GET', path)
    if check is None:
        print("  경고: Cron 트리거 재확인(GET schedules) 실패", file=sys.stderr)
        return False
    got = sorted(s.get('cron') for s in check.get('schedules', []))
    if got != sorted(CRON_SCHEDULES):
        print(f"  경고: Cron 트리거 불일치 — 기대 {CRON_SCHEDULES}, 실제 {got}", file=sys.stderr)
        return False
    print(f"  Cron 트리거 확인: {got}", file=sys.stderr)
    return True

def get_secret_names():
    """스크립트 시크릿 '이름' 집합 (값은 절대 조회하지 않음). 조회 실패 시 None.

    이 목록은 스크립트 레벨 시크릿 저장소(= 최신 lineage)를 반영한다 —
    2026-10-21 복구 과정에서 5→6→7→8로 누적되는 것이 실측으로 확인됐다.
    (버전별 바인딩 조회와 달리 이 목록은 게이트로 쓸 수 있다.)
    """
    result = api_json('GET', f'/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}/secrets')
    if result is None:
        return None
    try:
        return {item['name'] for item in result}
    except Exception:
        return None

def missing_secrets(before, after):
    """업로드 전후 비교로 사라진 시크릿 이름 집합.

    한쪽이라도 조회 실패(None)면 판단 불가로 보고 빈 집합을 돌려준다 —
    조회 실패 자체로 배포를 막지 않는다. 단, 조회가 성공했는데 이름이
    사라졌으면 그건 실제 소실이므로 호출자가 배포를 중단해야 한다.
    """
    if before is None or after is None:
        return set()
    return set(before) - set(after)

# ---------------------------------------------------------------------------
# verify 모드 (검증 전용, 2026-10-29 — P2 트랙 4)
# 배경: 2026-10-29 배포 중 서비스 재시작으로 스크립트가 중단됐을 때 내장
# 검증·롤백 단계를 수동으로 대체해야 했다. 중단 이후 "현재 라이브 상태가
# 정상인지"만 확인할 읽기 전용 수단이 필요해 추가했다.
# 읽기 전용 보장: 이 모드가 호출하는 것은 Cloudflare API의 GET
# (deployments·secrets·schedules)과 라이브 URL GET뿐이다. 업로드(PUT 스크립트·
# POST assets)·승격(POST deployments)·스케줄 등록(PUT schedules)은 일절
# 호출하지 않으며, deploy_version·ensure_cron_schedules·upload_assets 경로는
# 사용하지 않는다. 시크릿은 '이름'만 조회한다 (값 조회 API 자체가 없음 —
# get_secret_names와 동일한 표면).
# ---------------------------------------------------------------------------

# verify가 '반드시 있어야 한다'고 보는 핵심 시크릿 이름 (값은 조회하지 않는다).
# 근거: SESSION_SECRET(세션 서명)·RESEND_API_KEY(OTP 메일 발송)·
# MEMO_ENCRYPTION_KEY(잠긴 메모 암복호화)·GEMINI_API_KEY_1(주 AI 키 풀) —
# 하나라도 사라지면 로그인·메일·암호화·AI 중 하나가 즉시 깨지는 세트다
# (2026-10-21 소실 사고에서 복구가 필요했던 핵심과 같다). 그 밖의 이름은
# lineage에 누적될 수 있어 전체 목록을 출력만 하고 강제하지 않는다.
REQUIRED_SECRET_NAMES = {'SESSION_SECRET', 'RESEND_API_KEY',
                         'MEMO_ENCRYPTION_KEY', 'GEMINI_API_KEY_1'}


def check_secret_names(names, required=REQUIRED_SECRET_NAMES):
    """시크릿 이름 목록 판정 (순수 함수). (ok, detail) 반환.

    조회 실패(None)면 '확인할 수 없음'이므로 FAIL이다 — 배포 가드의
    missing_secrets가 조회 실패를 통과시키는 것과 달리, verify는
    '확인됨' 자체가 목적이라 보수적으로 판정한다."""
    if names is None:
        return False, '시크릿 이름 목록 조회 실패'
    missing = sorted(set(required) - set(names))
    if missing:
        return False, f'핵심 시크릿 누락: {missing} (전체 {len(names)}개)'
    return True, f'핵심 시크릿 {len(required)}개 포함, 전체 {len(names)}개'


def parse_cron_schedules(result):
    """GET schedules 응답 → cron 문자열 정렬 목록. 조회 실패/형식 오류 시 None."""
    if result is None:
        return None
    try:
        return sorted(s.get('cron') for s in result.get('schedules', []))
    except Exception:
        return None


def check_cron_schedules(result, expected=CRON_SCHEDULES):
    """Cron 스케줄 등록 상태 판정 (순수 함수). (ok, detail) 반환.
    ensure_cron_schedules의 GET 재확인 판정과 동일 기준이지만, 등록(PUT)은
    하지 않는 읽기 전용 버전이다."""
    got = parse_cron_schedules(result)
    if got is None:
        return False, 'Cron 스케줄 조회 실패 (GET schedules)'
    if got != sorted(expected):
        return False, f'Cron 스케줄 불일치 — 기대 {sorted(expected)}, 실제 {got}'
    return True, f'Cron 스케줄 등록 확인: {got}'


def build_verify_staging():
    """verify 전용 스테이징 생성: 임시 디렉토리에서 배포와 동일한 NODE_GEN을
    실행해 (asset_ver, assets_dir)를 반환한다. 실패 시 (None, None).

    verify_deployment의 manifest 본문·login ?v= 검사는 '이번에 업로드한
    스테이징'과의 비교라 스테이징이 필요하다. 작업 트리(src/index-inline.ts·
    .deploy-assets/)를 건드리지 않기 위해 src/index.ts·public/·
    scripts/static-assets.json만 임시 복사해 그 안에서 실행한다."""
    import tempfile, shutil
    src_root = Path(__file__).resolve().parent
    tmp = Path(tempfile.mkdtemp(prefix='myhub-verify-'))
    try:
        (tmp / 'src').mkdir()
        shutil.copy2(src_root / 'src' / 'index.ts', tmp / 'src' / 'index.ts')
        shutil.copytree(src_root / 'public', tmp / 'public')
        (tmp / 'scripts').mkdir()
        shutil.copy2(src_root / 'scripts' / 'static-assets.json',
                     tmp / 'scripts' / 'static-assets.json')
        # NODE_GEN이 ./scripts/asset-version.cjs를 상대 경로로 require하므로
        # 임시 디렉토리에도 함께 복사한다 (복사 누락 시 verify 스테이징이
        # MODULE_NOT_FOUND로 실패하던 알려진 결함의 수정, 2026-11-07 등재).
        shutil.copy2(src_root / 'scripts' / 'asset-version.cjs',
                     tmp / 'scripts' / 'asset-version.cjs')
        result = subprocess.run(['node', '-e', NODE_GEN], cwd=str(tmp),
                                capture_output=True, text=True)
        if result.returncode != 0:
            print(f'  verify 스테이징 생성 실패: {result.stderr[:200]}', file=sys.stderr)
            return None, None
        asset_ver = assets_dir = None
        for line in result.stdout.splitlines():
            if line.startswith('ASSET_VER='):
                asset_ver = line.split('=', 1)[1].strip()
            if line.startswith('ASSETS_DIR='):
                assets_dir = line.split('=', 1)[1].strip()
        if not asset_ver or not assets_dir:
            return None, None
        return asset_ver, tmp / assets_dir.removeprefix('./')
    except Exception as e:
        print(f'  verify 스테이징 생성 오류: {e}', file=sys.stderr)
        return None, None


def run_verify_only():
    """현재 라이브 상태만 검증한다 (읽기 전용). 종합 PASS면 0, 아니면 1 반환.

    수행 항목:
    1. 활성 버전(100% 트래픽) 식별 — GET deployments
    2. 시크릿 이름 목록 — GET secrets (이름만; 핵심 세트 포함 여부 판정)
    3. Cron 스케줄 등록 상태 — GET schedules
    4. 라이브 QA — 배포 검증과 동일한 verify_deployment() 재사용 (URL GET만):
       /api/health·정적 에셋 200, manifest 본문·immutable, /shell.css 인증 보호,
       /api/system 401, / 302, /login.html 본문의 ?v= 에셋 버전
    """
    base_url = CONFIG['BASE_URL']
    script_root = Path(__file__).resolve().parent
    results = []

    def record(name, ok, detail=''):
        results.append(ok)
        line = f"[{'PASS' if ok else 'FAIL'}] {name}"
        if detail:
            line += f' — {detail}'
        print(line)

    print(f'=== VERIFY ONLY (읽기 전용): {SCRIPT_NAME} @ {base_url} ===')

    active = get_active_version_id()
    record('활성 버전 (100% 트래픽)', active is not None,
           active if active else '식별 실패 (GET deployments)')

    names = get_secret_names()
    if names is not None:
        print(f'  시크릿 이름 {len(names)}개: {sorted(names)}')
    ok, detail = check_secret_names(names)
    record('시크릿 이름 목록', ok, detail)

    sched = api_json('GET', f'/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}/schedules')
    ok, detail = check_cron_schedules(sched)
    record('Cron 스케줄', ok, detail)

    asset_ver, staging_dir = build_verify_staging()
    if staging_dir is None:
        record('라이브 QA (verify_deployment)', False, '검증용 스테이징 생성 실패')
    else:
        ok = verify_deployment(script_root, base_url, asset_ver, staging_dir)
        record('라이브 QA (verify_deployment)', ok, f'asset_ver={asset_ver}')

    verdict = 'PASS' if all(results) else 'FAIL'
    print(f'=== VERIFY {verdict}: {sum(results)}/{len(results)} 항목 통과 ===')
    return 0 if all(results) else 1

# ---------------------------------------------------------------------------
# Static Assets 업로드 (audit P-1, 2026-10-28)
# Cloudflare Direct Uploads 3단계 (공식 문서 workers/static-assets/direct-upload):
#   1. POST assets-upload-session {manifest: {path: {hash, size}}} → {jwt, buckets}
#   2. POST workers/assets/upload?base64=true (버킷별 multipart, 필드명=해시,
#      값=base64 본문, Content-Type=파일 MIME) → 마지막 버킷에서 201 + 완료 jwt
#   3. PUT worker 스크립트, metadata.assets={jwt, config:{run_worker_first:true}}
#      + bindings에 {"type": "assets", "name": "ASSETS"}
# 해시는 공식 예시와 동일: sha256(base64(본문) + 확장자) 앞 32자(hex).
# 버킷이 비면(전부 서버 캐시 적중) wrangler와 동일하게 세션 jwt를 완료 토큰으로 쓴다
# (wrangler 4.147.0 uploadAssets: "No updated asset files to upload" 분기).
# 에셋 업로드는 세션 jwt 자체가 Authorization이므로 서러게이트가 필요 없다.
# ---------------------------------------------------------------------------
INLINE_BASE64_MARKERS = ('STATIC_FILES_B64', 'ICON192_B64', 'ICON512_B64',
                         'WALLPAPER_B64', 'AV_RUMI_B64', 'AV_ECHO_B64',
                         'AV_NOVA_B64', 'AV_CALI_B64')


def find_inline_markers(data: bytes):
    """번들/생성 파일 안에 남은 base64 인라인 마커 목록.
    하나라도 있으면 구 인라인 경로가 복원된 것이다."""
    return [m for m in INLINE_BASE64_MARKERS if m.encode() in data]


def check_assets_staging(project, assets_path):
    """스테이징 디렉토리가 업로드 집합과 정확히 일치하는지 검사.
    (ok, message) 반환 — main()은 실패 시 배포를 중단한다."""
    with open(str(Path(project) / 'scripts' / 'static-assets.json'), encoding='utf-8') as f:
        expected = set(json.load(f)['files'])
    staged = {'/' + p.relative_to(assets_path).as_posix()
              for p in Path(assets_path).rglob('*') if p.is_file()}
    if staged != expected:
        return False, (f"스테이징 에셋 불일치 — 누락 {sorted(expected - staged)} "
                       f"초과 {sorted(staged - expected)}")
    return True, f'Assets staging OK: {len(staged)}개 파일'


def build_worker_metadata(completion_jwt):
    """Worker 업로드 메타데이터 (ASSETS 연결 포함).
    run_worker_first가 없으면 에셋이 인증 미들웨어를 우회하므로 필수다
    (wrangler 4.147.0 createWorkerUploadForm과 동일한 형태)."""
    return {
        'main_module': 'index.js',
        'compatibility_date': '2026-10-01',
        'assets': {'jwt': completion_jwt, 'config': dict(ASSETS_CONFIG)},
        'bindings': [
            {'type': 'd1', 'name': 'DB', 'id': CONFIG['DB_ID']},
            {'type': 'kv_namespace', 'name': 'KV', 'namespace_id': CONFIG['KV_ID']},
            {'type': 'ai', 'name': 'AI'},
            {'type': 'assets', 'name': 'ASSETS'},
            {'type': 'plain_text', 'name': 'APP_NAME', 'text': CONFIG['APP_NAME']},
            {'type': 'plain_text', 'name': 'ENVIRONMENT', 'text': CONFIG['ENVIRONMENT']},
            # Google 쓰기 플래그 (2026-10-28 사용자 승인 — 테스트 계정만 연결됨).
            # 주의: keep_bindings는 시크릿(secret_text/secret_key)만 보존하고
            # plain_text 바인딩은 보존하지 않는다. 대시보드에서만 켜면 다음
            # deploy_full.py 배포 때 이 바인딩이 사라져 쓰기가 조용히 꺼진다.
            # 그래서 플래그의 유일한 기준은 이 메타데이터이다 (wrangler.toml
            # [vars]는 deploy_full.py가 동기화하지 않는다).
            {'type': 'plain_text', 'name': 'GOOGLE_WRITE_ENABLED', 'text': 'true'},
            # 리마인더 워크플로 플래그 (운영 a2702ca4에 plain_text 'false'로 실재).
            # keep_bindings는 plain_text를 보존하지 않으므로, 명시하지 않으면
            # 다음 배포에서 소실된다. 코드는 === 'true'로 판정해 부재와 동작이
            # 같지만, 운영 바인딩과의 이름 단위 일치를 위해 'false'로 명시한다
            # (2026-11-11 배포 메타 감사에서 발견).
            {'type': 'plain_text', 'name': 'WORKFLOW_REMINDER_ENABLED', 'text': 'false'},
            {'type': 'queue', 'name': 'ARTIFACT_QUEUE', 'queue_name': 'myhub-artifact-jobs'},
        ],
        'keep_bindings': ['secret_text', 'secret_key'],
        # Cron Trigger (5분 틱) — src/index.ts scheduled 핸들러 기동용.
        # 주의: versions 업로드 메타데이터의 'triggers'는 schedules를 등록하지
        # 않는다 (2026-10-26 배포 실측 — GET schedules 빈 배열). 실제 등록은
        # 승격 후 ensure_cron_schedules()가 schedules API로 수행한다.
        'triggers': {'crons': ['*/5 * * * *']},
    }


ASSETS_DIR_NAME = '.deploy-assets'
# html_handling='none'이 필수다 (기본 auto-trailing-slash는 /file.html → 307 → /file로
# 보내는데, /login은 인증 allowlist에 없어 무인증 리다이렉트 루프가 된다.
# 공식 문서 HTML handling 표: /file.html → 307 to /file. Canonical URL이
# /a.html인 앱은 'none'을 써야 한다. wrangler.toml [assets]와 동일하게 유지할 것.)
ASSETS_CONFIG = {'run_worker_first': True, 'html_handling': 'none'}


def asset_hash(data: bytes, ext: str) -> str:
    """에셋 해시: sha256(base64(data) + ext) hex 앞 32자."""
    return hashlib.sha256(base64.b64encode(data) + ext.encode()).hexdigest()[:32]


def build_assets_manifest(assets_dir):
    """{path: {'hash', 'size'}} 매니페스트 + {hash: Path} 역참조를 만든다.
    assets_dir 아래 모든 파일을 재귀 수집한다. 빈 디렉토리면 ValueError."""
    manifest = {}
    by_hash = {}
    root = Path(assets_dir)
    for path in sorted(root.rglob('*')):
        if not path.is_file():
            continue
        rel = '/' + path.relative_to(root).as_posix()
        data = path.read_bytes()
        h = asset_hash(data, path.suffix.lstrip('.'))
        manifest[rel] = {'hash': h, 'size': len(data)}
        by_hash[h] = path
    if not manifest:
        raise ValueError(f'에셋 없음: {assets_dir}')
    return manifest, by_hash


def create_assets_upload_session(manifest):
    """1단계: 업로드 세션 생성. 성공 시 (jwt, buckets), 실패 시 None."""
    result = api_json('POST', f'/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}/assets-upload-session',
                      {'manifest': manifest})
    if not result or not result.get('jwt'):
        print('ERROR: assets-upload-session 생성 실패', file=sys.stderr)
        return None
    return result['jwt'], result.get('buckets') or []


def _upload_assets_bucket(jwt, bucket, by_hash):
    """2단계: 버킷 하나를 multipart로 업로드. (status, completion_jwt|None) 반환.
    완료(201) 응답에만 jwt가 있다. 실패 시 (None, None)."""
    boundary = '----MyHubAssetsBoundary7MA4YWxkTrZu0gW'
    parts = []
    for h in bucket:
        path = by_hash.get(h)
        if path is None:
            print(f'ERROR: 버킷 해시 {h}에 해당하는 파일 없음', file=sys.stderr)
            return None, None
        data = path.read_bytes()
        mime = mimetypes.guess_type(str(path))[0] or 'application/octet-stream'
        parts.append(f'--{boundary}\r\n'.encode())
        parts.append(f'Content-Disposition: form-data; name="{h}"; filename="{h}"\r\n'.encode())
        parts.append(f'Content-Type: {mime}\r\n\r\n'.encode())
        parts.append(base64.b64encode(data) + b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode())
    body = b''.join(parts)
    url = BASE + f'/accounts/{ACCOUNT_ID}/workers/assets/upload?base64=true'
    req = urllib.request.Request(url, data=body, method='POST')
    req.add_header('Content-Type', f'multipart/form-data; boundary={boundary}')
    req.add_header('Authorization', f'Bearer {jwt}')
    try:
        with urllib.request.urlopen(req) as resp:
            result = read_json_response(resp)
            status = resp.status
    except urllib.error.HTTPError as e:
        try:
            result = read_json_response(e)
        except Exception:
            result = {}
        status = e.code
    except Exception as e:
        print(f'ERROR: 에셋 버킷 업로드 실패: {e}', file=sys.stderr)
        return None, None
    if not result.get('success'):
        print(f"ERROR: 에셋 버킷 업로드 실패 (HTTP {status}): {result.get('errors')}", file=sys.stderr)
        return None, None
    return status, (result.get('result') or {}).get('jwt')


def upload_assets(assets_dir):
    """에셋 전체 업로드. 성공 시 완료 jwt, 실패 시 None.
    세션 생성 → 버킷 업로드 → 완료 jwt 반환. 업로드할 버킷이 없으면
    (이미 전부 업로드됨) 세션 jwt를 완료 토큰으로 쓴다."""
    try:
        manifest, by_hash = build_assets_manifest(assets_dir)
    except ValueError as e:
        print(f'ERROR: {e}', file=sys.stderr)
        return None
    print(f'에셋 매니페스트: {len(manifest)}개 파일', file=sys.stderr)
    session = create_assets_upload_session(manifest)
    if session is None:
        return None
    jwt, buckets = session
    completion_jwt = None
    for i, bucket in enumerate(buckets):
        status, completion_jwt = _upload_assets_bucket(jwt, bucket, by_hash)
        if status is None:
            return None
        print(f'  에셋 버킷 {i + 1}/{len(buckets)} 업로드 완료 (HTTP {status})', file=sys.stderr)
    return completion_jwt or jwt


def post_upload_flow(prev_version_id, new_version_id, promote_fn, verify_fn, deploy_fn, schedules_fn=None):
    """업로드 후 처리: 승격 → Cron 트리거 등록 → 라이브 검증 → 실패 시 이전 버전으로 롤백.

    secret 보존은 업로드 메타데이터의 keep_bindings가 담당한다 (기존 메커니즘).
    버전 바인딩 API 조회는 게이트로 쓰지 않는다 — 2026-10-21 실측에서
    정상 배포된 새 버전도 조회상 secret 0개로 표시돼 오판 롤백이 2회 발생했고,
    그 표시가 런타임 secret 가용성과 일치하지 않음이 확인됐다.
    schedules_fn이 주어지면 승격 직후 Cron 트리거를 등록·확인한다 (실패 시 경고만, 롤백 안 함).
    반환: (성공 여부, 결과) — 'deployed' | 'rolled_back' | 'failed_no_rollback'
    promote_fn/verify_fn/deploy_fn은 테스트에서 주입 가능.
    """
    def _rollback():
        if prev_version_id and prev_version_id != new_version_id:
            print(f"  실패 → 이전 버전 {prev_version_id}으로 롤백합니다", file=sys.stderr)
            if deploy_fn(prev_version_id):
                print("  ROLLED BACK: 이전 버전이 100%로 복원됨", file=sys.stderr)
                return False, 'rolled_back'
            print("  롤백 실패! 수동 조치가 필요합니다", file=sys.stderr)
            return False, 'failed_no_rollback'
        print("  롤백할 이전 버전이 없어 복원할 수 없습니다", file=sys.stderr)
        return False, 'failed_no_rollback'

    if new_version_id:
        if not promote_fn(new_version_id):
            print("  승격(deployments POST) 실패", file=sys.stderr)
            return _rollback()
        print(f"  승격 완료: {new_version_id}@100%", file=sys.stderr)
        if schedules_fn is not None:
            schedules_fn()
    if verify_fn():
        return True, 'deployed'
    return _rollback()

# ---------------------------------------------------------------------------
# 단일 실행 잠금 (2026-11-06, 커밋 b1fcf5cc — 재구축으로 재적용)
#
# 배경: 배포 두 건이 겹쳐 실행되면 한쪽이 상대의 버전을 "외부 배포"로
# 오인하고 롤백까지 가는 간섭 사고가 있었다 (2026-11-06 18:19). 그래서
# 배포 진입 시 .deploy_full.lock을 O_EXCL로 원자적으로 획득해 동시 실행
# 자체를 막는다. 잠금에는 pid·cmdline·시작 시각을 남기고, 경합 시 보유자
# 정보를 출력하며 exit 3으로 거부한다. 기록된 pid가 죽었거나, 살아 있어도
# 그 pid의 cmdline이 deploy_full이 아니면(재사용된 pid) stale로 보고
# 회수한 뒤 재획득한다 — 중단된 배포가 남긴 잠금을 다음 배포가 자동
# 회수하므로 영구 차단은 없다. verify 모드는 읽기 전용이라 잠금 대상이
# 아니다 (main()을 타지 않는 별도 진입점이다).
# ---------------------------------------------------------------------------
DEPLOY_LOCK_PATH = project / '.deploy_full.lock'


def _read_lock_info(lock_path=None):
    """잠금 파일의 보유자 정보(dict) — 없거나 깨졌으면 None."""
    try:
        with open(str(lock_path or DEPLOY_LOCK_PATH), encoding='utf-8') as f:
            info = json.load(f)
        return info if isinstance(info, dict) else None
    except Exception:
        return None


def _lock_holder_alive(info):
    """기록된 보유자가 아직 배포 프로세스로 살아 있는지 판정."""
    if not info:
        return False
    pid = info.get('pid')
    if not isinstance(pid, int) or pid <= 0:
        return False
    import os
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    # pid가 살아 있어도 다른 프로세스가 재사용했을 수 있다 — cmdline에
    # deploy_full이 있을 때만 실제 보유자로 인정한다. /proc를 읽을 수 없는
    # 환경에서는 생존만으로 보수적으로 인정한다.
    try:
        with open(f'/proc/{pid}/cmdline', 'rb') as f:
            cmdline = f.read().decode('utf-8', 'replace')
        return 'deploy_full' in cmdline
    except OSError:
        return True


def acquire_deploy_lock(lock_path=None):
    """단일 실행 잠금 획득. 보유자가 살아 있으면 보유자 정보를 출력하고
    exit 3으로 거부한다. stale 잠금은 회수하고 재시도한다.
    성공 시 잠금 파일 경로를 반환한다."""
    import os
    from datetime import datetime, timezone
    lock_path = Path(lock_path or DEPLOY_LOCK_PATH)
    info = {'pid': os.getpid(), 'cmdline': ' '.join(sys.argv),
            'started_at': datetime.now(timezone.utc).isoformat()}
    for _attempt in range(2):
        try:
            fd = os.open(str(lock_path),
                         os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            holder = _read_lock_info(lock_path)
            if _lock_holder_alive(holder):
                print(f"ERROR: 다른 배포가 실행 중입니다 — 동시 배포를 거부합니다. "
                      f"보유자: pid {holder.get('pid')}, "
                      f"시작 {holder.get('started_at')}, "
                      f"cmdline: {holder.get('cmdline')}", file=sys.stderr)
                sys.exit(3)
            # stale 잠금 회수 후 재시도
            try:
                os.remove(str(lock_path))
            except OSError:
                pass
            continue
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(info, f)
        return lock_path
    print("ERROR: 배포 잠금을 획득하지 못했습니다 (경합 반복)", file=sys.stderr)
    sys.exit(3)


def release_deploy_lock(lock_path=None):
    """잠금 해제 — 자기 pid가 기록된 잠금만 지운다."""
    import os
    lock_path = Path(lock_path or DEPLOY_LOCK_PATH)
    try:
        holder = _read_lock_info(lock_path)
        if holder and holder.get('pid') == os.getpid():
            os.remove(str(lock_path))
    except OSError:
        pass


def main():
    # 단일 실행 잠금 (2026-11-06): 동시 배포 간섭 방지 — 경합 시 exit 3,
    # 프로세스 종료 시(정상·예외·sys.exit 공통) atexit으로 해제한다.
    acquire_deploy_lock()
    import atexit
    atexit.register(release_deploy_lock)
    # DEPLOY-003 개정(2026-10-21): 환경변수 게이트 제거.
    # 안전장치는 post_upload_flow (라이브 검증 + secret 보존 검증 + 자동 롤백)가 담당한다.
    # DEPLOY-002: memo-bundle.js 자동 재생성 (원본 수정 시 번들 갱신 보장)
    print("Building memo-bundle.js...", file=sys.stderr)
    result = subprocess.run(['bash', 'scripts/build-memo-bundle.sh'],
                            cwd=str(project), capture_output=True, text=True)
    if result.returncode != 0:
        print(f"MEMO BUNDLE BUILD FAIL: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    print("MEMO BUNDLE BUILD PASS", file=sys.stderr)

    result = subprocess.run(['node', '-e', NODE_GEN],
                            cwd=str(project), capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Generate failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    # 생성된 파일 검증 (audit P-1, 2026-10-28): 정적 파일·이미지는 ASSETS로만
    # 서빙하므로, 생성 파일에 base64 인라인이 남아 있으면 배포를 중단한다.
    # 구 마커가 있으면 구 NODE_GEN이 돌았다는 뜻이다.
    with open(str(project / 'src' / 'index-inline.ts'), 'rb') as f:
        generated = f.read()
    found = find_inline_markers(generated)
    if found:
        print(f"ERROR: Generated file still contains inline base64 markers {found}!", file=sys.stderr)
        sys.exit(1)
    asset_ver = None
    assets_dir = None
    for line in result.stdout.splitlines():
        if line.startswith('ASSET_VER='):
            asset_ver = line.split('=', 1)[1].strip()
        if line.startswith('ASSETS_DIR='):
            assets_dir = line.split('=', 1)[1].strip()
    print(f"Asset version: {asset_ver}", file=sys.stderr)
    if not asset_ver or not assets_dir:
        print("ERROR: NODE_GEN 출력에서 ASSET_VER/ASSETS_DIR를 못 읽음", file=sys.stderr)
        sys.exit(1)
    # 스테이징 디렉토리 검증: 업로드 집합과 정확히 일치해야 한다.
    # 주의: lstrip('./')은 문자 집합 {'.', '/'}을 벗겨 './.deploy-assets'를
    # 'deploy-assets'로 만든다 (2026-10-28 배포 중단 원인). removeprefix 사용.
    assets_path = project / assets_dir.removeprefix('./')
    ok, msg = check_assets_staging(project, assets_path)
    if not ok:
        print(f"ERROR: {msg}", file=sys.stderr)
        sys.exit(1)
    print(msg, file=sys.stderr)

    import os
    try:
        os.remove('/tmp/myhub-inline.js')
    except:
        pass
    # esbuild 번들. --conditions=workerd 필수 (2026-10-28 MCP):
    # @modelcontextprotocol/server의 ./_shims 조건부 export가 workerd 조건
    # 없이는 node shim(shimsNode.mjs → node:process)을 타서
    # platform=neutral 번들이 실패한다. workerd 조건이 없는 패키지는
    # default 분기로 떨어지므로 기존 번들에는 영향이 없다 (실측 확인).
    result = subprocess.run(
        ['npx', 'esbuild', 'src/index-inline.ts', '--bundle', '--format=esm',
         '--platform=neutral', '--conditions=workerd', '--external:cloudflare:workers', '--outfile=/tmp/myhub-inline.js'],
        cwd=str(project), capture_output=True, text=True, errors='replace')
    if result.returncode != 0:
        print(f"BUILD FAIL: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    print("BUILD PASS", file=sys.stderr)

    # 번들에 base64 인라인이 없는지 검증 (audit P-1 — 구 긍정 검사의 역방향).
    # 마커 이름 자체가 번들에 남아 있으면 인라인이 복원된 것이다.
    with open('/tmp/myhub-inline.js', 'rb') as f:
        bundle_check = f.read()
        found = find_inline_markers(bundle_check)
        if found:
            print(f"BUILD FAIL: Bundle still contains inline base64 {found}!",
                  file=sys.stderr)
            sys.exit(1)
        print("BUILD VERIFY PASS: no inline base64 in bundle", file=sys.stderr)
    with open('/tmp/myhub-inline.js', 'rb') as f:
        worker_js = f.read()
    print(f"Bundle: {len(worker_js)} bytes", file=sys.stderr)

    # 에셋 업로드 (Direct Uploads 3단계 중 1·2단계) — 실패하면 라이브 변경 없이 중단.
    completion_jwt = upload_assets(assets_path)
    if not completion_jwt:
        print("ASSETS UPLOAD FAIL: 에셋 업로드 실패 — 배포 중단", file=sys.stderr)
        sys.exit(1)
    print("ASSETS UPLOAD PASS", file=sys.stderr)

    boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW'
    metadata = build_worker_metadata(completion_jwt)
    # 배포 전 검증: 필수 바인딩 확인
    binding_names = {b['name'] for b in metadata['bindings']}
    required = {'DB', 'KV', 'AI', 'ASSETS', 'APP_NAME', 'ENVIRONMENT', 'ARTIFACT_QUEUE'}
    missing = required - binding_names
    if missing:
        print(f"ERROR: 필수 바인딩 누락: {missing}", file=sys.stderr)
        sys.exit(1)
    env_binding = next((b for b in metadata['bindings'] if b['name'] == 'ENVIRONMENT'), None)
    if not env_binding or env_binding.get('text') != CONFIG['ENVIRONMENT']:
        print(f"ERROR: ENVIRONMENT={CONFIG['ENVIRONMENT']} 미설정", file=sys.stderr)
        sys.exit(1)
    print(f"배포 검증 통과: {SCRIPT_NAME}, ENVIRONMENT={CONFIG['ENVIRONMENT']}", file=sys.stderr)

    parts = [
        f'--{boundary}\r\n'.encode(),
        b'Content-Disposition: form-data; name="metadata"\r\n\r\n',
        json.dumps(metadata).encode() + b'\r\n',
        f'--{boundary}\r\n'.encode(),
        b'Content-Disposition: form-data; name="index.js"; filename="index.js"\r\n',
        b'Content-Type: application/javascript+module\r\n\r\n',
        worker_js + b'\r\n',
        f'--{boundary}--\r\n'.encode(),
    ]
    body = b''.join(parts)

    # 업로드 전 현재 활성 버전을 기록 (검증 실패 시 롤백 대상)
    prev_version_id = get_active_version_id()
    print(f"현재 활성 버전: {prev_version_id}", file=sys.stderr)

    # 시크릿 소실 재발 방지 가드 (2026-10-22): 업로드 전 시크릿 이름 목록을 기록한다.
    # 2026-10-21 사고(keep_bindings 없는 업로드가 시크릿 세트를 교체)가 다시 일어나면
    # 업로드 직후 이름이 사라진 것으로 드러나며, 그 경우 승격하지 않고 중단한다.
    secret_names_before = get_secret_names()
    if secret_names_before is None:
        print("경고: 시크릿 이름 목록 조회 실패 — 소실 가드는 업로드 후 비교만 수행", file=sys.stderr)
    else:
        print(f"시크릿 이름 {len(secret_names_before)}개 기록 (업로드 전)", file=sys.stderr)

    url = BASE + f'/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}'
    req = urllib.request.Request(url, data=body, method='PUT')
    req.add_header('Content-Type', f'multipart/form-data; boundary={boundary}')
    add_surrogate_to_request(req, CREDENTIAL, allowed_hosts=ALLOWED_HOSTS)

    with urllib.request.urlopen(req) as resp:
        result = read_json_response(resp)
        if result.get('success'):
            print("UPLOAD SUCCESS", file=sys.stderr)
        else:
            print(f"Failed: {result}", file=sys.stderr)
            sys.exit(1)

    # 시크릿 소실 가드: 업로드로 시크릿이 사라졌으면 승격 전에 중단한다.
    secret_names_after = get_secret_names()
    lost = missing_secrets(secret_names_before, secret_names_after)
    if lost:
        print(f"ERROR: 업로드 후 시크릿 소실 감지: {sorted(lost)} — 승격을 중단합니다", file=sys.stderr)
        if prev_version_id:
            deploy_version(prev_version_id)
            print(f"  이전 버전 {prev_version_id}을 100%로 재확인(롤백)했습니다", file=sys.stderr)
        sys.exit(1)
    if secret_names_after is not None:
        print(f"시크릿 가드 PASS: 이름 {len(secret_names_after)}개 유지", file=sys.stderr)

    # 업로드 후 처리: 승격 → Cron 트리거 등록 → 라이브 검증 → 실패 시 자동 롤백
    # PUT 직후 versions 목록이 stale할 수 있으므로(2026-11-12 실측) 새 ID가
    # 목록에 나타날 때까지 기다린다. 타임아웃 시 PUT이 이미 활성화한 버전을
    # deployments 목록에서 폴백으로 읽는다.
    new_version_id = wait_for_new_version(prev_version_id)
    if not new_version_id:
        print("경고: versions 목록에서 새 버전을 확인하지 못했습니다 — deployments 목록으로 폴백합니다", file=sys.stderr)
        new_version_id = get_active_version_id()
    if not new_version_id or new_version_id == prev_version_id:
        print("ERROR: PUT 후 새 버전을 식별하지 못했습니다 — 승격하지 않고 종료합니다", file=sys.stderr)
        sys.exit(1)
    print(f"새 버전: {new_version_id}", file=sys.stderr)
    ok, outcome = post_upload_flow(
        prev_version_id, new_version_id,
        deploy_version,
        lambda: verify_deployment(project, CONFIG['BASE_URL'], asset_ver, assets_path),
        deploy_version,
        ensure_cron_schedules)
    if not ok:
        print(f"DEPLOY FAILED ({outcome})", file=sys.stderr)
        sys.exit(1)
    print("Deployed!")

if __name__ == '__main__' and VERIFY_ONLY:
    sys.exit(run_verify_only())

if __name__ == '__main__':
    main()
