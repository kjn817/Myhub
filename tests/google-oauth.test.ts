/**
 * Google OAuth 테스트 — URL 생성·PKCE·state·토큰 교환/갱신/철회
 * 모의 fetch만 사용 — 실제 Google API 호출 없음.
 */
import {
  buildAuthUrl,
  consumeOAuthState,
  exchangeCodeForTokens,
  generatePKCE,
  isGoogleOAuthConfigured,
  isGoogleWriteEnabled,
  refreshAccessToken,
  revokeToken,
  saveOAuthState,
  scopesForMode,
} from '../src/services/google-oauth'

function fakeKV() {
  const store = new Map<string, string>()
  return {
    store,
    async get(key: string) { return store.get(key) ?? null },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
}

function mockFetch(body: any, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
}

const ENV = { GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'test-secret' }

describe('scope', () => {
  test('기본은 읽기 전용 2개, 쓰기는 calendar.events 추가', () => {
    expect(scopesForMode('read')).toEqual([
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
    ])
    expect(scopesForMode('write')).toContain('https://www.googleapis.com/auth/calendar.events')
  })

  test('설정 여부·쓰기 플래그', () => {
    expect(isGoogleOAuthConfigured(ENV)).toBe(true)
    expect(isGoogleOAuthConfigured({})).toBe(false)
    expect(isGoogleWriteEnabled({ GOOGLE_WRITE_ENABLED: 'true' })).toBe(true)
    expect(isGoogleWriteEnabled({})).toBe(false)
    expect(isGoogleWriteEnabled({ GOOGLE_WRITE_ENABLED: 'yes' })).toBe(false)
  })
})

describe('PKCE', () => {
  test('challenge는 verifier의 SHA-256 base64url', async () => {
    const { verifier, challenge } = await generatePKCE()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    const bytes = new Uint8Array(digest)
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    const expected = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(challenge).toBe(expected)
  })
})

describe('buildAuthUrl', () => {
  test('필수 파라미터 포함 — offline 접근·PKCE·state', () => {
    const url = new URL(buildAuthUrl(ENV, { origin: 'https://example.workers.dev', mode: 'read', state: 'nonce1', challenge: 'chal1' }))
    expect(url.searchParams.get('client_id')).toBe('test-client-id')
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.workers.dev/api/google/oauth/callback')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toContain('gmail.readonly')
    expect(url.searchParams.get('scope')).not.toContain('calendar.events')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('nonce1')
  })

  test('write 모드면 calendar.events 포함', () => {
    const url = new URL(buildAuthUrl(ENV, { origin: 'https://example.workers.dev', mode: 'write', state: 'n', challenge: 'c' }))
    expect(url.searchParams.get('scope')).toContain('calendar.events')
  })
})

describe('state 저장소 (KV 1회용)', () => {
  test('저장→소비 1회, 두 번째 소비는 null', async () => {
    const kv = fakeKV()
    const env = { ...ENV, KV: kv as unknown as KVNamespace }
    await saveOAuthState(env, 'nonce-1', { verifier: 'v123', mode: 'read', createdAt: Date.now() })
    const first = await consumeOAuthState(env, 'nonce-1')
    expect(first).toMatchObject({ verifier: 'v123', mode: 'read' })
    expect(await consumeOAuthState(env, 'nonce-1')).toBeNull()
  })

  test('없는 nonce·깨진 JSON은 null', async () => {
    const kv = fakeKV()
    const env = { ...ENV, KV: kv as unknown as KVNamespace }
    expect(await consumeOAuthState(env, 'nope')).toBeNull()
    kv.store.set('google:oauth:state:bad', '{broken')
    expect(await consumeOAuthState(env, 'bad')).toBeNull()
  })

  test('KV 없으면 저장 실패·소비 null', async () => {
    await expect(saveOAuthState(ENV, 'n', { verifier: 'v', mode: 'read', createdAt: 0 })).rejects.toThrow()
    expect(await consumeOAuthState(ENV, 'n')).toBeNull()
  })
})

describe('토큰 교환', () => {
  test('code 교환 성공', async () => {
    const fetchFn = mockFetch({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' })
    const res = await exchangeCodeForTokens(fetchFn, ENV, { code: 'code-1', verifier: 'v', redirectUri: 'https://x/callback' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.tokens.access_token).toBe('at-1')
  })

  test('code 교환 실패 — 에러 반환, 토큰 없음', async () => {
    const fetchFn = mockFetch({ error: 'invalid_grant' }, 400)
    const res = await exchangeCodeForTokens(fetchFn, ENV, { code: 'bad', verifier: 'v', redirectUri: 'https://x/callback' })
    expect(res.ok).toBe(false)
  })

  test('refresh 성공 — 새 access token', async () => {
    const fetchFn = mockFetch({ access_token: 'at-2', expires_in: 3600, token_type: 'Bearer' })
    const res = await refreshAccessToken(fetchFn, ENV, 'rt-1')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.accessToken).toBe('at-2')
  })

  test('refresh 실패 invalid_grant 구분', async () => {
    const fetchFn = mockFetch({ error: 'invalid_grant' }, 400)
    const res = await refreshAccessToken(fetchFn, ENV, 'rt-bad')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.invalidGrant).toBe(true)
  })

  test('refresh 실패 기타 에러는 invalidGrant=false', async () => {
    const fetchFn = mockFetch({ error: 'server_error' }, 500)
    const res = await refreshAccessToken(fetchFn, ENV, 'rt-1')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.invalidGrant).toBe(false)
  })

  test('revoke 성공·실패', async () => {
    expect(await revokeToken(mockFetch({}), 't')).toBe(true)
    expect(await revokeToken(mockFetch({ error: 'x' }, 400), 't')).toBe(false)
    const failing = (async () => { throw new Error('net') }) as unknown as typeof fetch
    expect(await revokeToken(failing, 't')).toBe(false)
  })
})
