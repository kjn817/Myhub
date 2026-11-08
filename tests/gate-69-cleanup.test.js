/**
 * 관문 테스트 69: 고아 채팅 정리 — 실제 SQLite + 실제 라우트 검증.
 *
 * 2026-10-27 전면 재작성: 이전 버전은 expect(true).toBe(true) 연극이었다.
 * 이제 실제 마이그레이션 파일을 better-sqlite3 인메모리 DB에 적용하고,
 * esbuild로 컴파일한 실제 routes.ts의 POST /chats/cleanup를 호출한다.
 *
 * 검증하는 성질:
 * - 30일 지난 artifact_id IS NULL 채팅만 삭제된다.
 * - 최근 고아 채팅, 30일 지났어도 프로젝트에 속한 채팅은 남는다.
 * - 반환된 deleted 수가 실제 삭제 행 수와 일치하고, 두 번째 호출은 0이다.
 *
 * 관문 24(채팅 데이터 정리)는 이 파일과 같은 성질(동일 엔드포인트·동일 정책)을
 * 검증하므로, gate-24 파일은 삭제하고 이 파일이 cover한다.
 */
const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { Hono } = require('hono')

const ROUTES_TS = path.join(__dirname, '../src/modules/artifact/routes.ts')
const ROUTES_JS = '/tmp/artifact-routes-gate69-test.cjs'
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
  return { app, env }
}

describe('관문 69: 고아 채팅 정리 (실제 SQLite + 실제 라우트)', () => {
  test('30일 지난 고아 채팅만 삭제되고 deleted 수가 일치한다', async () => {
    const { db, d1 } = freshDb()
    try {
      const { app, env } = makeApp(d1)
      const artId = db.prepare(
        `INSERT INTO artifacts (title, type, status, description, row_revision, owner_email, html_content)
         VALUES ('T', 'html', 'draft', '', 1, ?, '<html/>')`
      ).run(OWNER).lastInsertRowid
      const daysAgo = (n) => new Date(Date.now() - n * 86400 * 1000).toISOString().replace('T', ' ').slice(0, 19)
      const insertChat = (artifactId, sessionKey, createdAt) =>
        db.prepare(
          `INSERT INTO artifact_chats (artifact_id, session_key, who, content, created_at)
           VALUES (?, ?, 'user', 'x', ?)`
        ).run(artifactId, sessionKey, createdAt).lastInsertRowid
      // 30일 지난 고아 2건 (삭제 대상)
      const oldOrphan1 = insertChat(null, 'new_1', daysAgo(40))
      const oldOrphan2 = insertChat(null, 'job-2', daysAgo(31))
      // 최근 고아 (보존)
      const newOrphan = insertChat(null, 'new_3', daysAgo(1))
      // 30일 지났어도 프로젝트 소속 (보존)
      const oldAttached = insertChat(artId, 'p' + artId, daysAgo(40))
      // 29일 지난 고아 (보존 — 경계)
      const edgeOrphan = insertChat(null, 'new_4', daysAgo(29))

      const res = await app.request('/a/chats/cleanup', { method: 'POST' }, env)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ ok: true, data: { deleted: 2 } })

      const exists = (id) => db.prepare('SELECT COUNT(*) AS n FROM artifact_chats WHERE id=?').get(id).n
      expect(exists(oldOrphan1)).toBe(0)
      expect(exists(oldOrphan2)).toBe(0)
      expect(exists(newOrphan)).toBe(1)
      expect(exists(oldAttached)).toBe(1)
      expect(exists(edgeOrphan)).toBe(1)
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_chats').get().n).toBe(3)

      // 두 번째 호출은 삭제할 것이 없어 0이다 (멱등)
      const res2 = await app.request('/a/chats/cleanup', { method: 'POST' }, env)
      expect((await res2.json()).data.deleted).toBe(0)
    } finally {
      db.close()
    }
  })

  test('고아 채팅이 없으면 deleted 0, 200이다', async () => {
    const { db, d1 } = freshDb()
    try {
      const { app, env } = makeApp(d1)
      const res = await app.request('/a/chats/cleanup', { method: 'POST' }, env)
      expect(res.status).toBe(200)
      expect((await res.json()).data.deleted).toBe(0)
    } finally {
      db.close()
    }
  })
})
