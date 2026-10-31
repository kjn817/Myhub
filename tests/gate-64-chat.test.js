/**
 * 관문 테스트 64: 채팅 조회 보안 — 실제 DB·실제 HTTP 검증
 *
 * 성질: GET /chats 는 session_key='p{artifactId}' 추측만으로 남의 채팅을
 * 읽을 수 없다. artifact_id든 session_key든, 가리키는 아티팩트가 draft면
 * 소유자만 읽고 published면 누구나 읽는다.
 *
 * 과거 결함(주석): GET /chats에 소유권 확인이 없었다.
 * 코드 확인(2026-10-27): routes.ts는 artifact_id와 p-접두사 session_key에서
 * 아티팩트 ID를 추출해 `owner_email = ? OR status = 'published'` 확인을 한다.
 *
 * 다시 쓰면서 발견해 함께 고친 결함 (routes.ts):
 * - 필터(session_key/artifact_id) 없이 호출하면 WHERE 1=1 그대로라
 *   전체 채팅 100건이 그대로 노출됐다 → 둘 다 없으면 400을 반환한다.
 *   (프론트는 항상 session_key를 넘긴다 — agent.html restoreChat)
 * - 이 파일의 "추측한 p{id} 키로 남의 채팅 조회 → 403" 테스트가
 *   관문 71(세션 키 예측 가능성)의 성질을 그대로 검증한다.
 *   관문 71 파일은 삭제하고 여기서 cover한다.
 *
 * 실행: npx jest tests/gate-64-chat.test.js
 */
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Hono } = require('hono');

const ROOT = path.join(__dirname, '..');
const BUNDLE = '/tmp/artifact-routes-gate-64-test.cjs';
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

describe('관문 64: 채팅 조회 보안 (실제 DB + 실제 HTTP)', () => {
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

  test('artifact_id로 조회: draft는 소유자만, 남은 403', async () => {
    const id = seedArtifact(db, { owner: ALICE });
    seedChat(db, { artifactId: id, sessionKey: 'p' + id, who: 'user', content: '앨리스 비밀' });
    seedChat(db, { artifactId: id, sessionKey: 'p' + id, who: 'nova', content: '노바 답' });
    const own = await req(ALICE, `/chats?artifact_id=${id}`);
    expect(own.status).toBe(200);
    expect(own.body.data.map((m) => m.content)).toEqual(['앨리스 비밀', '노바 답']);
    const other = await req(BOB, `/chats?artifact_id=${id}`);
    expect(other.status).toBe(403);
    expect(JSON.stringify(other.body)).not.toContain('앨리스 비밀');
  });

  test('session_key 추측 방지 (관문 71 cover): p{id}를 알아도 남은 403', async () => {
    const id = seedArtifact(db, { owner: ALICE });
    seedChat(db, { artifactId: id, sessionKey: 'p' + id, who: 'user', content: '앨리스 비밀' });
    // 키 형식이 p{숫자}라 추측이 쉽지만, 소유권 확인이 막는다
    const guessed = await req(BOB, `/chats?session_key=p${id}`);
    expect(guessed.status).toBe(403);
    expect(JSON.stringify(guessed.body)).not.toContain('앨리스 비밀');
    const own = await req(ALICE, `/chats?session_key=p${id}`);
    expect(own.status).toBe(200);
    expect(own.body.data).toHaveLength(1);
  });

  test('published 아티팩트의 채팅은 누구나 읽을 수 있다', async () => {
    const id = seedArtifact(db, { owner: ALICE, status: 'published' });
    seedChat(db, { artifactId: id, sessionKey: 'p' + id, who: 'user', content: '공개 대화' });
    expect((await req(BOB, `/chats?artifact_id=${id}`)).status).toBe(200);
    expect((await req(BOB, `/chats?session_key=p${id}`)).status).toBe(200);
  });

  test('필터 없이 호출하면 400이다 (전체 채팅 노출 차단)', async () => {
    const id = seedArtifact(db, { owner: ALICE });
    seedChat(db, { artifactId: id, sessionKey: 'p' + id, content: '앨리스 비밀' });
    const r = await req(BOB, '/chats');
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain('앨리스 비밀');
  });

  test('p-접두사가 없는 고아 세션 키는 키를 아는 사람만 조회한다', async () => {
    seedChat(db, { artifactId: null, sessionKey: 'orphan-key-xyz', who: 'user', content: '고아 채팅' });
    const r = await req(BOB, '/chats?session_key=orphan-key-xyz');
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    const miss = await req(BOB, '/chats?session_key=other-key');
    expect(miss.body.data).toEqual([]);
  });
});
