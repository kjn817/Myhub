/// <reference types="jest" />
/**
 * src/modules/browse/unlock.ts + /navigate 잠금 차단·내부 URL 차단
 * (2026-11-15, LUKS "MyHub에서 풀기").
 *
 * 고정하는 성질:
 * - 언록 API: 오라클 설정이 없으면 503 ORACLE_NOT_CONFIGURED, UNLOCK_SECRET이
 *   없으면 503 UNLOCK_NOT_CONFIGURED이고 fetch를 부르지 않는다.
 * - 상태 조회·언록·셋업은 사이드카 /unlock/*로 가고, x-origin-secret과
 *   x-unlock-secret을 둘 다 주입한다. 서비스 응답(상태·본문)이 그대로 돌아온다.
 * - 암호는 8~256자만 받는다 (짧거나 비문자열이면 400 INVALID_PASSWORD, fetch 없음).
 * - 업스트림 예외는 502 ORACLE_UPSTREAM.
 * - isBrowserLocked: configured && !unlocked일 때만 true. 미설정·언록됨·
 *   조회 실패면 false (조회 실패는 차단이 아니라 정상 흐름으로 진행).
 * - /navigate: 내부 URL(169.254.169.254·localhost·사설)은 400 INVALID_URL.
 *   잠긴 볼륨이면 423 BROWSER_LOCKED이고 /json/version을 부르지 않는다.
 *   UNLOCK_SECRET이 없으면 상태 조회를 건너뛰고 기존 흐름대로 간다.
 * 네트워크 경계는 전역 fetch 목킹이다 (실 Oracle 연결은 하지 않는다).
 * 카나리아: 시크릿 주입·암호 검증·잠금 분기를 깨면 해당 테스트가 실패한다.
 */
import { Hono } from 'hono'
import { browseApp } from '../../src/modules/browse/routes'
import { isBrowserLocked } from '../../src/modules/browse/unlock'

const app = new Hono()
app.route('/api/browse', browseApp)

const HOST = '203.0.113.7'
const ENV = {
  ORACLE_BROWSER_HOST: HOST,
ORIGIN_SECRET: 'origin-secret',
CDP_SECRET: 'cdp-secret',
SELKIES_PASSWORD: 'selkies-pass',
UNLOCK_SECRET: 'unlock-secret-1234',
}
const ENV_NO_UNLOCK = {
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

/** DoH 스텁: example.com은 공인 IP로 답한다 (A만, AAAA는 빈 응답).
 *  /navigate의 validatePublicUrlAsync가 DoH로 해석 IP를 확인하므로,
 *  유효한 호스트명 테스트는 이 응답이 필요하다. DoH URL이 아니면 null. */
function dohResponse(url: string): Response | null {
  if (!url.startsWith('https://cloudflare-dns.com/dns-query')) return null
  const type = new URL(url).searchParams.get('type')
  const answers =
    type === '1'
      ? [{ name: 'example.com.', type: 1, TTL: 300, data: '93.184.216.34' }]
      : []
  return new Response(JSON.stringify({ Status: 0, Answer: answers }), {
    status: 200,
    headers: { 'content-type': 'application/dns-json' },
  })
}

async function postUnlock(route: string, env: never, body?: unknown) {
  const init: RequestInit = { method: 'POST' }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await app.request(`/api/browse${route}`, init, env)
  return { status: res.status, json: (await res.json()) as any }
}

describe('GET /unlock/status', () => {
  test('오라클 설정이 없으면 503이고 fetch를 부르지 않는다', async () => {
    stubFetch(async () => {
      throw new Error('must not be called')
    })
    const res = await app.request('/api/browse/unlock/status', {}, {} as never)
    expect(res.status).toBe(503)
    expect((await res.json() as any).error).toBe('ORACLE_NOT_CONFIGURED')
    expect(fetchCalls).toHaveLength(0)
  })

  test('UNLOCK_SECRET이 없으면 503 UNLOCK_NOT_CONFIGURED이고 fetch를 부르지 않는다', async () => {
    stubFetch(async () => {
      throw new Error('must not be called')
    })
    const res = await app.request('/api/browse/unlock/status', {}, ENV_NO_UNLOCK as never)
    expect(res.status).toBe(503)
    expect((await res.json() as any).error).toBe('UNLOCK_NOT_CONFIGURED')
    expect(fetchCalls).toHaveLength(0)
  })

  test('사이드카로 두 시크릿을 주입하고 서비스 응답을 그대로 돌려준다', async () => {
    stubFetch(async () => jsonResponse({ configured: true, unlocked: false, failed_attempts: 2 }))
    const res = await app.request('/api/browse/unlock/status', {}, ENV as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ configured: true, unlocked: false, failed_attempts: 2 })
    expect(fetchCalls).toHaveLength(1)
    const call = fetchCalls[0]
    expect(call.url).toBe(`https://${HOST}:8080/unlock/status`)
    expect(call.headers['x-origin-secret']).toBe('origin-secret')
    expect(call.headers['x-unlock-secret']).toBe('unlock-secret-1234')
  })

  test('업스트림 예외는 502 ORACLE_UPSTREAM', async () => {
    stubFetch(async () => {
      throw new Error('down')
    })
    const res = await app.request('/api/browse/unlock/status', {}, ENV as never)
    expect(res.status).toBe(502)
    expect((await res.json() as any).error).toBe('ORACLE_UPSTREAM')
  })
})

describe('POST /unlock/unlock · /unlock/setup', () => {
  test.each(['/unlock/unlock', '/unlock/setup'] as const)(
    '%s: 암호가 8자 미만이거나 비문자열이면 400이고 fetch를 부르지 않는다',
    async (route) => {
      stubFetch(async () => {
        throw new Error('must not be called')
      })
      for (const password of ['short', 42, undefined, '']) {
        const r = await postUnlock(route, ENV as never, password === undefined ? {} : { password })
        expect(r.status).toBe(400)
        expect(r.json.error).toBe('INVALID_PASSWORD')
      }
      expect(fetchCalls).toHaveLength(0)
    },
  )

  test('언록: 암호 본문 + 두 시크릿을 보내고 서비스 응답을 그대로 돌려준다', async () => {
    stubFetch(async () => jsonResponse({ ok: true, unlocked: true }))
    const r = await postUnlock('/unlock/unlock', ENV as never, { password: 'correct-horse-1' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: true, unlocked: true })
    expect(fetchCalls).toHaveLength(1)
    const call = fetchCalls[0]
    expect(call.url).toBe(`https://${HOST}:8080/unlock/unlock`)
    expect(call.method).toBe('POST')
    expect(call.headers['x-origin-secret']).toBe('origin-secret')
    expect(call.headers['x-unlock-secret']).toBe('unlock-secret-1234')
    expect(call.body).toBe(JSON.stringify({ password: 'correct-horse-1' }))
  })

  test('서비스의 잠금 응답(423)이 그대로 돌아온다', async () => {
    stubFetch(async () => jsonResponse({ ok: false, error: 'locked_out', lockout_remaining: 420 }, 423))
    const r = await postUnlock('/unlock/unlock', ENV as never, { password: 'correct-horse-1' })
    expect(r.status).toBe(423)
    expect(r.json).toEqual({ ok: false, error: 'locked_out', lockout_remaining: 420 })
  })

  test('셋업: 경로가 /unlock/setup로 간다', async () => {
    stubFetch(async () => jsonResponse({ ok: true, configured: true }))
    const r = await postUnlock('/unlock/setup', ENV as never, { password: 'correct-horse-1' })
    expect(r.status).toBe(200)
    expect(fetchCalls[0].url).toBe(`https://${HOST}:8080/unlock/setup`)
  })

  test('UNLOCK_SECRET이 없으면 503이고 fetch를 부르지 않는다', async () => {
    stubFetch(async () => {
      throw new Error('must not be called')
    })
    const r = await postUnlock('/unlock/unlock', ENV_NO_UNLOCK as never, { password: 'correct-horse-1' })
    expect(r.status).toBe(503)
    expect(r.json.error).toBe('UNLOCK_NOT_CONFIGURED')
    expect(fetchCalls).toHaveLength(0)
  })
})

describe('isBrowserLocked', () => {
  const cfg = {
    host: HOST,
    originSecret: 'origin-secret',
    cdpSecret: 'cdp-secret',
    selkiesPassword: 'selkies-pass',
  }
  test('configured && !unlocked일 때만 true', async () => {
    stubFetch(async () => jsonResponse({ configured: true, unlocked: false }))
    expect(await isBrowserLocked(cfg, 'unlock-secret-1234')).toBe(true)
    stubFetch(async () => jsonResponse({ configured: true, unlocked: true }))
    expect(await isBrowserLocked(cfg, 'unlock-secret-1234')).toBe(false)
    stubFetch(async () => jsonResponse({ configured: false, unlocked: false }))
    expect(await isBrowserLocked(cfg, 'unlock-secret-1234')).toBe(false)
  })

  test('조회 실패(예외·비200·형태 불일치)는 false — 차단이 아니라 정상 흐름으로', async () => {
    stubFetch(async () => {
      throw new Error('down')
    })
    expect(await isBrowserLocked(cfg, 'unlock-secret-1234')).toBe(false)
    stubFetch(async () => new Response('{}', { status: 503 }))
    expect(await isBrowserLocked(cfg, 'unlock-secret-1234')).toBe(false)
    stubFetch(async () => jsonResponse({ configured: 'yes' }))
    expect(await isBrowserLocked(cfg, 'unlock-secret-1234')).toBe(false)
  })
})

describe('POST /navigate — 내부 URL 차단 · 잠금 차단', () => {
  async function postNavigate(env: never, body: unknown) {
    const res = await app.request('/api/browse/navigate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, env)
    return { status: res.status, json: (await res.json()) as any }
  }

  test('내부 URL은 400 INVALID_URL (메타데이터·localhost·사설)', async () => {
    stubFetch(async () => {
      throw new Error('must not be called')
    })
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:9222/json/version',
      'http://127.0.0.1:9222/json/version',
      'http://10.0.0.212:8080/healthz',
      'http://192.168.1.1/',
    ]) {
      const r = await postNavigate(ENV as never, { url })
      expect(r.status).toBe(400)
      expect(r.json.error).toBe('INVALID_URL')
    }
    expect(fetchCalls).toHaveLength(0)
  })

  test('잠긴 볼륨이면 423 BROWSER_LOCKED이고 /json/version을 부르지 않는다', async () => {
    stubFetch(async (url) => {
      const doh = dohResponse(url)
      if (doh) return doh
      if (url.includes('/unlock/status')) {
        return jsonResponse({ configured: true, unlocked: false })
      }
      throw new Error('must not reach version fetch: ' + url)
    })
    const r = await postNavigate(ENV as never, { url: 'https://example.com' })
    expect(r.status).toBe(423)
    expect(r.json.error).toBe('BROWSER_LOCKED')
    // DoH 조회(A·AAAA 2회)는 URL 검증 단계에서 나가므로 제외하고 센다.
    const nonDoh = fetchCalls.filter(
      (f) => !f.url.startsWith('https://cloudflare-dns.com/dns-query'),
    )
    expect(nonDoh).toHaveLength(1)
    expect(nonDoh[0].url).toBe(`https://${HOST}:8080/unlock/status`)
  })

  test('언록된 볼륨이면 잠금 검사를 통과해 /json/version으로 간다', async () => {
    stubFetch(async (url) => {
      const doh = dohResponse(url)
      if (doh) return doh
      if (url.includes('/unlock/status')) {
        return jsonResponse({ configured: true, unlocked: true })
      }
      return new Response('{}', { status: 500 })
    })
    const r = await postNavigate(ENV as never, { url: 'https://example.com' })
    expect(r.status).toBe(502)
    expect(r.json.error).toBe('ORACLE_UPSTREAM')
    expect(fetchCalls.map((f) => f.url)).toContain(`https://${HOST}:8081/json/version`)
  })

  test('UNLOCK_SECRET이 없으면 상태 조회를 건너뛰고 기존 흐름대로 간다', async () => {
    stubFetch(async (url) => {
      const doh = dohResponse(url)
      if (doh) return doh
      if (url.includes('/unlock/status')) throw new Error('must not check status')
      return new Response('{}', { status: 500 })
    })
    const r = await postNavigate(ENV_NO_UNLOCK as never, { url: 'https://example.com' })
    expect(r.status).toBe(502)
    expect(r.json.error).toBe('ORACLE_UPSTREAM')
    expect(fetchCalls.every((f) => !f.url.includes('/unlock/'))).toBe(true)
  })

  test('DoH 해석이 사설 IP면 400 INVALID_URL (DNS 리바인딩 차단)', async () => {
    // 호스트명 문자열은 공인처럼 보이지만 DoH 해석이 메타데이터 IP다 —
    // 동기 검사만으로는 못 막고 DoH 해석 IP 검사로만 차단된다.
    stubFetch(async (url) => {
      if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
        const type = new URL(url).searchParams.get('type')
        const answers =
          type === '1'
            ? [{ name: 'evil.example.com.', type: 1, TTL: 60, data: '169.254.169.254' }]
            : []
        return new Response(JSON.stringify({ Status: 0, Answer: answers }), {
          status: 200,
          headers: { 'content-type': 'application/dns-json' },
        })
      }
      throw new Error('must not reach upstream: ' + url)
    })
    const r = await postNavigate(ENV as never, { url: 'https://evil.example.com/latest/meta-data/' })
    expect(r.status).toBe(400)
    expect(r.json.error).toBe('INVALID_URL')
    // DoH 조회(A·AAAA)만 나가고 잠금 검사·버전 페치는 없다.
    expect(fetchCalls.length).toBeGreaterThan(0)
    expect(
      fetchCalls.every((f) => f.url.startsWith('https://cloudflare-dns.com/dns-query')),
    ).toBe(true)
  })
})
