#!/usr/bin/env python3
"""
MyHub 암호화 백업 격리 복원 + 무결성 검증 (P0, 2026-10-29)

암호화 백업 파일(format_version 1)을 복호화해 격리된 로컬 SQLite DB
(miniflare 로컬 D1 파일 또는 일반 sqlite 파일)에 복원하고 검증한다.
운영 DB에는 절대 쓰지 않는다 — 대상은 로컬 파일뿐이다.

검증 항목:
  1. AES-GCM 복호화 성공 (인증 태그 = 파일 무결성)
  2. 테이블별 행 수 일치 (백업 integrity vs 복원 DB)
  3. 테이블별 전 행 정규화 해시 일치 (백업 vs 복원 — 바이트 충실도)
  4. 암호화 메모: 잠긴 메모의 ciphertext (id, text) 해시 집합 일치
     (평문은 열지 않는다. 운영 Worker가 같은 MEMO_ENCRYPTION_KEY를
     보유하므로 ciphertext 바이트 동일 = 복호화 가능의 구성적 증거)
  5. PRAGMA foreign_key_check 위반 0 + 선언되지 않은 논리 참조 고아 검사
  6. FTS 인덱스: 트리거로 재구축된 memos_fts 행 수와 MATCH 검색 동작

사용법:
  MYHUB_BACKUP_PASSWORD='...' python3 scripts/restore_local.py \
      --input <백업파일> --db <로컬DB파일> [--existing-db]
  --existing-db: 마이그레이션을 이미 적용한 DB 파일(miniflare 로컬 D1 등)에
                 스키마 생성을 건너뛰고 데이터만 넣는다.
"""

import argparse
import base64
import hashlib
import json
import os
import sqlite3
import sys

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes
    from cryptography.exceptions import InvalidTag
except ImportError:
    print('오류: cryptography 패키지 필요 (pip install --user cryptography)')
    sys.exit(1)


def decrypt_backup(data: dict, password: str) -> dict:
    salt = base64.b64decode(data['salt'])
    iv = base64.b64decode(data['iv'])
    ciphertext = base64.b64decode(data['ciphertext'])
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt,
                     iterations=data['iterations'])
    key = kdf.derive(password.encode())
    plaintext = AESGCM(key).decrypt(iv, ciphertext, None)  # InvalidTag면 예외
    return json.loads(plaintext.decode('utf-8'))


def canonical_hash(rows: list) -> str:
    """행 집합의 순서 무관 정규화 해시. 값은 str()로 정규화해
    D1 JSON과 sqlite 타입 표기 차이에 흔들리지 않게 한다."""
    norm = []
    for row in rows:
        norm.append(tuple(sorted((k, '' if v is None else str(v)) for k, v in row.items())))
    norm.sort(key=repr)
    return hashlib.sha256(repr(norm).encode()).hexdigest()


def apply_migrations(conn: sqlite3.Connection, migrations_dir: str) -> list:
    errors = []
    for name in sorted(os.listdir(migrations_dir)):
        if not name.endswith('.sql'):
            continue
        sql = open(os.path.join(migrations_dir, name)).read()
        try:
            conn.executescript(sql)
            conn.commit()
        except Exception as e:
            conn.rollback()
            errors.append({'file': name, 'error': str(e)[:200]})
    return errors


# 선언 FK가 없어도 끊기면 안 되는 논리 참조 (컬럼이 있을 때만 검사)
LOGICAL_REFS = [
    ('memo_tags', 'memo_id', 'memos', 'id'),
    ('files', 'memo_id', 'memos', 'id'),
    ('ai_chats', 'conversation_id', 'ai_conversations', 'id'),
    ('memo_conversation_context', 'memo_id', 'memos', 'id'),
    ('artifact_files', 'artifact_id', 'artifacts', 'id'),
    ('artifact_versions', 'artifact_id', 'artifacts', 'id'),
    ('artifact_chats', 'artifact_id', 'artifacts', 'id'),
    ('memory_relations', 'source_entity_id', 'memory_entities', 'id'),
    ('memory_relations', 'target_entity_id', 'memory_entities', 'id'),
    ('memory_fact_entities', 'entity_id', 'memory_entities', 'id'),
]


def main():
    ap = argparse.ArgumentParser(description='MyHub 백업 격리 복원 + 검증')
    ap.add_argument('--input', required=True)
    ap.add_argument('--db', required=True, help='로컬 DB 파일 경로 (운영 DB 금지)')
    ap.add_argument('--existing-db', action='store_true')
    ap.add_argument('--migrations', default=None)
    ap.add_argument('--report', default=None, help='검증 리포트 JSON 출력 경로')
    args = ap.parse_args()

    if '0dd871c5' in args.db:
        raise SystemExit('운영 DB 식별자가 포함된 경로는 거부한다')

    password = os.environ.get('MYHUB_BACKUP_PASSWORD')
    if not password:
        raise SystemExit('MYHUB_BACKUP_PASSWORD 환경변수 필요')

    report = {'input': args.input, 'db': args.db, 'checks': {}}

    with open(args.input) as f:
        encrypted = json.load(f)
    report['backup_created_at'] = encrypted.get('created_at')
    try:
        backup = decrypt_backup(encrypted, password)
        report['checks']['decrypt_aes_gcm_auth'] = 'PASS'
    except InvalidTag:
        report['checks']['decrypt_aes_gcm_auth'] = 'FAIL (InvalidTag)'
        print(json.dumps(report, ensure_ascii=False, indent=2))
        sys.exit(1)

    tables = backup['tables']
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    migrations_dir = args.migrations or os.path.join(repo_root, 'migrations')

    if not args.existing_db and os.path.exists(args.db):
        os.remove(args.db)
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row

    if not args.existing_db:
        errors = apply_migrations(conn, migrations_dir)
        report['migration_errors'] = errors
        report['checks']['migrations_applied'] = 'PASS' if not errors else f'FAIL {len(errors)}건'
    else:
        report['checks']['migrations_applied'] = 'SKIP (existing-db)'

    # 복원 (파라미터 바인딩만 사용)
    # 스키마 드리프트 대응: 운영 스키마와 마이그레이션 스키마가 다른 컬럼이
    # 있다 (실증: ai_chats.prompt_version — 운영은 nullable, 마이그레이션은
    # NOT NULL DEFAULT 'legacy'). 백업 행의 NULL을 NOT NULL+DEFAULT 컬럼에
    # 넣으면 실패하므로, 그 경우 컬럼을 생략해 대상 기본값을 적용하고
    # 치환 사실을 리포트에 전부 기록한다 (조용히 넘기지 않음).
    conn.execute('PRAGMA foreign_keys=OFF')
    # 전체 복원 의미론: 백업이 정본이다. 마이그레이션 시드 행(예: 0010의
    # 기본 대화방 'AI 비서방')이 빈 DB에 이미 있으면 행 수가 어긋나므로,
    # 백업에 포함된 테이블은 넣기 전에 비운다. 대상은 격리 로컬 DB뿐이다.
    for table in tables:
        conn.execute(f'DELETE FROM "{table}"')
    conn.commit()
    drift_substitutions = {}
    drift_columns = {}
    for table, tdata in tables.items():
        rows = tdata['rows']
        if not rows:
            continue
        target = {r[1]: {'notnull': r[3], 'dflt': r[4]}
                  for r in conn.execute(f'PRAGMA table_info("{table}")')}
        for row in rows:
            cols, vals = [], []
            for c, v in row.items():
                if c not in target:
                    drift_columns.setdefault(table, []).append(c)
                    continue
                if v is None and target[c]['notnull'] and target[c]['dflt'] is not None:
                    key = f'{table}.{c}'
                    drift_substitutions[key] = drift_substitutions.get(key, 0) + 1
                    continue  # 컬럼 생략 → 대상 스키마 기본값 적용
                cols.append(c)
                vals.append(json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v)
            ph = ', '.join(['?'] * len(cols))
            sql = f'INSERT INTO "{table}" ({", ".join(chr(34)+c+chr(34) for c in cols)}) VALUES ({ph})'
            conn.execute(sql, vals)
    conn.commit()
    report['drift_substitutions_null_to_default'] = drift_substitutions
    report['drift_columns_missing_in_target'] = {k: sorted(set(v)) for k, v in drift_columns.items()}

    # 검증 2·3: 행 수 + 전 행 해시
    # 해시는 드리프트 치환을 백업 행에도 동일 적용한 뒤 비교한다
    # (치환 자체는 drift_substitutions로 이미 투명하게 기록됨).
    def parse_default(dflt):
        if dflt is None:
            return None
        s = str(dflt).strip()
        if len(s) >= 2 and s[0] == "'" and s[-1] == "'":
            return s[1:-1].replace("''", "'")
        try:
            return int(s)
        except ValueError:
            try:
                return float(s)
            except ValueError:
                return s

    sub_cols = {}
    for key in drift_substitutions:
        t, c = key.rsplit('.', 1)
        sub_cols.setdefault(t, {})[c] = parse_default(
            {r[1]: r[4] for r in conn.execute(f'PRAGMA table_info("{t}")')}[c])

    def normalized(table, rows):
        subs = sub_cols.get(table)
        if not subs:
            return rows
        out = []
        for r in rows:
            r2 = dict(r)
            for c, dflt in subs.items():
                if r2.get(c) is None:
                    r2[c] = dflt
            out.append(r2)
        return out

    table_results = {}
    all_counts_ok = True
    all_hash_ok = True
    for table, tdata in tables.items():
        cur = conn.execute(f'SELECT * FROM "{table}"')
        restored = [dict(r) for r in cur.fetchall()]
        count_ok = len(restored) == tdata['row_count'] == len(tdata['rows'])
        hash_ok = canonical_hash(restored) == canonical_hash(normalized(table, tdata['rows']))
        all_counts_ok &= count_ok
        all_hash_ok &= hash_ok
        table_results[table] = {
            'backup_rows': tdata['row_count'],
            'restored_rows': len(restored),
            'count_match': count_ok,
            'row_hash_match': hash_ok,
        }
    report['tables'] = table_results
    report['checks']['row_counts_match'] = 'PASS' if all_counts_ok else 'FAIL'
    report['checks']['row_hashes_match'] = 'PASS' if all_hash_ok else 'FAIL'

    # 검증 4: 잠긴 메모 ciphertext 동일성 (평문을 열지 않음)
    def locked_digest(rows):
        sel = [(r['id'], r['text']) for r in rows
               if r.get('is_locked') == 1 or (isinstance(r.get('text'), str) and r['text'].startswith('ENC:'))]
        return hashlib.sha256(repr(sorted(sel, key=repr)).encode()).hexdigest(), len(sel)
    prod_digest, locked_n = locked_digest(tables['memos']['rows'])
    cur = conn.execute('SELECT * FROM memos')
    rest_digest, rest_locked_n = locked_digest([dict(r) for r in cur.fetchall()])
    report['locked_memos'] = {'count_backup': locked_n, 'count_restored': rest_locked_n,
                              'ciphertext_digest_match': prod_digest == rest_digest}
    report['checks']['locked_memo_ciphertext_identical'] = (
        'PASS' if prod_digest == rest_digest and locked_n == rest_locked_n else 'FAIL')

    # 검증 5: FK 무결성
    fk_violations = conn.execute('PRAGMA foreign_key_check').fetchall()
    report['fk_check_violations'] = len(fk_violations)
    orphans = {}
    existing_tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    for child, col, parent, pcol in LOGICAL_REFS:
        if child not in existing_tables or parent not in existing_tables:
            continue
        child_cols = {r[1] for r in conn.execute(f'PRAGMA table_info("{child}")')}
        if col not in child_cols:
            continue
        n = conn.execute(
            f'SELECT COUNT(*) FROM "{child}" WHERE "{col}" IS NOT NULL '
            f'AND "{col}" NOT IN (SELECT "{pcol}" FROM "{parent}")').fetchone()[0]
        if n:
            orphans[f'{child}.{col}'] = n
    report['logical_ref_orphans'] = orphans
    report['checks']['referential_integrity'] = (
        'PASS' if len(fk_violations) == 0 and not orphans else 'FAIL')

    # 검증 6: FTS 재구축 (트리거 경유) + 검색 동작
    try:
        fts_n = conn.execute('SELECT COUNT(*) FROM memos_fts').fetchone()[0]
        unlocked_n = conn.execute(
            'SELECT COUNT(*) FROM memos WHERE is_locked = 0 AND sensitivity < 2').fetchone()[0]
        sample = conn.execute('SELECT text FROM memos WHERE is_locked = 0 LIMIT 1').fetchone()
        match_ok = None
        if sample and sample[0]:
            word = sample[0].split()[0][:10] if sample[0].split() else ''
            if word:
                hits = conn.execute(
                    'SELECT COUNT(*) FROM memos_fts WHERE memos_fts MATCH ?', (f'"{word}"',)).fetchone()[0]
                match_ok = hits >= 1
        report['fts'] = {'memos_fts_rows': fts_n, 'unlocked_memos': unlocked_n, 'match_smoke': match_ok}
        report['checks']['fts_rebuilt'] = 'PASS' if fts_n == unlocked_n and match_ok is not False else 'FAIL'
    except Exception as e:
        report['checks']['fts_rebuilt'] = f'FAIL ({str(e)[:120]})'

    conn.close()
    failed = [k for k, v in report['checks'].items() if str(v).startswith('FAIL')]
    report['verdict'] = 'PASS' if not failed else f'FAIL: {failed}'
    out = json.dumps(report, ensure_ascii=False, indent=2)
    print(out)
    if args.report:
        with open(args.report, 'w') as f:
            f.write(out)
    sys.exit(0 if not failed else 1)


if __name__ == '__main__':
    main()
