/**
 * 관문 테스트 62: 파일 목록 소유권 — 실제 DB·실제 HTTP 검증
 *
 * 성질: GET /:id/versions/:versionNo/files 는 draft 버전의 파일을
 * 소유자만 볼 수 있고, published는 누구나 볼 수 있다.
 *
 * 과거 결함(주석): 파일 목록에 소유권 확인이 없었다.
 * 코드 확인(2026-10-27): routes.ts는 `owner_email = ? OR status = 'published'`
 * 확인 후 403을 반환한다.
 *
 * 실행: npx jest tests/gate-62-files.test.js
 */
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Hono } = require('hono');

const ROOT = path.join(__dirname, '..');
const BUNDLE = '/tmp/artifact-routes-gate-62-test.cjs';
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

function seedVersion(db, artifactId, versionNo, html = '<p>v</p>') {
  const info = db.prepare(
    `INSERT INTO artifact_versions (artifact_id, version_no, html_content, content_sha256, change_note, source_type) VALUES (?, ?, ?, 'hash', '', 'manual')`,
  ).run(artifactId, versionNo, html);
  return Number(info.lastInsertRowid);
}

function seedFile(db, versionId, filePath, content) {
  db.prepare(`INSERT INTO artifact_files (version_id, file_path, content, content_sha256, file_size) VALUES (?, ?, ?, 'h', ?)`).run(versionId, filePath, content, content.length);
}

function cleanDb(db) {
  for (const t of ['artifact_job_events', 'job_provider_attempts', 'artifact_files', 'artifact_versions', 'artifact_chats', 'artifact_jobs', 'artifacts']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
}

describe('관문 62: 파일 목록 소유권 (실제 DB + 실제 HTTP)', () => {
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

  test('소유자는 draft 버전의 파일 목록·내용을 볼 수 있다', async () => {
    const id = seedArtifact(db, { owner: ALICE });
    const v1 = seedVersion(db, id, 1);
    seedFile(db, v1, 'index.html', '<p>비밀</p>');
    seedFile(db, v1, 'style.css', 'body{}');
    const r = await req(ALICE, `/${id}/versions/1/files`);
    expect(r.status).toBe(200);
    expect(r.body.data.map((f) => f.file_path)).toEqual(['index.html', 'style.css']);
    expect(r.body.data.find((f) => f.file_path === 'index.html').content).toBe('<p>비밀</p>');
  });

  test('남은 draft 버전 파일을 보면 403이고 내용은 안 나온다', async () => {
    const id = seedArtifact(db, { owner: ALICE });
    const v1 = seedVersion(db, id, 1);
    seedFile(db, v1, 'index.html', '<p>비밀</p>');
    const r = await req(BOB, `/${id}/versions/1/files`);
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain('비밀');
  });

  test('published 버전 파일은 누구나 볼 수 있다', async () => {
    const id = seedArtifact(db, { owner: ALICE, status: 'published' });
    const v1 = seedVersion(db, id, 1);
    seedFile(db, v1, 'index.html', '<p>공개</p>');
    const r = await req(BOB, `/${id}/versions/1/files`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
  });

  test('없는 버전은 소유자에게 404, 남에게 403이다', async () => {
    const id = seedArtifact(db, { owner: ALICE });
    seedVersion(db, id, 1);
    expect((await req(ALICE, `/${id}/versions/99/files`)).status).toBe(404);
    expect((await req(BOB, `/${id}/versions/99/files`)).status).toBe(403);
  });
});
