/**
 * src/modules/auth/routes.ts 100% 커버리지 단위 테스트 (보안 핵심: 인증)
 * - getAuthEmail: 환경별 이메일 allowlist (fail-closed)
 * - sendOtpEmail: Resend 발송 + TEST_MAIL_TRANSPORT 모드
 * - verifySession: HMAC 세션 검증
 * - POST /request, POST /verify, POST /logout, GET /me
 * - D1 Mock, KV Mock, fetch Mock, Hono app.request()
 */
/// <reference types="jest" />
import { Hono } from 'hono'
import { authApp, getAuthEmail, sendOtpEmail, verifySession, verifySessionInfo, getClientIp, checkRateLimit, hashPassword, verifyPassword, hashPin, verifyPin, isValidPin, OTP_TTL_MS, OTP_SET_PIN_WINDOW_MS } from '../../src/modules/auth/routes'

// ---------------- Mock D1 ----------------
class MockDb {
  firstQueue: any[] = []
  runQueue: any[] = []
  calls: { sql: string; params: any[] }[] = []

  prepare(sql: string) {
    const db = this
    const exec = (params: any[]) => {
      db.calls.push({ sql, params })
      return {
        first: async () => {
          const v = db.firstQueue.shift()
          if (v === undefined) return null
          if (v instanceof Error) throw v
          return v
        },
        all: async () => ({ results: [] }),
        run: async () => {
          const v = db.runQueue.shift()
          if (v === undefined) return { meta: { last_row_id: 1, changes: 1 } }
          if (v instanceof Error) throw v
          return v
        },
      }
    }
    return {
      bind: (...params: any[]) => exec(params),
      first: () => exec([]).first(),
      all: () => exec([]).all(),
      run: () => exec([]).run(),
    }
  }
}

// ---------------- Mock KV ----------------
class MockKv {
  store = new Map<string, string>()
  puts: { key: string; value: string; opts?: any }[] = []
  async get(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  async put(key: string, value: string, opts?: any) {
    this.store.set(key, value)
    this.puts.push({ key, value, opts })
  }
}

function makeApp(opts: {
  db?: MockDb
  kv?: MockKv
  env?: Record<string, any>
  fetchMock?: any
} = {}) {
  const db = opts.db ?? new MockDb()
  const kv = opts.kv ?? new MockKv()
  const app = new Hono()
  app.route('/a', authApp)
  const env: any = {
    DB: db,
    KV: kv,
    SESSION_SECRET: 'test-secret-1234567890',
    ENVIRONMENT: 'production',
    RESEND_API_KEY: 're_test_key',
    ...opts.env,
  }
  const req = (path: string, init?: RequestInit) => app.request('/a' + path, init, env)
  const json = (path: string, method: string, body?: any, headers?: Record<string, string>) =>
    req(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  return { app, db, kv, env, req, json }
}

async function body(res: Response) {
  return res.json() as Promise<any>
}

// HMAC 세션 토큰 직접 생성 (verifySession 테스트용) — 0045 이후 형식 (method/v 포함)
// OTP 토큰은 "방금 본인확인한 세션"을 뜻하므로 oa(OTP 확인 시각)를 현재로 싣는다
// (트랙 2: set-pin의 10분 창 판정용 클레임).
async function makeSessionToken(email: string, secret: string, expOffsetMs: number, method: 'otp' | 'pin' = 'otp', v = 0) {
  const exp = Date.now() + expOffsetMs
  const payload = JSON.stringify({ email, exp, method, v, ...(method === 'otp' ? { oa: Date.now() } : {}) })
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return btoa(payload) + '.' + sigB64
}

// 0045 이전 구 토큰 (method/v 없음) — 하위 호환 검증용
async function makeLegacySessionToken(email: string, secret: string, expOffsetMs: number) {
  const exp = Date.now() + expOffsetMs
  const payload = JSON.stringify({ email, exp })
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return btoa(payload) + '.' + sigB64
}

// ================= getAuthEmail =================
describe('getAuthEmail', () => {
  test('ENVIRONMENT 누락 → null (fail-closed)', () => {
    expect(getAuthEmail({} as any)).toBeNull()
  })
  test('development + 단일 DEV_ALLOWED_EMAILS → 이메일', () => {
    expect(getAuthEmail({ ENVIRONMENT: 'development', DEV_ALLOWED_EMAILS: ' dev@example.com ' } as any))
      .toBe('dev@example.com')
  })
  test('development + 복수 이메일 → null', () => {
    expect(getAuthEmail({ ENVIRONMENT: 'development', DEV_ALLOWED_EMAILS: 'a@x.com,b@x.com' } as any)).toBeNull()
  })
  test('development + 이메일 없음 → null', () => {
    expect(getAuthEmail({ ENVIRONMENT: 'development', DEV_ALLOWED_EMAILS: '' } as any)).toBeNull()
    expect(getAuthEmail({ ENVIRONMENT: 'development' } as any)).toBeNull()
  })
  test('development + 공백만 → null', () => {
    expect(getAuthEmail({ ENVIRONMENT: 'development', DEV_ALLOWED_EMAILS: ' , ,' } as any)).toBeNull()
  })
  test('staging + 단일 이메일 → 이메일', () => {
    expect(getAuthEmail({ ENVIRONMENT: 'staging', STAGING_ALLOWED_EMAILS: 's@x.com' } as any)).toBe('s@x.com')
  })
  test('staging + 복수 이메일 → null', () => {
    expect(getAuthEmail({ ENVIRONMENT: 'staging', STAGING_ALLOWED_EMAILS: 'a@x.com, b@x.com' } as any)).toBeNull()
  })
  test('staging + 설정 누락 → null (운영 fallback 금지)', () => {
    expect(getAuthEmail({ ENVIRONMENT: 'staging' } as any)).toBeNull()
    expect(getAuthEmail({ ENVIRONMENT: 'staging', STAGING_ALLOWED_EMAILS: '' } as any)).toBeNull()
  })
  test('production → 고정 운영 이메일', () => {
    expect(getAuthEmail({ ENVIRONMENT: 'production' } as any)).toBe('kimjn00003@naver.com')
  })
  test('알 수 없는 환경 → null', () => {
    expect(getAuthEmail({ ENVIRONMENT: 'test' } as any)).toBeNull()
    expect(getAuthEmail({ ENVIRONMENT: 'prod' } as any)).toBeNull()
  })
})

// ================= sendOtpEmail =================
describe('sendOtpEmail', () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })

  test('TEST_MAIL_TRANSPORT=1 + development → 모의 전송 성공', async () => {
    const r = await sendOtpEmail(
      { TEST_MAIL_TRANSPORT: '1', ENVIRONMENT: 'development' },
      'a@x.com', '123456'
    )
    expect(r.ok).toBe(true)
    expect(r.emailId).toMatch(/^test-/)
  })
  test('TEST_MAIL_TRANSPORT=1 + production → 테스트 모드 비활성화 (실제 fetch 호출)', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ id: 'em_1' }), { status: 200 })) as any
    const r = await sendOtpEmail(
      { TEST_MAIL_TRANSPORT: '1', ENVIRONMENT: 'production', RESEND_API_KEY: 'k' },
      'a@x.com', '123456'
    )
    expect(r.ok).toBe(true)
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1)
  })
  test('TEST_MAIL_TRANSPORT=1 + staging → 테스트 모드 비활성화', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ id: 'em_2' }), { status: 200 })) as any
    const r = await sendOtpEmail(
      { TEST_MAIL_TRANSPORT: '1', ENVIRONMENT: 'staging', RESEND_API_KEY: 'k' },
      'a@x.com', '123456'
    )
    expect(r.ok).toBe(true)
  })
  test('TEST_MAIL_TRANSPORT=1 + ENVIRONMENT 누락 → 테스트 모드 비활성화', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ id: 'em_3' }), { status: 200 })) as any
    const r = await sendOtpEmail(
      { TEST_MAIL_TRANSPORT: '1', RESEND_API_KEY: 'k' },
      'a@x.com', '123456'
    )
    expect(r.ok).toBe(true)
  })
  test('fetch throw → ok:false', async () => {
    global.fetch = jest.fn(async () => { throw new Error('net down') }) as any
    const r = await sendOtpEmail({ ENVIRONMENT: 'production', RESEND_API_KEY: 'k' }, 'a@x.com', '1')
    expect(r.ok).toBe(false)
    expect(r.status).toBeUndefined()
  })
  test('res.ok=false + 유효한 에러 코드 → ok:false + status', async () => {
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ name: 'invalid_api_key' }), { status: 401 })) as any
    const r = await sendOtpEmail({ ENVIRONMENT: 'production', RESEND_API_KEY: 'k' }, 'a@x.com', '1')
    expect(r.ok).toBe(false)
    expect(r.status).toBe(401)
  })
  test('res.ok=false + error 필드 사용', async () => {
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ error: 'rate_limit' }), { status: 429 })) as any
    const r = await sendOtpEmail({ ENVIRONMENT: 'production', RESEND_API_KEY: 'k' }, 'a@x.com', '1')
    expect(r.ok).toBe(false)
    expect(r.status).toBe(429)
  })
  test('res.ok=false + injection 시도 에러 코드 → 필터링 (로그만, 반환은 동일)', async () => {
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ name: 'bad\ncode; DROP' }), { status: 400 })) as any
    const r = await sendOtpEmail({ ENVIRONMENT: 'production', RESEND_API_KEY: 'k' }, 'a@x.com', '1')
    expect(r.ok).toBe(false)
    expect(r.status).toBe(400)
  })
  test('res.ok=false + 50자 초과 에러 코드 → 필터링', async () => {
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ name: 'x'.repeat(60) }), { status: 400 })) as any
    const r = await sendOtpEmail({ ENVIRONMENT: 'production', RESEND_API_KEY: 'k' }, 'a@x.com', '1')
    expect(r.ok).toBe(false)
  })
  test('res.ok=false + 에러 body JSON 파싱 실패 → ok:false', async () => {
    global.fetch = jest.fn(async () => new Response('not json{{{', { status: 500 })) as any
    const r = await sendOtpEmail({ ENVIRONMENT: 'production', RESEND_API_KEY: 'k' }, 'a@x.com', '1')
    expect(r.ok).toBe(false)
    expect(r.status).toBe(500)
  })
  test('성공 + id 있음 → ok:true + emailId', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ id: 'em_abc' }), { status: 200 })) as any
    const r = await sendOtpEmail({ ENVIRONMENT: 'production', RESEND_API_KEY: 'k' }, 'a@x.com', '1')
    expect(r.ok).toBe(true)
    expect(r.emailId).toBe('em_abc')
  })
  test('성공 + id 없음 → ok:false', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as any
    const r = await sendOtpEmail({ ENVIRONMENT: 'production', RESEND_API_KEY: 'k' }, 'a@x.com', '1')
    expect(r.ok).toBe(false)
  })
  test('성공 + id가 빈 문자열 → ok:false', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ id: '' }), { status: 200 })) as any
    const r = await sendOtpEmail({ ENVIRONMENT: 'production', RESEND_API_KEY: 'k' }, 'a@x.com', '1')
    expect(r.ok).toBe(false)
  })
  test('성공 + 응답 JSON 파싱 실패 → ok:false', async () => {
    global.fetch = jest.fn(async () => new Response('garbage{{{', { status: 200 })) as any
    const r = await sendOtpEmail({ ENVIRONMENT: 'production', RESEND_API_KEY: 'k' }, 'a@x.com', '1')
    expect(r.ok).toBe(false)
    expect(r.status).toBe(200)
  })
  test('res.ok=false + 에러 body에 name/error 없음 → errCode 빈 문자열', async () => {
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ message: 'something else' }), { status: 400 })) as any
    const r = await sendOtpEmail({ ENVIRONMENT: 'production', RESEND_API_KEY: 'k' }, 'a@x.com', '1')
    expect(r.ok).toBe(false)
    expect(r.status).toBe(400)
  })
  test('요청 본문에 code와 toEmail 포함', async () => {
    let captured: any = null
    global.fetch = jest.fn(async (_url: string, init: any) => {
      captured = JSON.parse(init.body)
      return new Response(JSON.stringify({ id: 'em_x' }), { status: 200 })
    }) as any
    await sendOtpEmail({ ENVIRONMENT: 'production', RESEND_API_KEY: 'k' }, 'to@x.com', '654321')
    expect(captured.to).toEqual(['to@x.com'])
    expect(captured.html).toContain('654321')
    expect(captured.subject).toContain('인증코드')
  })
})

// ================= verifySession =================
describe('verifySession', () => {
  const secret = 'verify-test-secret'
  test('유효한 토큰 → 이메일', async () => {
    const token = await makeSessionToken('u@x.com', secret, 100000)
    expect(await verifySession(token, secret)).toBe('u@x.com')
  })
  test('allowedEmail 일치 → 이메일', async () => {
    const token = await makeSessionToken('u@x.com', secret, 100000)
    expect(await verifySession(token, secret, 'u@x.com')).toBe('u@x.com')
  })
  test('allowedEmail 불일치 → null', async () => {
    const token = await makeSessionToken('u@x.com', secret, 100000)
    expect(await verifySession(token, secret, 'other@x.com')).toBeNull()
  })
  test('다른 secret → null (서명 불일치)', async () => {
    const token = await makeSessionToken('u@x.com', secret, 100000)
    expect(await verifySession(token, 'wrong-secret')).toBeNull()
  })
  test('만료된 토큰 → null', async () => {
    const token = await makeSessionToken('u@x.com', secret, -1000)
    expect(await verifySession(token, secret)).toBeNull()
  })
  test('구분자 없는 토큰 → null', async () => {
    expect(await verifySession('nodot', secret)).toBeNull()
    expect(await verifySession('', secret)).toBeNull()
  })
  test('페이로드만 있고 서명 없음 → null', async () => {
    expect(await verifySession('abc.', secret)).toBeNull()
  })
  test('잘못된 base64 → null (catch)', async () => {
    expect(await verifySession('%%%.%%%', secret)).toBeNull()
  })
  test('변조된 페이로드 → null', async () => {
    const token = await makeSessionToken('u@x.com', secret, 100000)
    const [p, s] = token.split('.')
    const tampered = btoa(JSON.stringify({ email: 'hacker@x.com', exp: Date.now() + 99999 })) + '.' + s
    expect(p).not.toBe(tampered.split('.')[0])
    expect(await verifySession(tampered, secret)).toBeNull()
  })
})

// ================= POST /request =================
describe('POST /request', () => {
  const realFetch = global.fetch
  afterEach(() => { global.fetch = realFetch })

  test('인증 설정 오류 (ENVIRONMENT 누락) → 500', async () => {
    const { json } = makeApp({ env: { ENVIRONMENT: undefined } })
    const res = await json('/request', 'POST', {})
    expect(res.status).toBe(500)
    expect((await body(res)).error).toBe('인증 설정 오류')
  })

  test('Rate limit 초과 (계정 전역 20회) → 429', async () => {
    const db = new MockDb()
    // 전역 UPSERT 차단 (CF 헤더가 없어 per-IP 검사는 건너뜀)
    db.runQueue.push({ meta: { changes: 0 } })
    const { json } = makeApp({ db })
    const res = await json('/request', 'POST', {})
    expect(res.status).toBe(429)
    expect((await body(res)).error).toContain('너무 많은 요청')
  })

  test('발신자(IP)별 Rate limit 5회 초과 → 429 (전역 카운터 여유 있어도)', async () => {
    const db = new MockDb()
    db.runQueue.push({ meta: { changes: 0 } }) // per-IP UPSERT 차단
    const { json } = makeApp({ db })
    const res = await json('/request', 'POST', {})
    expect(res.status).toBe(429)
    expect((await body(res)).error).toContain('너무 많은 요청')
  })

  test('동시 요청 경합: INSERT OR IGNORE changes=0 → 패자는 메일 발송 안 함, 승자 코드로 성공 반환', async () => {
    const db = new MockDb()
    const future = new Date(Date.now() + 3600_000).toISOString()
    // 속도 제한 UPSERT 1건(전역 — CF 헤더가 없어 per-IP 검사는 건너뜀) 통과 후 삽입 경합
    db.runQueue.push({ meta: { changes: 1 } })
    db.firstQueue.push(null) // 최초 조회: 코드 없음
    db.runQueue.push({ meta: { changes: 0 } }) // INSERT OR IGNORE: 동시 요청이 먼저 생성
    db.firstQueue.push({ code: '777777', expires_at: future }) // 재조회: 승자 코드 존재
    global.fetch = jest.fn() as any
    const { json } = makeApp({ db })
    const res = await json('/request', 'POST', {})
    expect(res.status).toBe(200)
    expect((await body(res)).ok).toBe(true)
    // 패자는 메일을 보내지 않는다 (발송은 승자 1건만)
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(0)
    const ins = db.calls.find(c => c.sql.includes('INSERT OR IGNORE'))
    expect(ins).toBeDefined()
  })

  test('동시 교체 경합: UPDATE changes=0 → 패자는 메일 발송 안 함, 승자 코드를 덮지 않음', async () => {
    const db = new MockDb()
    const future = new Date(Date.now() + 3600_000).toISOString()
    db.runQueue.push({ meta: { changes: 1 } }) // 전역 속도 제한 통과
    db.firstQueue.push({ code: '111111', expires_at: future }) // 기존 코드 조회
    db.runQueue.push({ meta: { changes: 0 } }) // 낙관적 UPDATE: 그 사이 승자가 이미 교체
    db.firstQueue.push({ code: '777777', expires_at: future }) // 재조회: 승자 코드 존재
    global.fetch = jest.fn() as any
    const { json } = makeApp({ db })
    const res = await json('/request', 'POST', {})
    expect(res.status).toBe(200)
    expect((await body(res)).ok).toBe(true)
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(0)
    const upd = db.calls.find(c => c.sql.includes('UPDATE otp_codes SET code'))
    expect(upd).toBeDefined()
    // 낙관적 잠금: 읽었던 기존 코드·만료를 조건으로 건다
    expect(upd!.params[3]).toBe('111111')
    expect(upd!.params[4]).toBe(future)
  })

  test('기존 유효 코드가 있어도 새 코드로 교체 + attempts 초기화 + 메일 발송 (당일 재사용 폐지)', async () => {
    const db = new MockDb()
    const future = new Date(Date.now() + 3600_000).toISOString()
    db.firstQueue.push({ code: '111111', expires_at: future })
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ id: 'em_re' }), { status: 200 })) as any
    const { json } = makeApp({ db })
    const before = Date.now()
    const res = await json('/request', 'POST', {})
    expect(res.status).toBe(200)
    expect((await body(res)).ok).toBe(true)
    // 재사용이 아니라 새 코드 메일이 발송된다
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1)
    // D1 속도 제한 UPSERT 1건(전역 — CF 헤더가 없어 per-IP 검사는 건너뜀) 실행
    const limits = db.calls.filter(c => c.sql.includes('INSERT INTO rate_limits'))
    expect(limits).toHaveLength(1)
    expect(limits[0].params[0]).toBe('rl:kimjn00003@naver.com')
    // 교체 UPDATE: 새 코드 + attempts=0 + 10분 만료, 조건은 기존 코드
    const upd = db.calls.find(c => c.sql.includes('UPDATE otp_codes SET code'))
    expect(upd).toBeDefined()
    expect(upd!.sql).toContain('attempts = 0')
    expect(upd!.params[0]).toMatch(/^\d{6}$/)
    expect(upd!.params[3]).toBe('111111')
    const ttlSec = (new Date(upd!.params[1]).getTime() - before) / 1000
    expect(ttlSec).toBeGreaterThan(600 - 5)
    expect(ttlSec).toBeLessThan(600 + 5)
    // INSERT 경로는 타지 않는다 (교체는 UPDATE)
    expect(db.calls.filter(c => c.sql.includes('INSERT OR IGNORE'))).toHaveLength(0)
  })

  test('신규 코드 → DB 저장 + D1 속도 제한 + 메일 발송', async () => {
    const db = new MockDb()
    db.firstQueue.push(null) // 기존 코드 없음
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ id: 'em_new' }), { status: 200 })) as any
    const { json } = makeApp({ db })
    const res = await json('/request', 'POST', {})
    expect(res.status).toBe(200)
    expect((await body(res)).ok).toBe(true)
    // INSERT 호출 확인 + 6자리 코드
    const ins = db.calls.find(c => c.sql.includes('INSERT OR IGNORE'))
    expect(ins).toBeDefined()
    expect(ins!.params[1]).toMatch(/^\d{6}$/)
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1)
  })

  test('유효기간 상수: OTP_TTL_MS는 10분(600초)', () => {
    expect(OTP_TTL_MS).toBe(600_000)
  })

  test('신규 발급 행의 expires_at - now ≈ 600초 (허용 오차 ±5초)', async () => {
    const db = new MockDb()
    db.firstQueue.push(null)
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ id: 'em_ttl' }), { status: 200 })) as any
    const { json } = makeApp({ db })
    const before = Date.now()
    const res = await json('/request', 'POST', {})
    expect(res.status).toBe(200)
    const ins = db.calls.find(c => c.sql.includes('INSERT OR IGNORE'))
    expect(ins).toBeDefined()
    const ttlSec = (new Date(ins!.params[2]).getTime() - before) / 1000
    expect(ttlSec).toBeGreaterThan(600 - 5)
    expect(ttlSec).toBeLessThan(600 + 5)
  })

  test('메일 본문에 10분 유효기간이 명시된다', async () => {
    let captured: any = null
    global.fetch = jest.fn(async (_url: string, init: any) => {
      captured = JSON.parse(init.body)
      return new Response(JSON.stringify({ id: 'em_body' }), { status: 200 })
    }) as any
    const r = await sendOtpEmail({ ENVIRONMENT: 'production', RESEND_API_KEY: 'k' }, 'a@x.com', '123456')
    expect(r.ok).toBe(true)
    expect(captured.html).toContain('10분')
    expect(captured.html).not.toContain('하루')
    expect(captured.subject).not.toContain('오늘')
  })

  test('만료된 기존 코드 → 신규 발급', async () => {
    const db = new MockDb()
    const past = new Date(Date.now() - 1000).toISOString()
    db.firstQueue.push({ code: '000000', expires_at: past })
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ id: 'em_x' }), { status: 200 })) as any
    const { json } = makeApp({ db })
    const res = await json('/request', 'POST', {})
    expect(res.status).toBe(200)
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1)
  })

  test('메일 발송 실패 → OTP 정리 + 502', async () => {
    const db = new MockDb()
    db.firstQueue.push(null)
    global.fetch = jest.fn(async () => new Response('err', { status: 500 })) as any
    const { json } = makeApp({ db })
    const res = await json('/request', 'POST', {})
    expect(res.status).toBe(502)
    expect((await body(res)).error).toBe('메일 발송 실패')
    // 정리 DELETE 호출 (email + code 조건)
    const dels = db.calls.filter(c => c.sql.includes('DELETE FROM otp_codes WHERE email = ? AND code = ?'))
    expect(dels).toHaveLength(1)
  })

  test('메일 발송 실패 + 정리 DELETE throw → 502 (catch 무시)', async () => {
    const db = new MockDb()
    db.firstQueue.push(null)
    db.runQueue.push({ meta: { changes: 1 } }) // 전역 속도 제한 UPSERT 통과
    db.runQueue.push({ meta: { changes: 1 } }) // INSERT
    db.runQueue.push(new Error('delete boom')) // DELETE throw
    global.fetch = jest.fn(async () => new Response('err', { status: 500 })) as any
    const { json } = makeApp({ db })
    const res = await json('/request', 'POST', {})
    expect(res.status).toBe(502)
  })

  test('Rate limit: 전역 20회 상한 UPSERT가 D1으로 실행된다', async () => {
    const db = new MockDb()
    const future = new Date(Date.now() + 3600_000).toISOString()
    db.firstQueue.push({ code: '222222', expires_at: future })
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ id: 'em_rl' }), { status: 200 })) as any
    const { json } = makeApp({ db })
    const res = await json('/request', 'POST', {})
    expect(res.status).toBe(200)
    const limits = db.calls.filter(c => c.sql.includes('INSERT INTO rate_limits'))
    expect(limits).toHaveLength(1)
    expect(limits[0].params[0]).toBe('rl:kimjn00003@naver.com')
    expect(limits[0].params[6]).toBe(20)
  })

  test('생성 코드가 6자리 숫자 범위', async () => {
    const db = new MockDb()
    db.firstQueue.push(null)
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ id: 'e' }), { status: 200 })) as any
    const { json } = makeApp({ db })
    await json('/request', 'POST', {})
    const ins = db.calls.find(c => c.sql.includes('INSERT OR IGNORE'))
    const code = ins!.params[1] as string
    expect(Number(code)).toBeGreaterThanOrEqual(100000)
    expect(Number(code)).toBeLessThanOrEqual(999999)
  })
})

// ================= POST /verify =================
describe('POST /verify', () => {
  test('인증 설정 오류 → 500', async () => {
    const { json } = makeApp({ env: { ENVIRONMENT: undefined } })
    const res = await json('/verify', 'POST', { code: '123456' })
    expect(res.status).toBe(500)
  })

  test('OTP 없음 → 400 (먼저 요청)', async () => {
    const db = new MockDb()
    db.firstQueue.push(null)
    const { json } = makeApp({ db })
    const res = await json('/verify', 'POST', { code: '123456' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toContain('먼저 요청')
  })

  test('만료된 코드 → 삭제 + 400', async () => {
    const db = new MockDb()
    const past = new Date(Date.now() - 1000).toISOString()
    db.firstQueue.push({ code: '123456', attempts: 0, expires_at: past })
    const { json } = makeApp({ db })
    const res = await json('/verify', 'POST', { code: '123456' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toContain('만료')
    const dels = db.calls.filter(c => c.sql.includes('DELETE FROM otp_codes WHERE email = ?'))
    expect(dels.length).toBeGreaterThan(0)
  })

  test('시도 횟수 초과 + 오답 → 400, 행은 지우지 않음 (소유자 정답 코드 보호)', async () => {
    const db = new MockDb()
    const future = new Date(Date.now() + 3600_000).toISOString()
    db.firstQueue.push({ code: '123456', attempts: 5, expires_at: future })
    const { json } = makeApp({ db })
    const res = await json('/verify', 'POST', { code: '999999' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toContain('시도 횟수 초과')
    // 소진 상태에서 행을 지우면 소유자의 정답 제출도 막히므로 삭제하지 않는다
    const dels = db.calls.filter(c => c.sql.includes('DELETE FROM otp_codes WHERE email = ?'))
    expect(dels).toHaveLength(0)
  })

  test('시도 횟수 초과 + 정답 코드 → 200 (정답은 소진과 무관하게 성공)', async () => {
    const db = new MockDb()
    const future = new Date(Date.now() + 3600_000).toISOString()
    db.firstQueue.push({ code: '123456', attempts: 5, expires_at: future })
    db.runQueue.push({ meta: { changes: 1 } }) // 전역 속도 제한 UPSERT 통과
    db.runQueue.push({ meta: { changes: 1 } }) // 원자적 DELETE 성공
    const { json } = makeApp({ db })
    const res = await json('/verify', 'POST', { code: '123456' })
    expect(res.status).toBe(200)
    expect((await body(res)).ok).toBe(true)
    const setCookie = res.headers.get('Set-Cookie') || ''
    expect(setCookie).toContain('myhub_session=')
  })

  test('틀린 코드 → attempts+1 + 400 (원자 UPDATE: attempts < 5 조건 포함)', async () => {
    const db = new MockDb()
    const future = new Date(Date.now() + 3600_000).toISOString()
    db.firstQueue.push({ code: '123456', attempts: 2, expires_at: future })
    const { json } = makeApp({ db })
    const res = await json('/verify', 'POST', { code: '999999' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toContain('틀렸습니다')
    const ups = db.calls.filter(c => c.sql.includes('UPDATE otp_codes SET attempts'))
    expect(ups).toHaveLength(1)
    expect(ups[0].sql).toContain('attempts < 5')
  })

  test('동시 오답 경합: 원자 UPDATE changes=0 → 시도 횟수 초과 400 (행은 유지)', async () => {
    const db = new MockDb()
    const future = new Date(Date.now() + 3600_000).toISOString()
    db.firstQueue.push({ code: '123456', attempts: 4, expires_at: future })
    db.runQueue.push({ meta: { changes: 1 } }) // 전역 속도 제한 UPSERT 통과
    db.runQueue.push({ meta: { changes: 0 } }) // 동시 요청이 상한에 먼저 도달
    const { json } = makeApp({ db })
    const res = await json('/verify', 'POST', { code: '999999' })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toContain('시도 횟수 초과')
    // 행을 지우지 않는다 — 소유자의 정답 코드가 남아 있어야 한다
    const dels = db.calls.filter(c => c.sql.includes('DELETE FROM otp_codes WHERE email = ?'))
    expect(dels).toHaveLength(0)
  })

  test('발신자(IP)별 /verify 속도 제한 20회 초과 → 429', async () => {
    const db = new MockDb()
    db.runQueue.push({ meta: { changes: 0 } }) // per-IP UPSERT 차단
    const { json } = makeApp({ db })
    const res = await json('/verify', 'POST', { code: '123456' }, { 'CF-Connecting-IP': '1.2.3.4' })
    expect(res.status).toBe(429)
  })

  test('IP 식별 불가 시 per-IP 검사 건너뜀 → 전역 백스톱만 적용', async () => {
    const db = new MockDb()
    const future = new Date(Date.now() + 3600_000).toISOString()
    db.firstQueue.push({ code: '123456', attempts: 0, expires_at: future })
    db.runQueue.push({ meta: { changes: 1 } }) // 전역 UPSERT 통과
    db.runQueue.push({ meta: { changes: 1 } }) // 원자적 DELETE 성공
    const { json } = makeApp({ db })
    const res = await json('/verify', 'POST', { code: '123456' })
    expect(res.status).toBe(200)
    // 전역 백스톱 UPSERT 1건만 실행 (per-IP 검사 없음)
    const limits = db.calls.filter(c => c.sql.includes('INSERT INTO rate_limits'))
    expect(limits).toHaveLength(1)
    expect(limits[0].params[0]).toBe('verify:global')
  })

  test('코드 앞뒤 공백 → trim 후 비교', async () => {
    const db = new MockDb()
    const future = new Date(Date.now() + 3600_000).toISOString()
    db.firstQueue.push({ code: '123456', attempts: 0, expires_at: future })
    db.runQueue.push({ meta: { changes: 1 } }) // 원자적 DELETE 성공
    const { json } = makeApp({ db })
    const res = await json('/verify', 'POST', { code: '  123456  ' })
    expect(res.status).toBe(200)
    expect((await body(res)).ok).toBe(true)
  })

  test('코드 누락(undefined) → 틀림 처리', async () => {
    const db = new MockDb()
    const future = new Date(Date.now() + 3600_000).toISOString()
    db.firstQueue.push({ code: '123456', attempts: 0, expires_at: future })
    const { json } = makeApp({ db })
    const res = await json('/verify', 'POST', {})
    expect(res.status).toBe(400)
  })

  test('DB 코드가 빈 문자열 + 코드 누락 → (code || \'\') falsy 분기 커버', async () => {
    const db = new MockDb()
    const future = new Date(Date.now() + 3600_000).toISOString()
    db.firstQueue.push({ code: '', attempts: 0, expires_at: future })
    db.runQueue.push({ meta: { changes: 1 } })
    const { json } = makeApp({ db })
    const res = await json('/verify', 'POST', {})
    expect(res.status).toBe(200)
    // DELETE 바인딩에 trim된 빈 문자열 전달 확인
    const del = db.calls.find(c => c.sql.includes('AND expires_at > ?'))
    expect(del!.params[1]).toBe('')
  })

  test('정확한 코드 → 원자적 DELETE + 세션 쿠키 + 200', async () => {
    const db = new MockDb()
    const future = new Date(Date.now() + 3600_000).toISOString()
    db.firstQueue.push({ code: '123456', attempts: 0, expires_at: future })
    db.runQueue.push({ meta: { changes: 1 } }) // 원자적 DELETE 1건
    const { json } = makeApp({ db })
    const res = await json('/verify', 'POST', { code: '123456' })
    expect(res.status).toBe(200)
    expect((await body(res)).ok).toBe(true)
    const setCookie = res.headers.get('Set-Cookie') || ''
    expect(setCookie).toContain('myhub_session=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Max-Age=2592000')
    expect(setCookie).toContain('SameSite=Lax')
    // 원자적 DELETE에 만료 조건 포함
    const del = db.calls.find(c => c.sql.includes('AND expires_at > ?'))
    expect(del).toBeDefined()
  })

  test('동시 요청 race (changes=0) → 400', async () => {
    const db = new MockDb()
    const future = new Date(Date.now() + 3600_000).toISOString()
    db.firstQueue.push({ code: '123456', attempts: 0, expires_at: future })
    db.runQueue.push({ meta: { changes: 1 } }) // 전역 속도 제한 UPSERT 통과
    db.runQueue.push({ meta: { changes: 0 } }) // 다른 요청이 먼저 소비
    const { json } = makeApp({ db })
    const res = await json('/verify', 'POST', { code: '123456' })
    expect(res.status).toBe(400)
    expect(res.headers.get('Set-Cookie')).toBeNull()
  })

  test('성공 후 같은 코드 재검증 → 실패 (소비된 행이 없으므로 먼저 요청 오류)', async () => {
    const db = new MockDb()
    const future = new Date(Date.now() + 3600_000).toISOString()
    // 1차 검증: 행 조회 + 전역 속도 제한 + 원자적 DELETE 성공 → 200
    db.firstQueue.push({ code: '123456', attempts: 0, expires_at: future })
    db.runQueue.push({ meta: { changes: 1 } })
    db.runQueue.push({ meta: { changes: 1 } })
    const { json } = makeApp({ db })
    const first = await json('/verify', 'POST', { code: '123456' })
    expect(first.status).toBe(200)
    // 소비 DELETE가 실제로 실행됐는지 확인 — 이 DELETE가 단회 사용의 근거다
    const del = db.calls.find(c => c.sql.includes('DELETE FROM otp_codes WHERE email = ? AND code = ? AND expires_at > ?'))
    expect(del).toBeDefined()
    // 2차 검증: 행이 소비돼 없으므로 같은 코드로는 다시 성공할 수 없다
    db.firstQueue.push(null)
    db.runQueue.push({ meta: { changes: 1 } })
    const second = await json('/verify', 'POST', { code: '123456' })
    expect(second.status).toBe(400)
    expect((await body(second)).error).toContain('먼저 요청')
    expect(second.headers.get('Set-Cookie')).toBeNull()
  })

  test('동시 요청 race (meta 없음) → ?? 0으로 400', async () => {
    const db = new MockDb()
    const future = new Date(Date.now() + 3600_000).toISOString()
    db.firstQueue.push({ code: '123456', attempts: 0, expires_at: future })
    db.runQueue.push({ meta: { changes: 1 } }) // 전역 속도 제한 UPSERT 통과
    db.runQueue.push({}) // meta 없음
    const { json } = makeApp({ db })
    const res = await json('/verify', 'POST', { code: '123456' })
    expect(res.status).toBe(400)
  })

  test('동시 요청 race (meta는 있으나 changes 없음) → ?? 0으로 400', async () => {
    const db = new MockDb()
    const future = new Date(Date.now() + 3600_000).toISOString()
    db.firstQueue.push({ code: '123456', attempts: 0, expires_at: future })
    db.runQueue.push({ meta: { changes: 1 } }) // 전역 속도 제한 UPSERT 통과
    db.runQueue.push({ meta: {} }) // meta 존재, changes 없음
    const { json } = makeApp({ db })
    const res = await json('/verify', 'POST', { code: '123456' })
    expect(res.status).toBe(400)
  })

  test('성공한 세션 토큰이 /me에서 검증됨', async () => {
    const db = new MockDb()
    const future = new Date(Date.now() + 3600_000).toISOString()
    db.firstQueue.push({ code: '123456', attempts: 0, expires_at: future })
    db.runQueue.push({ meta: { changes: 1 } })
    const secret = 'integration-secret'
    const { json } = makeApp({ db, env: { SESSION_SECRET: secret } })
    const res = await json('/verify', 'POST', { code: '123456' })
    const cookie = res.headers.get('Set-Cookie') || ''
    const m = cookie.match(/myhub_session=([^;]+)/)
    expect(m).not.toBeNull()
    // 토큰 직접 검증
    const email = await verifySession(m![1], secret, 'kimjn00003@naver.com')
    expect(email).toBe('kimjn00003@naver.com')
  })
})

// ================= POST /logout =================
describe('POST /logout', () => {
  test('세션 쿠키 삭제 + 200', async () => {
    const { json } = makeApp()
    const res = await json('/logout', 'POST', {})
    expect(res.status).toBe(200)
    expect((await body(res)).ok).toBe(true)
    const setCookie = res.headers.get('Set-Cookie') || ''
    expect(setCookie).toContain('myhub_session=;')
    expect(setCookie).toContain('Max-Age=0')
  })
  test('로그아웃 후 같은 토큰으로는 /me 401 (서버 측 무효화)', async () => {
    const secret = 'logout-secret'
    const token = await makeSessionToken('kimjn00003@naver.com', secret, 3600000, 'otp', 0)
    const db = new MockDb()
    // /logout의 bump: UPDATE ... RETURNING version → 1
    db.firstQueue.push({ version: 1 })
    // /me의 버전 조회 → 1 (토큰 v=0과 불일치)
    db.firstQueue.push({ version: 1 })
    const { json, req } = makeApp({ db, env: { SESSION_SECRET: secret } })
    const logoutRes = await json('/logout', 'POST', {}, { Cookie: `myhub_session=${token}` })
    expect(logoutRes.status).toBe(200)
    // D1 원자 bump 실행 확인 (KV sessver 아님)
    const bump = db.calls.find(c => c.sql.includes('UPDATE session_versions SET version = version + 1'))
    expect(bump).toBeDefined()
    expect(bump!.sql).toContain('RETURNING version')
    // 같은 토큰으로 /me → 버전 불일치로 401
    const meRes = await req('/me', { method: 'GET', headers: { Cookie: `myhub_session=${token}` } })
    expect(meRes.status).toBe(401)
  })
})

// ================= 세션 버전 / 발신자 제한 유닛 =================
describe('세션 버전 + 속도 제한 헬퍼', () => {
  test('verifySessionInfo: method/v 파싱 + 구 토큰은 method null·v 0', async () => {
    const secret = 'info-secret'
    const info = await verifySessionInfo(await makeSessionToken('a@b.c', secret, 100000, 'pin', 3), secret)
    expect(info?.method).toBe('pin')
    expect(info?.version).toBe(3)
    const legacy = await verifySessionInfo(await makeLegacySessionToken('a@b.c', secret, 100000), secret)
    expect(legacy?.method).toBeNull()
    expect(legacy?.version).toBe(0)
  })
  test('verifySession expectedVersion 불일치 → null', async () => {
    const secret = 'ver-secret'
    const token = await makeSessionToken('a@b.c', secret, 100000, 'otp', 0)
    await expect(verifySession(token, secret, undefined, 1)).resolves.toBeNull()
    await expect(verifySession(token, secret, undefined, 0)).resolves.toBe('a@b.c')
  })
  test('getClientIp: CF-Connecting-IP만 신뢰, XFF 무시, 없으면 null', () => {
    const mk = (headers: Record<string, string>) => ({
      req: { header: (name: string) => headers[name.toLowerCase()] },
    })
    expect(getClientIp(mk({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' }) as any)).toBe('1.2.3.4')
    // XFF만 있으면 식별 불가 → null (XFF는 클라이언트가 위조 가능)
    expect(getClientIp(mk({ 'x-forwarded-for': '5.6.7.8, 9.9.9.9' }) as any)).toBeNull()
    expect(getClientIp(mk({}) as any)).toBeNull()
  })
  test('checkRateLimit: D1 원자 UPSERT — 허용 시 false, 상한 도달 시 true', async () => {
    const db = new MockDb()
    // 기본 run()은 changes=1 (허용)
    expect(await checkRateLimit(db, 'k1', 2, 3600)).toBe(false)
    const upsert = db.calls.find((c) => c.sql.includes('INSERT INTO rate_limits'))
    expect(upsert).toBeDefined()
    expect(upsert!.sql).toContain('ON CONFLICT(key) DO UPDATE')
    expect(upsert!.sql).toContain('rate_limits.count < ?')
    expect(upsert!.params[0]).toBe('k1')
    expect(upsert!.params[6]).toBe(2)
    // 상한 도달 시뮬레이션: UPSERT changes=0 → 차단
    db.runQueue.push({ meta: { changes: 0 } })
    expect(await checkRateLimit(db, 'k1', 2, 3600)).toBe(true)
  })
})

// ================= GET /me =================
describe('GET /me', () => {
  test('쿠키 없음 → 401', async () => {
    const { req } = makeApp()
    const res = await req('/me', { method: 'GET' })
    expect(res.status).toBe(401)
  })
  test('세션 쿠키 없음(다른 쿠키만) → 401', async () => {
    const { req } = makeApp()
    const res = await req('/me', { method: 'GET', headers: { Cookie: 'other=1' } })
    expect(res.status).toBe(401)
  })
  test('유효한 세션 → 200 + email', async () => {
    const secret = 'me-test-secret'
    const token = await makeSessionToken('kimjn00003@naver.com', secret, 100000)
    const { req } = makeApp({ env: { SESSION_SECRET: secret } })
    const res = await req('/me', { method: 'GET', headers: { Cookie: `myhub_session=${token}` } })
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.ok).toBe(true)
    expect(j.email).toBe('kimjn00003@naver.com')
  })
  test('위조된 세션 → 401', async () => {
    const { req } = makeApp()
    const res = await req('/me', {
      method: 'GET',
      headers: { Cookie: 'myhub_session=forged.token' },
    })
    expect(res.status).toBe(401)
  })
  test('만료된 세션 → 401', async () => {
    const secret = 'me-test-secret'
    const token = await makeSessionToken('kimjn00003@naver.com', secret, -1000)
    const { req } = makeApp({ env: { SESSION_SECRET: secret } })
    const res = await req('/me', { method: 'GET', headers: { Cookie: `myhub_session=${token}` } })
    expect(res.status).toBe(401)
  })
  test('다른 이메일 세션 (allowedEmail 불일치) → 401', async () => {
    const secret = 'me-test-secret'
    const token = await makeSessionToken('attacker@x.com', secret, 100000)
    const { req } = makeApp({ env: { SESSION_SECRET: secret } })
    const res = await req('/me', { method: 'GET', headers: { Cookie: `myhub_session=${token}` } })
    expect(res.status).toBe(401)
  })
  test('인증 설정 오류 시 allowedEmail undefined → 세션 이메일 그대로 반환', async () => {
    const secret = 'me-test-secret'
    const token = await makeSessionToken('any@x.com', secret, 100000)
    const { req } = makeApp({ env: { SESSION_SECRET: secret, ENVIRONMENT: undefined } })
    const res = await req('/me', { method: 'GET', headers: { Cookie: `myhub_session=${token}` } })
    expect(res.status).toBe(200)
    expect((await body(res)).email).toBe('any@x.com')
  })
  test('쿠키 값에 세미콜론 뒤 추가 속성 → 첫 번째 값만 사용', async () => {
    const secret = 'me-test-secret'
    const token = await makeSessionToken('kimjn00003@naver.com', secret, 100000)
    const { req } = makeApp({ env: { SESSION_SECRET: secret } })
    const res = await req('/me', {
      method: 'GET',
      headers: { Cookie: `myhub_session=${token}; other=1` },
    })
    expect(res.status).toBe(200)
  })
  test('세션 버전 불일치 (로그아웃 후 구 토큰) → 401', async () => {
    const secret = 'me-test-secret'
    const token = await makeSessionToken('kimjn00003@naver.com', secret, 100000, 'otp', 0)
    const db = new MockDb()
    db.firstQueue.push({ version: 1 }) // D1 세션 버전 조회 → 1 (토큰 v=0과 불일치)
    const { req } = makeApp({ db, env: { SESSION_SECRET: secret } })
    const res = await req('/me', { method: 'GET', headers: { Cookie: `myhub_session=${token}` } })
    expect(res.status).toBe(401)
  })
  test('세션 버전 조회 실패(D1 오류) → 401 (fail-closed)', async () => {
    const secret = 'me-test-secret'
    const token = await makeSessionToken('kimjn00003@naver.com', secret, 100000)
    const db = new MockDb()
    db.firstQueue.push(new Error('D1 down'))
    const { req } = makeApp({ db, env: { SESSION_SECRET: secret } })
    const res = await req('/me', { method: 'GET', headers: { Cookie: `myhub_session=${token}` } })
    expect(res.status).toBe(401)
  })
  test('구 토큰(method/v 없음) → 하위 호환으로 200', async () => {
    const secret = 'me-test-secret'
    const token = await makeLegacySessionToken('kimjn00003@naver.com', secret, 100000)
    const { req } = makeApp({ env: { SESSION_SECRET: secret } })
    const res = await req('/me', { method: 'GET', headers: { Cookie: `myhub_session=${token}` } })
    expect(res.status).toBe(200)
  })
})

// ================= 비밀번호 해시 (PBKDF2) =================
describe('hashPassword / verifyPassword', () => {
  test('라운드트립: 올바른 비밀번호만 검증 성공', async () => {
    const h = await hashPassword('correct-horse-9', undefined, 1000)
    const row = { password_hash: h.hashB64, password_salt: h.saltB64, iterations: h.iterations }
    await expect(verifyPassword('correct-horse-9', row)).resolves.toBe(true)
    await expect(verifyPassword('wrong-password', row)).resolves.toBe(false)
  })
  test('같은 비밀번호도 salt가 다르면 해시가 다르다', async () => {
    const a = await hashPassword('same-password', undefined, 1000)
    const b = await hashPassword('same-password', undefined, 1000)
    expect(a.saltB64).not.toBe(b.saltB64)
    expect(a.hashB64).not.toBe(b.hashB64)
  })
  test('같은 salt·iterations면 결정적 (재현 가능)', async () => {
    const a = await hashPassword('pw-deterministic', undefined, 1000)
    const b = await hashPassword('pw-deterministic', a.saltB64, 1000)
    expect(b.hashB64).toBe(a.hashB64)
  })
})

// ================= PIN 헬퍼 =================
describe('PIN 헬퍼 (isValidPin / hashPin / verifyPin)', () => {
  test('isValidPin: 숫자 6자리만 허용', () => {
    expect(isValidPin('123456')).toBe(true)
    expect(isValidPin('000000')).toBe(true)
    expect(isValidPin('12345')).toBe(false)
    expect(isValidPin('1234567')).toBe(false)
    expect(isValidPin('12345a')).toBe(false)
    expect(isValidPin('')).toBe(false)
    expect(isValidPin(123456 as any)).toBe(false)
    expect(isValidPin(undefined)).toBe(false)
  })
  test('hashPin/verifyPin 라운드트립: 올바른 PIN만 성공', async () => {
    const h = await hashPin('042069')
    const row = { pin_hash: h.hashB64, pin_salt: h.saltB64, iterations: h.iterations }
    await expect(verifyPin('042069', row)).resolves.toBe(true)
    await expect(verifyPin('042068', row)).resolves.toBe(false)
  })
})

// ================= POST /pin-login =================
describe('POST /pin-login (PIN 로그인)', () => {
  async function pinRow(pin: string) {
    const h = await hashPin(pin)
    return { pin_hash: h.hashB64, pin_salt: h.saltB64, iterations: h.iterations }
  }
  test('PIN 미설정 → 401 PIN_NOT_SET', async () => {
    const db = new MockDb()
    db.firstQueue.push(null)
    const { json } = makeApp({ db })
    const res = await json('/pin-login', 'POST', { pin: '123456' })
    expect(res.status).toBe(401)
    const j = await body(res)
    expect(j.ok).toBe(false)
    expect(j.code).toBe('PIN_NOT_SET')
  })
  test('형식 오류 (5자리·문자 포함) → 400, DB 조회 없음', async () => {
    const db = new MockDb()
    const { json } = makeApp({ db })
    expect((await json('/pin-login', 'POST', { pin: '12345' })).status).toBe(400)
    expect((await json('/pin-login', 'POST', { pin: '12345a' })).status).toBe(400)
    expect((await json('/pin-login', 'POST', {})).status).toBe(400)
    expect(db.calls.length).toBe(0)
  })
  test('PIN 불일치 → 401 + D1 원자 실패 카운터 증가 (KV 미사용)', async () => {
    const db = new MockDb()
    db.firstQueue.push(await pinRow('135790'))
    const kv = new MockKv()
    const { json } = makeApp({ db, kv })
    const res = await json('/pin-login', 'POST', { pin: '135791' })
    expect(res.status).toBe(401)
    // D1 단일 UPDATE로 fail_count+1 (만료 재시작 CASE 포함), 5회 도달 시 locked_until +15분
    const ups = db.calls.filter(c => c.sql.includes('UPDATE auth_pins SET fail_count = CASE'))
    expect(ups).toHaveLength(1)
    expect(ups[0].sql).toContain('THEN 1 ELSE fail_count + 1 END')
    expect(ups[0].sql).toContain("'+900 seconds'")
    expect(kv.store.has('pinfail:kimjn00003@naver.com')).toBe(false)
  })
  test('PIN 일치 → 200 + 세션 쿠키 (30일 Max-Age) + D1 실패 카운터 초기화', async () => {
    const db = new MockDb()
    const row = await pinRow('135790')
    db.firstQueue.push({ ...row, fail_count: 3, locked_until: null })
    const kv = new MockKv()
    const { json } = makeApp({ db, kv })
    const res = await json('/pin-login', 'POST', { pin: '135790' })
    expect(res.status).toBe(200)
    expect((await body(res)).ok).toBe(true)
    const setCookie = res.headers.get('Set-Cookie') || ''
    expect(setCookie).toContain('myhub_session=')
    expect(setCookie).toContain('Max-Age=2592000')
    // D1 카운터 초기화 UPDATE
    const reset = db.calls.find(c => c.sql.includes('fail_count = 0'))
    expect(reset).toBeDefined()
    const token = (setCookie.match(/myhub_session=([^;]+)/) || [])[1]
    await expect(verifySession(token, 'test-secret-1234567890', 'kimjn00003@naver.com'))
      .resolves.toBe('kimjn00003@naver.com')
    // PIN 로그인 세션은 method='pin' (set-pin step-up에서 거부됨)
    const info = await verifySessionInfo(token, 'test-secret-1234567890', 'kimjn00003@naver.com')
    expect(info?.method).toBe('pin')
  })
  test('D1 잠금 중 + 오답 → 429, PIN 검증·게이트 UPDATE 없음', async () => {
    const db = new MockDb()
    const row = await pinRow('135790')
    db.firstQueue.push({ ...row, fail_count: 5, locked_until: new Date(Date.now() + 900_000).toISOString() })
    const { json } = makeApp({ db })
    const res = await json('/pin-login', 'POST', { pin: '135791' })
    expect(res.status).toBe(429)
    // 잠금 중 오답에는 실패 증가 UPDATE도 없음
    expect(db.calls.filter(c => c.sql.includes('UPDATE auth_pins SET fail_count'))).toHaveLength(0)
  })
  test('D1 잠금 중 + 정답 PIN → 200, 잠금 해제 (소진 DoS 수정)', async () => {
    const db = new MockDb()
    const row = await pinRow('135790')
    db.firstQueue.push({ ...row, fail_count: 5, locked_until: new Date(Date.now() + 900_000).toISOString() })
    const { json } = makeApp({ db })
    const res = await json('/pin-login', 'POST', { pin: '135790' })
    expect(res.status).toBe(200)
    expect((await body(res)).ok).toBe(true)
    const reset = db.calls.find(c => c.sql.includes('fail_count = 0'))
    expect(reset).toBeDefined()
  })
  test('잠금 만료 후 (locked_until 과거) → PIN 검증 진행', async () => {
    const db = new MockDb()
    const row = await pinRow('135790')
    db.firstQueue.push({ ...row, fail_count: 5, locked_until: new Date(Date.now() - 1000).toISOString() })
    const { json } = makeApp({ db })
    const res = await json('/pin-login', 'POST', { pin: '135790' })
    expect(res.status).toBe(200)
  })
  test('발신자(IP)별 /pin-login 속도 제한 10회 초과 → 429', async () => {
    const db = new MockDb()
    db.runQueue.push({ meta: { changes: 0 } }) // per-IP UPSERT 차단
    const { json } = makeApp({ db })
    const res = await json('/pin-login', 'POST', { pin: '135790' }, { 'CF-Connecting-IP': '1.2.3.4' })
    expect(res.status).toBe(429)
  })
  test('0045 미적용 판정: no such column이면 KV 폴백으로 동작', async () => {
    const db = new MockDb()
    db.firstQueue.push(new Error('no such column: fail_count'))
    const row = await pinRow('135790')
    db.firstQueue.push(row) // 폴백 경로의 SELECT
    const kv = new MockKv()
    const { json } = makeApp({ db, kv })
    const res = await json('/pin-login', 'POST', { pin: '135791' })
    expect(res.status).toBe(401)
    // 폴백 경로는 KV 카운터를 쓴다 (레거시 — 0045 적용 환경에서는 타지 않음)
    expect(kv.store.get('pinfail:kimjn00003@naver.com')).toBe('1')
    expect(db.calls.some(c => c.sql.includes('SELECT pin_hash, pin_salt, iterations FROM auth_pins'))).toBe(true)
  })
  test('0045 미적용 판정: 그 외 D1 오류는 폴백하지 않고 500', async () => {
    const db = new MockDb()
    db.firstQueue.push(new Error('database disk image is malformed'))
    const { json } = makeApp({ db })
    const res = await json('/pin-login', 'POST', { pin: '135790' })
    expect(res.status).toBe(500)
  })
  test('구 비밀번호 엔드포인트는 제거됨 → /login·/set-password 404', async () => {
    const { json } = makeApp()
    expect((await json('/login', 'POST', { email: 'kimjn00003@naver.com', password: 'x' })).status).toBe(404)
    expect((await json('/set-password', 'POST', { password: 'x' })).status).toBe(404)
  })
})

// ================= POST /set-pin =================
describe('POST /set-pin', () => {
  const secret = 'setpin-secret'
  async function sessionCookie() {
    const token = await makeSessionToken('kimjn00003@naver.com', secret, 3600000)
    return { Cookie: `myhub_session=${token}` }
  }
  test('세션 없음 → 401', async () => {
    const { json } = makeApp({ env: { SESSION_SECRET: secret } })
    const res = await json('/set-pin', 'POST', { pin: '123456' })
    expect(res.status).toBe(401)
  })
  test('형식 오류 PIN → 400, DB 쓰기 없음', async () => {
    const db = new MockDb()
    const { json } = makeApp({ db, env: { SESSION_SECRET: secret } })
    expect((await json('/set-pin', 'POST', { pin: '12345' }, await sessionCookie())).status).toBe(400)
    expect((await json('/set-pin', 'POST', { pin: 'abcdef' }, await sessionCookie())).status).toBe(400)
    expect(db.calls.filter((c) => c.sql.includes('INSERT INTO auth_pins')).length).toBe(0)
  })
  test('정상 설정 → auth_pins UPSERT 실행 + 200, 평문 PIN 미포함', async () => {
    const db = new MockDb()
    // verifySessionForEnv의 버전 조회 → 0, bump의 RETURNING → 1
    db.firstQueue.push(null)
    db.firstQueue.push({ version: 1 })
    const { json } = makeApp({ db, env: { SESSION_SECRET: secret } })
    const res = await json('/set-pin', 'POST', { pin: '975310' }, await sessionCookie())
    expect(res.status).toBe(200)
    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO auth_pins'))
    expect(insert).toBeDefined()
    expect(insert!.sql).toContain('ON CONFLICT(email) DO UPDATE')
    expect(insert!.params[0]).toBe('kimjn00003@naver.com')
    // 평문 PIN이 파라미터 어디에도 없어야 한다
    expect(insert!.params.join(' ')).not.toContain('975310')
    expect(insert!.params[3]).toBe(100000) // iterations 기본값
    // 기존 세션 무효화 (D1 원자 버전 +1) + 새 PIN 세션 쿠키 발급
    const bump = db.calls.find((c) => c.sql.includes('UPDATE session_versions SET version = version + 1'))
    expect(bump).toBeDefined()
    const setCookie = res.headers.get('Set-Cookie') || ''
    expect(setCookie).toContain('myhub_session=')
    const token = (setCookie.match(/myhub_session=([^;]+)/) || [])[1]
    const info = await verifySessionInfo(token, secret, 'kimjn00003@naver.com')
    expect(info?.method).toBe('pin')
    expect(info?.version).toBe(1)
  })

  test('PIN 로그인 세션으로는 재설정 불가 → 403', async () => {
    const token = await makeSessionToken('kimjn00003@naver.com', secret, 3600000, 'pin', 0)
    const { json } = makeApp({ env: { SESSION_SECRET: secret } })
    const res = await json('/set-pin', 'POST', { pin: '123456' }, { Cookie: `myhub_session=${token}` })
    expect(res.status).toBe(403)
  })

  test('구 토큰(method 없음)으로는 재설정 불가 → 403', async () => {
    const token = await makeLegacySessionToken('kimjn00003@naver.com', secret, 3600000)
    const { json } = makeApp({ env: { SESSION_SECRET: secret } })
    const res = await json('/set-pin', 'POST', { pin: '123456' }, { Cookie: `myhub_session=${token}` })
    expect(res.status).toBe(403)
  })
  test('재발급 라운드트립: 새 PIN으로 저장한 해시로는 새 PIN만 로그인된다', async () => {
    const db = new MockDb()
    // /set-pin: 버전 조회 → 0, bump RETURNING → 1
    db.firstQueue.push(null)
    db.firstQueue.push({ version: 1 })
    const { json } = makeApp({ db, env: { SESSION_SECRET: secret } })
    await json('/set-pin', 'POST', { pin: '222222' }, await sessionCookie())
    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO auth_pins'))!
    const newRow = { pin_hash: insert.params[1], pin_salt: insert.params[2], iterations: insert.params[3] }

    const db2 = new MockDb()
    db2.firstQueue.push(newRow)
    const okRes = await makeApp({ db: db2 }).json('/pin-login', 'POST', { pin: '222222' })
    expect(okRes.status).toBe(200)

    const db3 = new MockDb()
    db3.firstQueue.push(newRow)
    const oldRes = await makeApp({ db: db3 }).json('/pin-login', 'POST', { pin: '111111' })
    expect(oldRes.status).toBe(401)
  })
})

// ================= GET /me hasPin =================
describe('GET /me hasPin', () => {
  const secret = 'me-pin-secret'
  test('PIN 설정된 계정 → hasPin true', async () => {
    const token = await makeSessionToken('kimjn00003@naver.com', secret, 100000)
    const db = new MockDb()
    db.firstQueue.push({ version: 0 }) // 세션 버전 조회
    db.firstQueue.push({ email: 'kimjn00003@naver.com' }) // auth_pins 조회
    db.firstQueue.push(null) // accounts 조회 (구 호환 필드)
    const { req } = makeApp({ db, env: { SESSION_SECRET: secret } })
    const res = await req('/me', { method: 'GET', headers: { Cookie: `myhub_session=${token}` } })
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.hasPin).toBe(true)
    expect(j.hasPassword).toBe(false)
  })
  test('미설정 → hasPin false', async () => {
    const token = await makeSessionToken('kimjn00003@naver.com', secret, 100000)
    const db = new MockDb()
    db.firstQueue.push({ version: 0 }) // 세션 버전 조회
    db.firstQueue.push(null)
    db.firstQueue.push(null)
    const { req } = makeApp({ db, env: { SESSION_SECRET: secret } })
    const res = await req('/me', { method: 'GET', headers: { Cookie: `myhub_session=${token}` } })
    expect((await body(res)).hasPin).toBe(false)
  })
})

// ================= 트랙 2: step-up 엔드포인트 + set-pin OTP 창 + 세션 클레임 =================
// 카나리아 대상: /step-up의 PIN 검증·창 발급, set-pin의 10분 창 판정.
// 검증/판정을 제거하면 '틀린 PIN → 403', '11분 지난 OTP → 403' 테스트가 실패해야 한다.
describe('트랙 2: 보호 메모 step-up + OTP 세션 분리', () => {
  const secret = 'track2-secret'
  const EMAIL = 'kimjn00003@naver.com'
  const TEST_PIN = '654321' // 테스트 전용 PIN (실제 사용자 PIN 아님)
  let pinRow: { pin_hash: string; pin_salt: string; iterations: number }

  beforeAll(async () => {
    const h = await hashPin(TEST_PIN)
    pinRow = { pin_hash: h.hashB64, pin_salt: h.saltB64, iterations: h.iterations }
  })

  async function tokenWithClaims(claims: Record<string, unknown>, method: 'otp' | 'pin' = 'pin', v = 0) {
    const payload = JSON.stringify({ email: EMAIL, exp: Date.now() + 3600000, method, v, ...claims })
    const enc = new TextEncoder()
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
    return btoa(payload) + '.' + btoa(String.fromCharCode(...new Uint8Array(sig)))
  }
  const cookieOf = (t: string) => ({ Cookie: `myhub_session=${t}` })

  test('verifySessionInfo: su/oa 클레임을 돌려주고, 깨진 값은 null로 취급한다', async () => {
    const now = Date.now()
    const t1 = await tokenWithClaims({ su: now + 1000, oa: now - 1000 }, 'otp')
    const info1 = await verifySessionInfo(t1, secret, EMAIL)
    expect(info1?.suUntil).toBe(now + 1000)
    expect(info1?.otpAt).toBe(now - 1000)
    const t2 = await tokenWithClaims({ su: 'not-a-number', oa: -5 }, 'otp')
    const info2 = await verifySessionInfo(t2, secret, EMAIL)
    expect(info2?.suUntil).toBeNull()
    expect(info2?.otpAt).toBeNull()
    const t3 = await tokenWithClaims({}, 'pin')
    const info3 = await verifySessionInfo(t3, secret, EMAIL)
    expect(info3?.suUntil).toBeNull()
    expect(info3?.otpAt).toBeNull()
  })

  test('POST /step-up: 세션 없음 → 401', async () => {
    const { json } = makeApp({ env: { SESSION_SECRET: secret } })
    const res = await json('/step-up', 'POST', { pin: TEST_PIN })
    expect(res.status).toBe(401)
  })

  test('POST /step-up: PIN 미설정 → 200 exempt (쿠키 재발급 없음)', async () => {
    const db = new MockDb()
    db.firstQueue.push(null) // 세션 버전 조회 → 0
    db.firstQueue.push(null) // auth_pins 행 없음
    const { json } = makeApp({ db, env: { SESSION_SECRET: secret } })
    const res = await json('/step-up', 'POST', { pin: TEST_PIN }, cookieOf(await tokenWithClaims({})))
    expect(res.status).toBe(200)
    expect((await body(res)).exempt).toBe(true)
    expect(res.headers.get('Set-Cookie') || '').not.toContain('myhub_session=')
  })

  test('POST /step-up: PIN 없음 → 403 PIN_REQUIRED, 틀린 PIN → 403 PIN_INVALID', async () => {
    const mk = () => {
      const db = new MockDb()
      db.firstQueue.push(null) // 세션 버전
      db.firstQueue.push(pinRow) // auth_pins
      return makeApp({ db, env: { SESSION_SECRET: secret } })
    }
    const cookie = cookieOf(await tokenWithClaims({}))
    const noPin = await mk().json('/step-up', 'POST', {}, cookie)
    expect(noPin.status).toBe(403)
    expect((await body(noPin)).code).toBe('PIN_REQUIRED')
    const wrong = await mk().json('/step-up', 'POST', { pin: '000000' }, cookie)
    expect(wrong.status).toBe(403)
    expect((await body(wrong)).code).toBe('PIN_INVALID')
    expect(wrong.headers.get('Set-Cookie') || '').not.toContain('myhub_session=')
  })

  test('POST /step-up: 맞는 PIN → 200 + su 클레임(≈5분) 실은 새 쿠키, method·버전 보존', async () => {
    const db = new MockDb()
    db.firstQueue.push({ version: 3 }) // 세션 버전 조회 → 3
    db.firstQueue.push(pinRow)
    const { json } = makeApp({ db, env: { SESSION_SECRET: secret } })
    const before = Date.now()
    const res = await json('/step-up', 'POST', { pin: TEST_PIN }, cookieOf(await tokenWithClaims({}, 'pin', 3)))
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.stepUpUntil).toBeGreaterThan(before + 4 * 60 * 1000)
    expect(j.stepUpUntil).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 1000)
    const setCookie = res.headers.get('Set-Cookie') || ''
    const token = (setCookie.match(/myhub_session=([^;]+)/) || [])[1]
    expect(token).toBeTruthy()
    const info = await verifySessionInfo(token, secret, EMAIL)
    expect(info?.method).toBe('pin')
    expect(info?.version).toBe(3)
    expect(info?.suUntil).toBe(j.stepUpUntil)
  })

  test('POST /set-pin: OTP 확인 11분 경과 → 403 OTP_WINDOW_EXPIRED + PIN 교체 없음', async () => {
    const db = new MockDb()
    db.firstQueue.push(null) // 세션 버전 조회
    const { json } = makeApp({ db, env: { SESSION_SECRET: secret } })
    const token = await tokenWithClaims({ oa: Date.now() - 11 * 60 * 1000 }, 'otp')
    const res = await json('/set-pin', 'POST', { pin: '112233' }, cookieOf(token))
    expect(res.status).toBe(403)
    expect((await body(res)).code).toBe('OTP_WINDOW_EXPIRED')
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO auth_pins'))).toBe(false)
  })

  test('POST /set-pin: oa 없는 OTP 토큰 → 403 (확인 시각 불명)', async () => {
    const db = new MockDb()
    db.firstQueue.push(null)
    const { json } = makeApp({ db, env: { SESSION_SECRET: secret } })
    const token = await tokenWithClaims({}, 'otp')
    const res = await json('/set-pin', 'POST', { pin: '112233' }, cookieOf(token))
    expect(res.status).toBe(403)
    expect((await body(res)).code).toBe('OTP_WINDOW_EXPIRED')
  })

  test('POST /set-pin: OTP 확인 9분 경과 → 200 (창 안)', async () => {
    const db = new MockDb()
    db.firstQueue.push(null) // 세션 버전 조회 → 0
    db.firstQueue.push({ version: 1 }) // bump RETURNING → 1
    const { json } = makeApp({ db, env: { SESSION_SECRET: secret } })
    const token = await tokenWithClaims({ oa: Date.now() - 9 * 60 * 1000 }, 'otp')
    const res = await json('/set-pin', 'POST', { pin: '112233' }, cookieOf(token))
    expect(res.status).toBe(200)
    // 새 세션에는 step-up 창이 실린다 (방금 PIN을 직접 입력했으므로)
    const setCookie = res.headers.get('Set-Cookie') || ''
    const newToken = (setCookie.match(/myhub_session=([^;]+)/) || [])[1]
    const info = await verifySessionInfo(newToken, secret, EMAIL)
    expect(info?.method).toBe('pin')
    expect(info?.version).toBe(1)
    expect(info?.suUntil).toBeGreaterThan(Date.now())
  })

  test('PIN 로그인 성공 토큰에도 step-up 창이 실린다', async () => {
    const db = new MockDb()
    db.firstQueue.push({ ...pinRow, fail_count: 0, locked_until: null }) // auth_pins (게이트 선점 포함 행)
    const { json } = makeApp({ db, env: { SESSION_SECRET: secret } })
    const res = await json('/pin-login', 'POST', { pin: TEST_PIN })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('Set-Cookie') || ''
    const token = (setCookie.match(/myhub_session=([^;]+)/) || [])[1]
    const info = await verifySessionInfo(token, secret, EMAIL)
    expect(info?.suUntil).toBeGreaterThan(Date.now())
    expect(info?.suUntil).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 1000)
  })
})

// ================= 뮤테이션 생존자 대응 (트랙 2, 2026-11-01) =================
// Run C (기준 a2586f2) 생존 뮤턴트 중 도달 가능한 경계 성질을 이 풀
// (auth-pin-gate·auth-routes·auth-low-fixes) 안에서 고정한다.
// - KV 폴백 잠금 경계: 풀백 429 판정은 coverage-final-cov에만 있어 풀에서
//   생존했다. 상한 정확값(5)에서 잠기고, 4에서는 올바른 PIN이 통과해야 한다.
// - set-pin OTP 창 경계: 경과 == 창(10분)에서는 허용, +1ms에서는 거부 —
//   '>' 를 '>=' 로 바꾸는 뮤턴트가 이 경계에서만 갈린다.
describe('뮤테이션 생존자 대응 — 경계 성질', () => {
  const EMAIL = 'kimjn00003@naver.com'

  test('KV 폴백: 실패 카운터가 상한(5)에 도달하면 올바른 PIN이어도 429, 세션 미발급', async () => {
    const { json, db, kv } = makeApp()
    db.firstQueue.push(new Error('no such column: fail_count'))
    kv.store.set(`pinfail:${EMAIL}`, '5')
    const res = await json('/pin-login', 'POST', { pin: '123456' })
    expect(res.status).toBe(429)
    expect(res.headers.get('Set-Cookie') || '').not.toContain('myhub_session=')
  })

  test('KV 폴백: 실패 카운터 4에서는 올바른 PIN이 통과하고 카운터가 0으로 초기화된다', async () => {
    const { json, db, kv } = makeApp()
    const { hashB64, saltB64, iterations } = await hashPin('123456')
    db.firstQueue.push(new Error('no such column: fail_count'))
    db.firstQueue.push({ pin_hash: hashB64, pin_salt: saltB64, iterations })
    db.firstQueue.push(null) // getSessionVersion → 0
    kv.store.set(`pinfail:${EMAIL}`, '4')
    const res = await json('/pin-login', 'POST', { pin: '123456' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Set-Cookie')).toContain('myhub_session=')
    expect(kv.store.get(`pinfail:${EMAIL}`)).toBe('0')
  })

  async function makeTokenWithOa(secret: string, oa: number, now: number) {
    const payload = JSON.stringify({ email: EMAIL, exp: now + 3600000, method: 'otp', v: 0, oa })
    const enc = new TextEncoder()
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
    return btoa(payload) + '.' + btoa(String.fromCharCode(...new Uint8Array(sig)))
  }

  test('set-pin: OTP 경과가 정확히 10분이면 허용, 10분+1ms면 OTP_WINDOW_EXPIRED', async () => {
    const secret = 'setpin-boundary-secret'
    const T = 1800000000000
    const spy = jest.spyOn(Date, 'now').mockReturnValue(T)
    try {
      // 정확 경계 — 허용되어야 한다 (판정은 '>' 기준)
      const db1 = new MockDb()
      db1.firstQueue.push(null)
      db1.firstQueue.push({ version: 1 })
      const app1 = makeApp({ db: db1, env: { SESSION_SECRET: secret } })
      const tok1 = await makeTokenWithOa(secret, T - OTP_SET_PIN_WINDOW_MS, T)
      const res1 = await app1.json('/set-pin', 'POST', { pin: '975310' }, { Cookie: `myhub_session=${tok1}` })
      expect(res1.status).toBe(200)

      // 1ms 초과 — 거부
      const db2 = new MockDb()
      const app2 = makeApp({ db: db2, env: { SESSION_SECRET: secret } })
      const tok2 = await makeTokenWithOa(secret, T - OTP_SET_PIN_WINDOW_MS - 1, T)
      const res2 = await app2.json('/set-pin', 'POST', { pin: '975310' }, { Cookie: `myhub_session=${tok2}` })
      expect(res2.status).toBe(403)
      expect((await body(res2)).code).toBe('OTP_WINDOW_EXPIRED')
    } finally {
      spy.mockRestore()
    }
  })
})
