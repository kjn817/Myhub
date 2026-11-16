/**
 * Oracle 원격 브라우저 프록시 — Worker가 오라클 서버의 엣지 사이드카로
 * 화면·CDP를 중계한다 (2026-11-14 설계 변경: Cloudflare Browser Run
 * 세션 발급 폐기, 상시 기동 서버로 단일화).
 *
 * - GET /view/* → https://<호스트>:8080/api/browse/view/* (Selkies 화면, WS 포함)
 *   — 접두사를 떼지 않고 통째로 보낸다. 컨테이너의 kclient·nginx가
 *   SUBFOLDER=/api/browse/view/로 같은 접두사를 알기 때문이다. 접두사를
 *   떼면 kclient가 화면 WS를 루트 /websockify로 보내 Worker에 닿지 않아
 *   화면이 검은 채 "WebSocket disconnected"가 된다 (2026-11-14 라이브 실증).
 * - GET /cdp/*  → https://<호스트>:8081/* (CDP HTTP/WS, WS 포함)
 *   — CDP는 접두사 개념이 없어 사이드카가 바라는 맨 경로로 떼서 보낸다.
 * - POST /navigate → 사이드카 CDP로 영구 탭을 이동시킨다
 *
 * TLS (2026-11-14): Worker→사이드카 구간은 HTTPS/WSS다 (사이드카에
 * Let's Encrypt 인증서 — 평문 HTTP 시절은 카드결제·로그인 사용을 앞두고
 * 폐기했다. 사이드카가 인증서 없이 뜨면 평문 폴백이지만 Worker는
 * HTTPS로만 붙으므로, 인증서 없는 사이드카에는 닿지 않는다 (fail-closed).
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
import { validatePublicUrlAsync } from './assistant-read'
import { applyViewportToSession, defaultCdpConnect, getBrowserState, goBackSession, goForwardSession, navigateSession, toDirectCdpWsUrl, VIEWPORT_TIMEOUT_MS, type ViewportSize } from './cdp'
import { isBrowserLocked } from './unlock'

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
  const upstream = `https://${cfg.host}:${port}${rest}${url.search}`
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

/* CDP 브라우저 WS URL을 사이드카에서 받아 직접 연결용으로 바꾼다.
   실패 시 null (호출자가 502 ORACLE_UPSTREAM으로 보고한다). */
async function directCdpWsUrl(cfg: OracleConfig, secretHeaders: Record<string, string>): Promise<string | null> {
  let version: unknown
  try {
    const res = await fetch(`https://${cfg.host}:${ORACLE_CDP_PORT}/json/version`, {
      headers: secretHeaders,
    })
    if (!res.ok) return null
    version = await res.json()
  } catch {
    return null
  }
  const publicWs = (version as { webSocketDebuggerUrl?: unknown })?.webSocketDebuggerUrl
  return typeof publicWs === 'string' ? toDirectCdpWsUrl(publicWs, cfg.host, ORACLE_CDP_PORT) : null
}

type CdpGate =
  | { ok: true; directWs: string; secretHeaders: Record<string, string> }
  | { ok: false; response: Response }

/* CDP를 쓰는 라우트들의 공통 전처리 (2026-11-15: /navigate·/viewport·
   /state·/back·/forward가 같은 전처리를 반복하던 것을 하나로 묶었다).
   LUKS 잠금이면 423 BROWSER_LOCKED, 사이드카 CDP에 닿지 않으면 502
   ORACLE_UPSTREAM을 돌려준다. UNLOCK_SECRET 미설정(암호화 미구성)이면
   잠금 검사를 건너뛴다. */
async function gateCdp(
  c: { env: Env; json: (body: unknown, status?: number) => Response },
  cfg: OracleConfig,
): Promise<CdpGate> {
  const unlockSecret = c.env.UNLOCK_SECRET
  if (unlockSecret && unlockSecret.length >= 16) {
    if (await isBrowserLocked(cfg, unlockSecret)) {
      return { ok: false, response: c.json({ ok: false, error: 'BROWSER_LOCKED' }, 423) }
    }
  }
  const secretHeaders = {
    'x-origin-secret': cfg.originSecret,
    'x-cdp-secret': cfg.cdpSecret,
  }
  const directWs = await directCdpWsUrl(cfg, secretHeaders)
  if (!directWs) return { ok: false, response: c.json({ ok: false, error: 'ORACLE_UPSTREAM' }, 502) }
  return { ok: true, directWs, secretHeaders }
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
    // 내부 URL 차단 (2026-11-15 보안 분석 지적): 프로토콜만 보던 기존
    // 검사는 169.254.169.254·localhost:9222 같은 내부 이동을 막지 못했다.
    // validatePublicUrlAsync는 문자열 검사에 더해 DoH로 해석 IP까지
    // 확인해 사설 IP로 해석되는 호스트명(DNS 리바인딩)도 차단한다.
    // 잔존 한계(TOCTOU): Worker 시점 해석 결과이며, 원격 Chromium이
    // 자기 리졸버로 다시 해석해 이동하므로 표적 리바인딩까지 막지는
    // 못한다 (assistant-read.ts의 주석 참조).
    const validated = await validatePublicUrlAsync(body.url)
    if (!validated.ok) return c.json({ ok: false, error: 'INVALID_URL' }, 400)
    const targetUrl = validated.url
    const viewport = parseViewport(body.viewport)
    const gate = await gateCdp(c, cfg)
    if (!gate.ok) return gate.response
    const nav = await navigateSession(gate.directWs, targetUrl, defaultCdpConnect, {
      headers: gate.secretHeaders,
      viewport,
    })
    return c.json({ ok: nav.ok, nav: nav.ok ? 'ok' : 'fail', navStage: nav.stage })
  })

  // 이동 없이 원격 뷰포트만 맞춘다 (2026-11-15): 라이브 진입·리사이즈
  // 때 호출한다. 세션 복원 뒤에는 navigate가 없어 override가 적용되지
  // 않던 구멍을 메운다. 실패해도 화면은 뜨므로 클라이언트는 결과를
  // 무시하고 다음 기회에 다시 시도한다.
  app.post('/viewport', async (c) => {
    const cfg = oracleConfigOf(c.env)
    if (!cfg) return c.json({ ok: false, error: 'ORACLE_NOT_CONFIGURED' }, 503)
    let body: { viewport?: unknown } = {}
    try {
      body = (await c.req.json()) as { viewport?: unknown }
    } catch {
      return c.json({ ok: false, error: 'INVALID_VIEWPORT' }, 400)
    }
    const viewport = parseViewport(body.viewport)
    if (!viewport) return c.json({ ok: false, error: 'INVALID_VIEWPORT' }, 400)
    const gate = await gateCdp(c, cfg)
    if (!gate.ok) return gate.response
    const applied = await applyViewportToSession(gate.directWs, viewport, defaultCdpConnect, {
      headers: gate.secretHeaders,
      timeoutMs: VIEWPORT_TIMEOUT_MS,
    })
    return c.json({ ok: applied.ok, stage: applied.stage, applied: applied.applied, total: applied.total, verified: applied.verified })
  })

  // 원격 브라우저 현재 상태 (2026-11-15): 활성 탭의 실제 URL·
  // 제목·뒤로/앞으로 가능 여부를 CDP로 읽는다. 셸 로컬 기록만 보던
  // 기존 주소창·뒤로가기는 원격 내 링크 이동을 몰라 주소가 고정되고
  // 뒤로가기가 안 됐다 — 프론트는 이 상태를 2초마다 폴링해 주소창·
  // 버튼을 원격 기준으로 맞춘다. 상태 읽기 실패는 502 BROWSER_STATE
  // (호출자는 기존 표시를 유지한다).
  app.get('/state', async (c) => {
    const cfg = oracleConfigOf(c.env)
    if (!cfg) return c.json({ ok: false, error: 'ORACLE_NOT_CONFIGURED' }, 503)
    const gate = await gateCdp(c, cfg)
    if (!gate.ok) return gate.response
    const state = await getBrowserState(gate.directWs, defaultCdpConnect, {
      headers: gate.secretHeaders,
    })
    if (!state) return c.json({ ok: false, error: 'BROWSER_STATE' }, 502)
    return c.json({ ok: true, url: state.url, title: state.title, canGoBack: state.canGoBack, canGoForward: state.canGoForward })
  })

  // 원격 뒤로/앞으로 가기 (2026-11-15): CDP getNavigationHistory로
  // 엔트리 id를 읽어 Page.navigateToHistoryEntry로 활성 탭을 이동시킨다
  // (2026-11-16 QA 2차: Page.goBack/goForward는 Chromium 156에 없어
  // 'wasn't found' 에러만 돌려줬다). 원격 내 이동 기록 기준이라 셸
  // 로컬 기록으로는 못 가던 곳도 간다. 실패해도 200 + ok:false로 보고한다
  // (/navigate·/viewport와 같은 모양). 라이브가 켜져 있을 때는
  // 호출자가 로컬 기록으로 폴백하지 않는다 (2026-11-16 QA 1차: 낡은
  // 기록으로 엉뚱한 곳에 가고 navigate가 다른 탭을 닫아버린다).
  app.post('/back', async (c) => {
    const cfg = oracleConfigOf(c.env)
    if (!cfg) return c.json({ ok: false, error: 'ORACLE_NOT_CONFIGURED' }, 503)
    const gate = await gateCdp(c, cfg)
    if (!gate.ok) return gate.response
    const r = await goBackSession(gate.directWs, defaultCdpConnect, {
      headers: gate.secretHeaders,
    })
    return c.json({ ok: r.ok, stage: r.stage })
  })

  app.post('/forward', async (c) => {
    const cfg = oracleConfigOf(c.env)
    if (!cfg) return c.json({ ok: false, error: 'ORACLE_NOT_CONFIGURED' }, 503)
    const gate = await gateCdp(c, cfg)
    if (!gate.ok) return gate.response
    const r = await goForwardSession(gate.directWs, defaultCdpConnect, {
      headers: gate.secretHeaders,
    })
    return c.json({ ok: r.ok, stage: r.stage })
  })

  // 화질 수동 전환 (2026-11-15): 사이드카 /control/quality로 중계한다.
  // { bitrate: <kbps> }는 수동 고정(사이드카 자동 조절 중단),
  // { mode: 'auto' }는 자동 조절로 되돌린다. 비트레이트 범위는
  // 500~8000kbps (사이드카 BITRATE_FLOOR/CEILING과 동일). 세션 게이트
  // 뒤에 있다 (전역 /api/* 미들웨어). 사이드카 응답(상태·본문)을
  // 그대로 돌려준다.
  app.post('/quality', async (c) => {
    const cfg = oracleConfigOf(c.env)
    if (!cfg) return c.json({ ok: false, error: 'ORACLE_NOT_CONFIGURED' }, 503)
    let body: { bitrate?: unknown; mode?: unknown } = {}
    try {
      body = (await c.req.json()) as { bitrate?: unknown; mode?: unknown }
    } catch {
      return c.json({ ok: false, error: 'INVALID_QUALITY' }, 400)
    }
    let payload: { bitrate: number } | { mode: 'auto' }
    if (body.mode === 'auto' && body.bitrate === undefined) {
      payload = { mode: 'auto' }
    } else if (
      body.mode === undefined &&
      typeof body.bitrate === 'number' &&
      Number.isFinite(body.bitrate)
    ) {
      const kbps = Math.round(body.bitrate)
      if (kbps < 500 || kbps > 8000) return c.json({ ok: false, error: 'INVALID_QUALITY' }, 400)
      payload = { bitrate: kbps }
    } else {
      return c.json({ ok: false, error: 'INVALID_QUALITY' }, 400)
    }
    try {
      const res = await fetch(`https://${cfg.host}:${ORACLE_VIEW_PORT}/control/quality`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-origin-secret': cfg.originSecret,
        },
        body: JSON.stringify(payload),
      })
      const text = await res.text()
      return new Response(text, {
        status: res.status,
        headers: { 'content-type': 'application/json' },
      })
    } catch {
      return c.json({ ok: false, error: 'ORACLE_UPSTREAM' }, 502)
    }
  })

  // 지연 분해 통계 (2026-11-15): 사이드카 GET /control/stats를 중계한다.
  // 연결별 _f/_l 보고·전달 처리 시간·버퍼·역압·keepalive RTT를 돌려줘
  // 지연이 어느 구간에서 쌓이는지 가른다. 세션 게이트 뒤에 있다
  // (전역 /api/* 미들웨어). 사이드카 응답(상태·본문)을 그대로 돌려준다.
  app.get('/stats', async (c) => {
    const cfg = oracleConfigOf(c.env)
    if (!cfg) return c.json({ ok: false, error: 'ORACLE_NOT_CONFIGURED' }, 503)
    try {
      const res = await fetch(`https://${cfg.host}:${ORACLE_VIEW_PORT}/control/stats`, {
        headers: { 'x-origin-secret': cfg.originSecret },
      })
      const text = await res.text()
      return new Response(text, {
        status: res.status,
        headers: { 'content-type': 'application/json' },
      })
    } catch {
      return c.json({ ok: false, error: 'ORACLE_UPSTREAM' }, 502)
    }
  })
}
