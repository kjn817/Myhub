/// <reference types="jest" />
/**
 * src/modules/browse/live.ts (+ routes.ts 결선) — Live 세션 발급 성질 테스트 (C3).
 *
 * 고정하는 성질:
 * - 응답 탐색: View URL은 중첩 구조 어디에 있어도 찾고, WebSocket URL은
 *   최상위(top)를 우선하되 없으면 page 타입 타깃을 고른다.
 * - 세션 게이트: 토큰이 없으면 503, 동시 세션이 살아 있으면 409와 남은
 *   시간이 돌아오고, 위쪽(Cloudflare) 429/5xx는 각각 429/502로 구분된다.
 * - 성공 시 viewUrl에는 mode=tab이 보장되고(기존 mode는 교체), KV에
 *   만료가 있는 단일 세션 기록이 남는다. 시작 URL이 있으면 내비게이션을
 *   시도하고 그 결과(nav/navStage/navSource)를 숨기지 않고 보고한다.
 * - 종료(DELETE)는 위쪽 세션 종료를 시도하고 KV 기록을 항상 지운다.
 * 네트워크 경계는 전역 fetch 목킹이다 (실 Browser Run 연결은 하지 않는다).
 * 카나리아: mode=tab 변환이나 BUSY 게이트를 깨면 해당 테스트가 실패한다.
 */
import { browseApp } from '../../src/modules/browse/routes'
import { findLiveViewUrl, findWebSocketDebuggerUrl } from '../../src/modules/browse/live'

class FakeKV {
  store = new Map<string, string>()
  puts: Array<{ key: string; value: string; ttl?: number }> = []
  deletes: string[] = []
  async get(key: string, type?: string): Promise<unknown> {
    const v = this.store.get(key)
    if (v === undefined) return null
    return type === 'json' ? JSON.parse(v) : v
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.puts.push({ key, value, ttl: opts?.expirationTtl })
    this.store.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.deletes.push(key)
    this.store.delete(key)
  }
}

const VIEW = 'https://live.browser.run/ui/view/sess-xyz'
const realFetch = global.fetch
let fetchCalls: Array<{ url: string; method: string }> = []

function stubFetch(handler: (url: string, init?: { method?: string }) => Promise<unknown>): void {
  fetchCalls = []
  global.fetch = (async (url: unknown, init?: { method?: string }) => {
    fetchCalls.push({ url: String(url), method: init?.method ?? 'GET' })
    return handler(String(url), init)
  }) as typeof fetch
}

afterEach(() => {
  global.fetch = realFetch
})

function envOf(kv: FakeKV, extra: Record<string, unknown> = {}) {
  return { KV: kv, BROWSER_RUN_TOKEN: 'br-token', ...extra } as never
}

async function postLive(env: never, body?: unknown) {
  const init: RequestInit = { method: 'POST' }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await browseApp.request('/live-session', init, env)
  return { status: res.status, json: (await res.json()) as any }
}

const upstreamOk = (data: unknown) => async () => ({ ok: true, status: 200, json: async () => data })

describe('findLiveViewUrl — 중첩 탐색', () => {
  test('마커를 포함한 문자열만 찾고, 배열·객체를 깊이 탐색한다', () => {
    expect(findLiveViewUrl(VIEW)).toBe(VIEW)
    expect(findLiveViewUrl('https://example.com/other')).toBeNull()
    expect(findLiveViewUrl({ a: [{ b: 'x' }, { c: VIEW }] })).toBe(VIEW)
    expect(findLiveViewUrl({ a: 1, b: null })).toBeNull()
    expect(findLiveViewUrl(null)).toBeNull()
    expect(findLiveViewUrl(42)).toBeNull()
    expect(findLiveViewUrl([VIEW, 'https://live.browser.run/ui/view/other'])).toBe(VIEW)
    expect(findLiveViewUrl(['x', { a: 1 }, [null, 3]])).toBeNull()
  })
})

describe('findWebSocketDebuggerUrl — 우선순위', () => {
  test('최상위 URL이 있으면 source=top', () => {
    expect(findWebSocketDebuggerUrl({ webSocketDebuggerUrl: 'wss://top', targets: [{ webSocketDebuggerUrl: 'wss://t', type: 'page' }] }))
      .toEqual({ url: 'wss://top', source: 'top' })
  })
  test('최상위가 없으면 page 타입을, 없으면 첫 후보를 고른다', () => {
    const data = { result: { targets: [
      { webSocketDebuggerUrl: 'wss://worker', type: 'service_worker' },
      { webSocketDebuggerUrl: 'wss://page', type: 'page' },
    ] } }
    expect(findWebSocketDebuggerUrl(data)).toEqual({ url: 'wss://page', source: 'target' })
    const noPage = { result: { targets: [{ webSocketDebuggerUrl: 'wss://only', type: 'browser' }] } }
    expect(findWebSocketDebuggerUrl(noPage)).toEqual({ url: 'wss://only', source: 'target' })
  })
  test('없거나 비어 있으면 null', () => {
    expect(findWebSocketDebuggerUrl(null)).toBeNull()
    expect(findWebSocketDebuggerUrl('wss://x')).toBeNull()
    expect(findWebSocketDebuggerUrl({ webSocketDebuggerUrl: '' })).toBeNull()
    expect(findWebSocketDebuggerUrl({ a: [1, 2] })).toBeNull()
  })
})

describe('POST /live-session — 게이트와 오류 구분', () => {
  test('토큰이 없으면 503 LIVE_NOT_CONFIGURED이고 fetch를 부르지 않는다', async () => {
    stubFetch(async () => { throw new Error('must not be called') })
    const kv = new FakeKV()
    const r = await postLive({ KV: kv } as never, {})
    expect(r.status).toBe(503)
    expect(r.json.error).toBe('LIVE_NOT_CONFIGURED')
    expect(fetchCalls).toHaveLength(0)
  })

  test('잘못된 시작 URL은 400 INVALID_URL (파싱 실패·비http·과길이·비문자열)', async () => {
    stubFetch(upstreamOk({}))
    const kv = new FakeKV()
    for (const url of ['not a url', 'ftp://example.com', 'x'.repeat(2050), 42]) {
      const r = await postLive(envOf(kv), { url })
      expect(r.status).toBe(400)
      expect(r.json.error).toBe('INVALID_URL')
    }
    expect(fetchCalls).toHaveLength(0)
  })

  test('살아 있는 세션이 있으면 409 LIVE_BUSY와 양의 retryAfterSec', async () => {
    stubFetch(upstreamOk({}))
    const kv = new FakeKV()
    const exp = Math.floor(Date.now() / 1000) + 90
    kv.store.set('browse:live:current', JSON.stringify({ sid: 'old', exp }))
    const r = await postLive(envOf(kv), {})
    expect(r.status).toBe(409)
    expect(r.json.error).toBe('LIVE_BUSY')
    expect(r.json.retryAfterSec).toBeGreaterThan(0)
    expect(r.json.retryAfterSec).toBeLessThanOrEqual(90)
    expect(fetchCalls).toHaveLength(0)
  })

  test('만료된 기록은 BUSY가 아니고 새 세션을 발급한다', async () => {
    stubFetch(upstreamOk({ sessionId: 'new-1', view: VIEW }))
    const kv = new FakeKV()
    kv.store.set('browse:live:current', JSON.stringify({ sid: 'old', exp: Math.floor(Date.now() / 1000) - 10 }))
    const r = await postLive(envOf(kv), {})
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
  })

  test('위쪽 429는 429 LIVE_QUOTA, 5xx와 네트워크 예외는 502 LIVE_UPSTREAM', async () => {
    const kv = new FakeKV()
    stubFetch(async () => ({ ok: false, status: 429, json: async () => ({}) }))
    let r = await postLive(envOf(kv), {})
    expect(r.status).toBe(429)
    expect(r.json.error).toBe('LIVE_QUOTA')
    stubFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    r = await postLive(envOf(kv), {})
    expect(r.status).toBe(502)
    expect(r.json.error).toBe('LIVE_UPSTREAM')
    stubFetch(async () => { throw new Error('net down') })
    r = await postLive(envOf(kv), {})
    expect(r.status).toBe(502)
    expect(r.json.error).toBe('LIVE_UPSTREAM')
  })

  test('응답에 viewUrl이나 sessionId가 없으면 502로 정직하게 실패한다', async () => {
    const kv = new FakeKV()
    stubFetch(upstreamOk({ sessionId: 's1' }))
    let r = await postLive(envOf(kv), {})
    expect(r.status).toBe(502)
    stubFetch(upstreamOk({ view: VIEW }))
    r = await postLive(envOf(kv), {})
    expect(r.status).toBe(502)
    expect(kv.puts).toHaveLength(0)
  })
})

describe('POST /live-session — 성공 계약', () => {
  test('viewUrl에 mode=tab이 붙고 KV에 TTL·만료 기록이 남으며 nav는 skip이다', async () => {
    stubFetch(upstreamOk({ sessionId: 'sess-1', view: VIEW }))
    const kv = new FakeKV()
    const before = Math.floor(Date.now() / 1000)
    const r = await postLive(envOf(kv), {})
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.viewUrl).toBe(`${VIEW}?mode=tab`)
    expect(r.json.nav).toBe('skip')
    expect(r.json.expiresAt).toBeGreaterThanOrEqual((before + 120) * 1000)
    expect(r.json.expiresAt).toBeLessThanOrEqual((before + 121) * 1000)
    expect(kv.puts).toHaveLength(1)
    expect(kv.puts[0].key).toBe('browse:live:current')
    expect(kv.puts[0].ttl).toBe(180)
    const record = JSON.parse(kv.puts[0].value) as { sid: string; exp: number }
    expect(record.sid).toBe('sess-1')
    expect(record.exp * 1000).toBe(r.json.expiresAt)
    const sent = fetchCalls[0]
    expect(sent.url).toContain('keep_alive=120000')
    expect(sent.url).toContain('targets=true')
    expect(sent.method).toBe('POST')
  })

  test('기존 쿼리의 mode는 tab으로 교체되고 다른 파라미터는 유지된다', async () => {
    stubFetch(upstreamOk({ sessionId: 's', view: `${VIEW}?mode=full&foo=bar` }))
    const kv = new FakeKV()
    const r = await postLive(envOf(kv), {})
    expect(r.json.viewUrl).toBe(`${VIEW}?mode=tab&foo=bar`)
  })

  test('시작 URL이 있고 ws 엔드포인트가 없으면 nav=no-ws로 보고한다', async () => {
    stubFetch(upstreamOk({ sessionId: 's', view: VIEW }))
    const kv = new FakeKV()
    const r = await postLive(envOf(kv), { url: 'https://example.com/start' })
    expect(r.status).toBe(200)
    expect(r.json.nav).toBe('no-ws')
    expect(r.json.navStage).toBe('no-ws')
    expect(r.json.navSource).toBeNull()
  })

  test('시작 URL과 ws 엔드포인트가 있으면 내비게이션을 시도하고 실패를 숨기지 않는다', async () => {
    // 전역 fetch가 업그레이드 응답(webSocket 없음)을 주면 기본 CDP 연결은
    // null이 되어 nav=fail/stage=connect가 된다 — 실제 연결 경계의 정직한 실패.
    stubFetch(async (url) => {
      if (url.includes('/browser-rendering/')) return { ok: true, status: 200, json: async () => ({ sessionId: 's', view: VIEW, webSocketDebuggerUrl: 'wss://dbg.example/ws' }) }
      return { ok: true, status: 200, json: async () => ({}) }
    })
    const kv = new FakeKV()
    const r = await postLive(envOf(kv), { url: 'https://example.com/start' })
    expect(r.status).toBe(200)
    expect(r.json.nav).toBe('fail')
    expect(r.json.navStage).toBe('connect')
    expect(r.json.navSource).toBe('top')
  })
})

describe('DELETE /live-session', () => {
  test('기록이 있으면 위쪽 세션 종료를 호출하고 KV를 비운다', async () => {
    stubFetch(async () => ({ ok: true, status: 204, json: async () => null }))
    const kv = new FakeKV()
    kv.store.set('browse:live:current', JSON.stringify({ sid: 'sess 9', exp: 9999999999 }))
    const res = await browseApp.request('/live-session', { method: 'DELETE' }, envOf(kv))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].method).toBe('DELETE')
    expect(fetchCalls[0].url).toContain('/sess%209')
    expect(kv.store.has('browse:live:current')).toBe(false)
  })

  test('기록이 없으면 fetch 없이 ok, 종료 fetch가 실패해도 KV는 비운다', async () => {
    stubFetch(async () => { throw new Error('down') })
    const kv = new FakeKV()
    let res = await browseApp.request('/live-session', { method: 'DELETE' }, envOf(kv))
    expect(res.status).toBe(200)
    expect(fetchCalls).toHaveLength(0)
    kv.store.set('browse:live:current', JSON.stringify({ sid: 's1', exp: 1 }))
    res = await browseApp.request('/live-session', { method: 'DELETE' }, envOf(kv))
    expect(res.status).toBe(200)
    expect(kv.store.has('browse:live:current')).toBe(false)
  })

  test('토큰이 없으면 위쪽 종료를 건너뛰지만 KV는 비운다', async () => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }))
    const kv = new FakeKV()
    kv.store.set('browse:live:current', JSON.stringify({ sid: 's1', exp: 1 }))
    const res = await browseApp.request('/live-session', { method: 'DELETE' }, { KV: kv } as never)
    expect(res.status).toBe(200)
    expect(fetchCalls).toHaveLength(0)
    expect(kv.store.has('browse:live:current')).toBe(false)
  })
})
