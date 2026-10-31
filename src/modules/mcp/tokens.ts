/**
 * MCP 토큰 — 발급·검증·폐기 (D1 `mcp_tokens`, 마이그레이션 0060)
 *
 * 설계 (docs/mcp-server-20261028.md §인증):
 * - 토큰 값은 `mcp_` + base64url(32바이트 CSPRNG). 평문은 발급 시 1회만
 *   반환하고, 저장되는 것은 SHA-256 해시뿐이다 (재조회 불가).
 * - 검증은 해시 동등 조회 + revoked_at NULL 확인. 성공 시 last_used_at을
 *   best-effort로 갱신한다 (갱신 실패가 인증을 막지 않는다).
 * - 토큰 값은 로그·에러 응답에 절대 포함하지 않는다 — 이 파일의 모든
 *   반환·오류는 id/label/타임스탬프만 다룬다.
 * - 활성 토큰 상한(MAX_ACTIVE_MCP_TOKENS)은 발급 전에 검사한다.
 */

import type { DbLike } from '../auth/routes'

export const MCP_TOKEN_PREFIX = 'mcp_'

/** 한 사용자가 동시에 보유할 수 있는 활성(미폐기) 토큰 상한. */
export const MAX_ACTIVE_MCP_TOKENS = 10

/** DbLike + all() — 실제 D1Database와 단위 테스트의 MockDb를 모두 받는다. */
export interface DbLikeWithAll extends DbLike {
  prepare(sql: string): {
    bind(...params: any[]): {
      first<T = unknown>(): Promise<T | null>
      all<T = unknown>(): Promise<{ results: T[] }>
      run(): Promise<{ meta?: { changes?: number } }>
    }
  }
}

export interface McpTokenRow {
  id: number
  email: string
  label: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

/** 해시·토큰 값을 제외한 공개 목록 행. */
export type McpTokenPublic = Omit<McpTokenRow, 'email'>

/** CSPRNG 32바이트 → `mcp_` + base64url(패딩 제거). */
export function generateMcpToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return MCP_TOKEN_PREFIX + b64
}

/** 토큰 값의 SHA-256 해시 (hex). 저장·조회 키로만 쓴다. */
export async function hashMcpToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 토큰 발급 — 평문 토큰은 이 반환에서만 얻을 수 있다.
 * 활성 토큰이 상한에 도달했으면 null을 돌려준다 (호출자가 400으로 매핑).
 * DB 오류는 예외로 전파한다.
 */
export async function issueMcpToken(
  db: DbLike,
  email: string,
  label: string
): Promise<{ id: number; token: string; label: string; created_at: string } | null> {
  const active = await db
    .prepare('SELECT COUNT(*) AS n FROM mcp_tokens WHERE email = ? AND revoked_at IS NULL')
    .bind(email)
    .first<{ n: number }>()
  if ((active?.n ?? 0) >= MAX_ACTIVE_MCP_TOKENS) return null

  const token = generateMcpToken()
  const tokenHash = await hashMcpToken(token)
  const now = new Date().toISOString()
  const r = await db
    .prepare(
      'INSERT INTO mcp_tokens (email, token_hash, label, created_at) VALUES (?, ?, ?, ?)'
    )
    .bind(email, tokenHash, label, now)
    .run()
  return {
    id: Number((r as any).meta?.last_row_id),
    token,
    label,
    created_at: now,
  }
}

/**
 * Bearer 토큰 검증 — 해시 조회 + 미폐기 확인.
 * 실패(미존재·폐기·형식 오류·DB 오류)는 모두 null로 fail-closed 한다.
 * 성공 시 last_used_at 갱신은 best-effort (실패해도 인증은 유지).
 */
export async function verifyMcpToken(
  db: DbLike,
  token: string
): Promise<{ id: number; email: string; label: string } | null> {
  try {
    if (typeof token !== 'string' || !token.startsWith(MCP_TOKEN_PREFIX)) return null
    const tokenHash = await hashMcpToken(token)
    const row = await db
      .prepare(
        'SELECT id, email, label FROM mcp_tokens WHERE token_hash = ? AND revoked_at IS NULL'
      )
      .bind(tokenHash)
      .first<{ id: number; email: string; label: string }>()
    if (!row) return null
    try {
      await db
        .prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?')
        .bind(new Date().toISOString(), row.id)
        .run()
    } catch {
      // last_used_at 갱신 실패는 인증과 무관하다 — 무시한다.
    }
    return row
  } catch {
    return null
  }
}

/** 토큰 목록 — 해시는 절대 돌려주지 않는다. */
export async function listMcpTokens(db: DbLikeWithAll, email: string): Promise<McpTokenPublic[]> {
  const { results } = await db
    .prepare(
      'SELECT id, label, created_at, last_used_at, revoked_at FROM mcp_tokens WHERE email = ? ORDER BY created_at DESC LIMIT 100'
    )
    .bind(email)
    .all<McpTokenPublic>()
  return results || []
}

/**
 * 토큰 폐기 — revoked_at을 찍는 소프트 삭제 (행은 감사 추적용으로 남긴다).
 * 본인 소유 + 아직 미폐기인 행만 폐기한다. 폐기된 행이 있으면 true.
 */
export async function revokeMcpToken(
  db: DbLike,
  id: number,
  email: string
): Promise<boolean> {
  const r = await db
    .prepare(
      'UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND email = ? AND revoked_at IS NULL'
    )
    .bind(new Date().toISOString(), id, email)
    .run()
  return (((r as any).meta?.changes ?? 0) as number) > 0
}
