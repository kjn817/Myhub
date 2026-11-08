#!/usr/bin/env python3
"""
MyHub 운영 암호화 백업 (P0, 2026-10-29)

운영 D1을 읽기 전용으로 조회해 Worker 백업 엔드포인트와 동일한 형식
(format_version 1: PBKDF2-SHA256 100k, salt 16B, iv 12B, AES-256-GCM)으로
암호화 백업 파일을 만든다.

왜 엔드포인트가 아니라 D1 API인가:
  구 배포본의 /api/backup/encrypted는 ENVIRONMENT=production에서 403이라
  운영 백업이 불가능했다 (2026-10-29 라이브 실증). routes.ts에서 암호화
  경로의 운영 허용으로 고쳤으나, 배포 전까지의 운영 백업 + 정기 백업의
  자동화 경로는 이 스크립트다. 포맷이 같아 복원 스크립트 하나로 통한다.

백업 범위: src/modules/backup/routes.ts의 BACKUP_TABLES를 파싱해 그대로
쓴다 (단일 진실원 — 스크립트에 목록을 복제하지 않는다).

사용법:
  MYHUB_BACKUP_PASSWORD='...' python3 scripts/backup_production.py \
      --output ~/workspace/myhub-backups/myhub-backup-YYYYMMDD-HHMM.json

인증: CF_API_TOKEN 환경변수가 있으면 Bearer, 없으면 Muse 커넥터
surrogate (custom.cloudflare)를 사용한다. 비밀번호·토큰은 출력하지 않는다.
백업 산출물은 저장소 안에 쓰지 말 것.
"""

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone

ACCOUNT_ID = '59e749ed2e9cdb8b0bf70d47227968a1'  # wrangler.toml과 동일 (공개 식별자)
DB_ID = '0dd871c5-3d1c-4cea-bfbe-3e258f477106'  # myhub-db (운영)
PBKDF2_ITERATIONS = 100000
PAGE_SIZE = 500

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes
except ImportError:
    print('오류: cryptography 패키지 필요 (pip install --user cryptography)')
    sys.exit(1)


def load_backup_tables(repo_root: str) -> list:
    src = open(os.path.join(repo_root, 'src/modules/backup/routes.ts')).read()
    m = re.search(r'export const BACKUP_TABLES = \[(.*?)\]', src, re.S)
    if not m:
        raise SystemExit('BACKUP_TABLES를 routes.ts에서 찾지 못함')
    return re.findall(r"'([a-z0-9_]+)'", m.group(1))


def d1_query(sql: str, params=None) -> list:
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/d1/database/{DB_ID}/query'
    body = json.dumps({'sql': sql, 'params': params or []}).encode()
    req = urllib.request.Request(url, data=body, method='POST')
    req.add_header('Content-Type', 'application/json')
    token = os.environ.get('CF_API_TOKEN')
    if token:
        req.add_header('Authorization', f'Bearer {token}')
    else:
        sys.path.insert(0, '/opt/muse/skills/custom-connector-setup/bin')
        from dynamic_credentials import add_surrogate_to_request
        add_surrogate_to_request(req, 'custom.cloudflare', allowed_hosts=['api.cloudflare.com'])
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.loads(resp.read().decode())
    if not payload.get('success'):
        raise RuntimeError(f'D1 query failed: {payload.get("errors")}')
    return payload['result'][0]['results']


def fetch_table(table: str) -> list:
    rows = []
    offset = 0
    while True:
        page = d1_query(f'SELECT * FROM "{table}" LIMIT ? OFFSET ?', [PAGE_SIZE, offset])
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            return rows
        offset += PAGE_SIZE
        time.sleep(0.2)


def main():
    ap = argparse.ArgumentParser(description='MyHub 운영 암호화 백업')
    ap.add_argument('--output', required=True, help='출력 파일 경로 (저장소 밖 권장)')
    ap.add_argument('--repo-root', default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    args = ap.parse_args()

    password = os.environ.get('MYHUB_BACKUP_PASSWORD')
    if not password or len(password) < 8:
        raise SystemExit('MYHUB_BACKUP_PASSWORD 환경변수 필요 (최소 8자)')

    tables = load_backup_tables(args.repo_root)
    print(f'백업 대상: {len(tables)}개 테이블 (routes.ts BACKUP_TABLES)')

    plaintext = {
        'version': 6,
        'created_at': datetime.now(timezone.utc).isoformat(),
        'method': 'd1-api-readonly (backup_production.py)',
        'tables': {},
    }
    total = 0
    for t in tables:
        rows = fetch_table(t)
        plaintext['tables'][t] = {'row_count': len(rows), 'rows': rows}
        total += len(rows)
        print(f'  {t}: {len(rows)}건')
    plaintext['integrity'] = {'table_count': len(tables), 'total_rows': total}

    # 첨부 실물 포함 (트랙 4, 2026-10-31 — Worker v6와 동일 형식).
    # 저장 바이트를 그대로 싣는다 (잠긴 첨부는 MEMO_ENCRYPTION_KEY 암호문인
    # 채로 백업 암호에 한 번 더 감싸진다). 하나라도 못 받으면 중단한다
    # (fail-closed — 불완전한 백업을 만들지 않는다).
    import hashlib
    att_items = []
    att_missing = []
    att_bytes = 0
    for row in plaintext['tables'].get('files', {}).get('rows', []):
        url = row.get('url')
        if not url:
            att_missing.append(row.get('id'))
            continue
        try:
            with urllib.request.urlopen(url, timeout=60) as resp:
                data = resp.read()
        except Exception:
            raise SystemExit(f"첨부 다운로드 실패로 백업 중단: file_id={row.get('id')}")
        att_items.append({
            'file_id': row.get('id'),
            'storage_key': row.get('storage_key'),
            'filename': row.get('filename'),
            'is_locked': 1 if row.get('is_locked') else 0,
            'size': len(data),
            'sha256': hashlib.sha256(data).hexdigest(),
            'data_base64': base64.b64encode(data).decode(),
        })
        att_bytes += len(data)
    plaintext['attachments'] = {
        'included': True,
        'count': len(att_items),
        'total_bytes': att_bytes,
        'missing_file_ids': att_missing,
        'items': att_items,
    }
    print(f'  첨부 실물: {len(att_items)}건, {att_bytes:,} bytes')

    salt = os.urandom(16)
    iv = os.urandom(12)
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=PBKDF2_ITERATIONS)
    key = kdf.derive(password.encode())
    ciphertext = AESGCM(key).encrypt(iv, json.dumps(plaintext, ensure_ascii=False).encode(), None)

    encrypted = {
        'format_version': 1,
        'algorithm': 'AES-256-GCM',
        'kdf': 'PBKDF2-SHA256',
        'iterations': PBKDF2_ITERATIONS,
        'salt': base64.b64encode(salt).decode(),
        'iv': base64.b64encode(iv).decode(),
        'ciphertext': base64.b64encode(ciphertext).decode(),
        'created_at': plaintext['created_at'],
        'table_count': len(tables),
        'total_rows': total,
        'attachments_included': True,
        'attachment_count': len(att_items),
        'attachment_bytes': att_bytes,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, 'w') as f:
        json.dump(encrypted, f)
    os.chmod(args.output, 0o600)
    print(f'완료: {args.output} ({os.path.getsize(args.output):,} bytes, 총 {total}행, 암호문만 포함)')


if __name__ == '__main__':
    main()
