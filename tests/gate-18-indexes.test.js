/**
 * 관문 테스트 18: D1 인덱스 커버리지 — 실제 마이그레이션 파일 검증.
 *
 * 2026-10-27 전면 재작성: 이전 버전은 인덱스 이름을 하드코딩한 배열끼리
 * 비교하는 연극이었다. 실제 DB도, 마이그레이션 파일도 읽지 않아서 0039
 * 결함(없는 컬럼에 인덱스 생성)을 전혀 잡지 못했다. 이제 마이그레이션
 * SQL 파일을 직접 파싱해, 인덱스가 참조하는 컬럼이 그 시점까지 정의돼
 * 있는지를 확인한다. 옛 0039로는 이 테스트가 실패한다 (카나리아 확인됨).
 *
 * 기대: 자주 조회되는 컬럼에 인덱스가 있어야 함.
 * - artifact_jobs(owner_email, client_request_id): 멱등성 체크 (매 job 생성 시)
 * - artifact_jobs(artifact_id): 프로젝트별 job 조회, 삭제 시
 */
const fs = require('fs')
const path = require('path')

const MIG_DIR = path.join(__dirname, '..', 'migrations')

function migrationFilesUpTo(target) {
  return fs
    .readdirSync(MIG_DIR)
    .filter((f) => f.endsWith('.sql') && f <= target)
    .sort()
}

function stripLineComments(sql) {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--')
      return idx >= 0 ? line.slice(0, idx) : line
    })
    .join('\n')
}

/** 0039까지의 마이그레이션에서 정의된 artifact_jobs 컬럼을 모은다. */
function definedColumns() {
  const cols = new Set()
  for (const f of migrationFilesUpTo('0039_artifact_jobs_indexes.sql')) {
    const sql = stripLineComments(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'))
    // CREATE TABLE artifact_jobs ( ... ) 안의 컬럼 정의
    const create = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?artifact_jobs\s*\(([\s\S]*?)\)\s*;/i)
    if (create) {
      for (const line of create[1].split('\n')) {
        const m = line.trim().match(/^([a-z_][a-z0-9_]*)\s+/i)
        if (m && !['primary', 'foreign', 'unique', 'check', 'constraint'].includes(m[1].toLowerCase())) {
          cols.add(m[1])
        }
      }
    }
    // ALTER TABLE artifact_jobs ADD COLUMN <name>
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+artifact_jobs\s+ADD\s+COLUMN\s+([a-z_][a-z0-9_]*)/gi)) {
      cols.add(m[1])
    }
  }
  return cols
}

/** 0039의 CREATE INDEX 문이 참조하는 컬럼을 { 인덱스명: 컬럼[] }로 모은다. */
function indexedColumns() {
  const sql = stripLineComments(
    fs.readFileSync(path.join(MIG_DIR, '0039_artifact_jobs_indexes.sql'), 'utf8'),
  )
  const out = {}
  for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+ON\s+artifact_jobs\s*\(([^)]+)\)/gi)) {
    out[m[1]] = m[2].split(',').map((c) => c.trim())
  }
  return out
}

describe('관문 18: D1 인덱스 (마이그레이션 파일 실검증)', () => {
  test('0039의 인덱스가 참조하는 컬럼이 그 시점까지 정의돼 있다', () => {
    const defined = definedColumns()
    const indexed = indexedColumns()
    expect(Object.keys(indexed).length).toBeGreaterThan(0)
    for (const [name, cols] of Object.entries(indexed)) {
      for (const col of cols) {
        expect(defined.has(col)).toBe(true)
      }
    }
  })

  test('멱등성 인덱스 + 부분 유니크 인덱스가 0039에 있다', () => {
    const indexed = indexedColumns()
    expect(indexed['idx_artifact_jobs_idempotency']).toEqual(['owner_email', 'client_request_id'])
    expect(indexed['uq_jobs_client_req']).toEqual(['owner_email', 'client_request_id'])
    expect(indexed['idx_artifact_jobs_artifact']).toEqual(['artifact_id'])
  })

  test('정의된 컬럼에 4개 멱등성·모델 컬럼이 포함된다', () => {
    const defined = definedColumns()
    for (const c of ['owner_email', 'client_request_id', 'provider', 'model']) {
      expect(defined.has(c)).toBe(true)
    }
  })
})
