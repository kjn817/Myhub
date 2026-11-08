/**
 * Google 라우트 커버리지 보강 — 성공 경로·실패 분기·revoked 토큰·기본값
 * Hono app.request + FakeD1 + 전역 fetch 모의 사용. 실제 Google API 호출 없음.
 */
import { googleApp } from '../src/modules/google/routes'
import { saveGoogleTokens, getGoogleTokens } from '../src/services/google-tokens'
import { FakeD1, asD1 } from './fake-d1'

const KEY = 'test-google-encryption-key'
const READONLY_SCOPE =
  'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly'
const WRITE_SCOPE = `${READONLY_SCOPE} https://www.googleapis.com/auth/calendar.events`

function fakeKV() {
  const store = new Map<string, string>()
  return {
    store,
    async get(key: string) { return store.get(key) ?? null },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
}

function makeEnv() {
  const fake = new FakeD1()
  const kv = fakeKV()
  const env: any = {
    DB: asD1(fake),
    KV: kv,
    MEMO_ENCRYPTION_KEY: KEY,
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-secret',
  }
  return { fake, kv, env }
}

async function call(env: any, path: string, init?: RequestInit) {
  return googleApp.request(path, init, env)
}

function b64url(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const realFetch = global.fetch
let fetchCalls: Array<{ url: string; init?: RequestInit }> = []

function installFetch(handler: (url: string, init?: RequestInit) => Response) {
  fetchCalls = []
  global.fetch = (async (url: any, init?: any) => {
    fetchCalls.push({ url: String(url), init })
    return handler(String(url), init)
  }) as unknown as typeof fetch
}

afterEach(() => {
  global.fetch = realFetch
})

async function seedConnected(env: any, scope: string = READONLY_SCOPE, expiresIn: number = 3600) {
  await saveGoogleTokens(env, {
    email: 'user@example.com',
    accessToken: 'at-valid',
    refreshToken: 'rt-1',
    scope,
    expiresIn,
  })
}

/** 만료 + refresh 없음 → getValidAccessToken이 revoked를 반환한다. */
async function seedRevoked(env: any) {
  await saveGoogleTokens(env, {
    email: 'user@example.com',
    accessToken: 'at-old',
    refreshToken: '',
    scope: READONLY_SCOPE,
    expiresIn: 0,
  })
}

function gmailCalendarFetch(opts: { failList?: boolean; failMessage?: boolean; longBody?: boolean } = {}) {
  return (url: string, init?: RequestInit) => {
    if (url.includes('/gmail/v1/users/me/messages?')) {
      if (opts.failList) return new Response(JSON.stringify({ error: 'x' }), { status: 500 })
      return new Response(JSON.stringify({ messages: [{ id: 'm1' }, { id: 'm2' }] }), { status: 200 })
    }
    if (url.includes('/gmail/v1/users/me/messages/m1')) {
      if (opts.failMessage) return new Response(JSON.stringify({ error: 'x' }), { status: 500 })
      const body = opts.longBody ? '본문'.repeat(3000) : '첫 번째 본문'
      return new Response(
        JSON.stringify({
          id: 'm1',
          threadId: 't1',
          snippet: '스니펫1',
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: 'a@x.com' },
              { name: 'Subject', value: '제목1' },
              { name: 'Date', value: 'Mon, 26 Oct 2026 10:00:00 +0900' },
            ],
            body: { data: b64url(body) },
          },
        }),
        { status: 200 },
      )
    }
    if (url.includes('/gmail/v1/users/me/messages/m2')) {
      return new Response(
        JSON.stringify({
          id: 'm2',
          threadId: 't2',
          snippet: '스니펫2',
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: 'b@x.com' },
              { name: 'Subject', value: '제목2' },
              { name: 'Date', value: 'Tue, 27 Oct 2026 10:00:00 +0900' },
            ],
            body: { data: b64url('두 번째 본문') },
          },
        }),
        { status: 200 },
      )
    }
    if (url.includes('/calendar/v3/calendars/primary/events') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      return new Response(
        JSON.stringify({ id: 'ev-new', summary: body.summary, start: body.start, end: body.end, status: 'confirmed' }),
        { status: 200 },
      )
    }
    if (url.includes('/calendar/v3/calendars/primary/events')) {
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'ev1',
              summary: '구글 회의',
              start: { dateTime: '2026-10-27T14:00:00+09:00' },
              end: { dateTime: '2026-10-27T15:00:00+09:00' },
              location: '강남',
              attendees: [{ email: 'a@x.com' }],
              status: 'confirmed',
            },
          ],
        }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
  }
}

/** SELECT(first)만 실패하는 DB — getGoogleTokens/getGoogleStatus는 던지고, run()은 동작한다. */
function selectThrowingDB(fake: FakeD1): D1Database {
  const db = asD1(fake) as any
  const origPrepare = db.prepare.bind(db)
  return {
    prepare(sql: string) {
      const stmt = origPrepare(sql)
      return {
        bind(...args: any[]) {
          const bound = stmt.bind(...args)
          return {
            run: bound.run.bind(bound),
            all: bound.all.bind(bound),
            async first(): Promise<null> { throw new Error('db down') },
          }
        },
      }
    },
  } as unknown as D1Database
}

describe('GET /status (추가)', () => {
  test('DB 장애 — getGoogleStatus 실패 시 connected:false, lastSync 빈 배열', async () => {
    const { fake, env } = makeEnv()
    env.DB = selectThrowingDB(fake)
    const res = await call(env, '/status')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.connected).toBe(false)
    expect(body.lastSync).toEqual([])
  })

  test('연동 + 동기화 로그 — lastSync 최신순 반환', async () => {
    const { fake, env } = makeEnv()
    await seedConnected(env)
    fake.tables.google_sync_log.push(
      { id: 1, provider: 'google', kind: 'calendar', status: 'ok', detail: 'events=2', created_at: '2026-10-26T00:00:00Z' },
      { id: 2, provider: 'google', kind: 'gmail', status: 'ok', detail: 'unread=1', created_at: '2026-10-26T00:01:00Z' },
    )
    const res = await call(env, '/status')
    const body = await res.json()
    expect(body.connected).toBe(true)
    expect(body.lastSync).toHaveLength(2)
    expect(body.lastSync[0].kind).toBe('gmail')
    expect(body.lastSync[1].kind).toBe('calendar')
  })
})

describe('GET /oauth/start (추가)', () => {
  test('KV 없음 — state 저장 실패 시 500 state_store_failed', async () => {
    const { env } = makeEnv()
    delete env.KV
    const res = await call(env, '/oauth/start?mode=read')
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('state_store_failed')
  })
})

describe('GET /oauth/callback (추가)', () => {
  test('code/state 누락 — 400 missing_code_or_state', async () => {
    const { env } = makeEnv()
    expect((await (await call(env, '/oauth/callback')).json()).error).toBe('missing_code_or_state')
    expect((await call(env, '/oauth/callback')).status).toBe(400)
    expect((await call(env, '/oauth/callback?code=abc')).status).toBe(400)
    expect((await call(env, '/oauth/callback?state=xyz')).status).toBe(400)
  })

  test('error=server_error — denied가 아닌 error로 복귀', async () => {
    const { env } = makeEnv()
    const res = await call(env, '/oauth/callback?error=server_error&state=x')
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('google=error')
  })

  test('토큰 교환 실패 — error로 복귀, 저장 안 함', async () => {
    const { fake, kv, env } = makeEnv()
    installFetch((url) => {
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      }
      return new Response(JSON.stringify({}), { status: 404 })
    })
    const start = await call(env, '/oauth/start?mode=read')
    const state = new URL(start.headers.get('Location') || '').searchParams.get('state') || ''
    expect(kv.store.size).toBe(1)
    const res = await call(env, `/oauth/callback?code=bad&state=${state}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('google=error')
    expect(fake.tables.google_integrations).toHaveLength(0)
  })

  test('프로필 조회 실패 — 이메일 빈 값으로 저장하고 연동 유지', async () => {
    const { fake, kv, env } = makeEnv()
    installFetch((url) => {
      if (url.includes('/token')) {
        return new Response(
          JSON.stringify({ access_token: 'at-cb', refresh_token: 'rt-cb', expires_in: 3600, scope: READONLY_SCOPE, token_type: 'Bearer' }),
          { status: 200 },
        )
      }
      if (url.includes('/users/me/profile')) {
        return new Response(JSON.stringify({ error: 'x' }), { status: 500 })
      }
      return new Response(JSON.stringify({}), { status: 404 })
    })
    const start = await call(env, '/oauth/start?mode=read')
    const state = new URL(start.headers.get('Location') || '').searchParams.get('state') || ''
    const res = await call(env, `/oauth/callback?code=code-1&state=${state}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('google=connected')
    expect(fake.tables.google_integrations).toHaveLength(1)
    expect(fake.tables.google_integrations[0].email).toBe('')
    expect((await getGoogleTokens(env))?.accessToken).toBe('at-cb')
    expect(kv.store.size).toBe(0)
  })

  test('토큰 응답에 refresh_token/scope/expires_in 없음 — 기본값으로 저장', async () => {
    const { env } = makeEnv()
    installFetch((url) => {
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ access_token: 'at-min', token_type: 'Bearer' }), { status: 200 })
      }
      if (url.includes('/users/me/profile')) {
        return new Response(JSON.stringify({ messagesTotal: 0 }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 404 })
    })
    const start = await call(env, '/oauth/start?mode=read')
    const state = new URL(start.headers.get('Location') || '').searchParams.get('state') || ''
    const before = Date.now()
    const res = await call(env, `/oauth/callback?code=code-1&state=${state}`)
    expect(res.headers.get('Location')).toContain('google=connected')
    const tokens = await getGoogleTokens(env)
    expect(tokens?.accessToken).toBe('at-min')
    expect(tokens?.refreshToken).toBe('')
    expect(tokens?.email).toBe('')
    expect(tokens?.scope).toBe(READONLY_SCOPE)
    // expires_in 기본값 3600초
    expect(tokens!.expiresAt).toBeGreaterThanOrEqual(before + 3599 * 1000)
    expect(tokens!.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000)
  })
})

describe('POST /disconnect (추가)', () => {
  test('refresh 없음·access만 있음 — revoke는 access token으로 호출', async () => {
    const { fake, env } = makeEnv()
    await saveGoogleTokens(env, {
      email: 'u@x.com',
      accessToken: 'at-only',
      refreshToken: '',
      scope: READONLY_SCOPE,
      expiresIn: 3600,
    })
    installFetch(() => new Response(JSON.stringify({}), { status: 200 }))
    const res = await call(env, '/disconnect', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(fake.tables.google_integrations).toHaveLength(0)
    const revokeCall = fetchCalls.find((c) => c.url.includes('/revoke'))
    expect(revokeCall).toBeDefined()
    expect(String(revokeCall!.init?.body)).toContain('token=at-only')
  })

  test('KV 마커 삭제 실패해도 200', async () => {
    const { fake, env } = makeEnv()
    await seedConnected(env)
    env.KV = {
      async get() { return null },
      async put() {},
      async delete() { throw new Error('kv down') },
    }
    installFetch(() => new Response(JSON.stringify({}), { status: 200 }))
    const res = await call(env, '/disconnect', { method: 'POST' })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(fake.tables.google_integrations).toHaveLength(0)
  })

  test('토큰 조회 실패(DB 장애)해도 로컬 삭제 수행·200', async () => {
    const { fake, env } = makeEnv()
    await seedConnected(env)
    env.DB = selectThrowingDB(fake)
    installFetch(() => new Response(JSON.stringify({}), { status: 200 }))
    const res = await call(env, '/disconnect', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(fake.tables.google_integrations).toHaveLength(0)
    expect(fetchCalls.some((c) => c.url.includes('/revoke'))).toBe(false)
  })
})

describe('GET /gmail/search (성공 경로)', () => {
  test('연동 시 목록 반환 — 기본 q=is:unread, max=10', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    installFetch(gmailCalendarFetch())
    const res = await call(env, '/gmail/search')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0]).toMatchObject({ id: 'm1', from: 'a@x.com', subject: '제목1' })
    expect(body.messages[1]).toMatchObject({ id: 'm2', from: 'b@x.com', subject: '제목2' })
    const listUrl = new URL(fetchCalls.find((c) => c.url.includes('/messages?'))!.url)
    expect(listUrl.searchParams.get('q')).toBe('is:unread')
    expect(listUrl.searchParams.get('maxResults')).toBe('10')
  })

  test('q·max 전달 — max는 10으로 클램프', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    installFetch(gmailCalendarFetch())
    const res = await call(env, '/gmail/search?q=%ED%9A%8C%EC%9D%98&max=99')
    expect(res.status).toBe(200)
    const listUrl = new URL(fetchCalls.find((c) => c.url.includes('/messages?'))!.url)
    expect(listUrl.searchParams.get('q')).toBe('회의')
    expect(listUrl.searchParams.get('maxResults')).toBe('10')
    const res2 = await call(env, '/gmail/search?q=x&max=3')
    expect(res2.status).toBe(200)
    const listUrl2 = new URL(fetchCalls.filter((c) => c.url.includes('/messages?')).pop()!.url)
    expect(listUrl2.searchParams.get('maxResults')).toBe('3')
  })

  test('API 실패 — 502', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    installFetch(gmailCalendarFetch({ failList: true }))
    const res = await call(env, '/gmail/search')
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe('google_api_error:500')
  })

  test('revoked 토큰 — 401 revoked', async () => {
    const { env } = makeEnv()
    await seedRevoked(env)
    installFetch(gmailCalendarFetch())
    const res = await call(env, '/gmail/search')
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('revoked')
  })
})

describe('GET /gmail/:id (성공 경로)', () => {
  test('단건 조회 — 본문 5000자 절단', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    installFetch(gmailCalendarFetch({ longBody: true }))
    const res = await call(env, '/gmail/m1')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.message.id).toBe('m1')
    expect(body.message.bodyText).toHaveLength(5000)
  })

  test('단건 조회 — 짧은 본문은 그대로', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    installFetch(gmailCalendarFetch())
    const res = await call(env, '/gmail/m1')
    const body = await res.json()
    expect(body.message.bodyText).toBe('첫 번째 본문')
  })

  test('API 실패 — 502', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    installFetch(gmailCalendarFetch({ failMessage: true }))
    const res = await call(env, '/gmail/m1')
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe('google_api_error:500')
  })

  test('미연동 — 401 google_not_connected', async () => {
    const { env } = makeEnv()
    installFetch(gmailCalendarFetch())
    const res = await call(env, '/gmail/m1')
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('google_not_connected')
  })

  test('revoked 토큰 — 401 revoked', async () => {
    const { env } = makeEnv()
    await seedRevoked(env)
    installFetch(gmailCalendarFetch())
    const res = await call(env, '/gmail/m1')
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('revoked')
  })
})

describe('GET /calendar/events (성공 경로)', () => {
  test('연동 시 이벤트 반환 — 기본 from/to는 오늘(KST)', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    installFetch(gmailCalendarFetch())
    const res = await call(env, '/calendar/events')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.events).toHaveLength(1)
    expect(body.events[0]).toMatchObject({ id: 'ev1', summary: '구글 회의' })
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const listUrl = new URL(fetchCalls.find((c) => c.url.includes('/calendars/primary/events'))!.url)
    expect(listUrl.searchParams.get('timeMin')).toBe(`${today}T00:00:00+09:00`)
    expect(listUrl.searchParams.get('timeMax')).toBe(`${today}T23:59:59+09:00`)
  })

  test('from만 지정 — to는 from과 동일', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    installFetch(gmailCalendarFetch())
    const res = await call(env, '/calendar/events?from=2026-10-27')
    expect(res.status).toBe(200)
    const listUrl = new URL(fetchCalls.find((c) => c.url.includes('/calendars/primary/events'))!.url)
    expect(listUrl.searchParams.get('timeMin')).toBe('2026-10-27T00:00:00+09:00')
    expect(listUrl.searchParams.get('timeMax')).toBe('2026-10-27T23:59:59+09:00')
  })

  test('from/to 지정 — 그대로 사용', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    installFetch(gmailCalendarFetch())
    const res = await call(env, '/calendar/events?from=2026-10-27&to=2026-10-28')
    expect(res.status).toBe(200)
    const listUrl = new URL(fetchCalls.find((c) => c.url.includes('/calendars/primary/events'))!.url)
    expect(listUrl.searchParams.get('timeMin')).toBe('2026-10-27T00:00:00+09:00')
    expect(listUrl.searchParams.get('timeMax')).toBe('2026-10-28T23:59:59+09:00')
  })

  test('API 실패 — 502', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    installFetch(() => new Response(JSON.stringify({ error: 'x' }), { status: 500 }))
    const res = await call(env, '/calendar/events?from=2026-10-27&to=2026-10-27')
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe('google_api_error:500')
  })

  test('revoked 토큰 — 401 revoked', async () => {
    const { env } = makeEnv()
    await seedRevoked(env)
    installFetch(gmailCalendarFetch())
    const res = await call(env, '/calendar/events?from=2026-10-27&to=2026-10-27')
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('revoked')
  })
})

describe('POST /calendar/events (성공 경로)', () => {
  function postJson(env: any, body: unknown) {
    return call(env, '/calendar/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  }

  test('미연동 — 401 google_not_connected', async () => {
    const { env } = makeEnv()
    installFetch(gmailCalendarFetch())
    const res = await postJson(env, { summary: '치과', start: '2026-10-27T15:00:00' })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('google_not_connected')
  })

  test('revoked 토큰 — 401 revoked', async () => {
    const { env } = makeEnv()
    await seedRevoked(env)
    installFetch(gmailCalendarFetch())
    const res = await postJson(env, { summary: '치과', start: '2026-10-27T15:00:00' })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('revoked')
  })

  test('invalid_input — summary/start 누락·공백·비문자열', async () => {
    const { env } = makeEnv()
    await seedConnected(env, WRITE_SCOPE)
    installFetch(gmailCalendarFetch())
    for (const bad of [
      {},
      { summary: '치과' },
      { start: '2026-10-27T15:00:00' },
      { summary: '   ', start: '2026-10-27T15:00:00' },
      { summary: 123, start: '2026-10-27T15:00:00' },
      { summary: '치과', start: 123 },
    ]) {
      const res = await postJson(env, bad)
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('invalid_input')
    }
  })

  test('잘못된 JSON 본문 — invalid_input', async () => {
    const { env } = makeEnv()
    await seedConnected(env, WRITE_SCOPE)
    installFetch(gmailCalendarFetch())
    const res = await postJson(env, '{bad json')
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_input')
  })

  test('쓰기 scope면 생성 성공 — end/description/location 전달', async () => {
    const { env } = makeEnv()
    await seedConnected(env, WRITE_SCOPE)
    installFetch(gmailCalendarFetch())
    const res = await postJson(env, {
      summary: '  치과  ',
      start: '2026-10-27T15:00:00',
      end: '2026-10-27T16:00:00',
      description: '정기 검진',
      location: '강남역',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.event).toMatchObject({ id: 'ev-new', summary: '치과' })
    const postCall = fetchCalls.find((c) => c.init?.method === 'POST')!
    const sent = JSON.parse(String(postCall.init?.body))
    expect(sent.summary).toBe('치과')
    expect(sent.start).toEqual({ dateTime: '2026-10-27T15:00:00', timeZone: 'Asia/Seoul' })
    expect(sent.end).toEqual({ dateTime: '2026-10-27T16:00:00', timeZone: 'Asia/Seoul' })
    expect(sent.description).toBe('정기 검진')
    expect(sent.location).toBe('강남역')
  })

  test('선택 필드 생략 — end는 start로, description/location 미전송', async () => {
    const { env } = makeEnv()
    await seedConnected(env, WRITE_SCOPE)
    installFetch(gmailCalendarFetch())
    const res = await postJson(env, { summary: '치과', start: '2026-10-27T15:00:00' })
    expect(res.status).toBe(200)
    const postCall = fetchCalls.find((c) => c.init?.method === 'POST')!
    const sent = JSON.parse(String(postCall.init?.body))
    expect(sent.end).toEqual({ dateTime: '2026-10-27T15:00:00', timeZone: 'Asia/Seoul' })
    expect('description' in sent).toBe(false)
    expect('location' in sent).toBe(false)
  })

  test('API 실패 — 502', async () => {
    const { env } = makeEnv()
    await seedConnected(env, WRITE_SCOPE)
    installFetch((url, init) => {
      if (url.includes('/calendars/primary/events') && init?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'x' }), { status: 500 })
      }
      return new Response(JSON.stringify({}), { status: 404 })
    })
    const res = await postJson(env, { summary: '치과', start: '2026-10-27T15:00:00' })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe('google_api_error:500')
  })
})
