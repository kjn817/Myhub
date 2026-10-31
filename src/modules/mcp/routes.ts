/**
 * MCP 모듈 라우트 — POST /api/mcp (단일 엔드포인트, Streamable HTTP)
 * + 토큰 관리 (/api/mcp/tokens — PIN 세션 전용)
 *
 * 인증 (두 가지 중 하나 — 미인증 요청은 401):
 * - PIN 세션: 기존 myhub_session 쿠키 (verifySessionForEnv 재사용).
 * - MCP 토큰: Authorization: Bearer <token> (mcp_tokens, 해시만 저장).
 *
 * 라우팅 주의: 전역 인증 미들웨어(src/index.ts)는 /api/*에 세션을 요구한다.
 * MCP 클라이언트는 쿠키를 못 보내므로 정확한 경로 `/api/mcp`만 allowlist에
 * 올려두고, 이 모듈 안에서 직접 인증한다. 토큰 관리 경로(/api/mcp/tokens*)는
 * allowlist에 없어 전역 미들웨어가 먼저 세션을 강제하고, 핸들러에서도
 * 한 번 더 검증한다 (이중화).
 *
 * 토큰 값은 로그·에러 응답에 절대 포함하지 않는다.
 * sampling·roots는 구현하지 않는다 (2026-07-28 스펙에서 폐지 예고).
 * OAuth 2.1 풀 구현은 하지 않는다 (개인용 단일 사용자).
 * Tasks 확장(tasks/get·update·cancel)은 SDK 2.4.0에 런타임이 없어
 * 이 모듈이 가로채 tasks.ts 디스패처로 답한다 (tools/call의 태스크
 * 반환만 SDK를 통한다). server/discover의 확장 광고는 server.ts의
 * capabilities.extensions에서 나온다.
 */

import { Hono } from 'hono'
import type { Env } from '../../types'
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server'
import {
  getAuthEmail,
  verifySessionForEnv,
  checkRateLimit,
  checkRateLimitForIp,
  getClientIp,
  type SessionInfo,
} from '../auth/routes'
import { buildMcpServer } from './server'
import { handleTasksRequest, isWellFormedTasksRequest } from './tasks'
import {
  issueMcpToken,
  verifyMcpToken,
  listMcpTokens,
  revokeMcpToken,
  MAX_ACTIVE_MCP_TOKENS,
} from './tokens'

export const mcpApp = new Hono<{ Bindings: Env }>()

// ---------------------------------------------------------------------------
// 인증
// ---------------------------------------------------------------------------

type McpAuth = {
  email: string
  method: 'session' | 'token'
  /** 검증된 자격 증명 원문 (authInfo.token용 — 메모리 내에서만 쓰고 로그 금지). */
  credential: string
}

/**
 * MCP 요청 인증 — 세션 쿠키 또는 Bearer MCP 토큰.
 * 둘 다 없거나 검증에 실패하면 null (호출자가 401로 매핑).
 */
export async function authenticateMcpRequest(
  c: { req: { header(name: string): string | undefined }; env: Env }
): Promise<McpAuth | null> {
  const cookie = c.req.header('Cookie') || ''
  const m = cookie.match(/myhub_session=([^;]+)/)
  if (m) {
    const allowed = getAuthEmail(c.env)
    const session = await verifySessionForEnv(c.env, m[1], allowed || undefined)
    if (session) {
      return { email: session.email, method: 'session', credential: m[1] }
    }
  }
  const authz = c.req.header('Authorization') || ''
  const bm = /^Bearer\s+(.+)$/i.exec(authz)
  if (bm) {
    const v = await verifyMcpToken(c.env.DB, bm[1].trim())
    if (v) {
      return { email: v.email, method: 'token', credential: bm[1].trim() }
    }
  }
  return null
}

/**
 * 인증 실패 시 속도 제한 (best-effort — rate_limits 테이블이 없는
 * DB(0051 미적용)에서는 제한 없이 401만 돌려준다).
 * 발신자별 20회/시간 + 전역 100회/시간 (auth /verify·/pin-login과 같은 상한).
 * 상한 초과 시 true.
 */
async function isMcpAuthRateLimited(c: { req: { header(name: string): string | undefined }; env: Env }): Promise<boolean> {
  try {
    if (await checkRateLimitForIp(c.env.DB, getClientIp(c), 'mcpfailip', 20, 3600)) {
      return true
    }
    if (await checkRateLimit(c.env.DB, 'mcpfail:global', 100, 3600)) {
      return true
    }
  } catch {
    // 속도 제한 인프라 장애는 인증 자체를 막지 않는다 (401로 진행).
  }
  return false
}

/** 토큰 관리 엔드포인트용 세션 확인 (전역 미들웨어 뒤의 이중화). */
async function requireSession(
  c: { req: { header(name: string): string | undefined }; env: Env }
): Promise<SessionInfo | null> {
  const cookie = c.req.header('Cookie') || ''
  const m = cookie.match(/myhub_session=([^;]+)/)
  if (!m) return null
  const allowed = getAuthEmail(c.env)
  return verifySessionForEnv(c.env, m[1], allowed || undefined)
}

/**
 * Tasks 확장 메서드 가로채기. well-formed tasks/* 요청이면 디스패처
 * 응답을 돌려주고, 아니면 null (호출자가 SDK 핸들러로 넘긴다).
 * 본문이 없거나 JSON이 아니면 SDK가 자신의 오류를 내게 null을 돌려준다.
 */
async function tryHandleTasksRequest(
  c: { req: { raw: Request } ; env: Env },
  email: string,
): Promise<Response | null> {
  let body: unknown
  try {
    body = await c.req.raw.clone().json()
  } catch {
    return null
  }
  if (!body || typeof body !== 'object') return null
  const method = (body as Record<string, unknown>).method
  if (typeof method !== 'string') return null
  if (!isWellFormedTasksRequest(method, c.req.raw.headers, body)) return null
  const params = (body as Record<string, unknown>).params
  const id = (body as Record<string, unknown>).id
  const res = await handleTasksRequest(
    c.env.DB,
    email,
    method,
    params as Record<string, unknown>,
    typeof id === 'string' || typeof id === 'number' ? id : null,
  )
  if (!res) return null
  return new Response(JSON.stringify(res), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ---------------------------------------------------------------------------
// MCP 엔드포인트 — POST /api/mcp
// ---------------------------------------------------------------------------

mcpApp.post('/', async (c) => {
  const auth = await authenticateMcpRequest(c)
  if (!auth) {
    if (await isMcpAuthRateLimited(c)) {
      return c.json({ ok: false, error: '너무 많은 요청. 1시간 후 다시 시도하세요.' }, 429)
    }
    return c.json({ ok: false, error: '인증 필요' }, 401)
  }

  // Tasks 확장 메서드 가로채기 (SDK 2.4.0에 tasks/get·update·cancel
  // 런타임이 없어 404가 난다 — tasks.ts 디스패처가 직접 답한다).
  // 본문은 clone으로 읽어 원본 요청은 그대로 둔다. 게이트를 통과한
  // well-formed 요청만 디스패처로 보내고, 나머지는 SDK로 넘겨 SDK
  // 자신의 -32020/-32602 오류를 그대로 받게 한다.
  const tasksResponse = await tryHandleTasksRequest(c, auth.email)
  if (tasksResponse) return tasksResponse

  // 요청마다 새 서버를 만드는 stateless 팩토리 (세션 상태 없음).
  // responseMode 'json' — SSE 스트림 없이 단일 JSON 본문으로 답한다.
  // legacy 기본값 'stateless' — 2025-era 클라이언트(initialize 핸드셰이크)도
  // 세션 없이 받는다. 2026-07-28 모던 요청이 우선이다.
  const handler = createMcpHandler(
    ({ authInfo }) => buildMcpServer(c.env, authInfo?.clientId ?? auth.email),
    { responseMode: 'json' }
  )
  const authInfo: AuthInfo = {
    token: auth.credential,
    clientId: auth.email,
    scopes: ['mcp:read'],
  }
  try {
    return await handler.fetch(c.req.raw, { authInfo })
  } catch {
    // SDK 내부 오류 — 요청 본문·토큰을 로그에 남기지 않는다.
    return c.json({ ok: false, error: 'MCP 요청 처리 실패' }, 500)
  }
})

// ---------------------------------------------------------------------------
// MCP 토큰 관리 — PIN 세션 전용 (전역 미들웨어 + 핸들러 이중 검증)
// ---------------------------------------------------------------------------

// 토큰 발급 — 평문 토큰은 이 응답에서만 얻을 수 있다. 다시 조회할 수 없다.
mcpApp.post('/tokens', async (c) => {
  const session = await requireSession(c)
  if (!session) return c.json({ ok: false, error: '로그인이 필요합니다.' }, 401)
  const body = await c.req.json<{ label?: string }>().catch(() => ({} as { label?: string }))
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 100) : ''
  let issued: { id: number; token: string; label: string; created_at: string } | null
  try {
    issued = await issueMcpToken(c.env.DB, session.email, label || 'MCP 토큰')
  } catch {
    return c.json({ ok: false, error: '토큰 발급 실패' }, 500)
  }
  if (!issued) {
    return c.json(
      { ok: false, error: `활성 토큰은 최대 ${MAX_ACTIVE_MCP_TOKENS}개까지 발급할 수 있습니다. 쓰지 않는 토큰을 먼저 폐기하세요.` },
      400
    )
  }
  return c.json(
    { ok: true, id: issued.id, token: issued.token, label: issued.label, created_at: issued.created_at },
    201
  )
})

// 토큰 목록 — 해시·토큰 값은 절대 포함하지 않는다.
mcpApp.get('/tokens', async (c) => {
  const session = await requireSession(c)
  if (!session) return c.json({ ok: false, error: '로그인이 필요합니다.' }, 401)
  try {
    const tokens = await listMcpTokens(c.env.DB, session.email)
    return c.json({ ok: true, tokens })
  } catch {
    return c.json({ ok: false, error: '토큰 목록 조회 실패' }, 500)
  }
})

// 토큰 폐기 — revoked_at을 찍는다 (행은 감사 추적용으로 남는다).
mcpApp.delete('/tokens/:id', async (c) => {
  const session = await requireSession(c)
  if (!session) return c.json({ ok: false, error: '로그인이 필요합니다.' }, 401)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id < 1) {
    return c.json({ ok: false, error: '유효하지 않은 ID' }, 400)
  }
  try {
    const revoked = await revokeMcpToken(c.env.DB, id, session.email)
    if (!revoked) return c.json({ ok: false, error: 'not_found' }, 404)
    return c.json({ ok: true })
  } catch {
    return c.json({ ok: false, error: '토큰 폐기 실패' }, 500)
  }
})
