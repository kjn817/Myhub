#!/usr/bin/env python3
"""MyHub 상시 자율 검증 프로브 (synthetic-probe) — 2026-11-08 재작성본.

원본은 2026-11-06 상시 자율 검증 체계(트랙 G)로 만들어져 6시간 간격 크론
`myhub-synthetic-probe`가 실행했으나, 2026-11-07 워크스페이스 소실 사고로
스크립트와 결과 파일이 함께 사라졌다. 이 파일은 크론 정의 본문과
2026-11-06/07 일일 로그에 남은 기록만으로 재작성한 것이다.

기록으로 확정된 사양 (크론 정의 본문):
- 비서 3명(루미·에코·캘리) 실호출 스모크 — 노바는 원본부터 제외.
- 보안엔진 고정 회귀 테스트 + 퍼징 측정.
- Clef 결정 로그 이상 감지.
- 운영 표면 건강 검사.
- 결과 축적: goal hidden_files/probe-log.jsonl (실행당 1줄) + probe-status.json (최신 상태).
- 종료 코드: 0=ALL NORMAL, 2=ANOMALY, 1=스크립트 실행 오류. 통상 실행 1~5분.

기록으로 확정된 판정 방식 (2026-11-06 로그):
- 보안엔진 판정은 라이브 실호출의 복원 일관성 간접 신호다 (확률적).
  일반 케이스와 ZW(제로폭 문자 삽입) 케이스를 매 실행 모두 돌리고,
  ZW 케이스에서 응답에 제로폭 문자가 남아 있으면 토큰화가 뚫린 것으로 본다.

재작성에서 새로 정한 것 (원본 기록에 없어 복원자가 명시하는 기본값):
- 인증: 원본의 자격 증명 경로는 기록에 없다. 이 스크립트는 값을 코드에
  박지 않고 아래 순서로만 세션을 얻는다 (값은 절대 출력·기록하지 않는다).
    1) 환경변수 MYHUB_SESSION_COOKIE (쿠키 값 전체)
    2) 파일 ~/.myhub/probe-session-cookie (첫 줄 = 쿠키 값)
    3) 환경변수 MYHUB_PROBE_PIN 또는 ~/workspace/myhub/.env 의 MYHUB_PIN
       → POST /api/auth/pin-login 으로 세션 발급
  셋 다 없으면 인증 필요 검사는 auth_unavailable 사유로 실패(ANOMALY) 처리해
  침묵하지 않는다 — 자격 증명 재공급이 필요한 상태 자체를 보이게 하기 위함.
- Clef 이상 기준: 2026-11-07 01:52 ALL NORMAL 시점에도 결정 로그는
  27시간째 신규 행이 없었다(최종 행 2026-11-05T22:52Z). 따라서 '최근 행
  없음'은 그 자체로 이상으로 보지 않고 지표로만 기록한다. 이상은
  라우터 모드 설정 부재·이상값, 로그 값 sanity 위반(top_prob 범위,
  probabilities_json 파싱, choice 값域)으로만 판정한다.
- 퍼징 케이스 수·토큰화율 임계값(0.8)은 재작성 기본값이다.

합성 카나리아 값은 전부 테스트용 가짜다 (테스트 카드번호·예시 이름·가상 주소).
"""

import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# 상수
# ---------------------------------------------------------------------------

BASE_URL = 'https://myhub.myhub-app.workers.dev'
KST = timezone(timedelta(hours=9))

GOAL_DIR = Path.home() / 'workspace' / 'goals' / 'myhub-hobby-web-service-on-cloudflare'
LOG_PATH = GOAL_DIR / 'hidden_files' / 'probe-log.jsonl'
STATUS_PATH = GOAL_DIR / 'hidden_files' / 'probe-status.json'

UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0 Safari/537.36')

CHAT_TIMEOUT = 120          # 비서 실호출 1건 상한 (초)
HTTP_TIMEOUT = 30
FUZZ_CASES = 6              # 퍼징 케이스 수 (재작성 기본값)
FUZZ_MIN_TOKENIZED_RATE = 0.8

ZW_CHARS = ['​', '‌', '‍', '﻿']  # ZWSP, ZWNJ, ZWJ, BOM(ZWNBSP)

# D1 (Clef 로그·설정 조회) — deploy_full.py와 같은 surrogate 자격 증명 경로.
CF_CREDENTIAL = 'custom.cloudflare'
CF_ACCOUNT_ID = '59e749ed2e9cdb8b0bf70d47227968a1'
CF_DB_ID = '0dd871c5-3d1c-4cea-bfbe-3e258f477106'

PERSONAS = {                # 레거시 ID (routes.ts 계약)
    'lumi': 'concierge',    # 루미 — Gemini
    'echo': 'keeper',       # 에코 — 비메모 턴 NVIDIA
    'cali': 'scheduler',    # 캘리 — Groq
}

# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------


def http(method, url, body=None, headers=None, timeout=HTTP_TIMEOUT):
    """(status, parsed_json_or_text, headers) 반환. HTTP 오류도 status로 돌려준다.

    urllib 전송이 엣지에서 끊기는 경우(RemoteDisconnected·IncompleteRead —
    정적 에셋 응답에서 재현됨)가 있어 curl로 1회 폴백한다 (deploy_full.py와
    같은 이유·방식)."""
    try:
        return _http_urllib(method, url, body, headers, timeout)
    except Exception:
        return _http_curl(method, url, body, headers, timeout)


def _http_urllib(method, url, body, headers, timeout):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('User-Agent', UA)
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode('utf-8', 'replace')
            return resp.status, _maybe_json(raw), resp.headers
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'replace') if e.fp else ''
        return e.code, _maybe_json(raw), e.headers or {}


def _http_curl(method, url, body, headers, timeout):
    import http.client
    import io
    import subprocess
    import tempfile
    with tempfile.NamedTemporaryFile() as bf, tempfile.NamedTemporaryFile() as hf:
        args = ['curl', '-sS', '-L', '-X', method, '-A', UA,
                '-o', bf.name, '-D', hf.name, '-w', '%{http_code}',
                '--max-time', str(timeout)]
        if body is not None:
            args += ['-H', 'Content-Type: application/json',
                     '--data-binary', json.dumps(body)]
        for k, v in (headers or {}).items():
            args += ['-H', f'{k}: {v}']
        args.append(url)
        out = subprocess.run(args, capture_output=True, text=True, timeout=timeout + 10)
        status = int(out.stdout.strip() or '0')
        raw = Path(bf.name).read_bytes().decode('utf-8', 'replace')
        header_text = Path(hf.name).read_bytes().decode('iso-8859-1', 'replace')
        # 리다이렉트·100-continue 블록이 있으면 마지막 블록만 쓴다
        blocks = [b for b in header_text.replace('\r\n', '\n').split('\n\n') if b.strip()]
        parsed_headers = http.client.parse_headers(io.BytesIO(blocks[-1].encode())) if blocks else {}
        return status, _maybe_json(raw), parsed_headers


def _maybe_json(raw):
    try:
        return json.loads(raw)
    except Exception:
        return raw


# ---------------------------------------------------------------------------
# 세션 획득 (값은 절대 출력·기록하지 않는다)
# ---------------------------------------------------------------------------


def _read_dotenv_pin():
    env_path = Path.home() / 'workspace' / 'myhub' / '.env'
    try:
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line.startswith('MYHUB_PIN='):
                return line.split('=', 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return None


def acquire_session():
    """(cookie_header_value, method) 또는 (None, None)."""
    cookie = os.environ.get('MYHUB_SESSION_COOKIE', '').strip()
    if cookie:
        return cookie, 'env_cookie'
    cookie_file = Path.home() / '.myhub' / 'probe-session-cookie'
    try:
        value = cookie_file.read_text().splitlines()[0].strip()
        if value:
            return value, 'cookie_file'
    except Exception:
        pass
    pin = os.environ.get('MYHUB_PROBE_PIN', '').strip() or _read_dotenv_pin()
    if pin:
        status, body, headers = http('POST', BASE_URL + '/api/auth/pin-login', {'pin': pin})
        if status == 200 and isinstance(body, dict) and body.get('ok'):
            set_cookie = headers.get('Set-Cookie') or ''
            if 'myhub_session=' in set_cookie:
                return set_cookie.split(';', 1)[0], 'pin_login'
        return None, 'pin_login_failed'
    return None, None


# ---------------------------------------------------------------------------
# D1 조회 (Cloudflare API + surrogate)
# ---------------------------------------------------------------------------


def d1_query(sql, params=None):
    sys.path.insert(0, '/opt/hatch/skills/skill-creator/bin')
    from dynamic_credentials import add_surrogate_to_request, read_json_response
    url = (f'https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}'
           f'/d1/database/{CF_DB_ID}/query')
    req = urllib.request.Request(
        url, data=json.dumps({'sql': sql, 'params': params or []}).encode(), method='POST')
    req.add_header('Content-Type', 'application/json')
    req.add_header('User-Agent', UA)
    add_surrogate_to_request(req, CF_CREDENTIAL, allowed_hosts=['api.cloudflare.com'])
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = read_json_response(resp)
    if not payload.get('success'):
        raise RuntimeError(f"D1 query failed: {str(payload.get('errors'))[:200]}")
    return payload['result'][0]['results']


# ---------------------------------------------------------------------------
# 비서 실호출
# ---------------------------------------------------------------------------


def chat(cookie, persona_legacy_id, prompt, timeout=CHAT_TIMEOUT):
    status, body, _ = http(
        'POST', BASE_URL + '/api/ai/chat',
        {'personaId': persona_legacy_id, 'messages': [{'role': 'user', 'content': prompt}]},
        headers={'Cookie': cookie}, timeout=timeout)
    if status != 200 or not isinstance(body, dict) or not body.get('ok'):
        raise RuntimeError(f'chat {persona_legacy_id} HTTP {status}: {str(body)[:200]}')
    return body


# ---------------------------------------------------------------------------
# 검사 1: 운영 표면 건강
# ---------------------------------------------------------------------------


def check_surface():
    metrics = {}
    problems = []
    for name, path, want in [
        ('health', '/api/health', 200),
        ('login_page', '/login.html', 200),
        ('root', '/', 200),
    ]:
        t0 = time.time()
        status, body, _ = http('GET', BASE_URL + path)
        metrics[f'{name}_ms'] = round((time.time() - t0) * 1000)
        metrics[f'{name}_status'] = status
        if status != want:
            problems.append(f'{name} HTTP {status} (기대 {want})')
        elif name == 'health' and not (isinstance(body, dict) and body.get('ok')):
            problems.append('health 응답 ok 아님')
    # 인증 경계: 무인증 채팅은 거부돼야 한다
    status, _, _ = http('POST', BASE_URL + '/api/ai/chat',
                        {'personaId': 'concierge', 'messages': [{'role': 'user', 'content': 'ping'}]})
    metrics['unauth_chat_status'] = status
    if status not in (401, 403):
        problems.append(f'무인증 채팅이 거부되지 않음 (HTTP {status})')
    return problems, metrics


# ---------------------------------------------------------------------------
# 검사 2: 비서 3명 실호출 스모크
# ---------------------------------------------------------------------------


def check_assistants(cookie):
    metrics = {}
    problems = []
    for name, legacy in PERSONAS.items():
        t0 = time.time()
        try:
            body = chat(cookie, legacy, '안녕하세요. 한 문장으로 짧게 인사해 주세요.')
            metrics[f'{name}_ms'] = round((time.time() - t0) * 1000)
            metrics[f'{name}_model'] = body.get('model')
            if not (body.get('text') or '').strip():
                problems.append(f'{name} 응답 본문이 비어 있음')
        except Exception as e:
            problems.append(f'{name} 실호출 실패: {str(e)[:160]}')
    return problems, metrics


# ---------------------------------------------------------------------------
# 검사 3: 보안엔진 고정 회귀 + 퍼징 (라이브 실호출, 복원 일관성 신호)
# ---------------------------------------------------------------------------

TEST_NAME = '김도현'
TEST_ADDR = '경기도 성남시 분당구 판교로 999, 101동 202호'
TEST_CARD = '4111-1111-1111-1111'          # Visa 테스트 번호 (합성)
TEST_PHONE = '010-9876-5432'               # 합성
TEST_ACCOUNT = '110-987-654321'            # 합성 계좌 형식


def _zw_insert(text, rng):
    if len(text) < 2:
        return text
    pos = rng.randrange(1, len(text))
    return text[:pos] + rng.choice(ZW_CHARS) + text[pos:]


def _has_zw(text):
    return any(z in text for z in ZW_CHARS)


def _text_case(cookie, label, sentence, expect_clean):
    """따라쓰기 케이스. 반환: 'tokenized' | 'leaked' | 'inconclusive'"""
    body = chat(cookie, PERSONAS['lumi'],
                f'다음 문장을 글자 하나도 바꾸지 말고 그대로 다시 써 주세요.\n문장: {sentence}')
    reply = body.get('text') or ''
    if _has_zw(reply):
        return 'leaked'
    if expect_clean in reply:
        return 'tokenized'
    return 'inconclusive'


def _pattern_case(cookie, label, secret, spaced_instruction_hint):
    """패턴(카드·전화·계좌) 케이스: 자릿수 사이 공백 삽입을 시켜 본다.
    모델이 원문을 봤으면 공백 삽입본을 만들 수 있고, 토큰화됐으면 만들 수 없다."""
    body = chat(cookie, PERSONAS['lumi'],
                f'다음 문장에서 {spaced_instruction_hint} 부분만 골라, 각 글자 사이에 '
                f'공백을 하나씩 넣어 다시 써 주세요. 다른 설명은 하지 마세요.\n문장: {secret}')
    reply = body.get('text') or ''
    digits_only = secret.replace('-', '')
    spaced = ' '.join(digits_only)
    if spaced in reply:
        # 공백 삽입본을 만들었다 = 모델이 원문을 직접 봤다
        return 'leaked'
    if not any(ch.isdigit() for ch in reply):
        return 'inconclusive'
    # 연속 숫자(토큰 복원 에코)만 있거나 일부만 있으면 토큰화된 것으로 본다
    return 'tokenized'


def check_privacy(cookie):
    problems = []
    metrics = {}
    rng = random.Random()

    fixed = []
    fixed.append(('name_plain', _text_case(
        cookie, 'name_plain', f'연락처 메모: {TEST_NAME} 님', TEST_NAME)))
    fixed.append(('addr_plain', _text_case(
        cookie, 'addr_plain', f'배송지: {TEST_ADDR}', TEST_ADDR)))
    fixed.append(('name_zw', _text_case(
        cookie, 'name_zw', f'연락처 메모: {_zw_insert(TEST_NAME, rng)} 님', TEST_NAME)))
    fixed.append(('addr_zw', _text_case(
        cookie, 'addr_zw', f'배송지: {_zw_insert(TEST_ADDR, rng)}', TEST_ADDR)))
    for label, secret, hint in [
        ('card', TEST_CARD, '카드번호'),
        ('phone', TEST_PHONE, '전화번호'),
        ('account', TEST_ACCOUNT, '계좌번호'),
    ]:
        fixed.append((label, _pattern_case(cookie, label, secret, hint)))
    metrics['fixed'] = dict(fixed)
    for label, verdict in fixed:
        if verdict == 'leaked':
            problems.append(f'고정 카나리아 {label} 유출 신호 (verdict=leaked)')

    # 퍼징: 이름·주소·전화 변형 (ZW 삽입 무작위)
    surnames = ['김', '이', '박', '최', '정', '강', '조', '윤']
    given = ['도현', '서연', '민준', '지우', '하은', '준서', '수아', '예준']
    verdicts = []
    for i in range(FUZZ_CASES):
        name = rng.choice(surnames) + rng.choice(given)
        addr = (f"{rng.choice(['서울특별시', '부산광역시', '경기도 수원시', '인천광역시'])} "
                f"{rng.choice(['강남구', '해운대구', '영통구', '연수구'])} "
                f"테스트로 {rng.randrange(10, 999)}, {rng.randrange(101, 150)}동 {rng.randrange(101, 250)}호")
        target, clean = (name, name) if i % 2 == 0 else (addr, addr)
        if rng.random() < 0.5:
            target = _zw_insert(target, rng)
        sentence = f'메모: {target}' if i % 2 == 0 else f'배송지: {target}'
        verdicts.append(_text_case(cookie, f'fuzz{i}', sentence, clean))
    metrics['fuzz_verdicts'] = verdicts
    tokenized = verdicts.count('tokenized')
    metrics['fuzz_tokenized_rate'] = round(tokenized / len(verdicts), 3) if verdicts else 0
    if any(v == 'leaked' for v in verdicts):
        problems.append(f'퍼징 유출 신호 {verdicts.count("leaked")}건')
    elif metrics['fuzz_tokenized_rate'] < FUZZ_MIN_TOKENIZED_RATE:
        problems.append(
            f"퍼징 토큰화율 {metrics['fuzz_tokenized_rate']} < 기준 {FUZZ_MIN_TOKENIZED_RATE} "
            f'(verdicts={verdicts})')
    return problems, metrics


# ---------------------------------------------------------------------------
# 검사 4: Clef 결정 로그 + 설정 정합
# ---------------------------------------------------------------------------


def check_clef():
    problems = []
    metrics = {}
    settings = {r['key']: r['value'] for r in d1_query(
        "SELECT key, value FROM ai_settings WHERE key IN ('clef.router_mode', 'privacy.korean_mode')")}
    metrics['settings'] = settings
    if settings.get('clef.router_mode') not in ('active', 'shadow', 'off'):
        problems.append(f"clef.router_mode 이상값: {settings.get('clef.router_mode')!r}")
    if settings.get('privacy.korean_mode') != 'enforce':
        problems.append(f"privacy.korean_mode가 enforce가 아님: {settings.get('privacy.korean_mode')!r}")

    rows = d1_query(
        'SELECT COUNT(*) AS total, MAX(created_at) AS latest FROM clef_decision_log')
    metrics['clef_total'] = rows[0]['total']
    metrics['clef_latest'] = rows[0]['latest']
    for label, hours in [('6h', 6), ('24h', 24)]:
        r = d1_query(
            "SELECT COUNT(*) AS n FROM clef_decision_log WHERE created_at > datetime('now', ?)",
            [f'-{hours} hours'])
        metrics[f'clef_rows_{label}'] = r[0]['n']
    r = d1_query("SELECT COUNT(*) AS n FROM ai_usage WHERE created_at > datetime('now', '-6 hours')")
    metrics['ai_usage_rows_6h'] = r[0]['n']

    bad = d1_query(
        'SELECT COUNT(*) AS n FROM clef_decision_log WHERE top_prob < 0 OR top_prob > 1')
    if bad[0]['n']:
        problems.append(f"clef_decision_log top_prob 범위 위반 {bad[0]['n']}건")
    bad = d1_query(
        'SELECT COUNT(*) AS n FROM clef_decision_log WHERE NOT json_valid(probabilities_json)')
    if bad[0]['n']:
        problems.append(f"clef_decision_log probabilities_json 파싱 불가 {bad[0]['n']}건")
    choices = {r['choice'] for r in d1_query('SELECT DISTINCT choice FROM clef_decision_log') if r['choice']}
    metrics['clef_choices'] = sorted(choices)
    unknown = choices - {'lumi', 'echo', 'nova', 'cali', 'concierge', 'keeper', 'builder', 'scheduler'}
    if unknown:
        problems.append(f'clef_decision_log 알 수 없는 choice: {sorted(unknown)}')
    return problems, metrics


# ---------------------------------------------------------------------------
# 실행·기록
# ---------------------------------------------------------------------------


def run():
    started = time.time()
    checks = {}

    def record(name, fn):
        try:
            problems, metrics = fn()
            checks[name] = {
                'status': 'fail' if problems else 'pass',
                'problems': problems,
                'metrics': metrics,
            }
        except Exception as e:
            checks[name] = {'status': 'fail', 'problems': [f'검사 실행 오류: {str(e)[:300]}'], 'metrics': {}}

    record('surface', check_surface)

    cookie, auth_method = acquire_session()
    if cookie:
        record('assistants', lambda: check_assistants(cookie))
        record('privacy', lambda: check_privacy(cookie))
    else:
        reason = f'auth_unavailable (method={auth_method}) — 자격 증명 재공급 필요'
        for name in ('assistants', 'privacy'):
            checks[name] = {'status': 'fail', 'problems': [reason], 'metrics': {}}

    record('clef', check_clef)

    failed = [n for n, c in checks.items() if c['status'] != 'pass']
    overall = 'ANOMALY' if failed else 'ALL NORMAL'
    result = {
        'ts': datetime.now(KST).isoformat(timespec='seconds'),
        'overall': overall,
        'auth_method': auth_method,
        'duration_ms': round((time.time() - started) * 1000),
        'checks': checks,
    }

    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open('a', encoding='utf-8') as f:
        f.write(json.dumps(result, ensure_ascii=False) + '\n')
    STATUS_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')

    for name, c in checks.items():
        line = f"[{c['status'].upper()}] {name}"
        if c['problems']:
            line += ' — ' + '; '.join(c['problems'])
        print(line)
    print(overall)
    return 2 if failed else 0


def main():
    try:
        return run()
    except Exception as e:
        # 스크립트 자체의 실행 오류 (종료 코드 1). 가능한 범위에서 기록을 남긴다.
        print(f'PROBE ERROR: {type(e).__name__}: {str(e)[:300]}')
        try:
            LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
            with LOG_PATH.open('a', encoding='utf-8') as f:
                f.write(json.dumps({
                    'ts': datetime.now(KST).isoformat(timespec='seconds'),
                    'overall': 'ERROR',
                    'error': f'{type(e).__name__}: {str(e)[:300]}',
                }, ensure_ascii=False) + '\n')
        except Exception:
            pass
        return 1


if __name__ == '__main__':
    sys.exit(main())
