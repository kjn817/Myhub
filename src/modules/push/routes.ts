import { Hono } from 'hono'
import type { Env } from '../../types'
import { getVapidPublicKey, isPushConfigured } from '../../services/push'

// Web Push 구독 관리
// 인증은 전역 미들웨어(verifySession)에서 처리됨

export const pushApp = new Hono<{ Bindings: Env }>()

function isValidSubscription(json: any): json is { endpoint: string; keys: { p256dh: string; auth: string } } {
  if (!json || typeof json.endpoint !== 'string') return false
  try {
    const u = new URL(json.endpoint)
    if (u.protocol !== 'https:') return false
  } catch {
    return false
  }
  const keys = json.keys
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return false
  // base64url 문자만 허용, 길이 상한
  if (!/^[A-Za-z0-9_-]+$/.test(keys.p256dh) || keys.p256dh.length > 200) return false
  if (!/^[A-Za-z0-9_-]+$/.test(keys.auth) || keys.auth.length > 100) return false
  if (json.endpoint.length > 2000) return false
  return true
}

// VAPID 공개키 (브라우저 구독용)
pushApp.get('/vapid-key', async (c) => {
  if (!isPushConfigured(c.env)) {
    return c.json({ ok: false, error: 'push_not_configured' }, 503)
  }
  try {
    const publicKey = await getVapidPublicKey(c.env)
    return c.json({ ok: true, publicKey })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'vapid_error' }, 500)
  }
})

// 구독 저장 (upsert)
pushApp.post('/subscribe', async (c) => {
  const json = await c.req.json().catch(() => null)
  if (!isValidSubscription(json)) {
    return c.json({ ok: false, error: 'invalid_subscription' }, 400)
  }
  try {
    await c.env.DB.prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth)
       VALUES (?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
    ).bind(json.endpoint, json.keys.p256dh, json.keys.auth).run()
    return c.json({ ok: true })
  } catch {
    return c.json({ ok: false, error: 'db_error' }, 500)
  }
})

// 구독 삭제
pushApp.delete('/unsubscribe', async (c) => {
  const json = await c.req.json().catch(() => null)
  const endpoint = json?.endpoint
  if (typeof endpoint !== 'string' || endpoint.length > 2000) {
    return c.json({ ok: false, error: 'invalid_endpoint' }, 400)
  }
  try {
    await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run()
    return c.json({ ok: true })
  } catch {
    return c.json({ ok: false, error: 'db_error' }, 500)
  }
})
