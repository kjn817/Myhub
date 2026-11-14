// Google 연동 모듈 — OAuth + 연동 상태·동기화
// Gmail/Calendar 직접 조회·생성 HTTP 엔드포인트는 D3 결정(2026-11-14)으로
// 삭제 — 비서·일정 동기화는 google-tools·schedule-google-events 서비스를
// 직접 사용한다.
// 인증은 전역 미들웨어(verifySession)에서 처리됨
// 설계: docs/gmail-calendar-design.md §7
// - 실제 Google 콘솔 설정(결정 ①)이 없어도 라우트·토큰 저장은 동작한다.
// - 토큰이 없으면 모든 연동 API는 google_not_connected를 반환하고 기존 기능에는 영향이 없다.

import { Hono } from 'hono'
import type { Env } from '../../types'
import {
  buildAuthUrl,
  consumeOAuthState,
  exchangeCodeForTokens,
  generatePKCE,
  isGoogleOAuthConfigured,
  isGoogleWriteEnabled,
  randomToken,
  redirectUriFor,
  revokeToken,
  saveOAuthState,
  scopesForMode,
} from '../../services/google-oauth'
import {
  deleteGoogleTokens,
  getGoogleStatus,
  getGoogleTokens,
  saveGoogleTokens,
} from '../../services/google-tokens'
import {
  getGmailProfile,
} from '../../services/google-client'
import { getLastSyncLog } from '../../services/google-sync'
import { backfillUnsyncedSchedules, getScheduleSyncCounts } from '../../services/schedule-google-sync'

export const googleApp = new Hono<{ Bindings: Env }>()

function dashboardRedirect(c: { redirect: (url: string, status?: any) => Response }, query: string) {
  return c.redirect(`/schedule.html?google=${query}`, 302)
}

// 연동 상태 — 토큰 값은 절대 반환하지 않는다
googleApp.get('/status', async (c) => {
  const status = await getGoogleStatus(c.env).catch(() => ({ connected: false }))
  const syncLog = await getLastSyncLog(c.env).catch(() => [])
  const scheduleSync = await getScheduleSyncCounts(c.env).catch(() => null)
  return c.json({
    ok: true,
    ...status,
    configured: isGoogleOAuthConfigured(c.env),
    writeEnabled: isGoogleWriteEnabled(c.env),
    lastSync: syncLog,
    scheduleSync,
  })
})

// 미동기 일정 백필 — 구글에 아직 없는 일정을 일괄 등록한다
googleApp.post('/backfill', async (c) => {
  const result = await backfillUnsyncedSchedules(fetch, c.env).catch(() => ({
    ran: false,
    reason: 'exception',
    scanned: 0,
    created: 0,
    updated: 0,
    deleted: 0,
    failed: 0,
    skipped: 0,
  }))
  return c.json({ ok: true, backfill: result })
})

// OAuth 시작 — Google 동의 화면으로 리다이렉트
googleApp.get('/oauth/start', async (c) => {
  if (!isGoogleOAuthConfigured(c.env as any)) {
    return c.json({ ok: false, error: 'google_oauth_not_configured' }, 503)
  }
  const mode = c.req.query('mode') === 'write' ? 'write' : 'read'
  // 결정 필요 (설계 §9-②): 쓰기 scope는 플래그가 명시적으로 켜져 있을 때만 허용
  if (mode === 'write' && !isGoogleWriteEnabled(c.env as any)) {
    return c.json({ ok: false, error: 'google_write_not_enabled' }, 400)
  }
  const origin = new URL(c.req.url).origin
  const nonce = randomToken(24)
  const { verifier, challenge } = await generatePKCE()
  try {
    await saveOAuthState(c.env as any, nonce, { verifier, mode, createdAt: Date.now() })
  } catch {
    return c.json({ ok: false, error: 'state_store_failed' }, 500)
  }
  const url = buildAuthUrl(c.env as any, { origin, mode, state: nonce, challenge })
  return c.redirect(url, 302)
})

// OAuth 콜백 — code 교환 → 토큰 암호화 저장 → 대시보드로 복귀
googleApp.get('/oauth/callback', async (c) => {
  const error = c.req.query('error')
  if (error) {
    // 사용자가 동의를 거부한 경우 등 — 토큰을 저장하지 않는다
    return dashboardRedirect(c, error === 'access_denied' ? 'denied' : 'error')
  }
  const code = c.req.query('code')
  const state = c.req.query('state')
  if (!code || !state) return c.json({ ok: false, error: 'missing_code_or_state' }, 400)
  const saved = await consumeOAuthState(c.env as any, state)
  if (!saved) return c.json({ ok: false, error: 'invalid_state' }, 400)
  const origin = new URL(c.req.url).origin
  const exchanged = await exchangeCodeForTokens(fetch, c.env as any, {
    code,
    verifier: saved.verifier,
    redirectUri: redirectUriFor(origin),
  })
  if (!exchanged.ok) return dashboardRedirect(c, 'error')
  const tokens = exchanged.tokens
  // 이메일은 프로필 조회로 채운다 (실패 시 빈 값 — 연동 자체는 유지)
  let email = ''
  const profile = await getGmailProfile(fetch, tokens.access_token)
  if (profile.ok) email = profile.data.emailAddress || ''
  await saveGoogleTokens(c.env as any, {
    email,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || '',
    scope: tokens.scope || scopesForMode(saved.mode).join(' '),
    expiresIn: tokens.expires_in || 3600,
  })
  // 연동 직후 미동기 일정을 백필한다 (실패해도 연동 완료 흐름은 유지)
  await backfillUnsyncedSchedules(fetch, c.env).catch(() => null)
  return dashboardRedirect(c, 'connected')
})

// 연동 해제 — revoke 베스트 에포트 + 로컬 토큰 삭제
googleApp.post('/disconnect', async (c) => {
  const tokens = await getGoogleTokens(c.env as any).catch(() => null)
  if (tokens?.refreshToken) {
    await revokeToken(fetch, tokens.refreshToken)
  } else if (tokens?.accessToken) {
    await revokeToken(fetch, tokens.accessToken)
  }
  await deleteGoogleTokens(c.env as any)
  try {
    await c.env.KV.delete('google:sync:last')
  } catch {
    // 마커 삭제 실패는 무시
  }
  return c.json({ ok: true })
})

