/**
 * 관문 테스트 66: Job 목록 보안 — 실제 DB·실제 HTTP 검증
 *
 * 성질: GET /jobs 는 자기 job만 반환한다. 남의 job은 목록에 안 나오고,
 * 확인한 done/failed(seen=1) job도 목록에서 빠진다.
 *
 * 코드 확인(2026-10-27): routes.ts는
 * `WHERE j.owner_email = ? AND (status IN ('pending','running')
 *  OR (status IN ('done','failed') AND seen = 0))` 로 필터링한다.
 *
 * 실행: npx jest tests/gate-66-jobs.test.js
 */
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Hono } = require('hono');

const ROOT = path.join(__dirname, '..');
const BUNDLE = '/tmp/artifact-routes-gate-66-test.cjs';
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

function seedArtifact(db, { owner = ALICE, status = 'draft', title = '제목' } = {}) {
  const info = db.prepare(
    `INSERT INTO artifacts (title, type, status, description, row_revision, html_content, owner_email) VALUES (?, 'html', ?, '', 1, '<p>seed</p>', ?)`,
  ).run(title, status, owner);
  return Number(info.lastInsertRowid);
}

function seedJob(db, { owner = ALICE, artifactId = null, status = 'pending', seen = 0, prompt = 'prompt' } = {}) {
  const info = db.prepare(
    `INSERT INTO artifact_jobs (kind, artifact_id, prompt, status, owner_email, seen) VALUES ('create', ?, ?, ?, ?, ?)`,
  ).run(artifactId, prompt, status, owner, seen);
  return Number(info.lastInsertRowid);
}

function cleanDb(db) {
  for (const t of ['artifact_job_events', 'job_provider_attempts', 'artifact_files', 'artifact_versions', 'artifact_chats', 'artifact_jobs', 'artifacts']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
}

describe('관문 66: Job 목록 보안 (실제 DB + 실제 HTTP)', () => {
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

  test('목록에는 자기 job만 나오고 남의 job은 안 나온다', async () => {
    const alicePending = seedJob(db, { owner: ALICE, status: 'pending', prompt: '앨리스 진행' });
    const aliceRunning = seedJob(db, { owner: ALICE, status: 'running', prompt: '앨리스 실행' });
    seedJob(db, { owner: BOB, status: 'pending', prompt: '밥 진행' });
    const r = await req(ALICE, '/jobs');
    expect(r.status).toBe(200);
    const ids = r.body.data.map((j) => j.id);
    expect(ids).toContain(alicePending);
    expect(ids).toContain(aliceRunning);
    expect(r.body.data.map((j) => j.prompt)).not.toContain('밥 진행');
    expect(r.body.data.every((j) => j.owner_email === ALICE)).toBe(true);
  });

  test('확인한 done/failed(seen=1)는 목록에서 빠지고 미확인(seen=0)은 남는다', async () => {
    const unseenDone = seedJob(db, { owner: ALICE, status: 'done', seen: 0 });
    seedJob(db, { owner: ALICE, status: 'done', seen: 1 });
    seedJob(db, { owner: ALICE, status: 'failed', seen: 1 });
    const unseenFailed = seedJob(db, { owner: ALICE, status: 'failed', seen: 0 });
    const r = await req(ALICE, '/jobs');
    const ids = r.body.data.map((j) => j.id);
    expect(ids).toContain(unseenDone);
    expect(ids).toContain(unseenFailed);
    expect(ids).toHaveLength(2);
  });

  test('POST /jobs 새 대화: 아티팩트가 소유자와 함께 생기고 job과 연결된다', async () => {
    const r = await req(ALICE, '/jobs', 'POST', { kind: 'create', prompt: '계산기 만들어줘' });
    expect(r.status).toBe(202);
    expect(r.body.ok).toBe(true);
    const job = db.prepare('SELECT artifact_id, owner_email FROM artifact_jobs WHERE id=?').get(r.body.data.jobId);
    expect(job.owner_email).toBe(ALICE);
    const art = db.prepare('SELECT title, owner_email FROM artifacts WHERE id=?').get(job.artifact_id);
    expect(art.owner_email).toBe(ALICE);
    // 생성자는 자기 아티팩트 상세를 읽을 수 있다 (소유권 왕복)
    expect((await req(ALICE, `/${job.artifact_id}`)).status).toBe(200);
    expect((await req(BOB, `/${job.artifact_id}`)).status).toBe(404);
  });

  test('GET /jobs/:id: 남의 job은 404이다', async () => {
    const bobJob = seedJob(db, { owner: BOB, status: 'pending' });
    expect((await req(ALICE, `/jobs/${bobJob}`)).status).toBe(404);
    const aliceJob = seedJob(db, { owner: ALICE, status: 'pending' });
    const r = await req(ALICE, `/jobs/${aliceJob}`);
    expect(r.status).toBe(200);
    expect(r.body.data.id).toBe(aliceJob);
  });
});
