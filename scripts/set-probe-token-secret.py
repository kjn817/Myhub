#!/usr/bin/env python3
"""PROBE_TOKEN Worker 시크릿 등록 (3기둥 합성 프로브 전용 토큰, 2026-11-26).

- 토큰 값은 ~/.myhub/probe-token (0600)에서 읽는다. 값은 절대 출력하지 않는다.
- Cloudflare API PUT /accounts/{id}/workers/scripts/myhub/secrets 로 등록한다.
- 성공/실패만 출력한다. 재실행 시 같은 값으로 덮어쓴다 (멱등).
- 로테이션이 필요하면 토큰 파일을 새로 만들고 이 스크립트를 다시 실행한다.
"""
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, '/opt/hatch/skills/skill-creator/bin')
from dynamic_credentials import add_surrogate_to_request, read_json_response

CREDENTIAL = 'custom.cloudflare'
ACCOUNT_ID = '59e749ed2e9cdb8b0bf70d47227968a1'
SCRIPT_NAME = 'myhub'
TOKEN_PATH = Path.home() / '.myhub' / 'probe-token'


def main() -> int:
    try:
        token = TOKEN_PATH.read_text().splitlines()[0].strip()
    except Exception as e:
        print(f'FAIL: 토큰 파일을 읽을 수 없음 ({TOKEN_PATH}): {type(e).__name__}')
        return 1
    if len(token) < 32:
        print('FAIL: 토큰이 너무 짧음 (32자 이상 필요)')
        return 1
    url = (f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}'
           f'/workers/scripts/{SCRIPT_NAME}/secrets')
    req = urllib.request.Request(
        url,
        data=json.dumps({'name': 'PROBE_TOKEN', 'text': token,
                         'type': 'secret_text'}).encode(),
        method='PUT')
    req.add_header('Content-Type', 'application/json')
    add_surrogate_to_request(req, CREDENTIAL, allowed_hosts=['api.cloudflare.com'])
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = read_json_response(resp)
    except Exception as e:
        print(f'FAIL: API 호출 실패: {type(e).__name__}: {str(e)[:200]}')
        return 1
    if payload.get('success'):
        print('OK: PROBE_TOKEN 시크릿 등록 완료')
        return 0
    print(f"FAIL: API 오류: {str(payload.get('errors'))[:200]}")
    return 1


if __name__ == '__main__':
    sys.exit(main())
