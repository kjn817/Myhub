import { Hono } from 'hono'
import type { Env } from '../../types'
import {
  getAuthEmail, isValidPin, hashPin, verifyPin, createSession, getSessionVersion,
  bumpSessionVersion, verifySessionForEnv, getClientIp, checkRateLimit, checkRateLimitForIp,
  isValidB64, PIN_FAIL_LIMIT, PIN_FAIL_WINDOW_SEC, SESSION_COOKIE_MAX_AGE, STEP_UP_TTL_MS,
  OTP_SET_PIN_WINDOW_MS, type DbLike,
} from './primitives'

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

export function registerAuthPinRoutes(authApp: Hono<{ Bindings: Env }>): void {
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
    // PIN 확인 직후이므로 step-up 창(5분)을 함께 발급한다 (보호 메모 게이트와 통합).
    const token = await createSession(normEmail, c.env.SESSION_SECRET, 'pin', await getSessionVersion(c.env, normEmail), { suUntil: Date.now() + STEP_UP_TTL_MS })
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
  // PIN 확인 직후이므로 step-up 창(5분)을 함께 발급한다 (보호 메모 게이트와 통합).
  const token = await createSession(normEmail, c.env.SESSION_SECRET, 'pin', await getSessionVersion(c.env, normEmail), { suUntil: Date.now() + STEP_UP_TTL_MS })
  const cookie = `myhub_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE}`
  c.header('Set-Cookie', cookie)
  return c.json({ ok: true })
})

// PIN 설정/재발급 — OTP 본인확인 세션 필요 (최초 설정·재발급 모두 OTP 본인확인으로 받은 세션으로 수행).
// 행을 통째로 교체(UPSERT)하므로 재발급 즉시 기존 PIN은 무효가 된다.
// - step-up (run-001 low auth/set-pin-no-step-up 수정):
//   PIN 로그인 세션만으로는 재설정 불가. OTP로 발급된 세션만 받는다.
//   구 토큰(method 없음)도 OTP로 인정하지 않는다 — OTP로 다시 로그인하면 새 토큰이 나온다.
// - OTP 창 (트랙 2, 2026-10-31): OTP 세션이라도 본인확인(oa 클레임) 후
//   10분이 지난 토큰은 PIN 설정·변경을 할 수 없다. 탈취된 OTP 세션의
//   PIN 교체 창을 본인확인 직후로 한정한다.
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
  // OTP 세션 분리 (트랙 2, 2026-10-31): OTP 세션 자체는 30일 유효하지만
  // PIN 설정·변경 권한은 본인확인 후 10분 창에만 둔다. oa 클레임이 없는
  // OTP 토큰(창 도입 전 발급분)은 확인 시각을 알 수 없어 인정하지 않는다 —
  // OTP로 다시 본인확인하면 새 토큰이 나온다.
  if (!session.otpAt || Date.now() - session.otpAt > OTP_SET_PIN_WINDOW_MS) {
    return c.json({
      ok: false,
      code: 'OTP_WINDOW_EXPIRED',
      error: 'PIN 설정은 인증코드 확인 후 10분 이내에만 가능합니다. 인증코드로 다시 본인 확인하세요.',
    }, 403)
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
  // 방금 PIN을 직접 입력했으므로 step-up 창(5분)도 함께 발급한다.
  const token = await createSession(normEmail, c.env.SESSION_SECRET, 'pin', nextVersion, { suUntil: Date.now() + STEP_UP_TTL_MS })
  c.header('Set-Cookie', `myhub_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE}`)
  return c.json({ ok: true })
})

// 보호 메모 step-up — PIN 재확인으로 5분 접근 창을 발급한다 (트랙 2, 2026-10-31).
// - 보호 메모 게이트(상세 열람·덮어쓰기·삭제·잠긴 첨부·블록)가 403
//   STEP_UP_REQUIRED를 돌려주면 프론트가 PIN 모달 → 이 엔드포인트 → 재시도한다.
// - 해제 step-up(memo 모듈 checkUnlockPin)과 같은 창(su 클레임)을 공유한다:
//   어느 쪽으로 통과해도 반대쪽이 열린다.
// - PIN 미설정 계정은 게이트 자체가 면제이므로 여기서도 성공으로 돌려준다
//   (모달이 뜰 일이 없지만, 직접 호출돼도 lockout을 만들지 않는다).
// - PIN 시도 속도 제한은 해제 경로와 같은 전역 버킷(unlock-pin:global,
}
