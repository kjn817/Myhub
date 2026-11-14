/**
 * Oracle 원격 브라우저 프록시 — Worker가 오라클 서버의 엣지 사이드카로
 * 화면·CDP를 중계한다 (2026-11-14 설계 변경: Cloudflare Browser Run
 * 세션 발급 폐기, 상시 기동 서버로 단일화).
 *
 * - GET /view/* → http://<호스트>:8080/api/browse/view/* (Selkies 화면, WS 포함)
 *   — 접두사를 떼지 않고 통째로 보낸다. 컨테이너의 kclient·nginx가
 *   SUBFOLDER=/api/browse/view/로 같은 접두사를 알기 때문이다. 접두사를
 *   떼면 kclient가 화면 WS를 루트 /websockify로 보내 Worker에 닿지 않아
 *   화면이 검은 채 "WebSocket disconnected"가 된다 (2026-11-14 라이브 실증).
 * - GET /cdp/*  → http://<호스트>:8081/* (CDP HTTP/WS, WS 포함)
 *   — CDP는 접두사 개념이 없어 사이드카가 바라는 맨 경로로 떼서 보낸다.
 * - POST /navigate → 사이드카 CDP로 영구 탭을 이동시킨다
 *
 * 세션 게이트는 전역 /api/* 미들웨어가 맡는다. 여기는 사이드카 시크릿
 * 주입 + WS 패스스루만 한다. 클라이언트가 보낸 시크릿 헤더·쿠키는
 * 절대 전달하지 않고 env 값으로 덮어쓴다. 시크릿이 하나라도 없으면
 * 503 ORACLE_NOT_CONFIGURED.
 *
 * WS는 fetch 업그레이드 응답을 그대로 반환해 패스스루한다 (Upgrade 1회만
 * 요청으로 과금, 이후 메시지는 추가 요청 아님). 본문이 있는 프록시
 * 요청은 ArrayBuffer로 읽어 전달한다 (스트림 duplex 문제 회피).
 */
import { Hono } from 'hono'
import type { Env } from '../../types'
import { defaultCdpConnect, navigateSession, toDirectCdpWsUrl, type ViewportSize } from './cdp'

export const ORACLE_VIEW_PORT = 8080
export const ORACLE_CDP_PORT = 8081
/** 프록시가 마운트되는 전체 경로 접두사 (modules.ts 결선과 동일해야 함). */
export const ORACLE_PROXY_MOUNT = '/api/browse'

export interface OracleConfig {
  host: string
  originSecret: string
  cdpSecret: string
  selkiesPassword: string
}

export function oracleConfigOf(env: Env): OracleConfig | null {
  const host = env.ORACLE_BROWSER_HOST
  const originSecret = env.ORIGIN_SECRET
  const cdpSecret = env.CDP_SECRET
  const selkiesPassword = env.SELKIES_PASSWORD
  if (!host || !originSecret || !cdpSecret || !selkiesPassword) return null
  return { host, originSecret, cdpSecret, selkiesPassword }
}

/** 프록시에서 전달하지 않는 헤더 — hop-by-hop + 클라이언트 자격증명. */
const DROP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'host',
  'cookie',
  'authorization',
  'x-origin-secret',
  'x-cdp-secret',
])

function buildUpstreamHeaders(req: Request, extra: Record<string, string>): Headers {
  const headers = new Headers()
  req.headers.forEach((value, name) => {
    if (DROP_HEADERS.has(name.toLowerCase())) return
    headers.set(name, value)
  })
  for (const [name, value] of Object.entries(extra)) headers.set(name, value)
  return headers
}

async function proxyToSidecar(
  c: { req: { raw: Request; url: string }; json: (body: unknown, status?: number) => Response },
  cfg: OracleConfig,
  port: number,
  prefix: string,
  extraHeaders: Record<string, string>,
  keepPrefix = false,
): Promise<Response> {
  const url = new URL(c.req.url)
  // keepPrefix면 전체 경로를 그대로 보낸다 (view — 컨테이너 SUBFOLDER와 일치).
  // 아니면 마운트 접두사를 떼고 맨 경로만 보낸다 (CDP).
  const rest = keepPrefix ? url.pathname : url.pathname.slice(prefix.length) || '/'
  const upstream = `http://${cfg.host}:${port}${rest}${url.search}`
  const req = c.req.raw
  const method = req.method.toUpperCase()
  const headers = buildUpstreamHeaders(req, {
    ...extraHeaders,
    'x-forwarded-host': url.host,
    'x-forwarded-proto': url.protocol.replace(':', ''),
  })
  const init: RequestInit = { method, headers }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = await req.arrayBuffer()
  }
  try {
    const res = await fetch(upstream, init)
    // WS 업그레이드 응답(webSocket 포함)도 그대로 반환해 패스스루한다.
    return res
  } catch {
    return c.json({ ok: false, error: 'ORACLE_UPSTREAM' }, 502)
  }
}

function parseViewport(raw: unknown): ViewportSize | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { width, height } = raw as { width?: unknown; height?: unknown }
  if (typeof width !== 'number' || typeof height !== 'number') return undefined
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return undefined
  return { width: Math.round(width), height: Math.round(height) }
}

export function registerOracleProxyRoutes(app: Hono<{ Bindings: Env }>): void {
  app.all('/view', (c) => {
    const cfg = oracleConfigOf(c.env)
    if (!cfg) return c.json({ ok: false, error: 'ORACLE_NOT_CONFIGURED' }, 503)
    const basic = `Basic ${btoa(`myhub:${cfg.selkiesPassword}`)}`
    return proxyToSidecar(c, cfg, ORACLE_VIEW_PORT, `${ORACLE_PROXY_MOUNT}/view`, {
      'x-origin-secret': cfg.originSecret,
      authorization: basic,
    }, true)
  })
  app.all('/view/*', (c) => {
    const cfg = oracleConfigOf(c.env)
    if (!cfg) return c.json({ ok: false, error: 'ORACLE_NOT_CONFIGURED' }, 503)
    const basic = `Basic ${btoa(`myhub:${cfg.selkiesPassword}`)}`
    return proxyToSidecar(c, cfg, ORACLE_VIEW_PORT, `${ORACLE_PROXY_MOUNT}/view`, {
      'x-origin-secret': cfg.originSecret,
      authorization: basic,
    }, true)
  })
  app.all('/cdp', (c) => {
    const cfg = oracleConfigOf(c.env)
    if (!cfg) return c.json({ ok: false, error: 'ORACLE_NOT_CONFIGURED' }, 503)
    return proxyToSidecar(c, cfg, ORACLE_CDP_PORT, `${ORACLE_PROXY_MOUNT}/cdp`, {
      'x-origin-secret': cfg.originSecret,
      'x-cdp-secret': cfg.cdpSecret,
    })
  })
  app.all('/cdp/*', (c) => {
    const cfg = oracleConfigOf(c.env)
    if (!cfg) return c.json({ ok: false, error: 'ORACLE_NOT_CONFIGURED' }, 503)
    return proxyToSidecar(c, cfg, ORACLE_CDP_PORT, `${ORACLE_PROXY_MOUNT}/cdp`, {
      'x-origin-secret': cfg.originSecret,
      'x-cdp-secret': cfg.cdpSecret,
    })
  })

  app.post('/navigate', async (c) => {
    const cfg = oracleConfigOf(c.env)
    if (!cfg) return c.json({ ok: false, error: 'ORACLE_NOT_CONFIGURED' }, 503)
    let body: { url?: unknown; viewport?: unknown } = {}
    try {
      body = (await c.req.json()) as { url?: unknown; viewport?: unknown }
    } catch {
      return c.json({ ok: false, error: 'INVALID_URL' }, 400)
    }
    const rawUrl = body.url
    if (typeof rawUrl !== 'string' || rawUrl.length > 2048) {
      return c.json({ ok: false, error: 'INVALID_URL' }, 400)
    }
    let targetUrl: string
    try {
      const parsed = new URL(rawUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return c.json({ ok: false, error: 'INVALID_URL' }, 400)
      }
      targetUrl = parsed.toString()
    } catch {
      return c.json({ ok: false, error: 'INVALID_URL' }, 400)
    }
    const viewport = parseViewport(body.viewport)
    const secretHeaders = {
      'x-origin-secret': cfg.originSecret,
      'x-cdp-secret': cfg.cdpSecret,
    }
    let version: unknown
    try {
      const res = await fetch(`http://${cfg.host}:${ORACLE_CDP_PORT}/json/version`, {
        headers: secretHeaders,
      })
      if (!res.ok) return c.json({ ok: false, error: 'ORACLE_UPSTREAM' }, 502)
      version = await res.json()
    } catch {
      return c.json({ ok: false, error: 'ORACLE_UPSTREAM' }, 502)
    }
    const publicWs = (version as { webSocketDebuggerUrl?: unknown })?.webSocketDebuggerUrl
    const directWs =
      typeof publicWs === 'string'
        ? toDirectCdpWsUrl(publicWs, cfg.host, ORACLE_CDP_PORT)
        : null
    if (!directWs) return c.json({ ok: false, error: 'ORACLE_UPSTREAM' }, 502)
    const nav = await navigateSession(directWs, targetUrl, defaultCdpConnect, {
      headers: secretHeaders,
      viewport,
    })
    return c.json({ ok: nav.ok, nav: nav.ok ? 'ok' : 'fail', navStage: nav.stage })
  })
}
