/**
 * Google 쓰기 플래그 실런타임 테스트 (miniflare + 실제 D1 + 실제 workerd).
 *
 * Jest 단위 테스트(tests/google-*.test.ts)가 게이트 함수·마커 단위를 검증한다면,
 * 이 파일은 실제 워커 경계에서 플래그가 쓰기 경로를 여닫는지 검증한다:
 * - 플래그 OFF (vitest.config.ts에 GOOGLE_WRITE_ENABLED 없음):
 *   GET /api/google/oauth/start?mode=write → 400 google_write_not_enabled
 *   (읽기 모드 시작은 영향 없이 302 + 쓰기 scope 미포함)
 * - 플래그 ON (직접 Hono 호출 — miniflare 바인딩은 테스트마다 바꿀 수 없어
 *   ON 경로는 googleApp.request에 env를 주입해 검증한다):
 *   GET /oauth/start?mode=write → 302, 동의 URL에 calendar.events 포함,
 *   KV state의 mode='write'
 * - POST /api/google/calendar/events (플래그와 무관하게 scope가 게이트):
 *   토큰 없음 → 401 google_not_connected / 읽기 전용 scope → 403 scope_missing
 *   (두 경우 모두 Google fetch에 도달하지 않는다)
 * - 쓰기 scope 토큰 + 스텁 Google fetch:
 *   executeGcalCreate가 Calendar API에 일정 생성 POST를 보내고 생성된
 *   일정을 반환한다. 읽기 전용 scope면 scope_missing + fetch 미호출.
 * - GET /api/google/status가 쓰기 scope를 그대로 보고하는지 (부모의
 *   라이브 확인 절차와 동일한 조회 경로).
 *
 * 실제 Google egress 없음 — Google fetch는 스텁으로 대체한다.
 * 운영 DB·운영 배포·OTP 라이브 호출 없음. D1은 파일마다 격리된 로컬 SQLite.
 * 토큰은 테스트 전용 MEMO_ENCRYPTION_KEY로 암호화해 시드한다
 * (vitest.config.ts bindings와 같은 값 — 워커가 같은 키로 복호화한다).
 */
import { env, exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { googleApp } from '../../src/modules/google/routes'
import { applyAllMigrations, testDb } from './helpers/apply-migrations'
import { saveGoogleTokens, deleteGoogleTokens } from '../../src/services/google-tokens'
import { executeGcalCreate } from '../../src/services/google-tools'
import { GOOGLE_SCOPES_READONLY, GOOGLE_SCOPES_WRITE } from '../../src/services/google-oauth'

const testEnv = env as unknown as { SESSION_SECRET: string; MEMO_ENCRYPTION_KEY: string }
const worker = exports as unknown as { default: { fetch: (req: Request) => Promise<Response> } }

// vitest.config.ts bindings와 동일한 테스트 전용 값. 운영 키가 아니다.
const TEST_MEMO_KEY = 'runtime-test-only-memo-key'
const TEST_EMAIL = 'google-write-runtime@myhub.local'
const READONLY_SCOPE = GOOGLE_SCOPES_READONLY.join(' ')
const WRITE_SCOPE = GOOGLE_SCOPES_WRITE.join(' ')
const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events'

/** src/modules/auth/routes.ts createSession과 같은 형식의 세션 토큰을 만든다. */
async function mintSessionToken(email: string, secret: string): Promise<string> {
  const exp = Date.now() + 30 * 24 * 60 * 60 * 1000
  const payload = JSON.stringify({ email, exp, method: 'pin', v: 0 })
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return btoa(payload) + '.' + sigB64
}

let sessionCookie = ''

async function fetchJson(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers = new Headers(init.headers as any)
  if (sessionCookie) headers.set('Cookie', sessionCookie)
  // redirect: 'manual' 필수 — 기본값(follow)이면 worker.default.fetch가
  // 302를 따라가 외부(accounts.google.com) 응답을 돌려준다. /oauth/start
  // 테스트는 워커가 낸 302 자체를 봐야 한다.
  const res = await worker.default.fetch(
    new Request(`http://localhost${path}`, { ...init, headers, redirect: 'manual' }),
  )
  const text = await res.text()
  let body: any = null
  try {
    body = JSON.parse(text)
  } catch {
    // JSON이 아닌 응답은 body null
  }
  return { status: res.status, body, headers: res.headers }
}

async function seedToken(scope: string): Promise<void> {
  await saveGoogleTokens(
    { DB: testDb(), MEMO_ENCRYPTION_KEY: TEST_MEMO_KEY } as any,
    {
      email: TEST_EMAIL,
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      scope,
      expiresIn: 3600,
    },
  )
}

async function clearTokens(): Promise<void> {
  await deleteGoogleTokens({ DB: testDb(), MEMO_ENCRYPTION_KEY: TEST_MEMO_KEY } as any)
}

/** googleApp.request용 인메모리 KV 스텁. */
function stubKv() {
  const store = new Map<string, string>()
  return {
    store,
    kv: {
      put: async (k: string, v: string) => {
        store.set(k, v)
      },
      get: async (k: string) => store.get(k) ?? null,
      delete: async (k: string) => {
        store.delete(k)
      },
    },
  }
}

describe('google write flag (miniflare)', () => {
  beforeAll(async () => {
    const result = await applyAllMigrations()
    expect(result.failed).toHaveLength(0)
    sessionCookie = `myhub_session=${await mintSessionToken(TEST_EMAIL, testEnv.SESSION_SECRET)}`
  })

  it(
    '워커 워밍업: /api/health 200 (첫 fetch는 workerd 부팅 + 전체 앱 로딩으로 느리다)',
    async () => {
      const { status, body } = await fetchJson('/api/health')
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
    },
    60000,
  )

  it('플래그 OFF: mode=write 시작은 400 google_write_not_enabled', async () => {
    const { status, body } = await fetchJson('/api/google/oauth/start?mode=write')
    expect(status).toBe(400)
    expect(body.error).toBe('google_write_not_enabled')
  })

  it('플래그 OFF: 읽기 모드 시작은 302 + 동의 scope에 calendar.events 없음', async () => {
    const { status, headers } = await fetchJson('/api/google/oauth/start')
    expect(status).toBe(302)
    const location = headers.get('Location') || ''
    expect(location).toContain('accounts.google.com/o/oauth2/v2/auth')
    const scope = new URL(location).searchParams.get('scope') || ''
    expect(scope).toContain('https://www.googleapis.com/auth/calendar.readonly')
    expect(scope).toContain('https://www.googleapis.com/auth/gmail.readonly')
    expect(scope).not.toContain(CALENDAR_EVENTS_SCOPE)
  })

  it('플래그 ON: mode=write 시작은 302 + 동의 scope에 calendar.events 포함 + state mode=write', async () => {
    const { store, kv } = stubKv()
    const res = await googleApp.request(
      '/oauth/start?mode=write',
      { method: 'GET' },
      {
        GOOGLE_CLIENT_ID: 'runtime-test-client-id',
        GOOGLE_CLIENT_SECRET: 'runtime-test-client-secret',
        GOOGLE_WRITE_ENABLED: 'true',
        KV: kv,
      } as any,
    )
    expect(res.status).toBe(302)
    const location = res.headers.get('Location') || ''
    const scope = new URL(location).searchParams.get('scope') || ''
    expect(scope).toContain(CALENDAR_EVENTS_SCOPE)
    // state가 mode=write로 저장돼야 콜백이 쓰기 scope 토큰을 저장한다.
    const states = [...store.values()].map((v) => JSON.parse(v))
    expect(states).toHaveLength(1)
    expect(states[0].mode).toBe('write')
  })

  it('POST /calendar/events: 토큰 없으면 401 google_not_connected', async () => {
    await clearTokens()
    const { status, body } = await fetchJson('/api/google/calendar/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: '테스트', start: '2026-10-29T15:00:00+09:00' }),
    })
    expect(status).toBe(401)
    expect(body.error).toBe('google_not_connected')
  })

  it('POST /calendar/events: 읽기 전용 scope 토큰이면 403 scope_missing (Google 미호출)', async () => {
    await seedToken(READONLY_SCOPE)
    const { status, body } = await fetchJson('/api/google/calendar/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: '테스트', start: '2026-10-29T15:00:00+09:00' }),
    })
    expect(status).toBe(403)
    expect(body.error).toBe('scope_missing')
  })

  it('GET /api/google/status: 쓰기 scope 토큰이면 scope에 calendar.events 포함', async () => {
    await seedToken(WRITE_SCOPE)
    const { status, body } = await fetchJson('/api/google/status')
    expect(status).toBe(200)
    expect(body.connected).toBe(true)
    expect(body.email).toBe(TEST_EMAIL)
    expect(body.scope).toContain(CALENDAR_EVENTS_SCOPE)
  })

  it('GET /api/google/status: 플래그 OFF 워커 env면 writeEnabled:false (연결 버튼은 읽기 전용 시작)', async () => {
    await seedToken(WRITE_SCOPE)
    const { status, body } = await fetchJson('/api/google/status')
    expect(status).toBe(200)
    // vitest.config.ts bindings에 GOOGLE_WRITE_ENABLED가 없어 OFF 상태다.
    expect(body.writeEnabled).toBe(false)
  })

  it('executeGcalCreate: 쓰기 scope 토큰이면 Calendar API에 생성 POST 후 일정 반환', async () => {
    await seedToken(WRITE_SCOPE)
    const calls: Array<{ url: string; method: string; auth: string; body: any }> = []
    const stubFetch = (async (input: any, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method || 'GET',
        auth: new Headers(init?.headers as any).get('Authorization') || '',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return new Response(
        JSON.stringify({
          id: 'evt-test-1',
          summary: '테스트 일정',
          start: { dateTime: '2026-10-29T15:00:00+09:00' },
          end: { dateTime: '2026-10-29T16:00:00+09:00' },
          status: 'confirmed',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch

    const res = await executeGcalCreate(
      { DB: testDb(), MEMO_ENCRYPTION_KEY: TEST_MEMO_KEY } as any,
      { title: '테스트 일정', start_at: '2026-10-29T15:00:00+09:00', end_at: '2026-10-29T16:00:00+09:00' },
      stubFetch,
    )
    expect(res.success).toBe(true)
    if (res.success) {
      expect(res.data.id).toBe('evt-test-1')
      expect(res.data.summary).toBe('테스트 일정')
      expect(res.data.start).toBe('2026-10-29T15:00:00+09:00')
    }
    // Google에 간 요청이 정확히 1건, 올바른 엔드포인트·본문·토큰이어야 한다.
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events')
    expect(calls[0].auth).toBe('Bearer test-access-token')
    expect(calls[0].body.summary).toBe('테스트 일정')
    expect(calls[0].body.start.dateTime).toBe('2026-10-29T15:00:00+09:00')
    expect(calls[0].body.start.timeZone).toBe('Asia/Seoul')
  })

  it('executeGcalCreate: 읽기 전용 scope면 scope_missing + Google fetch 미호출', async () => {
    await seedToken(READONLY_SCOPE)
    let fetchCalls = 0
    const stubFetch = (async () => {
      fetchCalls++
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    const res = await executeGcalCreate(
      { DB: testDb(), MEMO_ENCRYPTION_KEY: TEST_MEMO_KEY } as any,
      { title: '테스트 일정', start_at: '2026-10-29T15:00:00+09:00' },
      stubFetch,
    )
    expect(res.success).toBe(false)
    if (!res.success) expect(res.error).toBe('scope_missing')
    expect(fetchCalls).toBe(0)
  })
})
