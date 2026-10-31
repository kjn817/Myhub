/**
 * 관문 테스트 46: 제목 생성 로직 — 실검증 재작성 (2026-10-27)
 *
 * 옛 테스트는 expect(true) 연극이었다. 이 파일은 실제 코드·실제 DB로 검증한다.
 *
 * 검증하는 성질:
 * - create: POST /jobs가 프롬프트에서 제목을 만든다
 *   ("계산기 앱 만들어줘" → "계산기 앱", 접미사 ' 만들어줘' 등 제거).
 *   (src/modules/artifact/routes.ts, title 정규식)
 * - modify: saveJobResult가 제목을 건드리지 않는다. modify는 새 버전만
 *   만들고 artifacts.title은 그대로 둔다.
 *   (src/modules/artifact/job-processor.ts saveJobResult — modify 분기에
 *   title UPDATE가 없음)
 *
 * 방법: better-sqlite3 인메모리 DB에 실제 마이그레이션 0032~0041을 적용하고,
 * esbuild로 컴파일한 실제 routes.ts / job-processor.ts를 호출한다.
 * 실행: npx jest tests/gate-46-title.test.js
 */
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const { Hono } = require('hono')
const { createLocalD1 } = require('./helpers/local-d1.cjs')

const routesPath = path.join(__dirname, '../src/modules/artifact/routes.ts')
const routesJs = '/tmp/artifact-routes-gate46-test.cjs'
execSync(
  `npx esbuild ${routesPath} --bundle --platform=node --format=cjs --outfile=${routesJs}`,
  { stdio: 'pipe' },
)
const { artifactApp } = require(routesJs)

const processorPath = path.join(__dirname, '../src/modules/artifact/job-processor.ts')
const processorJs = '/tmp/artifact-processor-gate46-test.cjs'
execSync(
  `npx esbuild ${processorPath} --bundle --platform=node --format=cjs --outfile=${processorJs}`,
  { stdio: 'pipe' },
)
const { saveJobResult } = require(processorJs)

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

describe('관문 46: 제목 생성 로직 (실DB)', () => {
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
    return { json, env }
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

  async function createTitle(prompt) {
    const { json } = makeApp()
    const res = await json('/jobs', 'POST', { prompt })
    expect(res.status).toBe(202)
    const { jobId } = (await res.json()).data
    const job = d1._db.prepare('SELECT artifact_id FROM artifact_jobs WHERE id=?').get(jobId)
    return d1._db.prepare('SELECT title FROM artifacts WHERE id=?').get(job.artifact_id).title
  }

  test('create: "계산기 앱 만들어줘" → 제목 "계산기 앱"', async () => {
    expect(await createTitle('계산기 앱 만들어줘')).toBe('계산기 앱')
  })

  test('create: "할 일 관리 앱 만들어주세요" → 제목 "할 일 관리 앱"', async () => {
    expect(await createTitle('할 일 관리 앱 만들어주세요')).toBe('할 일 관리 앱')
  })

  test('create: 접미사 없는 프롬프트는 그대로 제목 (30자까지)', async () => {
    expect(await createTitle('날씨 위젯')).toBe('날씨 위젯')
    const long = '가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라'
    expect(long.length).toBeGreaterThan(30)
    expect(await createTitle(long)).toBe(long.slice(0, 30))
  })

  test('modify: saveJobResult가 제목을 바꾸지 않고 새 버전만 만든다', async () => {
    const { env } = makeApp()
    const art = d1._db.prepare(
      `INSERT INTO artifacts (title, type, status, description, row_revision, html_content) VALUES ('원래 제목', 'html', 'draft', '', 1, '<html>old</html>')`,
    ).run()
    const artifactId = art.lastInsertRowid
    const job = d1._db.prepare(
      `INSERT INTO artifact_jobs (kind, artifact_id, prompt, status, owner_email) VALUES ('modify', ?, '버튼 색 바꿔줘', 'running', 'test@example.com')`,
    ).run(artifactId)
    const jobId = job.lastInsertRowid

    const r = await saveJobResult(env, jobId, '<html>new</html>', '바꾸려는 제목', 'modify', '버튼 색 바꿔줘', artifactId)
    expect(r.versionCreated).toBe(true)
    expect(r.artifactId).toBe(artifactId)
    // 제목은 그대로, 버전만 새로 생긴다
    expect(d1._db.prepare('SELECT title FROM artifacts WHERE id=?').get(artifactId).title).toBe('원래 제목')
    const ver = d1._db.prepare('SELECT html_content FROM artifact_versions WHERE artifact_id=?').get(artifactId)
    expect(ver).toBeTruthy()
    expect(ver.html_content).toContain('new')
  })
})
