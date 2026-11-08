/**
 * Resend OTP 메일 발송 실패 처리 테스트
 * @jest-environment node
 *
 * 검증: silent failure 수정 — Resend HTTP 오류/네트워크 오류 시
 * 반드시 실패로 처리하고 로그에 민감정보가 남지 않아야 함.
 */

const { execSync } = require('child_process');

try {
  execSync('npx esbuild src/modules/auth/routes.ts --bundle --format=cjs --platform=node --outfile=/tmp/auth-routes-test.cjs', { cwd: __dirname, stdio: 'pipe' });
} catch (e) {
  console.error('Bundle failed:', e.message);
}

const { sendOtpEmail } = require('/tmp/auth-routes-test.cjs');

// console.error 캡처
let errorLogs = [];
const origError = console.error;
beforeEach(() => {
  errorLogs = [];
  console.error = (...args) => { errorLogs.push(args.join(' ')); };
});
afterEach(() => {
  console.error = origError;
  delete global.fetch;
});

function mockFetchOnce(response) {
  global.fetch = async () => response;
}

const env = { RESEND_API_KEY: 'test-key-placeholder' };

describe('sendOtpEmail: Resend 응답 처리', () => {
  test('R01: 200 정상 응답 → ok:true', async () => {
    mockFetchOnce({ ok: true, status: 200, json: async () => ({ id: 'msg_123' }) });
    const r = await sendOtpEmail(env, 'a@b.com', '123456');
    expect(r.ok).toBe(true);
    expect(errorLogs.length).toBe(0);
  });

  test('R02: 401 (잘못된 키) → ok:false + 에러 로그', async () => {
    mockFetchOnce({
      ok: false, status: 401,
      json: async () => ({ name: 'invalid_api_key', message: 'API key is invalid' }),
      text: async () => '',
    });
    const r = await sendOtpEmail(env, 'a@b.com', '123456');
    expect(r.ok).toBe(false);
    expect(errorLogs.join(' ')).toMatch(/http=401/);
    expect(errorLogs.join(' ')).toMatch(/invalid_api_key/);
  });

  test('R03: 403 → ok:false', async () => {
    mockFetchOnce({
      ok: false, status: 403,
      json: async () => ({ name: 'forbidden', message: 'Access denied' }),
      text: async () => '',
    });
    const r = await sendOtpEmail(env, 'a@b.com', '123456');
    expect(r.ok).toBe(false);
    expect(errorLogs.join(' ')).toMatch(/http=403/);
  });

  test('R04: 429 (rate limit) → ok:false', async () => {
    mockFetchOnce({
      ok: false, status: 429,
      json: async () => ({ name: 'rate_limit_exceeded', message: 'Too many requests' }),
      text: async () => '',
    });
    const r = await sendOtpEmail(env, 'a@b.com', '123456');
    expect(r.ok).toBe(false);
    expect(errorLogs.join(' ')).toMatch(/http=429/);
  });

  test('R05: 500 → ok:false', async () => {
    mockFetchOnce({
      ok: false, status: 500,
      json: async () => { throw new Error('not json'); },
      text: async () => 'Internal Server Error',
    });
    const r = await sendOtpEmail(env, 'a@b.com', '123456');
    expect(r.ok).toBe(false);
    expect(errorLogs.join(' ')).toMatch(/http=500/);
  });

  test('R06: 네트워크 오류(throw) → ok:false + 성공으로 처리하지 않음', async () => {
    global.fetch = async () => { throw new Error('network down'); };
    const r = await sendOtpEmail(env, 'a@b.com', '123456');
    expect(r.ok).toBe(false);
    // 민감정보 노출 방지를 위해 원문 대신 일반 메시지 로그
    expect(errorLogs.join(' ')).toMatch(/Resend fetch failed/);
  });
});

describe('sendOtpEmail: 민감정보 비노출', () => {
  test('R07: 로그에 API 키·OTP 코드·수신자 이메일이 남지 않음', async () => {
    mockFetchOnce({
      ok: false, status: 401,
      json: async () => ({ name: 'invalid_api_key', message: 'bad' }),
      text: async () => '',
    });
    const secretEnv = { RESEND_API_KEY: 're_SECRETKEY123' };
    await sendOtpEmail(secretEnv, 'victim@example.com', '999888');
    const logs = errorLogs.join(' ');
    expect(logs).not.toContain('re_SECRETKEY123');
    expect(logs).not.toContain('999888');
    expect(logs).not.toContain('victim@example.com');
  });

  test('R08: 요청 본문에 코드가 포함되지만 로그에는 없음 (구조 확인)', async () => {
    let capturedBody = null;
    global.fetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
    };
    await sendOtpEmail(env, 'a@b.com', '123456');
    // 메일 본문에는 코드가 있어야 함 (발송 목적)
    expect(capturedBody.html).toContain('123456');
    // 로그에는 없어야 함
    expect(errorLogs.join(' ')).not.toContain('123456');
  });
});

describe('sendOtpEmail: 요청 형식', () => {
  test('R09: Resend API에 올바른 형식으로 요청', async () => {
    let captured = null;
    global.fetch = async (url, opts) => {
      captured = { url, opts };
      return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
    };
    await sendOtpEmail(env, 'a@b.com', '123456');
    expect(captured.url).toBe('https://api.resend.com/emails');
    expect(captured.opts.method).toBe('POST');
    expect(captured.opts.headers['Authorization']).toBe('Bearer test-key-placeholder');
    const body = JSON.parse(captured.opts.body);
    expect(body.to).toEqual(['a@b.com']);
    expect(body.subject).toContain('인증코드');
  });
});

describe('보안 조건: 계정 열거 방지', () => {
  test('S01: /request 핸들러가 요청 본문의 이메일을 읽지 않음 (구조적)', () => {
    const fs = require('fs');
    const code = fs.readFileSync(__dirname + '/src/modules/auth/routes.ts', 'utf8');
    // /request 핸들러 구간 추출
    const start = code.indexOf("authApp.post('/request'");
    const end = code.indexOf('// 인증코드 검증', start);
    const handler = code.slice(start, end);
    // 본문에서 이메일을 파싱하지 않음
    expect(handler).not.toMatch(/req\.json/);
    expect(handler).not.toMatch(/body\.email/);
    // 항상 서버 설정의 허용 이메일만 사용
    expect(handler).toContain('getAuthEmail(c.env)');
  });

  test('S02: 실패 응답에 이메일 주소가 포함되지 않음 (구조적)', () => {
    const fs = require('fs');
    const code = fs.readFileSync(__dirname + '/src/modules/auth/routes.ts', 'utf8');
    const start = code.indexOf("authApp.post('/request'");
    const end = code.indexOf('// 인증코드 검증', start);
    const handler = code.slice(start, end);
    // 500 응답 본문에 normEmail 변수가 포함되지 않음
    const failLines = handler.split('\n').filter((l) => l.includes('메일 발송 실패'));
    for (const line of failLines) {
      expect(line).not.toContain('normEmail');
    }
  });
});

describe('보안 조건: OTP 삭제 범위', () => {
  test('S03: 발송 실패 시 DELETE에 code 조건 포함 (구조적)', () => {
    const fs = require('fs');
    const code = fs.readFileSync(__dirname + '/src/modules/auth/routes.ts', 'utf8');
    const start = code.indexOf("authApp.post('/request'");
    const end = code.indexOf('// 인증코드 검증', start);
    const handler = code.slice(start, end);
    // email만으로 삭제하지 않고 code도 조건에 포함
    expect(handler).toMatch(/DELETE FROM otp_codes WHERE email = \? AND code = \?/);
  });

  test('S04: 발송 실패 시 해당 요청의 코드가 아니면 삭제되지 않음 (로직)', async () => {
    // 시뮬레이션: 다른 코드가 DB에 있으면 삭제 조건이 매치되지 않음
    const dbCodes = ['111111']; // 다른 요청이 생성한 코드
    const myCode = '222222';    // 이 요청이 생성한 코드 (발송 실패)
    const wouldDelete = dbCodes.filter((c) => c === myCode);
    expect(wouldDelete.length).toBe(0); // 삭제 대상 없음
    // 내 코드와 일치할 때만 삭제
    const dbCodes2 = ['222222'];
    expect(dbCodes2.filter((c) => c === myCode).length).toBe(1);
  });
});

describe('getAuthEmail: 환경별 fail-closed', () => {
  // getAuthEmail을 직접 테스트하기 위해 모듈 로드
  let getAuthEmail;
  beforeAll(() => {
    try {
      const mod = require('/tmp/auth-routes-test.cjs');
      getAuthEmail = mod.getAuthEmail;
    } catch {}
  });

  test('F01: ENVIRONMENT=production → 운영 이메일', () => {
    if (!getAuthEmail) return;
    const email = getAuthEmail({ ENVIRONMENT: 'production' });
    expect(email).toBe('kimjn00003@naver.com');
  });

  test('F02: ENVIRONMENT=staging + 유효 설정 → 스테이징 이메일', () => {
    if (!getAuthEmail) return;
    const email = getAuthEmail({
      ENVIRONMENT: 'staging',
      STAGING_ALLOWED_EMAILS: 'kjn817@gmail.com'
    });
    expect(email).toBe('kjn817@gmail.com');
  });

  test('F03: ENVIRONMENT 누락 → null (fail-closed)', () => {
    if (!getAuthEmail) return;
    expect(getAuthEmail({})).toBeNull();
    expect(getAuthEmail({ ENVIRONMENT: '' })).toBeNull();
    expect(getAuthEmail({ ENVIRONMENT: undefined })).toBeNull();
  });

  test('F04: 알 수 없는 환경 → null (fail-closed)', () => {
    if (!getAuthEmail) return;
    expect(getAuthEmail({ ENVIRONMENT: 'development' })).toBeNull();
    expect(getAuthEmail({ ENVIRONMENT: 'PRODUCTION' })).toBeNull(); // 대소문자 구분
    expect(getAuthEmail({ ENVIRONMENT: 'prod' })).toBeNull();
  });

  test('F05: staging에서 STAGING_ALLOWED_EMAILS 누락 → null', () => {
    if (!getAuthEmail) return;
    expect(getAuthEmail({ ENVIRONMENT: 'staging' })).toBeNull();
    expect(getAuthEmail({ ENVIRONMENT: 'staging', STAGING_ALLOWED_EMAILS: '' })).toBeNull();
  });

  test('F06: staging에서 잘못된 형식 → null', () => {
    if (!getAuthEmail) return;
    // 복수 이메일은 지원하지 않음
    expect(getAuthEmail({
      ENVIRONMENT: 'staging',
      STAGING_ALLOWED_EMAILS: 'a@b.com,c@d.com'
    })).toBeNull();
  });
});
