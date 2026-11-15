/// <reference types="jest" />
/**
 * GET /api/browse/stats — 지연 분해 통계 중계 (2026-11-15, 원격 브라우저
 * 성능 개선: 사이드카 /control/stats를 그대로 돌려준다).
 *
 * 고정하는 성질:
 * - 오라클 설정이 없으면 503 ORACLE_NOT_CONFIGURED이고 fetch를 부르지 않는다.
 * - 유효한 요청은 사이드카 GET /control/stats로 가고 x-origin-secret을
 *   주입한다. 사이드카 응답(상태·본문)이 그대로 돌아온다.
 * - 업스트림 예외는 502 ORACLE_UPSTREAM.
 * 네트워크 경계는 전역 fetch 목킹이다 (실 Oracle 연결은 하지 않는다).
 * 카나리아: 시크릿 주입·중계 URL을 깨면 해당 테스트가 실패한다.
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

describe('GET /stats — 지연 분해 통계 중계', () => {
  test('설정이 없으면 503 ORACLE_NOT_CONFIGURED이고 fetch를 부르지 않는다', async () => {
    stubFetch(async () => {
      throw new Error('must not be called')
    })
    const res = await app.request('/api/browse/stats', {}, {} as never)
    expect(res.status).toBe(503)
    expect((await res.json()) as { error: string }).toEqual({
      ok: false,
      error: 'ORACLE_NOT_CONFIGURED',
    })
    expect(fetchCalls).toHaveLength(0)
  })

  test('사이드카 /control/stats로 중계하고 시크릿을 주입하며 본문을 그대로 돌린다', async () => {
    const stats = {
      ok: true,
      serverUptimeMs: 12345,
      connections: [
        {
          id: 1,
          clientFps: 30,
          clientLatencyMs: 120,
          keepaliveRttMs: 45,
          forwardMsAvg: 0.07,
          forwardMsP95: 0.14,
          bufferedNow: 0,
          bufferedMax: 1024,
          paused: false,
          pauseCount: 0,
          pausedMs: 0,
          framesIn: 900,
          bytesIn: 1234567,
        },
      ],
    }
    stubFetch(async () => jsonResponse(stats))
    const res = await app.request('/api/browse/stats', {}, ENV as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(stats)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe(`https://${HOST}:8080/control/stats`)
    expect(fetchCalls[0].method).toBe('GET')
    expect(fetchCalls[0].headers['x-origin-secret']).toBe('origin-secret')
  })

  test('사이드카 오류는 상태·본문을 그대로 돌려준다', async () => {
    stubFetch(async () => jsonResponse({ ok: false, error: 'unauthorized' }, 401))
    const res = await app.request('/api/browse/stats', {}, ENV as never)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' })
  })

  test('업스트림 예외는 502 ORACLE_UPSTREAM', async () => {
    stubFetch(async () => {
      throw new Error('down')
    })
    const res = await app.request('/api/browse/stats', {}, ENV as never)
    expect(res.status).toBe(502)
    expect((await res.json()) as { error: string }).toEqual({
      ok: false,
      error: 'ORACLE_UPSTREAM',
    })
  })
})
