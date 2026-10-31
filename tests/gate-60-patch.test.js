/**
 * 관문 테스트 60: PATCH 소유권 — 실제 DB·실제 HTTP 검증
 *
 * 성질: PATCH /:id 는 소유자만 메타데이터를 바꿀 수 있다.
 * 남이 호출하면 DB가 바뀌지 않는다 (404 + 원본 유지).
 *
 * 과거 결함(주석): PATCH /:id에 소유권 확인이 없었다.
 * 코드 확인(2026-10-27): routes.ts PATCH는
 * `UPDATE artifacts SET ... WHERE id = ? AND owner_email = ?` 로 소유권을 확인한다.
 *
 * 실행: npx jest tests/gate-60-patch.test.js
 */
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Hono } = require('hono');

const ROOT = path.join(__dirname, '..');
const BUNDLE = '/tmp/artifact-routes-gate-60-test.cjs';
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

function seedArtifact(db, { owner = ALICE, status = 'draft', title = '원본 제목' } = {}) {
  const info = db.prepare(
    `INSERT INTO artifacts (title, type, status, description, row_revision, html_content, owner_email) VALUES (?, 'html', ?, '', 1, '<p>seed</p>', ?)`,
  ).run(title, status, owner);
  return Number(info.lastInsertRowid);
}

function cleanDb(db) {
  for (const t of ['artifact_job_events', 'job_provider_attempts', 'artifact_files', 'artifact_versions', 'artifact_chats', 'artifact_jobs', 'artifacts']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
}

describe('관문 60: PATCH 소유권 (실제 DB + 실제 HTTP)', () => {
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

  test('소유자는 제목·설명을 바꿀 수 있고 DB에 반영된다', async () => {
    const id = seedArtifact(db, { owner: ALICE });
    const r = await req(ALICE, `/${id}`, 'PATCH', { title: '새 제목', description: '새 설명' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const row = db.prepare('SELECT title, description FROM artifacts WHERE id=?').get(id);
    expect(row.title).toBe('새 제목');
    expect(row.description).toBe('새 설명');
  });

  test('남이 PATCH하면 404이고 제목·설명이 그대로다', async () => {
    const id = seedArtifact(db, { owner: ALICE });
    const r = await req(BOB, `/${id}`, 'PATCH', { title: '탈취 제목', description: '탈취' });
    expect(r.status).toBe(404);
    const row = db.prepare('SELECT title, description FROM artifacts WHERE id=?').get(id);
    expect(row.title).toBe('원본 제목');
    expect(row.description).toBe('');
  });

  test('없는 아티팩트 PATCH는 404이다', async () => {
    expect((await req(ALICE, '/9999', 'PATCH', { title: 'x' })).status).toBe(404);
  });

  test('수정 항목 없음·제목 길이 초과는 400이고 DB가 안 바뀐다', async () => {
    const id = seedArtifact(db, { owner: ALICE });
    expect((await req(ALICE, `/${id}`, 'PATCH', {})).status).toBe(400);
    expect((await req(ALICE, `/${id}`, 'PATCH', { title: 'x'.repeat(201) })).status).toBe(400);
    expect(db.prepare('SELECT title FROM artifacts WHERE id=?').get(id).title).toBe('원본 제목');
  });
});
