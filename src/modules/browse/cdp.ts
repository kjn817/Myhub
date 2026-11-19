/**
 * CDP(Chrome DevTools Protocol) 최소 클라이언트 — Oracle 원격 브라우저의
 * WebSocket 디버거 엔드포인트로 페이지 이동을 지시한다.
 */

/** CDP 소켓 최소 인터페이스 (Workers WebSocket / 테스트 대역 공통) */
export interface CdpSocket {
  send(data: string): void
  close(): void
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void
}

export type CdpConnectFn = (wsUrl: string, headers?: Record<string, string>) => Promise<CdpSocket | null>

export function wsToHttpUrl(wsUrl: string): string {
  if (wsUrl.startsWith('wss://')) return `https://${wsUrl.slice('wss://'.length)}`
  if (wsUrl.startsWith('ws://')) return `http://${wsUrl.slice('ws://'.length)}`
  return wsUrl
}

/**
 * 사이드카가 공개 베이스로 재작성한 CDP WS URL을 서버 내부 직접 URL로
 * 되돌린다. Worker가 자기 자신을 경유하지 않고 사이드카에 직접 닿기
 * 위함 (자기 경유는 세션 쿠키가 없어 401이 된다). 경로 안의 마지막
 * /devtools/ 부터가 CDP 엔드포인트이며 (공개 URL은 /api/browse/cdp
 * 접두사를 포함한다), 없으면 null (임의 URL로의 연결을 막는다).
 */
export function toDirectCdpWsUrl(publicWsUrl: string, host: string, port: number): string | null {
  let parsed: URL
  try {
    parsed = new URL(publicWsUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null
  // 공개 URL은 프록시 접두사(/api/browse/cdp)를 포함하므로, 경로 안의
  // 마지막 /devtools/ 부터가 CDP 엔드포인트이다.
  const idx = parsed.pathname.lastIndexOf('/devtools/')
  if (idx < 0) return null
  const endpoint = parsed.pathname.slice(idx)
  if (endpoint.length <= '/devtools/'.length) return null
  // 사이드카 리스너는 TLS다 (2026-11-14) — 직접 연결도 WSS로 해야 한다.
  return `wss://${host}:${port}${endpoint}`
}

export const defaultCdpConnect: CdpConnectFn = async (wsUrl, headers) => {
  const res = await fetch(wsToHttpUrl(wsUrl), {
    headers: { Upgrade: 'websocket', ...(headers ?? {}) },
  })
  const ws = (res as any).webSocket as CdpSocket | undefined
  if (!ws) return null
  ;(ws as any).accept()
  return ws
}

/**
 * 원격 디스플레이 출력 배율 (2026-11-16 QA 7차: 항상 1.0).
 * 사이드카가 클라이언트 SETTINGS의 scaling_dpi를 96으로 고정하므로
 * Selkies 출력 scale은 항상 1.0이다 (diag 실측: "scale 1.00").
 * 뷰포트 override의 DSF는 이 값과 같아야 한다 — 실측에서 역산하는
 * 옛 방식(디스플레이/스테이지 비율)은 리사이즈 중 Selkies 출력이
 * 아직 안 줄었을 때 옛 크기 ÷ 새 스테이지를 계산해 1.5 같은 잘못된
 * 배율을 만들고, 그 배율이 후보가 돼 자기 일치를 이뤄 고정이 안
 * 됐다 (창은 안 줄고 내용만 1.5배로 커져 넘치는 QA 7차 결함).
 * 낡은 1.75 렌더러 탭에도 1.0이 맞다 — 출력이 이미 1.0이라 1.75를
 * 걸면 물리 1.75배로 래스터링해 창을 넘친다. DPI 고정을 끄는
 * 날에는 이 상수와 뷰포트 로직을 함께 재검토할 것.
 */
export const REMOTE_DISPLAY_SCALE = 1

/** Runtime.evaluate 응답(result)에서 문자열 값을 꺼낸다. 없으면 null. */
function evalString(result: unknown): string | null {
  const value = (result as { result?: { value?: unknown } } | null | undefined)?.result?.value
  return typeof value === 'string' ? value : null
}

export type CdpReply = { result?: unknown; error?: { message?: string } }
export type CdpCall = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string | null,
) => Promise<CdpReply>

/**
 * CDP 브라우저 소켓을 열고 script를 실행한 뒤 닫는다. script는
 * call(method, params, sessionId)로 명령을 보내고 응답을 기다린다
 * (id 매칭은 여기서 한다). 연결 실패·리스너 등록 실패는
 * fallback.connect를, 타임아웃·스크립트 예외는 fallback.timeout()을
 * 돌려준다. 타이머는 리스너 등록 뒤에 만든다 — 등록이 동기 throw하면
 * 고아 타이머가 프로세스 종료를 붙잡는다 (navigateSession과 같은
 * 2026-11-15 교훈).
 */
async function runCdpScript<T>(
  webSocketDebuggerUrl: string,
  connect: CdpConnectFn,
  opts: { headers?: Record<string, string>; timeoutMs?: number },
  script: (call: CdpCall) => Promise<T>,
  fallback: { connect: T; timeout: () => T },
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? NAVIGATE_TIMEOUT_MS
  let sock: CdpSocket | null = null
  try {
    sock = await connect(webSocketDebuggerUrl, opts.headers)
  } catch {
    return fallback.connect
  }
  if (!sock) return fallback.connect
  const socket = sock
  try {
    return await new Promise<T>((resolve) => {
      let done = false
      let nextId = 0
      const pending = new Map<number, (reply: CdpReply) => void>()
      const finish = (value: T) => {
        if (done) return
        done = true
        clearTimeout(timer)
        pending.clear()
        try {
          socket.close()
        } catch {
          // 무시
        }
        resolve(value)
      }
      const call: CdpCall = (method, params, sessionId) => {
        return new Promise<CdpReply>((resolveReply, rejectReply) => {
          if (done) {
            rejectReply(new Error('cdp closed'))
            return
          }
          const id = ++nextId
          const msg: Record<string, unknown> = { id, method }
          if (params) msg.params = params
          if (sessionId) msg.sessionId = sessionId
          pending.set(id, resolveReply)
          try {
            socket.send(JSON.stringify(msg))
          } catch (err) {
            pending.delete(id)
            rejectReply(err instanceof Error ? err : new Error('cdp send failed'))
          }
        })
      }
      socket.addEventListener('message', (ev) => {
        let msg: any
        try {
          msg = JSON.parse(String(ev.data))
        } catch {
          return
        }
        if (typeof msg.id !== 'number') return
        const resolveReply = pending.get(msg.id)
        if (!resolveReply) return
        pending.delete(msg.id)
        resolveReply(msg.error ? { error: msg.error } : { result: msg.result })
      })
      // 리스너 등록 뒤에 타이머를 만든다 (위 주석 참조).
      const timer = setTimeout(() => finish(fallback.timeout()), timeoutMs)
      script(call).then(
        (value) => finish(value),
        () => finish(fallback.timeout()),
      )
    })
  } catch {
    return fallback.connect
  } finally {
    try {
      sock?.close()
    } catch {
      // 무시
    }
  }
}

/**
 * 활성 탭 프로브 식 (2026-11-17 P1 evaluate 통합): visibility 판별과
 * URL·제목 읽기를 한 번의 Runtime.evaluate로 합친다. getBrowserState는
 * 옛날에 visibility 평가와 URL 읽기 평가를 나눠서 2왕복을 했다 —
 * 프로브 1회로 visibility·url·title을 한 번에 받아 1왕복(약 170ms)을
 * 줄인다. XML 문서처럼 document.title이 없는 페이지는 JSON에서 title이
 * 빠지는데, 그때는 page가 null이 돼 getBrowserState가 기존처럼 별도
 * 평가로 읽는다 (동작 동일).
 */
const PAGE_PROBE_EXPRESSION =
  'JSON.stringify({visibility: document.visibilityState, url: location.href, title: document.title})'

/** 프로브 평가 결과: visibility는 필수, url·title은 없으면 null. */
interface PageProbe {
  visibility: string
  url: string | null
  title: string | null
}

/** 프로브 평가 문자열(JSON)을 파싱한다. 깨졌거나 visibility가 없으면 null. */
function parsePageProbe(raw: string | null): PageProbe | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as { visibility?: unknown; url?: unknown; title?: unknown }
    if (typeof parsed.visibility !== 'string') return null
    return {
      visibility: parsed.visibility,
      url: typeof parsed.url === 'string' ? parsed.url : null,
      title: typeof parsed.title === 'string' ? parsed.title : null,
    }
  } catch {
    return null
  }
}

type AttachResult =
  | { ok: true; sessionId: string; targetId: string; page: { url: string; title: string } | null }
  | { ok: false; stage: 'targets' | 'attach' }

/** 활성 탭 식별용 visibility 평가의 타깃당 제한 (ms). 동결된 탭의
 * evaluate는 응답이 안 와 전체 스크립트 타임아웃(5초)까지 붙잡히므로,
 * 이 제한 안에 안 오면 해당 탭을 건너뛰고 다음 탭을 본다 (2026-11-16
 * QA 1차: 첫 타깃이 동결 탭이면 /state가 매번 502였다). */
const VISIBILITY_EVAL_TIMEOUT_MS = 1500

/** Runtime.evaluate를 제한 시간 안에 평가해 문자열 값을 돌려준다.
 * 제한 안에 응답이 없거나·오류면 null (호출자는 다음 탭으로 넘어간다).
 * 타이머는 평가가 끝나면 지운다 (고아 타이머 금지). */
async function evalStringWithTimeout(
  call: CdpCall,
  expression: string,
  sessionId: string,
  timeoutMs: number,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      call('Runtime.evaluate', { expression, returnByValue: true }, sessionId).then(
        (reply) => (!reply.error ? evalString(reply.result) : null),
        () => null,
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 활성(visible) 페이지 타깃에 attach한다 (2026-11-16 QA 1차: 첫
 * 타깃은 사용자가 보는 탭이 아닐 수 있고, 동결된 백그라운드 탭에
 * evaluate를 걸면 타임아웃돼 /state가 매번 502가 됐다).
 * 모든 페이지 타깃에 차례로 attach해 프로브 식(visibility·url·title
 * 병합, PAGE_PROBE_EXPRESSION)을 평가하고 'visible'인 탭을 선택한다.
 * visible인 탭이 없으면(전부 hidden·평가 실패·응답 없음 포함) attach에
 * 성공한 첫 페이지 타깃으로 폴백한다. attach가 전부 실패하면
 * stage='attach', 타깃이 없으면 stage='targets'. 라운드트립이 늘어도
 * 괜찮다 — 폴링 간격 2초 + 진행 중 가드가 있다. visible이 여러 탭이면
 * 목록 순서상 첫 번째가 이긴다 (가장 먼저 생긴 탭 — 키오스크 팝업이
 * 떠 있어도 영구 탭이 visible로 보고되면 영구 탭이 선택된다).
 * pages를 넘기면 getTargets를 다시 부르지 않고 그 목록을 쓴다
 * (navigateSession은 닫을 타깃 목록이 필요해 미리 조회해 둔다).
 * 성공 시 sessionId와 함께 targetId도 돌려준다 — 호출자가 선택된 탭
 * 외의 탭을 닫는 데 쓴다. page는 선택된 탭의 프로브 결과(url·title) —
 * 프로브가 url·title을 못 줬으면(타임아웃·XML 문서 등) null이고,
 * 그때 getBrowserState는 별도 평가로 읽는다.
 */
async function attachActivePage(
  call: CdpCall,
  pages?: Array<{ type: 'page'; targetId: string }>,
): Promise<AttachResult> {
  let pageList = pages
  if (!pageList) {
    const targetsReply = await call('Target.getTargets')
    if (targetsReply.error) return { ok: false, stage: 'targets' }
    const infos =
      (targetsReply.result as { targetInfos?: Array<{ type?: unknown; targetId?: unknown }> } | undefined)
        ?.targetInfos ?? []
    pageList = infos.filter(
      (t): t is { type: 'page'; targetId: string } =>
        t.type === 'page' && typeof t.targetId === 'string',
    )
  }
  if (pageList.length === 0) return { ok: false, stage: 'targets' }
  let firstSession: string | null = null
  let firstTargetId: string | null = null
  let firstPage: { url: string; title: string } | null = null
  for (const page of pageList) {
    let sessionId: string | null = null
    try {
      const attachReply = await call('Target.attachToTarget', { targetId: page.targetId, flatten: true })
      sessionId = !attachReply.error
        ? ((attachReply.result as { sessionId?: unknown } | undefined)?.sessionId as string | undefined) ?? null
        : null
    } catch {
      sessionId = null
    }
    if (!sessionId) continue
    // 프로브 1회로 visibility·url·title을 함께 읽는다 (P1 통합).
    const probe = parsePageProbe(
      await evalStringWithTimeout(call, PAGE_PROBE_EXPRESSION, sessionId, VISIBILITY_EVAL_TIMEOUT_MS),
    )
    const pageInfo =
      probe && probe.url !== null && probe.title !== null
        ? { url: probe.url, title: probe.title }
        : null
    if (!firstSession) {
      firstSession = sessionId
      firstTargetId = page.targetId
      firstPage = pageInfo
    }
    if (probe?.visibility === 'visible') {
      return { ok: true, sessionId, targetId: page.targetId, page: pageInfo }
    }
  }
  if (firstSession && firstTargetId) {
    return { ok: true, sessionId: firstSession, targetId: firstTargetId, page: firstPage }
  }
  return { ok: false, stage: 'attach' }
}

export const NAVIGATE_TIMEOUT_MS = 5000


export type NavigateStage = 'ok' | 'connect' | 'targets' | 'attach' | 'navigate' | 'viewport'
export interface NavigateResult {
  ok: boolean
  stage: NavigateStage
}

export interface ViewportSize {
  width: number
  height: number
}

/**
 * 세션의 페이지 타깃에 targetUrl 이동을 지시한다.
 * 이동 대상은 사용자가 보고 있는 활성(visible) 탭이다 (2026-11-16
 * QA 4차: 첫 타깃을 이동시키던 기존 코드는 숨은 DuckDuckGo 탭을
 * 이동시키고 보던 naver.com 탭을 닫아버려, 뒤로가기가 naver.com이
 * 아니라 DuckDuckGo로 갔다). /state·뒤로/앞으로와 같은 attachActivePage를
 * 쓴다. visible 탭이 없으면 첫 탭으로 폴백한다.
 * 타깃 attach가 안 되는 환경에서는 세션 소켓에 직접 navigate하는 폴백을 쓴다.
 * viewport가 주어지면 attach 직후 Emulation.setDeviceMetricsOverride로
 * 원격 뷰포트를 맞춘 뒤 이동한다 (2026-11-12: 원격 브라우저 기본
 * 뷰포트 1280x720이 MyHub 창보다 넓으면 Live View가 짤려서).
 * 뷰포트 설정 실패는 이동을 막지 않는다 (경고 없이 navigate로 진행).
 */
export async function navigateSession(
  webSocketDebuggerUrl: string,
  targetUrl: string,
  connect: CdpConnectFn = defaultCdpConnect,
  opts: { headers?: Record<string, string>; timeoutMs?: number; viewport?: ViewportSize } = {}
): Promise<NavigateResult> {
  const viewport = opts.viewport
  let phase: NavigateStage = 'targets'
  return runCdpScript(
    webSocketDebuggerUrl,
    connect,
    opts,
    async (call) => {
      // 세션 없는 직접 navigate 폴백 (targets/attach 실패 시).
      // 실패하면 원래 단계로 보고한다.
      const directNavigate = async (fromStage: NavigateStage): Promise<NavigateResult> => {
        phase = 'navigate'
        let reply: CdpReply
        try {
          reply = await call('Page.navigate', { url: targetUrl })
        } catch {
          return { ok: false, stage: fromStage }
        }
        return reply.error ? { ok: false, stage: fromStage } : { ok: true, stage: 'ok' }
      }
      // getTargets — 빈 목록이면 최대 4회까지 300ms 간격으로 재시도한다
      // (Chromium 기동 직후에는 타깃이 아직 없을 수 있다). 오류면
      // 재시도 없이 직접 navigate 폴백으로 간다.
      let infos: Array<{ type?: unknown; targetId?: unknown }> = []
      for (let attempt = 0; attempt < 4; attempt++) {
        let reply: CdpReply
        try {
          reply = await call('Target.getTargets')
        } catch {
          return directNavigate('targets')
        }
        if (reply.error) return directNavigate('targets')
        infos =
          (reply.result as { targetInfos?: Array<{ type?: unknown; targetId?: unknown }> } | undefined)
            ?.targetInfos ?? []
        if (infos.length > 0) break
        if (attempt < 3) {
          // 전체 타임아웃이 이 대기 중에 끝나면 runCdpScript가 이미
          // 종료된 뒤라, 깨어나서 보내는 getTargets는 call이
          // 'cdp closed'로 거절해 실제로 나가지 않는다 (재시도 누수 없음).
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
      }
      if (infos.length === 0) return directNavigate('targets')
      const pages = infos.filter(
        (t): t is { type: 'page'; targetId: string } =>
          t.type === 'page' && typeof t.targetId === 'string',
      )
      let sessionId: string
      if (pages.length > 0) {
        phase = 'attach'
        const attached = await attachActivePage(call, pages)
        if (!attached.ok) return directNavigate('attach')
        sessionId = attached.sessionId
        // 다른 페이지 타깃은 닫지 않는다 (2026-11-19 변경 — 2026-11-14의
        // 일괄 닫기는 폐기). 팝업은 이제 셸 탭이 되어 탭 전환으로 돌아올
        // 수 있으므로 주소창이 탈출구일 필요가 없다. 비서 읽기용 임시 탭은
        // assistant-read.ts가 직접 닫는다 (읽기 완료 시 closeTarget).
      } else {
        // page 타입이 없으면 첫 타깃으로 attach한다 (기존 동작 유지).
        phase = 'attach'
        const first = infos[0]
        if (typeof first.targetId !== 'string') return directNavigate('attach')
        let attachReply: CdpReply
        try {
          attachReply = await call('Target.attachToTarget', { targetId: first.targetId, flatten: true })
        } catch {
          return directNavigate('attach')
        }
        const attached = !attachReply.error
          ? ((attachReply.result as { sessionId?: unknown } | undefined)?.sessionId as string | undefined) ?? null
          : null
        if (!attached) return directNavigate('attach')
        sessionId = attached
      }
      // 뷰포트 (있으면): DSF는 REMOTE_DISPLAY_SCALE(1.0) 고정.
      // screen.width로 DSF를 역산하는 옛 방식은 리사이즈 중 옛
      // 디스플레이 크기를 읽어 잘못된 배율을 만들었다 (2026-11-16
      // QA 7차: 1.5배). set이 기존 override를 대체하므로 clear도
      // 불필요하다. 설정 실패여도 이동은 진행한다.
      if (viewport && viewport.width > 0 && viewport.height > 0) {
        phase = 'viewport'
        try {
          await call(
            'Emulation.setDeviceMetricsOverride',
            {
              width: Math.round(viewport.width),
              height: Math.round(viewport.height),
              deviceScaleFactor: REMOTE_DISPLAY_SCALE,
              mobile: false,
            },
            sessionId,
          )
        } catch {
          // 뷰포트 설정 실패여도 이동은 진행한다 (기본 뷰포트로 표시됨).
        }
      }
      phase = 'navigate'
      let navReply: CdpReply
      try {
        navReply = await call('Page.navigate', { url: targetUrl }, sessionId)
      } catch {
        return { ok: false, stage: 'navigate' }
      }
      return navReply.error ? { ok: false, stage: 'navigate' } : { ok: true, stage: 'ok' }
    },
    {
      connect: { ok: false, stage: 'connect' as const },
      timeout: () => ({ ok: false, stage: phase }),
    },
  )
}



/** 원격 페이지 타깃 하나 (사이드카 /control/state의 tabs 항목). */
export interface RemoteTab {
  targetId: string
  url: string
  title: string
  /** 팝업이면 연 부모 타깃 id, 아니면 null — 셸은 openerId가 있는 타깃만 새 탭으로 만든다. */
  openerId: string | null
}

export interface BrowserState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  /** 탭 목록 — 빠른 경로(사이드카)에서만 온다. 폴백(직접 CDP)에서는
   *  없어 셸이 탭 동기화를 건드리지 않는다 (없는 목록으로 팝업 탭을
   *  지워버리는 것을 막는다). */
  tabs?: RemoteTab[]
  /** 현재 화면에 보이는 타깃 id (빠른 경로에서만). */
  activeTargetId?: string | null
  /** 연결 시 처음 본 페이지 타깃 id (빠른 경로에서만). */
  mainTargetId?: string | null
}

/**
 * 사이드카 영구 CDP 연결에서 브라우저 상태를 1회 HTTPS fetch로 읽는다
 * (2026-11-17 P0: GET /control/state). getBrowserState의 직접 CDP
 * 경로는 폴링 1회당 Worker→Oracle 순차 왕복 ~8회(/json/version + CDP
 * WS 신규 연결 + CDP 5회, RTT ~168ms × 8 ≈ 1.5초)였으나, 이 경로는
 * 1왕복(약 0.25초)으로 줄어든다. 사이드카가 구버전(404)이거나
 * 실패·응답이 깨졌으면 null — 호출자는 getBrowserState 직접 CDP
 * 방식으로 폴백한다 (배포 순서 어긋남 대비). fetchFn을 주입할 수 있어
 * 테스트에서 모킹할 수 있다 (기본값은 전역 fetch).
 */
export type SidecarFetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

export async function fetchSidecarBrowserState(
  sidecarStateUrl: string,
  headers: Record<string, string>,
  fetchFn: SidecarFetchFn = fetch as unknown as SidecarFetchFn,
): Promise<BrowserState | null> {
  let res: { ok: boolean; status: number; json: () => Promise<unknown> }
  try {
    res = await fetchFn(sidecarStateUrl, { method: 'GET', headers })
  } catch {
    return null
  }
  if (!res.ok) return null
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return null
  }
  const b = body as
    | {
        ok?: unknown
        url?: unknown
        title?: unknown
        canGoBack?: unknown
        canGoForward?: unknown
        tabs?: unknown
        activeTargetId?: unknown
        mainTargetId?: unknown
      }
    | null
    | undefined
  if (!b || typeof b !== 'object' || b.ok !== true) return null
  if (typeof b.url !== 'string' || typeof b.title !== 'string') return null
  if (typeof b.canGoBack !== 'boolean' || typeof b.canGoForward !== 'boolean') return null
  const state: BrowserState = {
    url: b.url,
    title: b.title,
    canGoBack: b.canGoBack,
    canGoForward: b.canGoForward,
  }
  // 탭 목록은 배열일 때만, 항목 모양을 검증해서 통과시킨다 — 깨진 항목은
  // 버리고 목록 자체는 살린다 (하나 깨졌다고 탭 동기화 전체가 멈추면 안 된다).
  if (Array.isArray(b.tabs)) {
    const tabs: RemoteTab[] = []
    for (const t of b.tabs) {
      if (
        t &&
        typeof t === 'object' &&
        typeof (t as { targetId?: unknown }).targetId === 'string' &&
        typeof (t as { url?: unknown }).url === 'string' &&
        typeof (t as { title?: unknown }).title === 'string' &&
        ((t as { openerId?: unknown }).openerId === null ||
          typeof (t as { openerId?: unknown }).openerId === 'string')
      ) {
        const tt = t as { targetId: string; url: string; title: string; openerId: string | null }
        tabs.push({ targetId: tt.targetId, url: tt.url, title: tt.title, openerId: tt.openerId })
      }
    }
    state.tabs = tabs
  }
  // unknown은 `typeof x === 'string' || x === null` 복합 가드로 좁혀지지
  // 않는다(TS 5.9 실측 — 분기문을 나누면 좁혀진다).
  const activeTargetId = b.activeTargetId
  if (typeof activeTargetId === 'string') {
    state.activeTargetId = activeTargetId
  } else if (activeTargetId === null) {
    state.activeTargetId = null
  }
  const mainTargetId = b.mainTargetId
  if (typeof mainTargetId === 'string') {
    state.mainTargetId = mainTargetId
  } else if (mainTargetId === null) {
    state.mainTargetId = null
  }
  return state
}

/**
 * 원격 브라우저의 현재 상태를 읽는다 (2026-11-15: 주소창·뒤로가기가
 * 셸 로컬 기록만 봐서 원격 내 링크 이동을 몰랐던 문제의 정식 수정).
 * 활성(visible) 탭에 attach해 프로브 식(visibility·url·title 병합,
 * 2026-11-17 P1 통합)과 Page.getNavigationHistory를 읽는다
 * (2026-11-16: 첫 타깃은 동결된 백그라운드 탭일 수 있어 /state가
 * 매번 502가 됐다). 어느 단계든 실패하면 null을 돌려준다 (호출자는
 * 기존 표시를 유지한다).
 * 2026-11-17부터 /state 라우트의 빠른 경로(fetchSidecarBrowserState)
 * 가 실패할 때의 폴백이다 (구 사이드카·/control/state 장애 대비).
 */
export async function getBrowserState(
  webSocketDebuggerUrl: string,
  connect: CdpConnectFn = defaultCdpConnect,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {}
): Promise<BrowserState | null> {
  return runCdpScript(
    webSocketDebuggerUrl,
    connect,
    opts,
    async (call) => {
      const attached = await attachActivePage(call)
      if (!attached.ok) return null
      // 프로브가 url·title을 이미 줬으면 별도 평가 없이 쓴다 (P1 통합 —
      // 2회 평가가 1회로 줄어 1왕복이 사라진다). 프로브가 못 줬으면
      // (타임아웃·XML 문서 등) 기존처럼 별도 평가로 읽는다.
      let url: string | null = attached.page?.url ?? null
      let title: string | null = attached.page?.title ?? null
      if (url === null || title === null) {
        const evalReply = await call(
          'Runtime.evaluate',
          { expression: 'JSON.stringify({url: location.href, title: document.title})', returnByValue: true },
          attached.sessionId,
        )
        if (evalReply.error) return null
        const raw = evalString(evalReply.result)
        if (raw === null) return null
        try {
          const parsed = JSON.parse(raw) as { url?: unknown; title?: unknown }
          url = typeof parsed.url === 'string' ? parsed.url : null
          title = typeof parsed.title === 'string' ? parsed.title : null
        } catch {
          return null
        }
        if (url === null || title === null) return null
      }
      const histReply = await call('Page.getNavigationHistory', undefined, attached.sessionId)
      if (histReply.error) return null
      const hist = parseNavigationHistory(histReply.result)
      if (!hist) return null
      return {
        url,
        title,
        canGoBack: hist.currentIndex > 0,
        canGoForward: hist.currentIndex < hist.entries.length - 1,
      }
    },
    { connect: null, timeout: () => null },
  )
}

/** Page.getNavigationHistory 응답(result)에서 꺼낸 현재 위치·엔트리 목록. */
interface NavigationHistory {
  currentIndex: number
  entries: Array<{ id?: unknown }>
}

/** getNavigationHistory 응답(result)이 깨졌으면 null을 돌려준다. */
function parseNavigationHistory(result: unknown): NavigationHistory | null {
  const hist = result as { currentIndex?: unknown; entries?: unknown } | undefined
  if (typeof hist?.currentIndex !== 'number' || !Array.isArray(hist.entries)) return null
  return { currentIndex: hist.currentIndex, entries: hist.entries as Array<{ id?: unknown }> }
}

export type HistoryStage = 'ok' | 'connect' | 'targets' | 'attach' | 'history' | 'no-history'
export interface HistoryResult {
  ok: boolean
  stage: HistoryStage
}

/**
 * 활성 탭의 기록을 한 단계 이동한다 (2026-11-16 QA 2차: Page.goBack/
 * Page.goForward는 Chromium 156에 존재하지 않아 `'Page.goBack' wasn't
 * found` 에러만 돌려줬다 — 셸 뒤로/앞으로 버튼이 활성화돼도 아무 일도
 * 안 일어난 원인. 정식 경로는 Page.getNavigationHistory로 엔트리 id를
 * 읽어 Page.navigateToHistoryEntry로 이동하는 것이다 (puppeteer도
 * 이 경로를 쓴다). 갈 곳이 없으면 'no-history'로 구분해 보고한다
 * (오류가 아니다 — 호출자가 버튼 상태를 구분할 수 있게 한다).
 */
async function goHistorySession(
  webSocketDebuggerUrl: string,
  direction: 'back' | 'forward',
  connect: CdpConnectFn,
  opts: { headers?: Record<string, string>; timeoutMs?: number },
): Promise<HistoryResult> {
  let phase: HistoryStage = 'targets'
  return runCdpScript(
    webSocketDebuggerUrl,
    connect,
    opts,
    async (call) => {
      const attached = await attachActivePage(call)
      if (!attached.ok) return { ok: false, stage: attached.stage as HistoryStage }
      phase = 'history'
      const histReply = await call('Page.getNavigationHistory', undefined, attached.sessionId)
      if (histReply.error) return { ok: false, stage: 'history' as const }
      const hist = parseNavigationHistory(histReply.result)
      if (!hist) return { ok: false, stage: 'history' as const }
      const targetIndex = direction === 'back' ? hist.currentIndex - 1 : hist.currentIndex + 1
      if (targetIndex < 0 || targetIndex >= hist.entries.length) {
        return { ok: false, stage: 'no-history' as const }
      }
      const entryId = hist.entries[targetIndex]?.id
      if (typeof entryId !== 'number') return { ok: false, stage: 'history' as const }
      const navReply = await call('Page.navigateToHistoryEntry', { entryId }, attached.sessionId)
      return navReply.error
        ? { ok: false, stage: 'history' as const }
        : { ok: true, stage: 'ok' as const }
    },
    {
      connect: { ok: false, stage: 'connect' as const },
      timeout: () => ({ ok: false, stage: phase }),
    },
  )
}

/** 활성 탭을 기록 한 단계 뒤로 이동한다 (원격 내 이동 기록 기준). */
export async function goBackSession(
  webSocketDebuggerUrl: string,
  connect: CdpConnectFn = defaultCdpConnect,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {}
): Promise<HistoryResult> {
  return goHistorySession(webSocketDebuggerUrl, 'back', connect, opts)
}

/** 활성 탭을 기록 한 단계 앞으로 이동한다 (원격 내 이동 기록 기준). */
export async function goForwardSession(
  webSocketDebuggerUrl: string,
  connect: CdpConnectFn = defaultCdpConnect,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {}
): Promise<HistoryResult> {
  return goHistorySession(webSocketDebuggerUrl, 'forward', connect, opts)
}
