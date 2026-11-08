/**
 * 관문 테스트 53: 프롬프트 길이 프론트엔드 검증 — 실검증 재작성 (2026-10-27)
 *
 * 옛 테스트는 expect(true) 연극이었다. 이 파일은 실제 파일·실제 코드로 검증한다.
 *
 * 검증하는 성질:
 * - 프론트엔드: AI 스튜디오(public/agent.html)의 프롬프트 입력창(#chatInput)에
 *   maxlength="10000"이 있다 — 브라우저에서 10000자를 넘겨 입력할 수 없다.
 * - 백엔드: POST /jobs가 10000자는 받고 10001자는 400으로 거부한다
 *   (src/modules/artifact/routes.ts 관문 25 제한). 프론트엔드만 믿지 않고
 *   서버가 같은 값으로 막는지까지 확인한다.
 *
 * 방법: agent.html을 직접 읽어 textarea 태그를 확인하고, better-sqlite3
 * 인메모리 DB + 실제 마이그레이션 + esbuild 컴파일한 실제 routes.ts를
 * Hono app.request()로 호출한다.
 * 실행: npx jest tests/gate-53-length.test.js
 */
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const { Hono } = require('hono')
const { createLocalD1 } = require('./helpers/local-d1.cjs')

const routesPath = path.join(__dirname, '../src/modules/artifact/routes.ts')
const jsPath = '/tmp/artifact-routes-gate53-test.cjs'
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
  '0039_artifact_jobs_indexes.sql', '0058_artifacts_owner_email.sql',
  '0040_artifact_jobs_pending_state.sql',
  '0041_artifact_jobs_base_snapshot.sql',
]

describe('관문 53: 프롬프트 길이 검증 (실파일 + 실DB)', () => {
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

  test('프론트엔드: 스튜디오 입력창(#chatInput)에 maxlength="10000"이 있다', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/agent.html'), 'utf8')
    const m = html.match(/<textarea[^>]*id="chatInput"[^>]*>/)
    expect(m).not.toBeNull()
    expect(m[0]).toContain('maxlength="10000"')
  })

  test('백엔드: 10000자 프롬프트는 받고(202), 10001자는 400으로 거부한다', async () => {
    const { json } = makeApp()
    const ok = await json('/jobs', 'POST', { prompt: 'x'.repeat(10000) })
    expect(ok.status).toBe(202)
    expect((await ok.json()).ok).toBe(true)
    const over = await json('/jobs', 'POST', { prompt: 'x'.repeat(10001) })
    expect(over.status).toBe(400)
    expect((await over.json()).error).toContain('10000자 제한')
    // 10001자 요청은 job 행을 만들지 않는다
    expect(d1._db.prepare('SELECT COUNT(*) AS n FROM artifact_jobs').get().n).toBe(1)
  })
})
