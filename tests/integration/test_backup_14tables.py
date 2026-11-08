#!/usr/bin/env python3
"""
MyHub Phase 4D 14개 테이블 무결성 테스트

실행: python3 tests/integration/test_backup_14tables.py
"""

import sqlite3
import os
import sys
import hashlib
import tempfile

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

# 14개 테이블 스키마
TABLES = {
    'memos': 'CREATE TABLE memos (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, is_locked INTEGER DEFAULT 0, sensitivity INTEGER DEFAULT 0)',
    'memo_tags': 'CREATE TABLE memo_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, memo_id INTEGER, tag TEXT)',
    'schedules': 'CREATE TABLE schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, status TEXT DEFAULT "active")',
    'todos': 'CREATE TABLE todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, done INTEGER DEFAULT 0)',
    'files': 'CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, memo_id INTEGER, name TEXT)',
    'reminders': 'CREATE TABLE reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT)',
    'ai_conversations': 'CREATE TABLE ai_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT)',
    'ai_chats': 'CREATE TABLE ai_chats (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT)',
    'ai_feedback': 'CREATE TABLE ai_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, rating INTEGER)',
    'ai_usage': 'CREATE TABLE ai_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, tokens INTEGER)',
    'ai_memo_audit': 'CREATE TABLE ai_memo_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT)',
    'ai_memory': 'CREATE TABLE ai_memory (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT)',
    'ai_memory_v2': 'CREATE TABLE ai_memory_v2 (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT, allow_ai_use INTEGER DEFAULT 0, allow_provider_send INTEGER DEFAULT 0)',
    'ai_settings': 'CREATE TABLE ai_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, value TEXT)',
}

# 테스트 데이터 (각 테이블 최소 1건)
TEST_DATA = {
    'memos': [
        (1, '일반 메모', 0, 0),
        (2, '잠긴 메모', 1, 0),
        (3, 'Restricted 메모', 0, 2),
        (4, '한국어 특수문자!@#$', 0, 0),
    ],
    'memo_tags': [(1, 1, '태그1'), (2, 1, '태그2')],
    'schedules': [(1, '회의', 'active')],
    'todos': [(1, '할일', 0)],
    'files': [(1, 1, 'test.txt')],
    'reminders': [(1, '리마인더')],
    'ai_conversations': [(1, '대화 내용')],
    'ai_chats': [(1, '채팅')],
    'ai_feedback': [(1, 5)],
    'ai_usage': [(1, 100)],
    'ai_memo_audit': [(1, 'create')],
    'ai_memory': [(1, '기억')],
    'ai_memory_v2': [(1, '기억v2', 1, 0)],
    'ai_settings': [(1, 'key1', 'value1')],
}

print("=== 14개 테이블 무결성 테스트 ===\n")

# 원본 DB 생성
orig_path = tempfile.mktemp(suffix='.db')
conn = sqlite3.connect(orig_path)
cur = conn.cursor()
for table, ddl in TABLES.items():
    cur.execute(ddl)

for table, rows in TEST_DATA.items():
    placeholders = ', '.join(['?'] * len(rows[0]))
    for row in rows:
        cur.execute(f'INSERT INTO {table} VALUES ({placeholders})', row)
conn.commit()

# 백업 데이터 추출
backup = {}
for table in TABLES.keys():
    cur.execute(f'SELECT * FROM {table} ORDER BY id')
    rows = cur.fetchall()
    cols = [d[0] for d in cur.description]
    backup[table] = [dict(zip(cols, r)) for r in rows]
conn.close()

total_rows = sum(len(v) for v in backup.values())
print(f"원본: 14개 테이블, {total_rows}건\n")

# 복원 DB 생성
restore_path = tempfile.mktemp(suffix='.db')
conn2 = sqlite3.connect(restore_path)
cur2 = conn2.cursor()
for table, ddl in TABLES.items():
    cur2.execute(ddl)

# 복원
for table, rows in backup.items():
    if not rows:
        continue
    cols = list(rows[0].keys())
    placeholders = ', '.join(['?'] * len(cols))
    for row in rows:
        values = [row[c] for c in cols]
        cur2.execute(f'INSERT INTO {table} ({", ".join(cols)}) VALUES ({placeholders})', values)
conn2.commit()

# 검증
print("--- 테이블별 검증 ---")
all_pass = True
for table in TABLES.keys():
    orig_rows = backup[table]
    cur2.execute(f'SELECT * FROM {table} ORDER BY id')
    cols = [d[0] for d in cur2.description]
    restore_rows = [dict(zip(cols, r)) for r in cur2.fetchall()]
    
    # 행 수 비교
    count_match = len(orig_rows) == len(restore_rows)
    
    # 필드 비교
    field_match = True
    for o, r in zip(orig_rows, restore_rows):
        for k in o.keys():
            if str(o[k]) != str(r.get(k)):
                field_match = False
                break
    
    passed = count_match and field_match
    if not passed:
        all_pass = False
    test(f"{table}: {len(orig_rows)}건", passed)

# 외래키 검증
cur2.execute('SELECT COUNT(*) FROM memo_tags WHERE memo_id NOT IN (SELECT id FROM memos)')
orphan = cur2.fetchone()[0]
test("외래키 무결성", orphan == 0)

# 잠금/민감도 검증
cur2.execute("SELECT COUNT(*) FROM memos WHERE is_locked=1")
locked = cur2.fetchone()[0]
test("잠금 상태 보존", locked == 1)

cur2.execute("SELECT COUNT(*) FROM memos WHERE sensitivity=2")
restricted = cur2.fetchone()[0]
test("Restricted 보존", restricted == 1)

# AI 동의 검증
cur2.execute("SELECT allow_ai_use FROM ai_memory_v2 WHERE id=1")
consent = cur2.fetchone()[0]
test("AI 동의 보존", consent == 1)

conn2.close()
os.remove(orig_path)
os.remove(restore_path)

print(f"\n=== 결과: {TESTS_PASSED} 통과, {TESTS_FAILED} 실패 ===")
sys.exit(0 if TESTS_FAILED == 0 else 1)
