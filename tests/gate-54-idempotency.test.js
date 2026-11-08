/**
 * 관문 테스트 54: 멱등성 — 실제 SQLite 검증.
 *
 * 2026-10-27 전면 재작성: 이전 버전은 expect(true).toBe(true) 연극이었다.
 * 이제 실제 마이그레이션 파일(0035·0039)을 better-sqlite3 인메모리 DB에
 * 적용하고, routes.ts와 동일한 INSERT/SELECT 문으로 멱등성을 확인한다.
 * - 프론트: 'req-' + Date.now() + random 생성
 * - 백엔드: 기존 jobId 반환 (deduped: true) — routes.ts:673-677의 SELECT
 * - DB 안전망: uq_jobs_client_req 부분 유니크 인덱스가 경합 중복을 거부
 */
const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')

const MIG_DIR = path.join(__dirname, '..', 'migrations')

function freshDb() {
  const db = new Database(':memory:')
  // artifacts가 있어야 artifact_jobs의 REFERENCES가 prepare 시점에 해석된다
  db.exec(fs.readFileSync(path.join(MIG_DIR, '0032_artifacts.sql'), 'utf8'))
  db.exec(fs.readFileSync(path.join(MIG_DIR, '0035_artifact_jobs.sql'), 'utf8'))
  db.exec(fs.readFileSync(path.join(MIG_DIR, '0039_artifact_jobs_indexes.sql'), 'utf8'))
  return db
}

const OWNER = 'kimjn00003@naver.com'

function insertJob(db, clientRequestId) {
  return db
    .prepare(
      'INSERT INTO artifact_jobs (kind, artifact_id, prompt, base_html, status, owner_email, client_request_id, provider, model) ' +
        "VALUES ('create', NULL, 'test', NULL, 'pending', ?, ?, 'gemini', 'gemini-3.5-flash-lite')",
    )
    .run(OWNER, clientRequestId).lastInsertRowid
}

function findJob(db, clientRequestId) {
  return db
    .prepare('SELECT id, status FROM artifact_jobs WHERE owner_email = ? AND client_request_id = ?')
    .get(OWNER, clientRequestId)
}

describe('관문 54: 멱등성 (실제 SQLite)', () => {
  test('중복 요청 시 기존 job 반환 (SELECT 멱등성 체크)', () => {
    const db = freshDb()
    try {
      const id1 = insertJob(db, 'req-54-a')
      // routes.ts:673-677과 동일한 조회 — 두 번째 요청은 이 SELECT가 잡는다
      const found = findJob(db, 'req-54-a')
      expect(found.id).toBe(id1)
      expect(found.status).toBe('pending')
    } finally {
      db.close()
    }
  })

  test('같은 키 중복 INSERT는 유니크 인덱스가 거부한다 (경합 안전망)', () => {
    const db = freshDb()
    try {
      insertJob(db, 'req-54-b')
      expect(() => insertJob(db, 'req-54-b')).toThrow(/UNIQUE constraint failed/)
    } finally {
      db.close()
    }
  })

  test('client_request_id가 없으면 부분 인덱스라 중복 허용된다', () => {
    const db = freshDb()
    try {
      const id1 = insertJob(db, null)
      const id2 = insertJob(db, null)
      expect(id2).not.toBe(id1)
    } finally {
      db.close()
    }
  })

  test('다른 사용자의 같은 키는 충돌하지 않는다', () => {
    const db = freshDb()
    try {
      insertJob(db, 'req-54-c')
      const other = db
        .prepare(
          'INSERT INTO artifact_jobs (kind, prompt, status, owner_email, client_request_id) ' +
            "VALUES ('create', 'other', 'pending', 'other@myhub.local', 'req-54-c')",
        )
        .run().lastInsertRowid
      expect(other).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })
})
