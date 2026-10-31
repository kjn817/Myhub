import { Hono } from 'hono'
import type { Env } from '../../types'

/** D1 prepare/bind/first/run 최소 인터페이스 — 실제 D1Database와 단위 테스트의 MockDb를 모두 받는다. */
export interface DbLike {
  prepare(sql: string): {
    bind(...params: any[]): {
      first<T = unknown>(): Promise<T | null>
      run(): Promise<{ meta?: { changes?: number } }>
    }
  }
}

// 허용된 이메일 (환경변수로 관리)
// - production: 기존 운영 이메일
// - staging: STAGING_ALLOWED_EMAILS (단일)
// - 설정 누락/알 수 없는 환경: fail-closed (null 반환)
export function getAuthEmail(env: Env): string | null {
  const environment = env.ENVIRONMENT
  // ENVIRONMENT 누락 → fail-closed (null)
  if (!environment) {
    return null
  }
  if (environment === 'development') {
    // 로컬 개발: DEV_ALLOWED_EMAILS (단일)
    const devEmails = (env.DEV_ALLOWED_EMAILS || '').split(',').map((e: string) => e.trim()).filter((e: string) => e.length > 0)
    if (devEmails.length === 1) {
      return devEmails[0]
    }
    return null
  }
  if (environment === 'staging') {
    const stagingEmails = (env.STAGING_ALLOWED_EMAILS || '').split(',').map((e: string) => e.trim()).filter((e: string) => e.length > 0)
    // 스테이징은 단일 이메일만 지원 (단순하고 안전)
    if (stagingEmails.length === 1) {
      return stagingEmails[0]
    }
    // 설정 누락/잘못됨 → fail-closed (운영 이메일로 fallback 금지)
    return null
  }
  if (environment === 'production') {
    return 'kimjn00003@naver.com'
  }
  // 알 수 없는 환경 → fail-closed
  return null
}

const authApp = new Hono<{ Bindings: Env }>()

// 6자리 인증코드 생성 (CSPRNG)
function genCode(): string {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return String(100000 + (buf[0] % 900000))
}

// Resend OTP 이메일 발송
// 반환: { ok: true, emailId } 또는 { ok: false, status }
// 민감정보(API 키, OTP, 이메일)는 로그에 남기지 않음
// 테스트 모드: TEST_MAIL_TRANSPORT=1 이면 실제 발송 없이 성공 반환
// 보안: ENVIRONMENT=production에서는 절대 활성화되지 않음
export async function sendOtpEmail(
  env: { RESEND_API_KEY?: string; TEST_MAIL_TRANSPORT?: string; ENVIRONMENT?: string },
  toEmail: string,
  code: string
): Promise<{ ok: boolean; emailId?: string; status?: number }> {
  // 테스트 모드: 명시적 개발 환경에서만 허용 (MAIL-01~07)
  // - development + TEST_MAIL_TRANSPORT=1 → 모의 전송
  // - production/staging/ENVIRONMENT 누락·오타 → 테스트 모드 비활성화
  if (env.TEST_MAIL_TRANSPORT === '1' && env.ENVIRONMENT === 'development') {
    return { ok: true, emailId: 'test-' + Date.now() }
  }
  let res: Response
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'MyHub <onboarding@resend.dev>',
        to: [toEmail],
        subject: '[MyHub] 인증코드',
        html: `<p>인증코드: <strong style="font-size:24px;letter-spacing:4px;">${code}</strong></p><p>10분 동안 사용 가능합니다.</p>`,
      }),
    })
  } catch {
    console.error('Resend fetch failed')
    return { ok: false }
  }
  if (!res.ok) {
    // 안전한 오류 코드만 로그 (민감정보 제외)
    let errCode = ''
    try {
      const errData = await res.json() as { name?: string; error?: string }
      const code = errData?.name || errData?.error || ''
      // 영숫자, 언더스코어, 하이픈만 허용 (injection 방지)
      if (/^[a-zA-Z0-9_-]{1,50}$/.test(code)) {
        errCode = ' ' + code
      }
    } catch {}
    console.error('Resend API error: http=' + res.status + errCode)
    return { ok: false, status: res.status }
  }
  try {
    const data = await res.json() as { id?: string }
    if (data && typeof data.id === 'string' && data.id.length > 0) {
      return { ok: true, emailId: data.id }
    }
    console.error('Resend API: missing email id')
    return { ok: false, status: res.status }
  } catch {
    console.error('Resend API: invalid response')
    return { ok: false, status: res.status }
  }
}

// 세션 유효기간: 30일 (매일 재로그인 방지 — OTP·PIN 로그인 공통)
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SESSION_COOKIE_MAX_AGE = SESSION_TTL_MS / 1000

// ---------------- 비밀번호 (PBKDF2-SHA256) ----------------
export const PBKDF2_ITERATIONS = 100_000

function b64encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}
function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))
}

/** 비밀번호 해시 생성. salt 미지정 시 새로 발급. 평문은 저장하지 않는다. */
export async function hashPassword(
  password: string,
  saltB64?: string,
  iterations: number = PBKDF2_ITERATIONS
): Promise<{ hashB64: string; saltB64: string; iterations: number }> {
  const salt = saltB64 ? b64decode(saltB64) : crypto.getRandomValues(new Uint8Array(16))
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial, 256
  )
  return { hashB64: b64encode(new Uint8Array(bits)), saltB64: b64encode(salt), iterations }
}

/** 상수 시간 비교로 비밀번호 검증 */
export async function verifyPassword(
  password: string,
  row: { password_hash: string; password_salt: string; iterations: number }
): Promise<boolean> {
  const { hashB64 } = await hashPassword(password, row.password_salt, row.iterations)
  const a = b64decode(hashB64)
  const b = b64decode(row.password_hash)
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

// ---------------- PIN (숫자 6자리, PBKDF2-SHA256) ----------------
// 2026-10-22 사용자 지시: 이메일+비밀번호 입력 대신 PIN만으로 로그인한다.
// 최초 설정/재설정은 이메일 OTP 본인확인(세션)으로만 가능하고, 재설정하면 기존 PIN은 즉시 무효가 된다.
// PIN은 경우의 수가 적으므로(10^6) 해시 저장에 더해 실패 잠금을 강하게 건다: 5회 실패 → 15분 잠금.
export const PIN_FAIL_LIMIT = 5
export const PIN_FAIL_WINDOW_SEC = 900

export function isValidPin(pin: unknown): pin is string {
  return typeof pin === 'string' && /^\d{6}$/.test(pin)
}

/** PIN 해시 생성 (PBKDF2 공용 구현 재사용). 평문은 저장하지 않는다. */
export async function hashPin(
  pin: string
): Promise<{ hashB64: string; saltB64: string; iterations: number }> {
  return hashPassword(pin)
}

/** 상수 시간 비교로 PIN 검증 */
export async function verifyPin(
  pin: string,
  row: { pin_hash: string; pin_salt: string; iterations: number }
): Promise<boolean> {
  return verifyPassword(pin, {
    password_hash: row.pin_hash,
    password_salt: row.pin_salt,
    iterations: row.iterations,
  })
}

// 세션 발급 수단 (run-001 low auth/set-pin-no-step-up 수정)
// - 'otp': 이메일 OTP 본인확인으로 발급 — PIN 설정/재발급 가능
// - 'pin': PIN 로그인으로 발급 — PIN 재설정 불가 (step-up 필요)
export type SessionMethod = 'otp' | 'pin'

// 세션 버전 (run-001 low auth/session-no-revocation 수정)
// - 로그아웃·PIN 재발급 시 버전 카운터를 올리면 그 전에 발급된 토큰은 전부 무효가 된다.
// - 카운터는 D1 `session_versions`에 저장 (0051, KV read-modify-write 대체).
//   KV에는 원자 증가 연산이 없어 동시 bump이 하나로 합쳐지는 race(sessver-bump-race)와
//   읽기 실패 시 0으로 fail-open되는 결함(sessver-fail-open)이 있었다.
//   D1 원자 UPDATE ... RETURNING으로 bump을 한 문장으로 합친다.
// - getSessionVersion은 '없음'(행 없음 → 0)과 '읽기 실패'(예외 전파)를 구분한다.
//   verifySessionForEnv는 읽기 실패 시 세션을 거부한다 (fail-closed).
// - 0051 미적용 환경에서는 조회가 실패해 모든 세션이 거부된다 — 0051은 배포 게이트다.
//   배포 전 KV `sessver:{email}` 현재값을 session_versions에 시드하면 기존 세션이 유지된다.
// - 0045 이전에 발급된 구 토큰에는 method/v가 없어 0으로 간주한다 (하위 호환).
export async function getSessionVersion(env: { DB: DbLike }, email: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT version FROM session_versions WHERE email = ?`
  ).bind(email).first<{ version: number }>()
  return row ? row.version : 0
}

export async function bumpSessionVersion(env: { DB: DbLike }, email: string): Promise<number> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO session_versions (email, version) VALUES (?, 0)`
  ).bind(email).run()
  const row = await env.DB.prepare(
    `UPDATE session_versions SET version = version + 1 WHERE email = ? RETURNING version`
  ).bind(email).first<{ version: number }>()
  if (!row) {
    throw new Error('bumpSessionVersion: session_versions row missing')
  }
  return row.version
}

// 세션 토큰 생성 (HMAC 서명)
async function createSession(email: string, secret: string, method: SessionMethod, version: number): Promise<string> {
  const exp = Date.now() + SESSION_TTL_MS
  const payload = JSON.stringify({ email, exp, method, v: version })
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return btoa(payload) + '.' + sigB64
}

export interface SessionInfo {
  email: string
  /** 발급 수단. 0045 이전 구 토큰에는 없어 null이다 (set-pin은 null을 OTP로 인정하지 않는다). */
  method: SessionMethod | null
  version: number
}

/** 세션 토큰 상세 검증 — 서명·만료·이메일 + 발급 수단·버전까지 돌려준다. */
export async function verifySessionInfo(token: string, secret: string, allowedEmail?: string): Promise<SessionInfo | null> {
  try {
    const [payloadB64, sigB64] = token.split('.')
    if (!payloadB64 || !sigB64) return null
    const payload = atob(payloadB64)
    const enc = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    )
    const sig = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0))
    const valid = await crypto.subtle.verify('HMAC', key, sig, enc.encode(payload))
    if (!valid) return null
    const parsed = JSON.parse(payload) as { email?: unknown; exp?: unknown; method?: unknown; v?: unknown }
    if (typeof parsed.email !== 'string' || typeof parsed.exp !== 'number') return null
    if (Date.now() > parsed.exp) return null
    if (allowedEmail && parsed.email !== allowedEmail) return null
    // 구 토큰(0045 이전)에는 method/v가 없다 — method는 null, 버전은 0으로 간주한다.
    // method가 null이면 set-pin step-up에서 OTP로 인정하지 않는다.
    const method: SessionMethod | null = parsed.method === 'otp' ? 'otp' : parsed.method === 'pin' ? 'pin' : null
    const version = typeof parsed.v === 'number' && Number.isFinite(parsed.v) && parsed.v >= 0 ? Math.floor(parsed.v) : 0
    return { email: parsed.email, method, version }
  } catch {
    return null
  }
}

// 세션 토큰 검증 (하위 호환 래퍼 — expectedVersion을 주면 버전까지 대조한다)
export async function verifySession(token: string, secret: string, allowedEmail?: string, expectedVersion?: number): Promise<string | null> {
  const info = await verifySessionInfo(token, secret, allowedEmail)
  if (!info) return null
  if (expectedVersion !== undefined && info.version !== expectedVersion) return null
  return info.email
}

/** 환경(D1 버전 카운터)까지 대조하는 세션 검증 — 미들웨어·/me·/set-pin 공용.
 *  버전 조회 실패 시 세션을 거부한다 (fail-closed, run-002 low auth/sessver-fail-open 수정).
 *  '없음'(행 없음 → 0)과 '읽기 실패'(예외)를 getSessionVersion이 구분한다. */
export async function verifySessionForEnv(
  env: { DB: DbLike; SESSION_SECRET: string },
  token: string,
  allowedEmail?: string,
): Promise<SessionInfo | null> {
  const info = await verifySessionInfo(token, env.SESSION_SECRET, allowedEmail)
  if (!info) return null
  let current: number
  try {
    current = await getSessionVersion(env, info.email)
  } catch {
    // 버전 조회 실패(D1 장애·0051 미적용) → 무효화 여부를 알 수 없으므로 세션 거부.
    return null
  }
  if (info.version !== current) return null
  return info
}

// ---------------- 발신자 구분 속도 제한 (run-001 low auth/attempt-counter-lockout-dos 수정) ----------------
// - 전역(계정) 상한만으로는 미인증 원격 호출이 카운터를 소진시켜 소유자를 차단할 수 있다.
// - 발신자(IP)별 버킷을 먼저 두고, 계정 전역 상한은 무차별 대입 방어용 백스톱으로 유지한다.
// - IP 식별은 CF-Connecting-IP만 신뢰한다 (run-002 low auth/rate-limit-unknown-ip 수정).
//   X-Forwarded-For는 클라이언트가 임의로 설정할 수 있어 버킷 식별자로 쓸 수 없고,
//   식별 불가 시에는 per-IP 버킷을 건너뛰고 전역 상한에만 의존한다 (null 반환).
//   'unknown'이라는 단일 식별자로 모든 미식별 클라이언트를 한 버킷에 합치던 결함을 없앤다.
/** 발신자 IP — CF-Connecting-IP만 신뢰. 식별 불가 시 null. */
export function getClientIp(c: { req: { header(name: string): string | undefined } }): string | null {
  const cfIp = (c.req.header('CF-Connecting-IP') || '').trim()
  return cfIp || null
}

/** D1 원자 속도 제한 (run-002 low auth/rate-limit-kv-race 수정).
 *  KV read-modify-write는 동시 버스트에 무력화되므로 (읽기-쓰기 사이 원자성 없음),
 *  INSERT ... ON CONFLICT DO UPDATE 한 문장으로 선점·증가·상한 판정을 합친다.
 *  - 행 없음 → INSERT로 count=1 (허용).
 *  - 윈도우 만료 → count를 1로 재시작 (허용).
 *  - 윈도우 내 count < limit → +1 (허용).
 *  - 윈도우 내 count >= limit → WHERE가 막아 changes=0 (차단).
 *  상한을 넘으면 true를 돌려준다. 0051 rate_limits 테이블이 필요하다. */
export async function checkRateLimit(
  db: DbLike,
  key: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  const nowIso = new Date().toISOString()
  const expiresIso = new Date(Date.now() + windowSec * 1000).toISOString()
  const res = await db.prepare(
    `INSERT INTO rate_limits (key, count, window_expires_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_expires_at IS NULL OR rate_limits.window_expires_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
       window_expires_at = CASE WHEN rate_limits.window_expires_at IS NULL OR rate_limits.window_expires_at <= ? THEN ? ELSE rate_limits.window_expires_at END
     WHERE rate_limits.window_expires_at IS NULL OR rate_limits.window_expires_at <= ? OR rate_limits.count < ?`
  ).bind(key, expiresIso, nowIso, nowIso, expiresIso, nowIso, limit).run()
  const changed = (((res as any).meta?.changes ?? 0) as number)
  return changed === 0
}

/** 발신자별 속도 제한 검사 — 식별 가능한 IP일 때만 per-IP 버킷을 검사한다.
 *  IP를 식별할 수 없으면 per-IP 검사를 건너뛰고 호출자의 전역 상한에만 의존한다. */
export async function checkRateLimitForIp(
  db: DbLike,
  ip: string | null,
  keyPrefix: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  if (ip === null) return false
  return checkRateLimit(db, `${keyPrefix}:${ip}`, limit, windowSec)
}

// OTP 코드 유효기간: 10분 (P0 otp-single-use — 기존 24시간 당일 재사용 폐지)
export const OTP_TTL_MS = 10 * 60 * 1000

// 인증코드 요청
// - 속도 제한 이중 구조 (run-001 low auth/attempt-counter-lockout-dos 수정):
//   발신자(IP)별 5회/시간을 먼저 두고, 계정 전역 상한은 20회/시간으로 둔다.
//   단일 발신자가 전역 카운터를 소진시켜 소유자를 차단할 수 없게 한다.
// - 단회·단기 코드 (P0 otp-single-use):
//   매 요청마다 새 코드를 생성해 기존 코드를 교체한다 (attempts 초기화).
//   기존 코드는 교체 즉시 무효가 되고, 유효기간은 10분이다.
//   당일 재사용(24시간 유효 코드 재발송)은 설계 결함으로 폐지했다.
// - 교체 원자화: 읽은 기존 코드가 그대로일 때만 UPDATE가 성공하고(낙관적 잠금),
//   행이 없을 때는 INSERT OR IGNORE만 성공한다. 동시 요청 중 쓰기에 성공한
//   1건만 메일을 발송하고, 패자(changes=0)는 승자 코드를 재조회해 성공으로
//   돌려줄 뿐 메일을 보내지 않는다 — 최종적으로 DB에는 코드가 1개만 남는다.
authApp.post('/request', async (c) => {
  const normEmail = getAuthEmail(c.env)
  if (!normEmail) {
    return c.json({ ok: false, error: '인증 설정 오류' }, 500)
  }

  // 발신자별 속도 제한 (5회/시간) → 계정 전역 상한 (20회/시간)
  // IP를 식별할 수 없으면 per-IP 검사를 건너뛰고 전역 상한에만 의존한다.
  const clientIp = getClientIp(c)
  if (await checkRateLimitForIp(c.env.DB, clientIp, 'rl:ip', 5, 3600)) {
    return c.json({ ok: false, error: '너무 많은 요청. 1시간 후 다시 시도하세요.' }, 429)
  }
  const rlKey = `rl:${normEmail}`
  if (await checkRateLimit(c.env.DB, rlKey, 20, 3600)) {
    return c.json({ ok: false, error: '너무 많은 요청. 1시간 후 다시 시도하세요.' }, 429)
  }

  // 매번 새 코드를 생성해 기존 코드를 교체한다 (기존 코드는 즉시 무효).
  const existing = await c.env.DB.prepare(
    `SELECT code, expires_at FROM otp_codes WHERE email = ?`
  ).bind(normEmail).first<{ code: string; expires_at: string }>()

  const code = genCode()
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString()
  let created = false
  if (!existing) {
    // 행이 없을 때만 삽입 — 동시 요청이 먼저 만들면 changes=0 (패자).
    const insResult = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO otp_codes (email, code, attempts, expires_at) VALUES (?, ?, 0, ?)`
    ).bind(normEmail, code, expiresAt).run()
    created = (((insResult as any).meta?.changes ?? 0) as number) === 1
  } else {
    // 읽은 기존 코드·만료가 그대로일 때만 교체한다 (낙관적 잠금).
    // 그 사이 다른 요청이 교체했으면 changes=0 (패자) — 승자 코드를 덮지 않는다.
    // attempts를 0으로 초기화하므로 오답 총량은 발급 rate limit이 묶는다:
    // IP별 5회/시간 × 코드당 오답 5회 + 마지막 코드 5회 (보고 계산 참조).
    const updResult = await c.env.DB.prepare(
      `UPDATE otp_codes SET code = ?, attempts = 0, expires_at = ? WHERE email = ? AND code = ? AND expires_at = ?`
    ).bind(code, expiresAt, normEmail, existing.code, existing.expires_at).run()
    created = (((updResult as any).meta?.changes ?? 0) as number) === 1
  }

  if (!created) {
    // 경합 패자: 승자가 만든 유효 코드가 있으면 그 코드로 진행된 것으로 보고
    // 성공을 돌려준다 (메일은 승자만 발송). 코드가 사라졌으면 실패로 처리한다.
    const winner = await c.env.DB.prepare(
      `SELECT code, expires_at FROM otp_codes WHERE email = ?`
    ).bind(normEmail).first<{ code: string; expires_at: string }>()
    if (winner && new Date(winner.expires_at).getTime() > Date.now()) {
      return c.json({ ok: true })
    }
    return c.json({ ok: false, error: '메일 발송 실패' }, 502)
  }

  // 쓰기에 성공한 요청만 메일 발송
  const sendResult = await sendOtpEmail(c.env, normEmail, code)
  if (!sendResult.ok) {
    // 발송 실패 시 현재 요청에서 생성한 OTP만 정리
    // (email + code 조건으로 동시 요청의 새 OTP 보호)
    try {
      await c.env.DB.prepare(
        `DELETE FROM otp_codes WHERE email = ? AND code = ?`
      ).bind(normEmail, code).run()
    } catch {}
    return c.json({ ok: false, error: '메일 발송 실패' }, 502)
  }

  return c.json({ ok: true })
})

// 인증코드 검증
authApp.post('/verify', async (c) => {
  const { code } = await c.req.json<{ code: string }>()
  const normEmail = getAuthEmail(c.env)
  if (!normEmail) {
    return c.json({ ok: false, error: '인증 설정 오류' }, 500)
  }

  // 발신자별 속도 제한 (20회/시간) — 단일 발신자의 무차별 추측을 묶는다.
  // IP를 식별할 수 없으면 per-IP 검사를 건너뛰고 전역 백스톱(100회/시간)에만 의존한다
  // (run-002 low auth/rate-limit-unknown-ip 수정 — /verify에는 전역 상한이 없어 신설).
  if (await checkRateLimitForIp(c.env.DB, getClientIp(c), 'verifyip', 20, 3600)) {
    return c.json({ ok: false, error: '너무 많은 요청. 1시간 후 다시 시도하세요.' }, 429)
  }
  if (await checkRateLimit(c.env.DB, 'verify:global', 100, 3600)) {
    return c.json({ ok: false, error: '너무 많은 요청. 1시간 후 다시 시도하세요.' }, 429)
  }

  const row = await c.env.DB.prepare(
    `SELECT code, attempts, expires_at FROM otp_codes WHERE email = ?`
  ).bind(normEmail).first<{ code: string; attempts: number; expires_at: string }>()

  if (!row) {
    return c.json({ ok: false, error: '인증코드를 먼저 요청하세요.' }, 400)
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    await c.env.DB.prepare(`DELETE FROM otp_codes WHERE email = ?`).bind(normEmail).run()
    return c.json({ ok: false, error: '인증코드가 만료되었습니다.' }, 400)
  }

  // 정답 코드는 시도 횟수와 무관하게 성공시킨다 (run-002 low auth/lockout-dos-verify-pin-residual 수정).
  // 시도 카운터는 오답에만 적용된다 — 미인증 원격 호출 5회로 코드를 소진시켜도
  // 소유자의 정답 제출은 막히지 않으므로, 소진 DoS가 성립하지 않는다.
  // 오답 시도의 총량은 attempts < 5 게이트가 그대로 묶는다.
  if (row.code === (code || '').trim()) {
    // 성공: OTP 원자적 단일 사용 (OTP-ATOMIC)
    // 조건부 DELETE로 코드 일치+만료를 원자적으로 확인 - 동시 요청 중 1건만 성공
    // SELECT→DELETE 사이의 race condition 및 만료 경계 차단
    const nowIso = new Date().toISOString()
    const delResult = await c.env.DB.prepare(
      `DELETE FROM otp_codes WHERE email = ? AND code = ? AND expires_at > ?`
    ).bind(normEmail, (code || '').trim(), nowIso).run()

    const changes = ((delResult as any).meta?.changes ?? 0) as number
    if (changes !== 1) {
      // 다른 동시 요청이 먼저 OTP를 소비함
      return c.json({ ok: false, error: '인증코드가 틀렸습니다.' }, 400)
    }

    // OTP 본인확인 세션 발급 (PIN 설정/재발급 가능)
    const token = await createSession(normEmail, c.env.SESSION_SECRET, 'otp', await getSessionVersion(c.env, normEmail))

    // httpOnly 쿠키로 세션 설정 (30일)
    const cookie = `myhub_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE}`
    c.header('Set-Cookie', cookie)
    return c.json({ ok: true })
  }

  // 오답인데 이미 상한(attempts >= 5)에 도달했으면, 행을 지우지 않고 400만 돌려준다.
  // 행을 지우면 소유자가 정답 코드를 쓸 수 없게 되어 소진 DoS가 되살아나기 때문이다.
  // 행은 만료(10분)까지 유지되며, 그 안에서는 소유자의 정답 제출이 항상 성공한다.
  if (row.attempts >= 5) {
    return c.json({ ok: false, error: '시도 횟수 초과. 다시 요청하세요.' }, 400)
  }

  // 원자적 시도 증가 (run-001 medium auth/otp-verify-attempts-race 수정):
  // `attempts < 5` 조건을 UPDATE에 넣어 동시 오답 버스트도 5회 상한을 넘지 않게 한다.
  // 조건에 안 맞으면(changes=0) 이미 상한에 도달한 것이다.
  const incResult = await c.env.DB.prepare(
    `UPDATE otp_codes SET attempts = attempts + 1 WHERE email = ? AND attempts < 5`
  ).bind(normEmail).run()
  const changed = (((incResult as any).meta?.changes ?? 0) as number)
  if (changed === 0) {
    return c.json({ ok: false, error: '시도 횟수 초과. 다시 요청하세요.' }, 400)
  }
  return c.json({ ok: false, error: '인증코드가 틀렸습니다.' }, 400)
})

// PIN 로그인 (단일 사용자 전용 — 이메일 입력 없음, PIN 6자리만으로 로그인)
// - PIN이 설정돼 있지 않으면 PIN_NOT_SET을 돌려줘 UI가 OTP 본인확인→PIN 발급으로 안내한다.
// - 실패 잠금: D1 원자 카운터 + 게이트 선점 (run-001 medium auth/pin-lockout-kv-race,
//   run-002 medium auth/pin-lock-gate-stale-read 수정).
//   KV read-modify-write는 동시 실패에서 1씩만 증가해 잠금을 우회하므로,
//   auth_pins.fail_count/locked_until(0045)을 단일 UPDATE로 갱신한다.
//   5회 실패 시 같은 UPDATE의 CASE 식으로 locked_until을 +15분으로 설정한다.
//   게이트 선점: PBKDF2 검증 전에 locked_until 조건을 단 원자 UPDATE로 실패 1회를
//   먼저 차지한다. SELECT 판정만으로는 동시 버스트가 잠금 전에 게이트를 전부
//   통과하므로, 선점에 실패하면(changes=0) 검증 없이 429를 돌려준다.
//   0045 미적용 환경(컬럼 없음)에서는 기존 KV 카운터로 폴백한다.
//   폴백 판정은 'no such column'일 때만 — 그 외 D1 오류는 500으로 실패한다
//   (run-002 low auth/pin-kv-fallback-race 수정).
// - 만료된 잠금 뒤의 fail_count는 새 창의 첫 실패로 재시작한다
//   (run-002 low auth/pin-failcount-no-decay 수정) — 오답 1개로 잠금을 무기한
//   재연장할 수 없게 한다.
// - 잠금 중에도 정답 PIN은 성공시킨다 (run-002 low auth/lockout-dos-verify-pin-residual
//   수정). 잠금의 목적은 오답 추측 속도를 묶는 것이지 소유자를 차단하는 것이 아니다.
// - 게이트 이후 예외 시에는 보상 UPDATE로 선점분을 되돌린다
//   (run-003 low auth/pin-gate-failure-leaves-lock 수정). 손상된 salt/hash 행은
//   게이트 선점 전에 500으로 분리한다.
// - 발신자별 속도 제한 10회/시간 + 전역 백스톱 100회/시간 (run-001 low
//   auth/attempt-counter-lockout-dos, run-002 low auth/rate-limit-unknown-ip 수정).
//   IP는 CF-Connecting-IP만 신뢰하고, 식별 불가 시 per-IP 검사를 건너뛴다.
authApp.post('/pin-login', async (c) => {
  const normEmail = getAuthEmail(c.env)
  if (!normEmail) {
    return c.json({ ok: false, error: '인증 설정 오류' }, 500)
  }
  const body = await c.req.json<{ pin?: string }>().catch(() => ({} as { pin?: string }))
  const pin = body.pin || ''
  if (!isValidPin(pin)) {
    return c.json({ ok: false, error: 'PIN은 숫자 6자리입니다.' }, 400)
  }

  // 발신자별 속도 제한 10회/시간 (run-001 low auth/attempt-counter-lockout-dos 수정).
  // IP를 식별할 수 없으면 per-IP 검사를 건너뛰고 전역 백스톱(100회/시간)에만 의존한다
  // (run-002 low auth/rate-limit-unknown-ip 수정 — /pin-login에는 전역 상한이 없어 신설).
  if (await checkRateLimitForIp(c.env.DB, getClientIp(c), 'pinip', 10, 3600)) {
    return c.json({ ok: false, error: 'PIN 입력 실패가 너무 많습니다. 1시간 후 다시 시도하세요.' }, 429)
  }
  if (await checkRateLimit(c.env.DB, 'pin:global', 100, 3600)) {
    return c.json({ ok: false, error: 'PIN 입력 실패가 너무 많습니다. 1시간 후 다시 시도하세요.' }, 429)
  }

  // D1 카운터 경로 (0045 적용 환경)
  let row: { pin_hash: string; pin_salt: string; iterations: number; fail_count?: number; locked_until?: string | null } | null = null
  let useD1Counter = true
  try {
    row = await c.env.DB.prepare(
      `SELECT pin_hash, pin_salt, iterations, fail_count, locked_until FROM auth_pins WHERE email = ?`
    ).bind(normEmail).first<{ pin_hash: string; pin_salt: string; iterations: number; fail_count: number; locked_until: string | null }>()
  } catch (e: any) {
    // 0045 미적용 판정은 오류 종류로 구분한다 (run-002 low auth/pin-kv-fallback-race 수정).
    // 'no such column'일 때만 KV 폴백으로 가고, 그 외 D1 오류(일시 장애 등)는
    // 폴백하지 않고 500으로 실패한다 — 일시적 오류가 racy한 KV 폴백으로 떨어지면
    // run-001 medium 결함이 그대로 되돌아오기 때문이다.
    const msg = (e && typeof e.message === 'string') ? e.message : ''
    if (/no such column/i.test(msg)) {
      useD1Counter = false
    } else {
      throw e
    }
  }

  if (!useD1Counter) {
    return pinLoginKvFallback(c, normEmail, pin)
  }

  if (!row) {
    return c.json({
      ok: false,
      code: 'PIN_NOT_SET',
      error: '아직 PIN이 설정되지 않았습니다. 인증코드로 본인 확인 후 PIN을 발급하세요.',
    }, 401)
  }

  // 손상된 salt/hash/iterations는 게이트 선점 전에 분리한다 (run-003 low auth/pin-gate-failure-leaves-lock 수정).
  // verifyPin이 atob에서 InvalidCharacterError를 던지거나 PBKDF2가 iterations=0에서
  // OperationError를 던지면 게이트 선점분이 남기 때문이다.
  // set-pin은 hashPin이 만든 유효 base64·iterations=100000만 저장하므로, 정상 경로에서는 생기지 않는다.
  if (!isValidB64(row.pin_salt, 16) || !isValidB64(row.pin_hash, 32) ||
      !Number.isInteger(row.iterations) || row.iterations < 1) {
    return c.json({ ok: false, error: 'PIN 검증 오류' }, 500)
  }

  const nowIso = new Date().toISOString()
  const isLocked = !!row.locked_until && new Date(row.locked_until).getTime() > Date.now()

  if (isLocked) {
    // 잠금 중에도 정답 PIN은 성공시킨다 (run-002 low auth/lockout-dos-verify-pin-residual 수정).
    // 잠금의 목적은 오답 추측 속도를 묶는 것이지 소유자를 차단하는 것이 아니다.
    // 오답은 429만 돌려주고 카운터를 건드리지 않는다 — 게이트 선점이 없어 보상도 필요 없다.
    const okPin = await verifyPin(pin, row)
    if (!okPin) {
      return c.json({ ok: false, error: 'PIN 입력 실패가 너무 많습니다. 15분 후 다시 시도하세요.' }, 429)
    }
    // 정답인데 카운터 초기화 UPDATE가 일시 실패하면 한 번 재시도한다 (run-004 신규 low 수정).
    // 게이트 선점이 없는 분기라 되돌릴 선점분은 없고, 잠금은 기존 잠금이라
    // 재시도마저 실패하면 500으로 두고 소유자가 재시도하거나 15분 뒤 만료된다.
    await resetPinCounter(c.env.DB, normEmail)
    const token = await createSession(normEmail, c.env.SESSION_SECRET, 'pin', await getSessionVersion(c.env, normEmail))
    const cookie = `myhub_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE}`
    c.header('Set-Cookie', cookie)
    return c.json({ ok: true })
  }

  // 게이트 선점 (run-002 medium auth/pin-lock-gate-stale-read 수정):
  // SELECT 판정→PBKDF2 검증→증가 순서에서는 동시 오답 버스트가 잠금 설정 전에
  // 게이트를 전부 통과한다 (동시 10개 전부 401, fail_count=10).
  // /verify(:423) 패턴과 동일하게, PBKDF2 검증 전에 locked_until 조건을 단
  // 원자 UPDATE로 실패 1회를 선점한다. changes=0이면 이미 잠긴 상태
  // (다른 요청이 잠금을 선점했거나, SELECT와 UPDATE 사이에 잠금이 걸림) → 429.
  // 선점한 실패는 검증 결과와 무관하게 이미 카운트됐으므로,
  // 실패 시에는 추가 증가 없이 401만 돌려주고, 성공 시에는 반드시 초기화한다.
  // 만료된 잠금 뒤의 fail_count는 재시작한다 (run-002 low auth/pin-failcount-no-decay 수정):
  // locked_until이 이미 과거면 새 창의 첫 실패로 카운트를 1로 되돌려,
  // 오답 1개로 15분 잠금을 무기한 재연장할 수 없게 한다. D1 단일 UPDATE 원자성은 유지한다.
  const gateResult = await c.env.DB.prepare(
    `UPDATE auth_pins SET fail_count = CASE WHEN locked_until IS NOT NULL AND locked_until <= ? THEN 1 ELSE fail_count + 1 END,
      locked_until = CASE WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= ? THEN 1 ELSE fail_count + 1 END) >= ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+900 seconds') WHEN locked_until IS NOT NULL AND locked_until <= ? THEN NULL ELSE locked_until END
     WHERE email = ? AND (locked_until IS NULL OR locked_until <= ?)`
  ).bind(nowIso, nowIso, PIN_FAIL_LIMIT, nowIso, normEmail, nowIso).run()
  const gateChanges = (((gateResult as any).meta?.changes ?? 0) as number)
  if (gateChanges === 0) {
    return c.json({ ok: false, error: 'PIN 입력 실패가 너무 많습니다. 15분 후 다시 시도하세요.' }, 429)
  }

  // 게이트 이후 단계는 예외 시 선점분을 되돌린다 (run-003 low auth/pin-gate-failure-leaves-lock 수정).
  // 초기화 UPDATE가 실패하면 게이트가 걸어둔 잠금이 그대로 남아 정답 PIN에도 429가 되므로,
  // 보상 UPDATE로 선점한 실패 1회를 되돌린 뒤 예외를 다시 던진다 (500).
  try {
    const okPin = await verifyPin(pin, row)
    if (!okPin) {
      return c.json({ ok: false, error: 'PIN이 올바르지 않습니다.' }, 401)
    }

    // 성공: 게이트에서 선점한 실패를 반드시 초기화한다.
    // 게이트가 fail_count를 +1했으므로 조건부 초기화가 아니라 무조건 초기화해야
    // 정답 시도 뒤에 카운터가 남지 않는다 (fail_count=4에서 정답 시 게이트가
    // 잠금을 걸었다가 여기서 풀린다).
    await c.env.DB.prepare(
      `UPDATE auth_pins SET fail_count = 0, locked_until = NULL WHERE email = ?`
    ).bind(normEmail).run()
  } catch (e) {
    try {
      await c.env.DB.prepare(
        `UPDATE auth_pins SET fail_count = MAX(fail_count - 1, 0),
          locked_until = CASE WHEN fail_count - 1 < ? THEN NULL ELSE locked_until END WHERE email = ?`
      ).bind(PIN_FAIL_LIMIT, normEmail).run()
    } catch {
      // 보상 UPDATE마저 실패하면 로그만 남긴다 — 원본 예외를 가리지 않는다.
      console.error('pin-login: gate compensation failed')
    }
    throw e
  }
  // PIN 로그인 세션 발급 (PIN 재설정 불가 — set-pin은 OTP 세션만 받는다)
  const token = await createSession(normEmail, c.env.SESSION_SECRET, 'pin', await getSessionVersion(c.env, normEmail))
  const cookie = `myhub_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE}`
  c.header('Set-Cookie', cookie)
  return c.json({ ok: true })
})

/** PIN 실패 카운터 초기화 — 일시 D1 오류 시 1회 재시도한다.
 *  두 번 다 실패하면 예외를 전파해 호출자가 500으로 실패하게 한다. */
async function resetPinCounter(db: DbLike, email: string): Promise<void> {
  const sql = `UPDATE auth_pins SET fail_count = 0, locked_until = NULL WHERE email = ?`
  try {
    await db.prepare(sql).bind(email).run()
  } catch {
    await db.prepare(sql).bind(email).run()
  }
}

/** base64 형식 검증 — 손상된 salt/hash 행을 게이트 선점 전에 분리하는 용도.
 *  기대 길이(바이트)를 주면 디코드 길이가 일치하는지도 확인한다. */
export function isValidB64(s: unknown, expectedBytes?: number): s is string {
  if (typeof s !== 'string' || s.length === 0) return false
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4 !== 0) return false
  try {
    const bytes = b64decode(s)
    return expectedBytes === undefined || bytes.length === expectedBytes
  } catch {
    return false
  }
}

// 0045 미적용 환경용 KV 폴백 (기존 동작 그대로 — D1 카운터가 없을 때만 사용)
async function pinLoginKvFallback(c: any, normEmail: string, pin: string) {
  const failKey = `pinfail:${normEmail}`
  const failCount = parseInt((await c.env.KV.get(failKey)) || '0', 10) || 0
  if (failCount >= PIN_FAIL_LIMIT) {
    return c.json({ ok: false, error: 'PIN 입력 실패가 너무 많습니다. 15분 후 다시 시도하세요.' }, 429)
  }
  const row = await c.env.DB.prepare(
    `SELECT pin_hash, pin_salt, iterations FROM auth_pins WHERE email = ?`
  ).bind(normEmail).first() as { pin_hash: string; pin_salt: string; iterations: number } | null
  if (!row) {
    return c.json({
      ok: false,
      code: 'PIN_NOT_SET',
      error: '아직 PIN이 설정되지 않았습니다. 인증코드로 본인 확인 후 PIN을 발급하세요.',
    }, 401)
  }
  const okPin = await verifyPin(pin, row)
  if (!okPin) {
    await c.env.KV.put(failKey, String(failCount + 1), { expirationTtl: PIN_FAIL_WINDOW_SEC })
    return c.json({ ok: false, error: 'PIN이 올바르지 않습니다.' }, 401)
  }
  await c.env.KV.put(failKey, '0', { expirationTtl: PIN_FAIL_WINDOW_SEC })
  const token = await createSession(normEmail, c.env.SESSION_SECRET, 'pin', await getSessionVersion(c.env, normEmail))
  const cookie = `myhub_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE}`
  c.header('Set-Cookie', cookie)
  return c.json({ ok: true })
}

// PIN 설정/재발급 — OTP 본인확인 세션 필요 (최초 설정·재발급 모두 OTP 본인확인으로 받은 세션으로 수행).
// 행을 통째로 교체(UPSERT)하므로 재발급 즉시 기존 PIN은 무효가 된다.
// - step-up (run-001 low auth/set-pin-no-step-up 수정):
//   PIN 로그인 세션만으로는 재설정 불가. OTP로 발급된 세션만 받는다.
//   구 토큰(method 없음)도 OTP로 인정하지 않는다 — OTP로 다시 로그인하면 새 토큰이 나온다.
// - 재발급 시 기존 세션을 전부 무효화한다 (버전 +1): 이전 PIN으로 로그인한 세션도 끊긴다.
//   설정에 사용한 OTP 세션 자체도 버전이 올라 무효가 되므로, UI는 로그인 화면으로 보낸다.
authApp.post('/set-pin', async (c) => {
  const normEmail = getAuthEmail(c.env)
  if (!normEmail) {
    return c.json({ ok: false, error: '인증 설정 오류' }, 500)
  }
  const cookie = c.req.header('Cookie') || ''
  const m = cookie.match(/myhub_session=([^;]+)/)
  if (!m) return c.json({ ok: false, error: '로그인이 필요합니다.' }, 401)
  const session = await verifySessionForEnv(c.env, m[1], normEmail)
  if (!session) return c.json({ ok: false, error: '로그인이 필요합니다.' }, 401)
  if (session.method !== 'otp') {
    return c.json({ ok: false, error: 'PIN 재설정은 인증코드로 로그인한 세션에서만 가능합니다.' }, 403)
  }

  const body = await c.req.json<{ pin?: string }>().catch(() => ({} as { pin?: string }))
  const pin = body.pin || ''
  if (!isValidPin(pin)) {
    return c.json({ ok: false, error: 'PIN은 숫자 6자리여야 합니다.' }, 400)
  }

  const { hashB64, saltB64, iterations } = await hashPin(pin)
  // 기존 세션 무효화를 PIN 교체보다 먼저 수행한다 (run-004 신규 low 수정).
  // bump이 실패하면 PIN도 세션도 그대로인 일관된 상태로 남는다.
  // 반대로 PIN을 먼저 교체하고 bump이 실패하면 새 PIN이 적용됐는데 구 세션이
  // 살아남는 무효화 누락이 생긴다.
  const nextVersion = await bumpSessionVersion(c.env, normEmail)
  const now = new Date().toISOString()
  await c.env.DB.prepare(
    `INSERT INTO auth_pins (email, pin_hash, pin_salt, iterations, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET pin_hash = excluded.pin_hash,
       pin_salt = excluded.pin_salt, iterations = excluded.iterations, updated_at = excluded.updated_at`
  ).bind(normEmail, hashB64, saltB64, iterations, now, now).run()
  // 실패 카운터 초기화 (세션 무효화는 위 bump에서 이미 수행됨)
  try {
    await c.env.DB.prepare(
      `UPDATE auth_pins SET fail_count = 0, locked_until = NULL WHERE email = ?`
    ).bind(normEmail).run()
  } catch {
    // 0045 미적용 환경 — 카운터 초기화를 건너뛴다 (PIN 자체는 이미 교체됨)
  }
  // 방금 설정한 PIN으로 로그인한 것과 같은 새 세션을 발급한다
  // (OTP 본인확인을 마친 사용자가 바로 앱으로 들어가게 한다).
  const token = await createSession(normEmail, c.env.SESSION_SECRET, 'pin', nextVersion)
  c.header('Set-Cookie', `myhub_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE}`)
  return c.json({ ok: true })
})

// 로그아웃 — 쿠키 삭제 + 서버 측 세션 무효화 (버전 +1; run-001 low auth/session-no-revocation 수정)
authApp.post('/logout', async (c) => {
  const cookie = c.req.header('Cookie') || ''
  const m = cookie.match(/myhub_session=([^;]+)/)
  if (m) {
    const info = await verifySessionInfo(m[1], c.env.SESSION_SECRET)
    if (info) {
      await bumpSessionVersion(c.env, info.email)
    }
  }
  c.header('Set-Cookie', 'myhub_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0')
  return c.json({ ok: true })
})

// 현재 사용자 (+ PIN 설정 여부 — 로그인 UI의 발급 안내용. hasPassword는 구 UI 호환용으로 유지)
authApp.get('/me', async (c) => {
  const cookie = c.req.header('Cookie') || ''
  const m = cookie.match(/myhub_session=([^;]+)/)
  if (!m) return c.json({ ok: false }, 401)
  const allowedEmail = getAuthEmail(c.env)
  const session = await verifySessionForEnv(c.env, m[1], allowedEmail || undefined)
  if (!session) return c.json({ ok: false }, 401)
  const email = session.email
  let hasPin = false
  try {
    const row = await c.env.DB.prepare(
      `SELECT email FROM auth_pins WHERE email = ?`
    ).bind(email).first<{ email: string }>()
    hasPin = !!row
  } catch {
    // auth_pins 테이블 미적용 환경에서는 false로 취급 (OTP → PIN 발급 흐름 유지)
    hasPin = false
  }
  let hasPassword = false
  try {
    const row = await c.env.DB.prepare(
      `SELECT email FROM accounts WHERE email = ?`
    ).bind(email).first<{ email: string }>()
    hasPassword = !!row
  } catch {
    hasPassword = false
  }
  return c.json({ ok: true, email, hasPin, hasPassword })
})

export { authApp }
