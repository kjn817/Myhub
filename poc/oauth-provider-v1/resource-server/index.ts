/**
 * OAuth Provider v1 POC — 리소스 서버 Worker (MCP 서버).
 *
 * 공식 예제(examples/split-workers/mcp-server)를 MyHub MCP에 맞게 옮긴 것이다.
 * - `OAuthResourceServer`가 RFC 9728 메타데이터 발행 + 401 챌린지 + audience 검사를 맡는다.
 * - 토큰 검증은 Service Binding으로 인증 서버에 위임한다.
 *   단, `mcp_` 형태의 기존 MCP 토큰은 D1에서 직접 검증한다
 *   (라이브러리 문서 "Alongside your own tokens" 패턴 — 형태 검사 후 위임).
 *   기존 토큰은 스코프 없이 발급됐으므로 `mcp:read`로만 매핑한다.
 * - 스코프 검사는 핸들러가 직접 한다 (`requiredScopes`는 광고일 뿐 강제 아님).
 *   `tools/call` 요청의 도구명을 보고 쓰기 도구에는
 *   `insufficientScope(ctx.auth, ['mcp:read', 'mcp:write'])`를 반환한다.
 * - MCP 본체는 실제 코드(`MCP_TOOLS` 읽기 4개 + POC 쓰기 도구 `memo.create`)를 쓴다.
 *   `buildMcpServer`를 그대로 쓰지 않고 등록 루프를 mirror한 것은,
 *   POC Env가 src Env의 부분집합이라 타입 캐스트를 피하기 위함이다.
 *   executor는 같은 함수(`MCP_TOOLS` + `executeMemoCreate`)이다.
 */

import {
  OAuthResourceServer,
  insufficientScope,
  type AuthorizationServerBinding,
} from '@cloudflare/workers-oauth-provider'
import { McpServer, createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server'
import type { ExecutionContext } from '../../../src/ai/types'
import { MCP_TOOLS } from '../../../src/modules/mcp/tools'
import { verifyMcpToken } from '../../../src/modules/mcp/tokens'
import {
  MCP_READ,
  MCP_RESOURCE,
  MCP_WRITE,
  OAUTH_ISSUER,
  WRITE_TOOL_NAMES,
  missingScopes,
} from '../common'
import {
  MemoCreateDefinition,
  MemoCreateInputSchema,
  executeMemoCreate,
} from './memo-create-tool'

export interface AuthProps {
  userId: string
  email: string
}

interface Env {
  DB: D1Database
  AUTH_SERVER: AuthorizationServerBinding<AuthProps>
}

/** 실제 읽기 도구 4개 + POC 쓰기 도구 1개를 등록한다. */
export function buildPocMcpServer(db: D1Database, email: string): McpServer {
  const server = new McpServer({ name: 'myhub', version: '0.1.0' })
  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.definition.name,
      {
        description: tool.definition.description,
        inputSchema: tool.schema,
        annotations: { readOnlyHint: true },
      },
      async (args) => {
        const ctx: ExecutionContext = {
          userId: email,
          requestId: crypto.randomUUID(),
          approvedWrites: false,
        }
        const data = (await tool.executor(args, ctx, { DB: db })) as Record<string, unknown>
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data) }],
          structuredContent: data,
        }
      }
    )
  }
  server.registerTool(
    MemoCreateDefinition.name,
    {
      description: MemoCreateDefinition.description,
      inputSchema: MemoCreateInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const ctx: ExecutionContext = {
        userId: email,
        requestId: crypto.randomUUID(),
        // 스코프 게이트를 통과한 호출만 여기까지 온다. 승인 게이트는
        // 운영 쓰기 도구 도입 시점에 이 executor 앞에 붙는다.
        approvedWrites: true,
      }
      const data = (await executeMemoCreate(args, ctx, { DB: db })) as Record<string, unknown>
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
        structuredContent: data,
      }
    }
  )
  return server
}

/**
 * 이 요청에 필요한 스코프. JSON-RPC 본문을 읽어 `tools/call`의 도구명을 본다.
 * 본문이 없거나 JSON이 아니면 baseline만 요구한다 (MCP 핸들러가 처리한다).
 */
export async function requiredScopesForRequest(request: Request): Promise<string[]> {
  if (request.method !== 'POST') return [MCP_READ]
  const contentType = request.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) return [MCP_READ]
  let body: any
  try {
    body = await request.clone().json()
  } catch {
    return [MCP_READ]
  }
  if (body?.method === 'tools/call' && typeof body?.params?.name === 'string') {
    if (WRITE_TOOL_NAMES.has(body.params.name)) return [MCP_READ, MCP_WRITE]
  }
  return [MCP_READ]
}

export default new OAuthResourceServer<Env, AuthProps>({
  resourceMetadata: {
    resource: MCP_RESOURCE,
    authorization_servers: [OAUTH_ISSUER],
    resource_name: 'MyHub MCP server (OAuth v1 POC)',
  },
  // 모든 접근의 baseline. 광고만 하고, 강제는 아래 핸들러가 한다.
  requiredScopes: [MCP_READ],
  validateToken: (env) => async (resource, token) => {
    // 기존 MCP 토큰: 형태(mcp_)로 먼저 구분해 D1에서 직접 검증한다.
    // 만료된 자사 토큰이 인증 서버로 넘어가지 않게 한다.
    if (token.startsWith('mcp_')) {
      const v = await verifyMcpToken(env.DB, token)
      if (!v) return null
      return {
        props: { userId: v.email, email: v.email },
        audience: resource,
        scope: [MCP_READ],
      }
    }
    return env.AUTH_SERVER.validateToken(resource, token)
  },
  handler: {
    async fetch(request, env, ctx) {
      const needed = await requiredScopesForRequest(request)
      if (missingScopes(ctx.auth.scope, needed).length > 0) {
        // 부족한 스코프만 적는 것이 아니라 연산에 필요한 스코프 전부를 적는다
        // (공식 문서: insufficientScope(ctx.auth, ['mcp:read', 'mcp:write'])).
        return insufficientScope(ctx.auth, needed)
      }
      const handler = createMcpHandler(
        ({ authInfo }) => buildPocMcpServer(env.DB, authInfo?.clientId ?? ctx.props.userId),
        { responseMode: 'json' }
      )
      const authInfo: AuthInfo = {
        token: ctx.auth.token,
        clientId: ctx.props.userId,
        scopes: [...ctx.auth.scope],
      }
      return handler.fetch(request, { authInfo })
    },
  },
})
