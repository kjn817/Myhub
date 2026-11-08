/**
 * 관문 테스트 72: 버전 저장소 — 실제 SQLite + 실제 라우트/job-processor 검증.
 *
 * 2026-10-27 전면 재작성: 이전 버전은 expect(true).toBe(true) 연극이었다.
 * 헤더의 "버전 수 제한 없음"은 코드 확인 결과 사실이 아니다.
 * job-processor.ts saveJobResult에 이미 "50개 초과 시 오래된 버전 정리
 * (published 제외)"가 있다. 단, 수동 버전 생성 경로(POST /:id/versions,
 * POST /:id/versions/files)에는 없어 수동 편집만으로 무한히 쌓이는
 * 결함이 있었고, 이번에 routes.ts에 같은 정책을 추가했다 (pruneOldVersions).
 *
 * 검증하는 성질:
 * 1) 버전당 2MB 상한: 초과 HTML·파일은 400으로 거부되고 버전이 안 생긴다.
 * 2) 수동 경로 정리: 55개 버전을 수동으로 만들면 최신 50개 + 게시본만 남는다.
 * 3) job 경로 정리: 55개 버전 상태에서 modify job이 끝나면 동일하게 정리된다.
 *    (버전 체인(parent_version_id)이 있어도 FK 오류 없이 정리된다 —
 *    2026-10-27 발견한 RESTRICT 결함의 회귀 테스트.)
 */
const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')
const { Hono } = require('hono')

const ROUTES_TS = path.join(__dirname, '../src/modules/artifact/routes.ts')
const ROUTES_JS = '/tmp/artifact-routes-gate72-test.cjs'
const JP_TS = path.join(__dirname, '../src/modules/artifact/job-processor.ts')
const JP_JS = '/tmp/artifact-job-processor-gate72-test.cjs'
try {
  execSync(`npx esbuild ${ROUTES_TS} --bundle --platform=node --format=cjs --outfile=${ROUTES_JS}`, { stdio: 'pipe' })
  execSync(`npx esbuild ${JP_TS} --bundle --platform=node --format=cjs --outfile=${JP_JS}`, { stdio: 'pipe' })
} catch (e) {
  console.error('TypeScript 컴파일 실패:', e.message)
}
const { artifactApp } = require(ROUTES_JS)
const { saveJobResult } = require(JP_JS)

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
  return { app, env, json }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

// parent 체인으로 연결된 버전 n개를 직접 심는다 (v1 게시).
function seedChainedVersions(db, n) {
  const artId = db.prepare(
    `INSERT INTO artifacts (title, type, status, description, row_revision, owner_email, html_content)
     VALUES ('T', 'html', 'draft', '', 1, ?, '<html/>')`
  ).run(OWNER).lastInsertRowid
  let prev = null
  const verIds = []
  for (let v = 1; v <= n; v++) {
    const html = `<html>v${v}</html>`
    const id = db.prepare(
      `INSERT INTO artifact_versions (artifact_id, version_no, parent_version_id, html_content, content_sha256, created_at)
       VALUES (?, ?, ?, ?, ?, '2026-01-01 00:00:00')`
    ).run(artId, v, prev, html, sha256(html)).lastInsertRowid
    verIds.push(id)
    prev = id
  }
  db.prepare(`UPDATE artifacts SET draft_version_id=?, published_version_id=?, status='published' WHERE id=?`)
    .run(verIds[verIds.length - 1], verIds[0], artId)
  return { artId, verIds }
}

describe('관문 72: 버전 저장소 (실제 SQLite + 실제 라우트)', () => {
  test('2MB 초과 HTML·파일은 400으로 거부되고 버전이 생기지 않는다', async () => {
    const { db, d1 } = freshDb()
    try {
      const { json } = makeApp(d1)
      const artId = db.prepare(
        `INSERT INTO artifacts (title, type, status, description, row_revision, owner_email, html_content)
         VALUES ('T', 'html', 'draft', '', 1, ?, '<html/>')`
      ).run(OWNER).lastInsertRowid
      const v1 = db.prepare(
        `INSERT INTO artifact_versions (artifact_id, version_no, html_content, content_sha256)
         VALUES (?, 1, '<html>v1</html>', 'h1')`
      ).run(artId).lastInsertRowid
      db.prepare(`UPDATE artifacts SET draft_version_id=? WHERE id=?`).run(v1, artId)

      const big = 'x'.repeat(2 * 1024 * 1024 + 1)
      let res = await json(`/${artId}/versions`, 'POST', { html_content: big })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/너무 큼/)

      res = await json(`/${artId}/versions/files`, 'POST', { files: { 'big.txt': big } })
      expect(res.status).toBe(400)

      // 버전은 v1 하나만 그대로다
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id=?').get(artId).n).toBe(1)
    } finally {
      db.close()
    }
  })

  test('수동 경로: 55개 버전 생성 후 최신 50개 + 게시본(v1)만 남는다', async () => {
    const { db, d1 } = freshDb()
    try {
      const { json } = makeApp(d1)
      // v1을 게시 상태로 직접 심는다 (POST /·publish는 이 관문의 검증 대상이 아니다)
      const { artId } = seedChainedVersions(db, 1)
      // v2..v56을 수동으로 55개 생성
      let res
      for (let v = 2; v <= 56; v++) {
        res = await json(`/${artId}/versions`, 'POST', { html_content: `<html>v${v}</html>` })
        expect(res.status).toBe(200)
      }
      const nos = db.prepare(
        'SELECT version_no AS n FROM artifact_versions WHERE artifact_id=? ORDER BY version_no'
      ).all(artId).map((r) => r.n)
      expect(nos).toHaveLength(51)
      expect(nos[0]).toBe(1) // 게시본 보존
      expect(nos.slice(1)).toEqual(Array.from({ length: 50 }, (_, i) => i + 7)) // 최신 50개 v7..v56
      // 게시본 v1의 내용은 그대로다
      expect(db.prepare('SELECT html_content FROM artifact_versions WHERE artifact_id=? AND version_no=1').get(artId).html_content).toBe('<html>v1</html>')
    } finally {
      db.close()
    }
  })

  test('job 경로: 55개 버전 상태에서 modify 완료 후에도 최신 50개 + 게시본만 남는다', async () => {
    const { db, d1 } = freshDb()
    try {
      const env = { DB: d1 }
      const { artId, verIds } = seedChainedVersions(db, 55)
      const jobId = db.prepare(
        `INSERT INTO artifact_jobs (kind, artifact_id, prompt, status, owner_email, base_version_id, base_snapshot)
         VALUES ('modify', ?, 'p', 'running', ?, ?, ?)`
      ).run(artId, OWNER, verIds[0], JSON.stringify({})).lastInsertRowid

      const r = await saveJobResult(env, jobId, '<html>new</html>', 't', 'modify', 'p', artId, {
        agentFiles: { 'index.html': '<html>new</html>' },
      })
      expect(r.versionCreated).toBe(true)

      const nos = db.prepare(
        'SELECT version_no AS n FROM artifact_versions WHERE artifact_id=? ORDER BY version_no'
      ).all(artId).map((r) => r.n)
      expect(nos).toHaveLength(51)
      expect(nos[0]).toBe(1) // 게시본 보존
      expect(nos[nos.length - 1]).toBe(56) // 새 버전 포함
      expect(nos.slice(1)).toEqual(Array.from({ length: 50 }, (_, i) => i + 7))
    } finally {
      db.close()
    }
  })
})
