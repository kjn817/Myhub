// Google 연동 모듈 — OAuth + Gmail/Calendar 읽기 API
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
  getValidAccessToken,
  hasCalendarWriteScope,
  saveGoogleTokens,
} from '../../services/google-tokens'
import {
  getGmailMessage,
  getGmailProfile,
  listCalendarEvents,
  listGmailMessages,
  createCalendarEvent,
} from '../../services/google-client'
import { getLastSyncLog } from '../../services/google-sync'

export const googleApp = new Hono<{ Bindings: Env }>()

function dashboardRedirect(c: { redirect: (url: string, status?: any) => Response }, query: string) {
  return c.redirect(`/schedule.html?google=${query}`, 302)
}

// 연동 상태 — 토큰 값은 절대 반환하지 않는다
googleApp.get('/status', async (c) => {
  const status = await getGoogleStatus(c.env as any).catch(() => ({ connected: false }))
  const syncLog = status.connected ? await getLastSyncLog(c.env as any) : []
  return c.json({ ok: true, ...status, configured: isGoogleOAuthConfigured(c.env as any), writeEnabled: isGoogleWriteEnabled(c.env as any), lastSync: syncLog })
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

// Gmail 검색 — q 없으면 읽지 않은 메일
googleApp.get('/gmail/search', async (c) => {
  const token = await getValidAccessToken(fetch, c.env as any)
  if (!token.ok) {
    return c.json({ ok: false, error: token.reason === 'not_connected' ? 'google_not_connected' : token.reason }, 401)
  }
  const q = c.req.query('q')?.trim() || 'is:unread'
  const max = Math.min(Math.max(Number(c.req.query('max')) || 10, 1), 10)
  const res = await listGmailMessages(fetch, token.accessToken, { q, maxResults: max })
  if (!res.ok) return c.json({ ok: false, error: res.error }, 502)
  return c.json({
    ok: true,
    messages: res.data.map((m) => ({ id: m.id, from: m.from, subject: m.subject, date: m.date, snippet: m.snippet })),
  })
})

// Gmail 단건 조회 — 본문은 5,000자로 절단 (사용자 본인 화면용)
googleApp.get('/gmail/:id', async (c) => {
  const token = await getValidAccessToken(fetch, c.env as any)
  if (!token.ok) {
    return c.json({ ok: false, error: token.reason === 'not_connected' ? 'google_not_connected' : token.reason }, 401)
  }
  const res = await getGmailMessage(fetch, token.accessToken, c.req.param('id'), true)
  if (!res.ok) return c.json({ ok: false, error: res.error }, 502)
  return c.json({
    ok: true,
    message: { ...res.data, bodyText: res.data.bodyText.slice(0, 5000) },
  })
})

// 캘린더 이벤트 조회 — from/to = YYYY-MM-DD (기본: 오늘)
googleApp.get('/calendar/events', async (c) => {
  const token = await getValidAccessToken(fetch, c.env as any)
  if (!token.ok) {
    return c.json({ ok: false, error: token.reason === 'not_connected' ? 'google_not_connected' : token.reason }, 401)
  }
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const from = c.req.query('from')?.trim() || today
  const to = c.req.query('to')?.trim() || from
  const res = await listCalendarEvents(fetch, token.accessToken, {
    timeMin: `${from}T00:00:00+09:00`,
    timeMax: `${to}T23:59:59+09:00`,
  })
  if (!res.ok) return c.json({ ok: false, error: res.error }, 502)
  return c.json({ ok: true, events: res.data })
})

// 캘린더 일정 생성 — 쓰기 scope가 없으면 거부 (설계 §3 결정 필요)
googleApp.post('/calendar/events', async (c) => {
  const token = await getValidAccessToken(fetch, c.env as any)
  if (!token.ok) {
    return c.json({ ok: false, error: token.reason === 'not_connected' ? 'google_not_connected' : token.reason }, 401)
  }
  if (!hasCalendarWriteScope(token.tokens)) {
    return c.json({ ok: false, error: 'scope_missing' }, 403)
  }
  const json = await c.req.json().catch(() => null)
  const summary = typeof json?.summary === 'string' ? json.summary.trim() : ''
  const start = typeof json?.start === 'string' ? json.start.trim() : ''
  if (!summary || !start) return c.json({ ok: false, error: 'invalid_input' }, 400)
  const res = await createCalendarEvent(fetch, token.accessToken, {
    summary,
    start,
    end: typeof json?.end === 'string' ? json.end : undefined,
    description: typeof json?.description === 'string' ? json.description : undefined,
    location: typeof json?.location === 'string' ? json.location : undefined,
  })
  if (!res.ok) return c.json({ ok: false, error: res.error }, 502)
  return c.json({ ok: true, event: res.data })
})
