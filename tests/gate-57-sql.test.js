/**
 * 관문 테스트 57: SQL 인젝션 — 실제 DB·실제 HTTP 검증
 *
 * 성질: 사용자 입력이 SQL 구조로 해석되지 않는다. 모든 쿼리는 .bind()
 * 파라미터 바인딩으로 값을 전달하고, 인젝션 문자열은 그냥 값(또는 불일치)으로
 * 처리된다. 인젝션 시도로 소유권이 우회되거나 행이 누출되지 않는다.
 *
 * 과거 확인(주석): 모든 쿼리가 .bind()를 쓴다고 적혀 있었으나 검증이 없었다.
 * 코드 확인(2026-10-27): routes.ts의 모든 사용자 입력은 .bind()로 전달된다.
 * 유일한 문자열 보간은 PATCH의 `${updates.join(', ')}`인데, 들어가는 값은
 * 코드에 고정된 컬럼명(title/description/icon_key)뿐이라 사용자 입력이 아니다.
 * 아래 테스트는 그 경계를 행위(behavior)로 검증한다.
 *
 * 실행: npx jest tests/gate-57-sql.test.js
 */
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Hono } = require('hono');

const ROOT = path.join(__dirname, '..');
const BUNDLE = '/tmp/artifact-routes-gate-57-test.cjs';
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

describe('관문 57: SQL 인젝션 (실제 DB + 실제 HTTP)', () => {
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

  test("OR 1=1 형태의 artifact_id는 값으로 처리돼 소유권을 우회하지 못한다", async () => {
    const id = seedArtifact(db, { owner: ALICE });
    seedChat(db, { artifactId: id, sessionKey: 'p' + id, content: '앨리스 비밀' });
    // 문자열 보간이었다면 `id = 1 OR 1=1`이 되어 소유권이 우회된다
    const r = await req(BOB, '/chats', 'POST', { artifact_id: `${id} OR 1=1`, session_key: 'x', who: 'user', content: '침입' });
    expect(r.status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_chats').get().n).toBe(1);
    const read = await req(BOB, `/chats?artifact_id=${id} OR 1=1`);
    expect(read.status).toBe(403);
    expect(JSON.stringify(read.body)).not.toContain('앨리스 비밀');
  });

  test("검색어의 따옴표·OR는 LIKE 값으로 처리돼 전체 행을 누출하지 않는다", async () => {
    seedArtifact(db, { owner: ALICE, title: '앨리스비밀' });
    seedArtifact(db, { owner: BOB, title: '밥프로젝트' });
    const r = await req(BOB, "/search?q=' OR '1'='1");
    expect(r.status).toBe(200);
    expect(r.body.data.projects).toEqual([]);
    expect(r.body.data.chats).toEqual([]);
  });

  test("검색어 '%'는 와일드카드로 동작해도 소유권 필터가 남의 초안을 가린다", async () => {
    seedArtifact(db, { owner: ALICE, title: '앨리스비밀' });
    seedArtifact(db, { owner: BOB, title: '밥프로젝트' });
    const r = await req(BOB, '/search?q=%');
    expect(r.status).toBe(200);
    expect(r.body.data.projects.map((p) => p.title)).toEqual(['밥프로젝트']);
  });

  test("DROP TABLE 형태의 입력은 값으로 처리되고 테이블이 그대로 있다", async () => {
    const id = seedArtifact(db, { owner: ALICE });
    const r = await req(BOB, '/chats', 'POST', { artifact_id: '1; DROP TABLE artifacts; --', session_key: 'x', who: 'user', content: '침입' });
    expect(r.status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n).toBe(1);
    expect(db.prepare('SELECT title FROM artifacts WHERE id=?').get(id).title).toBe('제목');
  });

  test("PATCH 제목의 따옴표·콤마는 값으로 저장되고 status는 안 바뀐다", async () => {
    const id = seedArtifact(db, { owner: ALICE });
    const evil = `x', status='published`;
    const r = await req(ALICE, `/${id}`, 'PATCH', { title: evil });
    expect(r.status).toBe(200);
    const row = db.prepare('SELECT title, status FROM artifacts WHERE id=?').get(id);
    expect(row.title).toBe(evil);
    expect(row.status).toBe('draft');
  });
});
