#!/usr/bin/env python3
"""
MyHub Phase 4D 백업·복원 통합 테스트

실행: python3 tests/integration/test_backup_restore.py
종료 코드: 0=성공, 1=실패
"""

import json
import base64
import sqlite3
import os
import sys
import tempfile

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes
    from cryptography.exceptions import InvalidTag
except ImportError:
    print("오류: cryptography 패키지 필요")
    sys.exit(1)

TESTS_PASSED = 0
TESTS_FAILED = 0

def test(name, condition):
    global TESTS_PASSED, TESTS_FAILED
    if condition:
        print(f"✅ {name}")
        TESTS_PASSED += 1
    else:
        print(f"❌ {name}")
        TESTS_FAILED += 1

def decrypt_backup(backup_data, password):
    """백업 복호화"""
    salt = base64.b64decode(backup_data['salt'])
    iv = base64.b64decode(backup_data['iv'])
    ciphertext = base64.b64decode(backup_data['ciphertext'])
    
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=backup_data['iterations'],
    )
    key = kdf.derive(password.encode())
    
    aesgcm = AESGCM(key)
    plaintext = aesgcm.decrypt(iv, ciphertext, None)
    return json.loads(plaintext.decode('utf-8'))

def create_test_backup():
    """테스트용 암호화 백업 생성 (Worker 형식 시뮬레이션)"""
    import os
    
    # 테스트 데이터
    plaintext_data = {
        'version': 4,
        'tables': {
            'memos': {
                'row_count': 3,
                'rows': [
                    {'id': 1, 'text': '일반 메모', 'is_locked': 0, 'sensitivity': 0},
                    {'id': 2, 'text': '잠긴 메모', 'is_locked': 1, 'sensitivity': 0},
                    {'id': 3, 'text': 'Restricted 메모', 'is_locked': 0, 'sensitivity': 2},
                ]
            }
        },
        'integrity': {'table_count': 1, 'total_rows': 3}
    }
    
    password = 'test-password-123'
    salt = os.urandom(16)
    iv = os.urandom(12)
    
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=100000,
    )
    key = kdf.derive(password.encode())
    
    aesgcm = AESGCM(key)
    plaintext = json.dumps(plaintext_data).encode()
    ciphertext = aesgcm.encrypt(iv, plaintext, None)
    
    return {
        'format_version': 1,
        'algorithm': 'AES-256-GCM',
        'kdf': 'PBKDF2-SHA256',
        'iterations': 100000,
        'salt': base64.b64encode(salt).decode(),
        'iv': base64.b64encode(iv).decode(),
        'ciphertext': base64.b64encode(ciphertext).decode(),
    }, password

print("=== Phase 4D 백업·복원 통합 테스트 ===\n")

# 테스트 1: 올바른 암호로 복호화
print("--- 복호화 테스트 ---")
backup, password = create_test_backup()
try:
    data = decrypt_backup(backup, password)
    test("올바른 암호 복호화", data['tables']['memos']['row_count'] == 3)
except:
    test("올바른 암호 복호화", False)

# 테스트 2: 잘못된 암호 거부
try:
    decrypt_backup(backup, 'wrong-password')
    test("잘못된 암호 거부", False)
except InvalidTag:
    test("잘못된 암호 거부", True)
except:
    test("잘못된 암호 거부", False)

# 테스트 3: 암호문 변조 탐지
tampered = dict(backup)
ct = bytearray(base64.b64decode(tampered['ciphertext']))
ct[0] ^= 0x01
tampered['ciphertext'] = base64.b64encode(bytes(ct)).decode()
try:
    decrypt_backup(tampered, password)
    test("암호문 변조 탐지", False)
except InvalidTag:
    test("암호문 변조 탐지", True)
except:
    test("암호문 변조 탐지", False)

# 테스트 4: FTS5 재구성
print("\n--- FTS5 테스트 ---")
db_path = tempfile.mktemp(suffix='.db')
conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.execute('CREATE TABLE memos (id INTEGER PRIMARY KEY, text TEXT)')
cur.execute("CREATE VIRTUAL TABLE memos_fts USING fts5(text, content='memos', content_rowid='id')")
cur.execute("INSERT INTO memos (text) VALUES ('테스트 메모')")
conn.commit()

# rebuild 테스트
try:
    cur.execute("INSERT INTO memos_fts(memos_fts) VALUES('rebuild')")
    conn.commit()
    test("FTS5 rebuild", True)
except:
    test("FTS5 rebuild", False)

# integrity-check 테스트
try:
    cur.execute("INSERT INTO memos_fts(memos_fts, rank) VALUES('integrity-check', 1)")
    conn.commit()
    test("FTS5 integrity-check", True)
except:
    test("FTS5 integrity-check", False)

conn.close()
os.remove(db_path)

# 테스트 5: 복원 실패 시 데이터 보존
print("\n--- 안전성 테스트 ---")
db_path = tempfile.mktemp(suffix='.db')
conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.execute('CREATE TABLE memos (id INTEGER PRIMARY KEY, text TEXT)')
cur.execute("INSERT INTO memos VALUES (1, '기존 데이터')")
conn.commit()

# 중복 ID 삽입 시도 (실패해야 함)
try:
    cur.execute("INSERT INTO memos VALUES (1, '중복')")
    conn.commit()
    test("중복 ID 거부", False)
except sqlite3.IntegrityError:
    conn.rollback()
    cur.execute("SELECT COUNT(*) FROM memos")
    count = cur.fetchone()[0]
    test("중복 ID 거부 및 롤백", count == 1)

conn.close()
os.remove(db_path)

print(f"\n=== 결과: {TESTS_PASSED} 통과, {TESTS_FAILED} 실패 ===")
sys.exit(0 if TESTS_FAILED == 0 else 1)
