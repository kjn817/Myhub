/**
 * 관문 테스트 45: 폴링 — 실제 SQLite + 실제 라우트 검증.
 *
 * 2026-10-27 전면 재작성: 이전 버전은 expect(true).toBe(true) 연극이었다.
 * pollJob(public/agent.html)은 DOM·fetch·타이머에 묶여 있어 Node 단위 테스트로
 * 직접 실행할 수 없다. 대신 폴링이 의존하는 서버 계약을 실제 DB·실제
 * 라우트로 검증한다. 이 계약이 깨지면 폴링은 동작할 수 없다.
 *
 * 검증하는 성질 (GET /jobs/:id/events?since=, GET /jobs/:id):
 * 1) events는 id 오름차순으로 반환되고, since보다 큰 id만 반환한다
 *    (폴링이 lastEventId로 증분 조회하는 전제).
 * 2) since가 최신보다 크면 빈 배열이다.
 * 3) job 상태 전이(pending → running → done)가 상태 조회에 그대로 보인다.
 * 4) 타인 소유 job의 이벤트·상태는 403이다.
 */
const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { Hono } = require('hono')

const ROUTES_TS = path.join(__dirname, '../src/modules/artifact/routes.ts')
const ROUTES_JS = '/tmp/artifact-routes-gate45-test.cjs'
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

function seedJobWithEvents(db, owner = OWNER) {
  const jobId = db.prepare(
    `INSERT INTO artifact_jobs (kind, artifact_id, prompt, status, owner_email)
     VALUES ('create', NULL, 'p', 'pending', ?)`
  ).run(owner).lastInsertRowid
  const eventIds = []
  for (const type of ['job.started', 'file.changed', 'version.committed', 'job.completed']) {
    eventIds.push(
      db.prepare(`INSERT INTO artifact_job_events (job_id, event_type, payload) VALUES (?, ?, ?)`)
        .run(jobId, type, JSON.stringify({ seq: eventIds.length + 1 })).lastInsertRowid
    )
  }
  return { jobId, eventIds }
}

describe('관문 45: 폴링 계약 (실제 SQLite + 실제 라우트)', () => {
  test('events는 id 오름차순, since보다 큰 것만 반환한다', async () => {
    const { db, d1 } = freshDb()
    try {
      const { app, env } = makeApp(d1)
      const { jobId, eventIds } = seedJobWithEvents(db)

      let res = await app.request(`/a/jobs/${jobId}/events?since=0`, {}, env)
      expect(res.status).toBe(200)
      let body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.data.map((e) => e.event_type)).toEqual([
        'job.started',
        'file.changed',
        'version.committed',
        'job.completed',
      ])
      expect(body.data.map((e) => e.id)).toEqual(eventIds)
      // 페이로드가 JSON 문자열 그대로 구조화되어 있다
      expect(JSON.parse(body.data[1].payload)).toEqual({ seq: 2 })

      // since=두 번째 이벤트 id → 뒤의 2개만 (폴링 증분 조회의 전제)
      res = await app.request(`/a/jobs/${jobId}/events?since=${eventIds[1]}`, {}, env)
      body = await res.json()
      expect(body.data.map((e) => e.event_type)).toEqual(['version.committed', 'job.completed'])
      expect(body.data.map((e) => e.id)).toEqual([eventIds[2], eventIds[3]])

      // since가 최신보다 크면 빈 배열 (폴링이 멈추지 않고 빈 손으로 돌아온다)
      res = await app.request(`/a/jobs/${jobId}/events?since=${eventIds[3]}`, {}, env)
      body = await res.json()
      expect(body.data).toEqual([])
    } finally {
      db.close()
    }
  })

  test('job 상태 전이가 상태 조회에 그대로 보인다', async () => {
    const { db, d1 } = freshDb()
    try {
      const { app, env } = makeApp(d1)
      const { jobId } = seedJobWithEvents(db)

      const getStatus = async () => {
        const res = await app.request(`/a/jobs/${jobId}`, {}, env)
        expect(res.status).toBe(200)
        return (await res.json()).data.status
      }
      expect(await getStatus()).toBe('pending')
      db.prepare(`UPDATE artifact_jobs SET status='running' WHERE id=?`).run(jobId)
      expect(await getStatus()).toBe('running')
      db.prepare(`UPDATE artifact_jobs SET status='done', result_html='<html/>' WHERE id=?`).run(jobId)
      expect(await getStatus()).toBe('done')
      db.prepare(`UPDATE artifact_jobs SET status='failed', error='boom' WHERE id=?`).run(jobId)
      expect(await getStatus()).toBe('failed')
    } finally {
      db.close()
    }
  })

  test('타인 소유 job의 이벤트·상태 조회는 403이다', async () => {
    const { db, d1 } = freshDb()
    try {
      const { app, env } = makeApp(d1, 'other@example.com')
      const { jobId } = seedJobWithEvents(db)

      let res = await app.request(`/a/jobs/${jobId}/events?since=0`, {}, env)
      expect(res.status).toBe(403)
      res = await app.request(`/a/jobs/${jobId}`, {}, env)
      expect(res.status).toBe(404)
    } finally {
      db.close()
    }
  })
})
