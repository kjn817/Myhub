/**
 * 관문 테스트 32: API 응답 일관성 — 실제 SQLite + 실제 라우트 검증.
 *
 * 2026-10-27 전면 재작성: 이전 버전은 하드코딩한 응답 객체 두 개를
 * 비교하는 연극이었다. 이제 실제 마이그레이션 파일을 better-sqlite3
 * 인메모리 DB에 적용하고, esbuild로 컴파일한 실제 routes.ts를 호출한다.
 *
 * 검증하는 성질 (routes.ts POST /jobs):
 * - 신규 생성: 202 + { ok: true, data: { jobId } } (최상위 jobId 없음).
 * - 멱등성 dedup: 같은 client_request_id면 같은 jobId를
 *   { ok: true, data: { jobId, deduped: true } }로 반환한다.
 * - GET /jobs/:id, GET /jobs도 { ok: true, data: ... } 형태다.
 * - POST /jobs/:id/answer도 { ok: true, data: { jobId } } 202다.
 */
const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { Hono } = require('hono')

const ROUTES_TS = path.join(__dirname, '../src/modules/artifact/routes.ts')
const ROUTES_JS = '/tmp/artifact-routes-gate32-test.cjs'
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
  const json = (p, method, body) =>
    app.request('/a' + p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env)
  const req = (p, init) => app.request('/a' + p, init, env)
  return { app, env, json, req }
}

describe('관문 32: API 응답 일관성 (실제 SQLite + 실제 라우트)', () => {
  test('POST /jobs 신규 생성 → 202 { ok: true, data: { jobId } }', async () => {
    const { db, d1 } = freshDb()
    try {
      const { json } = makeApp(d1)
      const artId = db.prepare(
        `INSERT INTO artifacts (title, type, status, description, row_revision, owner_email, html_content)
         VALUES ('T', 'html', 'draft', '', 1, ?, '<html/>')`
      ).run(OWNER).lastInsertRowid

      const res = await json('/jobs', 'POST', {
        kind: 'create',
        artifact_id: artId,
        prompt: '계산기 만들어줘',
        client_request_id: 'req-32-a',
      })
      expect(res.status).toBe(202)
      const body = await res.json()
      // 구 형태 { ok: true, jobId }가 아니라 data 안에 있다
      expect(body).toEqual({ ok: true, data: { jobId: expect.any(Number) } })
      expect(body).not.toHaveProperty('jobId')
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_jobs WHERE id=?').get(body.data.jobId).n).toBe(1)
    } finally {
      db.close()
    }
  })

  test('POST /jobs 멱등성 dedup → 같은 jobId를 data 안에 반환한다', async () => {
    const { db, d1 } = freshDb()
    try {
      const { json } = makeApp(d1)
      const artId = db.prepare(
        `INSERT INTO artifacts (title, type, status, description, row_revision, owner_email, html_content)
         VALUES ('T', 'html', 'draft', '', 1, ?, '<html/>')`
      ).run(OWNER).lastInsertRowid

      const first = await (await json('/jobs', 'POST', {
        kind: 'create', artifact_id: artId, prompt: 'p', client_request_id: 'req-32-b',
      })).json()
      const secondRes = await json('/jobs', 'POST', {
        kind: 'create', artifact_id: artId, prompt: 'p', client_request_id: 'req-32-b',
      })
      expect(secondRes.status).toBe(202)
      const second = await secondRes.json()
      expect(second).toEqual({ ok: true, data: { jobId: first.data.jobId, deduped: true } })
      expect(second).not.toHaveProperty('jobId')
      // job은 하나만 생성됐다
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_jobs').get().n).toBe(1)
    } finally {
      db.close()
    }
  })

  test('GET /jobs/:id, GET /jobs도 { ok: true, data } 형태다', async () => {
    const { db, d1 } = freshDb()
    try {
      const { json, req } = makeApp(d1)
      const artId = db.prepare(
        `INSERT INTO artifacts (title, type, status, description, row_revision, owner_email, html_content)
         VALUES ('T', 'html', 'draft', '', 1, ?, '<html/>')`
      ).run(OWNER).lastInsertRowid
      const created = await (await json('/jobs', 'POST', {
        kind: 'create', artifact_id: artId, prompt: 'p', client_request_id: 'req-32-c',
      })).json()
      const jobId = created.data.jobId

      const one = await (await req(`/jobs/${jobId}`, {})).json()
      expect(one.ok).toBe(true)
      expect(one.data.id).toBe(jobId)
      expect(one.data.prompt).toBe('p')

      const list = await (await req('/jobs', {})).json()
      expect(list.ok).toBe(true)
      expect(Array.isArray(list.data)).toBe(true)
      expect(list.data.map((j) => j.id)).toContain(jobId)
    } finally {
      db.close()
    }
  })

  test('POST /jobs/:id/answer → 202 { ok: true, data: { jobId } }', async () => {
    const { db, d1 } = freshDb()
    try {
      const { json } = makeApp(d1)
      const jobId = db.prepare(
        `INSERT INTO artifact_jobs (kind, artifact_id, prompt, status, owner_email, pending_state)
         VALUES ('create', NULL, 'p', 'awaiting_input', ?, ?)`
      ).run(OWNER, JSON.stringify({ questions: [{ id: 'q1', question: '색은?' }] })).lastInsertRowid

      const res = await json(`/jobs/${jobId}/answer`, 'POST', {
        answers: [{ id: 'q1', answer: '파랑' }],
      })
      expect(res.status).toBe(202)
      const body = await res.json()
      expect(body).toEqual({ ok: true, data: { jobId } })
      expect(body).not.toHaveProperty('jobId')
      expect(db.prepare('SELECT status FROM artifact_jobs WHERE id=?').get(jobId).status).toBe('pending')
    } finally {
      db.close()
    }
  })
})
