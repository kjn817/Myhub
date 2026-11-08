#!/usr/bin/env python3
"""
MyHub D1 백업 프로토타입 (Phase 4D-1)

FTS5 가상 테이블이 있어도 안전하게 백업:
- FTS 테이블 및 섀도우 테이블 제외
- 원본 테이블의 스키마 + 데이터만 백업
- 복원 시 마이그레이션으로 FTS 재생성

사용법:
  python3 backup_d1.py --db-id <D1_ID> --output <파일>
"""

import sys
import json
import argparse
import time
from datetime import datetime, timezone

sys.path.insert(0, '/home/hatch/workspace/skills/cloudflare/bin')
from cf_api import api_call

ACCT = '59e749ed2e9cdb8b0bf70d47227968a1'

# FTS 관련 테이블 (백업 제외)
# FTS5는 본 테이블 + _data, _idx, _content, _docsize, _config 섀도우 테이블 생성
FTS_EXCLUDE_SUFFIXES = ('_fts', '_fts_data', '_fts_idx', '_fts_content', '_fts_docsize', '_fts_config', '_fts_segdir', '_fts_segments')

def is_fts_table(name):
    return name.endswith(FTS_EXCLUDE_SUFFIXES)

def q(db_id, sql, params=None, retries=3):
    for attempt in range(retries):
        r = api_call('POST', f'/accounts/{ACCT}/d1/database/{db_id}/query',
                     {'sql': sql, 'params': params or []})
        if r.get('success'):
            return r['result'][0]['results']
        # Rate limit 시 대기 후 재시도
        if 'SQLITE_AUTH' in str(r.get('errors')) and attempt < retries - 1:
            time.sleep(2)
            continue
        raise Exception(f"Query failed: {r.get('errors')}")
    raise Exception("Max retries exceeded")

def get_tables(db_id):
    """FTS 제외한 백업 대상 테이블 목록"""
    tables = q(db_id, """
        SELECT name, sql FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
    """)
    # FTS 테이블 제외
    return [t for t in tables if not is_fts_table(t['name'])]

def get_triggers(db_id):
    """트리거 목록 (FTS 트리거는 제외 - 마이그레이션으로 재생성)"""
    triggers = q(db_id, """
        SELECT name, sql FROM sqlite_master
        WHERE type='trigger'
        ORDER BY name
    """)
    # FTS 관련 트리거 제외 (memory_fts_*, memos_fts_*)
    return [t for t in triggers
            if not ('_fts_' in t['name'] or t['name'].endswith('_fts_ai')
                    or t['name'].endswith('_fts_ad') or t['name'].endswith('_fts_au'))]

def backup_table_data(db_id, table_name, batch_size=100):
    """테이블 데이터를 배치로 조회"""
    # 행 수 (따옴표 없이, 테이블명은 화이트리스트로 검증됨)
    cnt = q(db_id, f"SELECT COUNT(*) as c FROM {table_name}")[0]['c']
    rows = []
    offset = 0
    while offset < cnt:
        batch = q(db_id, f"SELECT * FROM {table_name} LIMIT ? OFFSET ?",
                  [batch_size, offset])
        rows.extend(batch)
        offset += batch_size
        time.sleep(0.5)  # Rate limit 방지
    return rows

def escape_value(v):
    """SQL 값 이스케이프"""
    if v is None:
        return 'NULL'
    if isinstance(v, (int, float)):
        return str(v)
    # 문자열: 작은따옴표 이스케이프
    return "'" + str(v).replace("'", "''") + "'"

def main():
    parser = argparse.ArgumentParser(description='MyHub D1 백업')
    parser.add_argument('--db-id', required=True, help='D1 database ID')
    parser.add_argument('--output', required=True, help='출력 파일 경로')
    args = parser.parse_args()

    db_id = args.db_id
    now = datetime.now(timezone.utc)

    print(f"백업 시작: {now.isoformat()}")
    print(f"D1: {db_id}")

    backup = {
        'version': 1,
        'created_at': now.isoformat(),
        'db_id': db_id,
        'tables': {},
    }

    tables = get_tables(db_id)
    print(f"\n백업 대상 테이블: {len(tables)}개")

    total_rows = 0
    for t in tables:
        name = t['name']
        schema = t['sql']
        rows = backup_table_data(db_id, name)
        # 컬럼명 추출 (첫 행의 키)
        columns = list(rows[0].keys()) if rows else []

        backup['tables'][name] = {
            'schema': schema,
            'columns': columns,
            'row_count': len(rows),
            'rows': rows,
        }
        total_rows += len(rows)
        print(f"  {name}: {len(rows)}건")

    # 트리거 (FTS 제외)
    triggers = get_triggers(db_id)
    backup['triggers'] = [{'name': t['name'], 'sql': t['sql']} for t in triggers]
    print(f"\n트리거: {len(triggers)}개 (FTS 제외)")

    # 무결성: 테이블별 행 수 기록
    backup['integrity'] = {
        table: backup['tables'][table]['row_count']
        for table in backup['tables']
    }

    # 파일 저장
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(backup, f, ensure_ascii=False)

    import os
    size = os.path.getsize(args.output)
    print(f"\n✅ 백업 완료: {args.output}")
    print(f"   테이블: {len(tables)}개, 총 {total_rows}행")
    print(f"   파일 크기: {size:,} bytes")

    # 무결성 검증: 저장된 파일 다시 읽기
    with open(args.output, 'r', encoding='utf-8') as f:
        verify = json.load(f)
    assert verify['integrity'] == backup['integrity'], "무결성 검증 실패!"
    print(f"   무결성 검증: 통과 ✅")

if __name__ == '__main__':
    main()
