import type { Env } from '../../types'
import { CONFIG } from '../../config'

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
    return CONFIG.productionEmail
  }
  // 알 수 없는 환경 → fail-closed
  return null
}


// 6자리 인증코드 생성 (CSPRNG)
export function genCode(): string {
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
export const SESSION_COOKIE_MAX_AGE = SESSION_TTL_MS / 1000

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

// ---------------- 보호 메모 step-up (트랙 2, 2026-10-31) ----------------
// step-up 창: PIN 재확인(해제·/step-up·PIN 로그인)에 성공하면 세션 토큰에
// `su`(step-up 만료 epoch ms) 클레임을 실어 5분간 보호 메모 접근을 연다.
// 해제 step-up과 읽기 게이트가 같은 클레임·같은 창을 공유하므로 이중 입력이 없다.
// OTP 창: OTP 본인확인으로 발급된 토큰에는 `oa`(OTP 확인 epoch ms)를 실어,
// set-pin이 "OTP 확인 후 10분 이내"인지를 토큰만으로 판정한다.
export const STEP_UP_TTL_MS = 5 * 60 * 1000
export const OTP_SET_PIN_WINDOW_MS = 10 * 60 * 1000

export interface SessionClaims {
  /** step-up 만료 (epoch ms). 이 시각 전까지 보호 메모 접근 허용. */
  suUntil?: number
  /** OTP 본인확인 시각 (epoch ms). method='otp' 토큰에만 싣는다. */
  otpAt?: number
}

// 세션 토큰 생성 (HMAC 서명)
export async function createSession(
  email: string,
  secret: string,
  method: SessionMethod,
  version: number,
  claims: SessionClaims = {},
): Promise<string> {
  const exp = Date.now() + SESSION_TTL_MS
  const payloadObj: Record<string, unknown> = { email, exp, method, v: version }
  if (typeof claims.suUntil === 'number' && claims.suUntil > 0) payloadObj.su = claims.suUntil
  if (typeof claims.otpAt === 'number' && claims.otpAt > 0) payloadObj.oa = claims.otpAt
  const payload = JSON.stringify(payloadObj)
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
  /** step-up 만료 (epoch ms). 클레임이 없으면 null. */
  suUntil: number | null
  /** OTP 본인확인 시각 (epoch ms). 클레임이 없으면 null. */
  otpAt: number | null
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
    const parsed = JSON.parse(payload) as { email?: unknown; exp?: unknown; method?: unknown; v?: unknown; su?: unknown; oa?: unknown }
    if (typeof parsed.email !== 'string' || typeof parsed.exp !== 'number') return null
    if (Date.now() > parsed.exp) return null
    if (allowedEmail && parsed.email !== allowedEmail) return null
    // 구 토큰(0045 이전)에는 method/v가 없다 — method는 null, 버전은 0으로 간주한다.
    // method가 null이면 set-pin step-up에서 OTP로 인정하지 않는다.
    const method: SessionMethod | null = parsed.method === 'otp' ? 'otp' : parsed.method === 'pin' ? 'pin' : null
    const version = typeof parsed.v === 'number' && Number.isFinite(parsed.v) && parsed.v >= 0 ? Math.floor(parsed.v) : 0
    // su/oa 클레임: 양의 유한수일 때만 인정한다 (그 외는 없음 취급 — fail-closed).
    const suUntil = typeof parsed.su === 'number' && Number.isFinite(parsed.su) && parsed.su > 0 ? parsed.su : null
    const otpAt = typeof parsed.oa === 'number' && Number.isFinite(parsed.oa) && parsed.oa > 0 ? parsed.oa : null
    return { email: parsed.email, method, version, suUntil, otpAt }
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

/** step-up 창이 살아 있는 세션인지 (보호 메모 게이트 판정 공용). */
export function hasActiveStepUp(info: SessionInfo | null, now: number = Date.now()): boolean {
  return !!info && typeof info.suUntil === 'number' && info.suUntil > now
}

/** 현재 요청의 세션 쿠키를 step-up 창(5분)을 실은 새 토큰으로 재발급한다.
 *  method·버전·OTP 확인 시각은 그대로 보존하고 버전은 올리지 않으므로
 *  다른 기기의 세션을 끊지 않는다. 세션이 없거나 검증에 실패하면 아무것도
 *  하지 않는다 (호출자의 본래 동작을 깨지 않는 것이 우선). */
export async function grantStepUp(c: any): Promise<boolean> {
  try {
    const cookie = (typeof c.req?.header === 'function' ? c.req.header('Cookie') : '') || ''
    const m = cookie.match(/myhub_session=([^;]+)/)
    if (!m) return false
    const info = await verifySessionForEnv(c.env, m[1])
    if (!info || !info.method) return false
    const suUntil = Date.now() + STEP_UP_TTL_MS
    const token = await createSession(info.email, c.env.SESSION_SECRET, info.method, info.version, {
      suUntil,
      otpAt: info.otpAt ?? undefined,
    })
    c.header('Set-Cookie', `myhub_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE}`)
    return true
  } catch {
    return false
  }
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

