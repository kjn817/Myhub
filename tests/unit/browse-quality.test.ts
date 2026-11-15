/// <reference types="jest" />
/**
 * POST /api/browse/quality — 화질 수동 전환 (2026-11-15, 원격 브라우저
 * 성능 개선: 사이드카 적응 제어의 수동 오버라이드 경로).
 *
 * 고정하는 성질:
 * - 오라클 설정이 없으면 503 ORACLE_NOT_CONFIGURED이고 fetch를 부르지 않는다.
 * - { bitrate }는 500~8000 정수만 받는다 (범위 밖·비숫자·소수는 400
 *   INVALID_QUALITY, fetch 없음). 소수 입력은 반올림해 보낸다.
 * - { mode: 'auto' }만 자동 복귀를 뜻한다. mode와 bitrate를 함께 주거나
 *   mode가 다른 값이면 400이다. 본문이 JSON이 아니면 400이다.
 * - 유효한 요청은 사이드카 /control/quality로 가고 x-origin-secret을
 *   주입한다. 사이드카 응답(상태·본문)이 그대로 돌아온다.
 * - 업스트림 예외는 502 ORACLE_UPSTREAM.
 * 네트워크 경계는 전역 fetch 목킹이다 (실 Oracle 연결은 하지 않는다).
 * 카나리아: 범위 검증·시크릿 주입·중계를 깨면 해당 테스트가 실패한다.
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
const ENV_NO_ORACLE = {}

const realFetch = global.fetch
interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
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
    fetchCalls.push({ url: String(url), method: init?.method ?? 'GET', headers, body: init?.body })
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

async function postQuality(env: Record<string, string>, body: unknown, rawBody?: string): Promise<Response> {
  return await app.request(
    '/api/browse/quality',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody !== undefined ? rawBody : JSON.stringify(body),
    },
    env as never,
  )
}

describe('POST /api/browse/quality', () => {
  test('오라클 미설정 시 503이고 fetch를 부르지 않는다', async () => {
    stubFetch(async () => jsonResponse({ ok: true }))
    const res = await postQuality(ENV_NO_ORACLE, { bitrate: 1800 })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, error: 'ORACLE_NOT_CONFIGURED' })
    expect(fetchCalls).toHaveLength(0)
  })

  test('유효한 bitrate는 사이드카로 중계되고 시크릿이 주입된다', async () => {
    stubFetch(async () => jsonResponse({ ok: true, mode: 'manual', bitrate: 1800, connections: 1 }))
    const res = await postQuality(ENV, { bitrate: 1800 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, mode: 'manual', bitrate: 1800, connections: 1 })
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe(`https://${HOST}:8080/control/quality`)
    expect(fetchCalls[0].method).toBe('POST')
    expect(fetchCalls[0].headers['x-origin-secret']).toBe('origin-secret')
    expect(JSON.parse(fetchCalls[0].body as string)).toEqual({ bitrate: 1800 })
  })

  test('소수 bitrate는 반올림해 보낸다', async () => {
    stubFetch(async () => jsonResponse({ ok: true }))
    const res = await postQuality(ENV, { bitrate: 1800.6 })
    expect(res.status).toBe(200)
    expect(JSON.parse(fetchCalls[0].body as string)).toEqual({ bitrate: 1801 })
  })

  test('범위 밖 bitrate는 400이고 fetch를 부르지 않는다', async () => {
    stubFetch(async () => jsonResponse({ ok: true }))
    for (const bad of [0, 499, 8001, 100000]) {
      fetchCalls = []
      const res = await postQuality(ENV, { bitrate: bad })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ ok: false, error: 'INVALID_QUALITY' })
      expect(fetchCalls).toHaveLength(0)
    }
  })

  test('비숫자 bitrate·mode+bitrate 동시·알 수 없는 mode는 400이다', async () => {
    stubFetch(async () => jsonResponse({ ok: true }))
    const badBodies: unknown[] = [
      { bitrate: 'fast' },
      { bitrate: null },
      {},
      { mode: 'auto', bitrate: 1800 },
      { mode: 'high' },
      { mode: 1 },
    ]
    for (const bad of badBodies) {
      fetchCalls = []
      const res = await postQuality(ENV, bad)
      expect(res.status).toBe(400)
      expect(fetchCalls).toHaveLength(0)
    }
  })

  test('JSON이 아닌 본문은 400이다', async () => {
    stubFetch(async () => jsonResponse({ ok: true }))
    const res = await postQuality(ENV, null, 'not-json{')
    expect(res.status).toBe(400)
    expect(fetchCalls).toHaveLength(0)
  })

  test('{ mode: auto }는 사이드카에 자동 복귀를 중계한다', async () => {
    stubFetch(async () => jsonResponse({ ok: true, mode: 'auto', connections: 1 }))
    const res = await postQuality(ENV, { mode: 'auto' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, mode: 'auto', connections: 1 })
    expect(fetchCalls).toHaveLength(1)
    expect(JSON.parse(fetchCalls[0].body as string)).toEqual({ mode: 'auto' })
  })

  test('사이드카 오류 상태·본문이 그대로 돌아온다', async () => {
    stubFetch(async () => jsonResponse({ error: 'invalid_bitrate' }, 400))
    const res = await postQuality(ENV, { bitrate: 1800 })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_bitrate' })
  })

  test('업스트림 예외는 502 ORACLE_UPSTREAM이다', async () => {
    stubFetch(async () => {
      throw new Error('unreachable')
    })
    const res = await postQuality(ENV, { bitrate: 1800 })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ ok: false, error: 'ORACLE_UPSTREAM' })
  })
})
