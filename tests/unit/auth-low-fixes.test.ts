/**
 * run-002·run-003 low 수정 검증 — 게이트 보상, 세션 버전 D1 이전, 로그인 CSP
 * - auth/pin-gate-failure-leaves-lock: 초기화 UPDATE 실패 시 보상 UPDATE로 선점분 복원
 * - auth/sessver-bump-race: 동시 /set-pin 시 bump이 하나로 합쳐지지 않음 (D1 RETURNING)
 * - auth/sessver-fail-open: 버전 조회 실패 시 세션 거부 (fail-closed) — auth-routes.test.ts에도 있음
 * - auth/login-csp-unsafe-inline: login.html 정적 검증 (인라인 제거·외부 파일·CSP)
 * - auth/rate-limit-unknown-ip: IP null이면 per-IP 검사 건너뜀
 */
/// <reference types="jest" />
import { Hono } from 'hono'
import * as fs from 'fs'
import * as path from 'path'
import { authApp, hashPin, checkRateLimitForIp } from '../../src/modules/auth/routes'

type PinRow = {
  pin_hash: string
  pin_salt: string
  iterations: number
  fail_count: number
  locked_until: string | null
}

class StatefulMockDb {
  row: PinRow | null
  version = 0
  throwOnReset = false
  failResetOnce = false
  throwOnBump = false
  calls: { sql: string; params: any[] }[] = []

  constructor(row: PinRow | null) {
    this.row = row ? { ...row } : null
  }

  prepare(sql: string) {
    const db = this
    return {
      bind: (...params: any[]) => ({
        first: async () => {
          db.calls.push({ sql, params })
          if (sql.includes('UPDATE session_versions SET version = version + 1')) {
            if (db.throwOnBump) throw new Error('D1 bump failed')
            db.version += 1
            return { version: db.version }
          }
          if (sql.includes('SELECT version FROM session_versions')) {
            return { version: db.version }
          }
          if (!sql.includes('FROM auth_pins')) return null
          return db.row ? { ...db.row } : null
        },
        run: async () => {
          db.calls.push({ sql, params })
          if (sql.includes('INSERT INTO rate_limits') || sql.includes('INSERT OR IGNORE INTO session_versions')) {
            return { meta: { changes: 1 } }
          }
          if (sql.includes('UPDATE auth_pins SET fail_count = CASE')) {
            if (!db.row) return { meta: { changes: 0 } }
            const nowIso: string = params[5]
            if (db.row.locked_until && db.row.locked_until > nowIso) {
              return { meta: { changes: 0 } }
            }
            const expired = db.row.locked_until !== null && db.row.locked_until <= nowIso
            const next = expired ? 1 : db.row.fail_count + 1
            db.row.fail_count = next
            if (next >= params[2]) {
              db.row.locked_until = new Date(Date.now() + 900_000).toISOString()
            } else if (expired) {
              db.row.locked_until = null
            }
            return { meta: { changes: 1 } }
          }
          if (sql.includes('UPDATE auth_pins SET fail_count = 0')) {
            if (db.throwOnReset) throw new Error('D1 reset failed')
            if (db.failResetOnce) {
              db.failResetOnce = false
              throw new Error('D1 reset failed once')
            }
            if (db.row) {
              db.row.fail_count = 0
              db.row.locked_until = null
            }
            return { meta: { changes: 1 } }
          }
          if (sql.includes('MAX(fail_count - 1, 0)')) {
            if (db.row) {
              db.row.fail_count = Math.max(db.row.fail_count - 1, 0)
              if (db.row.fail_count < params[0]) db.row.locked_until = null
            }
            return { meta: { changes: 1 } }
          }
          return { meta: { changes: 1 } }
        },
      }),
    }
  }
}

class MockKv {
  store = new Map<string, string>()
  async get(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  async put(key: string, value: string, opts?: any) {
    this.store.set(key, value)
  }
}

function makeApp(db: StatefulMockDb, secret = 'test-secret-1234567890') {
  const kv = new MockKv()
  const app = new Hono()
  app.route('/a', authApp)
  const env: any = {
    DB: db,
    KV: kv,
    SESSION_SECRET: secret,
    ENVIRONMENT: 'production',
    RESEND_API_KEY: 're_test_key',
  }
  const json = (path: string, method: string, body?: any, headers?: Record<string, string>) =>
    app.request('/a' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env)
  const req = (path: string, init?: RequestInit) => app.request('/a' + path, init, env)
  return { json, req, db, kv }
}

async function makeSessionToken(email: string, secret: string, expOffsetMs: number, method: 'otp' | 'pin' = 'otp', v = 0) {
  const exp = Date.now() + expOffsetMs
  // OTP 토큰은 "방금 본인확인한 세션" — oa 클레임(트랙 2 set-pin 10분 창)을 현재로 싣는다.
  const payload = JSON.stringify({ email, exp, method, v, ...(method === 'otp' ? { oa: Date.now() } : {}) })
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return btoa(payload) + '.' + sigB64
}

async function pinRow(pin: string, failCount = 0, lockedUntil: string | null = null): Promise<PinRow> {
  const h = await hashPin(pin)
  return { pin_hash: h.hashB64, pin_salt: h.saltB64, iterations: h.iterations, fail_count: failCount, locked_until: lockedUntil }
}

describe('게이트 선점 후 예외 보상 (run-003 low auth/pin-gate-failure-leaves-lock)', () => {
  test('초기화 UPDATE 실패 → 보상 UPDATE로 선점분 되돌리고 500, 잠금 남지 않음', async () => {
    const db = new StatefulMockDb(await pinRow('135790', 4, null))
    db.throwOnReset = true
    const { json } = makeApp(db)
    const res = await json('/pin-login', 'POST', { pin: '135790' }, { 'CF-Connecting-IP': '10.1.0.1' })
    expect(res.status).toBe(500)
    // 게이트가 4→5로 올리며 잠금을 걸었다가 보상 UPDATE가 5→4로 되돌려야 한다
    expect(db.row!.fail_count).toBe(4)
    expect(db.row!.locked_until).toBeNull()
    const comp = db.calls.find((c) => c.sql.includes('MAX(fail_count - 1, 0)'))
    expect(comp).toBeDefined()
  })

  test('보상 후 재시도하면 정상 로그인된다 (고착 없음)', async () => {
    const db = new StatefulMockDb(await pinRow('135790', 4, null))
    db.throwOnReset = true
    const { json } = makeApp(db)
    const first = await json('/pin-login', 'POST', { pin: '135790' }, { 'CF-Connecting-IP': '10.1.0.2' })
    expect(first.status).toBe(500)
    db.throwOnReset = false
    const second = await json('/pin-login', 'POST', { pin: '135790' }, { 'CF-Connecting-IP': '10.1.0.3' })
    expect(second.status).toBe(200)
    expect(db.row!.fail_count).toBe(0)
  })

  test('잠금 중 정답 + 초기화 1회 실패 → 재시도로 200 (run-004 신규 low 수정)', async () => {
    const lockedUntil = new Date(Date.now() + 900_000).toISOString()
    const db = new StatefulMockDb(await pinRow('135790', 5, lockedUntil))
    db.failResetOnce = true
    const { json } = makeApp(db)
    const res = await json('/pin-login', 'POST', { pin: '135790' }, { 'CF-Connecting-IP': '10.1.0.4' })
    expect(res.status).toBe(200)
    expect(db.row!.fail_count).toBe(0)
    expect(db.row!.locked_until).toBeNull()
    expect(db.calls.filter((c) => c.sql.includes('UPDATE auth_pins SET fail_count = 0'))).toHaveLength(2)
  })

  test('잠금 중 정답 + 초기화 2회 실패 → 500, 잠금은 그대로 (재시도 후에도 실패)', async () => {
    const lockedUntil = new Date(Date.now() + 900_000).toISOString()
    const db = new StatefulMockDb(await pinRow('135790', 5, lockedUntil))
    db.throwOnReset = true
    const { json } = makeApp(db)
    const res = await json('/pin-login', 'POST', { pin: '135790' }, { 'CF-Connecting-IP': '10.1.0.5' })
    expect(res.status).toBe(500)
    expect(db.row!.fail_count).toBe(5)
    expect(db.row!.locked_until).toBe(lockedUntil)
  })

  test('iterations=0 손상 행 → 게이트 선점 없이 500', async () => {
    const row = await pinRow('135790', 0, null)
    row.iterations = 0
    const db = new StatefulMockDb(row)
    const { json } = makeApp(db)
    const res = await json('/pin-login', 'POST', { pin: '135790' }, { 'CF-Connecting-IP': '10.1.0.6' })
    expect(res.status).toBe(500)
    expect(db.calls.filter((c) => c.sql.includes('UPDATE auth_pins'))).toHaveLength(0)
  })
})

describe('세션 버전 D1 이전 (run-002 low auth/sessver-bump-race·fail-open)', () => {
  test('동시 /set-pin 2건 → 살아남는 세션은 최대 1개 (bump-race 수정)', async () => {
    const secret = 'setpin-race-secret'
    const db = new StatefulMockDb(null)
    const { json, req } = makeApp(db, secret)
    const cookie = { Cookie: `myhub_session=${await makeSessionToken('kimjn00003@naver.com', secret, 3600000, 'otp', 0)}` }
    const [r1, r2] = await Promise.all([
      json('/set-pin', 'POST', { pin: '111111' }, cookie),
      json('/set-pin', 'POST', { pin: '222222' }, cookie),
    ])
    // 먼저 완료된 요청이 버전을 올리면, 뒤의 요청은 세션 검증에서 401이 될 수 있다.
    // 이는 올바른 동작이다 — 중요한 불변식은 "살아남는 세션은 최대 1개"다.
    expect([r1.status, r2.status].every((s) => s === 200 || s === 401)).toBe(true)
    expect(db.version).toBeGreaterThanOrEqual(1)
    expect(db.version).toBeLessThanOrEqual(2)
    const tokenOf = (res: Response) => {
      const m = (res.headers.get('Set-Cookie') || '').match(/myhub_session=([^;]+)/)
      return m ? m[1] : ''
    }
    const tokens = [tokenOf(r1), tokenOf(r2)].filter(Boolean)
    expect(tokens.length).toBe(db.version)
    const versions = tokens.map((t) => JSON.parse(atob(t.split('.')[0])).v as number)
    expect(new Set(versions).size).toBe(tokens.length)
    // 발급된 토큰 중 유효한 것은 최종 버전과 일치하는 1개뿐이다
    let validCount = 0
    for (const t of tokens) {
      const me = await req('/me', { method: 'GET', headers: { Cookie: `myhub_session=${t}` } })
      if (me.status === 200) validCount++
    }
    expect(validCount).toBe(1)
    const latest = tokens.find((t) => JSON.parse(atob(t.split('.')[0])).v === db.version)!
    const meLatest = await req('/me', { method: 'GET', headers: { Cookie: `myhub_session=${latest}` } })
    expect(meLatest.status).toBe(200)
  })

  test('bump 실패 시 /set-pin은 500, 토큰 미발급, PIN 교체 없음, 기존 세션 유지', async () => {
    const secret = 'setpin-bump-fail-secret'
    const db = new StatefulMockDb(null)
    db.throwOnBump = true
    const { json, req } = makeApp(db, secret)
    const otpToken = await makeSessionToken('kimjn00003@naver.com', secret, 3600000, 'otp', 0)
    const cookie = { Cookie: `myhub_session=${otpToken}` }
    const res = await json('/set-pin', 'POST', { pin: '333333' }, cookie)
    expect(res.status).toBe(500)
    expect(res.headers.get('Set-Cookie')).toBeNull()
    // bump이 먼저라 PIN UPSERT이 실행되지 않아야 한다
    expect(db.calls.filter((c) => c.sql.includes('INSERT INTO auth_pins'))).toHaveLength(0)
    // 기존 OTP 세션은 그대로 유효하다 (bump 실패 = 아무것도 바뀌지 않음)
    const me = await req('/me', { method: 'GET', headers: { Cookie: `myhub_session=${otpToken}` } })
    expect(me.status).toBe(200)
  })
})

describe('속도 제한 IP 식별 불가 (run-002 low auth/rate-limit-unknown-ip)', () => {
  test('checkRateLimitForIp: IP null이면 검사 건너뜀 (false, DB 호출 없음)', async () => {
    const db = new StatefulMockDb(null)
    expect(await checkRateLimitForIp(db as any, null, 'pinip', 10, 3600)).toBe(false)
    expect(db.calls.filter((c) => c.sql.includes('INSERT INTO rate_limits'))).toHaveLength(0)
  })
})

describe('로그인 CSP (run-002 low auth/login-csp-unsafe-inline) — 정적 검증', () => {
  const loginHtml = fs.readFileSync(path.join(__dirname, '../../public/login.html'), 'utf8')
  const loginJs = fs.readFileSync(path.join(__dirname, '../../public/js/login.js'), 'utf8')

  test('login.html에 인라인 스크립트·스타일·onclick이 없고 CSP에 unsafe-inline이 없다', () => {
    expect(loginHtml).not.toContain('onclick=')
    expect(loginHtml).not.toContain('<style>')
    expect(loginHtml).not.toMatch(/<script>[\s\S]*?<\/script>/)
    const csp = loginHtml.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)
    expect(csp).not.toBeNull()
    expect(csp![1]).not.toContain("'unsafe-inline'")
    expect(loginHtml).toContain('<meta http-equiv="Content-Security-Policy"')
    expect(loginHtml).toContain("script-src 'self';")
    expect(loginHtml).not.toContain('unpkg.com')
    expect(loginHtml).toContain("style-src 'self';")
  })

  test('login.html이 외부 JS/CSS를 참조하고 JS가 버튼을 addEventListener로 연결한다', () => {
    expect(loginHtml).toContain('<script src="/js/login.js"></script>')
    expect(loginHtml).toContain('<link rel="stylesheet" href="/css/login.css">')
    for (const id of ['btnPinLogin', 'btnToOtp', 'btnSend', 'btnToPin', 'btnVerify', 'btnBackToStart', 'btnSetPin', 'btnLater']) {
      expect(loginJs).toContain(`getElementById('${id}')`)
    }
    expect(loginJs).toContain("addEventListener('click', pinLogin)")
    expect(loginJs).toContain("addEventListener('click', setPin)")
  })

  test('login.js/css가 에셋 집합에 있고 /login.html 응답에 CSP 헤더를 단다 (ASSETS 서빙)', () => {
    // 구 인라인 번들 대신 ASSETS + catch-all이 같은 속성을 보장한다.
    const assetList = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../scripts/static-assets.json'), 'utf8'),
    )
    expect(assetList.files).toContain('/css/login.css')
    expect(assetList.files).toContain('/js/login.js')
    const indexTs = fs.readFileSync(path.join(__dirname, '../../src/index.ts'), 'utf8')
    expect(indexTs).toContain('Content-Security-Policy')
    expect(indexTs).toContain("frame-ancestors 'none'")
    // CSP는 /login.html 응답에만 붙는다 (catch-all의 login.html 분기)
    expect(indexTs).toContain(
      "if (pathname === '/login.html') headers.set('Content-Security-Policy', LOGIN_CSP)",
    )
  })
})
