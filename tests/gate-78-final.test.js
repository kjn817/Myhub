/**
 * 관문 78 + 관문 82: POST /jobs model 검증 — 실제 라우트 + 실제 SQLite 검증.
 *
 * 2026-10-27 전면 재작성: 이전 버전은 "검증 완료"만 적힌
 * expect(true).toBe(true) 연극이었다. 코드 주석(routes.ts POST /jobs,
 * "관문 78: model 길이 제한")이 가리키는 실제 성질을 검증한다:
 * model이 100자를 초과하면 400 + job 행 미생성.
 *
 * 2026-10-30 새 사양 (관문 82, 잠재 경로 하드닝): 길이만으로는 통과하지
 * 않는다. model이 제공되면 src/services/ai.ts의 MODELS에서 status가
 * 'active'인 집합에 실재해야 하고, 없거나 비활성이면 400이다. provider가
 * 함께 오면 active 후보의 provider와 일치해야 한다. 즉 길이 100자
 * 이하라도 미등록 model은 400이며, 등록된 active model만 통과해
 * 그대로 저장된다. 길이 게이트 자체는 여전히 유효하다 (101자 → 400
 * 케이스가 그 성질을 계속 검증한다).
 * 실제 마이그레이션 파일(0032·0033·0034·0035·0036·0039)을
 * better-sqlite3 인메모리 DB에 적용하고, esbuild로 컴파일한 실제
 * src/modules/artifact/routes.ts를 Hono app.request()로 호출한다.
 *
 * 실행: npx jest tests/gate-78-final.test.js
 */
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { Hono } = require('hono')
const { createLocalD1 } = require('./helpers/local-d1.cjs')

const MIG_DIR = path.join(__dirname, '..', 'migrations')
const ROUTES_TS = path.join(__dirname, '..', 'src/modules/artifact/routes.ts')
const COMPILED = '/tmp/gate-78-artifact-routes.cjs'
execSync(
  `npx esbuild ${ROUTES_TS} --bundle --platform=node --format=cjs --outfile=${COMPILED}`,
  { stdio: 'pipe' },
)
const { artifactApp } = require(COMPILED)

const OWNER = 'kimjn00003@naver.com'

describe('관문 78+82: POST /jobs model 길이·레지스트리 검증 (실제 라우트 + 실제 DB)', () => {
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

  test('model 101자 → 400, job 행 미생성', async () => {
    const r = await createJob({ model: 'm'.repeat(101) })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/100자/)
    expect(jobCount()).toBe(0)
  })

  test('model 정확히 100자이지만 미등록 → 400, job 행 미생성 (길이 경계는 통과해도 관문 82 레지스트리 검증에서 거부)', async () => {
    const model = 'm'.repeat(100)
    expect(model).toHaveLength(100)
    const r = await createJob({ model })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/unknown model/)
    expect(jobCount()).toBe(0)
  })

  test('등록된 active model → 202, model 그대로 저장', async () => {
    // src/services/ai.ts MODELS에서 직접 확인: 'gemini-3.5-flash-lite'는
    // provider 'gemini', status 'active'로 등록돼 있다.
    // createJob 헬퍼는 provider를 함께 보내지 않으므로 관문 82의
    // provider 일치 검증 대상이 아니다 (model 단독 검증만 적용된다).
    const model = 'gemini-3.5-flash-lite'
    const r = await createJob({ model })
    expect(r.status).toBe(202)
    expect(r.body.data.jobId).toBeGreaterThan(0)
    const job = db.prepare('SELECT model FROM artifact_jobs WHERE id = ?').get(r.body.data.jobId)
    expect(job.model).toBe(model)
  })

  test('model 생략 → 202', async () => {
    const r = await createJob({})
    expect(r.status).toBe(202)
    expect(jobCount()).toBe(1)
  })
})
