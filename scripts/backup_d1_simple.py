#!/usr/bin/env python3
"""
MyHub D1 백업 (Phase 4D-1) - 화이트리스트 방식

FTS5 가상 테이블 제외, 알려진 테이블만 백업
"""

import sys
import json
import time
import argparse
from datetime import datetime, timezone

sys.path.insert(0, '/home/hatch/workspace/skills/cloudflare/bin')
from cf_api import api_call

ACCT = '59e749ed2e9cdb8b0bf70d47227968a1'

# 백업 대상 테이블 (화이트리스트) - 2026-10-11 운영 스키마 기준
# FTS 테이블(memos_fts, ai_memory_fts 및 섀도우)은 제외
BACKUP_TABLES = [
    # 사용자 데이터
    'memos',
    'memo_tags',
    'schedules',
    'todos',
    'files',
    'reminders',
    # AI 대화 (ai_chats, ai_conversations 포함 - 2026-10-11 추가)
    # ai_chats는 ai_conversations를 외래키로 참조하므로 함께 백업 필수
    'ai_conversations',
    'ai_chats',
    'ai_feedback',
    'ai_usage',
    'ai_memo_audit',
    # 장기 기억
    'ai_memory',
    'ai_memory_v2',
    # 설정
    'ai_settings',
    # 민감 데이터 (정책 검토 필요)
    # 'otp_codes' - 일회용 인증코드, 장기 백업 제외 권장
    # 'push_subscriptions' - endpoint·키 포함, 별도 검토 필요
]

# 민감 데이터 정책
SENSITIVE_TABLES = {
    'otp_codes': '제외 - 일회용 인증코드는 백업 불필요, 복원 후 재발급',
    'push_subscriptions': '포함하되 암호화 필수 - endpoint와 키가 민감함',
}

def q(db_id, sql, params=None):
    time.sleep(0.3)  # Rate limit 방지
    r = api_call('POST', f'/accounts/{ACCT}/d1/database/{db_id}/query',
                 {'sql': sql, 'params': params or []})
    if not r.get('success'):
        # 테이블이 없으면 빈 결과 반환
        if 'no such table' in str(r.get('errors')).lower():
            return []
        raise Exception(f"Query failed: {r.get('errors')}")
    return r['result'][0]['results']

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--db-id', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    print(f"백업 시작: {now.isoformat()}")

    backup = {
        'version': 1,
        'created_at': now.isoformat(),
        'db_id': args.db_id,
        'tables': {},
    }

    total_rows = 0
    for table in BACKUP_TABLES:
        try:
            # 스키마
            schema_r = q(args.db_id, f"SELECT sql FROM sqlite_master WHERE type='table' AND name='{table}'")
            if not schema_r:
                print(f"  ⏭️ {table}: 없음 (건너뜀)")
                continue

            # 데이터
            rows = q(args.db_id, f"SELECT * FROM {table}")
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

    # 무결성
    backup['integrity'] = {t: backup['tables'][t]['row_count'] for t in backup['tables']}

    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(backup, f, ensure_ascii=False)

    import os
    size = os.path.getsize(args.output)
    print(f"\n✅ 백업 완료: {args.output} ({size:,} bytes, {total_rows}행)")

if __name__ == '__main__':
    main()
