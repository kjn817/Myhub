/**
 * 관문 테스트 55: 작업 취소 — 실검증 재작성 (2026-10-27)
 *
 * 옛 테스트는 expect(true) 연극이었다. 이 파일은 실제 코드·실제 DB로 검증한다.
 *
 * 검증하는 성질 (src/modules/artifact/routes.ts POST /jobs/:id/cancel):
 * - 소유권: 남의 작업은 404 '작업 없음'으로 거부하고 행을 건드리지 않는다.
 * - 상태: done/failed 작업은 400 '이미 완료된 작업'으로 거부하고 상태를
 *   바꾸지 않는다. pending/running만 취소된다.
 * - lease 무효화: 취소된 pending/running 작업의 lease_token이 NULL이 되고
 *   status='failed', error='사용자 취소'가 된다 (실행 중 Job 중단).
 * - awaiting_input 작업도 취소된다 (관문 81, 2026-10-29 백로그 트랙 A-3로 계약 변경):
 *   이전 계약은 UPDATE가 닿지 않는데도 {ok:true}를 반환하는 거짓 성공을 고정하고
 *   있었다. 이제는 실제로 status='failed'가 되고 pending_state가 폐기되며,
 *   응답과 DB 상태가 일치한다.
 *
 * 방법: better-sqlite3 인메모리 DB에 실제 마이그레이션 0032~0041을 적용하고,
 * esbuild로 컴파일한 실제 routes.ts를 Hono app.request()로 호출한다.
 * 실행: npx jest tests/gate-55-cancel.test.js
 */
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const { Hono } = require('hono')
const { createLocalD1 } = require('./helpers/local-d1.cjs')

const routesPath = path.join(__dirname, '../src/modules/artifact/routes.ts')
const jsPath = '/tmp/artifact-routes-gate55-test.cjs'
execSync(
  `npx esbuild ${routesPath} --bundle --platform=node --format=cjs --outfile=${jsPath}`,
  { stdio: 'pipe' },
)
const { artifactApp } = require(jsPath)

const MIGRATIONS = [
  '0032_artifacts.sql',
  '0033_artifact_status.sql',
  '0034_artifact_versions.sql',
  '0035_artifact_files.sql',
  '0035_artifact_jobs.sql',
  '0036_artifact_chats.sql',
  '0037_job_provider_attempts.sql',
  '0038_artifact_job_events.sql',
  '0039_artifact_jobs_indexes.sql',
  '0040_artifact_jobs_pending_state.sql',
  '0041_artifact_jobs_base_snapshot.sql',
]

describe('관문 55: 작업 취소 (실DB)', () => {
  let d1

  function makeApp(userEmail = 'test@example.com') {
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('userEmail', userEmail)
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
    return { json }
  }

  function seedJob({ status, owner = 'test@example.com', lease = 'lease-abc' }) {
    const r = d1._db.prepare(
      `INSERT INTO artifact_jobs (kind, prompt, status, owner_email, lease_token, seen) VALUES ('create', 'p', ?, ?, ?, 1)`,
    ).run(status, owner, lease)
    return Number(r.lastInsertRowid)
  }

  function jobRow(id) {
    return d1._db.prepare('SELECT status, error, lease_token, seen FROM artifact_jobs WHERE id=?').get(id)
  }

  beforeAll(() => {
    d1 = createLocalD1(':memory:')
    for (const f of MIGRATIONS) {
      d1.exec(fs.readFileSync(path.join(__dirname, '../migrations', f), 'utf8'))
    }
  })

  afterAll(() => d1.close())

  beforeEach(() => {
    d1._db.prepare('DELETE FROM artifact_job_events').run()
    d1._db.prepare('DELETE FROM artifact_chats').run()
    d1._db.prepare('DELETE FROM artifact_files').run()
    d1._db.prepare('DELETE FROM artifact_versions').run()
    d1._db.prepare('DELETE FROM artifact_jobs').run()
    d1._db.prepare('DELETE FROM artifacts').run()
  })

  test('남의 pending 작업 취소 → 404, 행은 그대로', async () => {
    const id = seedJob({ status: 'pending', owner: 'other@example.com' })
    const { json } = makeApp('test@example.com')
    const res = await json(`/jobs/${id}/cancel`, 'POST', {})
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('작업 없음')
    expect(jobRow(id)).toEqual({ status: 'pending', error: null, lease_token: 'lease-abc', seen: 1 })
  })

  test('done 작업 취소 → 400, 상태 그대로', async () => {
    const id = seedJob({ status: 'done' })
    const { json } = makeApp()
    const res = await json(`/jobs/${id}/cancel`, 'POST', {})
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('이미 완료된 작업')
    expect(jobRow(id).status).toBe('done')
  })

  test('failed 작업 취소 → 400, 상태 그대로', async () => {
    const id = seedJob({ status: 'failed' })
    const { json } = makeApp()
    const res = await json(`/jobs/${id}/cancel`, 'POST', {})
    expect(res.status).toBe(400)
    expect(jobRow(id).status).toBe('failed')
  })

  test('pending 취소 → status=failed, error=사용자 취소, lease_token NULL', async () => {
    const id = seedJob({ status: 'pending' })
    const { json } = makeApp()
    const res = await json(`/jobs/${id}/cancel`, 'POST', {})
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(jobRow(id)).toEqual({ status: 'failed', error: '사용자 취소', lease_token: null, seen: 0 })
  })

  test('running 취소 → lease_token NULL로 무효화 (실행 중 Job 중단)', async () => {
    const id = seedJob({ status: 'running' })
    const { json } = makeApp()
    const res = await json(`/jobs/${id}/cancel`, 'POST', {})
    expect(res.status).toBe(200)
    const row = jobRow(id)
    expect(row.status).toBe('failed')
    expect(row.error).toBe('사용자 취소')
    expect(row.lease_token).toBeNull()
  })

  test('관문 81: awaiting_input 취소 → 실제로 failed 전이 + pending_state 폐기 (응답·DB 일치)', async () => {
    const r = d1._db.prepare(
      `INSERT INTO artifact_jobs (kind, prompt, status, owner_email, lease_token, seen, pending_state)
       VALUES ('create', 'p', 'awaiting_input', 'test@example.com', 'lease-abc', 1, ?)`,
    ).run(JSON.stringify({ questions: [{ id: 'q1', question: '색?' }], answers: [], files: {} }))
    const id = Number(r.lastInsertRowid)
    const { json } = makeApp()
    const res = await json(`/jobs/${id}/cancel`, 'POST', {})
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    // 거짓 성공이 아니어야 한다: DB가 응답대로 취소 상태여야 한다
    expect(jobRow(id)).toEqual({ status: 'failed', error: '사용자 취소', lease_token: null, seen: 0 })
    const ps = d1._db.prepare('SELECT pending_state FROM artifact_jobs WHERE id=?').get(id)
    expect(ps.pending_state).toBeNull()
    // 취소된 잡은 /answer로 재개할 수 없어야 한다 (awaiting_input가 아니므로 400)
    const ans = await json(`/jobs/${id}/answer`, 'POST', { answers: [{ id: 'q1', answer: '파랑' }] })
    expect(ans.status).toBe(400)
  })
})
