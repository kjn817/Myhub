/**
 * Google 토큰 저장소 테스트 — D1 암호화 저장·조회·갱신·철회
 * FakeD1 + 모의 fetch 사용 — 운영 DB·실제 Google API에 닿지 않음.
 */
import {
  saveGoogleTokens,
  getGoogleTokens,
  getGoogleStatus,
  deleteGoogleTokens,
  getValidAccessToken,
  hasCalendarWriteScope,
  setGoogleTokenStatus,
} from '../src/services/google-tokens'
import { FakeD1, asD1 } from './fake-d1'

const KEY = 'test-google-encryption-key'
const READONLY_SCOPE =
  'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly'

function makeEnv() {
  const fake = new FakeD1()
  const env: any = {
    DB: asD1(fake),
    MEMO_ENCRYPTION_KEY: KEY,
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'csec',
  }
  return { fake, env }
}

async function seed(env: any, opts: Partial<{ refreshToken: string; scope: string; expiresInSec: number }> = {}) {
  await saveGoogleTokens(env, {
    email: 'user@example.com',
    accessToken: 'at-old',
    refreshToken: opts.refreshToken ?? 'rt-1',
    scope: opts.scope ?? READONLY_SCOPE,
    expiresIn: opts.expiresInSec ?? 3600,
  })
}

function tokenFetch(body: any, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
}

describe('저장·조회', () => {
  test('저장 후 조회 — 토큰 복호화됨, D1에는 평문 없음', async () => {
    const { fake, env } = makeEnv()
    await seed(env)
    const got = await getGoogleTokens(env)
    expect(got?.accessToken).toBe('at-old')
    expect(got?.refreshToken).toBe('rt-1')
    expect(got?.email).toBe('user@example.com')
    // D1 저장값은 ENC: 암호문 — 평문이 아님
    const row = fake.tables.google_integrations[0]
    expect(row.access_token.startsWith('ENC:')).toBe(true)
    expect(row.access_token).not.toContain('at-old')
    expect(row.refresh_token).not.toContain('rt-1')
  })

  test('없으면 null, 상태 요약에 토큰 값 없음', async () => {
    const { env } = makeEnv()
    expect(await getGoogleTokens(env)).toBeNull()
    const status = await getGoogleStatus(env)
    expect(status.connected).toBe(false)
    expect(JSON.stringify(status)).not.toContain('at-')
  })

  test('재저장하면 교체됨 (upsert)', async () => {
    const { fake, env } = makeEnv()
    await seed(env)
    await saveGoogleTokens(env, {
      email: 'user2@example.com',
      accessToken: 'at-new',
      refreshToken: 'rt-2',
      scope: READONLY_SCOPE,
      expiresIn: 3600,
    })
    expect(fake.tables.google_integrations).toHaveLength(1)
    expect((await getGoogleTokens(env))?.accessToken).toBe('at-new')
  })

  test('삭제 후 조회 null', async () => {
    const { fake, env } = makeEnv()
    await seed(env)
    await deleteGoogleTokens(env)
    expect(fake.tables.google_integrations).toHaveLength(0)
    expect(await getGoogleTokens(env)).toBeNull()
  })

  test('revoked 상태면 조회 null', async () => {
    const { env } = makeEnv()
    await seed(env)
    await setGoogleTokenStatus(env, 'revoked')
    expect(await getGoogleTokens(env)).toBeNull()
    expect((await getGoogleStatus(env)).connected).toBe(false)
  })
})

describe('hasCalendarWriteScope', () => {
  test('읽기 전용 scope는 false, calendar.events 포함 시 true', () => {
    expect(hasCalendarWriteScope(null)).toBe(false)
    expect(hasCalendarWriteScope({ scope: READONLY_SCOPE } as any)).toBe(false)
    expect(
      hasCalendarWriteScope({ scope: `${READONLY_SCOPE} https://www.googleapis.com/auth/calendar.events` } as any),
    ).toBe(true)
  })
})

describe('getValidAccessToken', () => {
  test('유효기간 충분 — 갱신 없이 반환', async () => {
    const { env } = makeEnv()
    await seed(env, { expiresInSec: 3600 })
    const res = await getValidAccessToken(tokenFetch({}), env)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.accessToken).toBe('at-old')
  })

  test('만료 임박 — refresh 교환 후 새 토큰 저장', async () => {
    const { fake, env } = makeEnv()
    await seed(env, { expiresInSec: 0 })
    const fetchFn = tokenFetch({ access_token: 'at-fresh', expires_in: 3600, token_type: 'Bearer' })
    const res = await getValidAccessToken(fetchFn, env)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.accessToken).toBe('at-fresh')
    expect((await getGoogleTokens(env))?.accessToken).toBe('at-fresh')
    expect(fake.tables.google_integrations[0].status).toBe('active')
  })

  test('refresh invalid_grant — revoked로 전환', async () => {
    const { fake, env } = makeEnv()
    await seed(env, { expiresInSec: 0 })
    const fetchFn = tokenFetch({ error: 'invalid_grant' }, 400)
    const res = await getValidAccessToken(fetchFn, env)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('revoked')
    expect(fake.tables.google_integrations[0].status).toBe('revoked')
    expect(await getGoogleTokens(env)).toBeNull()
  })

  test('refresh 기타 실패 — refresh_failed, 상태 유지', async () => {
    const { fake, env } = makeEnv()
    await seed(env, { expiresInSec: 0 })
    const fetchFn = tokenFetch({ error: 'server_error' }, 500)
    const res = await getValidAccessToken(fetchFn, env)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('refresh_failed')
    expect(fake.tables.google_integrations[0].status).toBe('active')
  })

  test('토큰 없음 — not_connected', async () => {
    const { env } = makeEnv()
    const res = await getValidAccessToken(tokenFetch({}), env)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('not_connected')
  })

  test('refresh token 없음 + 만료 — revoked', async () => {
    const { env } = makeEnv()
    await seed(env, { refreshToken: '', expiresInSec: 0 })
    const res = await getValidAccessToken(tokenFetch({}), env)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('revoked')
  })
})
