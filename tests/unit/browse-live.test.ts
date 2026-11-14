/// <reference types="jest" />
/**
 * src/modules/browse/oracle-proxy.ts (+ routes.ts 결선) — Oracle 원격
 * 브라우저 프록시 성질 테스트.
 *
 * 고정하는 성질:
 * - toDirectCdpWsUrl: 공개 베이스로 재작성된 CDP WS URL을 사이드카
 *   직접 URL로 되돌리고, /devtools/ 밖 경로나 비WS 스킴은 거부한다.
 * - 프록시(/view/*, /cdp/*): 시크릿이 하나라도 없으면 503이고 fetch를
 *   부르지 않는다. view는 x-origin-secret + Selkies Basic 인증을,
 *   cdp는 x-origin-secret + x-cdp-secret을 주입한다. 클라이언트가
 *   보낸 쿠키·Authorization·시크릿 헤더는 전달하지 않는다. 쿼리와
 *   하위 경로는 그대로 사이드카로 간다. 업스트림 예외는 502.
 * - POST /navigate: 시크릿 없으면 503, 잘못된 URL은 400, /json/version
 *   실패·ws 없음은 502, CDP 연결 실패는 ok:false/nav=fail/stage=connect로
 *   정직하게 보고한다 (성공은 실서버 검증 항목).
 * 네트워크 경계는 전역 fetch 목킹이다 (실 Oracle 연결은 하지 않는다).
 * 카나리아: 시크릿 주입이나 헤더 차단을 깨면 해당 테스트가 실패한다.
 */
import { Hono } from 'hono'
import { browseApp } from '../../src/modules/browse/routes'
import { toDirectCdpWsUrl } from '../../src/modules/browse/cdp'

const app = new Hono()
app.route('/api/browse', browseApp)

const HOST = '203.0.113.7'
const ENV = {
  ORACLE_BROWSER_HOST: HOST,
  ORIGIN_SECRET: 'origin-secret',
  CDP_SECRET: 'cdp-secret',
  SELKIES_PASSWORD: 'selkies-pw',
}
const ENV_AS_NEVER = ENV as never

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
        for (const [k, v] of Object.entries(h as Record<string, string>)) headers[k.toLowerCase()] = v
      }
    }
    fetchCalls.push({ url: String(url), method: init?.method ?? 'GET', headers, body: init?.body })
    return handler(String(url), init)
  }) as typeof fetch
}

afterEach(() => {
  global.fetch = realFetch
})

const upstreamOk = (data: unknown) => async () =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe('toDirectCdpWsUrl — 공개 URL을 직접 URL로', () => {
  test('wss 공개 URL의 경로를 유지하고 호스트·포트를 사이드카로 바꾼다', () => {
    expect(
      toDirectCdpWsUrl(
        'wss://myhub.myhub-app.workers.dev/api/browse/cdp/devtools/browser/abc123',
        HOST,
        8081,
      ),
    ).toBe(`ws://${HOST}:8081/devtools/browser/abc123`)
    expect(toDirectCdpWsUrl('ws://example.com/devtools/page/p1', HOST, 8081)).toBe(
      `ws://${HOST}:8081/devtools/page/p1`,
    )
  })
  test('/devtools/ 밖 경로나 비WS 스킴·파싱 불가면 null', () => {
    expect(toDirectCdpWsUrl('wss://example.com/api/browse/cdp/json/version', HOST, 8081)).toBeNull()
    expect(toDirectCdpWsUrl('https://example.com/devtools/browser/x', HOST, 8081)).toBeNull()
    expect(toDirectCdpWsUrl('not a url', HOST, 8081)).toBeNull()
    expect(toDirectCdpWsUrl('', HOST, 8081)).toBeNull()
  })
})

describe('GET /view/* — 화면 프록시', () => {
  test('시크릿이 하나라도 없으면 503 ORACLE_NOT_CONFIGURED이고 fetch를 부르지 않는다', async () => {
    stubFetch(async () => {
      throw new Error('must not be called')
    })
    for (const missing of ['ORACLE_BROWSER_HOST', 'ORIGIN_SECRET', 'CDP_SECRET', 'SELKIES_PASSWORD'] as const) {
      const env = { ...ENV }
      delete (env as Record<string, unknown>)[missing]
      const res = await app.request('/api/browse/view/', {}, env as never)
      expect(res.status).toBe(503)
      expect((await res.json()) as { error: string }).toEqual({
        ok: false,
        error: 'ORACLE_NOT_CONFIGURED',
      })
    }
    expect(fetchCalls).toHaveLength(0)
  })

  test('하위 경로·쿼리를 접두사째 8080으로 중계하고 시크릿+Basic을 주입한다', async () => {
    // view는 접두사를 떼지 않는다 — 컨테이너 kclient·nginx가
    // SUBFOLDER=/api/browse/view/로 같은 접두사를 알기 때문이다. 접두사를
    // 떼면 화면 WS가 루트 /websockify로 가서 끊긴다 (2026-11-14 실증).
    stubFetch(upstreamOk({}))
    const res = await app.request(
      '/api/browse/view/selkies/index.html?foo=bar',
      { headers: { 'x-custom': 'keep-me' } },
      ENV_AS_NEVER,
    )
    expect(res.status).toBe(200)
    expect(fetchCalls).toHaveLength(1)
    const call = fetchCalls[0]
    expect(call.url).toBe(`http://${HOST}:8080/api/browse/view/selkies/index.html?foo=bar`)
    expect(call.headers['x-origin-secret']).toBe('origin-secret')
    expect(call.headers['authorization']).toBe(
      `Basic ${Buffer.from('myhub:selkies-pw').toString('base64')}`,
    )
    expect(call.headers['x-custom']).toBe('keep-me')
    expect(call.headers['x-cdp-secret']).toBeUndefined()
  })

  test('/view 루트도 접두사째 보내고, 클라이언트 자격증명은 전달하지 않는다', async () => {
    stubFetch(upstreamOk({}))
    await app.request(
      '/api/browse/view',
      {
        headers: {
          cookie: 'myhub_session=abc',
          authorization: 'Bearer stolen',
          'x-origin-secret': 'forged',
        },
      },
      ENV_AS_NEVER,
    )
    expect(fetchCalls).toHaveLength(1)
    const call = fetchCalls[0]
    expect(call.url).toBe(`http://${HOST}:8080/api/browse/view`)
    expect(call.headers['cookie']).toBeUndefined()
    expect(call.headers['x-origin-secret']).toBe('origin-secret')
    expect(call.headers['authorization']).not.toBe('Bearer stolen')
  })

  test('업스트림 예외는 502 ORACLE_UPSTREAM', async () => {
    stubFetch(async () => {
      throw new Error('net down')
    })
    const res = await app.request('/api/browse/view/', {}, ENV_AS_NEVER)
    expect(res.status).toBe(502)
    expect((await res.json()) as { error: string }).toEqual({
      ok: false,
      error: 'ORACLE_UPSTREAM',
    })
  })
})

describe('GET /cdp/* — CDP 프록시', () => {
  test('하위 경로를 8081으로 중계하고 두 시크릿을 주입하며 Basic은 안 붙인다', async () => {
    stubFetch(upstreamOk({}))
    const res = await app.request('/api/browse/cdp/json/version', {}, ENV_AS_NEVER)
    expect(res.status).toBe(200)
    expect(fetchCalls).toHaveLength(1)
    const call = fetchCalls[0]
    expect(call.url).toBe(`http://${HOST}:8081/json/version`)
    expect(call.headers['x-origin-secret']).toBe('origin-secret')
    expect(call.headers['x-cdp-secret']).toBe('cdp-secret')
    expect(call.headers['authorization']).toBeUndefined()
  })

  test('시크릿이 없으면 503이고 fetch를 부르지 않는다', async () => {
    stubFetch(async () => {
      throw new Error('must not be called')
    })
    const res = await app.request('/api/browse/cdp/json/list', {}, {} as never)
    expect(res.status).toBe(503)
    expect(fetchCalls).toHaveLength(0)
  })
})

async function postNavigate(env: never, body?: unknown) {
  const init: RequestInit = { method: 'POST' }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await app.request('/api/browse/navigate', init, env)
  return { status: res.status, json: (await res.json()) as any }
}

describe('POST /navigate — 영구 탭 이동', () => {
  test('시크릿이 없으면 503이고 fetch를 부르지 않는다', async () => {
    stubFetch(async () => {
      throw new Error('must not be called')
    })
    const r = await postNavigate({} as never, { url: 'https://example.com' })
    expect(r.status).toBe(503)
    expect(r.json.error).toBe('ORACLE_NOT_CONFIGURED')
    expect(fetchCalls).toHaveLength(0)
  })

  test('잘못된 URL은 400 INVALID_URL (파싱 실패·비http·과길이·비문자열·본문 없음)', async () => {
    stubFetch(upstreamOk({}))
    for (const url of ['not a url', 'ftp://example.com', 'x'.repeat(2050), 42, undefined]) {
      const r = await postNavigate(ENV_AS_NEVER, url === undefined ? {} : { url })
      expect(r.status).toBe(400)
      expect(r.json.error).toBe('INVALID_URL')
    }
    expect(fetchCalls).toHaveLength(0)
  })

  test('/json/version 실패·ws 없음은 502 ORACLE_UPSTREAM', async () => {
    stubFetch(async () => new Response('{}', { status: 500 }))
    let r = await postNavigate(ENV_AS_NEVER, { url: 'https://example.com' })
    expect(r.status).toBe(502)
    expect(r.json.error).toBe('ORACLE_UPSTREAM')
    stubFetch(upstreamOk({ Browser: 'Chrome' }))
    r = await postNavigate(ENV_AS_NEVER, { url: 'https://example.com' })
    expect(r.status).toBe(502)
    stubFetch(async () => {
      throw new Error('down')
    })
    r = await postNavigate(ENV_AS_NEVER, { url: 'https://example.com' })
    expect(r.status).toBe(502)
  })

  test('CDP 연결 실패는 ok:false/nav=fail/stage=connect로 정직하게 보고한다', async () => {
    // /json/version은 공개 베이스 ws URL을 돌려주고, 그 뒤의 WS 업그레이드
    // fetch는 webSocket 없는 응답을 준다 → 기본 CDP 연결이 null이 된다.
    stubFetch(async (url) => {
      if (url.includes('/json/version')) {
        return new Response(
          JSON.stringify({
            webSocketDebuggerUrl:
              'wss://myhub.myhub-app.workers.dev/api/browse/cdp/devtools/browser/abc',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('{}', { status: 200 })
    })
    const r = await postNavigate(ENV_AS_NEVER, { url: 'https://example.com' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: false, nav: 'fail', navStage: 'connect' })
    // WS 연결 시도는 공개 URL이 아니라 사이드카 직접 URL로 가야 한다.
    const wsCall = fetchCalls.find((c) => c.url.includes('/devtools/browser/'))
    expect(wsCall).toBeDefined()
    expect(wsCall!.url).toBe(`http://${HOST}:8081/devtools/browser/abc`)
    expect(wsCall!.headers['x-origin-secret']).toBe('origin-secret')
    expect(wsCall!.headers['x-cdp-secret']).toBe('cdp-secret')
  })
})
