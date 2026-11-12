#!/usr/bin/env python3
"""
deploy_full.py 안전장치 단위 테스트 (DEPLOY-003 개정, 2026-10-21)

- post_upload_flow: 승격 → 라이브 검증 → 실패 시 롤백 판정
- get_active_version_id / get_latest_version_id 파싱 (API 응답 목킹)
네트워크는 사용하지 않는다.
"""

import sys
import importlib.util

sys.argv = ['deploy_full.py', 'production']
sys.path.insert(0, '.')
_spec = importlib.util.spec_from_file_location('deploy_full', 'deploy_full.py')
df = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(df)


def _flow(verify=True, prev='v-prev', new='v-new', promote_result=True, deploy_result=True):
    """호출 순서를 기록하는 가짜 함수들로 post_upload_flow 실행."""
    events = []
    def promote(vid):
        events.append(('promote', vid))
        return promote_result
    def deploy(vid):
        events.append(('deploy', vid))
        return deploy_result
    ok, outcome = df.post_upload_flow(prev, new, promote, lambda: verify, deploy)
    return ok, outcome, events


def test_flow_all_pass():
    ok, outcome, events = _flow()
    assert ok and outcome == 'deployed', (ok, outcome)
    assert events == [('promote', 'v-new')], events
    print('flow: 승격 → 검증 PASS → deployed PASS')


def test_flow_verify_fail_rolls_back():
    ok, outcome, events = _flow(verify=False)
    assert not ok and outcome == 'rolled_back', (ok, outcome)
    assert events == [('promote', 'v-new'), ('deploy', 'v-prev')], events
    print('flow: 라이브 검증 FAIL → 롤백 PASS')


def test_flow_promote_fail_rolls_back():
    ok, outcome, events = _flow(promote_result=False)
    assert not ok and outcome == 'rolled_back', (ok, outcome)
    assert ('deploy', 'v-prev') in events, events
    print('flow: 승격 실패 → 롤백 PASS')


def test_flow_rollback_failure():
    ok, outcome, events = _flow(verify=False, deploy_result=False)
    assert not ok and outcome == 'failed_no_rollback', (ok, outcome)
    print('flow: 롤백 실패 → failed_no_rollback PASS')


def test_flow_no_prev():
    ok, outcome, events = _flow(verify=False, prev=None)
    assert not ok and outcome == 'failed_no_rollback', (ok, outcome)
    assert not any(e[0] == 'deploy' for e in events), events
    print('flow: 이전 버전 없음 → 복원 불가 보고 PASS')


def test_flow_same_version_no_rollback():
    ok, outcome, events = _flow(verify=False, prev='v-same', new='v-same')
    assert not ok and outcome == 'failed_no_rollback', (ok, outcome)
    assert not any(e[0] == 'deploy' for e in events), events
    print('flow: 동일 버전 → 자기 자신으로 롤백하지 않음 PASS')


def test_flow_no_new_version_verify_only():
    # 새 버전 ID를 못 구한 경우: 승격 생략, 검증만으로 판정
    ok, outcome, events = _flow(new=None)
    assert ok and outcome == 'deployed', (ok, outcome)
    assert events == [], events
    print('flow: 새 버전 ID 없음 → 승격 생략, 검증 판정 PASS')


def test_get_active_version_id_parsing():
    orig = df.api_json
    try:
        df.api_json = lambda m, p, payload=None: {
            'deployments': [
                {'versions': [{'version_id': 'v-old', 'percentage': 0}]},
                {'versions': [{'version_id': 'v-cur', 'percentage': 100}]},
            ]
        }
        assert df.get_active_version_id() == 'v-cur'
        df.api_json = lambda m, p, payload=None: None
        assert df.get_active_version_id() is None
        df.api_json = lambda m, p, payload=None: {'deployments': []}
        assert df.get_active_version_id() is None
    finally:
        df.api_json = orig
    print('get_active_version_id 파싱 PASS')


def test_get_latest_version_id_parsing():
    orig = df.api_json
    try:
        df.api_json = lambda m, p, payload=None: {'items': [{'id': 'v-latest'}, {'id': 'v-older'}]}
        assert df.get_latest_version_id() == 'v-latest'
        df.api_json = lambda m, p, payload=None: {'items': []}
        assert df.get_latest_version_id() is None
        df.api_json = lambda m, p, payload=None: None
        assert df.get_latest_version_id() is None
    finally:
        df.api_json = orig
    print('get_latest_version_id 파싱 PASS')


def test_missing_secrets():
    # 동일하면 소실 없음
    assert df.missing_secrets({'A', 'B'}, {'A', 'B'}) == set()
    # 추가는 소실이 아님
    assert df.missing_secrets({'A'}, {'A', 'B'}) == set()
    # 사라진 이름만 반환 (2026-10-21 사고 재현 케이스)
    assert df.missing_secrets({'A', 'B', 'C'}, {'A'}) == {'B', 'C'}
    # 조회 실패(None)는 판단 불가 → 빈 집합 (배포를 막지 않음)
    assert df.missing_secrets(None, {'A'}) == set()
    assert df.missing_secrets({'A'}, None) == set()
    assert df.missing_secrets(None, None) == set()
    print('missing_secrets 판정 PASS')


def test_get_secret_names_parsing():
    orig = df.api_json
    try:
        df.api_json = lambda m, p, payload=None: [{'name': 'A_KEY'}, {'name': 'B_KEY'}]
        assert df.get_secret_names() == {'A_KEY', 'B_KEY'}
        df.api_json = lambda m, p, payload=None: []
        assert df.get_secret_names() == set()
        df.api_json = lambda m, p, payload=None: None
        assert df.get_secret_names() is None
        df.api_json = lambda m, p, payload=None: [{'noname': 1}]
        assert df.get_secret_names() is None
    finally:
        df.api_json = orig
    print('get_secret_names 파싱 PASS')


def test_ensure_cron_schedules_success():
    # PUT 본문은 [{"cron": ...}] 배열이어야 한다 ({"crons": [...]}·["..."]는 400).
    orig = df.api_json
    seen = []
    try:
        def fake(m, p, payload=None):
            seen.append((m, p, payload))
            if m == 'PUT':
                return {'schedules': [{'cron': '*/5 * * * *'}]}
            return {'schedules': [{'cron': '*/5 * * * *'}]}
        df.api_json = fake
        assert df.ensure_cron_schedules() is True
        assert seen[0][0] == 'PUT' and seen[0][2] == [{'cron': '*/5 * * * *'}], seen
        assert seen[1][0] == 'GET', seen
    finally:
        df.api_json = orig
    print('ensure_cron_schedules 성공 PASS')


def test_ensure_cron_schedules_put_fail():
    orig = df.api_json
    try:
        df.api_json = lambda m, p, payload=None: None
        assert df.ensure_cron_schedules() is False
    finally:
        df.api_json = orig
    print('ensure_cron_schedules PUT 실패 → False PASS')


def test_ensure_cron_schedules_mismatch():
    orig = df.api_json
    try:
        def fake(m, p, payload=None):
            return {'schedules': [{'cron': '0 9 * * *'}]} if m == 'GET' else {'schedules': [{'cron': '*/5 * * * *'}]}
        df.api_json = fake
        assert df.ensure_cron_schedules() is False
    finally:
        df.api_json = orig
    print('ensure_cron_schedules 재확인 불일치 → False PASS')


def test_flow_calls_schedules_after_promote():
    events = []
    def promote(vid):
        events.append(('promote', vid))
        return True
    def sched():
        events.append(('schedules',))
        return True
    ok, outcome = df.post_upload_flow('v-prev', 'v-new', promote, lambda: True, lambda v: True, sched)
    assert ok and outcome == 'deployed', (ok, outcome)
    assert events == [('promote', 'v-new'), ('schedules',)], events
    print('flow: 승격 → schedules 등록 → 검증 PASS')


def test_flow_schedules_fail_warns_only():
    # schedules 실패는 경고만 — 배포를 롤백하지 않는다.
    ok, outcome = df.post_upload_flow('v-prev', 'v-new', lambda v: True, lambda: True, lambda v: True, lambda: False)
    assert ok and outcome == 'deployed', (ok, outcome)
    print('flow: schedules 실패 → 경고만, 배포 유지 PASS')




# ---------------------------------------------------------------------------
# audit P-1 (2026-10-28): Static Assets 업로드 — 네트워크 없이 검증
# ---------------------------------------------------------------------------
import base64 as _b64
import hashlib as _hashlib
import json as _json
import tempfile as _tempfile
import urllib.error as _urlerror
import urllib.request as _urlrequest
from pathlib import Path as _Path


def test_asset_hash_matches_documented_formula():
    # 공식 문서 예시와 동일한 식: sha256(base64(본문) + 확장자) 앞 32자(hex).
    # 식이 바뀌면(예: 확장자 누락) 서버의 중복 판정과 어긋나므로 핀을 박는다.
    data = b'<html>hello</html>'
    expected = _hashlib.sha256(_b64.b64encode(data) + b'html').hexdigest()[:32]
    assert df.asset_hash(data, 'html') == expected
    assert len(expected) == 32 and all(c in '0123456789abcdef' for c in expected)
    # 내용·확장자 중 하나만 바뀌어도 해시가 바뀐다 (충돌 방지 성질)
    assert df.asset_hash(b'<html>HELLO</html>', 'html') != expected
    assert df.asset_hash(data, 'css') != expected
    # 결정성: 같은 입력은 항상 같은 해시
    assert df.asset_hash(data, 'html') == expected
    print('asset_hash 문서 식 일치 PASS')


def test_build_assets_manifest():
    with _tempfile.TemporaryDirectory() as d:
        root = _Path(d)
        (root / 'a.html').write_bytes(b'<html/>')
        (root / 'sub').mkdir()
        (root / 'sub' / 'b.css').write_bytes(b'body{}')
        manifest, by_hash = df.build_assets_manifest(root)
        assert set(manifest) == {'/a.html', '/sub/b.css'}, manifest
        assert manifest['/a.html']['size'] == 7
        assert manifest['/sub/b.css']['size'] == 6
        assert manifest['/a.html']['hash'] == df.asset_hash(b'<html/>', 'html')
        # 역참조: 해시로 원본 파일을 찾는다 (버킷 업로드용)
        assert by_hash[manifest['/a.html']['hash']] == root / 'a.html'
        assert by_hash[manifest['/sub/b.css']['hash']] == root / 'sub' / 'b.css'
    with _tempfile.TemporaryDirectory() as d:
        try:
            df.build_assets_manifest(_Path(d))
            raise AssertionError('빈 디렉토리는 ValueError여야 한다')
        except ValueError:
            pass
    print('build_assets_manifest PASS')


def test_find_inline_markers():
    assert df.find_inline_markers(b'const x = 1;') == []
    assert df.find_inline_markers(b'const STATIC_FILES_B64={};') == ['STATIC_FILES_B64']
    # 구 번들처럼 여러 마커가 있으면 전부 보고한다
    found = df.find_inline_markers(b'AV_RUMI_B64="..." + WALLPAPER_B64')
    assert found == ['WALLPAPER_B64', 'AV_RUMI_B64'], found
    print('find_inline_markers PASS')


def test_build_worker_metadata_assets():
    md = df.build_worker_metadata('completion-jwt-123')
    # ASSETS 바인딩이 있어야 Worker에서 c.env.ASSETS를 쓸 수 있다
    bindings = {(b['type'], b['name']) for b in md['bindings']}
    assert ('assets', 'ASSETS') in bindings, bindings
    # 완료 토큰 + run_worker_first (없으면 에셋이 인증을 우회한다)
    assert md['assets']['jwt'] == 'completion-jwt-123'
    assert md['assets']['config'].get('run_worker_first') is True, md['assets']
    # html_handling='none': 기본 auto-trailing-slash는 /login.html → 307 → /login으로
    # 보내 무인증 리다이렉트 루프를 만든다 (wrangler dev 실측 확인)
    assert md['assets']['config'].get('html_handling') == 'none', md['assets']
    # 기존 바인딩·시크릿 보존 메커니즘은 그대로
    assert md['keep_bindings'] == ['secret_text', 'secret_key']
    names = {b['name'] for b in md['bindings']}
    assert {'DB', 'KV', 'AI', 'ASSETS', 'APP_NAME', 'ENVIRONMENT', 'ARTIFACT_QUEUE'} <= names
    # Google 쓰기 플래그 (2026-10-28 사용자 승인): plain_text 바인딩으로
    # 'true'가 있어야 다음 배포 뒤에도 쓰기가 켜진 채 유지된다.
    # keep_bindings는 시크릿만 보존하므로 이 바인딩이 빠지면 대시보드에서
    # 켠 플래그가 다음 배포 때 조용히 사라진다 — 그 퇴행을 잡는 단언이다.
    flag = next((b for b in md['bindings'] if b['name'] == 'GOOGLE_WRITE_ENABLED'), None)
    assert flag is not None, bindings
    assert flag['type'] == 'plain_text' and flag['text'] == 'true', flag
    print('build_worker_metadata ASSETS 연결 PASS')


def test_check_assets_staging():
    with _tempfile.TemporaryDirectory() as d:
        root = _Path(d)
        (root / 'scripts').mkdir()
        (root / 'scripts' / 'static-assets.json').write_text(
            _json.dumps({'files': ['/a.html', '/sub/b.css'], 'versioned': []}))
        staging = root / '.deploy-assets'
        (staging / 'sub').mkdir(parents=True)
        (staging / 'a.html').write_bytes(b'<html/>')
        (staging / 'sub' / 'b.css').write_bytes(b'body{}')
        ok, msg = df.check_assets_staging(root, staging)
        assert ok, msg
        # 누락: 집합에 있는 파일이 없으면 실패
        (staging / 'sub' / 'b.css').unlink()
        ok, msg = df.check_assets_staging(root, staging)
        assert not ok and '/sub/b.css' in msg, msg
        # 초과: 집합에 없는 파일이 있으면 실패
        (staging / 'sub' / 'b.css').write_bytes(b'body{}')
        (staging / 'extra.js').write_bytes(b'x')
        ok, msg = df.check_assets_staging(root, staging)
        assert not ok and '/extra.js' in msg, msg
    print('check_assets_staging PASS')


class _FakeResp:
    def __init__(self, body, status=200):
        self._body = body
        self.status = status
    def read(self, n=-1):
        out, self._body = self._body, b''
        return out
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


def test_upload_assets_bucket_multipart():
    seen = {}
    def fake_urlopen(req):
        seen['url'] = req.full_url
        seen['auth'] = req.get_header('Authorization')
        seen['ct'] = req.get_header('Content-type')
        seen['body'] = req.data
        payload = _json.dumps({'success': True, 'result': {'jwt': 'completion-jwt'}}).encode()
        return _FakeResp(payload, status=201)
    orig = _urlrequest.urlopen
    with _tempfile.TemporaryDirectory() as d:
        root = _Path(d)
        f = root / 'a.html'
        f.write_bytes(b'<html/>')
        h = df.asset_hash(b'<html/>', 'html')
        _urlrequest.urlopen = fake_urlopen
        try:
            status, jwt = df._upload_assets_bucket('session-jwt', [h], {h: f})
        finally:
            _urlrequest.urlopen = orig
    assert status == 201 and jwt == 'completion-jwt', (status, jwt)
    assert seen['url'] == 'https://api.cloudflare.com/client/v4/accounts/59e749ed2e9cdb8b0bf70d47227968a1/workers/assets/upload?base64=true'
    assert seen['auth'] == 'Bearer session-jwt', seen['auth']
    assert seen['ct'].startswith('multipart/form-data; boundary='), seen['ct']
    body = seen['body']
    # 필드명은 해시, 값은 base64 본문, Content-Type은 파일 MIME
    assert f'name="{h}"'.encode() in body, body[:400]
    assert _b64.b64encode(b'<html/>') in body
    assert b'Content-Type: text/html' in body
    print('_upload_assets_bucket multipart PASS')


def test_upload_assets_bucket_wasm_parts_mime():
    # WASM 조각(.wasm.part0/.part1)은 application/wasm으로 올려야 한다
    # (2026-11-12 오피스 성능 점검): mimetypes가 못 알아봐 octet-stream이
    # 되면 Cloudflare 압축 대상이 아니라 36MB를 통째로 내려받는다.
    seen = {}
    def fake_urlopen(req):
        seen['body'] = req.data
        payload = _json.dumps({'success': True, 'result': {'jwt': 'completion-jwt'}}).encode()
        return _FakeResp(payload, status=201)
    orig = _urlrequest.urlopen
    with _tempfile.TemporaryDirectory() as d:
        root = _Path(d)
        f0 = root / 'x_bg.wasm.part0'
        f1 = root / 'x_bg.wasm.part1'
        f0.write_bytes(b'\x00asm-part0')
        f1.write_bytes(b'\x00asm-part1')
        h0 = df.asset_hash(b'\x00asm-part0', 'part0')
        h1 = df.asset_hash(b'\x00asm-part1', 'part1')
        _urlrequest.urlopen = fake_urlopen
        try:
            status, jwt = df._upload_assets_bucket('session-jwt', [h0, h1], {h0: f0, h1: f1})
        finally:
            _urlrequest.urlopen = orig
    assert status == 201 and jwt == 'completion-jwt', (status, jwt)
    body = seen['body']
    assert body.count(b'Content-Type: application/wasm') == 2, body[:600]
    assert b'Content-Type: application/octet-stream' not in body
    print('_upload_assets_bucket wasm parts MIME PASS')


def test_upload_assets_bucket_failure():
    def fake_urlopen(req):
        raise _urlerror.HTTPError(req.full_url, 400, 'bad', {}, None)
    orig = _urlrequest.urlopen
    with _tempfile.TemporaryDirectory() as d:
        root = _Path(d)
        f = root / 'a.html'
        f.write_bytes(b'<html/>')
        h = df.asset_hash(b'<html/>', 'html')
        _urlrequest.urlopen = fake_urlopen
        try:
            # HTTPError 본문이 JSON이 아니어도 (None, None)을 돌려줘야 한다
            assert df._upload_assets_bucket('session-jwt', [h], {h: f}) == (None, None)
            # 버킷에 없는 해시는 업로드 전에 실패한다
            assert df._upload_assets_bucket('session-jwt', ['0' * 32], {h: f}) == (None, None)
        finally:
            _urlrequest.urlopen = orig
    print('_upload_assets_bucket 실패 경로 PASS')


def test_upload_assets_flow():
    orig_session = df.create_assets_upload_session
    orig_bucket = df._upload_assets_bucket
    try:
        with _tempfile.TemporaryDirectory() as d:
            root = _Path(d)
            (root / 'a.html').write_bytes(b'<html/>')
            # 정상: 세션 → 버킷 2개 → 마지막 201의 완료 jwt 반환
            df.create_assets_upload_session = lambda m: ('session-jwt', [['h1'], ['h2']])
            calls = []
            def fake_bucket(jwt, bucket, by_hash):
                calls.append(bucket)
                return (201, 'completion-jwt') if bucket == ['h2'] else (200, None)
            df._upload_assets_bucket = fake_bucket
            assert df.upload_assets(root) == 'completion-jwt'
            assert calls == [['h1'], ['h2']]
            # 버킷 없음(전부 캐시 적중): 세션 jwt를 완료 토큰으로 쓴다 (wrangler와 동일)
            df.create_assets_upload_session = lambda m: ('session-jwt', [])
            assert df.upload_assets(root) == 'session-jwt'
            # 세션 생성 실패 → None (배포 중단)
            df.create_assets_upload_session = lambda m: None
            assert df.upload_assets(root) is None
            # 버킷 실패 → None (배포 중단)
            df.create_assets_upload_session = lambda m: ('session-jwt', [['h1']])
            df._upload_assets_bucket = lambda *a: (None, None)
            assert df.upload_assets(root) is None
    finally:
        df.create_assets_upload_session = orig_session
        df._upload_assets_bucket = orig_bucket
    print('upload_assets 흐름 PASS')



def test_assets_config_matches_wrangler_toml():
    # deploy_full.py ASSETS_CONFIG와 wrangler.toml [assets]는 같은 동작이어야 한다.
    # 어긋나면 로컬 dev와 운영의 에셋 라우팅이 달라진다 (html_handling 루프 등).
    import re as _re
    toml = open('wrangler.toml', encoding='utf-8').read()
    m = _re.search(r'\[assets\](.*?)(?=\n\[|\Z)', toml, _re.S)
    assert m, 'wrangler.toml [assets] 없음'
    block = m.group(1)
    assert 'run_worker_first = true' in block, block
    assert 'html_handling = "none"' in block, block
    assert df.ASSETS_CONFIG.get('run_worker_first') is True
    assert df.ASSETS_CONFIG.get('html_handling') == 'none'
    print('ASSETS_CONFIG ↔ wrangler.toml 일치 PASS')

# ---------------------------------------------------------------------------
# verify 모드 (검증 전용, 2026-10-29 — P2 트랙 4): 순수 판정 로직 + 읽기 전용 보장
# 네트워크는 타지 않는다 (api_json·verify_deployment·스테이징 생성을 목킹).
# ---------------------------------------------------------------------------

def test_verify_arg_normalization_not_triggered_for_production():
    # 이 테스트 파일은 sys.argv=['deploy_full.py', 'production']으로 임포트하므로
    # verify 정규화가 발동하지 않아야 한다 (production 흐름 무변경의 최소 보장).
    assert df.VERIFY_ONLY is False
    assert sys.argv[1] == 'production'
    print('verify: production 인자에서는 VERIFY_ONLY 비활성 PASS')


def test_check_secret_names():
    full = set(df.REQUIRED_SECRET_NAMES) | {'EXTRA_KEY', 'ANOTHER_KEY'}
    ok, detail = df.check_secret_names(full)
    assert ok and str(len(full)) in detail, (ok, detail)
    # 핵심이 하나라도 빠지면 FAIL이고, 빠진 이름이 detail에 드러난다
    ok, detail = df.check_secret_names(full - {'SESSION_SECRET'})
    assert not ok and 'SESSION_SECRET' in detail, (ok, detail)
    # 빈 목록·조회 실패(None)는 '확인 불가'라 FAIL (배포 가드와 다른 판정)
    assert df.check_secret_names(set())[0] is False
    assert df.check_secret_names(None)[0] is False
    # 필수 집합을 인자로 바꾸면 판정도 바뀐다 (판정이 상수에 박힌 게 아님)
    assert df.check_secret_names({'A'}, required={'A'})[0] is True
    assert df.check_secret_names({'A'}, required={'A', 'B'})[0] is False
    print('check_secret_names 판정 PASS')


def test_check_cron_schedules():
    good = {'schedules': [{'cron': '*/5 * * * *'}]}
    ok, detail = df.check_cron_schedules(good)
    assert ok and '*/5 * * * *' in detail, (ok, detail)
    # 다른 스케줄만 있으면 FAIL
    assert df.check_cron_schedules({'schedules': [{'cron': '0 9 * * *'}]})[0] is False
    # 스케줄이 비어 있으면(미등록) FAIL — 2026-10-26 실측했던 상태
    assert df.check_cron_schedules({'schedules': []})[0] is False
    # 조회 실패(None)·형식 오류는 FAIL이지 예외가 아니다
    assert df.check_cron_schedules(None)[0] is False
    assert df.check_cron_schedules({'unexpected': 1})[0] is False
    assert df.parse_cron_schedules(None) is None
    assert df.parse_cron_schedules(good) == ['*/5 * * * *']
    print('check_cron_schedules 판정 PASS')


def _verify_fake_api(calls, schedules=None):
    secrets = [{'name': n} for n in sorted(df.REQUIRED_SECRET_NAMES)] + [{'name': 'EXTRA_KEY'}]
    def fake(method, path, payload=None):
        calls.append((method, path, payload))
        if path.endswith('/deployments'):
            return {'deployments': [{'versions': [{'version_id': 'v-live', 'percentage': 100}]}]}
        if path.endswith('/secrets'):
            return secrets
        if path.endswith('/schedules'):
            return {'schedules': [{'cron': '*/5 * * * *'}]} if schedules is None else schedules
        raise AssertionError(f'예상 밖 API 경로: {path}')
    return fake


def test_run_verify_only_readonly_all_pass():
    orig_api, orig_vd, orig_bs = df.api_json, df.verify_deployment, df.build_verify_staging
    calls = []
    try:
        df.api_json = _verify_fake_api(calls)
        df.verify_deployment = lambda *a: True
        df.build_verify_staging = lambda: ('deadbeef', _Path('/tmp'))
        assert df.run_verify_only() == 0
    finally:
        df.api_json, df.verify_deployment, df.build_verify_staging = orig_api, orig_vd, orig_bs
    # 읽기 전용 보장: 호출된 API는 전부 GET이고 payload가 없어야 한다.
    # (승격 POST·스케줄 PUT·업로드 PUT 중 하나라도 섞이면 여기서 잡힌다)
    assert calls, 'API 호출이 기록되지 않음'
    assert all(m == 'GET' and p is None for m, _, p in calls), calls
    print('run_verify_only: 전부 GET + 종합 PASS → 종료 코드 0 PASS')


def test_run_verify_only_fail_exit_code():
    orig_api, orig_vd, orig_bs = df.api_json, df.verify_deployment, df.build_verify_staging
    calls = []
    try:
        df.api_json = _verify_fake_api(calls, schedules={'schedules': []})
        df.verify_deployment = lambda *a: True
        df.build_verify_staging = lambda: ('deadbeef', _Path('/tmp'))
        # Cron 미등록이면 다른 항목이 통과해도 종합 FAIL → 종료 코드 1
        assert df.run_verify_only() == 1
        # 라이브 QA 자체가 실패해도 종료 코드 1
        df.api_json = _verify_fake_api(calls)
        df.verify_deployment = lambda *a: False
        assert df.run_verify_only() == 1
    finally:
        df.api_json, df.verify_deployment, df.build_verify_staging = orig_api, orig_vd, orig_bs
    print('run_verify_only: 항목 FAIL → 종료 코드 1 PASS')


def test_deploy_lock_acquire_release():
    import os, tempfile
    from pathlib import Path
    with tempfile.TemporaryDirectory() as td:
        lock = Path(td) / '.deploy_full.lock'
        got = df.acquire_deploy_lock(lock)
        assert got == lock and lock.exists()
        info = df._read_lock_info(lock)
        assert info['pid'] == os.getpid(), info
        assert 'deploy_full' in info['cmdline'], info
        df.release_deploy_lock(lock)
        assert not lock.exists()
    print('deploy lock 획득·해제 PASS')


def test_deploy_lock_contention_exit3():
    import os, json, tempfile
    from pathlib import Path
    with tempfile.TemporaryDirectory() as td:
        lock = Path(td) / '.deploy_full.lock'
        lock.write_text(json.dumps(
            {'pid': os.getpid(), 'cmdline': 'python3 deploy_full.py production',
             'started_at': 'x'}), encoding='utf-8')
        orig = df._lock_holder_alive
        df._lock_holder_alive = lambda info: True
        try:
            try:
                df.acquire_deploy_lock(lock)
                raise AssertionError('경합인데 잠금을 획득함')
            except SystemExit as e:
                assert e.code == 3, e.code
        finally:
            df._lock_holder_alive = orig
        # 남의 잠금은 해제되지 않는다
        assert lock.exists()
    print('deploy lock 경합 → exit 3 PASS')


def test_deploy_lock_stale_reclaim():
    import os, json, tempfile
    from pathlib import Path
    with tempfile.TemporaryDirectory() as td:
        lock = Path(td) / '.deploy_full.lock'
        # 죽은 pid의 잠금은 stale로 회수돼야 한다
        lock.write_text(json.dumps(
            {'pid': 99999999, 'cmdline': 'python3 deploy_full.py production',
             'started_at': 'x'}), encoding='utf-8')
        got = df.acquire_deploy_lock(lock)
        assert got == lock
        info = df._read_lock_info(lock)
        assert info['pid'] == os.getpid(), info
        df.release_deploy_lock(lock)
        assert not lock.exists()
    print('deploy lock stale 회수 PASS')


if __name__ == '__main__':
    print('=== deploy_full 안전장치 테스트 ===\n')
    test_flow_all_pass()
    test_flow_verify_fail_rolls_back()
    test_flow_promote_fail_rolls_back()
    test_flow_rollback_failure()
    test_flow_no_prev()
    test_flow_same_version_no_rollback()
    test_flow_no_new_version_verify_only()
    test_get_active_version_id_parsing()
    test_get_latest_version_id_parsing()
    test_missing_secrets()
    test_get_secret_names_parsing()
    test_ensure_cron_schedules_success()
    test_ensure_cron_schedules_put_fail()
    test_ensure_cron_schedules_mismatch()
    test_flow_calls_schedules_after_promote()
    test_flow_schedules_fail_warns_only()
    test_asset_hash_matches_documented_formula()
    test_build_assets_manifest()
    test_find_inline_markers()
    test_build_worker_metadata_assets()
    test_check_assets_staging()
    test_upload_assets_bucket_multipart()
    test_upload_assets_bucket_failure()
    test_upload_assets_flow()
    test_assets_config_matches_wrangler_toml()
    test_verify_arg_normalization_not_triggered_for_production()
    test_check_secret_names()
    test_check_cron_schedules()
    test_run_verify_only_readonly_all_pass()
    test_run_verify_only_fail_exit_code()
    test_deploy_lock_acquire_release()
    test_deploy_lock_contention_exit3()
    test_deploy_lock_stale_reclaim()
    print('\n=== 모든 테스트 PASS ===')
