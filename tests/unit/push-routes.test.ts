/**
 * src/modules/push/routes.ts 100% 커버리지 단위 테스트
 * - src/services/push 모듈 mock (getVapidPublicKey / isPushConfigured)
 * - D1 Mock (prepare/bind/run, runQueue에 Error 적재 시 catch 분기)
 * - Hono app.request()로 HTTP 시뮬레이션
 * - 내부 함수 isValidSubscription은 라우트를 통해 간접 커버
 *   (각 || / && 조건의 양쪽 분기를 모두 타도록 payload 변형)
 */
/// <reference types="jest" />
import { Hono } from 'hono'

// ---------------- 모듈 mock (hoisted) ----------------
jest.mock('../../src/services/push', () => ({
  getVapidPublicKey: jest.fn(),
  isPushConfigured: jest.fn(),
}))

import { pushApp } from '../../src/modules/push/routes'
import { getVapidPublicKey, isPushConfigured } from '../../src/services/push'

const mockGetVapidPublicKey = getVapidPublicKey as jest.Mock
const mockIsPushConfigured = isPushConfigured as jest.Mock

// ---------------- Mock D1 ----------------
class MockDb {
  runQueue: any[] = []
  calls: { sql: string; params: any[] }[] = []

  prepare(sql: string) {
    const db = this
    return {
      bind: (...params: any[]) => {
        db.calls.push({ sql, params })
        return {
          run: async () => {
            const v = db.runQueue.shift()
            if (v instanceof Error) throw v
            return v ?? { meta: { changes: 1 } }
          },
        }
      },
    }
  }
}

function makeApp(db?: MockDb) {
  const mdb = db ?? new MockDb()
  const app = new Hono()
  app.route('/p', pushApp)
  const env: any = { DB: mdb }
  const req = (path: string, init?: RequestInit) => app.request('/p' + path, init, env)
  const json = (path: string, method: string, body?: any) =>
    req(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  return { app, db: mdb, env, req, json }
}

async function body(res: Response) {
  return res.json() as Promise<any>
}

const validSub = (over: any = {}) => ({
  endpoint: 'https://push.example.com/sub/123',
  keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wt5h4P9w', auth: 'tBHIt3Q5t8fF5gX6z' },
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockIsPushConfigured.mockReturnValue(true)
  mockGetVapidPublicKey.mockResolvedValue('BValidPublicKey')
})

// ---------------- GET /vapid-key ----------------
describe('GET /vapid-key', () => {
  test('미설정 → 503', async () => {
    mockIsPushConfigured.mockReturnValue(false)
    const { json } = makeApp()
    const res = await json('/vapid-key', 'GET')
    expect(res.status).toBe(503)
    expect((await body(res)).error).toBe('push_not_configured')
    expect(mockGetVapidPublicKey).not.toHaveBeenCalled()
  })

  test('정상 → 공개키 반환', async () => {
    const { json } = makeApp()
    const res = await json('/vapid-key', 'GET')
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true, publicKey: 'BValidPublicKey' })
  })

  test('키 조회 실패(메시지 있음) → 500 + 메시지', async () => {
    mockGetVapidPublicKey.mockRejectedValue(new Error('boom'))
    const { json } = makeApp()
    const res = await json('/vapid-key', 'GET')
    expect(res.status).toBe(500)
    expect((await body(res)).error).toBe('boom')
  })

  test('키 조회 실패(메시지 없음) → 500 + vapid_error', async () => {
    mockGetVapidPublicKey.mockRejectedValue('plain-string-failure')
    const { json } = makeApp()
    const res = await json('/vapid-key', 'GET')
    expect(res.status).toBe(500)
    expect((await body(res)).error).toBe('vapid_error')
  })
})

// ---------------- POST /subscribe ----------------
describe('POST /subscribe — isValidSubscription 분기', () => {
  test('JSON 파싱 실패 → 400', async () => {
    const { req } = makeApp()
    const res = await req('/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    })
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('invalid_subscription')
  })

  test('json null → 400', async () => {
    const { json } = makeApp()
    const res = await json('/subscribe', 'POST', null)
    expect(res.status).toBe(400)
  })

  test('endpoint 누락 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/subscribe', 'POST', { keys: { p256dh: 'a', auth: 'b' } })
    expect(res.status).toBe(400)
  })

  test('endpoint 비문자열 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/subscribe', 'POST', validSub({ endpoint: 123 }))
    expect(res.status).toBe(400)
  })

  test('endpoint URL 파싱 실패 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/subscribe', 'POST', validSub({ endpoint: 'notaurl' }))
    expect(res.status).toBe(400)
  })

  test('endpoint 비-https → 400', async () => {
    const { json } = makeApp()
    const res = await json('/subscribe', 'POST', validSub({ endpoint: 'http://push.example.com/x' }))
    expect(res.status).toBe(400)
  })

  test('keys 누락 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/subscribe', 'POST', { endpoint: 'https://push.example.com/x' })
    expect(res.status).toBe(400)
  })

  test('p256dh 누락 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/subscribe', 'POST', validSub({ keys: { auth: 'abc' } }))
    expect(res.status).toBe(400)
  })

  test('auth 비문자열 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/subscribe', 'POST', validSub({ keys: { p256dh: 'abc', auth: 5 } }))
    expect(res.status).toBe(400)
  })

  test('p256dh base64url 외 문자 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/subscribe', 'POST', validSub({ keys: { p256dh: 'AB+C/D=', auth: 'abc' } }))
    expect(res.status).toBe(400)
  })

  test('p256dh 200자 초과 → 400', async () => {
    const { json } = makeApp()
    const res = await json(
      '/subscribe',
      'POST',
      validSub({ keys: { p256dh: 'a'.repeat(201), auth: 'abc' } })
    )
    expect(res.status).toBe(400)
  })

  test('auth base64url 외 문자 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/subscribe', 'POST', validSub({ keys: { p256dh: 'abc', auth: 'a!b' } }))
    expect(res.status).toBe(400)
  })

  test('auth 100자 초과 → 400', async () => {
    const { json } = makeApp()
    const res = await json(
      '/subscribe',
      'POST',
      validSub({ keys: { p256dh: 'abc', auth: 'a'.repeat(101) } })
    )
    expect(res.status).toBe(400)
  })

  test('endpoint 2000자 초과 → 400', async () => {
    const { json } = makeApp()
    const res = await json(
      '/subscribe',
      'POST',
      validSub({ endpoint: 'https://push.example.com/' + 'a'.repeat(2000) })
    )
    expect(res.status).toBe(400)
  })

  test('유효한 구독 → upsert 성공', async () => {
    const { json, db } = makeApp()
    const sub = validSub()
    const res = await json('/subscribe', 'POST', sub)
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true })
    expect(db.calls).toHaveLength(1)
    const call = db.calls[0]
    expect(call.sql).toContain('INSERT INTO push_subscriptions')
    expect(call.sql).toContain('ON CONFLICT(endpoint) DO UPDATE')
    expect(call.params).toEqual([sub.endpoint, sub.keys.p256dh, sub.keys.auth])
  })

  test('DB 실패 → 500', async () => {
    const { json, db } = makeApp()
    db.runQueue.push(new Error('db down'))
    const res = await json('/subscribe', 'POST', validSub())
    expect(res.status).toBe(500)
    expect((await body(res)).error).toBe('db_error')
  })
})

// ---------------- DELETE /unsubscribe ----------------
describe('DELETE /unsubscribe', () => {
  test('본문 없음 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/unsubscribe', 'DELETE')
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('invalid_endpoint')
  })

  test('endpoint 누락 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/unsubscribe', 'DELETE', {})
    expect(res.status).toBe(400)
  })

  test('endpoint 비문자열 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/unsubscribe', 'DELETE', { endpoint: 42 })
    expect(res.status).toBe(400)
  })

  test('endpoint 2000자 초과 → 400', async () => {
    const { json } = makeApp()
    const res = await json('/unsubscribe', 'DELETE', { endpoint: 'x'.repeat(2001) })
    expect(res.status).toBe(400)
  })

  test('정상 삭제 → 200 + DELETE 바인딩 확인', async () => {
    const { json, db } = makeApp()
    const endpoint = 'https://push.example.com/sub/123'
    const res = await json('/unsubscribe', 'DELETE', { endpoint })
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true })
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].sql).toContain('DELETE FROM push_subscriptions')
    expect(db.calls[0].params).toEqual([endpoint])
  })

  test('DB 실패 → 500', async () => {
    const { json, db } = makeApp()
    db.runQueue.push(new Error('db down'))
    const res = await json('/unsubscribe', 'DELETE', { endpoint: 'https://x.com/a' })
    expect(res.status).toBe(500)
    expect((await body(res)).error).toBe('db_error')
  })
})
