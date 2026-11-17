/// <reference types="jest" />
/**
 * GET /api/browse/state · POST /api/browse/back|forward · POST /api/browse/viewport
 * — 원격 브라우저 상태·히스토리 라우트 (2026-11-15 밤).
 *
 * 고정하는 성질:
 * - /state: 활성(visible) 탭의 실제 URL·제목·뒤로/앞으로 가능 여부를
 *   CDP로 읽어 돌려준다 (2026-11-16: 첫 타깃은 동결된 백그라운드
 *   탭일 수 있어 /state가 매번 502가 됐다). 설정 없음 503, 잠김 423,
 *   /json/version 실패 502 ORACLE_UPSTREAM, 상태 읽기 실패
 *   502 BROWSER_STATE.
 * - /state 빠른 경로 (2026-11-17 P0): 사이드카 영구 CDP 연결의
 *   GET /control/state를 1회 fetch로 읽는다 (직접 CDP는 폴링 1회당
 *   순차 왕복 ~8회, 약 1.5초 → 1왕복, 약 0.25초). 사이드카가
 *   구버전(404)이거나 실패·응답이 깨지면 직접 CDP 방식으로 폴백한다
 *   (배포 순서 어긋남 대비). 빠른 경로가 성공하면 /json/version·
 *   CDP WS를 부르지 않는다. 잠금 검사는 한 번만 한다.
 * - /back·/forward: CDP getNavigationHistory로 엔트리 id를 읽어
 *   Page.navigateToHistoryEntry로 활성 탭을 이동시키고 200 + { ok, stage }
 *   로 보고한다 (실패해도 200). 설정 없음 503, 잠김 423. 라이브가
 *   켜져 있을 때 호출자는 로컬 기록으로 폴백하지 않는다 (2026-11-16
 *   QA 1차). (2026-11-16 QA 2차: Page.goBack/goForward는 Chromium
 *   156에 없어 'wasn't found' 에러만 돌려줬다.)
 * - /viewport: 사이드카 영구 override 매니저(/control/viewport)에
 *   크기를 전달하고 적용 결과를 { ok, stage, applied, total,
 *   verified }로 보고한다 (2026-11-16 QA 12차: 직접 CDP는 세션을
 *   닫으면 override가 풀려 렌더러가 1918로 되돌아갔다). 사이드카
 *   미연결(적용 0건)은 ok:false + stage=viewport, 닿지 않으면
 *   502 ORACLE_UPSTREAM.
 * - 공통 게이트(gateCdp): 잠금 검사는 UNLOCK_SECRET이 있을 때만 하고,
 *   CDP 연결은 사이드카 직접 URL(https://호스트:8081/devtools/...)로 간다.
 * 네트워크 경계는 전역 fetch 목킹이다 (실 Oracle 연결은 하지 않는다).
 * 카나리아: 시크릿 주입·잠금 게이트·CDP 메서드·응답 모양을 깨면
 * 해당 테스트가 실패한다.
 */
import { Hono } from 'hono'
import { browseApp } from '../../src/modules/browse/routes'

const app = new Hono()
app.route('/api/browse', browseApp)

const HOST = '203.0.113.7'
const ENV = {
  ORACLE_BROWSER_HOST: HOST,
  ORIGIN_SECRET: 'origin-secret',
  CDP_SECRET: 'cdp-secret',
  SELKIES_PASSWORD: 'selkies-pass',
}
const ENV_LOCKED = {
  ...ENV,
  UNLOCK_SECRET: 'unlock-secret-0123456789',
}

type Listener = (ev: { data: unknown }) => void

class FakeSocket {
  sent: Array<Record<string, any>> = []
  closed = false
  accepted = false
  private listeners: Listener[] = []
  constructor(
    private handler: (msg: Record<string, any>, emit: (m: unknown) => void) => void,
  ) {}
  send(data: string): void {
    const msg = JSON.parse(data) as Record<string, any>
    this.sent.push(msg)
    this.handler(msg, (m) => this.emit(m))
  }
  private emit(m: unknown): void {
    queueMicrotask(() => {
      for (const l of this.listeners) l({ data: JSON.stringify(m) })
    })
  }
  addEventListener(_type: 'message', listener: Listener): void {
    this.listeners.push(listener)
  }
  close(): void {
    this.closed = true
  }
  accept(): void {
    this.accepted = true
  }
}

const realFetch = global.fetch
interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
}
let fetchCalls: FetchCall[] = []

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<unknown>): void {
  fetchCalls = []
  global.fetch = (async (url: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    const h = init?.headers as Record<string, string> | Headers | undefined
    if (h) {
      if (typeof (h as Headers).forEach === 'function') {
        ;(h as Headers).forEach((v, k) => {
          headers[k.toLowerCase()] = v
        })
      } else {
        for (const [k, v] of Object.entries(h as Record<string, string>)) {
          headers[k.toLowerCase()] = v
        }
      }
    }
    fetchCalls.push({ url: String(url), method: init?.method ?? 'GET', headers })
    return handler(String(url), init)
  }) as typeof fetch
}

afterEach(() => {
  global.fetch = realFetch
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const VERSION_BODY = {
  webSocketDebuggerUrl: 'wss://myhub.myhub-app.workers.dev/api/browse/cdp/devtools/browser/abc',
}

/** /json/version은 공개 베이스 ws URL을, WS 업그레이드는 FakeSocket을 준다. */
function stubCdp(sock: FakeSocket, extra?: (url: string) => Promise<unknown> | null): void {
  stubFetch(async (url) => {
    if (extra) {
      const r = await extra(url)
      if (r !== null) return r
    }
    if (url.includes('/json/version')) return jsonResponse(VERSION_BODY)
    if (url.includes('/devtools/browser/')) return { webSocket: sock }
    throw new Error(`unexpected fetch: ${url}`)
  })
}

function stateHandler(msg: Record<string, any>, emit: (m: unknown) => void): void {
  if (msg.method === 'Target.getTargets') {
    emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'page-1' }] } })
  } else if (msg.method === 'Target.attachToTarget') {
    emit({ id: msg.id, result: { sessionId: 'sess-1' } })
  } else if (msg.method === 'Runtime.evaluate') {
    // 활성 탭 식별용 visibility 평가와 URL 읽기 식을 구분해 답한다.
    if (String(msg.params?.expression ?? '').includes('visibilityState')) {
      emit({ id: msg.id, result: { result: { type: 'string', value: 'visible' } } })
    } else {
      emit({
        id: msg.id,
        result: {
          result: {
            type: 'string',
            value: JSON.stringify({ url: 'https://news.naver.com/article/123', title: '뉴스 기사' }),
          },
        },
      })
    }
  } else if (msg.method === 'Page.getNavigationHistory') {
    emit({ id: msg.id, result: { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }, { id: 3 }] } })
  }
}

function historyHandler(msg: Record<string, any>, emit: (m: unknown) => void): void {
  if (msg.method === 'Target.getTargets') {
    emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'page-1' }] } })
  } else if (msg.method === 'Target.attachToTarget') {
    emit({ id: msg.id, result: { sessionId: 'sess-1' } })
  } else if (msg.method === 'Runtime.evaluate') {
    // 활성 탭 식별용 visibility 평가에 visible로 답한다 (무응답이면
    // 타깃당 1.5초 제한까지 기다려 테스트가 느려진다).
    emit({ id: msg.id, result: { result: { type: 'string', value: 'visible' } } })
  } else if (msg.method === 'Page.getNavigationHistory') {
    emit({ id: msg.id, result: { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }, { id: 3 }] } })
  } else if (msg.method === 'Page.navigateToHistoryEntry') {
    emit({ id: msg.id, result: {} })
  }
}
describe('GET /state — 원격 현재 상태', () => {
  test('설정이 없으면 503 ORACLE_NOT_CONFIGURED이고 fetch를 부르지 않는다', async () => {
    stubFetch(async () => {
      throw new Error('must not be called')
    })
    const res = await app.request('/api/browse/state', {}, {} as never)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, error: 'ORACLE_NOT_CONFIGURED' })
    expect(fetchCalls).toHaveLength(0)
  })

  test('잠기면 423 BROWSER_LOCKED이고 CDP에 닿지 않는다', async () => {
    const sock = new FakeSocket(stateHandler)
    stubCdp(sock, async (url) => {
      if (url.includes('/unlock/status')) {
        return jsonResponse({ configured: true, unlocked: false })
      }
      return null
    })
    const res = await app.request('/api/browse/state', {}, ENV_LOCKED as never)
    expect(res.status).toBe(423)
    expect(await res.json()).toEqual({ ok: false, error: 'BROWSER_LOCKED' })
    expect(fetchCalls.some((c) => c.url.includes('/devtools/browser/'))).toBe(false)
    expect(sock.sent).toHaveLength(0)
  })

  test('/json/version 실패는 502 ORACLE_UPSTREAM', async () => {
    stubFetch(async () => new Response('{}', { status: 500 }))
    const res = await app.request('/api/browse/state', {}, ENV as never)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ ok: false, error: 'ORACLE_UPSTREAM' })
  })

  test('CDP로 읽은 URL·제목·뒤로/앞으로를 돌려주고, WS는 사이드카 직접 URL로 간다', async () => {
    const sock = new FakeSocket(stateHandler)
    stubCdp(sock)
    const res = await app.request('/api/browse/state', {}, ENV as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      url: 'https://news.naver.com/article/123',
      title: '뉴스 기사',
      canGoBack: true,
      canGoForward: true,
    })
    const wsCall = fetchCalls.find((c) => c.url.includes('/devtools/browser/'))
    expect(wsCall).toBeDefined()
    expect(wsCall!.url).toBe(`https://${HOST}:8081/devtools/browser/abc`)
    expect(wsCall!.headers['x-origin-secret']).toBe('origin-secret')
    expect(wsCall!.headers['x-cdp-secret']).toBe('cdp-secret')
    expect(sock.accepted).toBe(true)
  })

  test('상태 읽기 실패(페이지 타깃 없음)는 502 BROWSER_STATE', async () => {
    const sock = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') {
        emit({ id: msg.id, result: { targetInfos: [] } })
      }
    })
    stubCdp(sock)
    const res = await app.request('/api/browse/state', {}, ENV as never)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ ok: false, error: 'BROWSER_STATE' })
  })
})

describe('GET /state — 사이드카 빠른 경로 + 직접 CDP 폴백 (2026-11-17 P0)', () => {
  const FAST_BODY = { ok: true, url: 'https://www.naver.com/', title: 'NAVER', canGoBack: true, canGoForward: false }

  /** /control/state는 빠른 응답을, /json/version·CDP WS는 FakeSocket 경로를 준다. */
  function stubFastThenCdp(sock: FakeSocket, stateResponse: () => Promise<unknown>): void {
    stubFetch(async (url) => {
      if (url.includes('/control/state')) return stateResponse()
      if (url.includes('/json/version')) return jsonResponse(VERSION_BODY)
      if (url.includes('/devtools/browser/')) return { webSocket: sock }
      throw new Error(`unexpected fetch: ${url}`)
    })
  }

  test('빠른 경로가 성공하면 /json/version·CDP WS를 부르지 않고 1회 fetch로 상태를 돌려준다', async () => {
    const sock = new FakeSocket(stateHandler)
    stubFastThenCdp(sock, async () => jsonResponse(FAST_BODY))
    const res = await app.request('/api/browse/state', {}, ENV as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      url: 'https://www.naver.com/',
      title: 'NAVER',
      canGoBack: true,
      canGoForward: false,
    })
    // 빠른 경로 1회만 나간다 — 직접 CDP 왕복이 없어야 한다.
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe(`https://${HOST}:8081/control/state`)
    expect(fetchCalls[0].method).toBe('GET')
    expect(fetchCalls[0].headers['x-origin-secret']).toBe('origin-secret')
    expect(fetchCalls[0].headers['x-cdp-secret']).toBe('cdp-secret')
    expect(sock.sent).toHaveLength(0)
    expect(sock.accepted).toBe(false)
  })

  test('구 사이드카(404)면 직접 CDP로 폴백해 상태를 돌려준다', async () => {
    const sock = new FakeSocket(stateHandler)
    stubFastThenCdp(sock, async () => new Response('{"error":"not_found"}', { status: 404 }))
    const res = await app.request('/api/browse/state', {}, ENV as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      url: 'https://news.naver.com/article/123',
      title: '뉴스 기사',
      canGoBack: true,
      canGoForward: true,
    })
    // 빠른 경로 시도 1회 + 폴백(/json/version + CDP WS) 2회.
    expect(fetchCalls.map((c) => c.url)).toEqual([
      `https://${HOST}:8081/control/state`,
      `https://${HOST}:8081/json/version`,
      `https://${HOST}:8081/devtools/browser/abc`,
    ])
    expect(sock.sent.map((m) => m.method)).toContain('Page.getNavigationHistory')
  })

  test('빠른 경로 fetch가 던지거나 응답이 깨져도 직접 CDP로 폴백한다', async () => {
    const sock = new FakeSocket(stateHandler)
    stubFastThenCdp(sock, async () => {
      throw new Error('unreachable')
    })
    const res = await app.request('/api/browse/state', {}, ENV as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      url: 'https://news.naver.com/article/123',
      title: '뉴스 기사',
      canGoBack: true,
      canGoForward: true,
    })

    const sock2 = new FakeSocket(stateHandler)
    stubFastThenCdp(sock2, async () => jsonResponse({ ok: true, url: 42, title: 'NAVER' }))
    const res2 = await app.request('/api/browse/state', {}, ENV as never)
    expect(res2.status).toBe(200)
    expect(await res2.json()).toEqual({
      ok: true,
      url: 'https://news.naver.com/article/123',
      title: '뉴스 기사',
      canGoBack: true,
      canGoForward: true,
    })
  })

  test('빠른 경로와 폴백이 둘 다 실패하면 502 BROWSER_STATE', async () => {
    const sock = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') {
        emit({ id: msg.id, result: { targetInfos: [] } })
      }
    })
    stubFastThenCdp(sock, async () => jsonResponse({ error: 'browser_state' }, 502))
    const res = await app.request('/api/browse/state', {}, ENV as never)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ ok: false, error: 'BROWSER_STATE' })
  })

  test('잠기면 빠른 경로를 부르기 전에 423이고, 잠금 검사는 한 번만 한다', async () => {
    const sock = new FakeSocket(stateHandler)
    stubFetch(async (url) => {
      if (url.includes('/unlock/status')) {
        return jsonResponse({ configured: true, unlocked: false })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const res = await app.request('/api/browse/state', {}, ENV_LOCKED as never)
    expect(res.status).toBe(423)
    expect(await res.json()).toEqual({ ok: false, error: 'BROWSER_LOCKED' })
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toContain('/unlock/status')
    expect(sock.sent).toHaveLength(0)
  })
})

describe('POST /back · POST /forward — 원격 뒤로/앞으로', () => {
  test('설정이 없으면 503이고 fetch를 부르지 않는다', async () => {
    stubFetch(async () => {
      throw new Error('must not be called')
    })
    for (const path of ['/api/browse/back', '/api/browse/forward']) {
      const res = await app.request(path, { method: 'POST' }, {} as never)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ ok: false, error: 'ORACLE_NOT_CONFIGURED' })
    }
    expect(fetchCalls).toHaveLength(0)
  })

  test('잠기면 423 BROWSER_LOCKED', async () => {
    const sock = new FakeSocket(historyHandler)
    stubCdp(sock, async (url) => {
      if (url.includes('/unlock/status')) {
        return jsonResponse({ configured: true, unlocked: false })
      }
      return null
    })
    const res = await app.request('/api/browse/back', { method: 'POST' }, ENV_LOCKED as never)
    expect(res.status).toBe(423)
    expect(await res.json()).toEqual({ ok: false, error: 'BROWSER_LOCKED' })
    expect(sock.sent).toHaveLength(0)
  })

  test('/back는 currentIndex-1 엔트리로 navigateToHistoryEntry를 보내고 200 + ok:true로 보고한다', async () => {
    const sock = new FakeSocket(historyHandler)
    stubCdp(sock)
    const res = await app.request('/api/browse/back', { method: 'POST' }, ENV as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, stage: 'ok' })
    const back = sock.sent.find((m) => m.method === 'Page.navigateToHistoryEntry')
    expect(back).toBeDefined()
    expect(back.params).toEqual({ entryId: 1 })
    expect(back.sessionId).toBe('sess-1')
    expect(sock.sent.find((m) => m.method === 'Page.goBack')).toBeUndefined()
  })

  test('/forward는 currentIndex+1 엔트리로 navigateToHistoryEntry를 보내고 200 + ok:true로 보고한다', async () => {
    const sock = new FakeSocket(historyHandler)
    stubCdp(sock)
    const res = await app.request('/api/browse/forward', { method: 'POST' }, ENV as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, stage: 'ok' })
    const fwd = sock.sent.find((m) => m.method === 'Page.navigateToHistoryEntry')
    expect(fwd).toBeDefined()
    expect(fwd.params).toEqual({ entryId: 3 })
    expect(fwd.sessionId).toBe('sess-1')
    expect(sock.sent.find((m) => m.method === 'Page.goForward')).toBeUndefined()
  })

  test('갈 곳이 없으면 200 + ok:false/stage=no-history로 보고한다', async () => {
    const sock = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') {
        emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'page-1' }] } })
      } else if (msg.method === 'Target.attachToTarget') {
        emit({ id: msg.id, result: { sessionId: 'sess-1' } })
      } else if (msg.method === 'Runtime.evaluate') {
        emit({ id: msg.id, result: { result: { type: 'string', value: 'visible' } } })
      } else if (msg.method === 'Page.getNavigationHistory') {
        emit({ id: msg.id, result: { currentIndex: 0, entries: [{ id: 1 }] } })
      }
    })
    stubCdp(sock)
    const res = await app.request('/api/browse/back', { method: 'POST' }, ENV as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, stage: 'no-history' })
  })

  test('CDP 실패는 200 + ok:false/stage로 보고한다', async () => {
    const sock = new FakeSocket((msg, emit) => {
      if (msg.method === 'Target.getTargets') {
        emit({ id: msg.id, result: { targetInfos: [{ type: 'page', targetId: 'page-1' }] } })
      } else if (msg.method === 'Target.attachToTarget') {
        emit({ id: msg.id, error: { message: 'nope' } })
      }
    })
    stubCdp(sock)
    const res = await app.request('/api/browse/back', { method: 'POST' }, ENV as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, stage: 'attach' })
  })
})

describe('POST /viewport — 사이드카 영구 override 경유 (2026-11-16 QA 12차)', () => {
  test('사이드카가 두 탭에 적용하면 applied=2, total=2, verified=2로 보고한다', async () => {
    let postedBody: unknown = null
    stubFetch(async (url, init) => {
      expect(url).toBe(`https://${HOST}:8081/control/viewport`)
      expect(init?.method).toBe('POST')
      postedBody = JSON.parse(String(init?.body ?? '{}'))
      return jsonResponse({ ok: true, applied: 2, total: 2, connected: true })
    })
    const res = await app.request(
      '/api/browse/viewport',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ viewport: { width: 1680, height: 967 } }),
      },
      ENV as never,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, stage: 'ok', applied: 2, total: 2, verified: 2 })
    expect(postedBody).toEqual({ width: 1680, height: 967 })
    // 시크릿 헤더가 사이드카로 나간다 (이중 게이트).
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].headers['x-origin-secret']).toBe('origin-secret')
    expect(fetchCalls[0].headers['x-cdp-secret']).toBe('cdp-secret')
  })

  test('사이드카가 CDP에 안 붙어 적용 0건이면 ok:false + stage=viewport', async () => {
    stubFetch(async () => jsonResponse({ ok: true, applied: 0, total: 0, connected: false }))
    const res = await app.request(
      '/api/browse/viewport',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ viewport: { width: 1680, height: 967 } }),
      },
      ENV as never,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, stage: 'viewport', applied: 0, total: 0, verified: 0 })
  })

  test('사이드카가 닿지 않으면 502 ORACLE_UPSTREAM', async () => {
    stubFetch(async () => {
      throw new Error('unreachable')
    })
    const res = await app.request(
      '/api/browse/viewport',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ viewport: { width: 1680, height: 967 } }),
      },
      ENV as never,
    )
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ ok: false, error: 'ORACLE_UPSTREAM' })
  })

  test('잘못된 뷰포트는 400 INVALID_VIEWPORT', async () => {
    stubFetch(async () => {
      throw new Error('must not be called')
    })
    const res = await app.request(
      '/api/browse/viewport',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ viewport: { width: 0, height: 100 } }),
      },
      ENV as never,
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: 'INVALID_VIEWPORT' })
    expect(fetchCalls).toHaveLength(0)
  })
})
