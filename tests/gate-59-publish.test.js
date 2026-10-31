/**
 * 관문 테스트 59: 게시 소유권 — 실제 DB·실제 HTTP 검증
 *
 * 성질: POST /:id/versions/:versionNo/publish 와 POST /:id/publish 는
 * 소유자만 게시할 수 있다. 남이 게시하면 상태가 바뀌지 않는다.
 *
 * 과거 결함(주석): publish 엔드포인트에 소유권 확인이 없었다.
 * 코드 확인(2026-10-27): routes.ts 두 publish 경로 모두
 * `WHERE id = ? AND owner_email = ?` 확인을 한다.
 *
 * 다시 쓰면서 발견해 함께 고친 결함 (routes.ts, 실DB 재현 확인):
 * - POST / (아티팩트 생성)의 버전 INSERT가 존재하지 않는 컬럼
 *   content_hash/content_size를 써서 새 DB·운영 모두에서 500이었다
 *   (운영 artifact_versions 스키마 실측: content_sha256만 존재).
 *   → content_sha256 사용·content_size 제거.
 * - 어떤 생성 경로도 artifacts.owner_email을 기록하지 않아, 컬럼이 있어도
 *   생성자는 자기 아티팩트를 게시·수정·조회할 수 없었다.
 *   → POST /·POST /jobs·job-processor 2곳의 INSERT에 owner_email 추가.
 * - artifacts.owner_email 컬럼 자체는 어떤 마이그레이션도 만들지 않고
 *   운영 D1에도 없었다 (2026-10-27 읽기 전용 실측). 마이그레이션 0058이
 *   컬럼을 만들고 2026-10-27 운영 D1에 단독 적용해 해소했다 (행 수 불변 확인).
 *
 * 실행: npx jest tests/gate-59-publish.test.js
 */
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Hono } = require('hono');

const ROOT = path.join(__dirname, '..');
const BUNDLE = '/tmp/artifact-routes-gate-59-test.cjs';
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

function artifactStatus(db, id) {
  return db.prepare('SELECT status, published_version_id FROM artifacts WHERE id=?').get(id);
}

function cleanDb(db) {
  for (const t of ['artifact_job_events', 'job_provider_attempts', 'artifact_files', 'artifact_versions', 'artifact_chats', 'artifact_jobs', 'artifacts']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
}

describe('관문 59: 게시 소유권 (실제 DB + 실제 HTTP)', () => {
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

  test('POST / 생성: 소유자가 기록되고 v1 버전이 스키마대로 생긴다', async () => {
    const r = await req(ALICE, '/', 'POST', { title: '새 앱', html_content: '<p>hello</p>' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const art = db.prepare('SELECT owner_email, status FROM artifacts WHERE id=?').get(r.body.data.id);
    expect(art.owner_email).toBe(ALICE);
    expect(art.status).toBe('draft');
    const ver = db.prepare('SELECT version_no, content_sha256 FROM artifact_versions WHERE artifact_id=?').get(r.body.data.id);
    expect(ver.version_no).toBe(1);
    expect(ver.content_sha256).toBeTruthy();
  });

  test('소유자는 버전 게시가 되고 DB 상태가 published로 바뀐다', async () => {
    const id = seedArtifact(db, { owner: ALICE });
    const v1 = seedVersion(db, id, 1);
    const r = await req(ALICE, `/${id}/versions/1/publish`, 'POST');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const after = artifactStatus(db, id);
    expect(after.status).toBe('published');
    expect(after.published_version_id).toBe(v1);
  });

  test('남이 버전 게시하면 403이고 DB 상태는 draft 그대로다', async () => {
    const id = seedArtifact(db, { owner: ALICE });
    seedVersion(db, id, 1);
    const r = await req(BOB, `/${id}/versions/1/publish`, 'POST');
    expect(r.status).toBe(403);
    expect(artifactStatus(db, id).status).toBe('draft');
    expect(artifactStatus(db, id).published_version_id).toBeNull();
  });

  test('소유자는 초안 게시가 되고 남이 하면 404이며 상태가 안 바뀐다', async () => {
    const id = seedArtifact(db, { owner: ALICE });
    const v1 = seedVersion(db, id, 1);
    db.prepare('UPDATE artifacts SET draft_version_id=? WHERE id=?').run(v1, id);
    const bobRes = await req(BOB, `/${id}/publish`, 'POST');
    expect(bobRes.status).toBe(404);
    expect(artifactStatus(db, id).status).toBe('draft');
    const aliceRes = await req(ALICE, `/${id}/publish`, 'POST');
    expect(aliceRes.status).toBe(200);
    expect(artifactStatus(db, id).status).toBe('published');
  });

  test('없는 버전 게시: 소유자는 404, 남은 403이다', async () => {
    const id = seedArtifact(db, { owner: ALICE });
    seedVersion(db, id, 1);
    expect((await req(ALICE, `/${id}/versions/99/publish`, 'POST')).status).toBe(404);
    expect((await req(BOB, `/${id}/versions/99/publish`, 'POST')).status).toBe(403);
  });

  test('롤백도 같은 소유권 규칙을 따른다', async () => {
    const id = seedArtifact(db, { owner: ALICE });
    const v1 = seedVersion(db, id, 1);
    const v2 = seedVersion(db, id, 2);
    db.prepare(`UPDATE artifacts SET published_version_id=?, draft_version_id=?, status='published' WHERE id=?`).run(v2, v2, id);
    expect((await req(BOB, `/${id}/rollback/1`, 'POST')).status).toBe(403);
    expect(artifactStatus(db, id).published_version_id).toBe(v2);
    const ok = await req(ALICE, `/${id}/rollback/1`, 'POST');
    expect(ok.status).toBe(200);
    expect(artifactStatus(db, id).published_version_id).toBe(v1);
  });
});
