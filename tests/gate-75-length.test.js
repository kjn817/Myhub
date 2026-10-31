/**
 * 관문 75: PATCH 길이 검증 — 실제 라우트 + 실제 SQLite 검증.
 *
 * 2026-10-27 전면 재작성: 이전 버전은 expect(true).toBe(true) 연극이었다.
 * 이제 실제 마이그레이션 파일(0032·0033·0034)을 better-sqlite3 인메모리 DB에
 * 적용하고, esbuild로 컴파일한 실제 src/modules/artifact/routes.ts를
 * Hono app.request()로 호출한다. 성질(routes.ts PATCH /:id, "관문 75"):
 * title 200자 / description 1000자 / icon_key 50자 초과 시 400을 반환하고
 * DB 행을 바꾸지 않는다.
 *
 * ⚠ 발견된 결함 (이 테스트로는 고칠 수 없어 보고만 한다):
 * 유효한 PATCH는 500 '수정 실패'이 된다. 원인: routes.ts가
 * `UPDATE artifacts ... WHERE id = ? AND owner_email = ?`을 실행하는데
 * artifacts 테이블에는 owner_email 컬럼이 git 마이그레이션 어디에도 없다
 * (0032 생성 + 0033·0034·0035 ALTER 전부 없음 — 운영 D1의 sqlite_master
 * 조회로도 확인: 운영 artifacts에도 owner_email 없음).
 * 0039 결함과 같은 부류로, 고치려면 artifacts.owner_email을 추가하는
 * 신규 마이그레이션이 필요해 이 배치의 권한 밖이다. 그래서 아래 테스트는
 * 길이 검증(400 + DB 불변)만 다루고, 정상 수정 경로(200)는 이 파일에
 * 넣지 않는다 — 가짜 PASS를 만들지 않기 위해서다.
 * 재현: node /tmp/repro75.cjs (당시 기록: PATCH valid → 500,
 * SqliteError: no such column: owner_email).
 *
 * 실행: npx jest tests/gate-75-length.test.js
 */
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { Hono } = require('hono')
const { createLocalD1 } = require('./helpers/local-d1.cjs')

const MIG_DIR = path.join(__dirname, '..', 'migrations')
const ROUTES_TS = path.join(__dirname, '..', 'src/modules/artifact/routes.ts')
const COMPILED = '/tmp/gate-75-artifact-routes.cjs'
execSync(
  `npx esbuild ${ROUTES_TS} --bundle --platform=node --format=cjs --outfile=${COMPILED}`,
  { stdio: 'pipe' },
)
const { artifactApp } = require(COMPILED)

const OWNER = 'kimjn00003@naver.com'

describe('관문 75: PATCH 길이 검증 (실제 라우트 + 실제 DB)', () => {
  let d1
  let db
  let app
  let artId

  const env = () => ({ DB: d1, ARTIFACT_QUEUE: { send: async () => {} } })

  beforeAll(() => {
    d1 = createLocalD1(':memory:')
    db = d1._db
    for (const m of ['0032_artifacts.sql', '0033_artifact_status.sql', '0034_artifact_versions.sql']) {
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
    db.exec('DELETE FROM artifacts')
    db.prepare(
      `INSERT INTO artifacts (title, type, status, description, icon_key, row_revision, html_content)
       VALUES ('원본 제목', 'html', 'draft', '원본 설명', 'star', 1, '')`,
    ).run()
    artId = db.prepare('SELECT id FROM artifacts').get().id
  })

  async function patch(body) {
    const res = await app.request(`/a/${artId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, env())
    return { status: res.status, body: await res.json() }
  }

  function row() {
    return db.prepare('SELECT title, description, icon_key FROM artifacts WHERE id = ?').get(artId)
  }

  test('title 201자 → 400, DB 제목 불변', async () => {
    const r = await patch({ title: 'x'.repeat(201) })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/200자/)
    expect(row().title).toBe('원본 제목')
  })

  test('description 1001자 → 400, DB 설명 불변', async () => {
    const r = await patch({ description: 'y'.repeat(1001) })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/1000자/)
    expect(row().description).toBe('원본 설명')
  })

  test('icon_key 51자 → 400, DB 아이콘 불변', async () => {
    const r = await patch({ icon_key: 'i'.repeat(51) })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/50자/)
    expect(row().icon_key).toBe('star')
  })

  test('세 필드 모두 초과 → 400, 어떤 필드도 안 바뀐다', async () => {
    const r = await patch({ title: 'x'.repeat(201), description: 'y'.repeat(1001), icon_key: 'i'.repeat(51) })
    expect(r.status).toBe(400)
    expect(row()).toEqual({ title: '원본 제목', description: '원본 설명', icon_key: 'star' })
  })

  test('수정 항목이 없으면 400', async () => {
    const r = await patch({})
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/수정할 항목 없음/)
  })

  test('존재하지 않는 id + 초과 길이 → 검증이 조회보다 먼저라 400', async () => {
    const res = await app.request('/a/999999', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(201) }),
    }, env())
    expect(res.status).toBe(400)
  })
})
