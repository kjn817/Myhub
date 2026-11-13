import { Hono } from 'hono'
import type { Env } from '../../types'
import {
  getAuthEmail, isValidPin, verifyPin, createSession, verifySessionForEnv, verifySessionInfo,
  bumpSessionVersion, checkRateLimit, isValidB64, SESSION_COOKIE_MAX_AGE, STEP_UP_TTL_MS,
} from './primitives'
import { registerAuthOtpRoutes } from './routes-otp'
import { registerAuthPinRoutes } from './routes-pin'

// 기존 import 경로 호환: 프리미티브는 routes.ts에서도 재노출한다.
export * from './primitives'

const authApp = new Hono<{ Bindings: Env }>()
registerAuthOtpRoutes(authApp)
registerAuthPinRoutes(authApp)

authApp.post('/step-up', async (c) => {
  const normEmail = getAuthEmail(c.env)
  if (!normEmail) {
    return c.json({ ok: false, error: '인증 설정 오류' }, 500)
  }
  const cookie = c.req.header('Cookie') || ''
  const m = cookie.match(/myhub_session=([^;]+)/)
  if (!m) return c.json({ ok: false, error: '로그인이 필요합니다.' }, 401)
  const session = await verifySessionForEnv(c.env, m[1], normEmail)
  if (!session) return c.json({ ok: false, error: '로그인이 필요합니다.' }, 401)

  let row: { pin_hash: string; pin_salt: string; iterations: number } | null = null
  try {
    row = await c.env.DB.prepare(
      'SELECT pin_hash, pin_salt, iterations FROM auth_pins WHERE email = ?'
    ).bind(normEmail).first()
  } catch {
    // auth_pins 미적용 환경 — PIN 미설정과 동일 취급 (면제)
    return c.json({ ok: true, exempt: true })
  }
  if (!row) return c.json({ ok: true, exempt: true }) // PIN 미설정 → 면제

  if (
    !isValidB64(row.pin_salt, 16) ||
    !isValidB64(row.pin_hash, 32) ||
    !Number.isInteger(row.iterations) ||
    row.iterations < 1
  ) {
    return c.json({ ok: false, error: 'pin_verify_error' }, 500)
  }

  const body = await c.req.json<{ pin?: string }>().catch(() => ({} as { pin?: string }))
  const pin = body.pin
  if (!isValidPin(pin)) {
    return c.json({ ok: false, error: 'pin_required', code: 'PIN_REQUIRED' }, 403)
  }
  try {
    if (await checkRateLimit(c.env.DB, 'unlock-pin:global', 10, 3600)) {
      return c.json({ ok: false, error: 'pin_rate_limited', code: 'PIN_RATE_LIMITED' }, 429)
    }
  } catch {
    // rate_limits 미적용 환경에서는 제한만 건너뛴다 (PIN 검증은 아래에서 강제)
  }
  let okPin = false
  try {
    okPin = await verifyPin(pin, row)
  } catch {
    return c.json({ ok: false, error: 'pin_verify_error' }, 500)
  }
  if (!okPin) {
    return c.json({ ok: false, error: 'pin_invalid', code: 'PIN_INVALID' }, 403)
  }

  const suUntil = Date.now() + STEP_UP_TTL_MS
  const token = await createSession(session.email, c.env.SESSION_SECRET, session.method ?? 'pin', session.version, {
    suUntil,
    otpAt: session.otpAt ?? undefined,
  })
  c.header('Set-Cookie', `myhub_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE}`)
  return c.json({ ok: true, stepUpUntil: suUntil })
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
