/**
 * 브라우저 라이브 세션 — Cloudflare Browser Run 세션을 발급하고
 * Live View URL을 돌려준다. 동시 세션은 KV로 1개만 허용한다.
 */

import { Hono } from 'hono'
import type { Env } from '../../types'
import { CONFIG } from '../../config'
import { navigateSession } from './cdp'

export const CF_BROWSER_URL = `https://api.cloudflare.com/client/v4/accounts/${CONFIG.cfAccountId}/browser-rendering/devtools/browser`
const LIVE_KV_KEY = 'browse:live:current'
const LIVE_SESSION_SEC = 120
const LIVE_KEEP_ALIVE_MS = LIVE_SESSION_SEC * 1000
const LIVE_KV_TTL_SEC = 180
const VIEW_URL_MARKER = 'live.browser.run/ui/view'

export function findLiveViewUrl(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.includes(VIEW_URL_MARKER) ? value : null
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findLiveViewUrl(item)
      if (found) return found
    }
    return null
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = findLiveViewUrl(item)
      if (found) return found
    }
  }
  return null
}

export function findWebSocketDebuggerUrl(data: unknown): { url: string; source: 'top' | 'target' } | null {
  if (data === null || typeof data !== 'object') return null
  const top = (data as Record<string, unknown>).webSocketDebuggerUrl
  if (typeof top === 'string' && top) return { url: top, source: 'top' }
  const candidates: Array<{ url: string; type?: unknown }> = []
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    const rec = value as Record<string, unknown>
    if (typeof rec.webSocketDebuggerUrl === 'string' && rec.webSocketDebuggerUrl) {
      candidates.push({ url: rec.webSocketDebuggerUrl, type: rec.type })
    }
    for (const item of Object.values(value)) walk(item)
  }
  walk(data)
  const page = candidates.find((cd) => cd.type === 'page')
  const chosen = page ?? candidates[0]
  return chosen ? { url: chosen.url, source: 'target' } : null
}

function toTabViewUrl(url: string): string {
  const q = url.indexOf('?')
  if (q === -1) return `${url}?mode=tab`
  const head = url.slice(0, q + 1)
  const rest = url.slice(q + 1)
  if (!rest) return `${head}mode=tab`
  let replaced = false
  const parts = rest.split('&').map((p) => {
    if (p === 'mode' || p.startsWith('mode=')) {
      replaced = true
      return 'mode=tab'
    }
    return p
  })
  if (!replaced) parts.unshift('mode=tab')
  return head + parts.join('&')
}

interface LiveRecord {
  sid: string
  exp: number
}

export function registerLiveRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post('/live-session', async (c) => {
    const token = c.env.BROWSER_RUN_TOKEN
    if (!token) return c.json({ ok: false, error: 'LIVE_NOT_CONFIGURED' }, 503)
    const body = await c.req.json().catch(() => null) as { url?: unknown; viewport?: unknown } | null
    let startUrl: string | null = null
    if (body && body.url !== undefined && body.url !== null && body.url !== '') {
      if (typeof body.url !== 'string' || body.url.length > 2048) {
        return c.json({ ok: false, error: 'INVALID_URL' }, 400)
      }
      let parsed: URL
      try {
        parsed = new URL(body.url)
      } catch {
        return c.json({ ok: false, error: 'INVALID_URL' }, 400)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return c.json({ ok: false, error: 'INVALID_URL' }, 400)
      }
      startUrl = parsed.toString()
    }
    // 원격 뷰포트 (2026-11-12: 기본 1280x720이 MyHub 창보다 넓으면
    // Live View가 짤린다 — 클라이언트가 iframe 크기를 보내면 맞춘다).
    // 범위를 벗어나면 무시하고 기본 뷰포트로 진행한다.
    let viewport: { width: number; height: number } | undefined
    if (body && body.viewport !== undefined && body.viewport !== null) {
      const v = body.viewport as { width?: unknown; height?: unknown }
      const w = typeof v.width === 'number' ? Math.round(v.width) : 0
      const h = typeof v.height === 'number' ? Math.round(v.height) : 0
      if (w >= 320 && w <= 3840 && h >= 240 && h <= 2160) {
        viewport = { width: w, height: h }
      }
    }
    const kv = c.env.KV
    const nowSec = Math.floor(Date.now() / 1000)
    const cur = await kv.get<LiveRecord>(LIVE_KV_KEY, 'json')
    if (cur && typeof cur.exp === 'number' && cur.exp > nowSec) {
      return c.json({ ok: false, error: 'LIVE_BUSY', retryAfterSec: cur.exp - nowSec }, 409)
    }
    let data: any = null
    try {
      const res = await fetch(`${CF_BROWSER_URL}?keep_alive=${LIVE_KEEP_ALIVE_MS}&targets=true`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.status === 429) return c.json({ ok: false, error: 'LIVE_QUOTA' }, 429)
      if (!res.ok) return c.json({ ok: false, error: 'LIVE_UPSTREAM' }, 502)
      data = await res.json()
    } catch {
      return c.json({ ok: false, error: 'LIVE_UPSTREAM' }, 502)
    }
    const rawViewUrl = findLiveViewUrl(data)
    const viewUrl = rawViewUrl ? toTabViewUrl(rawViewUrl) : null
    const sid = data?.sessionId
    if (!viewUrl || typeof sid !== 'string' || !sid) {
      return c.json({ ok: false, error: 'LIVE_UPSTREAM' }, 502)
    }
    const exp = nowSec + LIVE_SESSION_SEC
    const record: LiveRecord = { sid, exp }
    await kv.put(LIVE_KV_KEY, JSON.stringify(record), { expirationTtl: LIVE_KV_TTL_SEC })
    let nav = 'skip'
    let navStage = 'skip'
    let navSource: string | null = null
    if (startUrl) {
      const endpoint = findWebSocketDebuggerUrl(data)
      if (endpoint) {
        navSource = endpoint.source
        const result = await navigateSession(endpoint.url, startUrl, undefined, {
          headers: { Authorization: `Bearer ${token}` },
          viewport,
        }).catch(() => ({ ok: false, stage: 'connect' as const }))
        nav = result.ok ? 'ok' : 'fail'
        navStage = result.stage
      } else {
        nav = 'no-ws'
        navStage = 'no-ws'
      }
    }
    return c.json({ ok: true, viewUrl, expiresAt: exp * 1000, nav, navStage, navSource })
  })

  app.delete('/live-session', async (c) => {
    const kv = c.env.KV
    const cur = await kv.get<LiveRecord>(LIVE_KV_KEY, 'json')
    if (cur && typeof cur.sid === 'string' && cur.sid) {
      const token = c.env.BROWSER_RUN_TOKEN
      if (token) {
        try {
          await fetch(`${CF_BROWSER_URL}/${encodeURIComponent(cur.sid)}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          })
        } catch {
          // 세션 종료 실패는 무시 (KV 기록은 지운다)
        }
      }
      await kv.delete(LIVE_KV_KEY)
    }
    return c.json({ ok: true })
  })
}
