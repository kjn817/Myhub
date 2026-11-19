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
 * - 언록/버전 캐시 (2026-11-17 P1): /state 폴링은 언록 조회 1왕복 +
 *   상태 조회 1왕복이었으나 언록 상태를 30초 캐시해 1왕복으로 줄인다.
 *   언록/셋업 POST 성공 시 캐시를 즉시 무효화한다 ("풀었는데 계속
 *   423"이 없어야 한다). /json/version도 60초 캐시하고, 낡은 WS URL로
 *   'connect' 실패가 나면 캐시를 버리고 한 번만 재시도한다.
 * 네트워크 경계는 전역 fetch 목킹이다 (실 Oracle 연결은 하지 않는다).
 * 카나리아: 시크릿 주입·잠금 게이트·CDP 메서드·응답 모양을 깨면
 * 해당 테스트가 실패한다.
 */
import { Hono } from 'hono'
import { browseApp } from '../../src/modules/browse/routes'
import { invalidateDirectCdpWsUrlCache } from '../../src/modules/browse/oracle-proxy'
import { invalidateUnlockStatusCache } from '../../src/modules/browse/unlock'

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

beforeEach(() => {
  // 모듈 단위 캐시(언록 상태·CDP WS URL)가 테스트 간에 새지 않게 한다.
  invalidateUnlockStatusCache()
  invalidateDirectCdpWsUrlCache()
})

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
    // 병합 프로브 식(visibility·url·title)에는 한 번에 답한다.
    // 별도 URL 읽기 식(프로브 폴백)이 오면 URL JSON으로 답한다.
    if (String(msg.params?.expression ?? '').includes('visibilityState')) {
      emit({
        id: msg.id,
        result: {
          result: {
            type: 'string',
            value: JSON.stringify({ visibility: 'visible', url: 'https://news.naver.com/article/123', title: '뉴스 기사' }),
          },
        },
      })
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
    // 활성 탭 식별용 프로브 평가에 visible로 답한다 (무응답이면
    // 타깃당 1.5초 제한까지 기다려 테스트가 느려진다).
    emit({
      id: msg.id,
      result: {
        result: {
          type: 'string',
          value: JSON.stringify({ visibility: 'visible', url: 'https://example.com', title: 't' }),
        },
      },
    })
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

describe('GET /state — 언록 상태 캐시 (2026-11-17 P1)', () => {
  const FAST_BODY = { ok: true, url: 'https://www.naver.com/', title: 'NAVER', canGoBack: true, canGoForward: false }

  test('두 번째 /state부터 언록 조회를 안 한다 — 전체가 1회 fetch가 된다', async () => {
    stubFetch(async (url) => {
      if (url.includes('/unlock/status')) {
        return jsonResponse({ configured: true, unlocked: true })
      }
      if (url.includes('/control/state')) return jsonResponse(FAST_BODY)
      throw new Error(`unexpected fetch: ${url}`)
    })
    // 첫 호출: 언록 조회 + 상태 조회 2회 (캐시가 비어 있다).
    let res = await app.request('/api/browse/state', {}, ENV_LOCKED as never)
    expect(res.status).toBe(200)
    expect(fetchCalls.map((c) => c.url)).toEqual([
      `https://${HOST}:8080/unlock/status`,
      `https://${HOST}:8081/control/state`,
    ])
    // 두 번째 호출: 상태 조회만 1회 — 언록 조회 1왕복이 사라진다.
    const before = fetchCalls.length
    res = await app.request('/api/browse/state', {}, ENV_LOCKED as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      url: 'https://www.naver.com/',
      title: 'NAVER',
      canGoBack: true,
      canGoForward: false,
    })
    expect(fetchCalls.slice(before).map((c) => c.url)).toEqual([
      `https://${HOST}:8081/control/state`,
    ])
  })

  test('언록 POST 성공 후에는 잠금 캐시가 풀려 /state가 200을 돌려준다', async () => {
    let locked = true
    stubFetch(async (url) => {
      if (url.includes('/unlock/status')) {
        return jsonResponse({ configured: true, unlocked: !locked })
      }
      if (url.includes('/unlock/unlock')) {
        locked = false
        return jsonResponse({ ok: true, unlocked: true })
      }
      if (url.includes('/control/state')) return jsonResponse(FAST_BODY)
      throw new Error(`unexpected fetch: ${url}`)
    })
    // 잠긴 상태로 /state → 423 (잠금 결과가 캐시된다).
    let res = await app.request('/api/browse/state', {}, ENV_LOCKED as never)
    expect(res.status).toBe(423)
    // 언록 POST 성공 — 캐시 무효화가 안 되면 다음 /state가 423이다.
    res = await app.request(
      '/api/browse/unlock/unlock',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'correct-horse-1' }),
      },
      ENV_LOCKED as never,
    )
    expect(res.status).toBe(200)
    res = await app.request('/api/browse/state', {}, ENV_LOCKED as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      url: 'https://www.naver.com/',
      title: 'NAVER',
      canGoBack: true,
      canGoForward: false,
    })
  })

  test('TTL(30초)이 지나면 언록 상태를 다시 조회한다', async () => {
    jest.useFakeTimers()
    try {
      stubFetch(async (url) => {
        if (url.includes('/unlock/status')) {
          return jsonResponse({ configured: true, unlocked: true })
        }
        if (url.includes('/control/state')) return jsonResponse(FAST_BODY)
        throw new Error(`unexpected fetch: ${url}`)
      })
      const unlockCalls = () => fetchCalls.filter((c) => c.url.includes('/unlock/status')).length
      let res = await app.request('/api/browse/state', {}, ENV_LOCKED as never)
      expect(res.status).toBe(200)
      expect(unlockCalls()).toBe(1)
      // TTL 안에서는 다시 안 묻는다.
      jest.advanceTimersByTime(29_000)
      res = await app.request('/api/browse/state', {}, ENV_LOCKED as never)
      expect(res.status).toBe(200)
      expect(unlockCalls()).toBe(1)
      // TTL이 지나면 다시 묻는다 (재부팅 같은 Worker 밖 변경을 묶는다).
      jest.advanceTimersByTime(2_000)
      res = await app.request('/api/browse/state', {}, ENV_LOCKED as never)
      expect(res.status).toBe(200)
      expect(unlockCalls()).toBe(2)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('POST /back — 버전 캐시 + connect 재시도 (2026-11-17 P1)', () => {
  test('/back을 두 번 부르면 /json/version은 한 번만 나간다', async () => {
    stubFetch(async (url) => {
      if (url.includes('/json/version')) return jsonResponse(VERSION_BODY)
      if (url.includes('/devtools/browser/')) return { webSocket: new FakeSocket(historyHandler) }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const versionCalls = () => fetchCalls.filter((c) => c.url.includes('/json/version')).length
    let res = await app.request('/api/browse/back', { method: 'POST' }, ENV as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, stage: 'ok' })
    expect(versionCalls()).toBe(1)
    res = await app.request('/api/browse/back', { method: 'POST' }, ENV as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, stage: 'ok' })
    expect(versionCalls()).toBe(1)
  })

  test('낡은 버전으로 connect가 실패하면 버전을 다시 읽어 재시도해 성공한다', async () => {
    let wsAttempts = 0
    stubFetch(async (url) => {
      if (url.includes('/json/version')) return jsonResponse(VERSION_BODY)
      if (url.includes('/devtools/browser/')) {
        wsAttempts += 1
        // 첫 시도는 webSocket 없음(낡은 엔드포인트) → connect 실패,
        // 재시도는 정상 소켓을 돌려준다.
        if (wsAttempts === 1) return new Response('{}', { status: 200 })
        return { webSocket: new FakeSocket(historyHandler) }
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const res = await app.request('/api/browse/back', { method: 'POST' }, ENV as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, stage: 'ok' })
    // 버전은 초기 1회 + 재시도 1회 = 2회, WS 시도도 2회.
    expect(fetchCalls.filter((c) => c.url.includes('/json/version'))).toHaveLength(2)
    expect(wsAttempts).toBe(2)
  })

  test('재시도해도 connect가 실패하면 stage=connect로 보고한다 (재시도는 1회뿐)', async () => {
    stubFetch(async (url) => {
      if (url.includes('/json/version')) return jsonResponse(VERSION_BODY)
      if (url.includes('/devtools/browser/')) return new Response('{}', { status: 200 })
      throw new Error(`unexpected fetch: ${url}`)
    })
    const res = await app.request('/api/browse/back', { method: 'POST' }, ENV as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, stage: 'connect' })
    // 버전 2회(초기+재시도), WS 2회 — 무한 재시도가 아니다.
    expect(fetchCalls.filter((c) => c.url.includes('/json/version'))).toHaveLength(2)
    expect(fetchCalls.filter((c) => c.url.includes('/devtools/browser/'))).toHaveLength(2)
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
        emit({
          id: msg.id,
          result: {
            result: {
              type: 'string',
              value: JSON.stringify({ visibility: 'visible', url: 'https://example.com', title: 't' }),
            },
          },
        })
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
    // dpr이 없으면 기본 1.0이 실린다 (구 프론트 호환).
    expect(postedBody).toEqual({ width: 1680, height: 967, dpr: 1 })
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

  test('dpr: 2면 사이드카에 dpr이 그대로 전달된다 (2026-11-19 맥 레티나)', async () => {
    let postedBody: unknown = null
    stubFetch(async (url, init) => {
      postedBody = JSON.parse(String(init?.body ?? '{}'))
      return jsonResponse({ ok: true, applied: 1, total: 1, connected: true })
    })
    const res = await app.request(
      '/api/browse/viewport',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ viewport: { width: 1470, height: 847, dpr: 2 } }),
      },
      ENV as never,
    )
    expect(res.status).toBe(200)
    expect(postedBody).toEqual({ width: 1470, height: 847, dpr: 2 })
  })

  test('비정상 dpr은 1.0으로 두고 뷰포트 전체를 버리지 않는다', async () => {
    let postedBody: unknown = null
    stubFetch(async (url, init) => {
      postedBody = JSON.parse(String(init?.body ?? '{}'))
      return jsonResponse({ ok: true, applied: 1, total: 1, connected: true })
    })
    const res = await app.request(
      '/api/browse/viewport',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ viewport: { width: 1470, height: 847, dpr: 99 } }),
      },
      ENV as never,
    )
    expect(res.status).toBe(200)
    expect(postedBody).toEqual({ width: 1470, height: 847, dpr: 1 })
  })
})

describe('POST /mouse-offset — 사이드카 중계 + dpr (2026-11-19)', () => {
  // 프론트는 디바이스 px + dpr을 보낸다. dpr이 있으면 사이드카가 이미
  // 디바이스 px인 줄 알고 그대로 쓰고, 없으면(구 프론트·수동) CSS px로
  // 보고 배운 DPR로 변환한다. Worker는 dpr을 검증만 하고 중계한다.
  test('dpr이 있으면 그대로 중계한다', async () => {
    let postedBody: unknown = null
    let postedUrl: unknown = null
    stubFetch(async (url, init) => {
      postedUrl = url
      postedBody = JSON.parse(String(init?.body ?? '{}'))
      return jsonResponse({ ok: true, offset: { x: 0, y: 132 } })
    })
    const res = await app.request(
      '/api/browse/mouse-offset',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ x: 0, y: 132, dpr: 2 }),
      },
      ENV as never,
    )
    expect(res.status).toBe(200)
    expect(postedUrl).toBe(`https://${HOST}:8080/control/mouse-offset`)
    expect(postedBody).toEqual({ x: 0, y: 132, dpr: 2 })
  })

  test('dpr이 없으면 dpr 키 없이 중계한다 (사이드카가 CSS px로 본다)', async () => {
    let postedBody: unknown = null
    stubFetch(async (url, init) => {
      postedBody = JSON.parse(String(init?.body ?? '{}'))
      return jsonResponse({ ok: true, offset: { x: 0, y: 66 } })
    })
    const res = await app.request(
      '/api/browse/mouse-offset',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ x: 0, y: 66 }),
      },
      ENV as never,
    )
    expect(res.status).toBe(200)
    expect(postedBody).toEqual({ x: 0, y: 66 })
  })

  test('비정상 dpr은 빼고 중계한다', async () => {
    let postedBody: unknown = null
    stubFetch(async (url, init) => {
      postedBody = JSON.parse(String(init?.body ?? '{}'))
      return jsonResponse({ ok: true, offset: { x: 0, y: 66 } })
    })
    const res = await app.request(
      '/api/browse/mouse-offset',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ x: 0, y: 66, dpr: 99 }),
      },
      ENV as never,
    )
    expect(res.status).toBe(200)
    expect(postedBody).toEqual({ x: 0, y: 66 })
  })

  test('잘못된 오프셋은 400 INVALID_OFFSET', async () => {
    stubFetch(async () => {
      throw new Error('must not be called')
    })
    const res = await app.request(
      '/api/browse/mouse-offset',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ x: -1, y: 66 }),
      },
      ENV as never,
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: 'INVALID_OFFSET' })
    expect(fetchCalls).toHaveLength(0)
  })
})
