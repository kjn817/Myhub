/// <reference types="jest" />
/**
 * 보안 헤더 회귀 (GPT P0-③, 트랙 3): 정적 HTML 응답의 클릭재킹·스니핑 방어.
 *
 * 실측(2026-10-31 라이브): CSP는 /login.html에만 있었고, 그 외 HTML에는
 * frame-ancestors·X-Content-Type-Options·Referrer-Policy가 전혀 없었다.
 * 수정 성질:
 * - 인증 HTML 페이지: CSP frame-ancestors 'self' (데스크톱 워크스페이스의
 *   동일 출처 iframe은 허용, 교차 출처 프레이밍만 차단), nosniff, Referrer-Policy.
 * - /login.html: 기존 엄격 CSP(frame-ancestors 'none' 포함)를 덮지 않는다.
 * - 비HTML 에셋: nosniff를 붙인다.
 *
 * 하네스는 tests/unit/core-index.test.ts와 같은 패턴(앱 실물 + ASSETS 목).
 */
import { Hono } from 'hono'

jest.mock('../../src/modules/auth/routes', () => {
  const { Hono: HonoMock } = require('hono')
  const authApp = new HonoMock()
  authApp.get('/ping', (c: any) => c.json({ pong: true }))
  const verifySession = jest.fn()
  const verifySessionForEnv = jest.fn(async (env: any, token: string, allowedEmail?: string) => {
    const email = await verifySession(token, env?.SESSION_SECRET, allowedEmail)
    return email ? { email, method: 'otp', version: 0 } : null
  })
  return { authApp, verifySession, verifySessionForEnv }
})

jest.mock('../../src/scheduled', () => ({
  handleScheduled: jest.fn(),
  handleCronJobs: jest.fn(),
  handleSleepConsolidation: jest.fn(),
  handleGoogleSync: jest.fn(),
}))

jest.mock('../../src/modules/artifact/job-processor', () => ({
  processArtifactJob: jest.fn(),
}))

jest.mock('../../src/services/router', () => {
  const actual = jest.requireActual('../../src/services/router')
  return { ...actual, routeMessage: jest.fn() }
})

import def from '../../src/index'
import { verifySession } from '../../src/modules/auth/routes'

const mockVerifySession = verifySession as jest.Mock

class MockDb {
  prepare(_sql: string) {
    const stmt: any = {
      bind() { return stmt },
      all: async () => ({ results: [] }),
      first: async () => null,
      run: async () => ({ meta: { changes: 1 } }),
    }
    return stmt
  }
  async batch() { return [] }
}

function makeEnv(over: any = {}): any {
  return {
    APP_NAME: 'MyHub Test',
    SESSION_SECRET: 'test-secret',
    DB: new MockDb(),
    KV: { get: jest.fn().mockResolvedValue(null), put: jest.fn().mockResolvedValue(undefined) },
    ASSETS: { fetch: jest.fn() },
    AI: { run: jest.fn() },
    ...over,
  }
}

const get = (path: string, env: any, headers: any = {}) =>
  (def as any).fetch(new Request(`https://test${path}`, { headers }), env, {} as any)

beforeEach(() => {
  jest.clearAllMocks()
  mockVerifySession.mockResolvedValue('user@test.com')
})

describe('정적 HTML 보안 헤더', () => {
  test('인증 HTML 페이지는 frame-ancestors self + nosniff + Referrer-Policy를 받는다', async () => {
    const env = makeEnv()
    env.ASSETS.fetch.mockResolvedValue(
      new Response('<html>memo</html>', { headers: { 'Content-Type': 'text/html' } })
    )
    const res = await get('/memo.html', env, { Cookie: 'myhub_session=t' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Security-Policy') ?? '').toContain("frame-ancestors 'self'")
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Referrer-Policy')).toBe('same-origin')
  })

  test('/login.html의 엄격 CSP는 유지되고(frame-ancestors none) nosniff가 추가된다', async () => {
    const env = makeEnv()
    env.ASSETS.fetch.mockResolvedValue(
      new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } })
    )
    const res = await get('/login.html', env)
    expect(res.status).toBe(200)
    const csp = res.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  test('일반 인증 페이지는 script-src 없이 object/base/form/frame만 제한한다', async () => {
    const env = makeEnv()
    env.ASSETS.fetch.mockResolvedValue(
      new Response('<html>memo</html>', { headers: { 'Content-Type': 'text/html' } })
    )
    const res = await get('/memo.html', env, { Cookie: 'myhub_session=t' })
    expect(res.status).toBe(200)
    const csp = res.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain("frame-ancestors 'self'")
    // 인라인 스크립트 페이지에 script-src를 걸면 깨진다 — 걸지 않는 것이 성질
    expect(csp).not.toContain('script-src')
    expect(csp).not.toContain('default-src')
  })

  test('/desktop.html 파일럿은 unsafe-inline 없는 전면 CSP를 받는다', async () => {
    const env = makeEnv()
    env.ASSETS.fetch.mockResolvedValue(
      new Response('<html>desktop</html>', { headers: { 'Content-Type': 'text/html' } })
    )
    const res = await get('/desktop.html', env, { Cookie: 'myhub_session=t' })
    expect(res.status).toBe(200)
    const csp = res.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    // Lucide 자체 호스팅 전환 후 script-src는 'self'만이다 (unpkg 불허)
    expect(csp).toContain("script-src 'self';")
    expect(csp).not.toContain('unpkg.com')
    expect(csp).toContain("script-src-attr 'none'")
    expect(csp).toContain("frame-src 'self'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("frame-ancestors 'self'")
    // script 계열에 unsafe-inline/unsafe-eval이 새어 들어오면 파일럿이 무의미해진다
    expect(csp).not.toContain("'unsafe-eval'")
    const scriptParts = csp.split(';').filter((d) => d.trim().startsWith('script-src'))
    for (const part of scriptParts) expect(part).not.toContain("'unsafe-inline'")
  })

  test('비HTML 에셋에도 nosniff를 붙인다', async () => {
    const env = makeEnv()
    env.ASSETS.fetch.mockResolvedValue(
      new Response('console.log(1)', { headers: { 'Content-Type': 'application/javascript' } })
    )
    const res = await get('/app.js', env, { Cookie: 'myhub_session=t' })
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })
})
