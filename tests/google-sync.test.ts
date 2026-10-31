/**
 * Google 동기화 테스트 — Cron pull, 30분 간격 제어, fail-soft
 * FakeD1 + 모의 fetch + 메모리 KV 사용 — 실제 Google API 호출 없음.
 */
import { syncGoogleNow, getLastSyncLog, GOOGLE_SYNC_INTERVAL_MS } from '../src/services/google-sync'
import { saveGoogleTokens } from '../src/services/google-tokens'
import { FakeD1, asD1 } from './fake-d1'

const KEY = 'test-google-encryption-key'
const READONLY_SCOPE =
  'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly'

function fakeKV() {
  const store = new Map<string, string>()
  return {
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

function googleFetch(): typeof fetch {
  return (async (url: any) => {
    const u = String(url)
    if (u.includes('/calendar/v3/calendars/primary/events')) {
      return new Response(JSON.stringify({ items: [{ id: 'e1' }, { id: 'e2' }] }), { status: 200 })
    }
    if (u.includes('/gmail/v1/users/me/messages?')) {
      return new Response(JSON.stringify({ messages: [{ id: 'm1' }] }), { status: 200 })
    }
    if (u.includes('/gmail/v1/users/me/messages/m1')) {
      return new Response(
        JSON.stringify({
          id: 'm1',
          snippet: 's',
          payload: { mimeType: 'text/plain', headers: [], body: { data: '' } },
        }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({}), { status: 404 })
  }) as unknown as typeof fetch
}

async function seedConnected(env: any) {
  await saveGoogleTokens(env, {
    email: 'user@example.com',
    accessToken: 'at-valid',
    refreshToken: 'rt-1',
    scope: READONLY_SCOPE,
    expiresIn: 3600,
  })
}

describe('syncGoogleNow', () => {
  // 실제 시각대 now 값 — 1_000_000ms는 30분 간격보다 작아 too_soon이 된다
  const NOW = 1_790_000_000_000
  test('미연동이면 실행 안 함', async () => {
    const { env } = makeEnv()
    const res = await syncGoogleNow(googleFetch(), env, { now: NOW })
    expect(res).toEqual({ ran: false, reason: 'not_connected' })
  })

  test('연동 시 실행 — 건수 반환 + 로그 기록 (본문 저장 안 함)', async () => {
    const { fake, env } = makeEnv()
    await seedConnected(env)
    const res = await syncGoogleNow(googleFetch(), env, { now: NOW })
    expect(res.ran).toBe(true)
    expect(res.calendarCount).toBe(2)
    expect(res.unreadCount).toBe(1)
    expect(fake.tables.google_sync_log).toHaveLength(2)
    // 로그에는 건수만 있고 메일 본문·이벤트 원문은 없음
    for (const row of fake.tables.google_sync_log) {
      expect(row.detail).not.toContain('e1')
      expect(row.detail).not.toContain('m1')
    }
    const last = await getLastSyncLog(env)
    expect(last.length).toBeGreaterThan(0)
    expect(last[0].status).toBe('ok')
  })

  test('30분 이내 재실행은 too_soon', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    const fetchFn = googleFetch()
    const first = await syncGoogleNow(fetchFn, env, { now: NOW })
    expect(first.ran).toBe(true)
    const second = await syncGoogleNow(fetchFn, env, { now: NOW + GOOGLE_SYNC_INTERVAL_MS - 1000 })
    expect(second).toEqual({ ran: false, reason: 'too_soon' })
    const third = await syncGoogleNow(fetchFn, env, { now: NOW + GOOGLE_SYNC_INTERVAL_MS + 1000 })
    expect(third.ran).toBe(true)
  })

  test('force면 간격 무시', async () => {
    const { env } = makeEnv()
    await seedConnected(env)
    const fetchFn = googleFetch()
    await syncGoogleNow(fetchFn, env, { now: NOW })
    const res = await syncGoogleNow(fetchFn, env, { now: NOW + 1, force: true })
    expect(res.ran).toBe(true)
  })

  test('API 실패 — 실패 로그 남기고 ran:false (예외 없음)', async () => {
    const { fake, env } = makeEnv()
    await seedConnected(env)
    const failing = (async () => new Response(JSON.stringify({}), { status: 500 })) as unknown as typeof fetch
    const res = await syncGoogleNow(failing, env, { now: NOW + 1000 })
    expect(res.ran).toBe(false)
    expect(res.reason).toBe('api_error')
    expect(fake.tables.google_sync_log[0].status).toBe('failed')
  })

  test('KV 없으면 간격 제어 건너뛰고 실행', async () => {
    const fake = new FakeD1()
    const env: any = {
      DB: asD1(fake),
      MEMO_ENCRYPTION_KEY: KEY,
      GOOGLE_CLIENT_ID: 'cid',
      GOOGLE_CLIENT_SECRET: 'csec',
    }
    await saveGoogleTokens(env, {
      email: 'u@x.com',
      accessToken: 'at',
      refreshToken: 'rt',
      scope: READONLY_SCOPE,
      expiresIn: 3600,
    })
    const res = await syncGoogleNow(googleFetch(), env, { now: NOW + 2000 })
    expect(res.ran).toBe(true)
  })
})
