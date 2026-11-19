/// <reference types="jest" />
/**
 * 새 창→새 탭 — Worker 라우트 (2026-11-19).
 *
 * 고정하는 성질:
 * - GET /api/browse/state 빠른 경로: 사이드카 /control/state의 tabs·
 *   activeTargetId·mainTargetId를 그대로 통과시킨다. 깨진 탭 항목은
 *   버리고 목록은 살린다 (하나 깨졌다고 동기화 전체가 멈추면 안 된다).
 * - 폴백(직접 CDP) 경로는 tabs 필드를 아예 내지 않는다 — 셸은 필드가
 *   없을 때 탭 동기화를 건드리지 않으므로, 폴백이 팝업 탭을 지우는
 *   일이 없다.
 * - POST /api/browse/tab/activate|close: 사이드카 /control/tab/*으로
 *   중계한다 (URL·메서드·본문·시크릿 헤더). targetId 없으면 400,
 *   설정 없으면 503, 사이드카가 닿지 않으면 502.
 * 카나리아: 통과·생략·중계를 빼면 해당 테스트가 실패한다.
 */
import { Hono } from 'hono'
import { browseApp } from '../../src/modules/browse/routes'
import { fetchSidecarBrowserState } from '../../src/modules/browse/cdp'
import { invalidateDirectCdpWsUrlCache } from '../../src/modules/browse/oracle-proxy'
import { invalidateUnlockStatusCache } from '../../src/modules/browse/unlock'

const app = new Hono()
app.route('/api/browse', browseApp)

const HOST = '203.0.113.7'
const ENV = {
  ORACLE_BROWSER_HOST: HOST,
  ORIGIN_SECRET: 'origin-secret-16',
  CDP_SECRET: 'test-cdp-secret-16',
  SELKIES_PASSWORD: 'testpass',
}

const realFetch = global.fetch
interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
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
    fetchCalls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    })
    return handler(String(url), init)
  }) as typeof fetch
}

beforeEach(() => {
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

const SIDECAR_STATE = {
  ok: true,
  url: 'https://www.naver.com/',
  title: 'NAVER',
  canGoBack: true,
  canGoForward: false,
  tabs: [
    { targetId: 'page-1', url: 'https://www.naver.com/', title: 'NAVER', openerId: null },
    { targetId: 'page-2', url: 'https://news.naver.com/article/123', title: '뉴스 기사', openerId: 'page-1' },
  ],
  activeTargetId: 'page-1',
  mainTargetId: 'page-1',
}

describe('GET /api/browse/state — 탭 목록 통과', () => {
  test('빠른 경로가 tabs·activeTargetId·mainTargetId를 그대로 돌려준다', async () => {
    stubFetch(async (url) => {
      if (url.includes('/control/state')) return jsonResponse(SIDECAR_STATE)
      throw new Error(`unexpected fetch: ${url}`)
    })
    const res = await app.request('/api/browse/state', { method: 'GET' }, ENV as never)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.tabs).toEqual(SIDECAR_STATE.tabs)
    expect(body.activeTargetId).toBe('page-1')
    expect(body.mainTargetId).toBe('page-1')
  })

  test('깨진 탭 항목은 버리고 목록은 살린다', async () => {
    const broken = {
      ...SIDECAR_STATE,
      tabs: [
        { targetId: 'page-1', url: 'https://www.naver.com/', title: 'NAVER', openerId: null },
        { targetId: 42, url: 'https://x.test/', title: '깨짐', openerId: null },
        { url: 'https://y.test/', title: 'id 없음', openerId: null },
        '문자열 항목',
      ],
    }
    const parsed = await fetchSidecarBrowserState(
      'https://example.test/control/state',
      {},
      (async () => jsonResponse(broken)) as never,
    )
    expect(parsed).not.toBeNull()
    expect(parsed!.tabs).toEqual([broken.tabs[0]])
  })

  test('폴백(직접 CDP) 경로는 tabs 필드를 내지 않는다', async () => {
    // /control/state가 404(구 사이드카)면 직접 CDP로 폴백한다.
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
              value: JSON.stringify({
                visibility: 'visible',
                url: 'https://www.naver.com/',
                title: 'NAVER',
              }),
            },
          },
        })
      } else if (msg.method === 'Page.getNavigationHistory') {
        emit({ id: msg.id, result: { currentIndex: 0, entries: [{ id: 1 }] } })
      }
    })
    stubFetch(async (url) => {
      if (url.includes('/control/state')) return jsonResponse({ error: 'not_found' }, 404)
      if (url.includes('/json/version')) {
        return jsonResponse({
          webSocketDebuggerUrl: 'wss://myhub.myhub-app.workers.dev/api/browse/cdp/devtools/browser/abc',
        })
      }
      if (url.includes('/devtools/browser/')) return { webSocket: sock }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const res = await app.request('/api/browse/state', { method: 'GET' }, ENV as never)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.url).toBe('https://www.naver.com/')
    expect('tabs' in body).toBe(false)
    expect('activeTargetId' in body).toBe(false)
    expect('mainTargetId' in body).toBe(false)
  })
})

describe('POST /api/browse/tab/activate|close', () => {
  test('activate가 사이드카 /control/tab/activate로 중계된다', async () => {
    stubFetch(async (url) => {
      if (url.includes('/control/tab/activate')) return jsonResponse({ ok: true })
      throw new Error(`unexpected fetch: ${url}`)
    })
    const res = await app.request(
      '/api/browse/tab/activate',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetId: 'page-2' }),
      },
      ENV as never,
    )
    expect(res.status).toBe(200)
    expect((await res.json()) as unknown).toEqual({ ok: true })
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe(`https://${HOST}:8081/control/tab/activate`)
    expect(fetchCalls[0].method).toBe('POST')
    expect(fetchCalls[0].body).toBe(JSON.stringify({ targetId: 'page-2' }))
    expect(fetchCalls[0].headers['x-origin-secret']).toBe('origin-secret-16')
    expect(fetchCalls[0].headers['x-cdp-secret']).toBe('test-cdp-secret-16')
  })

  test('close가 사이드카 /control/tab/close로 중계된다', async () => {
    stubFetch(async (url) => {
      if (url.includes('/control/tab/close')) return jsonResponse({ ok: true })
      throw new Error(`unexpected fetch: ${url}`)
    })
    const res = await app.request(
      '/api/browse/tab/close',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetId: 'page-2' }),
      },
      ENV as never,
    )
    expect(res.status).toBe(200)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe(`https://${HOST}:8081/control/tab/close`)
  })

  test('targetId 없으면 400, 사이드카가 안 닿으면 502, 설정 없으면 503', async () => {
    stubFetch(async () => {
      throw new Error('unreachable')
    })
    const bad = await app.request(
      '/api/browse/tab/activate',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
      ENV as never,
    )
    expect(bad.status).toBe(400)
    const badType = await app.request(
      '/api/browse/tab/close',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetId: 42 }),
      },
      ENV as never,
    )
    expect(badType.status).toBe(400)
    const upstream = await app.request(
      '/api/browse/tab/activate',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetId: 'page-2' }),
      },
      ENV as never,
    )
    expect(upstream.status).toBe(502)
    const noCfg = await app.request(
      '/api/browse/tab/activate',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetId: 'page-2' }),
      },
      {} as never,
    )
    expect(noCfg.status).toBe(503)
  })
})

type Listener = (ev: { data: unknown }) => void

class FakeSocket {
  sent: Array<Record<string, any>> = []
  closed = false
  accepted = false
  private listeners: Listener[] = []
  constructor(private handler: (msg: Record<string, any>, emit: (m: unknown) => void) => void) {}
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
  addEventListener(_type: string, listener: Listener): void {
    this.listeners.push(listener)
  }
  close(): void {
    this.closed = true
  }
  accept(): void {
    this.accepted = true
  }
}
