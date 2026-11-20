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
import { defaultCdpConnect, fetchSidecarBrowserState, getBrowserState, goBackSession, goForwardSession, navigateSession, reloadSession, toDirectCdpWsUrl, type ViewportSize } from './cdp'
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
  const { width, height, dpr } = raw as { width?: unknown; height?: unknown; dpr?: unknown }
  if (typeof width !== 'number' || typeof height !== 'number') return undefined
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return undefined
  // dpr은 선택 — 없거나 비정상이면 1.0으로 둔다 (구 프론트 호환:
  // dpr이 이상하다고 뷰포트 전체를 버리면 안 된다).
  const dsf =
    typeof dpr === 'number' && Number.isFinite(dpr) && dpr >= 1 && dpr <= 4 ? dpr : 1
  return { width: Math.round(width), height: Math.round(height), dpr: dsf }
}

/**
 * CDP 브라우저 WS URL 캐시 (2026-11-17 P1: /navigate·/back·/forward·
 * /state 폴백이 매번 /json/version 1왕복을 했다 — 캐시하면 그 왕복이
 * 사라진다. 모듈 단위(Worker 아이솔레이트별) 캐시.
 *
 * 무효화 — WS URL은 Chromium 재시작 때마다 바뀐다 (/devtools/browser/
 * <id>가 새로 발급된다). 낡은 URL로 연결하면 stage='connect' 실패가
 * 되므로, CDP 작업이 'connect'로 실패하면 캐시를 버리고 버전을 다시
 * 읽어 한 번만 재시도한다 (runCdpWithVersionRetry). TTL 60초는 그
 * 밖의 낡음(재시도 없이 지나간 실패)을 묶는다. 조회 실패(null)는
 * 캐시하지 않는다.
 */
export const DIRECT_CDP_WS_URL_CACHE_TTL_MS = 60_000

let directCdpWsUrlCache: { host: string; port: number; url: string; fetchedAt: number } | null = null

/** CDP WS URL 캐시를 버린다. 'connect' 실패 시 재시도 전 + 테스트 격리용. */
export function invalidateDirectCdpWsUrlCache(): void {
  directCdpWsUrlCache = null
}

/* CDP 브라우저 WS URL을 사이드카에서 받아 직접 연결용으로 바꾼다.
   캐시가 신선하면 조회 없이 돌려준다. 실패 시 null (호출자가
   502 ORACLE_UPSTREAM으로 보고한다). */
async function directCdpWsUrl(cfg: OracleConfig, secretHeaders: Record<string, string>): Promise<string | null> {
  const now = Date.now()
  if (
    directCdpWsUrlCache &&
    directCdpWsUrlCache.host === cfg.host &&
    directCdpWsUrlCache.port === ORACLE_CDP_PORT &&
    now - directCdpWsUrlCache.fetchedAt < DIRECT_CDP_WS_URL_CACHE_TTL_MS
  ) {
    return directCdpWsUrlCache.url
  }
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
  const direct = typeof publicWs === 'string' ? toDirectCdpWsUrl(publicWs, cfg.host, ORACLE_CDP_PORT) : null
  if (direct) {
    directCdpWsUrlCache = { host: cfg.host, port: ORACLE_CDP_PORT, url: direct, fetchedAt: now }
  }
  return direct
}

type CdpGate =
  | { ok: true; directWs: string; secretHeaders: Record<string, string> }
  | { ok: false; response: Response }

/* 사이드카 HTTP 제어 엔드포인트(/control/*)용 전처리 (2026-11-16 QA 12차:
   /viewport가 직접 CDP에서 사이드카 영구 override 경유로 바뀌면서
   /json/version 조회가 필요 없어졌다). LUKS 잠금이면 423, 아니면
   시크릿 헤더만 돌려준다. */
type SidecarGate =
  | { ok: true; secretHeaders: Record<string, string> }
  | { ok: false; response: Response }

async function gateSidecar(
  c: { env: Env; json: (body: unknown, status?: number) => Response },
  cfg: OracleConfig,
): Promise<SidecarGate> {
  const unlockSecret = c.env.UNLOCK_SECRET
  if (unlockSecret && unlockSecret.length >= 16) {
    if (await isBrowserLocked(cfg, unlockSecret)) {
      return { ok: false, response: c.json({ ok: false, error: 'BROWSER_LOCKED' }, 423) }
    }
  }
  return {
    ok: true,
    secretHeaders: {
      'x-origin-secret': cfg.originSecret,
      'x-cdp-secret': cfg.cdpSecret,
    },
  }
}

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

/* CDP 게이트 + 'connect' 실패 시 1회 재시도 (2026-11-17 P1 버전 캐시).
   run은 게이트가 준 directWs로 CDP 작업을 한 번 수행하고,
   isConnectFailure가 그 결과를 'connect' 실패로 판정한다. 캐시된 WS
   URL이 낡았으면(Chromium 재시작) 첫 시도가 'connect'로 실패하는데,
   그때만 캐시를 버리고 버전을 다시 읽어 한 번 더 시도한다 — 재시도의
   게이트는 언록 캐시를 써서 추가 왕복이 없다. 재시도 게이트 자체가
   실패하면 원래 결과를 돌려준다 (재시도 불가 ≠ 원래 실패의 변질).
   게이트 실패(잠금·버전 조회 실패)는 재시도하지 않고 그대로 돌려준다. */
async function runCdpWithVersionRetry<T>(
  c: { env: Env; json: (body: unknown, status?: number) => Response },
  cfg: OracleConfig,
  run: (gate: { directWs: string; secretHeaders: Record<string, string> }) => Promise<T>,
  isConnectFailure: (result: T) => boolean,
): Promise<{ ok: true; result: T } | { ok: false; response: Response }> {
  const gate = await gateCdp(c, cfg)
  if (!gate.ok) return { ok: false as const, response: gate.response }
  let result = await run(gate)
  if (isConnectFailure(result)) {
    invalidateDirectCdpWsUrlCache()
    const fresh = await gateCdp(c, cfg)
    if (fresh.ok) result = await run(fresh)
  }
  return { ok: true, result }
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
    const ran = await runCdpWithVersionRetry(
      c,
      cfg,
      (gate) =>
        navigateSession(gate.directWs, targetUrl, defaultCdpConnect, {
          headers: gate.secretHeaders,
          viewport,
        }),
      (nav) => !nav.ok && nav.stage === 'connect',
    )
    if (!ran.ok) return ran.response
    const nav = ran.result
    return c.json({ ok: nav.ok, nav: nav.ok ? 'ok' : 'fail', navStage: nav.stage })
  })

  // 이동 없이 원격 뷰포트만 맞춘다 (2026-11-15): 라이브 진입·리사이즈
  // 때 호출한다. 2026-11-16 QA 12차부터 직접 CDP가 아니라 사이드카
  // 영구 override 매니저(/control/viewport) 경유다 — 직접 CDP는
  // 세션을 닫으면 override가 풀려 렌더러가 1918로 되돌아가고,
  // 풀스크린 토그 재동기화는 QA 9·10·11·12차에서 네 번 불합격했다.
  // 사이드카는 CDP 세션을 영구 유지하므로 override가 풀리지 않고,
  // 새 탭에도 현재 뷰포트를 즉시 적용한다. 실패해도 화면은 뜨므로
  // 클라이언트는 결과를 무시하고 다음 기회에 다시 시도한다.
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
    const gate = await gateSidecar(c, cfg)
    if (!gate.ok) return gate.response
    let res: Response
    try {
      res = await fetch(`https://${cfg.host}:${ORACLE_CDP_PORT}/control/viewport`, {
        method: 'POST',
        headers: { ...gate.secretHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ width: viewport.width, height: viewport.height, dpr: viewport.dpr }),
      })
    } catch {
      return c.json({ ok: false, error: 'ORACLE_UPSTREAM' }, 502)
    }
    if (!res.ok) return c.json({ ok: false, error: 'ORACLE_UPSTREAM' }, 502)
    let applied: { ok?: unknown; applied?: unknown; total?: unknown; connected?: unknown } = {}
    try {
      applied = (await res.json()) as typeof applied
    } catch {
      return c.json({ ok: false, error: 'ORACLE_UPSTREAM' }, 502)
    }
    // 사이드카가 CDP에 안 붙었으면(언록 전 등) 적용 0건 — ok:false로
    // 보고해 클라이언트가 다음 재적용에서 다시 시도하게 한다.
    const ok = applied.ok === true && typeof applied.applied === 'number' && applied.applied > 0
    return c.json({
      ok,
      stage: ok ? 'ok' : 'viewport',
      applied: typeof applied.applied === 'number' ? applied.applied : 0,
      total: typeof applied.total === 'number' ? applied.total : 0,
      verified: typeof applied.applied === 'number' ? applied.applied : 0,
    })
  })

  // 원격 브라우저 현재 상태 (2026-11-15): 활성 탭의 실제 URL·
  // 제목·뒤로/앞으로 가능 여부를 읽는다. 셸 로컬 기록만 보던
  // 기존 주소창·뒤로가기는 원격 내 링크 이동을 몰라 주소가 고정되고
  // 뒤로가기가 안 됐다 — 프론트는 이 상태를 2초마다 폴링해 주소창·
  // 버튼을 원격 기준으로 맞춘다. 상태 읽기 실패는 502 BROWSER_STATE
  // (호출자는 기존 표시를 유지한다).
  // 빠른 경로 (2026-11-17 P0): 사이드카 영구 CDP 연결의
  // GET /control/state를 1회 fetch로 읽는다. 기존 직접 CDP 경로는
  // 폴링 1회당 순차 왕복 ~8회(/json/version + CDP WS 신규 연결 +
  // CDP 5회, 약 1.5초)였으나 이 경로는 1왕복(약 0.25초)이다.
  // 사이드카가 구버전이거나 실패하면 null이 돌아오고, 아래 직접
  // CDP 방식으로 폴백한다 (배포 순서 어긋남 대비). 잠금 검사는
  // gateSidecar에서 한 번만 한다 (폴백 경로에서 다시 안 한다).
  // 언록 조회는 30초 캐시를 쓴다 (unlock.ts) — /state 폴링 2초마다
  // 언록 1왕복이 나가던 것을 없애 전체가 1왕복(약 0.17초)이 된다.
  app.get('/state', async (c) => {
    const cfg = oracleConfigOf(c.env)
    if (!cfg) return c.json({ ok: false, error: 'ORACLE_NOT_CONFIGURED' }, 503)
    const gate = await gateSidecar(c, cfg)
    if (!gate.ok) return gate.response
    const fast = await fetchSidecarBrowserState(
      `https://${cfg.host}:${ORACLE_CDP_PORT}/control/state`,
      gate.secretHeaders,
    )
    if (fast) {
      // 탭 목록은 빠른 경로에서만 온다 — 폴백(직접 CDP)은 탭을 몰라
      // 필드를 빼고, 셸은 필드가 없을 때 탭 동기화를 건드리지 않는다.
      return c.json({
        ok: true,
        url: fast.url,
        title: fast.title,
        canGoBack: fast.canGoBack,
        canGoForward: fast.canGoForward,
        ...(fast.tabs !== undefined ? { tabs: fast.tabs } : {}),
        ...(fast.activeTargetId !== undefined ? { activeTargetId: fast.activeTargetId } : {}),
        ...(fast.mainTargetId !== undefined ? { mainTargetId: fast.mainTargetId } : {}),
      })
    }
    const directWs = await directCdpWsUrl(cfg, gate.secretHeaders)
    if (!directWs) return c.json({ ok: false, error: 'ORACLE_UPSTREAM' }, 502)
    const state = await getBrowserState(directWs, defaultCdpConnect, {
      headers: gate.secretHeaders,
    })
    if (!state) {
      // 폴백 실패 — 원인이 낡은 버전 캐시일 수 있으니 버려 다음 폴링(2초)이
      // 버전을 다시 읽게 한다. 재시도는 안 한다 (폴링이 곧 다시 온다).
      invalidateDirectCdpWsUrlCache()
      return c.json({ ok: false, error: 'BROWSER_STATE' }, 502)
    }
    return c.json({ ok: true, url: state.url, title: state.title, canGoBack: state.canGoBack, canGoForward: state.canGoForward })
  })

  // 원격 탭 앞으로 불러오기·닫기 (2026-11-19 새 창→새 탭): 셸 탭 전환·
  // 닫기가 사이드카 /control/tab/*으로 중계된다. 키오스크에서는 팝업이
  // 전체 화면 창이므로 activate가 곧 화면 전환이다. 실패해도 200 +
  // ok:false로 보고하고 셸은 다음 상태 폴링(2초)에서 바로잡는다.
  const tabAction = (action: 'activate' | 'close') => async (c: {
    env: Env
    req: { json: () => Promise<unknown> }
    json: (body: unknown, status?: number) => Response
  }) => {
    const cfg = oracleConfigOf(c.env)
    if (!cfg) return c.json({ ok: false, error: 'ORACLE_NOT_CONFIGURED' }, 503)
    let body: { targetId?: unknown } = {}
    try {
      body = (await c.req.json()) as { targetId?: unknown }
    } catch {
      return c.json({ ok: false, error: 'INVALID_TARGET' }, 400)
    }
    if (typeof body.targetId !== 'string' || !body.targetId) {
      return c.json({ ok: false, error: 'INVALID_TARGET' }, 400)
    }
    const gate = await gateSidecar(c, cfg)
    if (!gate.ok) return gate.response
    let res: Response
    try {
      res = await fetch(`https://${cfg.host}:${ORACLE_CDP_PORT}/control/tab/${action}`, {
        method: 'POST',
        headers: { ...gate.secretHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ targetId: body.targetId }),
      })
    } catch {
      return c.json({ ok: false, error: 'ORACLE_UPSTREAM' }, 502)
    }
    if (!res.ok) return c.json({ ok: false, error: 'ORACLE_UPSTREAM' }, 502)
    return c.json({ ok: true })
  }
  app.post('/tab/activate', tabAction('activate'))
  app.post('/tab/close', tabAction('close'))

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
    const ran = await runCdpWithVersionRetry(
      c,
      cfg,
      (gate) =>
        goBackSession(gate.directWs, defaultCdpConnect, {
          headers: gate.secretHeaders,
        }),
      (r) => !r.ok && r.stage === 'connect',
    )
    if (!ran.ok) return ran.response
    const r = ran.result
    return c.json({ ok: r.ok, stage: r.stage })
  })

  app.post('/forward', async (c) => {
    const cfg = oracleConfigOf(c.env)
    if (!cfg) return c.json({ ok: false, error: 'ORACLE_NOT_CONFIGURED' }, 503)
    const ran = await runCdpWithVersionRetry(
      c,
      cfg,
      (gate) =>
        goForwardSession(gate.directWs, defaultCdpConnect, {
          headers: gate.secretHeaders,
        }),
      (r) => !r.ok && r.stage === 'connect',
    )
    if (!ran.ok) return ran.response
    const r = ran.result
    return c.json({ ok: r.ok, stage: r.stage })
  })

  // 원격 새로고침 (2026-11-20 브라우저 4단계): CDP Page.reload로
  // 활성 탭을 진짜로 새로고침한다. 같은 URL로 다시 이동하는 옛
  // 방식은 스크롤을 맨 위로 되돌린다 (실측 — 기록은 같은 URL이라
  // 둘 다 안 쌓인다). 실패해도 200 + ok:false로 보고한다 (/back과
  // 같은 모양) — 호출자는 재이동으로 조용히 폴백하지 않고
  // 사용자에게 알린다.
  app.post('/reload', async (c) => {
    const cfg = oracleConfigOf(c.env)
    if (!cfg) return c.json({ ok: false, error: 'ORACLE_NOT_CONFIGURED' }, 503)
    const ran = await runCdpWithVersionRetry(
      c,
      cfg,
      (gate) =>
        reloadSession(gate.directWs, defaultCdpConnect, {
          headers: gate.secretHeaders,
        }),
      (r) => !r.ok && r.stage === 'connect',
    )
    if (!ran.ok) return ran.response
    const r = ran.result
    return c.json({ ok: r.ok, stage: r.stage })
  })

  // 화질 수동 전환 (2026-11-15): 사이드카 /control/quality로 중계한다.
  // { bitrate: <kbps> }는 수동 고정(한 번만 vb를 보낸다),
  // { mode: 'auto' }는 수동 고정을 풀고 Selkies 혼잡 제어로 되돌린다
  // (2026-11-17 적응 폐지 — 사이드카 자동 조절은 없다). 비트레이트
  // 범위는 500~15000kbps (사이드카 BITRATE_FLOOR/CEILING과 동일 —
  // 2026-11-20 4단계에서 8000 상한을 15000으로 정정했다. 8000이면
  // 현행 기본값 12000조차 선택할 수 없었다). 세션 게이트 뒤에 있다
  // (전역 /api/* 미들웨어). 사이드카 응답(상태·본문)을 그대로 돌려준다.
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
      if (kbps < 500 || kbps > 15000) return c.json({ ok: false, error: 'INVALID_QUALITY' }, 400)
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

  // 페이지 내 찾기 (2026-11-20 브라우저 5단계): 사이드카 /control/find로
  // 중계한다. 사이드카가 활성 화면 WS 연결에 Selkies 키 메시지
  // kd,65507 → kd,102 → ku,102 → ku,65507 (Ctrl+F)를 주입해 원격
  // Chromium의 네이티브 찾기 막대를 연다. CDP Input.dispatchKeyEvent는
  // 렌더러로만 가서 브라우저 단축키를 못 연다 (실브라우저 3방 실측) —
  // 그래서 CDP가 아니라 Selkies 키 주입이 정본 경로다. 활성 연결이
  // 없으면 사이드카가 503 no_active_connection을 돌려준다. 세션 게이트
  // 뒤에 있다 (전역 /api/* 미들웨어). 사이드카 응답(상태·본문)을 그대로
  // 돌려준다 (/quality와 같은 모양).
  app.post('/find', async (c) => {
    const cfg = oracleConfigOf(c.env)
    if (!cfg) return c.json({ ok: false, error: 'ORACLE_NOT_CONFIGURED' }, 503)
    try {
      const res = await fetch(`https://${cfg.host}:${ORACLE_VIEW_PORT}/control/find`, {
        method: 'POST',
        headers: {
          'x-origin-secret': cfg.originSecret,
        },
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

  // 마우스 오프셋 보고 (2026-11-18): 프론트가 #bwLiveFrame의 화면상
  // 위치 {x, y}를 보내면 사이드카 /control/mouse-offset으로 중계한다.
  // Selkies 클라이언트가 iframe 좌표에 창 위치를 더해 보내므로
  // 사이드카가 빼서 되돌린다. 세션 게이트 뒤에 있다 (전역 /api/*
  // 미들웨어). 사이드카 응답(상태·본문)을 그대로 돌려준다.
  // (2026-11-19) 프론트는 디바이스 px + dpr을 보내고, dpr이 있으면
  // 이미 디바이스 px이라는 뜻이라 사이드카가 그대로 쓴다. dpr이
  // 없으면(구 프론트·수동 POST) CSS px로 보고 사이드카가 배운 DPR로
  // 변환한다. dpr은 검증만 하고 그대로 중계한다.
  app.post('/mouse-offset', async (c) => {
    const cfg = oracleConfigOf(c.env)
    if (!cfg) return c.json({ ok: false, error: 'ORACLE_NOT_CONFIGURED' }, 503)
    let body: { x?: unknown; y?: unknown; dpr?: unknown } = {}
    try {
      body = (await c.req.json()) as { x?: unknown; y?: unknown; dpr?: unknown }
    } catch {
      return c.json({ ok: false, error: 'INVALID_OFFSET' }, 400)
    }
    if (
      typeof body.x !== 'number' ||
      typeof body.y !== 'number' ||
      !Number.isFinite(body.x) ||
      !Number.isFinite(body.y)
    ) {
      return c.json({ ok: false, error: 'INVALID_OFFSET' }, 400)
    }
    const x = Math.round(body.x)
    const y = Math.round(body.y)
    if (x < 0 || x > 8192 || y < 0 || y > 8192) {
      return c.json({ ok: false, error: 'INVALID_OFFSET' }, 400)
    }
    const dpr =
      typeof body.dpr === 'number' && Number.isFinite(body.dpr) && body.dpr >= 1 && body.dpr <= 4
        ? body.dpr
        : undefined
    try {
      const res = await fetch(`https://${cfg.host}:${ORACLE_VIEW_PORT}/control/mouse-offset`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-origin-secret': cfg.originSecret,
        },
        body: JSON.stringify(dpr === undefined ? { x, y } : { x, y, dpr }),
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
