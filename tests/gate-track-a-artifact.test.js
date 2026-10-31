/**
 * 백로그 트랙 A (2026-10-29): artifact 소유권·이관·(취소는 gate-55) 실DB 검증
 *
 * 검증하는 성질 (src/modules/artifact/routes.ts):
 * - 관문 79 (POST /jobs): artifact_id가 있으면 소유권을 확인한다.
 *   타인 artifact_id → 403이고 잡 행이 생기지 않는다. 본인 artifact_id → 202,
 *   artifact_id 없음 → 기존대로 202 + 새 프로젝트 자동 생성.
 * - 관문 80 (POST /chats/migrate): 이관 대상은 artifact_id IS NULL인 고아
 *   세션 채팅뿐이다. session_key가 'p<타인 artifact id>'로 결정적이어도,
 *   이미 아티팩트에 붙은 채팅은 이동하지 않고 행이 그대로 남는다.
 *   고아 세션 채팅의 이관과 타인 to_artifact 403은 기존대로 동작한다.
 *
 * 방법: gate-55와 동일 — better-sqlite3 인메모리 DB에 실제 마이그레이션을
 * 적용하고, esbuild로 컴파일한 실제 routes.ts를 Hono app.request()로 호출한다.
 * 실행: npx jest tests/gate-track-a-artifact.test.js
 */
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const { Hono } = require('hono')
const { createLocalD1 } = require('./helpers/local-d1.cjs')

const routesPath = path.join(__dirname, '../src/modules/artifact/routes.ts')
const jsPath = '/tmp/artifact-routes-track-a-test.cjs'
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
  '0058_artifacts_owner_email.sql',
]

const ME = 'test@example.com'
const OTHER = 'other@example.com'

describe('트랙 A: POST /jobs 소유권 + POST /chats/migrate 고아 한정 (실DB)', () => {
  let d1
  let queueSent

  function makeApp(userEmail = ME) {
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('userEmail', userEmail)
      await next()
    })
    app.route('/a', artifactApp)
    const env = { DB: d1, ARTIFACT_QUEUE: { send: async (m) => { queueSent.push(m) } } }
    const json = (p, method, body) =>
      app.request('/a' + p, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }, env)
    return { json }
  }

  function seedArtifact(owner) {
    const r = d1._db.prepare(
      `INSERT INTO artifacts (title, type, status, html_content, owner_email) VALUES ('T', 'html', 'draft', '', ?)`,
    ).run(owner)
    return Number(r.lastInsertRowid)
  }

  function seedChat({ artifactId, sessionKey, content }) {
    const r = d1._db.prepare(
      `INSERT INTO artifact_chats (artifact_id, session_key, who, content) VALUES (?, ?, 'user', ?)`,
    ).run(artifactId, sessionKey, content)
    return Number(r.lastInsertRowid)
  }

  function chatRow(id) {
    return d1._db.prepare('SELECT artifact_id, session_key, content FROM artifact_chats WHERE id=?').get(id)
  }

  function jobCount() {
    return d1._db.prepare('SELECT COUNT(*) AS n FROM artifact_jobs').get().n
  }

  beforeAll(() => {
    d1 = createLocalD1(':memory:')
    for (const f of MIGRATIONS) {
      d1.exec(fs.readFileSync(path.join(__dirname, '../migrations', f), 'utf8'))
    }
  })

  afterAll(() => d1.close())

  beforeEach(() => {
    queueSent = []
    d1._db.prepare('DELETE FROM artifact_job_events').run()
    d1._db.prepare('DELETE FROM artifact_chats').run()
    d1._db.prepare('DELETE FROM artifact_files').run()
    d1._db.prepare('DELETE FROM artifact_versions').run()
    d1._db.prepare('DELETE FROM artifact_jobs').run()
    d1._db.prepare('DELETE FROM artifacts').run()
  })

  // ---------- 관문 79: POST /jobs artifact_id 소유권 ----------

  test('타인 artifact_id로 modify 잡 생성 → 403, 잡 미생성, 큐 미전송', async () => {
    const victim = seedArtifact(OTHER)
    const { json } = makeApp(ME)
    const res = await json('/jobs', 'POST', { kind: 'modify', prompt: '남의 앱 바꿔줘', artifact_id: victim })
    expect(res.status).toBe(403)
    expect((await res.json()).ok).toBe(false)
    expect(jobCount()).toBe(0)
    expect(queueSent).toHaveLength(0)
  })

  test('타인 artifact_id로 create 잡 생성 → 403, 잡 미생성', async () => {
    const victim = seedArtifact(OTHER)
    const { json } = makeApp(ME)
    const res = await json('/jobs', 'POST', { kind: 'create', prompt: '앱 만들어줘', artifact_id: victim })
    expect(res.status).toBe(403)
    expect(jobCount()).toBe(0)
  })

  test('존재하지 않는 artifact_id → 403, 잡 미생성', async () => {
    const { json } = makeApp(ME)
    const res = await json('/jobs', 'POST', { kind: 'modify', prompt: '바꿔줘', artifact_id: 99999 })
    expect(res.status).toBe(403)
    expect(jobCount()).toBe(0)
  })

  test('본인 artifact_id → 202, 잡이 그 artifact에 연결됨', async () => {
    const mine = seedArtifact(ME)
    const { json } = makeApp(ME)
    const res = await json('/jobs', 'POST', { kind: 'modify', prompt: '내 앱 바꿔줘', artifact_id: mine })
    expect(res.status).toBe(202)
    const j = await res.json()
    expect(j.ok).toBe(true)
    const job = d1._db.prepare('SELECT artifact_id, owner_email, status FROM artifact_jobs WHERE id=?').get(j.data.jobId)
    expect(job).toEqual({ artifact_id: mine, owner_email: ME, status: 'pending' })
    expect(queueSent).toEqual([{ jobId: j.data.jobId }])
  })

  test('artifact_id 없음 → 기존대로 202 + 새 프로젝트 자동 생성·연결', async () => {
    const { json } = makeApp(ME)
    const res = await json('/jobs', 'POST', { kind: 'create', prompt: '계산기 앱 만들어줘' })
    expect(res.status).toBe(202)
    const j = await res.json()
    const job = d1._db.prepare('SELECT artifact_id FROM artifact_jobs WHERE id=?').get(j.data.jobId)
    expect(job.artifact_id).not.toBeNull()
    const art = d1._db.prepare('SELECT owner_email FROM artifacts WHERE id=?').get(job.artifact_id)
    expect(art.owner_email).toBe(ME)
  })

  // ---------- 관문 80: POST /chats/migrate 고아 한정 ----------

  test('고아 세션 채팅(artifact_id NULL) 이관 성공 → artifact_id·session_key 갱신', async () => {
    const mine = seedArtifact(ME)
    const chatId = seedChat({ artifactId: null, sessionKey: 'new-12345', content: '고아 대화' })
    const { json } = makeApp(ME)
    const res = await json('/chats/migrate', 'POST', { from_session: 'new-12345', to_artifact_id: mine })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(chatRow(chatId)).toEqual({ artifact_id: mine, session_key: 'p' + mine, content: '고아 대화' })
  })

  test("'p<타인 artifact id>' 세션의 채팅은 이관되지 않는다 (행 불변)", async () => {
    const victim = seedArtifact(OTHER)
    const mine = seedArtifact(ME)
    const chatId = seedChat({ artifactId: victim, sessionKey: 'p' + victim, content: '타인 프로젝트 대화' })
    const { json } = makeApp(ME)
    const res = await json('/chats/migrate', 'POST', { from_session: 'p' + victim, to_artifact_id: mine })
    // 응답 자체는 기존 계약대로 ok (이관 대상이 없을 뿐) — 핵심은 행이 안 움직이는 것
    expect(res.status).toBe(200)
    expect(chatRow(chatId)).toEqual({ artifact_id: victim, session_key: 'p' + victim, content: '타인 프로젝트 대화' })
  })

  test('이미 자기 아티팩트에 붙은 채팅도 이 경로로는 이동하지 않는다 (행 불변)', async () => {
    const mineA = seedArtifact(ME)
    const mineB = seedArtifact(ME)
    const chatId = seedChat({ artifactId: mineA, sessionKey: 'p' + mineA, content: '내 프로젝트 A 대화' })
    const { json } = makeApp(ME)
    await json('/chats/migrate', 'POST', { from_session: 'p' + mineA, to_artifact_id: mineB })
    expect(chatRow(chatId)).toEqual({ artifact_id: mineA, session_key: 'p' + mineA, content: '내 프로젝트 A 대화' })
  })

  test('타인 to_artifact_id → 403 유지, 고아 채팅도 이동하지 않음', async () => {
    const victim = seedArtifact(OTHER)
    const chatId = seedChat({ artifactId: null, sessionKey: 'new-999', content: '고아 대화' })
    const { json } = makeApp(ME)
    const res = await json('/chats/migrate', 'POST', { from_session: 'new-999', to_artifact_id: victim })
    expect(res.status).toBe(403)
    expect(chatRow(chatId)).toEqual({ artifact_id: null, session_key: 'new-999', content: '고아 대화' })
  })
})
