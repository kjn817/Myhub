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
  return `ws://${host}:${port}${endpoint}`
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
  const timeoutMs = opts.timeoutMs ?? NAVIGATE_TIMEOUT_MS
  const viewport = opts.viewport
  let sock: CdpSocket | null = null
  try {
    sock = await connect(webSocketDebuggerUrl, opts.headers)
  } catch {
    return { ok: false, stage: 'connect' }
  }
  if (!sock) return { ok: false, stage: 'connect' }
  const socket = sock
  try {
    return await new Promise<NavigateResult>((resolve) => {
      let done = false
      let nextId = 0
      let sessionId: string | null = null
      let phase: NavigateStage = 'targets'
      let targetsId = -1
      let attachId = -1
      let viewportId = -1
      let navigateId = -1
      let directId = -1
      let targetTries = 0
      let fallbackStage: NavigateStage = 'targets'
      const finish = (result: NavigateResult) => {
        if (done) return
        done = true
        clearTimeout(timer)
        try {
          socket.close()
        } catch {
          // 무시
        }
        resolve(result)
      }
      const timer = setTimeout(() => finish({ ok: false, stage: phase }), timeoutMs)
      const send = (method: string, params?: Record<string, unknown>, withSession = false): number => {
        const id = ++nextId
        const msg: Record<string, unknown> = { id, method }
        if (params) msg.params = params
        if (withSession && sessionId) msg.sessionId = sessionId
        try {
          socket.send(JSON.stringify(msg))
        } catch {
          finish({ ok: false, stage: phase })
        }
        return id
      }
      const sendDirectNavigate = (fromStage: NavigateStage) => {
        fallbackStage = fromStage
        phase = 'navigate'
        directId = send('Page.navigate', { url: targetUrl })
      }
      const askTargets = () => {
        targetTries += 1
        targetsId = send('Target.getTargets')
      }
      const sendNavigate = () => {
        phase = 'navigate'
        navigateId = send('Page.navigate', { url: targetUrl }, true)
      }
      const sendViewportOrNavigate = () => {
        if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
          sendNavigate()
          return
        }
        phase = 'viewport'
        viewportId = send(
          'Emulation.setDeviceMetricsOverride',
          { width: Math.round(viewport.width), height: Math.round(viewport.height), deviceScaleFactor: 1, mobile: false },
          true
        )
      }
      socket.addEventListener('message', (ev) => {
        let msg: any
        try {
          msg = JSON.parse(String(ev.data))
        } catch {
          return
        }
        if (msg.id === targetsId) {
          if (msg.error) {
            sendDirectNavigate('targets')
            return
          }
          const infos = msg.result?.targetInfos ?? []
          const page = infos.find((t: any) => t.type === 'page') ?? infos[0]
          if (!page) {
            if (targetTries < 4) {
              setTimeout(askTargets, 300)
            } else {
              sendDirectNavigate('targets')
            }
            return
          }
          phase = 'attach'
          attachId = send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
        } else if (msg.id === attachId) {
          const attached = !msg.error ? msg.result?.sessionId ?? null : null
          if (!attached) {
            sendDirectNavigate('attach')
            return
          }
          sessionId = attached
          sendViewportOrNavigate()
        } else if (viewportId !== -1 && msg.id === viewportId) {
          // 뷰포트 설정 실패여도 이동은 진행한다 (기본 뷰포트로 표시됨).
          sendNavigate()
        } else if (navigateId !== -1 && msg.id === navigateId) {
          finish(msg.error ? { ok: false, stage: 'navigate' } : { ok: true, stage: 'ok' })
        } else if (directId !== -1 && msg.id === directId) {
          finish(msg.error ? { ok: false, stage: fallbackStage } : { ok: true, stage: 'ok' })
        }
      })
      askTargets()
    })
  } catch {
    return { ok: false, stage: 'connect' }
  } finally {
    try {
      sock?.close()
    } catch {
      // 무시
    }
  }
}
