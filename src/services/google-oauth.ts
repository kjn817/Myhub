/**
 * Google OAuth 2.0 — authorization code + PKCE(S256)
 *
 * 설계: docs/gmail-calendar-design.md §2·§3
 * - Client ID/Secret은 Worker secrets (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).
 * - state + PKCE verifier는 KV에 10분 저장, 콜백에서 1회용으로 소비.
 * - fetch는 주입 가능 (테스트에서 모의 Google API 사용 — 실제 호출 없음).
 */

// 결정 필요 (설계 §9-②): 쓰기 scope는 기본 OFF.
// GOOGLE_WRITE_ENABLED 플래그가 명시적으로 'true'일 때만 mode=write를 허용한다.
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

export const GOOGLE_SCOPES_READONLY = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
]

export const GOOGLE_SCOPES_WRITE = [
  ...GOOGLE_SCOPES_READONLY,
  'https://www.googleapis.com/auth/calendar.events',
]

export const OAUTH_STATE_TTL_SECONDS = 600

export interface GoogleEnv {
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  GOOGLE_WRITE_ENABLED?: string
  KV?: KVNamespace
}

export interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
  token_type: string
}

export interface OAuthState {
  verifier: string
  mode: 'read' | 'write'
  createdAt: number
}

function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function randomToken(byteLength = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(48)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(new Uint8Array(digest)) }
}

export function isGoogleOAuthConfigured(env: GoogleEnv): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
}

export function isGoogleWriteEnabled(env: GoogleEnv): boolean {
  return env.GOOGLE_WRITE_ENABLED === 'true'
}

export function scopesForMode(mode: 'read' | 'write'): string[] {
  return mode === 'write' ? GOOGLE_SCOPES_WRITE : GOOGLE_SCOPES_READONLY
}

export function redirectUriFor(origin: string): string {
  return `${origin.replace(/\/$/, '')}/api/google/oauth/callback`
}

export function buildAuthUrl(
  env: GoogleEnv,
  opts: { origin: string; mode: 'read' | 'write'; state: string; challenge: string },
): string {
  const url = new URL(GOOGLE_AUTH_URL)
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID || '')
  url.searchParams.set('redirect_uri', redirectUriFor(opts.origin))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', scopesForMode(opts.mode).join(' '))
  url.searchParams.set('state', opts.state)
  url.searchParams.set('code_challenge', opts.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  // refresh token을 받으려면 offline 접근 + 재동의 시에도 refresh token 재발급
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  return url.toString()
}

function stateKey(nonce: string): string {
  return `google:oauth:state:${nonce}`
}

export async function saveOAuthState(env: GoogleEnv, nonce: string, state: OAuthState): Promise<void> {
  if (!env.KV) throw new Error('kv_not_configured')
  await env.KV.put(stateKey(nonce), JSON.stringify(state), { expirationTtl: OAUTH_STATE_TTL_SECONDS })
}

export async function consumeOAuthState(env: GoogleEnv, nonce: string): Promise<OAuthState | null> {
  if (!env.KV) return null
  const raw = await env.KV.get(stateKey(nonce))
  if (!raw) return null
  await env.KV.delete(stateKey(nonce))
  try {
    const parsed = JSON.parse(raw) as OAuthState
    if (typeof parsed.verifier !== 'string' || !parsed.verifier) return null
    if (parsed.mode !== 'read' && parsed.mode !== 'write') return null
    return parsed
  } catch {
    return null
  }
}

async function postForm(
  fetchFn: typeof fetch,
  url: string,
  params: Record<string, string>,
): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
  let body: any = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { ok: res.ok, status: res.status, body }
}

/**
 * authorization code → 토큰 교환.
 * 실패 시 { ok:false, error } 반환 — 토큰 값은 에러에 포함하지 않는다.
 */
export async function exchangeCodeForTokens(
  fetchFn: typeof fetch,
  env: GoogleEnv,
  opts: { code: string; verifier: string; redirectUri: string },
): Promise<{ ok: true; tokens: TokenResponse } | { ok: false; error: string }> {
  const { ok, status, body } = await postForm(fetchFn, GOOGLE_TOKEN_URL, {
    client_id: env.GOOGLE_CLIENT_ID || '',
    client_secret: env.GOOGLE_CLIENT_SECRET || '',
    code: opts.code,
    code_verifier: opts.verifier,
    grant_type: 'authorization_code',
    redirect_uri: opts.redirectUri,
  })
  if (!ok || !body?.access_token) {
    return { ok: false, error: body?.error || `token_exchange_failed:${status}` }
  }
  return { ok: true, tokens: body as TokenResponse }
}

/**
 * refresh token → 새 access token 교환.
 * Google은 refresh 응답에 새 refresh token을 주지 않는 경우가 많으므로
 * 기존 refresh token은 호출부가 유지해야 한다.
 */
export async function refreshAccessToken(
  fetchFn: typeof fetch,
  env: GoogleEnv,
  refreshToken: string,
): Promise<
  | { ok: true; accessToken: string; expiresIn: number; scope?: string }
  | { ok: false; error: string; invalidGrant: boolean }
> {
  const { ok, status, body } = await postForm(fetchFn, GOOGLE_TOKEN_URL, {
    client_id: env.GOOGLE_CLIENT_ID || '',
    client_secret: env.GOOGLE_CLIENT_SECRET || '',
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  if (!ok || !body?.access_token) {
    return {
      ok: false,
      error: body?.error || `token_refresh_failed:${status}`,
      invalidGrant: body?.error === 'invalid_grant',
    }
  }
  return {
    ok: true,
    accessToken: body.access_token as string,
    expiresIn: Number(body.expires_in) || 3600,
    scope: body.scope as string | undefined,
  }
}

/** 토큰 철회 — 베스트 에포트. 실패해도 호출부는 로컬 행을 삭제한다. */
export async function revokeToken(fetchFn: typeof fetch, token: string): Promise<boolean> {
  try {
    const { ok } = await postForm(fetchFn, GOOGLE_REVOKE_URL, { token })
    return ok
  } catch {
    return false
  }
}
