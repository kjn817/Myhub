/**
 * 관문 테스트 36: 삭제 트랜잭션 — 실제 SQLite + 실제 라우트 검증.
 *
 * 2026-10-27 전면 재작성: 이전 버전은 하드코딩한 테이블 이름 배열의
 * 길이(7)를 세는 연극이었다. 이제 실제 마이그레이션 파일을 better-sqlite3
 * 인메모리 DB에 적용하고, esbuild로 컴파일한 실제 routes.ts를 호출한다.
 *
 * 검증하는 성질:
 * 1) 정상 삭제 시 7개 테이블(파일·버전·채팅·이벤트·provider_attempts·job·아티팩트)
 *    행이 모두 사라진다 (gate-34의 artifact_job_events 정리 성질도 여기서 cover).
 * 2) 원자성: batch 중간 문장이 실패하면(트리거로 강제 실패) 이미 실행된
 *    DELETE가 전부 롤백되어 어떤 행도 사라지지 않는다.
 * 3) 존재 확인: 없는 아티팩트는 404이고 DB가 그대로다.
 */
const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { Hono } = require('hono')

const ROUTES_TS = path.join(__dirname, '../src/modules/artifact/routes.ts')
const ROUTES_JS = '/tmp/artifact-routes-gate36-test.cjs'
try {
  execSync(`npx esbuild ${ROUTES_TS} --bundle --platform=node --format=cjs --outfile=${ROUTES_JS}`, { stdio: 'pipe' })
} catch (e) {
  console.error('TypeScript 컴파일 실패:', e.message)
}
const { artifactApp } = require(ROUTES_JS)

const MIGRATIONS = [
  '0032_artifacts.sql',
  '0033_artifact_status.sql',
  '0034_artifact_versions.sql',
  '0035_artifact_files.sql',
  '0035_artifact_jobs.sql',
  '0036_artifact_chats.sql',
  '0037_job_provider_attempts.sql',
  '0038_artifact_job_events.sql',
  '0039_artifact_jobs_indexes.sql', '0058_artifacts_owner_email.sql',
  '0040_artifact_jobs_pending_state.sql',
  '0041_artifact_jobs_base_snapshot.sql',
]


function createD1Adapter(db) {
  const prepare = (sql) => {
    const stmt = db.prepare(sql)
    return {
      _sql: sql,
      _params: [],
      bind(...p) { this._params = p; return this },
      async first() { return stmt.get(...this._params) || null },
      async all() { return { results: stmt.all(...this._params) } },
      async run() {
        const info = stmt.run(...this._params)
        return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } }
      },
    }
  }
  return {
    prepare,
    async batch(statements) {
      const results = []
      const txn = db.transaction(() => {
        for (const s of statements) {
          const info = db.prepare(s._sql).run(...(s._params || []))
          results.push({ meta: { changes: info.changes, last_row_id: info.lastInsertRowid } })
        }
      })
      txn()
      return results
    },
  }
}

const OWNER = 'test@example.com'

function freshDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const m of MIGRATIONS) {
    db.exec(fs.readFileSync(path.join(__dirname, '../migrations', m), 'utf8'))
  }
  return { db, d1: createD1Adapter(db) }
}

function makeApp(d1) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('userEmail', OWNER)
    await next()
  })
  app.route('/a', artifactApp)
  const env = { DB: d1, ARTIFACT_QUEUE: { send: async () => {} } }
  return { app, env }
}

function count(db, sql, ...params) {
  return db.prepare(sql).get(...params).n
}

// 7개 테이블에 전부 행을 심은 아티팩트 하나를 만든다. 버전 체인(v2.parent=v1) 포함.
function seedFullArtifact(db) {
  const artId = db.prepare(
    `INSERT INTO artifacts (title, type, status, description, row_revision, owner_email, html_content)
     VALUES ('T', 'html', 'draft', '', 1, ?, '<html/>')`
  ).run(OWNER).lastInsertRowid
  const v1 = db.prepare(
    `INSERT INTO artifact_versions (artifact_id, version_no, html_content, content_sha256)
     VALUES (?, 1, '<html/>', 'h1')`
  ).run(artId).lastInsertRowid
  const v2 = db.prepare(
    `INSERT INTO artifact_versions (artifact_id, version_no, parent_version_id, html_content, content_sha256)
     VALUES (?, 2, ?, '<html/>', 'h2')`
  ).run(artId, v1).lastInsertRowid
  db.prepare(`UPDATE artifacts SET draft_version_id=?, published_version_id=? WHERE id=?`).run(v2, v1, artId)
  db.prepare(
    `INSERT INTO artifact_files (version_id, file_path, content, content_sha256, file_size)
     VALUES (?, 'index.html', '<html/>', 'h1', 7)`
  ).run(v1)
  db.prepare(
    `INSERT INTO artifact_files (version_id, file_path, content, content_sha256, file_size)
     VALUES (?, 'index.html', '<html/>', 'h2', 7)`
  ).run(v2)
  db.prepare(
    `INSERT INTO artifact_chats (artifact_id, session_key, who, content) VALUES (?, 'p1', 'user', 'hi')`
  ).run(artId)
  const jobId = db.prepare(
    `INSERT INTO artifact_jobs (kind, artifact_id, prompt, status, owner_email)
     VALUES ('create', ?, 'p', 'done', ?)`
  ).run(artId, OWNER).lastInsertRowid
  db.prepare(
    `INSERT INTO artifact_job_events (job_id, event_type, payload) VALUES (?, 'job.started', '{}')`
  ).run(jobId)
  db.prepare(
    `INSERT INTO job_provider_attempts (provider_attempt_id, job_id, attempt_no, provider, model, state)
     VALUES ('pa-1', ?, 1, 'gemini', 'm', 'completed')`
  ).run(jobId)
  return { artId, jobId }
}

const TABLES = [
  'artifact_files',
  'artifact_versions',
  'artifact_chats',
  'artifact_job_events',
  'job_provider_attempts',
  'artifact_jobs',
  'artifacts',
]

describe('관문 36: 삭제 트랜잭션 (실제 SQLite + 실제 라우트)', () => {
  test('정상 삭제 → 7개 테이블 행이 모두 사라진다', async () => {
    const { db, d1 } = freshDb()
    try {
      const { app, env } = makeApp(d1)
      const { artId } = seedFullArtifact(db)
      for (const t of TABLES) {
        expect(count(db, `SELECT COUNT(*) AS n FROM ${t}`)).toBeGreaterThan(0)
      }

      const res = await app.request('/a/' + artId, { method: 'DELETE' }, env)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })

      for (const t of TABLES) {
        expect(count(db, `SELECT COUNT(*) AS n FROM ${t}`)).toBe(0)
      }
    } finally {
      db.close()
    }
  })

  test('원자성: batch 중간 실패 시 이미 지운 행까지 전부 롤백된다', async () => {
    const { db, d1 } = freshDb()
    try {
      const { app, env } = makeApp(d1)
      const { artId } = seedFullArtifact(db)
      const before = {}
      for (const t of TABLES) before[t] = count(db, `SELECT COUNT(*) AS n FROM ${t}`)
      // artifact_jobs 삭제에서 강제 실패시키는 트리거 (batch의 7번째 문장 지점)
      db.exec(`CREATE TRIGGER txn_fail BEFORE DELETE ON artifact_jobs
               BEGIN SELECT RAISE(ABORT, 'injected failure'); END`)

      const res = await app.request('/a/' + artId, { method: 'DELETE' }, env)
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.ok).toBe(false)

      // 먼저 실행된 files/versions/chats/events/attempts DELETE까지 롤백되어
      // 어떤 테이블의 행 수도 변하지 않아야 한다
      for (const t of TABLES) {
        expect(count(db, `SELECT COUNT(*) AS n FROM ${t}`)).toBe(before[t])
      }
      expect(count(db, 'SELECT COUNT(*) AS n FROM artifacts WHERE id = ?', artId)).toBe(1)
    } finally {
      db.close()
    }
  })

  test('없는 아티팩트 삭제 → 404, DB 그대로', async () => {
    const { db, d1 } = freshDb()
    try {
      const { app, env } = makeApp(d1)
      seedFullArtifact(db)
      const before = {}
      for (const t of TABLES) before[t] = count(db, `SELECT COUNT(*) AS n FROM ${t}`)

      const res = await app.request('/a/99999', { method: 'DELETE' }, env)
      expect(res.status).toBe(404)

      for (const t of TABLES) {
        expect(count(db, `SELECT COUNT(*) AS n FROM ${t}`)).toBe(before[t])
      }
    } finally {
      db.close()
    }
  })
})
