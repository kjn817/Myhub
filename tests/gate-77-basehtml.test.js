/**
 * 관문 77: base_html 크기 제한 — 실제 라우트 + 실제 SQLite 검증.
 *
 * 2026-10-27 전면 재작성: 이전 버전은 expect(true).toBe(true) 연극이었다.
 * 이제 실제 마이그레이션 파일(0032·0033·0034·0035·0036·0039)을
 * better-sqlite3 인메모리 DB에 적용하고, esbuild로 컴파일한 실제
 * src/modules/artifact/routes.ts를 Hono app.request()로 호출한다.
 * 성질(routes.ts POST /jobs, "관문 77"): base_html이 2MB를 초과하면
 * 400 + job 행 미생성, 2MB 이하면 202 + job 생성이다.
 *
 * 실행: npx jest tests/gate-77-basehtml.test.js
 */
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { Hono } = require('hono')
const { createLocalD1 } = require('./helpers/local-d1.cjs')

const MIG_DIR = path.join(__dirname, '..', 'migrations')
const ROUTES_TS = path.join(__dirname, '..', 'src/modules/artifact/routes.ts')
const COMPILED = '/tmp/gate-77-artifact-routes.cjs'
execSync(
  `npx esbuild ${ROUTES_TS} --bundle --platform=node --format=cjs --outfile=${COMPILED}`,
  { stdio: 'pipe' },
)
const { artifactApp } = require(COMPILED)

const OWNER = 'kimjn00003@naver.com'
const LIMIT = 2 * 1024 * 1024

describe('관문 77: POST /jobs base_html 크기 제한 (실제 라우트 + 실제 DB)', () => {
  let d1
  let db
  let app

  const env = () => ({ DB: d1, ARTIFACT_QUEUE: { send: async () => {} } })

  beforeAll(() => {
    d1 = createLocalD1(':memory:')
    db = d1._db
    for (const m of [
      '0032_artifacts.sql',
      '0033_artifact_status.sql',
      '0034_artifact_versions.sql',
      '0035_artifact_files.sql',
      '0035_artifact_jobs.sql',
      '0036_artifact_chats.sql',
      '0039_artifact_jobs_indexes.sql', '0058_artifacts_owner_email.sql',
    ]) {
      db.exec(fs.readFileSync(path.join(MIG_DIR, m), 'utf8'))
    }
    app = new Hono()
    app.use('*', async (c, next) => {
      c.set('userEmail', OWNER)
      await next()
    })
    app.route('/a', artifactApp)
  })

  afterAll(() => {
    db.close()
  })

  beforeEach(() => {
    db.exec('DELETE FROM artifact_chats')
    db.exec('DELETE FROM artifact_jobs')
    db.exec('DELETE FROM artifacts')
  })

  async function createJob(body) {
    const res = await app.request('/a/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '테스트 프롬프트', ...body }),
    }, env())
    return { status: res.status, body: await res.json() }
  }

  function jobCount() {
    return db.prepare('SELECT COUNT(*) AS n FROM artifact_jobs').get().n
  }

  test('base_html 2MB+1자 → 400, job 행 미생성', async () => {
    const r = await createJob({ base_html: 'x'.repeat(LIMIT + 1) })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/2MB/)
    expect(jobCount()).toBe(0)
  })

  test('base_html 정확히 2MB → 202, job 생성', async () => {
    const r = await createJob({ base_html: 'x'.repeat(LIMIT) })
    expect(r.status).toBe(202)
    expect(r.body.data.jobId).toBeGreaterThan(0)
    expect(jobCount()).toBe(1)
  })

  test('base_html 작음 → 202, base_html 그대로 저장', async () => {
    const html = '<html><body>hello</body></html>'
    const r = await createJob({ base_html: html })
    expect(r.status).toBe(202)
    const job = db.prepare('SELECT base_html FROM artifact_jobs WHERE id = ?').get(r.body.data.jobId)
    expect(job.base_html).toBe(html)
  })

  test('base_html 생략 → 202', async () => {
    const r = await createJob({})
    expect(r.status).toBe(202)
    expect(jobCount()).toBe(1)
  })
})
