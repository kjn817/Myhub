/**
 * 관문 테스트 65: 이벤트 조회 보안 — 실제 DB·실제 HTTP 검증
 *
 * 성질: GET /jobs/:id/events 는 job 소유자만 볼 수 있다.
 * 남이 조회하면 이벤트 내용이 노출되지 않는다.
 *
 * 과거 결함(주석): 이벤트 조회에 소유권 확인이 없었다.
 * 코드 확인(2026-10-27): routes.ts는 artifact_jobs에서
 * `WHERE id = ? AND owner_email = ?` 확인 후 403을 반환한다.
 *
 * 실행: npx jest tests/gate-65-events.test.js
 */
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Hono } = require('hono');

const ROOT = path.join(__dirname, '..');
const BUNDLE = '/tmp/artifact-routes-gate-65-test.cjs';
try {
  execSync(
    `npx esbuild ${path.join(ROOT, 'src/modules/artifact/routes.ts')} --bundle --platform=node --format=cjs --outfile=${BUNDLE}`,
    { stdio: 'pipe' },
  );
} catch (e) {
  throw new Error('artifact routes 컴파일 실패: ' + (e.stderr?.toString() || e.message));
}
const { artifactApp } = require(BUNDLE);

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

function createD1(db) {
  const prepare = (sql) => {
    const stmt = db.prepare(sql);
    return {
      _sql: sql,
      _params: [],
      bind(...p) { this._params = p; return this; },
      async first() { return stmt.get(...this._params) || null; },
      async all() { return { results: stmt.all(...this._params) }; },
      async run() {
        const info = stmt.run(...this._params);
        return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
      },
    };
  };
  return {
    prepare,
    async batch(statements) {
      const results = [];
      const txn = db.transaction(() => {
        for (const s of statements) {
          const info = db.prepare(s._sql).run(...(s._params || []));
          results.push({ meta: { changes: info.changes, last_row_id: info.lastInsertRowid } });
        }
      });
      txn();
      return results;
    },
  };
}

const MIGRATIONS = ['0032_artifacts.sql', '0033_artifact_status.sql', '0034_artifact_versions.sql',
  '0035_artifact_files.sql', '0035_artifact_jobs.sql', '0036_artifact_chats.sql',
  '0037_job_provider_attempts.sql', '0038_artifact_job_events.sql', '0039_artifact_jobs_indexes.sql', '0058_artifacts_owner_email.sql'];

function seedJob(db, { owner = ALICE, artifactId = null, status = 'running' } = {}) {
  const info = db.prepare(
    `INSERT INTO artifact_jobs (kind, artifact_id, prompt, status, owner_email) VALUES ('create', ?, 'prompt', ?, ?)`,
  ).run(artifactId, status, owner);
  return Number(info.lastInsertRowid);
}

function seedEvent(db, jobId, eventType, payload = '{}') {
  const info = db.prepare(`INSERT INTO artifact_job_events (job_id, event_type, payload) VALUES (?, ?, ?)`).run(jobId, eventType, payload);
  return Number(info.lastInsertRowid);
}

function cleanDb(db) {
  for (const t of ['artifact_job_events', 'job_provider_attempts', 'artifact_files', 'artifact_versions', 'artifact_chats', 'artifact_jobs', 'artifacts']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
}

describe('관문 65: 이벤트 조회 보안 (실제 DB + 실제 HTTP)', () => {
  let db;
  let d1;
  let app;
  let env;
  let req;

  beforeAll(() => {
    db = new Database(':memory:');
    d1 = createD1(db);
    for (const m of MIGRATIONS) db.exec(fs.readFileSync(path.join(ROOT, 'migrations', m), 'utf8'));
    app = new Hono();
    app.use('*', async (c, next) => {
      const u = c.req.header('x-test-user');
      if (u) c.set('userEmail', u);
      await next();
    });
    app.route('/a', artifactApp);
    env = { DB: d1, ARTIFACT_QUEUE: { send: async () => {} } };
    req = async (user, p, method = 'GET', body) => {
      const res = await app.request('/a' + (p === '/' ? '' : p), {
        method,
        headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }, env);
      let j = null;
      try { j = await res.json(); } catch { /* not json */ }
      return { status: res.status, body: j };
    };
  });

  afterAll(() => { db.close(); });
  beforeEach(() => cleanDb(db));

  test('소유자는 job 이벤트를 시간순으로 볼 수 있다', async () => {
    const jobId = seedJob(db, { owner: ALICE });
    seedEvent(db, jobId, 'job.started', '{"msg":"시작"}');
    seedEvent(db, jobId, 'file.changed', '{"file_path":"index.html"}');
    const r = await req(ALICE, `/jobs/${jobId}/events`);
    expect(r.status).toBe(200);
    expect(r.body.data.map((e) => e.event_type)).toEqual(['job.started', 'file.changed']);
    expect(r.body.data[1].payload).toContain('index.html');
  });

  test('남이 조회하면 403이고 이벤트 내용이 안 나온다', async () => {
    const jobId = seedJob(db, { owner: ALICE });
    seedEvent(db, jobId, 'file.changed', '{"file_path":"secret.html"}');
    const r = await req(BOB, `/jobs/${jobId}/events`);
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain('secret.html');
  });

  test('없는 job 조회도 403이다 (존재 여부 노출 방지)', async () => {
    expect((await req(ALICE, '/jobs/9999/events')).status).toBe(403);
  });

  test('since 파라미터로 그 이후 이벤트만 받는다', async () => {
    const jobId = seedJob(db, { owner: ALICE });
    const e1 = seedEvent(db, jobId, 'job.started');
    seedEvent(db, jobId, 'job.completed');
    const r = await req(ALICE, `/jobs/${jobId}/events?since=${e1}`);
    expect(r.status).toBe(200);
    expect(r.body.data.map((e) => e.event_type)).toEqual(['job.completed']);
  });
});
