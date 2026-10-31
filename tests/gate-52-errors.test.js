/**
 * 관문 테스트 52: 에러 메시지 품질 — 실검증 재작성 (2026-10-27)
 *
 * 옛 테스트는 expect(true) 연극이었다. 이 파일은 실제 코드·실제 DB로 검증한다.
 *
 * 검증하는 성질 (src/modules/artifact/routes.ts):
 * - 에러 응답이 "조회 실패"/"생성 실패" 같은 제네릭 문구가 아니라, 어디서
 *   무엇이 실패했는지 구체적으로 말한다.
 *   (관문 22의 요구 — 제네릭 메시지는 디버깅 불가)
 *
 * 방법: better-sqlite3 인메모리 DB에 실제 마이그레이션 0032~0041을 적용하고,
 * esbuild로 컴파일한 실제 routes.ts를 Hono app.request()로 호출해 실제
 * 에러 경로의 응답 메시지를 확인한다.
 * 실행: npx jest tests/gate-52-errors.test.js
 */
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const { Hono } = require('hono')
const { createLocalD1 } = require('./helpers/local-d1.cjs')

const routesPath = path.join(__dirname, '../src/modules/artifact/routes.ts')
const jsPath = '/tmp/artifact-routes-gate52-test.cjs'
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

// 관문 22에서 금지한 제네릭 메시지 (정확히 이 문구 그대로면 실패)
const GENERIC = ['조회 실패', '생성 실패', '저장 실패', '삭제 실패', '실패']

describe('관문 52: 에러 메시지 품질 — 구체적 메시지 (실DB)', () => {
  let d1
  let sent

  function makeApp(userEmail = 'test@example.com') {
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('userEmail', userEmail)
      await next()
    })
    app.route('/a', artifactApp)
    const env = { DB: d1, ARTIFACT_QUEUE: { send: async (m) => { sent.push(m) } } }
    const json = (p, method, body) =>
      app.request('/a' + p, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }, env)
    return { json }
  }

  function expectSpecific(error) {
    expect(typeof error).toBe('string')
    expect(error.length).toBeGreaterThan(3)
    for (const g of GENERIC) expect(error).not.toBe(g)
  }

  beforeAll(() => {
    d1 = createLocalD1(':memory:')
    for (const f of MIGRATIONS) {
      d1.exec(fs.readFileSync(path.join(__dirname, '../migrations', f), 'utf8'))
    }
  })

  afterAll(() => d1.close())

  beforeEach(() => {
    sent = []
    d1._db.prepare('DELETE FROM artifact_job_events').run()
    d1._db.prepare('DELETE FROM artifact_chats').run()
    d1._db.prepare('DELETE FROM artifact_files').run()
    d1._db.prepare('DELETE FROM artifact_versions').run()
    d1._db.prepare('DELETE FROM artifact_jobs').run()
    d1._db.prepare('DELETE FROM artifacts').run()
  })

  test.each([
    ['prompt 없음', '/jobs', 'POST', {}, 400, 'prompt 필요'],
    ['prompt 10001자', '/jobs', 'POST', { prompt: 'x'.repeat(10001) }, 400, 'prompt가 너무 깁니다'],
    ['kind 무효', '/jobs', 'POST', { kind: 'bogus', prompt: 'a' }, 400, 'kind는'],
    ['provider 무효', '/jobs', 'POST', { provider: 'openai', prompt: 'a' }, 400, 'provider는'],
    ['model 101자', '/jobs', 'POST', { model: 'm'.repeat(101), prompt: 'a' }, 400, 'model이 너무 깁니다'],
    ['없는 작업 조회', '/jobs/999', 'GET', undefined, 404, '작업 없음'],
    ['없는 작업 취소', '/jobs/999/cancel', 'POST', {}, 404, '작업 없음'],
  ])('%s → %s', async (_name, p, method, body, status, fragment) => {
    const { json } = makeApp()
    const res = await json(p, method, body)
    expect(res.status).toBe(status)
    const { error } = await res.json()
    expect(error).toContain(fragment)
    expectSpecific(error)
  })

  test('이미 완료된 작업 취소 → 400, 원인을 구체적으로 말한다', async () => {
    d1._db.prepare(
      `INSERT INTO artifact_jobs (kind, prompt, status, owner_email) VALUES ('create', 'a', 'done', 'test@example.com')`,
    ).run()
    const { json } = makeApp()
    const res = await json('/jobs/1/cancel', 'POST', {})
    expect(res.status).toBe(400)
    const { error } = await res.json()
    expect(error).toContain('이미 완료된 작업')
    expectSpecific(error)
  })
})
