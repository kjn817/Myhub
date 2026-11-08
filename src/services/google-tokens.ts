/**
 * Google OAuth 토큰 저장소 — D1 + AES-GCM 암호화 (기본안)
 *
 * 설계: docs/gmail-calendar-design.md §4
 * - Worker secrets는 런타임 토큰 저장소가 될 수 없으므로 D1에 암호화 저장한다.
 * - 암호화는 기존 메모 암호화와 같은 키(MEMO_ENCRYPTION_KEY)·같은 함수(crypto.ts)를 쓴다.
 * - 저장소 최종 선택(D1 유지 vs KV)은 사용자 결정 사항 — 바꾸면 이 파일의
 *   저장소 함수만 교체하면 되고, 호출부·클라이언트는 이 인터페이스에만 의존한다.
 * - 토큰 평문은 로그·에러·반환값에 절대 포함하지 않는다.
 */

import { encryptContent, decryptContent, isEncrypted } from './crypto'
import { refreshAccessToken, type GoogleEnv } from './google-oauth'

export const GOOGLE_PROVIDER = 'google'
// access 만료 60초 전에 미리 갱신한다.
export const REFRESH_MARGIN_MS = 60_000

export interface StoredGoogleTokens {
  provider: string
  email: string
  accessToken: string
  refreshToken: string
  scope: string
  expiresAt: number
  status: 'active' | 'revoked' | 'error'
}

interface TokenRow {
  provider: string
  email: string
  access_token: string
  refresh_token: string
  scope: string
  expires_at: number
  status: string
}

export interface GoogleTokenEnv extends GoogleEnv {
  DB: D1Database
  MEMO_ENCRYPTION_KEY?: string
}

async function decryptToken(env: GoogleTokenEnv, value: string): Promise<string> {
  if (!value) return ''
  if (!isEncrypted(value)) return '' // 평문 토큰은 저장하지 않으므로 복호화 실패 취급
  try {
    return await decryptContent(env as any, value)
  } catch {
    return ''
  }
}

function rowToStored(row: TokenRow): StoredGoogleTokens {
  return {
    provider: row.provider,
    email: row.email,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    scope: row.scope,
    expiresAt: Number(row.expires_at) || 0,
    status: row.status === 'revoked' ? 'revoked' : row.status === 'error' ? 'error' : 'active',
  }
}

/** 저장된 토큰 행 조회 (복호화 전 — 내부용). */
async function getTokenRow(env: GoogleTokenEnv): Promise<TokenRow | null> {
  const row = await env.DB.prepare(
    'SELECT provider, email, access_token, refresh_token, scope, expires_at, status ' +
      'FROM google_integrations WHERE provider = ?',
  )
    .bind(GOOGLE_PROVIDER)
    .first<TokenRow>()
  return row ?? null
}

/** 토큰 저장 (신규 연동·재연동). 기존 행이 있으면 교체한다. */
export async function saveGoogleTokens(
  env: GoogleTokenEnv,
  opts: { email: string; accessToken: string; refreshToken: string; scope: string; expiresIn: number },
): Promise<void> {
  const expiresAt = Date.now() + opts.expiresIn * 1000
  const encAccess = await encryptContent(env as any, opts.accessToken)
  const encRefresh = opts.refreshToken ? await encryptContent(env as any, opts.refreshToken) : ''
  await env.DB.prepare(
    `INSERT INTO google_integrations (provider, email, access_token, refresh_token, scope, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active')
     ON CONFLICT(provider) DO UPDATE SET
       email = excluded.email,
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       scope = excluded.scope,
       expires_at = excluded.expires_at,
       status = 'active',
       updated_at = datetime('now')`,
  )
    .bind(GOOGLE_PROVIDER, opts.email, encAccess, encRefresh, opts.scope, expiresAt)
    .run()
}

/** 저장된 토큰 조회 (복호화됨). 없거나 복호화 실패 시 null. */
export async function getGoogleTokens(env: GoogleTokenEnv): Promise<StoredGoogleTokens | null> {
  const row = await getTokenRow(env)
  if (!row || row.status === 'revoked') return null
  const accessToken = await decryptToken(env, row.access_token)
  const refreshToken = await decryptToken(env, row.refresh_token)
  if (!accessToken) return null
  return { ...rowToStored(row), accessToken, refreshToken }
}

/** 연동 상태 요약 — 토큰 값은 절대 반환하지 않는다. */
export async function getGoogleStatus(env: GoogleTokenEnv): Promise<{
  connected: boolean
  email?: string
  scope?: string
  expiresAt?: number
  status?: string
  needsReauth?: boolean
}> {
  const row = await getTokenRow(env)
  if (!row) return { connected: false }
  if (row.status === 'revoked') {
    return {
      connected: false,
      email: row.email || undefined,
      scope: row.scope || undefined,
      expiresAt: Number(row.expires_at) || undefined,
      status: 'revoked',
      needsReauth: true,
    }
  }
  const accessToken = await decryptToken(env, row.access_token)
  if (!accessToken) return { connected: false, status: 'error' }
  return {
    connected: true,
    email: row.email || undefined,
    scope: row.scope || undefined,
    expiresAt: Number(row.expires_at) || undefined,
    status: row.status,
  }
}

/** 토큰 상태 변경 (revoked/error). */
export async function setGoogleTokenStatus(
  env: GoogleTokenEnv,
  status: 'active' | 'revoked' | 'error',
): Promise<void> {
  await env.DB.prepare(
    "UPDATE google_integrations SET status = ?, updated_at = datetime('now') WHERE provider = ?",
  )
    .bind(status, GOOGLE_PROVIDER)
    .run()
}

/** 연동 해제 — 로컬 행 삭제. revoke API 호출은 호출부(라우트)에서 베스트 에포트로 수행한다. */
export async function deleteGoogleTokens(env: GoogleTokenEnv): Promise<void> {
  await env.DB.prepare('DELETE FROM google_integrations WHERE provider = ?').bind(GOOGLE_PROVIDER).run()
}

/** scope에 캘린더 쓰기가 포함됐는지 (GCAL_CREATE 가드용). */
export function hasCalendarWriteScope(tokens: StoredGoogleTokens | null): boolean {
  if (!tokens) return false
  return tokens.scope.split(/\s+/).includes('https://www.googleapis.com/auth/calendar.events')
}

export function hasGmailSendScope(tokens: StoredGoogleTokens | null): boolean {
  if (!tokens) return false
  return tokens.scope.split(/\s+/).includes('https://www.googleapis.com/auth/gmail.send')
}

/**
 * 유효한 access token 확보 — 만료가 임박하면 refresh로 교환해 저장한다.
 * - 토큰 없음 → { ok:false, reason:'not_connected' }
 * - refresh 실패(invalid_grant) → status를 revoked로 바꾸고 { ok:false, reason:'revoked' }
 * - 동시 갱신: 만료 시각을 조건으로 UPDATE하므로 먼저 갱신한 쪽만 저장된다.
 *   (두 번째 호출은 저장된 새 토큰을 다시 읽어 쓴다 — D1 단일 행이라 경합 창이 짧다.)
 */
export async function getValidAccessToken(
  fetchFn: typeof fetch,
  env: GoogleTokenEnv,
): Promise<
  | { ok: true; accessToken: string; tokens: StoredGoogleTokens }
  | { ok: false; reason: 'not_connected' | 'revoked' | 'refresh_failed' }
> {
  try {
    const raw = await getTokenRow(env)
    if (raw?.status === 'revoked') return { ok: false, reason: 'revoked' }
  } catch {
  }
  const tokens = await getGoogleTokens(env)
  if (!tokens) return { ok: false, reason: 'not_connected' }
  if (tokens.status === 'revoked') return { ok: false, reason: 'revoked' }

  if (tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return { ok: true, accessToken: tokens.accessToken, tokens }
  }
  if (!tokens.refreshToken) {
    await setGoogleTokenStatus(env, 'revoked')
    return { ok: false, reason: 'revoked' }
  }

  const refreshed = await refreshAccessToken(fetchFn, env, tokens.refreshToken)
  if (!refreshed.ok) {
    if (refreshed.invalidGrant) {
      await setGoogleTokenStatus(env, 'revoked')
      return { ok: false, reason: 'revoked' }
    }
    return { ok: false, reason: 'refresh_failed' }
  }

  const newExpiresAt = Date.now() + refreshed.expiresIn * 1000
  const encAccess = await encryptContent(env as any, refreshed.accessToken)
  // 조건부 UPDATE: 아직 구(舊) 만료 시각인 행만 갱신 — 동시 갱신 시 1회만 성공
  const r = await env.DB.prepare(
    'UPDATE google_integrations SET access_token = ?, expires_at = ?, status = ?, ' +
      "updated_at = datetime('now') WHERE provider = ? AND expires_at = ?",
  )
    .bind(encAccess, newExpiresAt, 'active', GOOGLE_PROVIDER, tokens.expiresAt)
    .run()
  if ((r.meta?.changes ?? 0) === 0) {
    // 다른 호출이 먼저 갱신했다 — 저장된 새 토큰을 다시 읽는다
    const fresh = await getGoogleTokens(env)
    if (fresh && fresh.expiresAt > Date.now()) {
      return { ok: true, accessToken: fresh.accessToken, tokens: fresh }
    }
    return { ok: false, reason: 'refresh_failed' }
  }
  const updated: StoredGoogleTokens = {
    ...tokens,
    accessToken: refreshed.accessToken,
    expiresAt: newExpiresAt,
    status: 'active',
  }
  return { ok: true, accessToken: refreshed.accessToken, tokens: updated }
}
