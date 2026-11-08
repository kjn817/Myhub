/**
 * 관문 테스트 34: 작업 이벤트 정리 — 실제 SQLite + 실제 삭제 라우트 검증.
 *
 * 2026-10-28 전면 재작성: 이전 버전은 하드코딩된 배열 두 개를 비교할 뿐
 * 실제 코드를 실행하지 않는 연극이었다 (감사 docs/test-quality-audit-20261028.md §2.1).
 * gate-45 선례대로 실제 DB + 실제 라우트로 검증한다.
 *
 * 검증하는 성질 (DELETE /a/:id — src/modules/artifact/routes.ts):
 * 1) 아티팩트 삭제 시 artifact_job_events 행이 함께 삭제된다
 *    (2026-10-27에 "아티팩트 삭제·버전 정리가 FK 오류로 실패하고 catch {}로
 *    삼켜짐"이 P0급으로 발견·수정된 바 있다 — 이 테스트가 그 회귀를 잡는다).
 * 2) files·versions·chats·jobs·provider attempts도 함께 삭제된다.
 * 3) 삭제 범위는 해당 아티팩트에 속한 행으로 한정된다 (다른 아티팩트의
 *    이벤트는 남는다).
 * 4) 타인 소유 아티팩트 삭제는 404이고 아무것도 지우지 않는다.
 */
const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { Hono } = require('hono')

const ROUTES_TS = path.join(__dirname, '../src/modules/artifact/routes.ts')
const ROUTES_JS = '/tmp/artifact-routes-gate34-test.cjs'
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

function makeApp(d1, owner = OWNER) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('userEmail', owner)
    await next()
  })
  app.route('/a', artifactApp)
  const env = { DB: d1, ARTIFACT_QUEUE: { send: async () => {} } }
  return { app, env }
}

/** 아티팩트 1개 + 관련 행(버전·파일·채팅·작업·이벤트·시도)을 전부 심는다. */
function seedArtifact(db, owner = OWNER, title = '위젯') {
  const artifactId = db.prepare(
    `INSERT INTO artifacts (title, type, html_content, owner_email) VALUES (?, 'html', '<p>x</p>', ?)`
  ).run(title, owner).lastInsertRowid
  const versionId = db.prepare(
    `INSERT INTO artifact_versions (artifact_id, version_no, html_content, content_sha256) VALUES (?, 1, '<p>x</p>', 'abc')`
  ).run(artifactId).lastInsertRowid
  db.prepare(
    `INSERT INTO artifact_files (version_id, file_path, content, content_sha256) VALUES (?, 'index.html', '<p>x</p>', 'abc')`
  ).run(versionId)
  db.prepare(
    `INSERT INTO artifact_chats (artifact_id, session_key, who, content) VALUES (?, 's1', 'user', 'hi')`
  ).run(artifactId)
  const jobId = db.prepare(
    `INSERT INTO artifact_jobs (kind, artifact_id, prompt, status, owner_email) VALUES ('create', ?, 'p', 'done', ?)`
  ).run(artifactId, owner).lastInsertRowid
  const eventIds = []
  for (const type of ['job.started', 'file.changed', 'version.committed', 'job.completed']) {
    eventIds.push(
      db.prepare(`INSERT INTO artifact_job_events (job_id, event_type, payload) VALUES (?, ?, ?)`)
        .run(jobId, type, JSON.stringify({ seq: eventIds.length + 1 })).lastInsertRowid
    )
  }
  db.prepare(
    `INSERT INTO job_provider_attempts (provider_attempt_id, job_id, attempt_no, provider, model, state) VALUES (?, ?, 1, 'nvidia', 'm', 'completed')`
  ).run(`att-${jobId}`, jobId)
  return { artifactId, versionId, jobId, eventIds }
}

function count(db, table, where = '', ...params) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...params).n
}

describe('관문 34: 이벤트 정리 (실제 SQLite + 실제 삭제 라우트)', () => {
  test('아티팩트 삭제 시 artifact_job_events를 포함한 관련 행이 모두 삭제된다', async () => {
    const { db, d1 } = freshDb()
    try {
      const { app, env } = makeApp(d1)
      const { artifactId, jobId, eventIds } = seedArtifact(db)

      // 삭제 전: 관련 행이 실제로 존재한다 (시드 자체가 비어 있으면 테스트가 공허해진다)
      expect(count(db, 'artifacts')).toBe(1)
      expect(count(db, 'artifact_versions')).toBe(1)
      expect(count(db, 'artifact_files')).toBe(1)
      expect(count(db, 'artifact_chats')).toBe(1)
      expect(count(db, 'artifact_jobs')).toBe(1)
      expect(count(db, 'artifact_job_events')).toBe(4)
      expect(count(db, 'job_provider_attempts')).toBe(1)

      const res = await app.request(`/a/${artifactId}`, { method: 'DELETE' }, env)
      expect(res.status).toBe(200)
      expect((await res.json()).ok).toBe(true)

      // 삭제 후: 아티팩트 본체 + 모든 관련 행이 0건이다 — 고아 이벤트가 남으면 실패
      expect(count(db, 'artifacts')).toBe(0)
      expect(count(db, 'artifact_versions')).toBe(0)
      expect(count(db, 'artifact_files')).toBe(0)
      expect(count(db, 'artifact_chats')).toBe(0)
      expect(count(db, 'artifact_jobs')).toBe(0)
      expect(count(db, 'artifact_job_events')).toBe(0)
      expect(count(db, 'job_provider_attempts')).toBe(0)
      // 시드했던 이벤트 id가 DB에 남아 있지 않다
      for (const id of eventIds) {
        expect(db.prepare('SELECT id FROM artifact_job_events WHERE id=?').get(id)).toBeUndefined()
      }
      expect(db.prepare('SELECT id FROM artifact_jobs WHERE id=?').get(jobId)).toBeUndefined()
    } finally {
      db.close()
    }
  })

  test('삭제 범위는 해당 아티팩트로 한정된다 — 다른 아티팩트의 이벤트는 남는다', async () => {
    const { db, d1 } = freshDb()
    try {
      const { app, env } = makeApp(d1)
      const first = seedArtifact(db, OWNER, '첫째')
      const second = seedArtifact(db, OWNER, '둘째')
      expect(count(db, 'artifact_job_events')).toBe(8)

      const res = await app.request(`/a/${first.artifactId}`, { method: 'DELETE' }, env)
      expect(res.status).toBe(200)

      expect(count(db, 'artifacts')).toBe(1)
      expect(count(db, 'artifact_job_events')).toBe(4)
      // 남은 4건은 둘째 아티팩트의 작업 이벤트이다
      const remainingJobId = db.prepare('SELECT id FROM artifact_jobs').get().id
      expect(remainingJobId).toBe(second.jobId)
      expect(count(db, 'artifact_job_events', 'WHERE job_id=?', second.jobId)).toBe(4)
      expect(count(db, 'artifact_job_events', 'WHERE job_id=?', first.jobId)).toBe(0)
    } finally {
      db.close()
    }
  })

  test('타인 소유 아티팩트 삭제는 404이고 이벤트를 지우지 않는다', async () => {
    const { db, d1 } = freshDb()
    try {
      const { app, env } = makeApp(d1, 'other@example.com')
      const { artifactId } = seedArtifact(db)
      expect(count(db, 'artifact_job_events')).toBe(4)

      const res = await app.request(`/a/${artifactId}`, { method: 'DELETE' }, env)
      expect(res.status).toBe(404)

      expect(count(db, 'artifacts')).toBe(1)
      expect(count(db, 'artifact_job_events')).toBe(4)
    } finally {
      db.close()
    }
  })
})
