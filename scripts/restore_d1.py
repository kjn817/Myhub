#!/usr/bin/env python3
"""
MyHub 복원 스크립트 (Phase 4D-2)

암호화된 백업을 격리 D1에 복원
"""

import sys
import os
import json
import base64
import argparse
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, '/home/hatch/workspace/skills/cloudflare/bin')
from cf_api import api_call

ACCT = '59e749ed2e9cdb8b0bf70d47227968a1'

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.exceptions import InvalidTag
except ImportError:
    print("오류: cryptography 패키지 필요")
    sys.exit(1)

def get_key():
    key_b64 = os.environ.get('MYHUB_BACKUP_KEY')
    if not key_b64:
        raise Exception("MYHUB_BACKUP_KEY 필요")
    key = base64.b64decode(key_b64)
    if len(key) != 32:
        raise Exception("키는 32바이트여야 함")
    return key

def decrypt_backup(encrypted: dict, key: bytes) -> bytes:
    aesgcm = AESGCM(key)
    nonce = base64.b64decode(encrypted['nonce'])
    ciphertext = base64.b64decode(encrypted['ciphertext'])
    try:
        return aesgcm.decrypt(nonce, ciphertext, None)
    except InvalidTag:
        raise Exception("복호화 실패: 키 오류 또는 파일 변조")

def q(db_id, sql, params=None):
    time.sleep(0.3)
    r = api_call('POST', f'/accounts/{ACCT}/d1/database/{db_id}/query',
                 {'sql': sql, 'params': params or []})
    if not r.get('success'):
        raise Exception(f"Query failed: {r.get('errors')}")
    return r['result'][0]['results']

def escape_value(v):
    if v is None:
        return 'NULL'
    if isinstance(v, (int, float)):
        # 큰 정수 정밀도 유지 (Python int는 임의 정밀도)
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"

def main():
    parser = argparse.ArgumentParser(description='MyHub 복원')
    parser.add_argument('--input', required=True, help='암호화된 백업 파일')
    parser.add_argument('--db-id', required=True, help='대상 D1 ID (격리 DB만!)')
    parser.add_argument('--confirm-isolated', action='store_true',
                        help='격리 DB임을 확인')
    args = parser.parse_args()

    if not args.confirm_isolated:
        raise Exception("--confirm-isolated 플래그 필요 (운영 DB 보호)")

    # 운영 DB ID 차단
    PROD_DB = '0dd871c5-3d1c-4cea-bfbe-3e258f477106'
    STAGING_DB = '995184a9-b291-402c-adf5-0d8d80a59e1c'
    if args.db_id in (PROD_DB, STAGING_DB):
        raise Exception("운영/스테이징 DB에는 복원할 수 없습니다!")

    key = get_key()

    # 백업 파일 읽기 및 복호화
    print(f"백업 파일 읽기: {args.input}")
    with open(args.input, 'r') as f:
        encrypted = json.load(f)
    print(f"  생성: {encrypted['metadata']['created_at']}")
    print(f"  테이블: {encrypted['metadata']['table_count']}개")
    print(f"  행: {encrypted['metadata']['total_rows']}행")

    plaintext = decrypt_backup(encrypted, key)
    backup = json.loads(plaintext.decode('utf-8'))
    print("✅ 복호화 성공")

    # 무결성 확인
    for table, expected in backup['integrity'].items():
        actual = backup['tables'][table]['row_count']
        if actual != expected:
            raise Exception(f"무결성 오류: {table} ({actual} != {expected})")
    print("✅ 무결성 확인")

    # 복원
    print(f"\n복원 시작: {args.db_id}")
    total_restored = 0

    # 외래키 비활성화 (스키마 의존성 문제 방지)
    try:
        q(args.db_id, "PRAGMA foreign_keys=OFF")
    except:
        pass

    for table_name, table_data in backup['tables'].items():
        schema = table_data['schema']
        columns = table_data['columns']
        rows = table_data['rows']

        # 스키마 생성 (IF NOT EXISTS 추가)
        if 'IF NOT EXISTS' not in schema.upper():
            schema = schema.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS', 1)
        try:
            q(args.db_id, schema)
        except Exception as e:
            if 'already exists' not in str(e).lower():
                print(f"  ⚠️ {table_name} 스키마: {e}")
                continue

        # 데이터 삽입 (일반 INSERT - 중복 시 오류)
        # INSERT OR REPLACE는 ON DELETE CASCADE로 자식 데이터 삭제 위험이 있어 사용 금지
        if rows:
            # 배치 삽입 (100행씩)
            for i in range(0, len(rows), 100):
                batch = rows[i:i+100]
                values_list = []
                for row in batch:
                    vals = [escape_value(row.get(col)) for col in columns]
                    values_list.append(f"({', '.join(vals)})")
                cols_str = ', '.join(columns)
                sql = f"INSERT INTO {table_name} ({cols_str}) VALUES {', '.join(values_list)}"
                try:
                    q(args.db_id, sql)
                except Exception as e:
                    if 'UNIQUE constraint' in str(e) or 'PRIMARY KEY' in str(e):
                        raise Exception(
                            f"복원 실패: {table_name}에 중복 데이터 존재. "
                            f"빈 DB가 아닌 경우 복원을 중단해야 합니다. 오류: {e}"
                        )
                    raise
            total_restored += len(rows)
            print(f"  ✅ {table_name}: {len(rows)}행 복원")

    print(f"\n✅ 복원 완료: 총 {total_restored}행")

    # 검증: 행 수 비교
    print("\n=== 검증 ===")
    for table_name in backup['tables']:
        expected = backup['integrity'][table_name]
        result = q(args.db_id, f"SELECT COUNT(*) as c FROM {table_name}")
        actual = result[0]['c']
        status = "✅" if actual == expected else "❌"
        print(f"  {status} {table_name}: {actual}/{expected}")

if __name__ == '__main__':
    main()
