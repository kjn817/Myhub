/**
 * Groq Provider Adapter 테스트 — 100% 커버리지 목표
 */
/// <reference types="jest" />
import { GroqAdapter } from '../../src/ai/providers/groq'
import { ProviderError } from '../../src/ai/types'

const mockFetch = jest.fn()
global.fetch = mockFetch as any

if (!AbortSignal.timeout) {
  (AbortSignal as any).timeout = (ms: number) => {
    const controller = new AbortController()
    return controller.signal
  }
}

// toJsonSchema mock - actual module may have complex deps
jest.mock('../../src/ai/tools/registry', () => ({
  toJsonSchema: jest.fn((params: any) => params),
}))

describe('GroqAdapter', () => {
  let adapter: GroqAdapter

  beforeEach(() => {
    mockFetch.mockClear()
    adapter = new GroqAdapter({ apiKey: 'test-key', model: 'groq-test' })
  })

  describe('constructor & basic', () => {
    test('provider와 modelId 설정', () => {
      expect(adapter.provider).toBe('groq')
      expect(adapter.modelId).toBe('groq-test')
    })
  })

  describe('setSystemPrompt / addUserMessage', () => {
    test('setSystemPrompt — 첫 설정', () => {
      adapter.setSystemPrompt('sys')
      const msgs = adapter.getMessages()
      expect(msgs[0].role).toBe('system')
      expect(msgs[0].content).toBe('sys')
    })

    test('setSystemPrompt — 기존 교체', () => {
      adapter.setSystemPrompt('old')
      adapter.setSystemPrompt('new')
      const msgs = adapter.getMessages()
      expect(msgs.filter((m) => m.role === 'system')).toHaveLength(1)
      expect(msgs[0].content).toBe('new')
    })

    test('addUserMessage', () => {
      adapter.addUserMessage('hello')
      const msgs = adapter.getMessages()
      expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'hello' })
    })

    test('getMessages는 복사본', () => {
      adapter.addUserMessage('hi')
      const m1 = adapter.getMessages()
      m1.push({ role: 'user' })
      expect(adapter.getMessages()).toHaveLength(1)
    })
  })

  describe('next() — 성공', () => {
    const mockTool = {
      name: 'test_tool',
      description: 'test',
      parameters: { type: 'object', properties: {} },
      mode: 'read' as const,
    }

    function mockGroqResponse(overrides: any = {}) {
      return {
        choices: [
          {
            message: { role: 'assistant', content: 'hello' },
            finish_reason: 'stop',
            ...overrides.choice,
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        ...overrides.root,
      }
    }

    function mockOkResponse(data: any) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => data,
      } as any)
    }

    test('텍스트 응답', async () => {
      mockOkResponse(mockGroqResponse())
      adapter.addUserMessage('hi')
      const step = await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })

      expect(step.text).toBe('hello')
      expect(step.toolCalls).toHaveLength(0)
      expect(step.finishReason).toBe('stop')
      expect(step.usage.inputTokens).toBe(10)
      expect(step.usage.source).toBe('provider')
    })

    test('systemPrompt 옵션', async () => {
      mockOkResponse(mockGroqResponse())
      adapter.addUserMessage('hi')
      await adapter.next({
        tools: [],
        toolChoice: 'auto',
        maxOutputTokens: 100,
        systemPrompt: 'be nice',
      })
      const msgs = adapter.getMessages()
      expect(msgs[0].role).toBe('system')
    })

    test('tools 포함', async () => {
      mockOkResponse(mockGroqResponse())
      adapter.addUserMessage('hi')
      await adapter.next({ tools: [mockTool], toolChoice: 'auto', maxOutputTokens: 100 })

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.tools).toHaveLength(1)
      expect(body.tools[0].function.name).toBe('test_tool')
      expect(body.tool_choice).toBeUndefined()
    })

    test('toolChoice none → tool_choice: none', async () => {
      mockOkResponse(mockGroqResponse())
      adapter.addUserMessage('hi')
      await adapter.next({ tools: [mockTool], toolChoice: 'none', maxOutputTokens: 100 })

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.tool_choice).toBe('none')
    })

    test('tool_calls → ToolCall 변환', async () => {
      mockOkResponse(
        mockGroqResponse({
          choice: {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  function: { name: 'search', arguments: '{"q":"x"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        })
      )
      adapter.addUserMessage('hi')
      const step = await adapter.next({ tools: [mockTool], toolChoice: 'auto', maxOutputTokens: 100 })

      expect(step.toolCalls).toHaveLength(1)
      expect(step.toolCalls[0].id).toBe('call-1')
      expect(step.toolCalls[0].name).toBe('search')
      expect(step.toolCalls[0].args).toEqual({ q: 'x' })
      expect(step.finishReason).toBe('tool_calls')
    })

    test('tool_call ID 없으면 생성', async () => {
      mockOkResponse(
        mockGroqResponse({
          choice: {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ function: { name: 'x', arguments: '{}' } }],
            },
            finish_reason: 'tool_calls',
          },
        })
      )
      adapter.addUserMessage('hi')
      const step = await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.toolCalls[0].id).toMatch(/^groq-/)
    })

    test('잘못된 JSON arguments → parseError', async () => {
      mockOkResponse(
        mockGroqResponse({
          choice: {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'c1', function: { name: 'x', arguments: 'not-json{{' } }],
            },
            finish_reason: 'tool_calls',
          },
        })
      )
      adapter.addUserMessage('hi')
      const step = await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.toolCalls[0].parseError).toBe(true)
      expect(step.toolCalls[0].args).toEqual({})
    })

    test('arguments 없으면 빈 객체', async () => {
      mockOkResponse(
        mockGroqResponse({
          choice: {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'c1', function: { name: 'x' } }],
            },
            finish_reason: 'tool_calls',
          },
        })
      )
      adapter.addUserMessage('hi')
      const step = await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.toolCalls[0].args).toEqual({})
    })

    test('function name 없으면 빈 문자열', async () => {
      mockOkResponse(
        mockGroqResponse({
          choice: {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'c1', function: {} }],
            },
            finish_reason: 'tool_calls',
          },
        })
      )
      adapter.addUserMessage('hi')
      const step = await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.toolCalls[0].name).toBe('')
    })

    test('finish_reason length → length', async () => {
      mockOkResponse(mockGroqResponse({ choice: { finish_reason: 'length' } }))
      adapter.addUserMessage('hi')
      const step = await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.finishReason).toBe('length')
    })

    test('finish_reason tool_calls (문자열) → tool_calls', async () => {
      mockOkResponse(
        mockGroqResponse({
          choice: {
            message: { role: 'assistant', content: null },
            finish_reason: 'tool_calls',
          },
        })
      )
      adapter.addUserMessage('hi')
      const step = await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      // toolCalls가 없어도 finish_reason이 tool_calls면 tool_calls
      expect(step.finishReason).toBe('tool_calls')
    })

    test('알 수 없는 finish_reason → unknown', async () => {
      mockOkResponse(mockGroqResponse({ choice: { finish_reason: 'weird' } }))
      adapter.addUserMessage('hi')
      const step = await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.finishReason).toBe('unknown')
    })

    test('usage 없으면 unavailable', async () => {
      mockOkResponse({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] })
      adapter.addUserMessage('hi')
      const step = await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.usage.source).toBe('unavailable')
    })

    test('content null → text null', async () => {
      mockOkResponse(
        mockGroqResponse({ choice: { message: { role: 'assistant', content: null }, finish_reason: 'stop' } })
      )
      adapter.addUserMessage('hi')
      const step = await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.text).toBeNull()
    })

    test('assistant 메시지 보존', async () => {
      mockOkResponse(mockGroqResponse())
      adapter.addUserMessage('hi')
      await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      const msgs = adapter.getMessages()
      expect(msgs[msgs.length - 1].role).toBe('assistant')
    })

    test('Authorization 헤더', async () => {
      mockOkResponse(mockGroqResponse())
      const a2 = new GroqAdapter({ apiKey: 'KEY123', model: 'm' })
      a2.addUserMessage('hi')
      await a2.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })

      const opts = mockFetch.mock.calls[0][1]
      expect(opts.headers.Authorization).toBe('Bearer KEY123')
      expect(mockFetch.mock.calls[0][0]).toBe('https://api.groq.com/openai/v1/chat/completions')
    })

    test('max_tokens 전송', async () => {
      mockOkResponse(mockGroqResponse())
      adapter.addUserMessage('hi')
      await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 555 })
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.max_tokens).toBe(555)
      expect(body.temperature).toBe(0.1)
    })
  })

  describe('next() — 에러', () => {
    test('429 + retry-after 헤더', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (k: string) => (k === 'retry-after' ? '5' : null) },
      } as any)
      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterMs: 5000 })
    })

    test('던져지는 오류는 실제 Error 객체 (결함 4 수정)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (k: string) => (k === 'retry-after' ? '5' : null) },
      } as any)
      adapter.addUserMessage('hi')
      const p = adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      // 구 코드는 일반 객체를 던져 .toThrow() 계열로 잡히지 않았다.
      await expect(p).rejects.toThrow('Rate limited')
      await expect(p).rejects.toBeInstanceOf(Error)
      await expect(p).rejects.toBeInstanceOf(ProviderError)
      await expect(p).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterMs: 5000 })
    })

    test('429 retry-after 없음', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => null },
      } as any)
      adapter.addUserMessage('hi')
      const err = await adapter
        .next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
        .catch((e) => e)
      expect(err.code).toBe('RATE_LIMITED')
      expect(err.retryAfterMs).toBeUndefined()
    })

    test('401 → AUTH_ERROR', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401, headers: { get: () => null } } as any)
      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'AUTH_ERROR' })
    })

    test('403 → AUTH_ERROR', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403, headers: { get: () => null } } as any)
      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'AUTH_ERROR' })
    })

    test('fetch throw (timeout) → TIMEOUT', async () => {
      const err: any = new Error('timeout')
      err.name = 'TimeoutError'
      mockFetch.mockRejectedValueOnce(err)
      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true })
    })

    test('fetch throw (일반) → UNKNOWN', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network down'))
      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'UNKNOWN' })
    })

    test('메시지 없는 에러 → Unknown error', async () => {
      mockFetch.mockRejectedValueOnce({})
      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'UNKNOWN', message: 'Unknown error' })
    })

    test('503 → SERVICE_UNAVAILABLE', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503, headers: { get: () => null } } as any)
      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    })

    test('400 → INVALID_REQUEST', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 400, headers: { get: () => null } } as any)
      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    })

    test('message 없음 → 에러', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ choices: [] }),
      } as any)
      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ provider: 'groq' })
    })

    test('rate_limited 메시지 → RATE_LIMITED', async () => {
      mockFetch.mockRejectedValueOnce(new Error('rate_limited'))
      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    })
  })

  describe('appendToolResults', () => {
    test('성공 결과', () => {
      adapter.appendToolResults([
        { callId: 'c1', name: 't', output: { ok: true, data: { v: 1 } } } as any,
      ])
      const msgs = adapter.getMessages()
      const last = msgs[msgs.length - 1]
      expect(last.role).toBe('tool')
      expect(last.tool_call_id).toBe('c1')
      expect(JSON.parse(last.content)).toEqual({ v: 1 })
    })

    test('실패 결과', () => {
      adapter.appendToolResults([
        { callId: 'c2', name: 't', output: { ok: false, errorCode: 'E', message: 'm' } } as any,
      ])
      const msgs = adapter.getMessages()
      const last = msgs[msgs.length - 1]
      expect(JSON.parse(last.content).error).toBe('E')
    })
  })

  describe('toJsonSchemaForGroq 폴백', () => {
    test('toJsonSchema throw → parameters 직접 사용', async () => {
      const { toJsonSchema } = require('../../src/ai/tools/registry')
      ;(toJsonSchema as jest.Mock).mockImplementationOnce(() => {
        throw new Error('schema fail')
      })

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        }),
      } as any)

      const tool = {
        name: 't',
        description: 'd',
        parameters: { type: 'object' },
        mode: 'read' as const,
      }
      adapter.addUserMessage('hi')
      await adapter.next({ tools: [tool], toolChoice: 'auto', maxOutputTokens: 10 })

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.tools[0].function.parameters).toEqual({ type: 'object' })
    })
  })
})
