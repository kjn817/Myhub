/**
 * LUKS 볼륨 언록 API (2026-11-15, "MyHub에서 풀기" 결정).
 *
 * 원격 브라우저 프로필(/config)이 LUKS 암호화 볼륨(/opt/myhub-browser/data)
 * 위에 있다. 서버가 재부팅되면 볼륨이 잠긴 채로 chromium이 뜨지 않으므로,
 * MyHub에서 암호를 입력해 호스트 언록 서비스(myhub-unlock.py)를 거쳐
 * 볼륨을 연 뒤 chromium을 기동한다.
 *
 * - GET  /unlock/status → 사이드카 /unlock/status 중계 (configured·unlocked·
 *   lockout_remaining 등). 세션 게이트 뒤에 있다 (전역 /api/* 미들웨어).
 * - POST /unlock/unlock { password } → 볼륨 언록 + 마운트 + chromium 기동.
 * - POST /unlock/setup  { password } → 최초 1회 luksFormat + 마이그레이션.
 *   이미 LUKS면 서비스가 거절한다 (재포맷 방지).
 *
 * 보안:
 * - 암호는 본문으로만 전달하고 로그·에러 응답에 절대 남기지 않는다.
 * - Worker는 암호를 저장하지 않는다 (요청 본문에서 사이드카로 직행).
 * - UNLOCK_SECRET이 없으면 503 (fail-closed — 서비스와 같은 값을 대시보드에
 *   등록해야 동작한다. 값은 사용자가 자기 맥에서 생성해 직접 입력한다).
 * - /navigate 잠금 차단(isBrowserLocked)은 UX용 빠른 길이다: 상태 조회가
 *   실패하면 차단하지 않고 정상 흐름에 맡긴다 (chromium이 떠 있으면
 *   네비게이션이 성공하고, 안 떠 있으면 ORACLE_UPSTREAM이 된다).
 */
import { Hono } from 'hono'
import type { Env } from '../../types'
import { ORACLE_VIEW_PORT, oracleConfigOf, type OracleConfig } from './oracle-proxy'

export const UNLOCK_MIN_PASSWORD_LENGTH = 8
export const UNLOCK_MAX_PASSWORD_LENGTH = 256

export interface UnlockStatus {
  configured: boolean
  unlocked: boolean
  locked_out?: boolean
  lockout_remaining?: number
  failed_attempts?: number
}

function unlockSecretOf(env: Env): string | null {
  const secret = env.UNLOCK_SECRET
  if (!secret || secret.length < 16) return null
  return secret
}

async function fetchUnlockService(
  cfg: OracleConfig,
  unlockSecret: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const headers = new Headers(init.headers || {})
  headers.set('x-origin-secret', cfg.originSecret)
  headers.set('x-unlock-secret', unlockSecret)
  return fetch(`https://${cfg.host}:${ORACLE_VIEW_PORT}/unlock${path}`, { ...init, headers })
}

/** 잠금 여부를 묻는다. 조회 실패 시 null (호출부가 정상 흐름으로 진행). */
export async function fetchUnlockStatus(
  cfg: OracleConfig,
  unlockSecret: string,
): Promise<UnlockStatus | null> {
  try {
    const res = await fetchUnlockService(cfg, unlockSecret, '/status', { method: 'GET' })
    if (!res.ok) return null
    const body = (await res.json()) as Partial<UnlockStatus>
    if (typeof body.configured !== 'boolean' || typeof body.unlocked !== 'boolean') return null
    return body as UnlockStatus
  } catch {
    return null
  }
}

/** 볼륨이 설정됐고 잠겨 있으면 true. 미설정이거나 조회 실패면 false. */
export async function isBrowserLocked(
  cfg: OracleConfig,
  unlockSecret: string,
): Promise<boolean> {
  const status = await fetchUnlockStatus(cfg, unlockSecret)
  return !!status && status.configured && !status.unlocked
}

function parsePassword(raw: unknown): { ok: true; password: string } | { ok: false } {
  if (typeof raw !== 'string') return { ok: false }
  if (raw.length < UNLOCK_MIN_PASSWORD_LENGTH || raw.length > UNLOCK_MAX_PASSWORD_LENGTH) {
    return { ok: false }
  }
  return { ok: true, password: raw }
}

export function registerUnlockRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get('/unlock/status', async (c) => {
    const cfg = oracleConfigOf(c.env)
    if (!cfg) return c.json({ ok: false, error: 'ORACLE_NOT_CONFIGURED' }, 503)
    const unlockSecret = unlockSecretOf(c.env)
    if (!unlockSecret) return c.json({ ok: false, error: 'UNLOCK_NOT_CONFIGURED' }, 503)
    try {
      const res = await fetchUnlockService(cfg, unlockSecret, '/status', { method: 'GET' })
      const body = await res.json().catch(() => ({}))
      return c.json(body, res.status as 200)
    } catch {
      return c.json({ ok: false, error: 'ORACLE_UPSTREAM' }, 502)
    }
  })

  for (const route of ['/unlock/unlock', '/unlock/setup'] as const) {
    app.post(route, async (c) => {
      const cfg = oracleConfigOf(c.env)
      if (!cfg) return c.json({ ok: false, error: 'ORACLE_NOT_CONFIGURED' }, 503)
      const unlockSecret = unlockSecretOf(c.env)
      if (!unlockSecret) return c.json({ ok: false, error: 'UNLOCK_NOT_CONFIGURED' }, 503)
      let body: { password?: unknown } = {}
      try {
        body = (await c.req.json()) as { password?: unknown }
      } catch {
        return c.json({ ok: false, error: 'INVALID_PASSWORD' }, 400)
      }
      const parsed = parsePassword(body.password)
      if (!parsed.ok) return c.json({ ok: false, error: 'INVALID_PASSWORD' }, 400)
      try {
        const res = await fetchUnlockService(cfg, unlockSecret, route.slice('/unlock'.length), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: parsed.password }),
        })
        const resBody = await res.json().catch(() => ({}))
        return c.json(resBody, res.status as 200)
      } catch {
        return c.json({ ok: false, error: 'ORACLE_UPSTREAM' }, 502)
      }
    })
  }
}
