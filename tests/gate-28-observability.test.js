/**
 * 관문 테스트 28: 도구 호출 관측성 — 실제 SQLite + 실제 코드 검증.
 *
 * 2026-10-27 전면 재작성: 이전 버전은 expect(true).toBe(true) 연극이었다.
 * 코드 확인 결과, 헤더의 전제는 부분적으로 바뀌어 있다.
 * - summary 문자열에 "[도구호출: ...]"이 섞이던 옛 형태는 사라졌다
 *   (summary는 lastText만 자른 것이다).
 * - '[도구호출:' 문자열 자체는 실패 시 error 진단 문자열에만 1곳 남는다.
 * - 구조화 기록은 이미 있다: runStudioAgent가 toolCalls를 구조화 반환하고,
 *   job-processor.ts가 'agent.tool_calls' 이벤트를 artifact_job_events에
 *   구조화 JSON으로 기록한다 (logJobEvent).
 *
 * 검증하는 성질:
 * 1) logJobEvent가 'agent.tool_calls' 이벤트를 구조화 JSON payload로 저장한다.
 * 2) GET /jobs/:id/events가 그 이벤트를 구조화 그대로 반환한다
 *    (summary 문자열 파싱이 필요 없다).
 * 3) 이벤트 로깅 실패는 job 처리를 깨뜨리지 않는다 (logJobEvent가 삼킨다).
 */
const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { Hono } = require('hono')

const ROUTES_TS = path.join(__dirname, '../src/modules/artifact/routes.ts')
const ROUTES_JS = '/tmp/artifact-routes-gate28-test.cjs'
const JP_TS = path.join(__dirname, '../src/modules/artifact/job-processor.ts')
const JP_JS = '/tmp/artifact-job-processor-gate28-test.cjs'
try {
  execSync(`npx esbuild ${ROUTES_TS} --bundle --platform=node --format=cjs --outfile=${ROUTES_JS}`, { stdio: 'pipe' })
  execSync(`npx esbuild ${JP_TS} --bundle --platform=node --format=cjs --outfile=${JP_JS}`, { stdio: 'pipe' })
} catch (e) {
  console.error('TypeScript 컴파일 실패:', e.message)
}
const { artifactApp } = require(ROUTES_JS)
const { logJobEvent } = require(JP_JS)

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

describe('관문 28: 도구 호출 관측성 (실제 SQLite + 실제 코드)', () => {
  test("logJobEvent가 'agent.tool_calls'를 구조화 JSON으로 저장한다", async () => {
    const { db, d1 } = freshDb()
    try {
      const env = { DB: d1 }
      const jobId = db.prepare(
        `INSERT INTO artifact_jobs (kind, artifact_id, prompt, status, owner_email)
         VALUES ('create', NULL, 'p', 'running', ?)`
      ).run(OWNER).lastInsertRowid

      await logJobEvent(env, jobId, 'agent.tool_calls', {
        calls: ['create_file:index.html', 'read_file:style.css'],
      })
      await logJobEvent(env, jobId, 'file.changed', { file_path: 'index.html' })

      const rows = db.prepare(
        'SELECT event_type AS t, payload FROM artifact_job_events WHERE job_id=? ORDER BY id'
      ).all(jobId)
      expect(rows).toHaveLength(2)
      expect(rows[0].t).toBe('agent.tool_calls')
      // payload는 JSON 문자열로 구조화되어 있어 파싱 없이 조회·분석 가능하다
      expect(JSON.parse(rows[0].payload)).toEqual({
        calls: ['create_file:index.html', 'read_file:style.css'],
      })
      expect(JSON.parse(rows[1].payload)).toEqual({ file_path: 'index.html' })
    } finally {
      db.close()
    }
  })

  test('GET /jobs/:id/events가 구조화 이벤트를 그대로 반환한다', async () => {
    const { db, d1 } = freshDb()
    try {
      const { app, env } = makeApp(d1)
      const jobId = db.prepare(
        `INSERT INTO artifact_jobs (kind, artifact_id, prompt, status, owner_email)
         VALUES ('create', NULL, 'p', 'running', ?)`
      ).run(OWNER).lastInsertRowid
      await logJobEvent({ DB: d1 }, jobId, 'agent.tool_calls', { calls: ['create_file:index.html'] })

      const res = await app.request(`/a/jobs/${jobId}/events?since=0`, {}, env)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.data).toHaveLength(1)
      expect(body.data[0].event_type).toBe('agent.tool_calls')
      expect(JSON.parse(body.data[0].payload)).toEqual({ calls: ['create_file:index.html'] })
    } finally {
      db.close()
    }
  })

  test('도구 호출 히스토리는 구조화 반환되고, "[도구호출:"은 실패 진단에만 남는다', () => {
    const agentSrc = fs.readFileSync(path.join(__dirname, '../src/services/studio-agent.ts'), 'utf8')
    // 구조화 반환: toolCalls 배열
    expect(agentSrc).toContain('toolCalls: toolCallHistory')
    // summary에는 히스토리가 섞이지 않는다 (모델 텍스트만 자름)
    expect(agentSrc).toMatch(/summary: lastText\.slice\(0, 500\)/)
    // '[도구호출:'은 실패 시 error 진단 문자열에만 1곳 존재한다
    expect(agentSrc.split('[도구호출:').length - 1).toBe(1)
    expect(agentSrc).toMatch(/historyStr = .*\[도구호출:/)
    // 구조화 이벤트 기록은 job-processor에 있다
    const jpSrc = fs.readFileSync(path.join(__dirname, '../src/modules/artifact/job-processor.ts'), 'utf8')
    expect(jpSrc).toContain("logJobEvent(env, jobId, 'agent.tool_calls'")
  })

  test('이벤트 로깅 실패(없는 job)는 throw하지 않는다', async () => {
    const { db, d1 } = freshDb()
    try {
      // FK 강제 하에서 없는 job_id로 INSERT하면 실패하지만, logJobEvent는 삼켜야 한다
      await expect(
        logJobEvent({ DB: d1 }, 99999, 'agent.tool_calls', { calls: ['x'] })
      ).resolves.toBeUndefined()
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_job_events').get().n).toBe(0)
    } finally {
      db.close()
    }
  })
})
