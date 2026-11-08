/**
 * 관문 테스트 43: 동시 수정 — 실제 SQLite + 실제 job-processor 검증.
 *
 * 2026-10-27 전면 재작성: 이전 버전은 expect(true).toBe(true) 연극이었다.
 * 이제 실제 마이그레이션 파일을 better-sqlite3 인메모리 DB에 적용하고,
 * esbuild로 컴파일한 실제 src/modules/artifact/job-processor.ts의
 * claimJob / saveJobResult를 호출한다 (AI 호출 없음 — 결과 저장 단계만).
 *
 * 검증하는 성질:
 * 1) Lease claim: 한 job을 두 번 claim하면 두 번째는 'busy'다.
 *    없는 job은 'notfound', lease 만료 후에는 다시 claim할 수 있다.
 * 2) 같은 base에서 출발한 두 modify job은 서로 다른 버전 번호(v2, v3)를
 *    얻고, 두 결과물이 모두 보존된다 (lost update 없음).
 * 3) B5 분기: 두 번째 job이 첫 번째 job의 변경과 충돌하면 conflicts에
 *    기록되고 version.branch 이벤트가 남으며, 이전 버전의 파일은 그대로다.
 * 4) 안전망: 같은 (artifact_id, version_no) INSERT는 UNIQUE 제약이
 *    거부한다 — 경합이 조용한 중복 번호로 이어지지 않고 크게 실패한다.
 */
const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')

const JP_TS = path.join(__dirname, '../src/modules/artifact/job-processor.ts')
const JP_JS = '/tmp/artifact-job-processor-gate43-test.cjs'
try {
  execSync(`npx esbuild ${JP_TS} --bundle --platform=node --format=cjs --outfile=${JP_JS}`, { stdio: 'pipe' })
} catch (e) {
  console.error('TypeScript 컴파일 실패:', e.message)
}
const { claimJob, saveJobResult } = require(JP_JS)

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

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

// v1 + index.html 파일을 가진 아티팩트
function seedArtifact(db, html = '<html>v1</html>') {
  const artId = db.prepare(
    `INSERT INTO artifacts (title, type, status, description, row_revision, owner_email, html_content)
     VALUES ('T', 'html', 'draft', '', 1, ?, '<html/>')`
  ).run(OWNER).lastInsertRowid
  const v1 = db.prepare(
    `INSERT INTO artifact_versions (artifact_id, version_no, html_content, content_sha256)
     VALUES (?, 1, ?, ?)`
  ).run(artId, html, sha256(html)).lastInsertRowid
  db.prepare(`UPDATE artifacts SET draft_version_id=?, published_version_id=? WHERE id=?`).run(v1, v1, artId)
  db.prepare(
    `INSERT INTO artifact_files (version_id, file_path, content, content_sha256, file_size)
     VALUES (?, 'index.html', ?, ?, ?)`
  ).run(v1, html, sha256(html), Buffer.byteLength(html))
  return { artId, v1, html }
}

function seedModifyJob(db, artId, baseVersionId, baseHtml) {
  return db.prepare(
    `INSERT INTO artifact_jobs (kind, artifact_id, prompt, status, owner_email, base_version_id, base_snapshot)
     VALUES ('modify', ?, 'modify prompt', 'running', ?, ?, ?)`
  ).run(artId, OWNER, baseVersionId, JSON.stringify({ 'index.html': sha256(baseHtml) })).lastInsertRowid
}

function saveFile(db, versionId, filePath, content) {
  db.prepare(
    `INSERT INTO artifact_files (version_id, file_path, content, content_sha256, file_size)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (version_id, file_path) DO UPDATE SET content=excluded.content, content_sha256=excluded.content_sha256, file_size=excluded.file_size`
  ).run(versionId, filePath, content, sha256(content), Buffer.byteLength(content))
}

describe('관문 43: 동시 수정 (실제 SQLite + 실제 job-processor)', () => {
  test('Lease claim: 두 번째 claim은 busy, 없는 job은 notfound, 만료 후 재claim 가능', async () => {
    const { db, d1 } = freshDb()
    try {
      const env = { DB: d1 }
      const jobId = db.prepare(
        `INSERT INTO artifact_jobs (kind, artifact_id, prompt, status, owner_email)
         VALUES ('create', NULL, 'p', 'pending', ?)`
      ).run(OWNER).lastInsertRowid

      const first = await claimJob(env, jobId)
      expect(first.status).toBe('claimed')
      expect(first.leaseToken).toBeTruthy()
      expect(db.prepare('SELECT status, lease_token FROM artifact_jobs WHERE id=?').get(jobId).status).toBe('running')

      const second = await claimJob(env, jobId)
      expect(second.status).toBe('busy')
      // lease를 빼앗기지 않음 (여전히 첫 번째 토큰)
      expect(db.prepare('SELECT lease_token FROM artifact_jobs WHERE id=?').get(jobId).lease_token).toBe(first.leaseToken)

      expect((await claimJob(env, 99999)).status).toBe('notfound')

      // lease 만료시키면 다시 claim 가능
      db.prepare(`UPDATE artifact_jobs SET lease_expires = CAST(unixepoch('now') - 10 AS TEXT) WHERE id=?`).run(jobId)
      const third = await claimJob(env, jobId)
      expect(third.status).toBe('claimed')
      expect(third.leaseToken).not.toBe(first.leaseToken)
    } finally {
      db.close()
    }
  })

  test('같은 base의 두 modify job → v2·v3이 모두 보존되고 두 번째는 분기로 기록된다', async () => {
    const { db, d1 } = freshDb()
    try {
      const env = { DB: d1 }
      const { artId, v1, html } = seedArtifact(db)
      // 두 job 모두 v1 스냅샷 기준으로 시작 (동시 수정 재현)
      const job1 = seedModifyJob(db, artId, v1, html)
      const job2 = seedModifyJob(db, artId, v1, html)

      const r1 = await saveJobResult(env, job1, '<html>job1</html>', 't', 'modify', 'p1', artId, {
        agentFiles: { 'index.html': '<html>job1</html>' },
      })
      expect(r1.versionCreated).toBe(true)
      expect(r1.conflicts).toEqual([])
      expect(r1.branched).toBe(false)
      // v2 파일 실체화 (실제 processArtifactJob이 saveWorkspaceToD1으로 하는 일)
      const v2id = db.prepare('SELECT id FROM artifact_versions WHERE artifact_id=? AND version_no=2').get(artId).id
      saveFile(db, v2id, 'index.html', '<html>job1</html>')

      const r2 = await saveJobResult(env, job2, '<html>job2</html>', 't', 'modify', 'p2', artId, {
        agentFiles: { 'index.html': '<html>job2</html>' },
      })
      expect(r2.versionCreated).toBe(true)
      // job1의 변경과 충돌 → 분기로 명시 기록
      expect(r2.conflicts).toEqual(['index.html'])
      expect(r2.branched).toBe(true)

      // 두 버전이 모두 보존되고 번호가 다르다
      const versions = db.prepare(
        'SELECT version_no AS no, parent_version_id AS parent FROM artifact_versions WHERE artifact_id=? ORDER BY version_no'
      ).all(artId)
      expect(versions.map((v) => v.no)).toEqual([1, 2, 3])
      // 두 modify 버전 모두 base(v1)를 parent로 가리킨다 (분기)
      expect(versions[1].parent).toBe(v1)
      expect(versions[2].parent).toBe(v1)
      // v2의 파일(첫 번째 결과물)은 그대로 보존된다
      expect(db.prepare('SELECT content FROM artifact_files WHERE version_id=? AND file_path=?').get(v2id, 'index.html').content).toBe('<html>job1</html>')
      // 분기 이벤트가 구조화되어 남는다
      const branch = db.prepare(
        `SELECT payload FROM artifact_job_events WHERE job_id=? AND event_type='version.branch'`
      ).get(job2)
      expect(branch).toBeTruthy()
      expect(JSON.parse(branch.payload).conflicts).toEqual(['index.html'])
      // draft는 최신(v3)을 가리킨다
      expect(db.prepare('SELECT draft_version_id AS d FROM artifacts WHERE id=?').get(artId).d).toBe(
        db.prepare('SELECT id FROM artifact_versions WHERE artifact_id=? AND version_no=3').get(artId).id
      )
    } finally {
      db.close()
    }
  })

  test('안전망: 같은 버전 번호 INSERT는 UNIQUE 제약이 거부한다', async () => {
    const { db } = freshDb()
    try {
      const { artId } = seedArtifact(db)
      expect(() =>
        db.prepare(
          `INSERT INTO artifact_versions (artifact_id, version_no, html_content, content_sha256)
           VALUES (?, 1, '<html/>', 'x')`
        ).run(artId)
      ).toThrow(/UNIQUE constraint failed/)
      // 기존 v1은 그대로다
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id=?').get(artId).n).toBe(1)
    } finally {
      db.close()
    }
  })
})
