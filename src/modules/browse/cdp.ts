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
 * 디스플레이 기기 픽셀 너비에서 뷰포트 override의 DSF를 계산한다.
 * override는 {width: 스테이지 CSS px, DSF}이고 렌더링 기기 픽셀은
 * width × DSF이므로, 디스플레이를 꽉 채우려면 DSF = 디스플레이/스테이지다
 * (2940 디스플레이 × 1680 스테이지 = 1.75). DSF=1로 두면 1680px로
 * 래스터링해 1.75배 업스케일하므로 뿌옇다 (2026-11-15 라이브 진단).
 * 비정상 입력·측정 실패는 1로 폴백하고, 1~3으로 클램프·소수 2자리로 반올림한다.
 */
export function displayScaleFactor(displayDeviceWidth: number, viewportWidth: number): number {
  if (!Number.isFinite(displayDeviceWidth) || displayDeviceWidth <= 0) return 1
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return 1
  const raw = displayDeviceWidth / viewportWidth
  const clamped = Math.min(3, Math.max(1, raw))
  return Math.round(clamped * 100) / 100
}

/** Runtime.evaluate 응답(result)에서 숫자 값을 꺼낸다. 없으면 null. */
function evalNumber(result: unknown): number | null {
  const value = (result as { result?: { value?: unknown } } | null | undefined)?.result?.value
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

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

type AttachResult =
  | { ok: true; sessionId: string; targetId: string }
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
 * 모든 페이지 타깃에 차례로 attach해 document.visibilityState를
 * 평가하고 'visible'인 탭을 선택한다. visible인 탭이 없으면(전부
 * hidden·평가 실패·응답 없음 포함) attach에 성공한 첫 페이지 타깃으로
 * 폴백한다. attach가 전부 실패하면 stage='attach', 타깃이 없으면
 * stage='targets'. 라운드트립이 늘어도 괜찮다 — 폴링 간격 2초 +
 * 진행 중 가드가 있다. visible이 여러 탭이면 목록 순서상 첫 번째가
 * 이긴다 (가장 먼저 생긴 탭 — 키오스크 팝업이 떠 있어도 영구 탭이
 * visible로 보고되면 영구 탭이 선택된다).
 * pages를 넘기면 getTargets를 다시 부르지 않고 그 목록을 쓴다
 * (navigateSession은 닫을 타깃 목록이 필요해 미리 조회해 둔다).
 * 성공 시 sessionId와 함께 targetId도 돌려준다 — 호출자가 선택된 탭
 * 외의 탭을 닫는 데 쓴다.
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
    if (!firstSession) {
      firstSession = sessionId
      firstTargetId = page.targetId
    }
    const visibility = await evalStringWithTimeout(
      call,
      'document.visibilityState',
      sessionId,
      VISIBILITY_EVAL_TIMEOUT_MS,
    )
    if (visibility === 'visible') return { ok: true, sessionId, targetId: page.targetId }
  }
  if (firstSession && firstTargetId) return { ok: true, sessionId: firstSession, targetId: firstTargetId }
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
        // 키오스크 모드(2026-11-14)에서는 팝업 창이 전체 화면으로 떠서
        // 돌아올 방법이 없다 — 이동 시 이동시킬 탭 외의 페이지 타깃을
        // 닫아 MyHub 주소창을 탈출구로 만든다. 닫기는 응답을 안 기다리는
        // 발사 후 망각이다. (비서 읽기가 진행 중이면 그 탭도 닫혀 읽기가
        // 실패할 수 있으나 드물고 우아하게 실패한다 — 읽기는 실패를
        // 보고하고 탭은 어차피 닫힐 운명이다.) 스캔이 탭들을 attach한
        // 뒤라 닫기는 attach 뒤에 나가지만, navigate보다는 먼저 나간다.
        for (const t of pages) {
          if (t.targetId !== attached.targetId) {
            void call('Target.closeTarget', { targetId: t.targetId }).catch(() => undefined)
          }
        }
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
      // 뷰포트 (있으면): DSF 측정 (2026-11-15) — 낡은 override가 남아
      // 있으면 screen.width가 그 값을 돌려주므로 먼저 지우고 자연
      // 상태에서 디스플레이 기기 픽셀(screen.width × devicePixelRatio)을
      // 잰다. 지우기·측정 실패는 DSF=1 폴백으로 이어지고, 설정 실패여도
      // 이동은 진행한다.
      if (viewport && viewport.width > 0 && viewport.height > 0) {
        phase = 'viewport'
        let dsf = 1
        try {
          await call('Emulation.clearDeviceMetricsOverride', undefined, sessionId)
        } catch {
          // 지우기 실패여도 측정은 진행한다 (낡은 override가 남으면
          // 측정값이 틀릴 수 있으나 DSF=1 폴백보다는 낫다).
        }
        try {
          const measureReply = await call(
            'Runtime.evaluate',
            { expression: 'screen.width * devicePixelRatio', returnByValue: true },
            sessionId,
          )
          const measured = !measureReply.error ? evalNumber(measureReply.result) : null
          if (measured !== null) dsf = displayScaleFactor(measured, viewport.width)
        } catch {
          // 측정 실패는 DSF=1 폴백.
        }
        try {
          await call(
            'Emulation.setDeviceMetricsOverride',
            {
              width: Math.round(viewport.width),
              height: Math.round(viewport.height),
              deviceScaleFactor: dsf,
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


export type ViewportStage = 'ok' | 'connect' | 'targets' | 'attach' | 'viewport'
export interface ViewportResult {
  ok: boolean
  stage: ViewportStage
  /** override가 적용된 페이지 타깃 수 (2026-11-15: 전 탭 적용 보고용). */
  applied: number
  /** 적용 대상이었던 페이지 타깃 수. */
  total: number
  /** 적용 후 실측이 의도와 일치한 타깃 수 (2026-11-16: 적용 후 검증).
   * 읽기 실패로 확인 못한 타깃은 여기서 빠지지만 applied에는 들어간다
   * (읽기 실패 ≠ 적용 실패). */
  verified: number
}

/** 적용 후 실측 뷰포트 값 (innerWidth·innerHeight·devicePixelRatio). */
interface MeasuredViewport {
  width: number
  height: number
  dsf: number
}

/** override 적용 후 실제 렌더링 크기를 읽는다. 읽기 실패·깨진 값이면 null. */
async function readAppliedViewport(call: CdpCall, sessionId: string): Promise<MeasuredViewport | null> {
  let reply: CdpReply
  try {
    reply = await call(
      'Runtime.evaluate',
      { expression: 'JSON.stringify({w: innerWidth, h: innerHeight, d: devicePixelRatio})', returnByValue: true },
      sessionId,
    )
  } catch {
    return null
  }
  if (reply.error) return null
  const raw = evalString(reply.result)
  if (raw === null) return null
  let parsed: { w?: unknown; h?: unknown; d?: unknown }
  try {
    parsed = JSON.parse(raw) as { w?: unknown; h?: unknown; d?: unknown }
  } catch {
    return null
  }
  if (typeof parsed.w !== 'number' || typeof parsed.h !== 'number' || typeof parsed.d !== 'number') return null
  return { width: parsed.w, height: parsed.h, dsf: parsed.d }
}

/** 실측이 의도와 일치하는지: 크기 ±2px, DSF ±0.05 허용. */
function viewportMatches(
  measured: MeasuredViewport,
  intended: { width: number; height: number; deviceScaleFactor: number },
): boolean {
  return (
    Math.abs(measured.width - intended.width) <= 2 &&
    Math.abs(measured.height - intended.height) <= 2 &&
    Math.abs(measured.dsf - intended.deviceScaleFactor) <= 0.05
  )
}

type VerifyOutcome = 'ok' | 'mismatch' | 'unknown'

/**
 * 한 탭의 override 적용을 검증한다. 실측이 의도와 다르면 override를
 * 1회 재시도하고 다시 읽는다. 'ok' = 실측 일치, 'mismatch' = 재시도
 * 후에도 불일치(확정된 적용 실패), 'unknown' = 읽기를 못 해서 확인
 * 불가 (적용 실패가 아니다 — 호출자는 ok를 유지한다).
 */
async function verifyViewportApplied(
  call: CdpCall,
  sessionId: string,
  overrideParams: { width: number; height: number; deviceScaleFactor: number; mobile: boolean },
): Promise<VerifyOutcome> {
  const measured = await readAppliedViewport(call, sessionId)
  if (measured === null) return 'unknown'
  if (viewportMatches(measured, overrideParams)) return 'ok'
  try {
    const retryReply = await call('Emulation.setDeviceMetricsOverride', overrideParams, sessionId)
    if (retryReply.error) return 'mismatch'
  } catch {
    return 'mismatch'
  }
  const remeasured = await readAppliedViewport(call, sessionId)
  if (remeasured === null) return 'unknown'
  return viewportMatches(remeasured, overrideParams) ? 'ok' : 'mismatch'
}

/**
 * 이동 없이 원격 뷰포트만 맞춘다 (2026-11-15: 세션 복원·Chromium 재시작
 * 뒤에는 navigate가 없어 override가 한 번도 적용되지 않고, 원격이
 * X 디스플레이 전체(레티나 기기 픽셀) 크기로 렌더링돼 화면이 절반
 * 크기로 보였다 — 실측 innerWidth 2940 vs 맥 브라우저 1470).
 * navigateSession과 같은 attach 경로를 쓰되 이동은 하지 않는다.
 * 페이지 타깃이 없으면 재시도 없이 stage='targets'로 보고한다
 * (호출자는 다음 진입·리사이즈 때 다시 시도한다).
 *
 * 전 탭 적용 (2026-11-15 밤): 첫 타깃에만 걸던 기존 코드는 세션 복원된
 * 다른 탭에 영원히 안 닿아 탭마다 크기가 달랐다 (뉴스 1680×967@dpr1.75,
 * 네이버 메인 2940×1692@dpr1 — 렌더러별 DSF 캐시 차이). 모든 페이지
 * 타깃에 차례로 attach해 같은 override를 걸고, 한 타깃이 실패해도
 * 나머지는 계속 적용한다. ok는 전 타깃 적용일 때만 true이고, applied/
 * total로 부분 적용을 보고한다. DSF는 첫 attach 성공 타깃에서 낡은
 * override를 지운 뒤 자연 상태로 측정한다 (screen.width ×
 * devicePixelRatio = 디스플레이 기기 픽셀).
 *
 * 적용 후 검증 (2026-11-16 QA 1차): 적용 명령이 성공을 돌려줘도 실제
 * 렌더링이 의도와 다를 수 있다 (측정 단계에서 override를 지운 뒤
 * 재적용이 안 닿아 한 탭이 자연 DSF 1.75로 남아 1.73배 확대돼 보였다).
 * 각 탭마다 적용 후 innerWidth·innerHeight·devicePixelRatio를 다시
 * 읽어 의도와 비교하고, 안 맞으면 1회 재시도한다. 재시도 후에도 안
 * 맞으면 ok=false + verified로 보고한다 (프론트의 기존 재시도가 다음
 * 기회에 다시 시도한다). 읽기 실패는 미검증으로 두고 적용 실패로
 * 보지 않는다.
 *
 * 읽기 우선·건드리지 않기 (2026-11-16 QA 2차): 새 탭(Ctrl+T)은
 * /viewport 이후에 생겨 override를 상속받지 않아 자연 DSF 1.75로
 * 남는다 (실측 1096×500). 프론트가 10초마다 재적용하므로, 재적용이
 * 올바른 탭을 건드려 깜빡임을 만들면 안 된다 — 예전처럼 매번 첫 탭의
 * override를 지우고 재는 방식은 10초마다 첫 탭을 깜빡이게 한다.
 * 그래서 1단계로 전 탭의 현재 실측을 먼저 읽고, 후보 DSF(첫 실측
 * 가능 탭의 innerWidth × devicePixelRatio = 디스플레이 기기 픽셀 —
 * override가 걸린 탭은 너비×DSF가, 없는 탭은 자연 너비×자연 DSF가
 * 디스플레이 너비다)와 비교해 전 탭이 일치하면 set도 clear도 없이
 * 끝낸다. 불일치 탭이 있을 때만 2단계로 불일치 탭에서 override를
 * 지우고 디스플레이를 권위 있게 다시 잰 뒤 (screen.width ×
 * devicePixelRatio), 불일치 탭에만 적용한다. 측정 탭은 지워서 자연
 * 상태가 됐으니 무조건 다시 건다. 디스플레이가 리사이즈되면
 * 스테이지도 함께 바뀌어 후보 너비와 안 맞아 2단계로 가므로, 낡은
 * 후보 DSF가 남지 않는다.
 */
export async function applyViewportToSession(
  webSocketDebuggerUrl: string,
  viewport: ViewportSize,
  connect: CdpConnectFn = defaultCdpConnect,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {}
): Promise<ViewportResult> {
  let phase: ViewportStage = 'targets'
  let applied = 0
  let total = 0
  let verified = 0
  let firstFailStage: ViewportStage | null = null
  const noteFail = (stage: ViewportStage) => {
    if (!firstFailStage) firstFailStage = stage
  }
  return runCdpScript(
    webSocketDebuggerUrl,
    connect,
    opts,
    async (call) => {
      let mismatch = 0
      const targetsReply = await call('Target.getTargets')
      if (targetsReply.error) {
        return { ok: false, stage: 'targets' as const, applied: 0, total: 0, verified: 0 }
      }
      const infos =
        (targetsReply.result as { targetInfos?: Array<{ type?: unknown; targetId?: unknown }> } | undefined)
          ?.targetInfos ?? []
      // navigateSession과 달리 첫 타깃으로 폴백하지 않는다:
      // Emulation.setDeviceMetricsOverride는 페이지 세션에서만
      // 동작하므로 browser 타깃에 attach해 봤자 실패할 뿐이다.
      const pages = infos.filter(
        (t): t is { type: 'page'; targetId: string } =>
          t.type === 'page' && typeof t.targetId === 'string',
      )
      total = pages.length
      if (pages.length === 0) {
        return { ok: false, stage: 'targets' as const, applied: 0, total: 0, verified: 0 }
      }
      // 1단계: 전 탭 attach + 현재 실측 읽기 (clear 없음 — 올바른
      // 탭을 건드리지 않는다).
      const sessions: Array<{ sessionId: string; measured: MeasuredViewport | null }> = []
      for (const page of pages) {
        phase = 'attach'
        let sessionId: string | null = null
        try {
          const attachReply = await call('Target.attachToTarget', { targetId: page.targetId, flatten: true })
          sessionId = !attachReply.error
            ? ((attachReply.result as { sessionId?: unknown } | undefined)?.sessionId as string | undefined) ?? null
            : null
        } catch {
          sessionId = null
        }
        if (!sessionId) {
          noteFail('attach')
          continue
        }
        sessions.push({ sessionId, measured: null })
      }
      if (sessions.length === 0) {
        return { ok: false, stage: 'attach' as const, applied: 0, total, verified: 0 }
      }
      phase = 'viewport'
      for (const s of sessions) {
        s.measured = await readAppliedViewport(call, s.sessionId)
      }
      // 후보 DSF: 첫 실측 가능 탭의 innerWidth × devicePixelRatio.
      let candidateDsf: number | null = null
      for (const s of sessions) {
        if (s.measured) {
          candidateDsf = displayScaleFactor(s.measured.width * s.measured.dsf, viewport.width)
          break
        }
      }
      if (candidateDsf !== null) {
        const candidate = {
          width: Math.round(viewport.width),
          height: Math.round(viewport.height),
          deviceScaleFactor: candidateDsf,
          mobile: false,
        }
        // 전 탭이 후보와 일치하면 끝 — set도 clear도 하지 않는다
        // (주기 재적용의 정상 경로: 올바른 탭은 건드리지 않는다).
        const allMatch = sessions.every((s) => s.measured !== null && viewportMatches(s.measured, candidate))
        if (allMatch) {
          const n = sessions.length
          const ok = n === total
          return { ok, stage: ok ? ('ok' as const) : ('attach' as const), applied: n, total, verified: n }
        }
      }
      // 2단계: 불일치 탭이 있다 (또는 후보를 못 잰다). 불일치 탭에서
      // override를 지우고 디스플레이를 권위 있게 다시 잰다. 측정 탭은
      // 불일치 탭을 우선한다 — 이미 틀린 탭이라 지워도 손해가 없다.
      let measureSessionId = sessions[0].sessionId
      if (candidateDsf !== null) {
        const candidate = {
          width: Math.round(viewport.width),
          height: Math.round(viewport.height),
          deviceScaleFactor: candidateDsf,
          mobile: false,
        }
        const bad = sessions.find((s) => s.measured === null || !viewportMatches(s.measured, candidate))
        if (bad) measureSessionId = bad.sessionId
      }
      let dsf = candidateDsf ?? 1
      try {
        await call('Emulation.clearDeviceMetricsOverride', undefined, measureSessionId)
      } catch {
        // 무시 — 측정만 후보 DSF로 이어진다
      }
      try {
        const measureReply = await call(
          'Runtime.evaluate',
          { expression: 'screen.width * devicePixelRatio', returnByValue: true },
          measureSessionId,
        )
        const displayWidth = !measureReply.error ? evalNumber(measureReply.result) : null
        if (displayWidth !== null) dsf = displayScaleFactor(displayWidth, viewport.width)
      } catch {
        // 무시 — 후보 DSF로 폴백한다
      }
      const overrideParams = {
        width: Math.round(viewport.width),
        height: Math.round(viewport.height),
        deviceScaleFactor: dsf,
        mobile: false,
      }
      for (const s of sessions) {
        if (s.sessionId !== measureSessionId && s.measured !== null && viewportMatches(s.measured, overrideParams)) {
          // 1단계 실측이 이미 의도와 일치한다 — 건드리지 않고
          // 적용·검증됨으로 센다 (측정 탭은 지워서 자연 상태가
          // 됐으니 아래에서 무조건 다시 건다).
          applied += 1
          verified += 1
          continue
        }
        let setOk = false
        try {
          const vpReply = await call('Emulation.setDeviceMetricsOverride', overrideParams, s.sessionId)
          if (vpReply.error) noteFail('viewport')
          else setOk = true
        } catch {
          noteFail('viewport')
        }
        if (!setOk) continue
        applied += 1
        // 적용 후 검증: 실측이 의도와 다르면 1회 재시도하고, 그래도 안
        // 맞으면 확정 불일치로 센다. 읽기 실패('unknown')는 미검증으로
        // 두고 적용 실패로 보지 않는다.
        const outcome = await verifyViewportApplied(call, s.sessionId, overrideParams)
        if (outcome === 'ok') verified += 1
        else if (outcome === 'mismatch') {
          mismatch += 1
          noteFail('viewport')
        }
      }
      const ok = applied === total && mismatch === 0
      return { ok, stage: ok ? ('ok' as const) : (firstFailStage ?? 'viewport'), applied, total, verified }
    },
    {
      connect: { ok: false, stage: 'connect' as const, applied: 0, total: 0, verified: 0 },
      timeout: () => ({ ok: false, stage: phase, applied, total, verified }),
    },
  )
}

export interface BrowserState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
}

/**
 * 원격 브라우저의 현재 상태를 읽는다 (2026-11-15: 주소창·뒤로가기가
 * 셸 로컬 기록만 봐서 원격 내 링크 이동을 몰랐던 문제의 정식 수정).
 * 활성(visible) 탭에 attach해 location.href·document.title과
 * Page.getNavigationHistory를 읽는다 (2026-11-16: 첫 타깃은 동결된
 * 백그라운드 탭일 수 있어 /state가 매번 502가 됐다). 어느 단계든
 * 실패하면 null을 돌려준다 (호출자는 기존 표시를 유지한다).
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
      const evalReply = await call(
        'Runtime.evaluate',
        { expression: 'JSON.stringify({url: location.href, title: document.title})', returnByValue: true },
        attached.sessionId,
      )
      if (evalReply.error) return null
      const raw = evalString(evalReply.result)
      if (raw === null) return null
      let url: unknown
      let title: unknown
      try {
        const parsed = JSON.parse(raw) as { url?: unknown; title?: unknown }
        url = parsed.url
        title = parsed.title
      } catch {
        return null
      }
      if (typeof url !== 'string' || typeof title !== 'string') return null
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
