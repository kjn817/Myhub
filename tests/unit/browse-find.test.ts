/// <reference types="jest" />
/**
 * POST /api/browse/find — 페이지 내 찾기 (2026-11-20 브라우저 5단계).
 *
 * 사이드카 /control/find로 중계한다. 사이드카가 활성 화면 WS 연결에
 * Selkies 키 메시지 Ctrl+F(kd,65507 → kd,102 → ku,102 → ku,65507)를
 * 주입해 원격 Chromium의 네이티브 찾기 막대를 연다. CDP
 * Input.dispatchKeyEvent는 렌더러로만 가서 브라우저 단축키를 못
 * 연다 (실브라우저 3방 실측 — 2단계 CDP 구현을 되돌린 이유).
 *
 * 고정하는 성질:
 * - 오라클 설정이 없으면 503 ORACLE_NOT_CONFIGURED이고 fetch를 부르지 않는다.
 * - 유효한 요청은 사이드카 /control/find로 가고 x-origin-secret을 주입한다.
 * - 사이드카 응답(상태·본문)이 그대로 돌아온다 (200 성공·503 연결 없음).
 * - 업스트림 예외는 502 ORACLE_UPSTREAM.
 * 네트워크 경계는 전역 fetch 목킹이다 (실 Oracle 연결은 하지 않는다).
 * 카나리아: 중계 URL·시크릿 주입·상태 전달을 깨면 해당 테스트가 실패한다.
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

async function postFind(env: Record<string, string>): Promise<Response> {
  return await app.request(
    '/api/browse/find',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    },
    env as never,
  )
}

describe('POST /api/browse/find', () => {
  test('오라클 미설정 시 503이고 fetch를 부르지 않는다', async () => {
    stubFetch(async () => jsonResponse({ ok: true }))
    const res = await postFind(ENV_NO_ORACLE)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, error: 'ORACLE_NOT_CONFIGURED' })
    expect(fetchCalls).toHaveLength(0)
  })

  test('유효한 요청은 사이드카 /control/find로 중계되고 시크릿이 주입된다', async () => {
    stubFetch(async () => jsonResponse({ ok: true, connections: 1 }))
    const res = await postFind(ENV)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, connections: 1 })
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe(`https://${HOST}:8080/control/find`)
    expect(fetchCalls[0].method).toBe('POST')
    expect(fetchCalls[0].headers['x-origin-secret']).toBe('origin-secret')
  })

  test('사이드카 503(활성 연결 없음)이 그대로 돌아온다', async () => {
    stubFetch(async () => jsonResponse({ ok: false, error: 'no_active_connection' }, 503))
    const res = await postFind(ENV)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, error: 'no_active_connection' })
  })

  test('업스트림 예외는 502 ORACLE_UPSTREAM이다', async () => {
    stubFetch(async () => {
      throw new Error('unreachable')
    })
    const res = await postFind(ENV)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ ok: false, error: 'ORACLE_UPSTREAM' })
  })
})
