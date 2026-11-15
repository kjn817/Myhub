/// <reference types="jest" />
/**
 * src/lib/csrf.ts — 전역 CSRF 방어(Origin/Referer 검사) 성질 테스트.
 *
 * 고정하는 성질:
 * - 안전 메서드(GET/HEAD/OPTIONS)는 Origin과 무관하게 통과한다.
 * - 상태 변경 요청은 Origin이 요청 URL의 호스트와 일치해야 통과한다.
 * - Origin이 없고 Referer만 있으면 Referer의 호스트를 대조한다.
 * - Origin·Referer가 둘 다 없으면 허용한다 (비브라우저 클라이언트).
 * - 파싱 불가·불투명 Origin(null)은 차단한다 (fail-closed).
 * - 포트가 다른 동일 호스트는 다른 출처로 차단한다.
 *
 * 카나리아: 호스트 대조를 빼면 교차 출처 차단 테스트가 실패한다.
 */
import { Hono } from 'hono'
import { isCsrfSafeRequest } from '../../src/lib/csrf'

function buildApp(): Hono {
  const app = new Hono()
  app.use(async (c, next) => {
    if (!isCsrfSafeRequest(c.req)) return c.json({ ok: false, error: 'forbidden' }, 403)
    return next()
  })
  app.get('/api/x', (c) => c.json({ ok: true }))
  app.post('/api/x', (c) => c.json({ ok: true }))
  app.put('/api/x', (c) => c.json({ ok: true }))
  app.delete('/api/x', (c) => c.json({ ok: true }))
  return app
}

const BASE = 'https://myhub.myhub-app.workers.dev'

describe('isCsrfSafeRequest — 미들웨어 경유', () => {
  const app = buildApp()
  const req = (method: string, headers: Record<string, string> = {}) =>
    app.request(`${BASE}/api/x`, { method, headers })

  test('동일 출처 POST는 통과한다', async () => {
    const res = await req('POST', { Origin: BASE })
    expect(res.status).toBe(200)
  })

  test.each(['POST', 'PUT', 'DELETE'])('교차 출처 %s는 403이다', async (method) => {
    const res = await req(method, { Origin: 'https://evil.example.com' })
    expect(res.status).toBe(403)
  })

  test('교차 출처 GET은 안전 메서드라 통과한다', async () => {
    const res = await req('GET', { Origin: 'https://evil.example.com' })
    expect(res.status).toBe(200)
  })

  test('Origin·Referer가 둘 다 없는 POST는 통과한다 (비브라우저 클라이언트)', async () => {
    const res = await req('POST')
    expect(res.status).toBe(200)
  })

  test('Referer만 있을 때는 Referer 호스트를 대조한다', async () => {
    const ok = await req('POST', { Referer: `${BASE}/memo.html` })
    expect(ok.status).toBe(200)
    const bad = await req('POST', { Referer: 'https://evil.example.com/p' })
    expect(bad.status).toBe(403)
  })

  test('Origin이 있으면 Referer보다 Origin을 우선 대조한다', async () => {
    const res = await req('POST', { Origin: 'https://evil.example.com', Referer: `${BASE}/x` })
    expect(res.status).toBe(403)
  })

  test('파싱 불가 Origin·불투명 Origin(null)은 차단한다', async () => {
    expect((await req('POST', { Origin: 'not-a-url' })).status).toBe(403)
    expect((await req('POST', { Origin: 'null' })).status).toBe(403)
  })

  test('포트가 다른 동일 호스트는 다른 출처로 차단한다', async () => {
    const res = await app.request('http://localhost:8787/api/x', {
      method: 'POST',
      headers: { Origin: 'http://localhost:9999' },
    })
    expect(res.status).toBe(403)
    const ok = await app.request('http://localhost:8787/api/x', {
      method: 'POST',
      headers: { Origin: 'http://localhost:8787' },
    })
    expect(ok.status).toBe(200)
  })
})
