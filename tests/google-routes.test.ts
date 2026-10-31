/**
 * Google 모듈 라우트 테스트 — OAuth 시작·콜백·상태·해제
 * Hono app.request + FakeD1 + 모의 fetch 사용.
 * 실제 Google API 호출 없음 — 전역 fetch를 모의 구현으로 교체한다.
 */
import { googleApp } from '../src/modules/google/routes'
import { saveGoogleTokens } from '../src/services/google-tokens'
import { FakeD1, asD1 } from './fake-d1'

const KEY = 'test-google-encryption-key'
const READONLY_SCOPE =
  'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly'

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

describe('GET /status', () => {
  test('미연동 — connected:false, 토큰 값 없음', async () => {
    const { env } = makeEnv()
    const res = await call(env, '/status')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.connected).toBe(false)
    expect(body.configured).toBe(true)
  })

  test('연동 후 — connected:true, 이메일·scope만 반환', async () => {
    const { env } = makeEnv()
    await saveGoogleTokens(env, {
      email: 'user@example.com',
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      scope: READONLY_SCOPE,
      expiresIn: 3600,
    })
    const res = await call(env, '/status')
    const body = await res.json()
    expect(body.connected).toBe(true)
    expect(body.email).toBe('user@example.com')
    expect(JSON.stringify(body)).not.toContain('at-1')
    expect(JSON.stringify(body)).not.toContain('rt-1')
  })

  test('쓰기 플래그 ON — writeEnabled:true를 노출한다 (연결 버튼의 mode=write 판정 근거)', async () => {
    const { env } = makeEnv()
    env.GOOGLE_WRITE_ENABLED = 'true'
    const res = await call(env, '/status')
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.writeEnabled).toBe(true)
  })

  test('쓰기 플래그 OFF(미설정) — writeEnabled:false', async () => {
    const { env } = makeEnv()
    const res = await call(env, '/status')
    const body = await res.json()
    expect(body.writeEnabled).toBe(false)
  })
})

describe('GET /oauth/start', () => {
  test('미설정 시 503', async () => {
    const { env } = makeEnv()
    delete env.GOOGLE_CLIENT_ID
    const res = await call(env, '/oauth/start')
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('google_oauth_not_configured')
  })

  test('read 모드 — Google 동의 화면으로 302, state가 KV에 저장됨', async () => {
    const { kv, env } = makeEnv()
    const res = await call(env, '/oauth/start?mode=read')
    expect(res.status).toBe(302)
    const location = res.headers.get('Location') || ''
    expect(location).toContain('accounts.google.com/o/oauth2/v2/auth')
    expect(location).toContain('gmail.readonly')
    expect(location).not.toContain('calendar.events')
    expect(kv.store.size).toBe(1)
  })

  test('write 모드 — 플래그 꺼져 있으면 400', async () => {
    const { env } = makeEnv()
    const res = await call(env, '/oauth/start?mode=write')
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('google_write_not_enabled')
  })

  test('write 모드 — 플래그 켜져 있으면 scope에 calendar.events 포함', async () => {
    const { env } = makeEnv()
    env.GOOGLE_WRITE_ENABLED = 'true'
    const res = await call(env, '/oauth/start?mode=write')
    expect(res.status).toBe(302)
    expect(res.headers.get('Location') || '').toContain('calendar.events')
  })
})

describe('GET /oauth/callback', () => {
  // 전역 fetch 모의 — 토큰 교환 + 프로필 조회
  const realFetch = global.fetch
  beforeAll(() => {
    global.fetch = (async (url: any) => {
      const u = String(url)
      if (u.includes('/token')) {
        return new Response(
          JSON.stringify({ access_token: 'at-cb', refresh_token: 'rt-cb', expires_in: 3600, scope: READONLY_SCOPE, token_type: 'Bearer' }),
          { status: 200 },
        )
      }
      if (u.includes('/users/me/profile')) {
        return new Response(JSON.stringify({ emailAddress: 'cb@example.com', messagesTotal: 1 }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 404 })
    }) as unknown as typeof fetch
  })
  afterAll(() => {
    global.fetch = realFetch
  })

  test('state 불일치 — 400, 토큰 저장 안 함', async () => {
    const { fake, env } = makeEnv()
    const res = await call(env, '/oauth/callback?code=abc&state=nope')
    expect(res.status).toBe(400)
    expect(fake.tables.google_integrations).toHaveLength(0)
  })

  test('동의 거부 — 토큰 저장 없이 denied로 복귀', async () => {
    const { fake, env } = makeEnv()
    const res = await call(env, '/oauth/callback?error=access_denied&state=x')
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('google=denied')
    expect(fake.tables.google_integrations).toHaveLength(0)
  })

  test('정상 콜백 — 토큰 저장 후 connected로 복귀', async () => {
    const { fake, kv, env } = makeEnv()
    // start를 거쳐 state를 심는다
    const start = await call(env, '/oauth/start?mode=read')
    const state = new URL(start.headers.get('Location') || '').searchParams.get('state') || ''
    expect(kv.store.size).toBe(1)
    const res = await call(env, `/oauth/callback?code=code-1&state=${state}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('google=connected')
    // state는 1회용 — 소진됨
    expect(kv.store.size).toBe(0)
    expect(fake.tables.google_integrations).toHaveLength(1)
    expect(fake.tables.google_integrations[0].email).toBe('cb@example.com')
    expect(fake.tables.google_integrations[0].access_token).not.toContain('at-cb')
  })

  test('state 재사용 — 두 번째 콜백은 400', async () => {
    const { env } = makeEnv()
    const start = await call(env, '/oauth/start?mode=read')
    const state = new URL(start.headers.get('Location') || '').searchParams.get('state') || ''
    await call(env, `/oauth/callback?code=code-1&state=${state}`)
    const second = await call(env, `/oauth/callback?code=code-1&state=${state}`)
    expect(second.status).toBe(400)
  })
})

describe('POST /disconnect', () => {
  test('연동 해제 — 행 삭제', async () => {
    const { fake, env } = makeEnv()
    await saveGoogleTokens(env, {
      email: 'u@x.com',
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      scope: READONLY_SCOPE,
      expiresIn: 3600,
    })
    // revoke 호출은 전역 fetch 모의(404)여도 로컬 삭제는 수행된다
    const res = await call(env, '/disconnect', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(fake.tables.google_integrations).toHaveLength(0)
  })
})

describe('GET /gmail/search · /calendar/events (미연동)', () => {
  test('미연동이면 google_not_connected', async () => {
    const { env } = makeEnv()
    const gmail = await call(env, '/gmail/search?q=test')
    expect(gmail.status).toBe(401)
    expect((await gmail.json()).error).toBe('google_not_connected')
    const cal = await call(env, '/calendar/events?from=2026-10-27&to=2026-10-27')
    expect(cal.status).toBe(401)
    expect((await cal.json()).error).toBe('google_not_connected')
  })
})

describe('POST /calendar/events (연동·읽기 전용)', () => {
  test('쓰기 scope 없으면 403 scope_missing', async () => {
    const { env } = makeEnv()
    await saveGoogleTokens(env, {
      email: 'u@x.com',
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      scope: READONLY_SCOPE,
      expiresIn: 3600,
    })
    const res = await call(env, '/calendar/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: '치과', start: '2026-10-27T15:00:00' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('scope_missing')
  })
})
