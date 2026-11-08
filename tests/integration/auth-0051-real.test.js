/**
 * 0051 인증 원자 카운터 — 실제 SQLite 통합 테스트
 *
 * better-sqlite3 인메모리 DB에 마이그레이션 0006(otp_codes)→0043(auth_pins)→
 * 0045(fail_count)→0051(session_versions·rate_limits)를 적용하고, esbuild로
 * 컴파일한 실제 src/modules/auth/routes.ts를 호출한다.
 * - rate_limits UPSERT: 한 문장으로 선점·증가·상한 판정 (KV read-modify-write 대체)
 * - session_versions: UPDATE ... RETURNING version 원자 bump
 * - PIN 게이트 CASE: 만료된 잠금 뒤 fail_count 재시작 (no-decay)
 * - /verify·/pin-login: 정답 제출이 소진·잠금을 우회하는지 실측
 *
 * 실행: npx jest tests/integration/auth-0051-real.test.js
 *
 * 주의: 표준 SQLite는 D1과 문법이 같지만, 실제 D1의 동시성·지연은 재현하지 않는다.
 * 이 테스트는 마이그레이션 SQL 유효성과 단일 문장 원자성의 의미를 검증한다.
 * D1 실측은 운영 적용 단계에서 수행한다.
 */
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Hono } = require('hono');

const tsPath = path.join(__dirname, '../../src/modules/auth/routes.ts');
const jsPath = '/tmp/auth-routes-0051-test.cjs';
try {
  execSync(`npx esbuild ${tsPath} --bundle --platform=node --format=cjs --outfile=${jsPath}`, {
    stdio: 'pipe',
  });
} catch (e) {
  console.error('TypeScript 컴파일 실패:', e.message);
}

const auth = require(jsPath);

function createD1Adapter(db) {
  const prepare = (sql) => {
    const stmt = db.prepare(sql);
    return {
      _sql: sql,
      _params: [],
      bind(...p) {
        this._params = p;
        return this;
      },
      async first() {
        return stmt.get(...this._params) || null;
      },
      async all() {
        return { results: stmt.all(...this._params) };
      },
      async run() {
        const info = stmt.run(...this._params);
        return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
      },
    };
  };
  return { prepare };
}

function applyMigration(db, name) {
  const sql = fs.readFileSync(path.join(__dirname, '../../migrations', name), 'utf8');
  db.exec(sql);
}

class MockKv {
  constructor() { this.store = new Map(); }
  async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
  async put(k, v) { this.store.set(k, v); }
}

describe('0051 마이그레이션 + 인증 원자 카운터 (실제 SQLite)', () => {
  let db;
  let d1;
  let app;
  let kv;

  beforeAll(() => {
    db = new Database(':memory:');
    d1 = createD1Adapter(db);
    applyMigration(db, '0006_otp.sql');
    applyMigration(db, '0043_auth_pins.sql');
    applyMigration(db, '0045_auth_pins_fail_count.sql');
    applyMigration(db, '0051_auth_atomic_counters.sql');
    kv = new MockKv();
    app = new Hono();
    app.route('/a', auth.authApp);
  });

  afterAll(() => {
    db.close();
  });

  const env = () => ({
    DB: d1,
    KV: kv,
    SESSION_SECRET: 'test-secret-1234567890',
    ENVIRONMENT: 'production',
    RESEND_API_KEY: 're_test_key',
  });
  const json = (path, method, body, headers) =>
    app.request('/a' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env());
  const ip = (n) => ({ 'CF-Connecting-IP': `10.9.0.${n}` });

  async function seedPin(pin, failCount = 0, lockedUntil = null) {
    const h = await auth.hashPin(pin);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO auth_pins (email, pin_hash, pin_salt, iterations, fail_count, locked_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('kimjn00003@naver.com', h.hashB64, h.saltB64, h.iterations, failCount, lockedUntil, now, now);
  }
  function pinState() {
    return db.prepare(`SELECT fail_count, locked_until FROM auth_pins WHERE email = ?`).get('kimjn00003@naver.com');
  }

  test('0051 적용 — 새 테이블 존재', () => {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
    expect(tables).toContain('session_versions');
    expect(tables).toContain('rate_limits');
    const cols = db.prepare(`PRAGMA table_info(session_versions)`).all().map((r) => r.name);
    expect(cols).toEqual(['email', 'version']);
  });

  test('속도 제한 UPSERT: 상한까지 허용, 초과 시 차단, 키별 독립', async () => {
    expect(await auth.checkRateLimit(d1, 't:ip1', 3, 3600)).toBe(false);
    expect(await auth.checkRateLimit(d1, 't:ip1', 3, 3600)).toBe(false);
    expect(await auth.checkRateLimit(d1, 't:ip1', 3, 3600)).toBe(false);
    expect(await auth.checkRateLimit(d1, 't:ip1', 3, 3600)).toBe(true);
    expect(await auth.checkRateLimit(d1, 't:ip1', 3, 3600)).toBe(true);
    expect(await auth.checkRateLimit(d1, 't:other', 3, 3600)).toBe(false);
    expect(db.prepare(`SELECT count FROM rate_limits WHERE key = ?`).get('t:ip1').count).toBe(3);
  });

  test('속도 제한: 윈도우 만료 시 카운터가 1로 재시작', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    db.prepare(`INSERT INTO rate_limits (key, count, window_expires_at) VALUES (?, ?, ?)`).run('t:exp', 3, past);
    expect(await auth.checkRateLimit(d1, 't:exp', 3, 3600)).toBe(false);
    expect(db.prepare(`SELECT count FROM rate_limits WHERE key = ?`).get('t:exp').count).toBe(1);
  });

  test('세션 버전: bump이 1씩 증가하고 RETURNING 값을 돌려준다', async () => {
    expect(await auth.getSessionVersion({ DB: d1 }, 'kimjn00003@naver.com')).toBe(0);
    expect(await auth.bumpSessionVersion({ DB: d1 }, 'kimjn00003@naver.com')).toBe(1);
    expect(await auth.bumpSessionVersion({ DB: d1 }, 'kimjn00003@naver.com')).toBe(2);
    expect(await auth.getSessionVersion({ DB: d1 }, 'kimjn00003@naver.com')).toBe(2);
  });

  test('세션 버전: 동시 bump 10개 → 버전이 1씩 모두 다르게 올라간다', async () => {
    db.prepare(`DELETE FROM session_versions WHERE email = ?`).run('kimjn00003@naver.com');
    const versions = await Promise.all(
      Array.from({ length: 10 }, () => auth.bumpSessionVersion({ DB: d1 }, 'kimjn00003@naver.com')),
    );
    expect(new Set(versions).size).toBe(10);
    expect(Math.max(...versions)).toBe(10);
    expect(await auth.getSessionVersion({ DB: d1 }, 'kimjn00003@naver.com')).toBe(10);
  });

  test('PIN 게이트: 순차 오답 5회 → 401×5 후 429, fail_count=5', async () => {
    await seedPin('135790');
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const r = await json('/pin-login', 'POST', { pin: '000000' }, ip(i + 1));
      statuses.push(r.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    expect(pinState().fail_count).toBe(5);
    expect(pinState().locked_until).not.toBeNull();
  });

  test('PIN 게이트: 잠금 중 정답 → 200, 오답 → 429', async () => {
    const wrong = await json('/pin-login', 'POST', { pin: '000001' }, ip(50));
    expect(wrong.status).toBe(429);
    const right = await json('/pin-login', 'POST', { pin: '135790' }, ip(51));
    expect(right.status).toBe(200);
    expect(pinState().fail_count).toBe(0);
    expect(pinState().locked_until).toBeNull();
  });

  test('PIN 게이트: 만료된 잠금 뒤 오답 → fail_count=1로 재시작', async () => {
    const expired = new Date(Date.now() - 1000).toISOString();
    db.prepare(`UPDATE auth_pins SET fail_count = 5, locked_until = ? WHERE email = ?`).run(expired, 'kimjn00003@naver.com');
    const r = await json('/pin-login', 'POST', { pin: '000000' }, ip(60));
    expect(r.status).toBe(401);
    const st = pinState();
    expect(st.fail_count).toBe(1);
    expect(st.locked_until).toBeNull();
  });

  // p0-pin-lock-verify: 실제 SQL 게이트의 동시 버스트 — Mock이 아닌 실제
  // UPDATE 문이 실행되므로 게이트 WHERE/CASE 의미 회귀를 여기서 잡는다.
  // better-sqlite3 어댑터의 run()은 동기 실행이라 게이트 UPDATE가 직렬화된다.
  // 실제 D1의 네트워크 동시성과는 다르다는 한계는 파일 상단 주석 참조.
  test('PIN 게이트: 동시 오답 버스트 10 → 401은 5개, 429는 5개, fail_count=5 (실제 SQL)', async () => {
    db.prepare(`UPDATE auth_pins SET fail_count = 0, locked_until = NULL WHERE email = ?`).run('kimjn00003@naver.com');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        json('/pin-login', 'POST', { pin: '000000' }, { 'CF-Connecting-IP': `10.9.1.${i + 1}` })),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    const st = pinState();
    expect(st.fail_count).toBe(5);
    expect(st.locked_until).not.toBeNull();
  });

  test('PIN 게이트: 버스트로 잠금된 상태 — 오답 429·잠금 불변, 정답 200·초기화 (실제 SQL)', async () => {
    const before = pinState();
    expect(before.fail_count).toBe(5);
    expect(before.locked_until).not.toBeNull();
    const wrong = await json('/pin-login', 'POST', { pin: '000001' }, { 'CF-Connecting-IP': '10.9.1.50' });
    expect(wrong.status).toBe(429);
    expect(pinState().fail_count).toBe(5);
    expect(pinState().locked_until).toBe(before.locked_until);
    const right = await json('/pin-login', 'POST', { pin: '135790' }, { 'CF-Connecting-IP': '10.9.1.51' });
    expect(right.status).toBe(200);
    expect(pinState().fail_count).toBe(0);
    expect(pinState().locked_until).toBeNull();
  });

  test('PIN 게이트: 잠금 만료 직후 동시 버스트 10 → 재시작 후에도 401은 5개만 (실제 SQL)', async () => {
    const expired = new Date(Date.now() - 1000).toISOString();
    db.prepare(`UPDATE auth_pins SET fail_count = 5, locked_until = ? WHERE email = ?`).run(expired, 'kimjn00003@naver.com');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        json('/pin-login', 'POST', { pin: '000000' }, { 'CF-Connecting-IP': `10.9.2.${i + 1}` })),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    const st = pinState();
    expect(st.fail_count).toBe(5);
    expect(st.locked_until).not.toBeNull();
    expect(new Date(st.locked_until).getTime()).toBeGreaterThan(Date.now());
  });

  test('/verify: attempts=5 상태에서 정답 → 200, 오답 → 400이고 행 유지', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    db.prepare(`INSERT OR REPLACE INTO otp_codes (email, code, attempts, expires_at) VALUES (?, ?, ?, ?)`)
      .run('kimjn00003@naver.com', '123456', 5, future);
    const wrong = await json('/verify', 'POST', { code: '999999' }, ip(70));
    expect(wrong.status).toBe(400);
    const rowAfterWrong = db.prepare(`SELECT attempts FROM otp_codes WHERE email = ?`).get('kimjn00003@naver.com');
    expect(rowAfterWrong).not.toBeNull();
    expect(rowAfterWrong.attempts).toBe(5);
    const right = await json('/verify', 'POST', { code: '123456' }, ip(71));
    expect(right.status).toBe(200);
    const rowAfterRight = db.prepare(`SELECT * FROM otp_codes WHERE email = ?`).get('kimjn00003@naver.com');
    expect(rowAfterRight).toBeUndefined();
  });

  // ---------- P0 otp-single-use: 단회 사용·10분 유효·재요청 교체 (실제 SQLite) ----------
  const OTP_EMAIL = 'kimjn00003@naver.com';
  let mailBodies = [];
  const realFetch = global.fetch;
  function stubMailOk() {
    mailBodies = [];
    global.fetch = async (_url, init) => {
      mailBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: 'em_test' }), { status: 200 });
    };
  }
  function codeFromMail(i) {
    const m = mailBodies[i].html.match(/>(\d{6})</);
    if (!m) throw new Error('메일 본문에서 코드를 찾지 못함');
    return m[1];
  }
  function otpRow() {
    return db.prepare(`SELECT code, attempts, expires_at FROM otp_codes WHERE email = ?`).get(OTP_EMAIL);
  }
  function clearOtp() {
    db.prepare(`DELETE FROM otp_codes WHERE email = ?`).run(OTP_EMAIL);
  }
  afterEach(() => { global.fetch = realFetch; });

  test('OTP 단회 사용: 검증 성공 후 같은 코드 재검증 → 실패, 유효기간 ≈10분', async () => {
    clearOtp();
    stubMailOk();
    const req = await json('/request', 'POST', {}, ip(101));
    expect(req.status).toBe(200);
    expect(mailBodies).toHaveLength(1);
    expect(mailBodies[0].html).toContain('10분');
    const row = otpRow();
    expect(row).toBeDefined();
    expect(row.code).toBe(codeFromMail(0));
    expect(row.attempts).toBe(0);
    // 발급 시점 기준 남은 유효기간이 600초에서 크게 벗어나지 않는다 (±10초)
    const remainSec = (new Date(row.expires_at).getTime() - Date.now()) / 1000;
    expect(remainSec).toBeGreaterThan(590);
    expect(remainSec).toBeLessThanOrEqual(600);
    const ok = await json('/verify', 'POST', { code: row.code }, ip(102));
    expect(ok.status).toBe(200);
    expect(otpRow()).toBeUndefined(); // 행이 소비됐다
    const again = await json('/verify', 'POST', { code: row.code }, ip(103));
    expect(again.status).toBe(400);
  });

  test('OTP 동시 검증 2건 (같은 코드 Promise.all) → 정확히 1건만 성공', async () => {
    clearOtp();
    const future = new Date(Date.now() + 600_000).toISOString();
    db.prepare(`INSERT INTO otp_codes (email, code, attempts, expires_at) VALUES (?, ?, 0, ?)`)
      .run(OTP_EMAIL, '654321', future);
    const results = await Promise.all([
      json('/verify', 'POST', { code: '654321' }, ip(110)),
      json('/verify', 'POST', { code: '654321' }, ip(111)),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 400]);
    expect(otpRow()).toBeUndefined();
  });

  test('OTP 만료 코드 → 거부 + 행 삭제', async () => {
    clearOtp();
    const past = new Date(Date.now() - 1000).toISOString();
    db.prepare(`INSERT INTO otp_codes (email, code, attempts, expires_at) VALUES (?, ?, 0, ?)`)
      .run(OTP_EMAIL, '111222', past);
    const r = await json('/verify', 'POST', { code: '111222' }, ip(112));
    expect(r.status).toBe(400);
    expect(otpRow()).toBeUndefined();
  });

  test('OTP 재요청: 구 코드 거부 + 새 코드 성공 + attempts 초기화', async () => {
    clearOtp();
    stubMailOk();
    expect((await json('/request', 'POST', {}, ip(120))).status).toBe(200);
    const firstCode = codeFromMail(0);
    // 오답 시도를 쌓아 attempts를 올린 뒤 재요청한다
    db.prepare(`UPDATE otp_codes SET attempts = 4 WHERE email = ?`).run(OTP_EMAIL);
    // 새 코드가 구 코드와 우연히 같으면(1/900000) 다시 요청해 구분 가능한 쌍을 만든다
    let secondCode = firstCode;
    let n = 121;
    while (secondCode === firstCode && n < 124) {
      expect((await json('/request', 'POST', {}, ip(n))).status).toBe(200);
      secondCode = codeFromMail(mailBodies.length - 1);
      n++;
    }
    expect(secondCode).not.toBe(firstCode);
    const row = otpRow();
    expect(row.code).toBe(secondCode);
    expect(row.attempts).toBe(0); // 재발급이 시도 횟수를 초기화했다
    const oldTry = await json('/verify', 'POST', { code: firstCode }, ip(130));
    expect(oldTry.status).toBe(400); // 구 코드는 교체 즉시 무효
    const newTry = await json('/verify', 'POST', { code: secondCode }, ip(131));
    expect(newTry.status).toBe(200);
    expect(otpRow()).toBeUndefined();
  });

  test('OTP 동시 발급 2건: 코드 1개만 남고 메일 발송은 1건만, 남은 코드로만 검증된다', async () => {
    clearOtp();
    stubMailOk();
    const results = await Promise.all([
      json('/request', 'POST', {}, ip(140)),
      json('/request', 'POST', {}, ip(141)),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    // 쓰기 경합에서 이긴 1건만 메일을 보낸다 (패자는 승자 코드로 성공 반환)
    expect(mailBodies).toHaveLength(1);
    const rows = db.prepare(`SELECT code FROM otp_codes WHERE email = ?`).all(OTP_EMAIL);
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe(codeFromMail(0));
    const ok = await json('/verify', 'POST', { code: rows[0].code }, ip(143));
    expect(ok.status).toBe(200);
  });
});
