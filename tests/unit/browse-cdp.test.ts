/// <reference types="jest" />
/**
 * src/modules/browse/cdp.ts — CDP 내비게이션 상태기계 성질 테스트 (C3).
 *
 * 고정하는 성질:
 * - URL 변환: wss→https, ws→http, 그 외는 그대로.
 * - 연결 실패(예외·null)는 stage='connect'로 구분되고, 소켓이 열리면
 *   getTargets → attach → navigate 순서로 메시지가 나가며 sessionId가
 *   navigate에만 실린다.
 * - 단계별 실패는 실패한 단계 이름으로 돌아온다 (targets/attach 폴백은
 *   세션 없는 직접 navigate로 이어지고, 그 실패는 원래 단계로 보고된다).
 * - 응답이 없으면 timeoutMs 안에 현재 단계로 종료하고 소켓은 닫힌다.
 * 카나리아: 단계 보고(stage)나 폴백 조건을 깨면 해당 테스트가 실패한다.
 */
import { navigateSession, wsToHttpUrl, type CdpSocket } from '../../src/modules/browse/cdp'

type Listener = (ev: { data: unknown }) => void

class FakeSocket implements CdpSocket {
  sent: Array<Record<string, any>> = []
  closed = false
  throwOnSend = false
  throwOnClose = false
  private listeners: Listener[] = []
  constructor(private handler: (msg: Record<string, any>, emit: (m: unknown) => void, raw: (s: string) => void) => void) {}
  send(data: string): void {
    if (this.throwOnSend) throw new Error('send boom')
    const msg = JSON.parse(data) as Record<string, any>
    this.sent.push(msg)
    this.handler(msg, (m) => this.emit(m), (s) => this.emitRaw(s))
  }
  private emit(m: unknown): void {
    this.emitRaw(JSON.stringify(m))
  }
  private emitRaw(s: string): void {
    queueMicrotask(() => {
      for (const l of this.listeners) l({ data: s })
    })
  }
  addEventListener(_type: 'message', listener: Listener): void {
    this.listeners.push(listener)
  }
  close(): void {
    if (this.throwOnClose) throw new Error('close boom')
    this.closed = true
  }
}

const WS_URL = 'wss://browser.example/devtools/browser/abc'
const TARGET = 'https://example.com/page'

function happyHandler(msg: Record<string, any>, emit: (m: unknown) => void): void {
  if (msg.method === 'Target.getTargets') {
    emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'page-1' }, { type: 'browser' }] } })
  } else if (msg.method === 'Target.attachToTarget') {
    emit({ id: msg.id, result: { sessionId: 'sess-1' } })
  } else if (msg.method === 'Page.navigate') {
    emit({ id: msg.id, result: {} })
  }
}

describe('wsToHttpUrl', () => {
  test('wss는 https로, ws는 http로 바뀌고 나머지는 그대로다', () => {
    expect(wsToHttpUrl('wss://h.example/x?y=1')).toBe('https://h.example/x?y=1')
    expect(wsToHttpUrl('ws://h.example/x')).toBe('http://h.example/x')
    expect(wsToHttpUrl('https://h.example/x')).toBe('https://h.example/x')
    expect(wsToHttpUrl('wss://h.example')).not.toContain('wss:')
  })
})

describe('navigateSession — 정상 경로', () => {
  test('getTargets→attach→navigate 순서, sessionId는 navigate에만 실리고 소켓이 닫힌다', async () => {
    const sock = new FakeSocket(happyHandler)
    let gotHeaders: Record<string, string> | undefined
    const connect = async (_url: string, headers?: Record<string, string>) => {
      gotHeaders = headers
      return sock as CdpSocket
    }
    const r = await navigateSession(WS_URL, TARGET, connect, { headers: { Authorization: 'Bearer t' } })
    expect(r).toEqual({ ok: true, stage: 'ok' })
    expect(gotHeaders).toEqual({ Authorization: 'Bearer t' })
    expect(sock.sent.map((m) => m.method)).toEqual(['Target.getTargets', 'Target.attachToTarget', 'Page.navigate'])
    expect(sock.sent[1].params).toEqual({ targetId: 'page-1', flatten: true })
    expect(sock.sent[2].params).toEqual({ url: TARGET })
    expect(sock.sent[2].sessionId).toBe('sess-1')
    expect(sock.sent[0].sessionId).toBeUndefined()
    expect(sock.closed).toBe(true)
  })

  test('page 타입이 없으면 첫 타깃으로 attach한다', async () => {
    const sock = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') {
        emit({ id: msg.id, result: { targetInfos: [{ type: 'service_worker', targetId: 'sw-1' }] } })
      } else if (msg.method === 'Target.attachToTarget') {
        emit({ id: msg.id, result: { sessionId: 's' } })
      } else if (msg.method === 'Page.navigate') {
        emit({ id: msg.id, result: {} })
      }
    })
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r.ok).toBe(true)
    expect(sock.sent[1].params.targetId).toBe('sw-1')
  })

  test('깨진 JSON 메시지는 무시하고 이후 정상 응답으로 완료한다', async () => {
    const sock = new FakeSocket((msg, emit, raw) => {
      if (msg.method === 'Target.getTargets') {
        raw('{{{not json')
        emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'p' }] } })
      } else if (msg.method === 'Target.attachToTarget') {
        emit({ id: msg.id, result: { sessionId: 's' } })
      } else if (msg.method === 'Page.navigate') {
        emit({ id: msg.id, result: {} })
      }
    })
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok' })
  })

  test('close가 던져도 결과는 정상으로 돌아온다', async () => {
    const sock = new FakeSocket(happyHandler)
    sock.throwOnClose = true
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok' })
  })
})

describe('navigateSession — 연결·단계 실패', () => {
  test('connect가 null을 돌려주거나 던지면 stage=connect', async () => {
    await expect(navigateSession(WS_URL, TARGET, async () => null)).resolves.toEqual({ ok: false, stage: 'connect' })
    await expect(
      navigateSession(WS_URL, TARGET, async () => { throw new Error('ws down') }),
    ).resolves.toEqual({ ok: false, stage: 'connect' })
  })

  test('attach 이후 navigate가 오류면 stage=navigate', async () => {
    const sock = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'p' }] } })
      else if (msg.method === 'Target.attachToTarget') emit({ id: msg.id, result: { sessionId: 's' } })
      else if (msg.method === 'Page.navigate') emit({ id: msg.id, error: { message: 'cannot navigate' } })
    })
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: false, stage: 'navigate' })
  })

  test('getTargets 오류면 세션 없는 직접 navigate로 폴백하고 성공할 수 있다', async () => {
    const sock = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') emit({ id: msg.id, error: { message: 'no targets api' } })
      else if (msg.method === 'Page.navigate') emit({ id: msg.id, result: {} })
    })
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: true, stage: 'ok' })
    const nav = sock.sent.find((m) => m.method === 'Page.navigate')!
    expect(nav.sessionId).toBeUndefined()
    expect(nav.params).toEqual({ url: TARGET })
  })

  test('attach 실패 후 직접 navigate도 실패하면 stage=attach로 보고한다', async () => {
    const sock = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'p' }] } })
      else if (msg.method === 'Target.attachToTarget') emit({ id: msg.id, error: { message: 'attach denied' } })
      else if (msg.method === 'Page.navigate') emit({ id: msg.id, error: { message: 'nav denied' } })
    })
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: false, stage: 'attach' })
  })

  test('타깃이 끝내 없으면 재시도 후 직접 navigate로 폴백한다', async () => {
    const sock = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') emit({ id: msg.id, result: { targetInfos: [] } })
      else if (msg.method === 'Page.navigate') emit({ id: msg.id, result: {} })
    })
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket, { timeoutMs: 8000 })
    expect(r).toEqual({ ok: true, stage: 'ok' })
    expect(sock.sent.filter((m) => m.method === 'Target.getTargets').length).toBe(4)
  }, 15000)

  test('응답이 없으면 timeoutMs 뒤 현재 단계(targets)로 종료하고 소켓을 닫는다', async () => {
    const sock = new FakeSocket(() => { /* 무응답 */ })
    const started = Date.now()
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket, { timeoutMs: 120 })
    expect(r).toEqual({ ok: false, stage: 'targets' })
    expect(Date.now() - started).toBeLessThan(3000)
    expect(sock.closed).toBe(true)
  })

  test('send가 던지면 현재 단계로 실패한다', async () => {
    const sock = new FakeSocket(happyHandler)
    sock.throwOnSend = true
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: false, stage: 'targets' })
  })

  test('리스너 등록 자체가 던지면 stage=connect로 변환된다', async () => {
    const sock = new FakeSocket(happyHandler)
    sock.addEventListener = () => { throw new Error('no listeners') }
    const r = await navigateSession(WS_URL, TARGET, async () => sock as CdpSocket)
    expect(r).toEqual({ ok: false, stage: 'connect' })
  })
})

describe('defaultCdpConnect — Workers fetch 경계', () => {
  const realFetch = global.fetch
  afterEach(() => { global.fetch = realFetch })

  test('업그레이드 응답의 webSocket을 accept해 쓰고, URL은 https로 변환된다', async () => {
    const sock = new FakeSocket(happyHandler)
    let accepted = false
    ;(sock as any).accept = () => { accepted = true }
    let seenUrl = ''
    let seenHeaders: Record<string, string> | undefined
    global.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      seenUrl = String(url)
      seenHeaders = init?.headers
      return { webSocket: sock }
    }) as unknown as typeof fetch
    const r = await navigateSession(WS_URL, TARGET, undefined, { headers: { Authorization: 'Bearer t' } })
    expect(r).toEqual({ ok: true, stage: 'ok' })
    expect(seenUrl).toBe('https://browser.example/devtools/browser/abc')
    expect(seenHeaders).toMatchObject({ Upgrade: 'websocket', Authorization: 'Bearer t' })
    expect(accepted).toBe(true)
  })

  test('업그레이드 응답에 webSocket이 없으면 connect 실패다', async () => {
    global.fetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch
    const r = await navigateSession(WS_URL, TARGET)
    expect(r).toEqual({ ok: false, stage: 'connect' })
  })
})
