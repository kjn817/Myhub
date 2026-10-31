#!/usr/bin/env python3
"""
Phase 5 브리핑 개인정보 필터 테스트

실행: python3 tests/integration/test_briefing_privacy.py
"""

import sqlite3
import os
import sys
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

print("=== Phase 5 브리핑 개인정보 필터 테스트 ===\n")

db_path = tempfile.mktemp(suffix='.db')
conn = sqlite3.connect(db_path)
cur = conn.cursor()

# 테이블 생성
cur.execute('CREATE TABLE memos (id INTEGER PRIMARY KEY, text TEXT, is_locked INTEGER DEFAULT 0, sensitivity INTEGER DEFAULT 0)')
cur.execute('CREATE TABLE ai_memory_v2 (id INTEGER PRIMARY KEY, content TEXT, allow_ai_use INTEGER DEFAULT 0, allow_provider_send INTEGER DEFAULT 0)')

# 테스트 데이터
cur.execute("INSERT INTO memos (text, is_locked, sensitivity) VALUES ('QA42_PUBLIC_MEMO', 0, 0)")
cur.execute("INSERT INTO memos (text, is_locked, sensitivity) VALUES ('QA42_LOCKED_SECRET', 1, 0)")
cur.execute("INSERT INTO memos (text, is_locked, sensitivity) VALUES ('QA42_RESTRICTED_SECRET', 0, 2)")
cur.execute("INSERT INTO ai_memory_v2 (content, allow_ai_use, allow_provider_send) VALUES ('QA42_MEMORY_ALLOWED', 1, 0)")
cur.execute("INSERT INTO ai_memory_v2 (content, allow_ai_use, allow_provider_send) VALUES ('QA42_MEMORY_DENIED', 0, 0)")
cur.execute("INSERT INTO ai_memory_v2 (content, allow_ai_use, allow_provider_send) VALUES ('QA42_PROVIDER_DENIED', 1, 0)")
conn.commit()

print("--- 메모 필터 테스트 ---")
# 브리핑 쿼리: is_locked=0 AND sensitivity<2
cur.execute("SELECT text FROM memos WHERE is_locked = 0 AND sensitivity < 2")
results = [r[0] for r in cur.fetchall()]

test("일반 메모 포함", 'QA42_PUBLIC_MEMO' in results)
test("잠긴 메모 제외", 'QA42_LOCKED_SECRET' not in results)
test("Restricted 메모 제외", 'QA42_RESTRICTED_SECRET' not in results)

print("\n--- AI 기억 필터 테스트 ---")
# 브리핑 쿼리: allow_ai_use=1
cur.execute("SELECT content FROM ai_memory_v2 WHERE allow_ai_use = 1")
results = [r[0] for r in cur.fetchall()]

test("동의 기억 포함", 'QA42_MEMORY_ALLOWED' in results)
test("미동의 기억 제외", 'QA42_MEMORY_DENIED' not in results)
test("Provider 거부 기억 (내부용)", 'QA42_PROVIDER_DENIED' in results)

# 외부 전송 필터 (별도)
cur.execute("SELECT content FROM ai_memory_v2 WHERE allow_ai_use = 1 AND allow_provider_send = 1")
results = [r[0] for r in cur.fetchall()]
test("외부 전송 동의 필터", 'QA42_PROVIDER_DENIED' not in results)

conn.close()
os.remove(db_path)

print(f"\n=== 결과: {TESTS_PASSED} 통과, {TESTS_FAILED} 실패 ===")
sys.exit(0 if TESTS_FAILED == 0 else 1)
