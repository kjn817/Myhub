/**
 * 관문 76: Provider 검증 — 실제 라우트 + 실제 SQLite 검증.
 *
 * 2026-10-27 전면 재작성: 이전 버전은 expect(true).toBe(true) 연극이었다.
 * 이제 실제 마이그레이션 파일(0032·0033·0034·0035·0036·0039)을
 * better-sqlite3 인메모리 DB에 적용하고, esbuild로 컴파일한 실제
 * src/modules/artifact/routes.ts를 Hono app.request()로 호출한다.
 * 성질(routes.ts POST /jobs, "관문 76"): provider는 gemini/groq/nvidia
 * 중 하나여야 하고, 그 외 값은 400 + job 행 미생성이다.
 *
 * 실행: npx jest tests/gate-76-provider.test.js
 */
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { Hono } = require('hono')
const { createLocalD1 } = require('./helpers/local-d1.cjs')

const MIG_DIR = path.join(__dirname, '..', 'migrations')
const ROUTES_TS = path.join(__dirname, '..', 'src/modules/artifact/routes.ts')
const COMPILED = '/tmp/gate-76-artifact-routes.cjs'
execSync(
  `npx esbuild ${ROUTES_TS} --bundle --platform=node --format=cjs --outfile=${COMPILED}`,
  { stdio: 'pipe' },
)
const { artifactApp } = require(COMPILED)

const OWNER = 'kimjn00003@naver.com'

describe('관문 76: POST /jobs provider 검증 (실제 라우트 + 실제 DB)', () => {
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

  test("provider 'openai' → 400, job 행 미생성", async () => {
    const r = await createJob({ provider: 'openai' })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/gemini\/groq/)
    expect(jobCount()).toBe(0)
  })

  test("provider 대소문자 변형 'Gemini' → 400 (검증은 대소문자 구분)", async () => {
    const r = await createJob({ provider: 'Gemini' })
    expect(r.status).toBe(400)
    expect(jobCount()).toBe(0)
  })

  test("provider 'workers-ai' → 400, job 행 미생성", async () => {
    const r = await createJob({ provider: 'workers-ai' })
    expect(r.status).toBe(400)
    expect(jobCount()).toBe(0)
  })

  test("provider 'nvidia' → 400, job 행 미생성 (2026-10-30: NVIDIA 운영 제외)", async () => {
    const r = await createJob({ provider: 'nvidia' })
    expect(r.status).toBe(400)
    expect(jobCount()).toBe(0)
  })

  test.each(['gemini', 'groq'])("provider '%s' → 202, provider 그대로 저장", async (provider) => {
    const r = await createJob({ provider })
    expect(r.status).toBe(202)
    expect(r.body.data.jobId).toBeGreaterThan(0)
    const job = db.prepare('SELECT provider FROM artifact_jobs WHERE id = ?').get(r.body.data.jobId)
    expect(job.provider).toBe(provider)
  })

  test('provider 생략 → 202, provider는 NULL로 저장', async () => {
    const r = await createJob({})
    expect(r.status).toBe(202)
    const job = db.prepare('SELECT provider FROM artifact_jobs WHERE id = ?').get(r.body.data.jobId)
    expect(job.provider).toBeNull()
  })
})
