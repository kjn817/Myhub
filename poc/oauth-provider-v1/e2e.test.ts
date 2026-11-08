/**
 * OAuth Provider v1 POC e2e — 로컬 workerd 하네스에서 분리 구성을 검증한다.
 *
 * 공식 예제(examples/split-workers/e2e.test.ts)의 흐름을 그대로 가져오고,
 * MyHub 단언(실제 MCP 도구 호출·기존 mcp_ 토큰·D1 행 확인)을 얹었다.
 * - 두 Worker는 workerd에서 돌고, 리소스 서버는 Service Binding으로 인증 서버를 부른다.
 * - 운영·스테이징 Worker·D1에는 닿지 않는다. D1은 하네스 로컬 SQLite이다.
 * - POC 메모는 잠기지 않은 테스트용 메모만 쓴다.
 *
 * 실행: cd poc/oauth-provider-v1 && ../../node_modules/.bin/vitest run --config vitest.config.ts
 */

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestHarness } from 'wrangler'
import { issueMcpToken } from '../../src/modules/mcp/tokens'
import { MCP_RESOURCE, OAUTH_ISSUER, SCOPES_SUPPORTED } from './common'

const POC_DIR = path.dirname(fileURLToPath(import.meta.url))

const harness = createTestHarness({
  workers: [
    { configPath: path.join(POC_DIR, 'auth-server', 'wrangler.jsonc') },
    { configPath: path.join(POC_DIR, 'resource-server', 'wrangler.jsonc') },
  ],
})

const auth = harness.getWorker('myhub-oauth-poc-auth')
const mcp = harness.getWorker<{ DB: D1Database }>('myhub-oauth-poc-mcp')

const REDIRECT_URI = 'https://client.example/callback'
const SEEDED_MEMO_TEXT = 'POC 테스트 메모 — OAuth 스코프 검증용'

beforeAll(async () => {
  await harness.listen()
  await mcp.applyD1Migrations('DB')
  const env = await mcp.getEnv()
  await env.DB.prepare('INSERT INTO memos (text, is_locked, sensitivity) VALUES (?, 0, 0)')
    .bind(SEEDED_MEMO_TEXT)
    .run()
  const issued = await issueMcpToken(env.DB as any, 'poc-user@myhub.local', 'POC legacy')
  if (!issued) throw new Error('legacy 토큰 발급 실패')
  legacyToken = issued.token
}, 120000)

afterAll(async () => {
  await harness.close()
})

let legacyToken = ''

async function countMemos(): Promise<number> {
  const env = await mcp.getEnv()
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM memos').first<{ n: number }>()
  return row?.n ?? 0
}

/** MCP 클라이언트처럼 401에서 인증 서버를 발견한다. */
async function discover(): Promise<Record<string, any>> {
  const challenge = await mcp.fetch(MCP_RESOURCE)
  expect(challenge.status).toBe(401)
  const wwwAuth = challenge.headers.get('WWW-Authenticate') ?? ''
  expect(wwwAuth).toContain('scope="mcp:read"')
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(wwwAuth)?.[1]
  expect(metadataUrl).toBeTruthy()
  const meta = (await (await mcp.fetch(metadataUrl!)).json()) as {
    authorization_servers: string[]
    resource: string
  }
  expect(meta.resource).toBe(MCP_RESOURCE)
  expect(meta.authorization_servers).toEqual([OAUTH_ISSUER])
  const as = (await (
    await auth.fetch(`${meta.authorization_servers[0]}/.well-known/oauth-authorization-server`)
  ).json()) as Record<string, any>
  return as
}

/** 공개 클라이언트를 DCR로 등록하고 PKCE 승인을 시작한다. */
async function authorize(
  as: Record<string, string>,
  scope: string,
  resource: string = MCP_RESOURCE
) {
  const client = (await (
    await auth.fetch(as.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' }),
    })
  ).json()) as { client_id: string }

  const verifier = crypto.randomUUID() + crypto.randomUUID()
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  const url = new URL(as.authorization_endpoint)
  for (const [key, value] of Object.entries({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    scope,
    state: 'xyz',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    resource,
  })) {
    url.searchParams.set(key, value)
  }
  const response = await auth.fetch(url, { redirect: 'manual' })
  return { response, clientId: client.client_id, verifier }
}

/** 승인 → 코드 교환 → 액세스 토큰. */
async function accessToken(as: Record<string, string>, scope: string): Promise<string> {
  const { response, clientId, verifier } = await authorize(as, scope)
  expect(response.status).toBe(302)
  const location = response.headers.get('Location')!
  expect(location).toContain('code=')
  const code = new URL(location).searchParams.get('code')!
  const tokens = (await (
    await auth.fetch(as.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
        resource: MCP_RESOURCE,
      }),
    })
  ).json()) as { access_token: string; scope?: string }
  expect(tokens.access_token).toBeTruthy()
  return tokens.access_token
}

/** 평문 JSON-RPC POST (Mcp-* 헤더 없이 — SDK가 그대로 받는다). */
async function mcpRpc(
  token: string | null,
  method: string,
  params: Record<string, unknown>
): Promise<{ status: number; headers: Headers; body: any }> {
  const res = await mcp.fetch(MCP_RESOURCE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await res.text()
  let body: any = null
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('text/event-stream')) {
    // SDK가 initialize 등에 SSE 봉투로 답한다 — data: 행을 모아 마지막 메시지를 쓴다
    // (tests/runtime/mcp-server.test.ts의 parseSse와 같은 방식).
    const messages = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)))
    body = messages[messages.length - 1] ?? null
  } else {
    try {
      body = JSON.parse(text)
    } catch {
      // 403 챌린지 등은 JSON이 아닐 수 있다 — text는 버린다.
    }
  }
  return { status: res.status, headers: res.headers, body }
}

async function initialize(token: string): Promise<void> {
  const r = await mcpRpc(token, 'initialize', {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'poc-e2e', version: '0.1.0' },
  })
  expect(r.status).toBe(200)
  expect(r.body?.result?.serverInfo?.name).toBe('myhub')
}

async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown>
): Promise<{ status: number; headers: Headers; body: any }> {
  return mcpRpc(token, 'tools/call', { name, arguments: args })
}

describe('OAuth Provider v1 POC (split Workers, 로컬 workerd)', () => {
  it('401 discovery: baseline 스코프와 인증 서버 메타데이터를 안내한다', async () => {
    const as = await discover()
    expect(as.issuer).toBe(OAUTH_ISSUER)
    expect(as.scopes_supported).toEqual(SCOPES_SUPPORTED)
    expect(as.registration_endpoint).toBeTruthy()
    expect(as.token_endpoint).toBeTruthy()
  })

  it('mcp:read 토큰으로 실제 읽기 도구(memo.search)가 동작한다', async () => {
    const as = await discover()
    const readToken = await accessToken(as, 'mcp:read')
    await initialize(readToken)
    const r = await callTool(readToken, 'memo.search', { query: 'POC 테스트', limit: 5 })
    expect(r.status).toBe(200)
    const text = r.body?.result?.content?.[0]?.text ?? ''
    const data = JSON.parse(text)
    // 시드한 잠금 해제 메모가 그대로 돌아온다 (정확 일치 — 부분 매칭 단언의 모호함 회피).
    expect(data.matches.some((m: any) => m.excerpt === SEEDED_MEMO_TEXT)).toBe(true)
  })

  it('mcp:read 토큰으로 memo.create를 부르면 403 insufficient_scope이고 메모가 생기지 않는다', async () => {
    const as = await discover()
    const readToken = await accessToken(as, 'mcp:read')
    const before = await countMemos()
    const r = await callTool(readToken, 'memo.create', { text: '읽기 토큰으로 만든 메모' })
    expect(r.status).toBe(403)
    expect(r.headers.get('WWW-Authenticate') ?? '').toContain('error="insufficient_scope"')
    expect(r.headers.get('WWW-Authenticate') ?? '').toContain('scope="mcp:read mcp:write"')
    // 카나리아: 403이 executor 전에 반환돼야 한다 — 행 수가 그대로여야 한다.
    expect(await countMemos()).toBe(before)
  })

  it('step-up 토큰(mcp:read mcp:write)으로는 memo.create가 되고 D1 행이 생긴다', async () => {
    const as = await discover()
    const writeToken = await accessToken(as, 'mcp:read mcp:write')
    await initialize(writeToken)
    const text = 'step-up으로 만든 메모'
    const r = await callTool(writeToken, 'memo.create', { text })
    expect(r.status).toBe(200)
    const id = r.body?.result?.structuredContent?.id
    expect(typeof id).toBe('number')
    const env = await mcp.getEnv()
    const row = await env.DB.prepare('SELECT text FROM memos WHERE id = ?')
      .bind(id)
      .first<{ text: string }>()
    expect(row?.text).toBe(text)
  })

  it('mcp:write 단독 토큰으로는 memo.create가 403이다 (baseline 필요 — 카나리아)', async () => {
    const as = await discover()
    const writeOnly = await accessToken(as, 'mcp:write')
    const before = await countMemos()
    const r = await callTool(writeOnly, 'memo.create', { text: '쓰기 단독 토큰 메모' })
    expect(r.status).toBe(403)
    expect(await countMemos()).toBe(before)
  })

  it('기존 mcp_ 토큰은 읽기(memo.search)가 계속 되고 쓰기는 403이다', async () => {
    await initialize(legacyToken)
    const read = await callTool(legacyToken, 'memo.search', { query: 'POC 테스트', limit: 5 })
    expect(read.status).toBe(200)
    const before = await countMemos()
    const write = await callTool(legacyToken, 'memo.create', { text: '레거시 토큰 메모' })
    expect(write.status).toBe(403)
    expect(write.headers.get('WWW-Authenticate') ?? '').toContain('error="insufficient_scope"')
    expect(await countMemos()).toBe(before)
  })

  it('미등록 리소스로는 authorize가 코드를 발급하지 않는다', async () => {
    const as = await discover()
    const { response } = await authorize(as, 'mcp:read', 'https://evil.example/mcp')
    // invalid_target: 302 에러 리다이렉트 또는 400. 어느 쪽이든 code가 없어야 한다.
    expect([302, 400]).toContain(response.status)
    const location = response.headers.get('Location') ?? ''
    expect(location).not.toContain('code=')
    if (response.status === 302) expect(location).toContain('error=')
  })

  it('토큰 없이 호출하면 401이다', async () => {
    const r = await mcpRpc(null, 'tools/call', {
      name: 'memo.search',
      arguments: { query: 'POC', limit: 5 },
    })
    expect(r.status).toBe(401)
  })
})
