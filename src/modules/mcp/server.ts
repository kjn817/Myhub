/**
 * MCP 서버 본체 — @modelcontextprotocol/server v2 (2026-07-28 스펙)
 *
 * - 요청마다 새 McpServer를 만든다 (stateless — createMcpHandler의
 *   per-request factory). 세션 상태는 어디에도 두지 않는다.
 * - 도구는 MCP_TOOLS(tools.ts)에서 등록한다. inputSchema는 P&E와 같은
 *   Zod 스키마라, tools/list가 내보내는 JSON Schema와
 *   ToolDefinition.parameters가 같은 원본에서 나온다.
 * - 모든 도구는 읽기 전용이다 (annotations.readOnlyHint: true).
 * - 결과는 content(text JSON) + structuredContent를 함께 돌려준다.
 *   단, Tasks 확장 핸들(resultType:'task')은 그대로 내보낸다 — SDK가
 *   flat CreateTaskResult를 통과시키는 것을 프로브로 실측했다.
 * - Tasks 확장(io.modelcontextprotocol/tasks)은 capabilities.extensions로
 *   광고한다. SDK 2.4.0은 확장 메서드의 런타임이 없어 tasks/get·update·
 *   cancel은 routes.ts가 가로채 tasks.ts 디스패처로 답한다.
 */

import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import type { Env } from '../../types'
import type { ExecutionContext } from '../../ai/types'
import { MCP_TOOLS } from './tools'
import { TASKS_EXTENSION_ID, clientDeclaresTasksExtension } from './tasks'

export function buildMcpServer(env: Env, email: string): McpServer {
  const server = new McpServer(
    { name: 'myhub', version: '0.1.0' },
    { capabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } },
  )
  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.definition.name,
      {
        description: tool.definition.description,
        inputSchema: tool.schema,
        annotations: { readOnlyHint: true },
      },
      async (args, sdkCtx) => {
        // 요청의 _meta 봉투에서 Tasks 확장 선언을 읽는다. envelope이
        // 없으면(레거시 era) false — 동기 결과를 낸다.
        const envelope = (sdkCtx as unknown as { mcpReq?: { envelope?: unknown } })?.mcpReq
          ?.envelope
        const ctx: ExecutionContext = {
          userId: email,
          requestId: crypto.randomUUID(),
          approvedWrites: false,
          origin: 'mcp',
          mcpTasksExtension: clientDeclaresTasksExtension(envelope),
        }
        const data = (await tool.executor(args, ctx, env)) as Record<string, unknown>
        // Tasks 핸들은 감싸지 않고 그대로 내보낸다 (SDK가 resultType:'task'를
        // 통과시키고 content:[]만 덧붙인다 — 프로브 실측). CallToolResult
        // 타입에는 태스크 변형이 없어 unknown 경유 캐스트가 필요하다.
        if (data && data.resultType === 'task') {
          return data as unknown as CallToolResult
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data) }],
          structuredContent: data,
        }
      },
    )
  }
  return server
}
