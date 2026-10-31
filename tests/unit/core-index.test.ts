/// <reference types="jest" />
/**
 * src/index.ts 단위 테스트 (Hono 앱 와이어링 + 미들웨어 + default export)
 *
 * Mock 전략:
 * - ../../src/modules/auth/routes → { authApp(최소 Hono), verifySession: jest.fn() }
 * - ../../src/scheduled → { handleScheduled, handleCronJobs, handleSleepConsolidation, handleGoogleSync: jest.fn() }
 * - ../../src/modules/artifact/job-processor → { processArtifactJob: jest.fn() } (동적 import)
 * - ../../src/services/router → requireActual + routeMessage: jest.fn() (clef 테스트 엔드포인트용)
 * - env.DB: 큐 기반 MockDb (prepare/bind/all/first/run)
 * - env.KV: { get, put } jest.fn()
 * - env.ASSETS: { fetch: jest.fn() }
 * - global.fetch: Cloudflare/Cloudinary API 모킹
 */
import { Hono } from 'hono'

jest.mock('../../src/modules/auth/routes', () => {
  const { Hono: HonoMock } = require('hono')
  const authApp = new HonoMock()
  authApp.get('/ping', (c: any) => c.json({ pong: true }))
  const verifySession = jest.fn()
  // 미들웨어가 쓰는 verifySessionForEnv는 모킹된 verifySession 값을
  // SessionInfo({ email, method, version }) 형태로 변환해 돌려준다.
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
import { verifySession, verifySessionForEnv } from '../../src/modules/auth/routes'
import { handleScheduled, handleCronJobs, handleSleepConsolidation, handleGoogleSync } from '../../src/scheduled'
import { processArtifactJob } from '../../src/modules/artifact/job-processor'
import { routeMessage } from '../../src/services/router'

const mockVerifySession = verifySession as jest.Mock
const mockVerifySessionForEnv = verifySessionForEnv as jest.Mock
const mockHandleScheduled = handleScheduled as jest.Mock
const mockHandleCronJobs = handleCronJobs as jest.Mock
const mockHandleSleepConsolidation = handleSleepConsolidation as jest.Mock
const mockHandleGoogleSync = handleGoogleSync as jest.Mock
const mockProcessArtifactJob = processArtifactJob as jest.Mock
const mockRouteMessage = routeMessage as jest.Mock

// ---------------- Mock D1 ----------------
class MockDb {
  allQueue: any[] = []
  firstQueue: any[] = []
  runQueue: any[] = []
  batchQueue: any[] = []
  prepareThrows: Error | null = null
  prepares: string[] = []

  prepare(sql: string) {
    if (this.prepareThrows) throw this.prepareThrows
    this.prepares.push(sql)
    const db = this
    const stmt: any = {
      bind(..._params: any[]) { return stmt },
      all: async () => {
        const v = db.allQueue.shift()
        if (v instanceof Error) throw v
        return v ?? { results: [] }
      },
      first: async () => {
        const v = db.firstQueue.shift()
        if (v instanceof Error) throw v
        return v ?? null
      },
      run: async () => {
        const v = db.runQueue.shift()
        if (v instanceof Error) throw v
        return v ?? { meta: { changes: 1 } }
      },
    }
    return stmt
  }

  async batch(_stmts: any[]) {
    const v = this.batchQueue.shift()
    if (v instanceof Error) throw v
    return v ?? []
  }
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

const fetchDef = (req: Request, env: any) => (def as any).fetch(req, env, {} as any)
const get = (path: string, env: any, headers: any = {}) =>
  fetchDef(new Request(`https://test${path}`, { headers }), env)

beforeEach(() => {
  jest.clearAllMocks()
  mockVerifySession.mockResolvedValue(null)
})

describe('/api/health', () => {
  test('인증 없이 200 + ok/app 반환', async () => {
    const res = await get('/api/health', makeEnv())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, app: 'MyHub Test' })
  })
})

describe('/api/test/clef-router', () => {
  const authed = (init: RequestInit) =>
    fetchDef(
      new Request('https://test/api/test/clef-router', {
        ...init,
        headers: { ...(init.headers || {}), Cookie: 'myhub_session=t' },
      }),
      makeEnv()
    )
  beforeEach(() => {
    mockVerifySession.mockResolvedValue('user@test.com')
  })

  test('인증 없으면 401 (인증 미들웨어 뒤에 등록됨)', async () => {
    const res = await fetchDef(
      new Request('https://test/api/test/clef-router', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '안녕' }),
      }),
      makeEnv()
    )
    expect(res.status).toBe(401)
    expect(mockRouteMessage).not.toHaveBeenCalled()
  })

  test('성공: routeMessage 결과를 그대로 반환', async () => {
    mockRouteMessage.mockResolvedValue({ persona: 'lumi', reason: 'test' })
    const env = makeEnv()
    const res = await authed({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '안녕', previousPersona: 'lumi' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.result).toEqual({ persona: 'lumi', reason: 'test' })
    expect(mockRouteMessage).toHaveBeenCalledTimes(1)
    const [invoker, message, opts] = mockRouteMessage.mock.calls[0]
    expect(typeof invoker).toBe('function')
    expect(message).toBe('안녕')
    expect(opts).toEqual({ previousPersona: 'lumi', previousMessage: undefined })
  })

  test('본문 파싱 실패 시 기본 메시지로 폴백 (.catch 분기)', async () => {
    mockRouteMessage.mockResolvedValue({ persona: null })
    const res = await authed({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    })
    expect(res.status).toBe(200)
    expect(mockRouteMessage.mock.calls[0][1]).toBe('내일 오후 3시에 회의 일정 등록해줘')
  })

  test('routeMessage 예외 시 500', async () => {
    mockRouteMessage.mockRejectedValue(new Error('router boom'))
    const res = await authed({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ ok: false, error: 'router boom' })
  })

  test('message 없는 에러는 String(e)으로 변환한다 (|| 분기)', async () => {
    mockRouteMessage.mockRejectedValue('plain failure string')
    const res = await authed({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('plain failure string')
  })

  test('invoker 콜백이 env.AI.run을 호출한다', async () => {
    mockRouteMessage.mockImplementation(async (invoker: any) => {
      const r = await invoker({ question: 'q' })
      return { invoked: r }
    })
    const env = makeEnv()
    env.AI.run.mockResolvedValue('ai-ok')
    mockVerifySession.mockResolvedValue('user@test.com')
    const res = await fetchDef(
      new Request('https://test/api/test/clef-router', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: 'myhub_session=t' },
        body: JSON.stringify({ message: 'hi' }),
      }),
      env
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.result).toEqual({ invoked: 'ai-ok' })
    expect(env.AI.run).toHaveBeenCalledTimes(1)
    expect(env.AI.run.mock.calls[0][1]).toEqual({ question: 'q' })
    // AI Gateway 관측성 (트랙 B2): invoker가 gateway 옵션을 3번째 인자로 단다
    expect(env.AI.run.mock.calls[0][2]).toEqual({ gateway: { id: 'default' } })
  })
})

describe('인증 미들웨어', () => {
  test('공개 경로 /login.html은 통과한다', async () => {
    const env = makeEnv()
    env.ASSETS.fetch.mockResolvedValue(new Response('<html>login</html>'))
    const res = await get('/login.html', env)
    expect(res.status).toBe(200)
    expect(mockVerifySession).not.toHaveBeenCalled()
  })

  test('쿼리스트링이 붙은 /login.html도 통과한다 (split("?") 분기)', async () => {
    const env = makeEnv()
    env.ASSETS.fetch.mockResolvedValue(new Response('<html>login</html>'))
    const res = await get('/login.html?v=abc123', env)
    expect(res.status).toBe(200)
  })

  test('공개 에셋(manifest/icon/wallpaper)은 통과한다', async () => {
    const env = makeEnv()
    env.ASSETS.fetch.mockResolvedValue(new Response('{}'))
    for (const p of ['/manifest.json', '/icon-192.png', '/icon-512.png', '/wallpaper.webp']) {
      const res = await get(p, env)
      expect(res.status).toBe(200)
    }
  })

  test('/api/auth/* 는 미들웨어를 통과해 authApp으로 간다', async () => {
    const res = await get('/api/auth/ping', makeEnv())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pong: true })
  })

  test('쿠키 없으면 API는 401', async () => {
    const res = await get('/api/modules', makeEnv())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: '인증 필요' })
  })

  test('쿠키 없으면 페이지는 /login.html로 302 리다이렉트', async () => {
    const res = await get('/memo.html', makeEnv())
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('/login.html')
  })

  test('유효한 세션 쿠키는 userEmail을 세팅하고 통과한다', async () => {
    mockVerifySession.mockResolvedValue('user@test.com')
    const env = makeEnv()
    const res = await get('/api/modules', env, { Cookie: 'myhub_session=tok123; other=1' })
    expect(res.status).toBe(200)
    // 미들웨어는 verifySessionForEnv(env, token)로 검증한다
    expect(mockVerifySessionForEnv).toHaveBeenCalledWith(env, 'tok123')
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(5) // hidden 제외
  })

  test('세션 쿠키 정규식이 토큰을 정확히 추출한다', async () => {
    mockVerifySession.mockResolvedValue('user@test.com')
    const env = makeEnv()
    env.ASSETS.fetch.mockResolvedValue(new Response('x'))
    await get('/index.html', env, { Cookie: 'a=1; myhub_session=ABC; b=2' })
    expect(mockVerifySessionForEnv).toHaveBeenCalledWith(env, 'ABC')
  })

  test('무효한 세션 쿠키는 API 401', async () => {
    mockVerifySession.mockResolvedValue(null)
    const res = await get('/api/modules', makeEnv(), { Cookie: 'myhub_session=bad' })
    expect(res.status).toBe(401)
  })

  test('무효한 세션 쿠키는 페이지 302', async () => {
    mockVerifySession.mockResolvedValue(null)
    const res = await get('/index.html', makeEnv(), { Cookie: 'myhub_session=bad' })
    expect(res.status).toBe(302)
  })
})

describe('/api/modules', () => {
  test('hidden 모듈을 제외하고 id/name/desc/path만 반환한다', async () => {
    mockVerifySession.mockResolvedValue('user@test.com')
    const res = await get('/api/modules', makeEnv(), { Cookie: 'myhub_session=t' })
    expect(res.status).toBe(200)
    const body = await res.json()
    const ids = body.map((m: any) => m.id)
    expect(ids).toEqual(['memo', 'ai', 'schedule', 'todo', 'studio'])
    for (const m of body) {
      expect(Object.keys(m).sort()).toEqual(['desc', 'id', 'name', 'path'])
    }
  })
})

describe('/api/system', () => {
  const authed = (env: any) => {
    mockVerifySession.mockResolvedValue('user@test.com')
    return { Cookie: 'myhub_session=t' }
  }

  function systemDb(): MockDb {
    const db = new MockDb()
    db.allQueue.push({ results: [{ name: 'memos' }, { name: 'files' }] })
    // §6 #6: 테이블별 COUNT(*)는 DB.batch() 1회로 반환된다
    db.batchQueue.push([{ results: [{ n: 10 }] }, { results: [{ n: 3 }] }])
    db.firstQueue.push({ n: 10 }) // memos (별도 쿼리)
    db.firstQueue.push({ n: 2, s: 500 }) // files (별도 쿼리)
    return db
  }

  function mockExternalApis(opts: { cf?: any; cl?: any; cfThrow?: boolean; clThrow?: boolean } = {}) {
    const fetchMock = jest.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('cloudflare.com')) {
        if (opts.cfThrow) throw new Error('cf down')
        return { json: async () => opts.cf ?? { success: false } }
      }
      if (u.includes('cloudinary.com')) {
        if (opts.clThrow) throw new Error('cl down')
        return { json: async () => opts.cl ?? {} }
      }
      throw new Error('unexpected fetch: ' + u)
    })
    ;(global as any).fetch = fetchMock
    return fetchMock
  }

  afterEach(() => {
    ;(global as any).fetch = undefined
  })

  test('KV 캐시 히트 시 from_cache=true로 반환한다', async () => {
    const env = makeEnv()
    const cached = { ok: true, cached_at: Date.now(), d1: { size_bytes: 1 } }
    env.KV.get.mockResolvedValue(cached)
    const res = await get('/api/system', env, authed(env))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.from_cache).toBe(true)
    expect(body.ok).toBe(true)
  })

  test('오래된 캐시는 무시하고 DB를 조회한다', async () => {
    const env = makeEnv({ DB: systemDb() })
    env.KV.get.mockResolvedValue({ ok: true, cached_at: Date.now() - 20 * 60 * 1000 })
    mockExternalApis()
    const res = await get('/api/system', env, authed(env))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.from_cache).toBeUndefined()
    expect(body.memos).toBe(10)
  })

  test('KV.get 실패는 무시하고 진행한다 (.catch 분기)', async () => {
    const env = makeEnv({ DB: systemDb() })
    env.KV.get.mockRejectedValue(new Error('kv down'))
    mockExternalApis()
    const res = await get('/api/system', env, authed(env))
    expect(res.status).toBe(200)
  })

  test('Cloudflare+Cloudinary API 성공 시 정확한 크기를 사용한다', async () => {
    const env = makeEnv({
      DB: systemDb(),
      CF_D1_TOKEN: 'tok',
      CLOUDINARY_CLOUD_NAME: 'cn',
      CLOUDINARY_API_KEY: 'k',
      CLOUDINARY_API_SECRET: 's',
    })
    mockExternalApis({
      cf: { success: true, result: { file_size: 123456 } },
      cl: { storage: { usage: 999, limit: 2000 }, plan: 'Free' },
    })
    const res = await get('/api/system', env, authed(env))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.d1.size_bytes).toBe(123456)
    expect(body.d1.size_source).toBe('cloudflare-api')
    expect(body.d1.tables).toEqual(['memos', 'files'])
    expect(body.d1.total_rows).toBe(13)
    expect(body.files).toEqual({ count: 2, bytes: 500 })
    expect(body.cloudinary.used_bytes).toBe(999)
    expect(body.cloudinary.limit_bytes).toBe(2000)
    expect(body.cloudinary.used_mb).toBe((999 / 1024 / 1024).toFixed(2))
    expect(body.cloudinary_source).toBe('cloudinary-api')
    expect(env.KV.put).toHaveBeenCalledTimes(1)
    const [key, val, opts] = env.KV.put.mock.calls[0]
    expect(key).toBe('system:stats')
    expect(opts).toEqual({ expirationTtl: 600 })
    expect(JSON.parse(val).ok).toBe(true)
  })

  test('외부 API fetch에 5초 타임아웃 signal이 전달된다 (§6 #6)', async () => {
    const env = makeEnv({
      DB: systemDb(),
      CF_D1_TOKEN: 'tok',
      CLOUDINARY_CLOUD_NAME: 'cn',
      CLOUDINARY_API_KEY: 'k',
      CLOUDINARY_API_SECRET: 's',
    })
    const inits: any[] = []
    ;(global as any).fetch = jest.fn(async (url: string, init: any) => {
      inits.push(init)
      if (String(url).includes('cloudflare.com')) {
        return { json: async () => ({ success: true, result: { file_size: 123 } }) }
      }
      return { json: async () => ({ storage: { usage: 1, limit: 2 }, plan: 'Free' }) }
    })
    const res = await get('/api/system', env, authed(env))
    expect(res.status).toBe(200)
    expect(inits).toHaveLength(2)
    for (const init of inits) {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      // AbortSignal.timeout(5000)은 타임아웃이 설정된 signal이다
      expect(init.signal.aborted).toBe(false)
    }
  })

  test('토큰 없으면 추정치 경로 + cloudinary null (db-sum)', async () => {
    const env = makeEnv({ DB: systemDb() })
    env.DB.firstQueue.push({ s: 1000 }) // memoBytes 추정치 쿼리
    mockExternalApis()
    const res = await get('/api/system', env, authed(env))
    const body = await res.json()
    expect(body.d1.size_source).toBe('estimate')
    expect(body.d1.size_bytes).toBe(1000 + 13 * 500)
    expect(body.d1.size_mb).toBe(((1000 + 13 * 500) / 1024 / 1024).toFixed(2))
    expect(body.cloudinary).toBeNull()
    expect(body.cloudinary_source).toBe('db-sum')
  })

  test('Cloudflare API fetch 예외 시 추정치로 폴백한다', async () => {
    const env = makeEnv({ DB: systemDb(), CF_D1_TOKEN: 'tok' })
    env.DB.firstQueue.push({ s: 1000 })
    mockExternalApis({ cfThrow: true })
    const res = await get('/api/system', env, authed(env))
    const body = await res.json()
    expect(body.d1.size_source).toBe('estimate')
  })

  test('Cloudflare API success:false면 추정치로 폴백한다', async () => {
    const env = makeEnv({ DB: systemDb(), CF_D1_TOKEN: 'tok' })
    env.DB.firstQueue.push({ s: 1000 })
    mockExternalApis({ cf: { success: false } })
    const res = await get('/api/system', env, authed(env))
    expect((await res.json()).d1.size_source).toBe('estimate')
  })

  test('Cloudflare API file_size 없으면 추정치로 폴백한다', async () => {
    const env = makeEnv({ DB: systemDb(), CF_D1_TOKEN: 'tok' })
    env.DB.firstQueue.push({ s: 1000 })
    mockExternalApis({ cf: { success: true, result: {} } })
    const res = await get('/api/system', env, authed(env))
    expect((await res.json()).d1.size_source).toBe('estimate')
  })

  test('Cloudinary fetch 예외 시 cloudinary null', async () => {
    const env = makeEnv({
      DB: systemDb(),
      CLOUDINARY_CLOUD_NAME: 'cn',
      CLOUDINARY_API_KEY: 'k',
      CLOUDINARY_API_SECRET: 's',
    })
    env.DB.firstQueue.push({ s: 1000 })
    mockExternalApis({ clThrow: true })
    const res = await get('/api/system', env, authed(env))
    const body = await res.json()
    expect(body.cloudinary).toBeNull()
    expect(body.cloudinary_source).toBe('db-sum')
  })

  test('Cloudinary usage 없으면 cloudinary null', async () => {
    const env = makeEnv({
      DB: systemDb(),
      CLOUDINARY_CLOUD_NAME: 'cn',
      CLOUDINARY_API_KEY: 'k',
      CLOUDINARY_API_SECRET: 's',
    })
    env.DB.firstQueue.push({ s: 1000 })
    mockExternalApis({ cl: { storage: {} } })
    const res = await get('/api/system', env, authed(env))
    expect((await res.json()).cloudinary).toBeNull()
  })

  test('테이블 count 쿼리 실패는 건너뛴다 (내부 try/catch)', async () => {
    const env = makeEnv({ DB: systemDb() })
    // batch가 실패하면 순차 카운트로 폴백하고, files count 예외는 건너뛴다
    // → totalRows는 memos(10)만. 폴백이 firstQueue 2건을 소비하므로
    // memos/files 집계용 항목을 그 뒤에 맞춰 넣는다.
    env.DB.batchQueue.length = 0
    env.DB.batchQueue.push(new Error('batch fail'))
    env.DB.firstQueue.splice(1, 0, new Error('count fail'))
    env.DB.firstQueue.splice(2, 0, { n: 10 }) // memos 집계
    env.DB.firstQueue.push({ s: 1000 })
    mockExternalApis()
    const res = await get('/api/system', env, authed(env))
    const body = await res.json()
    expect(body.d1.total_rows).toBe(10)
    expect(body.d1.tables).toEqual(['memos', 'files'])
    expect(body.memos).toBe(10)
  })

  test('memos/files 집계 실패 시 0으로 폴백한다 (.catch 분기)', async () => {
    const db = new MockDb()
    db.allQueue.push({ results: [{ name: 'memos' }] })
    db.batchQueue.push([{ results: [{ n: 10 }] }]) // 테이블 count (batch)
    db.firstQueue.push(new Error('memos fail')) // memos 집계
    db.firstQueue.push(new Error('files fail')) // files 집계
    db.firstQueue.push({ s: 1000 }) // 추정치
    const env = makeEnv({ DB: db })
    mockExternalApis()
    const res = await get('/api/system', env, authed(env))
    const body = await res.json()
    expect(body.memos).toBe(0)
    expect(body.files).toEqual({ count: 0, bytes: 0 })
  })

  test('KV.put 실패는 무시한다', async () => {
    const env = makeEnv({ DB: systemDb() })
    env.DB.firstQueue.push({ s: 1000 })
    env.KV.put.mockRejectedValue(new Error('kv put fail'))
    mockExternalApis()
    const res = await get('/api/system', env, authed(env))
    expect(res.status).toBe(200)
  })

  test('테이블 목록 results가 null이면 빈 배열로 처리한다 (|| [] 분기)', async () => {
    const db = new MockDb()
    db.allQueue.push({ results: null })
    db.firstQueue.push({ n: 5 })
    db.firstQueue.push({ n: 5 })
    db.firstQueue.push({ s: 100 })
    const env = makeEnv({ DB: db })
    mockExternalApis()
    const res = await get('/api/system', env, authed(env))
    const body = await res.json()
    expect(body.d1.tables).toEqual([])
    expect(body.d1.total_rows).toBe(0)
    expect(body.d1.size_bytes).toBe(100) // 100 + 0*500
  })

  test('테이블 count가 null이면 0으로 합산한다 (?? 0 분기)', async () => {
    const db = new MockDb()
    db.allQueue.push({ results: [{ name: 'memos' }] })
    db.batchQueue.push([{ results: [null] }]) // count 행 null → ?? 0
    db.firstQueue.push({ n: 5 }) // memos 집계
    db.firstQueue.push({ n: 1, s: 10 }) // files 집계
    db.firstQueue.push({ s: 100 }) // 추정치
    const env = makeEnv({ DB: db })
    mockExternalApis()
    const res = await get('/api/system', env, authed(env))
    expect((await res.json()).d1.total_rows).toBe(0)
  })

  test('Cloudinary limit/plan 없으면 기본값으로 폴백한다 (|| 분기)', async () => {
    const env = makeEnv({
      DB: systemDb(),
      CLOUDINARY_CLOUD_NAME: 'cn',
      CLOUDINARY_API_KEY: 'k',
      CLOUDINARY_API_SECRET: 's',
    })
    env.DB.firstQueue.push({ s: 1000 })
    const { CONFIG } = await import('../../src/config')
    mockExternalApis({ cl: { storage: { usage: 777 } } })
    const res = await get('/api/system', env, authed(env))
    const body = await res.json()
    expect(body.cloudinary.used_bytes).toBe(777)
    expect(body.cloudinary.limit_bytes).toBe(CONFIG.cloudinaryFreeLimitBytes)
    expect(body.cloudinary.plan).toBe('Free')
  })

  test('추정치 쿼리 결과가 null이면 0으로 계산한다 (?? 0 분기)', async () => {
    const env = makeEnv({ DB: systemDb() })
    env.DB.firstQueue.push(null) // memoBytes null
    mockExternalApis()
    const res = await get('/api/system', env, authed(env))
    expect((await res.json()).d1.size_bytes).toBe(13 * 500)
  })

  test('추정치 쿼리 실패 시 null로 폴백한다 (.catch 분기)', async () => {
    const env = makeEnv({ DB: systemDb() })
    env.DB.firstQueue.push(new Error('estimate fail'))
    mockExternalApis()
    const res = await get('/api/system', env, authed(env))
    expect((await res.json()).d1.size_bytes).toBe(13 * 500)
  })

  test('DB 장애 시 500', async () => {
    const env = makeEnv()
    env.DB.prepareThrows = new Error('d1 down')
    const res = await get('/api/system', env, authed(env))
    expect(res.status).toBe(500)
    expect((await res.json()).ok).toBe(false)
  })

  test('미인증 시 401 (미들웨어)', async () => {
    const res = await get('/api/system', makeEnv())
    expect(res.status).toBe(401)
  })
})

describe('정적 에셋 서빙 (/*)', () => {
  const authedHeaders = () => {
    mockVerifySession.mockResolvedValue('user@test.com')
    return { Cookie: 'myhub_session=t' }
  }

  test('/ → /index.html 매핑 + HTML은 no-store', async () => {
    const env = makeEnv()
    env.ASSETS.fetch.mockImplementation(async (req: Request) => {
      expect(req.url).toContain('/index.html')
      return new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } })
    })
    const res = await get('/', env, authedHeaders())
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toContain('no-store')
  })

  test('HTML이 아닌 에셋은 immutable 캐시 + 원본 Content-Type 유지', async () => {
    const env = makeEnv()
    const upstream = new Response('console.log(1)', { headers: { 'Content-Type': 'application/javascript' } })
    env.ASSETS.fetch.mockResolvedValue(upstream)
    const res = await get('/app.js', env, authedHeaders())
    expect(res.status).toBe(200)
    // audit P-1: ASSETS가 주는 헤더에 의존하지 않고 Worker가 직접 명시한다
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    expect(res.headers.get('Content-Type')).toContain('application/javascript')
    expect(await res.text()).toBe('console.log(1)')
  })

  test('/login.html에는 엄격 CSP를 붙인다 (인라인 시절과 동일)', async () => {
    const env = makeEnv()
    env.ASSETS.fetch.mockResolvedValue(new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }))
    const res = await get('/login.html', env)
    expect(res.status).toBe(200)
    const csp = res.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  test('ASSETS 바인딩이 없으면 503 (조용한 404로 위장하지 않음)', async () => {
    const env = makeEnv({ ASSETS: undefined })
    const res = await get('/memo.html', env, authedHeaders())
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('ASSETS')
  })

  test('아바타는 ASSETS에서 서빙된다 (인라인 폴백 없음)', async () => {
    const env = makeEnv()
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46])
    env.ASSETS.fetch.mockImplementation(async (req: Request) => {
      expect(req.url).toContain('/avatars/rumi.webp')
      return new Response(bytes, { headers: { 'Content-Type': 'image/webp' } })
    })
    const res = await get('/avatars/rumi.webp', env, authedHeaders())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/webp')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
  })

  test('ASSETS 404 응답에는 immutable을 붙이지 않는다', async () => {
    const env = makeEnv()
    env.ASSETS.fetch.mockResolvedValue(new Response('not found', { status: 404 }))
    const res = await get('/nope.js', env, authedHeaders())
    expect(res.status).toBe(404)
    expect(res.headers.get('Cache-Control')).toBeNull()
  })

  test('apple-touch-icon은 미인증 공개 경로다', async () => {
    const env = makeEnv()
    env.ASSETS.fetch.mockResolvedValue(new Response('png', { headers: { 'Content-Type': 'image/png' } }))
    const res = await get('/apple-touch-icon.png', env)
    expect(res.status).toBe(200)
  })

  test('ASSETS.fetch 예외 시 404', async () => {
    const env = makeEnv()
    env.ASSETS.fetch.mockRejectedValue(new Error('not found'))
    const res = await get('/nope.html', env, authedHeaders())
    expect(res.status).toBe(404)
  })
})

describe('default.scheduled', () => {
  test('handleScheduled(env)을 호출한다', async () => {
    const env = makeEnv()
    await (def as any).scheduled({} as any, env, {} as any)
    expect(mockHandleScheduled).toHaveBeenCalledTimes(1)
    expect(mockHandleScheduled).toHaveBeenCalledWith(env)
  })

  test('자연어 cron 핸들러 handleCronJobs(env)도 호출한다', async () => {
    const env = makeEnv()
    await (def as any).scheduled({} as any, env, {} as any)
    expect(mockHandleCronJobs).toHaveBeenCalledTimes(1)
    expect(mockHandleCronJobs).toHaveBeenCalledWith(env)
  })

  test('수면 통합 핸들러 handleSleepConsolidation(env)도 호출한다', async () => {
    const env = makeEnv()
    await (def as any).scheduled({} as any, env, {} as any)
    expect(mockHandleSleepConsolidation).toHaveBeenCalledTimes(1)
    expect(mockHandleSleepConsolidation).toHaveBeenCalledWith(env)
  })

  test('Google 동기화 핸들러 handleGoogleSync(env)도 호출한다', async () => {
    const env = makeEnv()
    await (def as any).scheduled({} as any, env, {} as any)
    expect(mockHandleGoogleSync).toHaveBeenCalledTimes(1)
    expect(mockHandleGoogleSync).toHaveBeenCalledWith(env)
  })
})

describe('default.queue (Artifact Queue Consumer)', () => {
  const msg = (jobId = 5) => ({
    body: { jobId },
    ack: jest.fn(),
    retry: jest.fn(),
  })
  const batchOf = (m: any) => ({ messages: [m] } as any)

  test("claimed 'done' → ack", async () => {
    mockProcessArtifactJob.mockResolvedValue('done')
    const m = msg()
    await (def as any).queue(batchOf(m), makeEnv())
    expect(mockProcessArtifactJob).toHaveBeenCalledWith(expect.anything(), 5)
    expect(m.ack).toHaveBeenCalledTimes(1)
    expect(m.retry).not.toHaveBeenCalled()
  })

  test("claimed 'failed' → ack", async () => {
    mockProcessArtifactJob.mockResolvedValue('failed')
    const m = msg()
    await (def as any).queue(batchOf(m), makeEnv())
    expect(m.ack).toHaveBeenCalledTimes(1)
  })

  test("claimed 'notfound' → ack", async () => {
    mockProcessArtifactJob.mockResolvedValue('notfound')
    const m = msg()
    await (def as any).queue(batchOf(m), makeEnv())
    expect(m.ack).toHaveBeenCalledTimes(1)
  })

  test("claimed 'busy' → 30초 후 retry", async () => {
    mockProcessArtifactJob.mockResolvedValue('busy')
    const m = msg()
    await (def as any).queue(batchOf(m), makeEnv())
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
    expect(m.ack).not.toHaveBeenCalled()
  })

  test('예외 발생 시 artifact_jobs를 failed로 기록 후 ack', async () => {
    mockProcessArtifactJob.mockRejectedValue(new Error('kaboom'))
    const db = new MockDb()
    const m = msg(9)
    await (def as any).queue(batchOf(m), makeEnv({ DB: db }))
    expect(m.ack).toHaveBeenCalledTimes(1)
    const updateSql = db.prepares.find((s) => s.includes("UPDATE artifact_jobs SET status='failed'"))
    expect(updateSql).toBeDefined()
  })

  test('DB 기록마저 실패해도 ack한다 (내부 catch)', async () => {
    mockProcessArtifactJob.mockRejectedValue(new Error('kaboom'))
    const db = new MockDb()
    db.runQueue.push(new Error('db down'))
    const m = msg(9)
    await (def as any).queue(batchOf(m), makeEnv({ DB: db }))
    expect(m.ack).toHaveBeenCalledTimes(1)
  })

  test('message 없는 에러는 unknown으로 기록한다 (|| 분기)', async () => {
    mockProcessArtifactJob.mockRejectedValue({})
    const db = new MockDb()
    const m = msg(9)
    const env = makeEnv({ DB: db })
    // bind 파라미터를 가로채기 위해 prepare 스파이
    const bound: any[] = []
    const origPrepare = db.prepare.bind(db)
    db.prepare = (sql: string) => {
      const stmt: any = origPrepare(sql)
      const origBind = stmt.bind
      stmt.bind = (...args: any[]) => { bound.push(args); return origBind(...args) }
      return stmt
    }
    await (def as any).queue(batchOf(m), env)
    expect(m.ack).toHaveBeenCalledTimes(1)
    expect(bound[0][0]).toBe('Consumer 오류: unknown')
    expect(bound[0][1]).toBe(9)
  })

  test('여러 메시지를 순차 처리한다', async () => {
    mockProcessArtifactJob.mockResolvedValue('done')
    const m1 = msg(1)
    const m2 = msg(2)
    await (def as any).queue({ messages: [m1, m2] } as any, makeEnv())
    expect(mockProcessArtifactJob).toHaveBeenCalledTimes(2)
    expect(m1.ack).toHaveBeenCalledTimes(1)
    expect(m2.ack).toHaveBeenCalledTimes(1)
  })
})
