import { Hono } from 'hono'
import type { Env } from '../../types'
import {
  getAuthEmail, genCode, sendOtpEmail, createSession, getSessionVersion,
  getClientIp, checkRateLimit, checkRateLimitForIp, OTP_TTL_MS, SESSION_COOKIE_MAX_AGE,
} from './primitives'

export function maskAuthEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return ''
  const local = email.slice(0, at)
  const head = local.slice(0, Math.min(2, local.length))
  return `${head}${'*'.repeat(Math.max(1, local.length - head.length))}${email.slice(at)}`
}

export function registerAuthOtpRoutes(authApp: Hono<{ Bindings: Env }>): void {
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
      return c.json({ ok: true, sentToMasked: maskAuthEmail(normEmail), ttlSec: Math.floor(OTP_TTL_MS / 1000) })
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

  return c.json({ ok: true, sentToMasked: maskAuthEmail(normEmail), ttlSec: Math.floor(OTP_TTL_MS / 1000) })
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
    // oa 클레임에 본인확인 시각을 실어 set-pin의 10분 창 판정에 쓴다.
    const token = await createSession(normEmail, c.env.SESSION_SECRET, 'otp', await getSessionVersion(c.env, normEmail), { otpAt: Date.now() })

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

}
