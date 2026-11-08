/**
 * 관문 테스트 56: 전역 인증 미들웨어 — 실제 앱·실제 세션 검증
 *
 * 성질: src/index.ts의 전역 미들웨어가 /api/* 를 보호한다.
 * - 세션 쿠키 없으면 /api/* → 401, 페이지는 /login.html로 302
 * - /api/health·/api/auth/*·/api/channel/webhook/* 은 면제
 * - 유효한 HMAC 세션(서명·만료·버전 일치)만 통과한다
 *
 * 검증 방식: 실제 src/index.ts를 esbuild로 컴파일해 Hono app.request()로
 * 호출한다. 세션 토큰은 auth/routes.ts createSession과 동일한 형식
 * (btoa(payload) + '.' + btoa(HMAC-SHA256 서명))으로 테스트에서 직접 만들어
 * 미들웨어의 검증 로직을 검사한다. OTP/PIN 발급 경로는 타지 않는다.
 * DB는 실제 마이그레이션(0032~0039 + 세션 버전 카운터 0051)을 적용한
 * better-sqlite3 인메모리 DB다.
 *
 * 실행: npx jest tests/gate-56-auth.test.js
 */
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const BUNDLE = '/tmp/index-gate-56-test.cjs';
try {
  execSync(
    `npx esbuild ${path.join(ROOT, 'src/index.ts')} --bundle --platform=node --format=cjs --outfile=${BUNDLE}`,
    { stdio: 'pipe' },
  );
} catch (e) {
  throw new Error('index.ts 컴파일 실패: ' + (e.stderr?.toString() || e.message));
}
const handler = require(BUNDLE).default;

const SECRET = 'test-session-secret-56';
const ALICE = 'alice@example.com';

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

/** auth/routes.ts createSession과 동일한 토큰 형식으로 위조 세션을 만든다. */
async function forgeSession(email, { version = 0, expOffsetMs = 30 * 24 * 3600 * 1000, method = 'pin' } = {}) {
  const payload = JSON.stringify({ email, exp: Date.now() + expOffsetMs, method, v: version });
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const b64bin = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  return btoa(payload) + '.' + b64bin(sig);
}

describe('관문 56: 전역 인증 미들웨어 (실제 앱 + 실제 세션)', () => {
  let db;
  let d1;
  let env;

  beforeAll(() => {
    db = new Database(':memory:');
    d1 = createD1(db);
    for (const m of ['0032_artifacts.sql', '0033_artifact_status.sql', '0034_artifact_versions.sql',
      '0035_artifact_files.sql', '0035_artifact_jobs.sql', '0036_artifact_chats.sql',
      '0037_job_provider_attempts.sql', '0038_artifact_job_events.sql', '0039_artifact_jobs_indexes.sql', '0058_artifacts_owner_email.sql',
      '0051_auth_atomic_counters.sql']) {
      db.exec(fs.readFileSync(path.join(ROOT, 'migrations', m), 'utf8'));
    }
    env = { DB: d1, SESSION_SECRET: SECRET, APP_NAME: 'myhub-test' };
  });

  afterAll(() => { db.close(); });

  async function req(p, { cookie = null, method = 'GET', body } = {}) {
    // index.ts의 기본 export는 Worker 핸들러({ fetch, scheduled, queue })라
    // Hono app.request가 아니라 handler.fetch(Request, env)로 호출한다.
    const res = await handler.fetch(new Request('http://localhost' + p, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    let j = null;
    try { j = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: j, headers: res.headers };
  }

  test('쿠키 없으면 /api/* 는 401이다', async () => {
    const r = await req('/api/artifact');
    expect(r.status).toBe(401);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toBe('인증 필요');
    const r2 = await req('/api/memos');
    expect(r2.status).toBe(401);
  });

  test('쿠키 없으면 페이지는 /login.html로 302 리다이렉트된다', async () => {
    const r = await req('/agent.html');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/login.html');
  });

  test('/api/health는 쿠키 없이도 200이다 (공개 경로)', async () => {
    const r = await req('/api/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  test('웹훅 경로는 세션 면제다 — 미들웨어를 통과해 라우트가 503으로 거절한다', async () => {
    // CHANNEL_WEBHOOK_SECRET 미설정이라 라우트 자체가 503. 401이 아니라는 점이
    // 미들웨어가 이 경로를 면제했다는 증거다.
    const r = await req('/api/channel/webhook/test', { method: 'POST', body: {} });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('webhook_disabled');
  });

  test('유효한 세션 쿠키면 /api/* 를 통과해 실제 라우트까지 간다', async () => {
    const token = await forgeSession(ALICE);
    const r = await req('/api/artifact', { cookie: `myhub_session=${token}` });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.data).toEqual([]);
  });

  test('서명을 위조한 토큰은 401이다', async () => {
    const token = await forgeSession(ALICE);
    const [payload, sig] = token.split('.');
    const tampered = payload + '.' + (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    const r = await req('/api/artifact', { cookie: `myhub_session=${tampered}` });
    expect(r.status).toBe(401);
  });

  test('형식 자체가 틀린 쿠키는 401이다', async () => {
    const r = await req('/api/artifact', { cookie: 'myhub_session=garbage' });
    expect(r.status).toBe(401);
  });

  test('만료된 세션은 401이다', async () => {
    const token = await forgeSession(ALICE, { expOffsetMs: -1000 });
    const r = await req('/api/artifact', { cookie: `myhub_session=${token}` });
    expect(r.status).toBe(401);
  });

  test('세션 버전이 D1 카운터와 다르면 401이다 (로그아웃·PIN 재발급 후 구 토큰 차단)', async () => {
    db.prepare('INSERT INTO session_versions (email, version) VALUES (?, ?)').run(ALICE, 1);
    try {
      const oldToken = await forgeSession(ALICE, { version: 0 });
      expect((await req('/api/artifact', { cookie: `myhub_session=${oldToken}` })).status).toBe(401);
      const newToken = await forgeSession(ALICE, { version: 1 });
      expect((await req('/api/artifact', { cookie: `myhub_session=${newToken}` })).status).toBe(200);
    } finally {
      db.prepare('DELETE FROM session_versions WHERE email=?').run(ALICE);
    }
  });
});
