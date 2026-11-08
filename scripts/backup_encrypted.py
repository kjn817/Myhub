#!/usr/bin/env python3
"""
MyHub 암호화 백업 (Phase 4D-2)

AES-256-GCM으로 백업 파일 암호화
- 키는 환경변수 MYHUB_BACKUP_KEY (base64, 32바이트)
- 키가 없으면 오류 (평문 저장 금지)
"""

import sys
import os
import json
import base64
import argparse
from datetime import datetime, timezone

# 백업 스크립트 임포트
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from backup_d1_simple import BACKUP_TABLES, q, ACCT

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.exceptions import InvalidTag
except ImportError:
    print("오류: cryptography 패키지 필요 (pip install cryptography)")
    sys.exit(1)

def get_key():
    """환경변수에서 암호화 키 로드"""
    key_b64 = os.environ.get('MYHUB_BACKUP_KEY')
    if not key_b64:
        raise Exception(
            "MYHUB_BACKUP_KEY 환경변수가 필요합니다. "
            "32바이트 키를 base64로 인코딩하여 설정하세요. "
            "예: python3 -c \"import os,base64; print(base64.b64encode(os.urandom(32)).decode())\""
        )
    key = base64.b64decode(key_b64)
    if len(key) != 32:
        raise Exception(f"키는 32바이트여야 합니다 (현재 {len(key)}바이트)")
    return key

def encrypt_backup(plaintext: bytes, key: bytes) -> dict:
    """AES-256-GCM 암호화"""
    aesgcm = AESGCM(key)
    nonce = os.urandom(12)  # 96-bit nonce
    ciphertext = aesgcm.encrypt(nonce, plaintext, None)
    return {
        'algorithm': 'AES-256-GCM',
        'nonce': base64.b64encode(nonce).decode(),
        'ciphertext': base64.b64encode(ciphertext).decode(),
    }

def decrypt_backup(encrypted: dict, key: bytes) -> bytes:
    """AES-256-GCM 복호화"""
    if encrypted.get('algorithm') != 'AES-256-GCM':
        raise Exception(f"지원하지 않는 알고리즘: {encrypted.get('algorithm')}")
    aesgcm = AESGCM(key)
    nonce = base64.b64decode(encrypted['nonce'])
    ciphertext = base64.b64decode(encrypted['ciphertext'])
    try:
        return aesgcm.decrypt(nonce, ciphertext, None)
    except InvalidTag:
        raise Exception("복호화 실패: 키가 틀리거나 파일이 변조됨")

def create_backup(db_id: str) -> dict:
    """백업 데이터 생성 (평문, 메모리에만)"""
    now = datetime.now(timezone.utc)
    print(f"백업 시작: {now.isoformat()}")

    backup = {
        'version': 2,  # 암호화 백업 v2
        'created_at': now.isoformat(),
        'db_id': db_id,
        'tables': {},
    }

    total_rows = 0
    for table in BACKUP_TABLES:
        try:
            schema_r = q(db_id, f"SELECT sql FROM sqlite_master WHERE type='table' AND name='{table}'")
            if not schema_r:
                continue
            rows = q(db_id, f"SELECT * FROM {table}")
            columns = list(rows[0].keys()) if rows else []
            backup['tables'][table] = {
                'schema': schema_r[0]['sql'],
                'columns': columns,
                'row_count': len(rows),
                'rows': rows,
            }
            total_rows += len(rows)
            print(f"  ✅ {table}: {len(rows)}건")
        except Exception as e:
            print(f"  ❌ {table}: {e}")

    backup['integrity'] = {t: backup['tables'][t]['row_count'] for t in backup['tables']}
    print(f"총 {total_rows}행")
    return backup

def main():
    parser = argparse.ArgumentParser(description='MyHub 암호화 백업')
    parser.add_argument('--db-id', required=True)
    parser.add_argument('--output', required=True, help='암호화된 백업 파일 경로 (.enc.json)')
    parser.add_argument('--decrypt', action='store_true', help='복호화 모드')
    parser.add_argument('--input', help='복호화할 입력 파일')
    args = parser.parse_args()

    key = get_key()

    if args.decrypt:
        # 복호화
        if not args.input:
            raise Exception("--decrypt에는 --input 필요")
        with open(args.input, 'r') as f:
            encrypted = json.load(f)
        plaintext = decrypt_backup(encrypted, key)
        with open(args.output, 'w') as f:
            f.write(plaintext.decode('utf-8'))
        print(f"✅ 복호화 완료: {args.output}")
    else:
        # 암호화 백업
        backup = create_backup(args.db_id)
        plaintext = json.dumps(backup, ensure_ascii=False).encode('utf-8')
        encrypted = encrypt_backup(plaintext, key)
        encrypted['metadata'] = {
            'created_at': backup['created_at'],
            'db_id': backup['db_id'],
            'version': backup['version'],
            'table_count': len(backup['tables']),
            'total_rows': sum(backup['integrity'].values()),
        }
        with open(args.output, 'w') as f:
            json.dump(encrypted, f)
        size = os.path.getsize(args.output)
        print(f"\n✅ 암호화 백업 완료: {args.output} ({size:,} bytes)")

        # 검증: 다시 읽어서 복호화
        with open(args.output, 'r') as f:
            verify_enc = json.load(f)
        verify_plain = decrypt_backup(verify_enc, key)
        verify_backup = json.loads(verify_plain.decode('utf-8'))
        assert verify_backup['integrity'] == backup['integrity']
        print("   무결성 검증: 통과 ✅")

if __name__ == '__main__':
    main()
