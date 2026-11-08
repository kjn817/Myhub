/**
 * Google 서비스 커버리지 보강 — google-client / google-tokens / google-tools /
 * google-sync / google-oauth 의 미커버 라인·분기
 * FakeD1 + 모의 fetch + 메모리 KV 사용. 실제 Google API 호출·실제 OAuth 없음.
 */
import {
  listGmailMessages,
  getGmailMessage,
  listCalendarEvents,
  createCalendarEvent,
  getGmailProfile,
} from '../src/services/google-client'
import {
  saveGoogleTokens,
  getGoogleTokens,
  getGoogleStatus,
  getValidAccessToken,
  setGoogleTokenStatus,
} from '../src/services/google-tokens'
import { encryptContent } from '../src/services/crypto'
import {
  parseGoogleMarkers,
  executeGmailSearch,
  executeGmailGet,
  executeGcalList,
  executeGcalCreate,
} from '../src/services/google-tools'
import { syncGoogleNow, getLastSyncLog } from '../src/services/google-sync'
import {
  exchangeCodeForTokens,
  refreshAccessToken,
  revokeToken,
  consumeOAuthState,
  redirectUriFor,
  buildAuthUrl,
} from '../src/services/google-oauth'
import { FakeD1, asD1 } from './fake-d1'

const KEY = 'test-google-encryption-key'
const READONLY_SCOPE =
  'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly'
const WRITE_SCOPE = `${READONLY_SCOPE} https://www.googleapis.com/auth/calendar.events`
const NOW = 1_790_000_000_000

function b64url(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

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
  const env: any = {
    DB: asD1(fake),
    KV: fakeKV(),
    MEMO_ENCRYPTION_KEY: KEY,
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'csec',
  }
  return { fake, env }
}

async function seedConnected(env: any, scope: string = READONLY_SCOPE, expiresInSec: number = 3600) {
  await saveGoogleTokens(env, {
    email: 'user@example.com',
    accessToken: 'at-valid',
    refreshToken: 'rt-1',
    scope,
    expiresIn: expiresInSec,
  })
}

function jsonFetch(body: any, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
}

/** 특정 SQL 접두사에만 실패를 주입하는 DB 래퍼 (그 외는 FakeD1에 위임). */
function failingSqlDB(fake: FakeD1, match: (sql: string) => boolean): D1Database {
  const db = asD1(fake) as any
  const origPrepare = db.prepare.bind(db)
  const throwing = {
    bind() {
      return {
        async run(): Promise<never> { throw new Error('db down') },
        async all(): Promise<never> { throw new Error('db down') },
        async first(): Promise<never> { throw new Error('db down') },
      }
    },
  }
  return {
    prepare(sql: string) {
      if (match(String(sql))) return throwing
      return origPrepare(sql)
    },
  } as unknown as D1Database
}

function googleApiFetch(): typeof fetch {
  return (async (url: any, init?: any) => {
    const u = String(url)
    if (u.includes('/gmail/v1/users/me/messages?')) {
      return new Response(JSON.stringify({ messages: [{ id: 'msg1' }] }), { status: 200 })
    }
    if (u.includes('/gmail/v1/users/me/messages/msg1')) {
      return new Response(
        JSON.stringify({
          id: 'msg1',
          threadId: 't',
          snippet: '스니펫',
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: 'boss@company.com' },
              { name: 'Subject', value: '내일 회의' },
              { name: 'Date', value: 'Mon, 26 Oct 2026' },
            ],
            body: { data: b64url('내일 10시 회의입니다.') },
          },
        }),
        { status: 200 },
      )
    }
    if (u.includes('/calendar/v3/calendars/primary/events') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      return new Response(
        JSON.stringify({ id: 'ev-new', summary: body.summary, start: body.start, end: body.end }),
        { status: 200 },
      )
    }
    if (u.includes('/calendar/v3/calendars/primary/events')) {
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
  }) as unknown as typeof fetch
}

describe('google-client 커버리지', () => {
  test('invalid_json — 200인데 JSON 파싱 실패', async () => {
    const badJson = (async () => new Response('not-json', { status: 200 })) as unknown as typeof fetch
    const res = await getGmailProfile(badJson, 'token')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBe('invalid_json')
      expect(res.unauthorized).toBe(false)
    }
  })

  test('base64 디코딩 실패 — 본문은 스니펫으로 대체', async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          id: 'm1',
          threadId: 't',
          snippet: '대체 스니펫',
          payload: {
            mimeType: 'text/plain',
            headers: [{ name: 'From', value: 'a@b.com' }],
            body: { data: '!!!not-base64!!!' },
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch
    const res = await getGmailMessage(fetchFn, 'token', 'm1', true)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.bodyText).toBe('대체 스니펫')
  })

  test('중첩 parts — multipart 안의 text/plain 본문 추출', async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          id: 'm1',
          threadId: 't',
          snippet: '스니펫',
          payload: {
            mimeType: 'multipart/mixed',
            headers: [{ name: 'From', value: 'a@b.com' }, { name: 'Subject', value: '중첩' }],
            parts: [
              {
                mimeType: 'multipart/alternative',
                parts: [
                  { mimeType: 'text/html', body: { data: b64url('<p>html</p>') } },
                  { mimeType: 'text/plain', body: { data: b64url('중첩 본문') } },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch
    const res = await getGmailMessage(fetchFn, 'token', 'm1', true)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.bodyText).toBe('중첩 본문')
  })

  test('중첩 parts에 text/plain 없음 — 스니펫으로 대체', async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          id: 'm1',
          threadId: 't',
          snippet: '스니펫만',
          payload: {
            mimeType: 'multipart/mixed',
            headers: [],
            parts: [
              {
                mimeType: 'multipart/alternative',
                parts: [{ mimeType: 'text/html', body: { data: b64url('<p>html</p>') } }],
              },
            ],
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch
    const res = await getGmailMessage(fetchFn, 'token', 'm1', true)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.bodyText).toBe('스니펫만')
  })

  test('payload 없음 — 빈 필드·빈 본문', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ id: 'm9', snippet: 's' }), { status: 200 })) as unknown as typeof fetch
    const res = await getGmailMessage(fetchFn, 'token', 'm9', true)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data).toMatchObject({ id: 'm9', from: '', subject: '', date: '', bodyText: 's' })
    }
  })

  test('단건 조회 401 — unauthorized 구분', async () => {
    const fetchFn = jsonFetch({ error: 'unauthorized' }, 401)
    const res = await getGmailMessage(fetchFn, 'token', 'm1', true)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBe('unauthorized')
      expect(res.unauthorized).toBe(true)
    }
  })

  test('listGmailMessages maxResults 클램프 — 999→10, 0→1, 기본 10', async () => {
    const urls: string[] = []
    const fetchFn = (async (url: any) => {
      urls.push(String(url))
      return new Response(JSON.stringify({ messages: [] }), { status: 200 })
    }) as unknown as typeof fetch
    await listGmailMessages(fetchFn, 'token', { maxResults: 999 })
    expect(new URL(urls[0]).searchParams.get('maxResults')).toBe('10')
    await listGmailMessages(fetchFn, 'token', { maxResults: 0 })
    expect(new URL(urls[1]).searchParams.get('maxResults')).toBe('1')
    await listGmailMessages(fetchFn, 'token', {})
    expect(new URL(urls[2]).searchParams.get('maxResults')).toBe('10')
  })

  test('목록에 messages 필드 없음 — 빈 배열', async () => {
    const res = await listGmailMessages(jsonFetch({}), 'token')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toEqual([])
  })

  test('목록 단건 조회 실패는 제외하고 나머지만 반환', async () => {
    const fetchFn = (async (url: any) => {
      const u = String(url)
      if (u.includes('/messages?')) {
        return new Response(JSON.stringify({ messages: [{ id: 'm1' }, { id: 'm2' }] }), { status: 200 })
      }
      if (u.includes('/messages/m1')) {
        return new Response(
          JSON.stringify({
            id: 'm1', snippet: 's', payload: { mimeType: 'text/plain', headers: [], body: { data: b64url('본문') } },
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ error: 'x' }), { status: 404 })
    }) as unknown as typeof fetch
    const res = await listGmailMessages(fetchFn, 'token')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data).toHaveLength(1)
      expect(res.data[0].id).toBe('m1')
    }
  })

  test('listCalendarEvents maxResults 클램프 — 500→100', async () => {
    let captured = ''
    const fetchFn = (async (url: any) => {
      captured = String(url)
      return new Response(JSON.stringify({ items: [] }), { status: 200 })
    }) as unknown as typeof fetch
    const res = await listCalendarEvents(fetchFn, 'token', { timeMin: 'x', timeMax: 'y', maxResults: 500 })
    expect(res.ok).toBe(true)
    expect(new URL(captured).searchParams.get('maxResults')).toBe('100')
  })

  test('createCalendarEvent 실패 — google_api_error 반환', async () => {
    const fetchFn = jsonFetch({ error: 'x' }, 500)
    const res = await createCalendarEvent(fetchFn, 'token', { summary: '회의', start: '2026-10-27T15:00:00' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('google_api_error:500')
  })

  test('createCalendarEvent — location 전달, end 생략 시 start로', async () => {
    let captured: any = null
    const fetchFn = (async (_url: any, init?: any) => {
      captured = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ id: 'ev1', summary: captured.summary, start: captured.start, end: captured.end }), { status: 200 })
    }) as unknown as typeof fetch
    const res = await createCalendarEvent(fetchFn, 'token', {
      summary: '회의',
      start: '2026-10-27T15:00:00',
      location: '서울',
    })
    expect(res.ok).toBe(true)
    expect(captured.location).toBe('서울')
    expect(captured.end.dateTime).toBe('2026-10-27T15:00:00')
  })
})

describe('google-tokens 커버리지', () => {
  test('평문 access_token 행 — 복호화 실패 취급, 조회 null', async () => {
    const { fake, env } = makeEnv()
    fake.tables.google_integrations.push({
      provider: 'google',
      email: 'u@x.com',
      access_token: 'plaintext-token',
      refresh_token: '',
      scope: READONLY_SCOPE,
      expires_at: Date.now() + 3600_000,
      status: 'active',
    })
    expect(await getGoogleTokens(env)).toBeNull()
  })

  test('손상된 ENC: 암호문 — 복호화 예외 시 조회 null, 상태는 error', async () => {
    const { fake, env } = makeEnv()
    fake.tables.google_integrations.push({
      provider: 'google',
      email: 'u@x.com',
      access_token: 'ENC:!!!corrupted!!!',
      refresh_token: '',
      scope: READONLY_SCOPE,
      expires_at: Date.now() + 3600_000,
      status: 'active',
    })
    expect(await getGoogleTokens(env)).toBeNull()
    const status = await getGoogleStatus(env)
    expect(status).toEqual({ connected: false, status: 'error' })
  })

  test("status 'error' 행 — 조회 시 status 유지, 상태 요약은 connected:true", async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    await setGoogleTokenStatus(env, 'error')
    const tokens = await getGoogleTokens(env)
    expect(tokens?.status).toBe('error')
    expect(tokens?.accessToken).toBe('at-valid')
    const status = await getGoogleStatus(env)
    expect(status.connected).toBe(true)
    expect(status.status).toBe('error')
  })

  test('refreshToken 빈 값 저장 — 조회 시 빈 문자열', async () => {
    const { env } = makeEnv()
    await saveGoogleTokens(env, {
      email: 'u@x.com',
      accessToken: 'at-1',
      refreshToken: '',
      scope: READONLY_SCOPE,
      expiresIn: 3600,
    })
    expect((await getGoogleTokens(env))?.refreshToken).toBe('')
  })

  test('이메일·scope 빈 값 — 상태 요약에서 undefined', async () => {
    const { env } = makeEnv()
    await saveGoogleTokens(env, {
      email: '',
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      scope: '',
      expiresIn: 3600,
    })
    const status = await getGoogleStatus(env)
    expect(status.connected).toBe(true)
    expect(status.email).toBeUndefined()
    expect(status.scope).toBeUndefined()
    expect(status.expiresAt).toBeGreaterThan(Date.now())
  })

  test('동시 갱신 경합 — 다른 호출이 먼저 갱신하면 저장된 새 토큰 반환', async () => {
    const { fake, env } = makeEnv()
    await seedConnected(env, READONLY_SCOPE, 0) // 만료됨
    const encConcurrent = await encryptContent(env, 'at-concurrent')
    const fetchFn = (async () => {
      // refresh 응답이 오기 전 다른 호출이 먼저 갱신한 것처럼 행을 교체
      const row = fake.tables.google_integrations[0]
      row.access_token = encConcurrent
      row.expires_at = Date.now() + 3600_000
      row.status = 'active'
      return new Response(JSON.stringify({ access_token: 'at-fresh', expires_in: 3600, token_type: 'Bearer' }), { status: 200 })
    }) as unknown as typeof fetch
    const res = await getValidAccessToken(fetchFn, env)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.accessToken).toBe('at-concurrent')
      expect(res.tokens.accessToken).toBe('at-concurrent')
    }
  })

  test('동시 갱신 경합 — 다시 읽은 행이 없으면 refresh_failed', async () => {
    const { fake, env } = makeEnv()
    await seedConnected(env, READONLY_SCOPE, 0)
    const fetchFn = (async () => {
      fake.tables.google_integrations = []
      return new Response(JSON.stringify({ access_token: 'at-fresh', expires_in: 3600, token_type: 'Bearer' }), { status: 200 })
    }) as unknown as typeof fetch
    const res = await getValidAccessToken(fetchFn, env)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('refresh_failed')
  })

  test('동시 갱신 경합 — 다시 읽은 토큰도 만료됐으면 refresh_failed', async () => {
    const { fake, env } = makeEnv()
    await seedConnected(env, READONLY_SCOPE, 0)
    const encStale = await encryptContent(env, 'at-stale')
    const fetchFn = (async () => {
      const row = fake.tables.google_integrations[0]
      row.access_token = encStale
      row.expires_at = Date.now() - 1000
      return new Response(JSON.stringify({ access_token: 'at-fresh', expires_in: 3600, token_type: 'Bearer' }), { status: 200 })
    }) as unknown as typeof fetch
    const res = await getValidAccessToken(fetchFn, env)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('refresh_failed')
  })
})

describe('google-tools 커버리지', () => {
  test('executeGmailSearch — 401은 revoked, 500은 api_error', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    const res401 = await executeGmailSearch(env, { q: '회의' }, jsonFetch({ error: 'unauthorized' }, 401))
    expect(res401.success).toBe(false)
    if (!res401.success) expect(res401.error).toBe('revoked')
    const res500 = await executeGmailSearch(env, { q: '회의' }, jsonFetch({ error: 'x' }, 500))
    expect(res500.success).toBe(false)
    if (!res500.success) expect(res500.error).toBe('api_error')
  })

  test('executeGmailGet — id 없음은 invalid_input, 미연동은 not_connected', async () => {
    const { env } = makeEnv()
    const noId = await executeGmailGet(env, {}, googleApiFetch())
    expect(noId.success).toBe(false)
    if (!noId.success) expect(noId.error).toBe('invalid_input')
    const notConnected = await executeGmailGet(env, { id: 'msg1' }, googleApiFetch())
    expect(notConnected.success).toBe(false)
    if (!notConnected.success) expect(notConnected.error).toBe('not_connected')
  })

  test('executeGmailGet — 401은 revoked, 500은 api_error', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    const res401 = await executeGmailGet(env, { id: 'msg1' }, jsonFetch({ error: 'unauthorized' }, 401))
    expect(res401.success).toBe(false)
    if (!res401.success) expect(res401.error).toBe('revoked')
    const res500 = await executeGmailGet(env, { id: 'msg1' }, jsonFetch({ error: 'x' }, 500))
    expect(res500.success).toBe(false)
    if (!res500.success) expect(res500.error).toBe('api_error')
  })

  test('executeGcalCreate — 401은 revoked, 500은 api_error', async () => {
    const { env } = makeEnv()
    await seedConnected(env, WRITE_SCOPE)
    const res401 = await executeGcalCreate(
      env,
      { title: '치과', start_at: '2026-10-27T15:00:00' },
      jsonFetch({ error: 'unauthorized' }, 401),
    )
    expect(res401.success).toBe(false)
    if (!res401.success) expect(res401.error).toBe('revoked')
    const res500 = await executeGcalCreate(
      env,
      { title: '치과', start_at: '2026-10-27T15:00:00' },
      jsonFetch({ error: 'x' }, 500),
    )
    expect(res500.success).toBe(false)
    if (!res500.success) expect(res500.error).toBe('api_error')
  })

  test('executeGcalList — 로컬 일정 조회 실패해도 구글 일정 반환', async () => {
    const { fake, env } = makeEnv()
    await seedConnected(env)
    env.DB = failingSqlDB(fake, (sql) => sql.includes('FROM schedules'))
    const res = await executeGcalList(env, { from: '2026-10-27', to: '2026-10-27' }, googleApiFetch())
    expect(res.success).toBe(true)
    expect(res.googleConnected).toBe(true)
    expect(res.data).toHaveLength(1)
    expect(res.data[0]).toMatchObject({ source: 'google', title: '구글 회의' })
  })

  test('executeGcalList — from/to 생략 시 오늘(KST) 기준', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    let captured = ''
    const fetchFn = (async (url: any) => {
      captured = String(url)
      return new Response(JSON.stringify({ items: [] }), { status: 200 })
    }) as unknown as typeof fetch
    const res = await executeGcalList(env, {}, fetchFn)
    expect(res.success).toBe(true)
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const url = new URL(captured)
    expect(url.searchParams.get('timeMin')).toBe(`${today}T00:00:00+09:00`)
    expect(url.searchParams.get('timeMax')).toBe(`${today}T23:59:59+09:00`)
  })

  test('parseGoogleMarkers — null JSON·비문자열 필드·공백 제목은 무시', () => {
    expect(parseGoogleMarkers('[GMAIL_SEARCH]null[/GMAIL_SEARCH]')).toHaveLength(0)
    expect(parseGoogleMarkers('[GMAIL_SEARCH]{"q": 123}[/GMAIL_SEARCH]')).toEqual([
      expect.objectContaining({ action: 'gmail_search', data: { q: undefined } }),
    ])
    expect(parseGoogleMarkers('[GCAL_CREATE]{"title": "   ", "start_at": "2026-10-27T15:00:00"}[/GCAL_CREATE]')).toHaveLength(0)
    expect(parseGoogleMarkers('[GCAL_LIST]{"from": 20261027, "to": null}[/GCAL_LIST]')).toEqual([
      expect.objectContaining({ action: 'gcal_list', data: { from: undefined, to: undefined } }),
    ])
    expect(parseGoogleMarkers('[GMAIL_GET]{"id": ""}[/GMAIL_GET]')).toHaveLength(0)
    expect(parseGoogleMarkers('[GMAIL_GET]{"id": 42}[/GMAIL_GET]')).toHaveLength(0)
  })
})

describe('google-sync 커버리지', () => {
  test('KV.get 실패 — 간격 제어 건너뛰고 실행', async () => {
    const { fake, env } = makeEnv()
    await seedConnected(env)
    env.KV = {
      async get(): Promise<never> { throw new Error('kv down') },
      async put() {},
      async delete() {},
    }
    const res = await syncGoogleNow(googleApiFetch(), env, { now: NOW })
    expect(res.ran).toBe(true)
    expect(fake.tables.google_sync_log).toHaveLength(2)
  })

  test('KV.put 실패 — 마커 저장 무시, 실행은 성공', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    env.KV = {
      async get() { return null },
      async put(): Promise<never> { throw new Error('kv down') },
      async delete() {},
    }
    const res = await syncGoogleNow(googleApiFetch(), env, { now: NOW })
    expect(res.ran).toBe(true)
    expect(res.calendarCount).toBe(1)
    expect(res.unreadCount).toBe(1)
  })

  test('KV에 숫자가 아닌 마커 — 0으로 취급해 실행', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    const kv = fakeKV()
    kv.store.set('google:sync:last', 'not-a-number')
    env.KV = kv
    const res = await syncGoogleNow(googleApiFetch(), env, { now: NOW })
    expect(res.ran).toBe(true)
  })

  test('Gmail 실패(캘린더 성공 후) — failed 로그 + api_error', async () => {
    const { fake, env } = makeEnv()
    await seedConnected(env)
    const fetchFn = (async (url: any) => {
      const u = String(url)
      if (u.includes('/calendar/v3/calendars/primary/events')) {
        return new Response(JSON.stringify({ items: [{ id: 'e1' }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: 'x' }), { status: 500 })
    }) as unknown as typeof fetch
    const res = await syncGoogleNow(fetchFn, env, { now: NOW })
    expect(res).toEqual({ ran: false, reason: 'api_error' })
    expect(fake.tables.google_sync_log).toHaveLength(2)
    expect(fake.tables.google_sync_log[0]).toMatchObject({ kind: 'calendar', status: 'ok' })
    expect(fake.tables.google_sync_log[1]).toMatchObject({ kind: 'gmail', status: 'failed' })
  })

  test('getLastSyncLog DB 장애 — 빈 배열', async () => {
    const { env } = makeEnv()
    env.DB = { prepare(): never { throw new Error('db down') } } as unknown as D1Database
    expect(await getLastSyncLog(env)).toEqual([])
  })

  test('로그 저장 실패해도 동기화는 성공 (fail-soft)', async () => {
    const { fake, env } = makeEnv()
    await seedConnected(env)
    env.DB = failingSqlDB(fake, (sql) => sql.startsWith('INSERT INTO google_sync_log'))
    const res = await syncGoogleNow(googleApiFetch(), env, { now: NOW })
    expect(res.ran).toBe(true)
    expect(res.calendarCount).toBe(1)
    expect(res.unreadCount).toBe(1)
    expect(fake.tables.google_sync_log).toHaveLength(0)
  })

  test('revoked 토큰 — ran:false, reason revoked', async () => {
    const { env } = makeEnv()
    await saveGoogleTokens(env, {
      email: 'u@x.com',
      accessToken: 'at-old',
      refreshToken: '',
      scope: READONLY_SCOPE,
      expiresIn: 0,
    })
    const res = await syncGoogleNow(googleApiFetch(), env, { now: NOW })
    expect(res).toEqual({ ran: false, reason: 'revoked' })
  })

  test('refresh 실패 — ran:false, reason refresh_failed', async () => {
    const { env } = makeEnv()
    await seedConnected(env, READONLY_SCOPE, 0)
    const res = await syncGoogleNow(jsonFetch({ error: 'server_error' }, 500), env, { now: NOW })
    expect(res).toEqual({ ran: false, reason: 'refresh_failed' })
  })
})

describe('google-oauth 커버리지', () => {
  const ENV = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec' }

  test('postForm JSON 파싱 실패 — exchange는 token_exchange_failed:200', async () => {
    const badJson = (async () => new Response('not-json', { status: 200 })) as unknown as typeof fetch
    const res = await exchangeCodeForTokens(badJson, ENV, { code: 'c', verifier: 'v', redirectUri: 'https://x/cb' })
    expect(res).toEqual({ ok: false, error: 'token_exchange_failed:200' })
  })

  test('postForm JSON 파싱 실패 — refresh는 token_refresh_failed:200, invalidGrant false', async () => {
    const badJson = (async () => new Response('not-json', { status: 200 })) as unknown as typeof fetch
    const res = await refreshAccessToken(badJson, ENV, 'rt-1')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBe('token_refresh_failed:200')
      expect(res.invalidGrant).toBe(false)
    }
  })

  test('postForm JSON 파싱 실패해도 revoke는 ok 상태만으로 true', async () => {
    const badJson = (async () => new Response('garbage', { status: 200 })) as unknown as typeof fetch
    expect(await revokeToken(badJson, 't')).toBe(true)
  })

  test('exchange 실패 + JSON 파싱 실패 — token_exchange_failed:400', async () => {
    const badJson = (async () => new Response('not-json', { status: 400 })) as unknown as typeof fetch
    const res = await exchangeCodeForTokens(badJson, ENV, { code: 'c', verifier: 'v', redirectUri: 'https://x/cb' })
    expect(res).toEqual({ ok: false, error: 'token_exchange_failed:400' })
  })

  test('consumeOAuthState — mode가 read/write가 아니거나 verifier가 비어 있으면 null', async () => {
    const kv = fakeKV()
    const env = { ...ENV, KV: kv as unknown as KVNamespace }
    kv.store.set('google:oauth:state:badmode', JSON.stringify({ verifier: 'v', mode: 'bogus', createdAt: 0 }))
    expect(await consumeOAuthState(env, 'badmode')).toBeNull()
    kv.store.set('google:oauth:state:noverifier', JSON.stringify({ verifier: '', mode: 'read', createdAt: 0 }))
    expect(await consumeOAuthState(env, 'noverifier')).toBeNull()
    kv.store.set('google:oauth:state:noverifier2', JSON.stringify({ mode: 'read', createdAt: 0 }))
    expect(await consumeOAuthState(env, 'noverifier2')).toBeNull()
  })

  test('redirectUriFor — origin 끝 슬래시 제거', () => {
    expect(redirectUriFor('https://example.workers.dev/')).toBe('https://example.workers.dev/api/google/oauth/callback')
    expect(redirectUriFor('https://example.workers.dev')).toBe('https://example.workers.dev/api/google/oauth/callback')
  })

  test('buildAuthUrl — client id 없으면 빈 문자열', () => {
    const url = new URL(buildAuthUrl({}, { origin: 'https://x.dev', mode: 'read', state: 's', challenge: 'c' }))
    expect(url.searchParams.get('client_id')).toBe('')
  })
})

describe('브랜치 보강 2차', () => {
  test('google-client — parts 없는 multipart payload은 빈 본문(스니펫 대체)', async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          id: 'm1',
          threadId: 't',
          snippet: '스니펫만',
          payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'a@b.com' }] },
        }),
        { status: 200 },
      )) as unknown as typeof fetch
    const res = await getGmailMessage(fetchFn, 'token', 'm1', true)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.bodyText).toBe('스니펫만')
  })

  test('google-client — 빈 원문은 id/threadId/snippet 모두 빈 문자열', async () => {
    const fetchFn = jsonFetch({})
    const res = await getGmailMessage(fetchFn, 'token', 'm1', true)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data).toMatchObject({ id: '', threadId: '', from: '', subject: '', date: '', snippet: '', bodyText: '' })
    }
  })

  test('google-client — withBody 기본값 true로 본문 추출', async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          id: 'm1',
          threadId: 't',
          snippet: '스니펫',
          payload: {
            mimeType: 'text/plain',
            headers: [{ name: 'From', value: 'a@b.com' }],
            body: { data: b64url('기본값 본문') },
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch
    const res = await getGmailMessage(fetchFn, 'token', 'm1')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.bodyText).toBe('기본값 본문')
  })

  test('google-client — 캘린더 items 없음은 빈 배열', async () => {
    const res = await listCalendarEvents(jsonFetch({}), 'token', { timeMin: 'x', timeMax: 'y' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toEqual([])
  })

  test('google-oauth — randomToken() 기본 32바이트', async () => {
    const { randomToken } = await import('../src/services/google-oauth')
    const token = randomToken()
    expect(token).toHaveLength(43) // 32바이트 base64url (패딩 없음)
    expect(token).not.toContain('+')
    expect(token).not.toContain('/')
    expect(token).not.toContain('=')
  })

  test('google-oauth — client id/secret 없으면 빈 문자열로 전송', async () => {
    let capturedBody = ''
    const fetchFn = (async (_url: any, init?: any) => {
      capturedBody = String(init?.body)
      return new Response(JSON.stringify({ access_token: 'at-1', expires_in: 3600, token_type: 'Bearer' }), { status: 200 })
    }) as unknown as typeof fetch
    const res = await exchangeCodeForTokens(fetchFn, {}, { code: 'c', verifier: 'v', redirectUri: 'https://x/cb' })
    expect(res.ok).toBe(true)
    const params = new URLSearchParams(capturedBody)
    expect(params.get('client_id')).toBe('')
    expect(params.get('client_secret')).toBe('')
  })

  test('google-oauth — refresh도 client id/secret 없으면 빈 문자열', async () => {
    let capturedBody = ''
    const fetchFn = (async (_url: any, init?: any) => {
      capturedBody = String(init?.body)
      return new Response(JSON.stringify({ access_token: 'at-2', expires_in: 3600, token_type: 'Bearer' }), { status: 200 })
    }) as unknown as typeof fetch
    const res = await refreshAccessToken(fetchFn, {}, 'rt-1')
    expect(res.ok).toBe(true)
    const params = new URLSearchParams(capturedBody)
    expect(params.get('client_id')).toBe('')
    expect(params.get('client_secret')).toBe('')
  })

  test('google-oauth — refresh 응답에 expires_in 없으면 3600 기본값', async () => {
    const noExpiry = jsonFetch({ access_token: 'at-3', token_type: 'Bearer' })
    const res1 = await refreshAccessToken(noExpiry, { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec' }, 'rt-1')
    expect(res1.ok).toBe(true)
    if (res1.ok) expect(res1.expiresIn).toBe(3600)
    const zeroExpiry = jsonFetch({ access_token: 'at-3', expires_in: 0, token_type: 'Bearer' })
    const res2 = await refreshAccessToken(zeroExpiry, { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec' }, 'rt-1')
    expect(res2.ok).toBe(true)
    if (res2.ok) expect(res2.expiresIn).toBe(3600)
  })

  test('google-sync — opts 생략 시 now 기본값으로 실행', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    const res = await syncGoogleNow(googleApiFetch(), env)
    expect(res.ran).toBe(true)
    expect(res.calendarCount).toBe(1)
    expect(res.unreadCount).toBe(1)
  })

  test('google-sync — getLastSyncLog 결과가 null이면 빈 배열', async () => {
    const env: any = {
      DB: {
        prepare() {
          return {
            bind: () => ({
              async all() { return { success: true, results: null } },
              async run() { return { success: true } },
              async first() { return null },
            }),
          }
        },
      } as unknown as D1Database,
    }
    expect(await getLastSyncLog(env)).toEqual([])
  })

  test('google-tokens — expires_at 비숫자 행은 0/undefined로 처리', async () => {
    const { fake, env } = makeEnv()
    fake.tables.google_integrations.push({
      provider: 'google',
      email: 'u@x.com',
      access_token: await encryptContent(env, 'at-1'),
      refresh_token: await encryptContent(env, 'rt-1'),
      scope: READONLY_SCOPE,
      expires_at: 'bogus',
      status: 'active',
    })
    expect((await getGoogleTokens(env))?.expiresAt).toBe(0)
    expect((await getGoogleStatus(env)).expiresAt).toBeUndefined()
  })

  test('google-tokens — 조건부 UPDATE 응답에 meta가 없어도 refresh_failed로 처리', async () => {
    const { fake, env } = makeEnv()
    await seedConnected(env, READONLY_SCOPE, 0) // 만료됨
    const db = asD1(fake) as any
    const origPrepare = db.prepare.bind(db)
    env.DB = {
      prepare(sql: string) {
        if (String(sql).startsWith('UPDATE google_integrations SET access_token')) {
          return {
            bind: () => ({
              async run() { return { success: true } }, // meta 없음
              async all() { return { success: true, results: [] } },
              async first() { return null },
            }),
          }
        }
        return origPrepare(sql)
      },
    } as unknown as D1Database
    const fetchFn = jsonFetch({ access_token: 'at-fresh', expires_in: 3600, token_type: 'Bearer' })
    const res = await getValidAccessToken(fetchFn, env)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('refresh_failed')
  })

  test('google-tools — GCAL_CREATE title만 있으면 나머지 필드는 undefined', () => {
    const markers = parseGoogleMarkers('[GCAL_CREATE]{"title": "치과"}[/GCAL_CREATE]')
    expect(markers).toHaveLength(1)
    expect(markers[0]).toEqual({
      full: '[GCAL_CREATE]{"title": "치과"}[/GCAL_CREATE]',
      action: 'gcal_create',
      data: { title: '치과', start_at: undefined, end_at: undefined, description: undefined, location: undefined },
    })
  })

  test('google-tools — Gmail 검색 q 생략 시 is:unread', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    let captured = ''
    const fetchFn = (async (url: any) => {
      captured = String(url)
      return new Response(JSON.stringify({ messages: [] }), { status: 200 })
    }) as unknown as typeof fetch
    const res = await executeGmailSearch(env, {}, fetchFn)
    expect(res.success).toBe(true)
    expect(new URL(captured).searchParams.get('q')).toBe('is:unread')
  })

  test('google-tools — 로컬 일정 빈 필드는 빈 값으로 매핑', async () => {
    const { fake, env } = makeEnv()
    await seedConnected(env)
    fake.tables.schedules.push({
      id: 1,
      title: '',
      description: '',
      location: '',
      start_at: '',
      end_at: null,
      timezone: 'Asia/Seoul',
      recurrence_rule: null,
      status: 'active',
      created_at: '',
      updated_at: '',
    })
    const res = await executeGcalList(env, { from: '2026-10-27', to: '2026-10-27' }, googleApiFetch())
    expect(res.success).toBe(true)
    expect(res.data).toHaveLength(2)
    expect(res.data[0]).toEqual({ source: 'local', title: '', start_at: '', end_at: null, location: '' })
  })

  test('google-tools — 구글 이벤트 end 없으면 end_at null', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    const fetchFn = (async (url: any) => {
      const u = String(url)
      if (u.includes('/calendar/v3/calendars/primary/events')) {
        return new Response(
          JSON.stringify({ items: [{ id: 'ev1', summary: '종일', start: { date: '2026-10-27' }, status: 'confirmed' }] }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({}), { status: 404 })
    }) as unknown as typeof fetch
    const res = await executeGcalList(env, { from: '2026-10-27', to: '2026-10-27' }, fetchFn)
    expect(res.success).toBe(true)
    expect(res.data).toHaveLength(1)
    expect(res.data[0]).toMatchObject({ source: 'google', title: '종일', start_at: '2026-10-27', end_at: null })
  })
})

describe('google-tools 기본 fetch 인자', () => {
  const realFetch = global.fetch
  beforeAll(() => {
    global.fetch = googleApiFetch()
  })
  afterAll(() => {
    global.fetch = realFetch
  })

  test('fetchFn 생략 시 전역 fetch 사용 — Gmail 검색', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    const res = await executeGmailSearch(env, { q: '회의' })
    expect(res.success).toBe(true)
    if (res.success) expect(res.data).toHaveLength(1)
  })

  test('fetchFn 생략 시 전역 fetch 사용 — Gmail 단건', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    const res = await executeGmailGet(env, { id: 'msg1' })
    expect(res.success).toBe(true)
    if (res.success) expect(res.data.body).toContain('내일 10시 회의입니다')
  })

  test('fetchFn 생략 시 전역 fetch 사용 — GCAL_LIST', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    const res = await executeGcalList(env, { from: '2026-10-27', to: '2026-10-27' })
    expect(res.success).toBe(true)
    expect(res.googleConnected).toBe(true)
    expect(res.data).toHaveLength(1)
  })

  test('fetchFn 생략 시 전역 fetch 사용 — GCAL_CREATE', async () => {
    const { env } = makeEnv()
    await seedConnected(env, WRITE_SCOPE)
    const res = await executeGcalCreate(env, { title: '치과', start_at: '2026-10-27T15:00:00' })
    expect(res.success).toBe(true)
    if (res.success) expect(res.data.summary).toBe('치과')
  })
})

describe('브랜치 보강 3차', () => {
  test('google-tools — GCAL_CREATE 모든 선택 필드 문자열로 전달', () => {
    const markers = parseGoogleMarkers(
      '[GCAL_CREATE]{"title": "치과", "start_at": "2026-10-27T15:00:00", "end_at": "2026-10-27T16:00:00", "description": "검진", "location": "강남"}[/GCAL_CREATE]',
    )
    expect(markers).toHaveLength(1)
    expect(markers[0].data).toEqual({
      title: '치과',
      start_at: '2026-10-27T15:00:00',
      end_at: '2026-10-27T16:00:00',
      description: '검진',
      location: '강남',
    })
  })

  function gcalFetchWithEvent(start: string) {
    return (async (url: any) => {
      const u = String(url)
      if (u.includes('/calendar/v3/calendars/primary/events')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'ev1',
                summary: '구글 회의',
                start: { dateTime: start },
                end: { dateTime: start },
                location: '',
                status: 'confirmed',
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({}), { status: 404 })
    }) as unknown as typeof fetch
  }

  function localRow(id: number, startAt: string) {
    return {
      id,
      title: `로컬 ${id}`,
      description: '',
      location: '',
      start_at: startAt,
      end_at: startAt,
      timezone: 'Asia/Seoul',
      recurrence_rule: null,
      status: 'active',
      created_at: '',
      updated_at: '',
    }
  }

  test('google-tools — GCAL_LIST 정렬: 구글 일정이 로컬보다 이른 경우', async () => {
    const { fake, env } = makeEnv()
    await seedConnected(env)
    fake.tables.schedules.push(localRow(1, '2026-10-27T14:00'))
    const res = await executeGcalList(env, { from: '2026-10-27', to: '2026-10-27' }, gcalFetchWithEvent('2026-10-27T10:00:00+09:00'))
    expect(res.success).toBe(true)
    expect(res.data).toHaveLength(2)
    expect(res.data[0]).toMatchObject({ source: 'google', title: '구글 회의' })
    expect(res.data[1]).toMatchObject({ source: 'local', title: '로컬 1' })
  })

  test('google-tools — GCAL_LIST 정렬: 시작 시각이 같으면 순서 유지(0 반환)', async () => {
    const { fake, env } = makeEnv()
    await seedConnected(env)
    // 문자열이 완전히 동일해야 비교기가 0을 반환한다
    fake.tables.schedules.push(localRow(1, '2026-10-27T14:00:00+09:00'))
    const res = await executeGcalList(env, { from: '2026-10-27', to: '2026-10-27' }, gcalFetchWithEvent('2026-10-27T14:00:00+09:00'))
    expect(res.success).toBe(true)
    expect(res.data).toHaveLength(2)
    expect(res.data[0].start_at).toBe(res.data[1].start_at)
    expect(res.data.map((d) => d.source).sort()).toEqual(['google', 'local'])
  })
})
