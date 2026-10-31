/**
 * 관문 테스트 61: 조회 소유권 — 실제 DB·실제 HTTP 검증
 *
 * 성질: draft 아티팩트는 소유자만 읽을 수 있고, published는 누구나 읽을 수 있다.
 * - GET /:id (상세), GET /:id/versions (히스토리)
 * - GET /:id/versions/:versionNo (단일 버전)
 * - GET /drafts (초안 목록), GET /search (검색)
 *
 * 과거 결함(주석): GET 상세·히스토리에 소유권 확인이 없었다.
 * 코드 확인(2026-10-27): 상세·히스토리는 `owner_email = ? OR status = 'published'`
 * 확인을 한다. 단, 아래 3건은 확인이 없어 다시 쓰면서 고쳤다 (routes.ts):
 * - GET /:id/versions/:versionNo: 소유권 확인 자체가 없어 남의 초안 HTML을
 *   버전 번호만 알면 읽을 수 있었다 → 히스토리와 동일한 확인 추가.
 * - GET /drafts: owner 필터가 없어 전원의 초안 목록이 노출됐다 → 소유자 필터 추가.
 * - GET /search: owner 필터가 없어 남의 초안 제목·채팅 스니펫이 검색됐다 → 필터 추가.
 *   (owner_email IS NULL은 소유권 모델 이전 레거시 행으로, 백필 전까지 허용한다.
 *   artifact_id IS NULL인 고아 채팅은 소유자를 알 수 없어 기존대로 반환한다.)
 *
 * 실행: npx jest tests/gate-61-read.test.js
 */
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Hono } = require('hono');

const ROOT = path.join(__dirname, '..');
const BUNDLE = '/tmp/artifact-routes-gate-61-test.cjs';
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

function seedChat(db, { artifactId = null, sessionKey = 'new', who = 'user', content = '안녕' } = {}) {
  db.prepare(`INSERT INTO artifact_chats (artifact_id, session_key, who, content) VALUES (?, ?, ?, ?)`).run(artifactId, sessionKey, who, content);
}

function cleanDb(db) {
  for (const t of ['artifact_job_events', 'job_provider_attempts', 'artifact_files', 'artifact_versions', 'artifact_chats', 'artifact_jobs', 'artifacts']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
}

describe('관문 61: 조회 소유권 (실제 DB + 실제 HTTP)', () => {
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

  test('GET /:id: draft는 소유자만 200, 남은 404, published는 누구나 200', async () => {
    const draftId = seedArtifact(db, { owner: ALICE, title: '앨리스 초안' });
    const pubId = seedArtifact(db, { owner: ALICE, status: 'published', title: '공개 앱' });
    const v = seedVersion(db, pubId, 1, '<p>공개</p>');
    db.prepare(`UPDATE artifacts SET published_version_id=? WHERE id=?`).run(v, pubId);

    const own = await req(ALICE, `/${draftId}`);
    expect(own.status).toBe(200);
    expect(own.body.data.title).toBe('앨리스 초안');
    expect((await req(BOB, `/${draftId}`)).status).toBe(404);
    const pub = await req(BOB, `/${pubId}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.title).toBe('공개 앱');
    expect((await req(ALICE, '/9999')).status).toBe(404);
  });

  test('GET /:id/versions: draft 히스토리는 소유자만, 남은 403, published는 공개', async () => {
    const draftId = seedArtifact(db, { owner: ALICE });
    seedVersion(db, draftId, 1);
    seedVersion(db, draftId, 2);
    const pubId = seedArtifact(db, { owner: ALICE, status: 'published' });
    seedVersion(db, pubId, 1);

    const own = await req(ALICE, `/${draftId}/versions`);
    expect(own.status).toBe(200);
    expect(own.body.data.versions).toHaveLength(2);
    expect(own.body.data.versions[0].version_no).toBe(2);
    expect((await req(BOB, `/${draftId}/versions`)).status).toBe(403);
    expect((await req(BOB, `/${pubId}/versions`)).status).toBe(200);
  });

  test('GET /:id/versions/:versionNo: draft 버전 HTML은 소유자만, 남은 403', async () => {
    const draftId = seedArtifact(db, { owner: ALICE });
    seedVersion(db, draftId, 1, '<p>비밀 초안</p>');
    const pubId = seedArtifact(db, { owner: ALICE, status: 'published' });
    seedVersion(db, pubId, 1, '<p>공개</p>');

    const own = await req(ALICE, `/${draftId}/versions/1`);
    expect(own.status).toBe(200);
    expect(own.body.data.html_content).toBe('<p>비밀 초안</p>');
    // 카나리아 대상: 이 403이 없으면 남의 초안 HTML이 통째로 노출된다
    expect((await req(BOB, `/${draftId}/versions/1`)).status).toBe(403);
    expect((await req(BOB, `/${pubId}/versions/1`)).status).toBe(200);
    expect((await req(ALICE, `/${draftId}/versions/99`)).status).toBe(404);
    expect((await req(BOB, `/${draftId}/versions/99`)).status).toBe(403);
  });

  test('GET /drafts: 자기 초안만 보이고 남의 초안은 안 보인다', async () => {
    seedArtifact(db, { owner: ALICE, title: '앨리스 초안' });
    seedArtifact(db, { owner: BOB, title: '밥 초안' });
    seedArtifact(db, { owner: null, title: '레거시 초안' });
    const aliceList = await req(ALICE, '/drafts');
    expect(aliceList.status).toBe(200);
    const aliceTitles = aliceList.body.data.map((a) => a.title);
    expect(aliceTitles).toContain('앨리스 초안');
    expect(aliceTitles).not.toContain('밥 초안');
    expect(aliceTitles).toContain('레거시 초안'); // NULL 소유자는 백필 전까지 허용
    const bobList = await req(BOB, '/drafts');
    const bobTitles = bobList.body.data.map((a) => a.title);
    expect(bobTitles).toContain('밥 초안');
    expect(bobTitles).not.toContain('앨리스 초안');
  });

  test('GET /search: 남의 초안 제목·채팅 스니펫이 검색되지 않는다', async () => {
    const aliceId = seedArtifact(db, { owner: ALICE, title: '앨리스비밀프로젝트' });
    seedChat(db, { artifactId: aliceId, sessionKey: 'p' + aliceId, content: '앨리스비밀대화내용' });
    seedArtifact(db, { owner: BOB, title: '밥공개프로젝트' });
    const pubId = seedArtifact(db, { owner: ALICE, status: 'published', title: '앨리스공개프로젝트' });
    seedVersion(db, pubId, 1);

    const bobSecret = await req(BOB, '/search?q=앨리스비밀');
    expect(bobSecret.status).toBe(200);
    expect(bobSecret.body.data.projects).toEqual([]);
    expect(bobSecret.body.data.chats).toEqual([]);
    const bobOwn = await req(BOB, '/search?q=밥공개');
    expect(bobOwn.body.data.projects.map((p) => p.title)).toEqual(['밥공개프로젝트']);
    const bobPub = await req(BOB, '/search?q=앨리스공개');
    expect(bobPub.body.data.projects.map((p) => p.title)).toEqual(['앨리스공개프로젝트']);
    const aliceOwn = await req(ALICE, '/search?q=앨리스비밀');
    expect(aliceOwn.body.data.projects.map((p) => p.title)).toEqual(['앨리스비밀프로젝트']);
    expect(aliceOwn.body.data.chats).toHaveLength(1);
  });
});
