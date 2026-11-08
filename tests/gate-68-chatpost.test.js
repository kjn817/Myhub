/**
 * 관문 테스트 68: 채팅 생성 보안 — 실제 DB·실제 HTTP 검증
 *
 * 성질: POST /chats 는 artifact_id가 있으면 그 아티팩트 소유자만
 * 메시지를 저장할 수 있다. 남이 저장하면 행이 생기지 않는다.
 * artifact_id가 없으면(고아 세션) 저장한다.
 *
 * 과거 결함(주석): 채팅 생성에 artifact_id 소유권 확인이 없었다.
 * 코드 확인(2026-10-27): routes.ts는 artifact_id가 있을 때
 * `WHERE id = ? AND owner_email = ?` 확인 후 403을 반환한다.
 *
 * 실행: npx jest tests/gate-68-chatpost.test.js
 */
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Hono } = require('hono');

const ROOT = path.join(__dirname, '..');
const BUNDLE = '/tmp/artifact-routes-gate-68-test.cjs';
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

function chatCount(db, artifactId) {
  return db.prepare('SELECT COUNT(*) AS n FROM artifact_chats WHERE artifact_id IS ?').get(artifactId).n;
}

function cleanDb(db) {
  for (const t of ['artifact_job_events', 'job_provider_attempts', 'artifact_files', 'artifact_versions', 'artifact_chats', 'artifact_jobs', 'artifacts']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
}

describe('관문 68: 채팅 생성 보안 (실제 DB + 실제 HTTP)', () => {
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

  test('소유자는 자기 아티팩트에 채팅을 저장할 수 있다', async () => {
    const id = seedArtifact(db, { owner: ALICE });
    const r = await req(ALICE, '/chats', 'POST', { artifact_id: id, session_key: 'p' + id, who: 'user', content: '안녕 노바' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(chatCount(db, id)).toBe(1);
    expect(db.prepare('SELECT who, content FROM artifact_chats WHERE artifact_id=?').get(id).content).toBe('안녕 노바');
  });

  test('남이 저장하면 403이고 행이 생기지 않는다', async () => {
    const id = seedArtifact(db, { owner: ALICE });
    const r = await req(BOB, '/chats', 'POST', { artifact_id: id, session_key: 'p' + id, who: 'user', content: '침입 메시지' });
    expect(r.status).toBe(403);
    expect(chatCount(db, id)).toBe(0);
  });

  test('artifact_id가 없으면(고아 세션) 저장한다', async () => {
    const r = await req(BOB, '/chats', 'POST', { session_key: 'new', who: 'user', content: '새 대화' });
    expect(r.status).toBe(200);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM artifact_chats WHERE session_key='new'`).get().n).toBe(1);
  });

  test('who/content가 없으면 400이고 10초 내 동일 메시지는 중복 저장 안 한다', async () => {
    const id = seedArtifact(db, { owner: ALICE });
    expect((await req(ALICE, '/chats', 'POST', { artifact_id: id, who: 'user' })).status).toBe(400);
    const body = { artifact_id: id, session_key: 'p' + id, who: 'user', content: '중복?' };
    const first = await req(ALICE, '/chats', 'POST', body);
    expect(first.body.deduped).toBeUndefined();
    const second = await req(ALICE, '/chats', 'POST', body);
    expect(second.body.deduped).toBe(true);
    expect(chatCount(db, id)).toBe(1);
  });
});
