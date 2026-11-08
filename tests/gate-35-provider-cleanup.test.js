/**
 * 관문 테스트 35: provider_attempts 정리 — 실제 SQLite + 실제 라우트 검증.
 *
 * 2026-10-27 전면 재작성: 이전 버전은 expect(true).toBe(true) 연극이었다.
 * 이제 실제 마이그레이션 파일을 better-sqlite3 인메모리 DB에 적용하고,
 * esbuild로 컴파일한 실제 src/modules/artifact/routes.ts를 Hono app.request()로
 * 호출한다. FK 강제(PRAGMA foreign_keys = ON)는 운영 D1과 동일하게 켠다.
 *
 * 검증하는 성질: 아티팩트 삭제 시 해당 아티팩트의 job에 딸린
 * job_provider_attempts 행이 함께 삭제되고, 다른 아티팩트·무소속 job의
 * 행은 그대로 남는다 (routes.ts DELETE batch의 해당 문장).
 *
 * 스키마 드리프트 주의: routes.ts가 쓰는 artifacts.owner_email 등은
 */
const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { Hono } = require('hono')

const ROUTES_TS = path.join(__dirname, '../src/modules/artifact/routes.ts')
const ROUTES_JS = '/tmp/artifact-routes-gate35-test.cjs'
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

describe('관문 35: provider_attempts 정리 (실제 SQLite + 실제 라우트)', () => {
  test('DELETE → 해당 아티팩트 job의 provider_attempts가 함께 삭제된다', async () => {
    const { db, d1 } = freshDb()
    try {
      const { app, env } = makeApp(d1)
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
      const jobId = db.prepare(
        `INSERT INTO artifact_jobs (kind, artifact_id, prompt, status, owner_email)
         VALUES ('create', ?, 'p', 'done', ?)`
      ).run(artId, OWNER).lastInsertRowid
      db.prepare(
        `INSERT INTO job_provider_attempts (provider_attempt_id, job_id, attempt_no, provider, model, state)
         VALUES ('pa-1', ?, 1, 'gemini', 'gemini-3.5-flash-lite', 'completed')`
      ).run(jobId)

      expect(count(db, 'SELECT COUNT(*) AS n FROM job_provider_attempts WHERE job_id = ?', jobId)).toBe(1)

      const res = await app.request('/a/' + artId, { method: 'DELETE' }, env)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })

      // 해당 job의 provider_attempts 삭제됨
      expect(count(db, 'SELECT COUNT(*) AS n FROM job_provider_attempts WHERE job_id = ?', jobId)).toBe(0)
      expect(count(db, 'SELECT COUNT(*) AS n FROM job_provider_attempts')).toBe(0)
      // 아티팩트·버전·job도 함께 삭제됨 (버전 체인이 있어도 FK 오류 없이)
      expect(count(db, 'SELECT COUNT(*) AS n FROM artifacts WHERE id = ?', artId)).toBe(0)
      expect(count(db, 'SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id = ?', artId)).toBe(0)
      expect(count(db, 'SELECT COUNT(*) AS n FROM artifact_jobs WHERE artifact_id = ?', artId)).toBe(0)
    } finally {
      db.close()
    }
  })

  test('다른 아티팩트·무소속 job의 provider_attempts는 그대로 남는다', async () => {
    const { db, d1 } = freshDb()
    try {
      const { app, env } = makeApp(d1)
      const mkArt = (title) => db.prepare(
        `INSERT INTO artifacts (title, type, status, description, row_revision, owner_email, html_content)
         VALUES (?, 'html', 'draft', '', 1, ?, '<html/>')`
      ).run(title, OWNER).lastInsertRowid
      const artA = mkArt('A')
      const artB = mkArt('B')
      const jobA = db.prepare(
        `INSERT INTO artifact_jobs (kind, artifact_id, prompt, status, owner_email)
         VALUES ('create', ?, 'p', 'done', ?)`
      ).run(artA, OWNER).lastInsertRowid
      const jobB = db.prepare(
        `INSERT INTO artifact_jobs (kind, artifact_id, prompt, status, owner_email)
         VALUES ('create', ?, 'p', 'done', ?)`
      ).run(artB, OWNER).lastInsertRowid
      const jobOrphan = db.prepare(
        `INSERT INTO artifact_jobs (kind, artifact_id, prompt, status, owner_email)
         VALUES ('create', NULL, 'p', 'done', ?)`
      ).run(OWNER).lastInsertRowid
      for (const [id, job] of [['pa-a', jobA], ['pa-b', jobB], ['pa-o', jobOrphan]]) {
        db.prepare(
          `INSERT INTO job_provider_attempts (provider_attempt_id, job_id, attempt_no, provider, model, state)
           VALUES (?, ?, 1, 'gemini', 'm', 'completed')`
        ).run(id, job)
      }

      const res = await app.request('/a/' + artA, { method: 'DELETE' }, env)
      expect(res.status).toBe(200)

      expect(count(db, 'SELECT COUNT(*) AS n FROM job_provider_attempts WHERE job_id = ?', jobA)).toBe(0)
      expect(count(db, 'SELECT COUNT(*) AS n FROM job_provider_attempts WHERE job_id = ?', jobB)).toBe(1)
      expect(count(db, 'SELECT COUNT(*) AS n FROM job_provider_attempts WHERE job_id = ?', jobOrphan)).toBe(1)
      expect(count(db, 'SELECT COUNT(*) AS n FROM artifact_jobs WHERE id = ?', jobB)).toBe(1)
    } finally {
      db.close()
    }
  })

  test('없는 아티팩트 삭제 → 404, 아무것도 지워지지 않는다', async () => {
    const { db, d1 } = freshDb()
    try {
      const { app, env } = makeApp(d1)
      const artId = db.prepare(
        `INSERT INTO artifacts (title, type, status, description, row_revision, owner_email, html_content)
         VALUES ('T', 'html', 'draft', '', 1, ?, '<html/>')`
      ).run(OWNER).lastInsertRowid
      const jobId = db.prepare(
        `INSERT INTO artifact_jobs (kind, artifact_id, prompt, status, owner_email)
         VALUES ('create', ?, 'p', 'done', ?)`
      ).run(artId, OWNER).lastInsertRowid
      db.prepare(
        `INSERT INTO job_provider_attempts (provider_attempt_id, job_id, attempt_no, provider, model, state)
         VALUES ('pa-1', ?, 1, 'gemini', 'm', 'completed')`
      ).run(jobId)

      const res = await app.request('/a/99999', { method: 'DELETE' }, env)
      expect(res.status).toBe(404)

      expect(count(db, 'SELECT COUNT(*) AS n FROM artifacts')).toBe(1)
      expect(count(db, 'SELECT COUNT(*) AS n FROM job_provider_attempts')).toBe(1)
    } finally {
      db.close()
    }
  })
})
