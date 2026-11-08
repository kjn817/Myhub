#!/usr/bin/env python3
"""D1 마이그레이션 적용 (Cloudflare API 직접 호출)"""
import sys
sys.path.insert(0, '/opt/hatch/skills/skill-creator/bin')
sys.path.insert(0, '/home/hatch/workspace/skills/cloudflare/bin')

from dynamic_credentials import add_surrogate_to_request, read_json_response
import urllib.request
import json

ACCOUNT_ID = '59e749ed2e9cdb8b0bf70d47227968a1'
DB_ID = '0dd871c5-3d1c-4cea-bfbe-3e258f477106'

def apply_sql(sql_text):
    # 여러 문장을 분리 (간단한 분리, -- 주석 처리)
    # D1 API는 한 번에 하나의 statement만 받으므로 분리 필요
    statements = []
    current = []
    for line in sql_text.split('\n'):
        stripped = line.strip()
        if stripped.startswith('--') or not stripped:
            continue
        current.append(line)
        if stripped.endswith(';'):
            statements.append('\n'.join(current))
            current = []
    if current:
        statements.append('\n'.join(current))

    url = f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/d1/database/{DB_ID}/query'

    for i, stmt in enumerate(statements):
        stmt = stmt.strip()
        if not stmt:
            continue
        body = json.dumps({'sql': stmt}).encode()
        req = urllib.request.Request(url, data=body, method='POST')
        req.add_header('Content-Type', 'application/json')
        add_surrogate_to_request(req, 'custom.cloudflare', allowed_hosts=['api.cloudflare.com'])

        try:
            resp = urllib.request.urlopen(req, timeout=30)
            data = read_json_response(resp)
            if not data.get('success'):
                print(f'Statement {i+1} FAILED: {data.get("errors")}')
                return False
            print(f'Statement {i+1} OK')
        except Exception as e:
            print(f'Statement {i+1} ERROR: {e}')
            return False
    return True

if __name__ == '__main__':
    path = sys.argv[1]
    with open(path) as f:
        sql = f.read()
    ok = apply_sql(sql)
    sys.exit(0 if ok else 1)
