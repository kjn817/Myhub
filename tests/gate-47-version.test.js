/**
 * 관문 테스트 47: 버전 번호 동시성 — 실제 SQLite + 실제 라우트 검증.
 *
 * 2026-10-27 전면 재작성: 이전 버전은 expect(true).toBe(true) 연극이었다.
 * 이제 실제 마이그레이션 파일을 better-sqlite3 인메모리 DB에 적용하고,
 * esbuild로 컴파일한 실제 routes.ts를 호출한다.
 *
 * 검증하는 성질 (routes.ts POST /:id/versions, 마이그레이션 0034):
 * 1) 순차 생성 시 버전 번호가 MAX(version_no)+1로 1씩 증가한다.
 * 2) 안전망: 같은 (artifact_id, version_no) INSERT는 UNIQUE 제약이
 *    거부한다 — MAX+1 경합이 조용한 중복 번호로 이어지지 않고 크게 실패한다
 *    (관문 47 헤더의 "UNIQUE 제약이 없어 DB 오류 안 남"은 사실과 다르다.
 *    0034에 UNIQUE(artifact_id, version_no)가 있다).
 * 3) 낙관적 락: stale row_revision으로 버전 생성 시 409이고,
 *    버전이 생성되지 않는다.
 */
const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { Hono } = require('hono')

const ROUTES_TS = path.join(__dirname, '../src/modules/artifact/routes.ts')
const ROUTES_JS = '/tmp/artifact-routes-gate47-test.cjs'
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

function makeApp(d1) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('userEmail', OWNER)
    await next()
  })
  app.route('/a', artifactApp)
  const env = { DB: d1, ARTIFACT_QUEUE: { send: async () => {} } }
  const json = (p, method, body) =>
    app.request('/a' + (p === '/' ? '' : p), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env)
  const req = (p, init) => app.request('/a' + p, init, env)
  return { app, env, json, req }
}

describe('관문 47: 버전 번호 (실제 SQLite + 실제 라우트)', () => {
  test('순차 생성 시 버전 번호가 1씩 증가한다', async () => {
    const { db, d1 } = freshDb()
    try {
      const { json, req } = makeApp(d1)
      // 아티팩트 + v1은 직접 심는다 (POST / 는 이 관문의 검증 대상이 아니다)
      const artId = db.prepare(
        `INSERT INTO artifacts (title, type, status, description, row_revision, owner_email, html_content)
         VALUES ('T', 'html', 'draft', '', 1, ?, '<html/>')`
      ).run(OWNER).lastInsertRowid
      db.prepare(
        `INSERT INTO artifact_versions (artifact_id, version_no, html_content, content_sha256)
         VALUES (?, 1, '<html>v1</html>', 'h1')`
      ).run(artId)
      expect(db.prepare('SELECT version_no AS n FROM artifact_versions WHERE artifact_id=?').get(artId).n).toBe(1)

      let res = await json(`/${artId}/versions`, 'POST', { html_content: '<html>v2</html>', change_note: 'v2' })
      expect(res.status).toBe(200)
      expect((await res.json()).data.version_no).toBe(2)

      res = await json(`/${artId}/versions`, 'POST', { html_content: '<html>v3</html>', change_note: 'v3' })
      expect(res.status).toBe(200)
      expect((await res.json()).data.version_no).toBe(3)

      const nos = db.prepare(
        'SELECT version_no AS n FROM artifact_versions WHERE artifact_id=? ORDER BY version_no'
      ).all(artId).map((r) => r.n)
      expect(nos).toEqual([1, 2, 3])
      // 히스토리 조회도 번호 내림차순이다
      res = await req(`/${artId}/versions`, {})
      const hist = await res.json()
      expect(hist.data.versions.map((v) => v.version_no)).toEqual([3, 2, 1])
    } finally {
      db.close()
    }
  })

  test('안전망: 같은 버전 번호 INSERT는 UNIQUE 제약이 거부한다', async () => {
    const { db, d1 } = freshDb()
    try {
      const artId = db.prepare(
        `INSERT INTO artifacts (title, type, status, description, row_revision, owner_email, html_content)
         VALUES ('T', 'html', 'draft', '', 1, ?, '<html/>')`
      ).run(OWNER).lastInsertRowid
      db.prepare(
        `INSERT INTO artifact_versions (artifact_id, version_no, html_content, content_sha256)
         VALUES (?, 1, '<html>v1</html>', 'h1')`
      ).run(artId)

      // 경합 재현: MAX+1을 두 번 계산해 같은 번호로 INSERT하면 두 번째가 실패해야 한다
      expect(() =>
        db.prepare(
          `INSERT INTO artifact_versions (artifact_id, version_no, html_content, content_sha256)
           VALUES (?, 1, '<html/>', 'x')`
        ).run(artId)
      ).toThrow(/UNIQUE constraint failed/)
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id=?').get(artId).n).toBe(1)
    } finally {
      db.close()
    }
  })

  test('stale row_revision → 409, 버전이 생성되지 않는다', async () => {
    const { db, d1 } = freshDb()
    try {
      const { json } = makeApp(d1)
      const artId = db.prepare(
        `INSERT INTO artifacts (title, type, status, description, row_revision, owner_email, html_content)
         VALUES ('T', 'html', 'draft', '', 1, ?, '<html/>')`
      ).run(OWNER).lastInsertRowid
      db.prepare(
        `INSERT INTO artifact_versions (artifact_id, version_no, html_content, content_sha256)
         VALUES (?, 1, '<html>v1</html>', 'h1')`
      ).run(artId)
      const rev = db.prepare('SELECT row_revision AS r FROM artifacts WHERE id=?').get(artId).r

      // 현재 revision으로는 성공
      let r2 = await json(`/${artId}/versions`, 'POST', { html_content: '<html>v2</html>', row_revision: rev })
      expect(r2.status).toBe(200)

      // 이미 쓴 옛 revision으로는 409 (다른 탭에서 수정됨)
      r2 = await json(`/${artId}/versions`, 'POST', { html_content: '<html>stale</html>', row_revision: rev })
      expect(r2.status).toBe(409)
      expect((await r2.json()).error).toMatch(/CONFLICT/)

      // 버전은 2개 그대로 (v1, v2)
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id=?').get(artId).n).toBe(2)
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id=? AND html_content=?').get(artId, '<html>stale</html>').n).toBe(0)
    } finally {
      db.close()
    }
  })
})
