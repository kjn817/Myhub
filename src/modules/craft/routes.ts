/**
 * Craft Anything 모듈 라우트 — 빌더 백엔드 릴레이만 둔다 (Phase 0).
 *
 *   POST /api/craft/relay/:provider/chat/completions
 *   GET  /api/craft/relay/:provider/models
 *
 * 인증은 세션 쿠키가 아니라 ORIGIN_SECRET Bearer다 (relay.ts 참조).
 * 전역 미들웨어가 /api/craft/relay/를 면제하므로 이 라우트에서 직접 검증한다.
 */
import { Hono } from 'hono'
import type { Env } from '../../types'
import { handleChatCompletions, handleModels, isCraftRelayProvider, relayAuth } from './relay'

export const craftApp = new Hono<{ Bindings: Env }>()

craftApp.use('/relay/*', async (c, next) => {
  const auth = relayAuth(c.env, c.req.header('Authorization'))
  if (auth === 'disabled') {
    return c.json({ ok: false, error: 'relay_disabled', message: 'ORIGIN_SECRET 미설정 — 릴레이 비활성화' }, 503)
  }
  if (auth === 'unauthorized') {
    return c.json({ ok: false, error: 'unauthorized' }, 401)
  }
  return next()
})

craftApp.post('/relay/:provider/chat/completions', async (c) => {
  const provider = c.req.param('provider')
  if (!isCraftRelayProvider(provider)) {
    return c.json({ ok: false, error: 'unknown_provider', message: `unknown provider: ${provider}` }, 404)
  }
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ ok: false, error: 'invalid_body' }, 400)
  }
  return handleChatCompletions(c.env, provider, body as Record<string, unknown>)
})

craftApp.get('/relay/:provider/models', async (c) => {
  const provider = c.req.param('provider')
  if (!isCraftRelayProvider(provider)) {
    return c.json({ ok: false, error: 'unknown_provider', message: `unknown provider: ${provider}` }, 404)
  }
  return handleModels(c.env, provider)
})
