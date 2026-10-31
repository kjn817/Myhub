/**
 * 관문 테스트 37: 롤백 파일 정합성 — 실제 SQLite + 실제 라우트 검증.
 *
 * 2026-10-27 전면 재작성: 이전 버전은 expect(true).toBe(true) 연극이었다.
 * 이제 실제 마이그레이션 파일을 better-sqlite3 인메모리 DB에 적용하고,
 * esbuild로 컴파일한 실제 routes.ts를 호출한다.
 *
 * 검증하는 성질 (routes.ts POST /:id/rollback/:versionNo):
 * - 롤백은 published_version_id 포인터만 바꾸고, 버전·파일 행은 그대로 둔다.
 * - 롤백 후 GET /:id는 해당 버전의 HTML을, 파일 조회는 해당 버전의
 *   artifact_files를 반환한다 (포인터 변경만으로 이전 버전 파일이 자동 사용).
 * - 없는 버전 롤백 → 404, 포인터 불변. 타인 소유 → 403, 포인터 불변.
 * - 롤백 시 row_revision이 1 증가한다.
 */
const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { Hono } = require('hono')

const ROUTES_TS = path.join(__dirname, '../src/modules/artifact/routes.ts')
const ROUTES_JS = '/tmp/artifact-routes-gate37-test.cjs'
try {
  execSync(`npx esbuild ${ROUTES_TS} --bundle --platform=node --format=cjs --outfile=${ROUTES_JS}`, { stdio: 'pipe' })
} catch (e) {
  console.error('TypeScript 컴파일 실패:', e.message)
}
const { artifactApp } = require(ROUTES_JS)

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


function createD1Adapter(db) {
  const prepare = (sql) => {
    const stmt = db.prepare(sql)
    return {
      _sql: sql,
      _params: [],
      bind(...p) { this._params = p; return this },
      async first() { return stmt.get(...this._params) || null },
      async all() { return { results: stmt.all(...this._params) } },
      async run() {
        const info = stmt.run(...this._params)
        return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } }
      },
    }
  }
  return {
    prepare,
    async batch(statements) {
      const results = []
      const txn = db.transaction(() => {
        for (const s of statements) {
          const info = db.prepare(s._sql).run(...(s._params || []))
          results.push({ meta: { changes: info.changes, last_row_id: info.lastInsertRowid } })
        }
      })
      txn()
      return results
    },
  }
}

const OWNER = 'test@example.com'

function freshDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const m of MIGRATIONS) {
    db.exec(fs.readFileSync(path.join(__dirname, '../migrations', m), 'utf8'))
  }
  return { db, d1: createD1Adapter(db) }
}

function makeApp(d1, owner = OWNER) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('userEmail', owner)
    await next()
  })
  app.route('/a', artifactApp)
  const env = { DB: d1, ARTIFACT_QUEUE: { send: async () => {} } }
  return { app, env }
}

// v1(게시) + v2(초안) 아티팩트. 버전별 HTML·파일 내용이 다르다.
function seedTwoVersions(db) {
  const artId = db.prepare(
    `INSERT INTO artifacts (title, type, status, description, row_revision, owner_email, html_content)
     VALUES ('T', 'html', 'draft', '', 1, ?, '<html/>')`
  ).run(OWNER).lastInsertRowid
  const v1 = db.prepare(
    `INSERT INTO artifact_versions (artifact_id, version_no, html_content, content_sha256)
     VALUES (?, 1, '<html>v1</html>', 'h1')`
  ).run(artId).lastInsertRowid
  const v2 = db.prepare(
    `INSERT INTO artifact_versions (artifact_id, version_no, parent_version_id, html_content, content_sha256)
     VALUES (?, 2, ?, '<html>v2</html>', 'h2')`
  ).run(artId, v1).lastInsertRowid
  db.prepare(`UPDATE artifacts SET draft_version_id=?, published_version_id=?, status='published' WHERE id=?`).run(v2, v1, artId)
  db.prepare(
    `INSERT INTO artifact_files (version_id, file_path, content, content_sha256, file_size)
     VALUES (?, 'index.html', '<html>v1</html>', 'h1', 15)`
  ).run(v1)
  db.prepare(
    `INSERT INTO artifact_files (version_id, file_path, content, content_sha256, file_size)
     VALUES (?, 'index.html', '<html>v2</html>', 'h2', 15)`
  ).run(v2)
  return { artId, v1, v2 }
}

describe('관문 37: 롤백 (실제 SQLite + 실제 라우트)', () => {
  test('롤백 → 포인터만 바뀌고 GET은 해당 버전 HTML·파일을 반환한다', async () => {
    const { db, d1 } = freshDb()
    try {
      const { app, env } = makeApp(d1)
      const { artId, v1, v2 } = seedTwoVersions(db)

      // v2로 롤백
      let res = await app.request(`/a/${artId}/rollback/2`, { method: 'POST' }, env)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, data: { rolled_back_to: 2 } })

      let art = db.prepare('SELECT published_version_id AS p, draft_version_id AS d, row_revision AS r FROM artifacts WHERE id=?').get(artId)
      expect(art.p).toBe(v2)
      expect(art.d).toBe(v2) // draft 포인터는 그대로 (롤백은 published만 바꾼다)
      expect(art.r).toBe(2) // row_revision +1

      // GET 상세는 v2 HTML을 반환
      res = await app.request('/a/' + artId, {}, env)
      const detail = await res.json()
      expect(detail.ok).toBe(true)
      expect(detail.data.html_content).toBe('<html>v2</html>')
      expect(detail.data.published_version).toBe(2)

      // 버전별 파일 조회는 v2 파일을 반환
      res = await app.request(`/a/${artId}/versions/2/files`, {}, env)
      const files = await res.json()
      expect(files.ok).toBe(true)
      expect(files.data).toHaveLength(1)
      expect(files.data[0].content).toBe('<html>v2</html>')

      // v1로 다시 롤백하면 v1 HTML·파일이 돌아온다 (버전·파일 행은 삭제되지 않음)
      res = await app.request(`/a/${artId}/rollback/1`, { method: 'POST' }, env)
      expect(res.status).toBe(200)
      art = db.prepare('SELECT published_version_id AS p FROM artifacts WHERE id=?').get(artId)
      expect(art.p).toBe(v1)
      res = await app.request('/a/' + artId, {}, env)
      expect((await res.json()).data.html_content).toBe('<html>v1</html>')
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id=?').get(artId).n).toBe(2)
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_files').get().n).toBe(2)
    } finally {
      db.close()
    }
  })

  test('없는 버전 롤백 → 404, 포인터 불변', async () => {
    const { db, d1 } = freshDb()
    try {
      const { app, env } = makeApp(d1)
      const { artId, v1 } = seedTwoVersions(db)

      const res = await app.request(`/a/${artId}/rollback/99`, { method: 'POST' }, env)
      expect(res.status).toBe(404)
      const art = db.prepare('SELECT published_version_id AS p, row_revision AS r FROM artifacts WHERE id=?').get(artId)
      expect(art.p).toBe(v1)
      expect(art.r).toBe(1)
    } finally {
      db.close()
    }
  })

  test('타인 소유 롤백 → 403, 포인터 불변', async () => {
    const { db, d1 } = freshDb()
    try {
      const { app, env } = makeApp(d1, 'other@example.com')
      const { artId, v1 } = seedTwoVersions(db)

      const res = await app.request(`/a/${artId}/rollback/2`, { method: 'POST' }, env)
      expect(res.status).toBe(403)
      const art = db.prepare('SELECT published_version_id AS p FROM artifacts WHERE id=?').get(artId)
      expect(art.p).toBe(v1)
    } finally {
      db.close()
    }
  })
})
