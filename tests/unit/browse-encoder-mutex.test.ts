/// <reference types="jest" />
/**
 * POST /api/browse/encoder-mutex — 인코더 뮤텍스 (2026-11-26 Waydroid
 * Phase 3 후속, C안: 활성 인코더 최대 1개).
 *
 * 고정하는 성질:
 * - 오라클 설정이 없으면 503 ORACLE_NOT_CONFIGURED이고 fetch를 부르지 않는다.
 * - { paused: boolean }만 받는다 (없음·비boolean·JSON 아님은 400
 *   INVALID_MUTEX, fetch 없음).
 * - { paused: true }는 사이드카 /control/video-streaming에
 *   { enabled: false }로, { paused: false }는 { enabled: true }로
 *   중계하고 x-origin-secret을 주입한다. 사이드카 응답(상태·본문)이
 *   그대로 돌아온다.
 * - 업스트림 예외는 502 ORACLE_UPSTREAM.
 * 네트워크 경계는 전역 fetch 목킹이다 (실 Oracle 연결은 하지 않는다).
 * 카나리아: paused↔enabled 반전·시크릿 주입·검증을 깨면 해당 테스트가
 * 실패한다.
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

async function postMutex(env: Record<string, string>, body: unknown, rawBody?: string): Promise<Response> {
  return await app.request(
    '/api/browse/encoder-mutex',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody !== undefined ? rawBody : JSON.stringify(body),
    },
    env as never,
  )
}

describe('POST /api/browse/encoder-mutex', () => {
  test('오라클 미설정 시 503이고 fetch를 부르지 않는다', async () => {
    stubFetch(async () => jsonResponse({ ok: true }))
    const res = await postMutex(ENV_NO_ORACLE, { paused: true })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, error: 'ORACLE_NOT_CONFIGURED' })
    expect(fetchCalls).toHaveLength(0)
  })

  test('{ paused: true }는 { enabled: false }로 중계되고 시크릿이 주입된다', async () => {
    stubFetch(async () => jsonResponse({ ok: true, enabled: false, connections: 1 }))
    const res = await postMutex(ENV, { paused: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, enabled: false, connections: 1 })
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe(`https://${HOST}:8080/control/video-streaming`)
    expect(fetchCalls[0].method).toBe('POST')
    expect(fetchCalls[0].headers['x-origin-secret']).toBe('origin-secret')
    expect(JSON.parse(fetchCalls[0].body as string)).toEqual({ enabled: false })
  })

  test('{ paused: false }는 { enabled: true }로 중계된다 (반전 확인)', async () => {
    stubFetch(async () => jsonResponse({ ok: true, enabled: true, connections: 1 }))
    const res = await postMutex(ENV, { paused: false })
    expect(res.status).toBe(200)
    expect(JSON.parse(fetchCalls[0].body as string)).toEqual({ enabled: true })
  })

  test('paused 없음·비boolean·여분 키만 있으면 400이고 fetch를 부르지 않는다', async () => {
    stubFetch(async () => jsonResponse({ ok: true }))
    for (const bad of [{}, { paused: 'yes' }, { paused: 1 }, { paused: null }, { enabled: false }]) {
      fetchCalls = []
      const res = await postMutex(ENV, bad)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ ok: false, error: 'INVALID_MUTEX' })
      expect(fetchCalls).toHaveLength(0)
    }
  })

  test('JSON이 아닌 본문은 400이다', async () => {
    stubFetch(async () => jsonResponse({ ok: true }))
    const res = await postMutex(ENV, null, 'not-json{')
    expect(res.status).toBe(400)
    expect(fetchCalls).toHaveLength(0)
  })

  test('사이드카 오류 상태·본문이 그대로 돌아온다', async () => {
    stubFetch(async () => jsonResponse({ error: 'invalid_body' }, 400))
    const res = await postMutex(ENV, { paused: true })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_body' })
  })

  test('업스트림 예외는 502 ORACLE_UPSTREAM이다', async () => {
    stubFetch(async () => {
      throw new Error('unreachable')
    })
    const res = await postMutex(ENV, { paused: true })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ ok: false, error: 'ORACLE_UPSTREAM' })
  })
})
