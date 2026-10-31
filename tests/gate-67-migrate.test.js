/**
 * 관문 테스트 67: 채팅 마이그레이션 보안 — 실제 DB·실제 HTTP 검증
 *
 * 성질: POST /chats/migrate 는 이관 대상 아티팩트(to_artifact_id)의
 * 소유자만 호출할 수 있다. 남이 호출하면 채팅이 이동하지 않는다.
 *
 * 과거 결함(주석): 이관에 소유권 확인이 없었다.
 * 코드 확인(2026-10-27): routes.ts는 to_artifact_id의
 * `WHERE id = ? AND owner_email = ?` 확인 후 403을 반환한다.
 *
 * 잔존 한계(미수정·보고용): 출발 세션(from_session) 자체의 소유권은
 * 확인하지 않는다. p{id} 형태 키는 GET /chats에서 막히지만,
 * 임의 키('new' 등)의 채팅은 키를 아는 사람이 자기 아티팩트로
 * 가져갈 수 있다. 고아 세션의 소유자 개념이 없어 정책 결정이 필요하다.
 *
 * 실행: npx jest tests/gate-67-migrate.test.js
 */
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Hono } = require('hono');

const ROOT = path.join(__dirname, '..');
const BUNDLE = '/tmp/artifact-routes-gate-67-test.cjs';
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

function seedChat(db, { artifactId = null, sessionKey = 'new', who = 'user', content = '안녕' } = {}) {
  db.prepare(`INSERT INTO artifact_chats (artifact_id, session_key, who, content) VALUES (?, ?, ?, ?)`).run(artifactId, sessionKey, who, content);
}

function cleanDb(db) {
  for (const t of ['artifact_job_events', 'job_provider_attempts', 'artifact_files', 'artifact_versions', 'artifact_chats', 'artifact_jobs', 'artifacts']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
}

describe('관문 67: 채팅 마이그레이션 보안 (실제 DB + 실제 HTTP)', () => {
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

  test('소유자는 고아 세션 채팅을 자기 아티팩트로 이관할 수 있다', async () => {
    const id = seedArtifact(db, { owner: ALICE });
    seedChat(db, { artifactId: null, sessionKey: 'old-session', who: 'user', content: '이전 대화' });
    seedChat(db, { artifactId: null, sessionKey: 'old-session', who: 'nova', content: '이전 답' });
    const r = await req(ALICE, '/chats/migrate', 'POST', { from_session: 'old-session', to_artifact_id: id });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const moved = db.prepare(`SELECT artifact_id, session_key FROM artifact_chats WHERE session_key=?`).all('p' + id);
    expect(moved).toHaveLength(2);
    expect(moved.every((m) => m.artifact_id === id)).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM artifact_chats WHERE session_key='old-session'`).get().n).toBe(0);
  });

  test('남의 아티팩트로 이관하면 403이고 채팅이 이동하지 않는다', async () => {
    const aliceId = seedArtifact(db, { owner: ALICE });
    seedChat(db, { artifactId: null, sessionKey: 'old-session', who: 'user', content: '이전 대화' });
    const r = await req(BOB, '/chats/migrate', 'POST', { from_session: 'old-session', to_artifact_id: aliceId });
    expect(r.status).toBe(403);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM artifact_chats WHERE session_key='old-session'`).get().n).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM artifact_chats WHERE artifact_id=?`).get(aliceId).n).toBe(0);
  });

  test('필수 파라미터가 없으면 400이다', async () => {
    const id = seedArtifact(db, { owner: ALICE });
    expect((await req(ALICE, '/chats/migrate', 'POST', { to_artifact_id: id })).status).toBe(400);
    expect((await req(ALICE, '/chats/migrate', 'POST', { from_session: 'x' })).status).toBe(400);
  });
});
