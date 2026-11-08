/**
 * CDP(Chrome DevTools Protocol) 최소 클라이언트 — Browser Run 세션의
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

export type NavigateStage = 'ok' | 'connect' | 'targets' | 'attach' | 'navigate'
export interface NavigateResult {
  ok: boolean
  stage: NavigateStage
}

/**
 * 세션의 페이지 타깃에 targetUrl 이동을 지시한다.
 * 타깃 attach가 안 되는 환경에서는 세션 소켓에 직접 navigate하는 폴백을 쓴다.
 */
export async function navigateSession(
  webSocketDebuggerUrl: string,
  targetUrl: string,
  connect: CdpConnectFn = defaultCdpConnect,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {}
): Promise<NavigateResult> {
  const timeoutMs = opts.timeoutMs ?? NAVIGATE_TIMEOUT_MS
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
          phase = 'navigate'
          navigateId = send('Page.navigate', { url: targetUrl }, true)
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
