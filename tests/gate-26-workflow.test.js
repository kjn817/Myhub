/**
 * 관문 테스트 26: Workflow 경로 일관성 — 실검증 재작성 (2026-10-27)
 *
 * 옛 테스트는 expect(true) 연극이었다. 이 파일은 실제 코드·실제 DB로 검증한다.
 *
 * 검증하는 성질 (src/modules/artifact/routes.ts POST /jobs):
 * - kind를 검증된 값(jobKind)으로만 사용한다: kind 생략 시 'create' 기본값,
 *   kind='modify'면 저장된 kind도 'modify', 유효하지 않은 kind는 400 거부.
 * - modify 분기는 검증된 jobKind로 판단한다: modify 작업은 시작 시점 파일
 *   스냅샷(base_version_id/base_snapshot)이 저장된다.
 *
 * 방법: better-sqlite3 인메모리 DB에 실제 마이그레이션 0032~0041을 적용하고,
 * esbuild로 컴파일한 실제 routes.ts를 Hono app.request()로 호출한다.
 * 실행: npx jest tests/gate-26-workflow.test.js
 */
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { Hono } = require('hono')
const { createLocalD1 } = require('./helpers/local-d1.cjs')

const routesPath = path.join(__dirname, '../src/modules/artifact/routes.ts')
const jsPath = '/tmp/artifact-routes-gate26-test.cjs'
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

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex')

describe('관문 26: Workflow 경로 — 검증된 jobKind 일관 사용 (실DB)', () => {
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

  test('kind 생략 → jobKind 기본값 create가 DB에 저장된다', async () => {
    const { json } = makeApp()
    const res = await json('/jobs', 'POST', { prompt: '계산기 앱 만들어줘' })
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.ok).toBe(true)
    const job = d1._db.prepare('SELECT kind, status FROM artifact_jobs WHERE id=?').get(body.data.jobId)
    expect(job.kind).toBe('create')
    expect(job.status).toBe('pending')
    expect(sent).toEqual([{ jobId: body.data.jobId }])
  })

  test('kind=create 명시 → create 저장', async () => {
    const { json } = makeApp()
    const res = await json('/jobs', 'POST', { kind: 'create', prompt: '메모 앱 만들어줘' })
    expect(res.status).toBe(202)
    const { jobId } = (await res.json()).data
    expect(d1._db.prepare('SELECT kind FROM artifact_jobs WHERE id=?').get(jobId).kind).toBe('create')
  })

  test('kind=modify → modify 저장 + 시작 시점 파일 스냅샷 기록', async () => {
    // 스냅샷 기준이 될 기존 아티팩트+버전+파일을 심는다
    // 관문 79(POST /jobs 소유권 확인) 이후: 픽스처 아티팩트의 owner_email이 요청
    // 사용자(makeApp 기본값 test@example.com)와 일치해야 실제 사용 형태가 된다.
    // 예전 픽스처는 owner_email이 NULL이라 403으로 막혔다 (2026-10-30 교정).
    const art = d1._db.prepare(
      `INSERT INTO artifacts (title, type, status, description, row_revision, html_content, owner_email) VALUES ('기존 앱', 'html', 'draft', '', 1, '<html>old</html>', 'test@example.com')`,
    ).run()
    const ver = d1._db.prepare(
      `INSERT INTO artifact_versions (artifact_id, version_no, html_content, content_sha256) VALUES (?, 1, '<html>old</html>', 'x')`,
    ).run(art.lastInsertRowid)
    d1._db.prepare('UPDATE artifacts SET draft_version_id=? WHERE id=?').run(ver.lastInsertRowid, art.lastInsertRowid)
    const content = '<html>old</html>'
    d1._db.prepare(
      `INSERT INTO artifact_files (version_id, file_path, content, content_sha256, file_size) VALUES (?, 'index.html', ?, ?, ?)`,
    ).run(ver.lastInsertRowid, content, sha256hex(content), content.length)

    const { json } = makeApp()
    const res = await json('/jobs', 'POST', {
      kind: 'modify',
      artifact_id: art.lastInsertRowid,
      prompt: '버튼 색을 파랗게 바꿔줘',
    })
    expect(res.status).toBe(202)
    const { jobId } = (await res.json()).data
    const job = d1._db.prepare(
      'SELECT kind, base_version_id, base_snapshot FROM artifact_jobs WHERE id=?',
    ).get(jobId)
    expect(job.kind).toBe('modify')
    // modify 분기가 검증된 jobKind로 동작했으므로 스냅샷이 기록된다
    expect(job.base_version_id).toBe(ver.lastInsertRowid)
    expect(JSON.parse(job.base_snapshot)).toEqual({ 'index.html': sha256hex(content) })
  })

  test('유효하지 않은 kind → 400, job 행이 생기지 않는다', async () => {
    const { json } = makeApp()
    const res = await json('/jobs', 'POST', { kind: 'bogus', prompt: '뭔가 만들어줘' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('kind는')
    expect(d1._db.prepare('SELECT COUNT(*) AS n FROM artifact_jobs').get().n).toBe(0)
    expect(sent).toEqual([])
  })

  test('kind 대소문자 변형(CREATE) → 400 (검증은 엄격)', async () => {
    const { json } = makeApp()
    const res = await json('/jobs', 'POST', { kind: 'CREATE', prompt: '뭔가 만들어줘' })
    expect(res.status).toBe(400)
    expect(d1._db.prepare('SELECT COUNT(*) AS n FROM artifact_jobs').get().n).toBe(0)
  })
})
