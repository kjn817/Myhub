/// <reference types="jest" />
/**
 * mcp/server.ts 커버리지 보강 — buildMcpServer 도구 등록 (Jest 미호출)
 * 실제 MCP 클라이언트·서버를 InMemoryTransport로 연결해 tools/list로 검증한다.
 * 도구 실행(executor)은 tests/mcp-tools.test.ts가 이미 다루므로 여기서는
 * 등록·노출·읽기 전용 표기·입력 스키마만 검증한다.
 */
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { buildMcpServer } from '../../src/modules/mcp/server'

jest.mock('../../src/services/ai-access', () => ({
  searchAccessibleMemos: jest.fn().mockResolvedValue([
    { id: 1, title: '서울 여행', snippet: '서울 여행 계획 본문' },
  ]),
}))

describe('buildMcpServer — MCP 프로토콜로 도구 5개 노출', () => {
  test('tools/list에 읽기 전용 도구 5개가 등록된다', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = buildMcpServer({ DB: {} } as any, 'user@example.com')
    await server.connect(serverTransport)
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    try {
      await client.connect(clientTransport)
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toEqual([
        'memo.search',
        'schedule.list',
        'todo.list',
        'memory.search',
        'briefing.generate',
      ])
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint).toBe(true)
      }
      const memo = tools.find((t) => t.name === 'memo.search')!
      expect(memo.inputSchema.properties).toHaveProperty('query')
      expect((memo.inputSchema.required as string[] | undefined) ?? []).toContain('query')
      const memory = tools.find((t) => t.name === 'memory.search')!
      expect(memory.inputSchema.properties).toHaveProperty('query')
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('callTool memo.search — 서버가 도구를 실행해 structuredContent를 돌려준다', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = buildMcpServer({ DB: {} } as any, 'user@example.com')
    await server.connect(serverTransport)
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    try {
      await client.connect(clientTransport)
      const result = await client.callTool({ name: 'memo.search', arguments: { query: '서울' } })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toEqual({
        matches: [{ id: 1, title: '서울 여행', excerpt: '서울 여행 계획 본문' }],
      })
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
      expect(JSON.parse(text)).toEqual({
        matches: [{ id: 1, title: '서울 여행', excerpt: '서울 여행 계획 본문' }],
      })
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('서버 정보는 myhub 0.1.0이다', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = buildMcpServer({ DB: {} } as any, 'user@example.com')
    await server.connect(serverTransport)
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    try {
      await client.connect(clientTransport)
      expect(client.getServerVersion()).toEqual({ name: 'myhub', version: '0.1.0' })
    } finally {
      await client.close()
      await server.close()
    }
  })
})
