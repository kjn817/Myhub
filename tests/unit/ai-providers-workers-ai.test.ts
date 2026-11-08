/**
 * Workers AI Provider Adapter 테스트 — 100% 커버리지 목표
 */
/// <reference types="jest" />
import { WorkersAIAdapter } from '../../src/ai/providers/workers-ai'
import { ProviderError } from '../../src/ai/types'

const mockFetch = jest.fn()
global.fetch = mockFetch as any

if (!AbortSignal.timeout) {
  (AbortSignal as any).timeout = (ms: number) => {
    const controller = new AbortController()
    return controller.signal
  }
}

describe('WorkersAIAdapter', () => {
  const mockAi = { run: jest.fn() }

  beforeEach(() => {
    mockFetch.mockClear()
    mockAi.run.mockClear()
  })

  function openAIAdapter() {
    return new WorkersAIAdapter({
      ai: mockAi,
      model: 'test-model',
      apiMode: 'openai',
      accountId: 'acc123',
      apiToken: 'tok123',
    })
  }

  function nativeAdapter() {
    return new WorkersAIAdapter({
      ai: mockAi,
      model: 'test-model',
      apiMode: 'native',
    })
  }

  describe('constructor & basic', () => {
    test('provider와 modelId', () => {
      const a = nativeAdapter()
      expect(a.provider).toBe('workers-ai')
      expect(a.modelId).toBe('test-model')
    })
  })

  describe('setSystemPrompt / addUserMessage', () => {
    test('setSystemPrompt', () => {
      const a = nativeAdapter()
      a.setSystemPrompt('sys')
      expect(a.getMessages()[0].content).toBe('sys')
    })

    test('setSystemPrompt 교체', () => {
      const a = nativeAdapter()
      a.setSystemPrompt('old')
      a.setSystemPrompt('new')
      expect(a.getMessages().filter((m) => m.role === 'system')).toHaveLength(1)
    })

    test('addUserMessage', () => {
      const a = nativeAdapter()
      a.addUserMessage('hi')
      expect(a.getMessages()[0]).toEqual({ role: 'user', content: 'hi' })
    })

    test('getMessages 복사본', () => {
      const a = nativeAdapter()
      a.addUserMessage('hi')
      const m = a.getMessages()
      m.push({ role: 'user' })
      expect(a.getMessages()).toHaveLength(1)
    })
  })

  describe('next() — openai 모드', () => {
    const mockTool = {
      name: 't',
      description: 'd',
      parameters: { type: 'object' },
      mode: 'read' as const,
    }

    function mockOk(data: any) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => data,
      } as any)
    }

    test('텍스트 응답 (result 래퍼)', async () => {
      mockOk({
        result: { choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] },
      })
      const a = openAIAdapter()
      a.addUserMessage('hello')
      const step = await a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })

      expect(step.text).toBe('hi')
      expect(step.finishReason).toBe('stop')
      expect(step.usage.source).toBe('unavailable')
    })

    test('result 래퍼 없이도 동작', async () => {
      mockOk({
        choices: [{ message: { role: 'assistant', content: 'hi2' }, finish_reason: 'stop' }],
      })
      const a = openAIAdapter()
      a.addUserMessage('hello')
      const step = await a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.text).toBe('hi2')
    })

    test('systemPrompt 옵션', async () => {
      mockOk({ result: { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] } })
      const a = openAIAdapter()
      await a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100, systemPrompt: 'sys' })
      expect(a.getMessages()[0].role).toBe('system')
    })

    test('tools 포함', async () => {
      mockOk({ result: { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] } })
      const a = openAIAdapter()
      a.addUserMessage('hi')
      await a.next({ tools: [mockTool], toolChoice: 'auto', maxOutputTokens: 100 })

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.tools[0].function.name).toBe('t')
      expect(body.tool_choice).toBeUndefined()
    })

    test('toolChoice none → tool_choice none', async () => {
      mockOk({ result: { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] } })
      const a = openAIAdapter()
      a.addUserMessage('hi')
      await a.next({ tools: [], toolChoice: 'none', maxOutputTokens: 100 })

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.tool_choice).toBe('none')
    })

    test('tool_calls 변환', async () => {
      mockOk({
        result: {
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'tc1', function: { name: 'search', arguments: '{"q":"a"}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      })
      const a = openAIAdapter()
      a.addUserMessage('hi')
      const step = await a.next({ tools: [mockTool], toolChoice: 'auto', maxOutputTokens: 100 })

      expect(step.toolCalls).toHaveLength(1)
      expect(step.toolCalls[0].name).toBe('search')
      expect(step.toolCalls[0].args).toEqual({ q: 'a' })
      expect(step.finishReason).toBe('tool_calls')
    })

    test('잘못된 JSON → __parseError', async () => {
      mockOk({
        result: {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: 'c1', function: { name: 'x', arguments: 'bad{{' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      })
      const a = openAIAdapter()
      a.addUserMessage('hi')
      const step = await a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.toolCalls[0].args).toEqual({ __parseError: true })
    })

    test('tool_call id 없으면 생성', async () => {
      mockOk({
        result: {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ function: { name: 'x', arguments: '{}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      })
      const a = openAIAdapter()
      a.addUserMessage('hi')
      const step = await a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.toolCalls[0].id).toMatch(/^wai-/)
    })

    test('message 없으면 에러', async () => {
      mockOk({ result: { choices: [] } })
      const a = openAIAdapter()
      a.addUserMessage('hi')
      await expect(
        a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ provider: 'workers-ai' })
    })

    test('arguments 없으면 빈 객체 (openai)', async () => {
      mockOk({
        result: {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: 'c1', function: { name: 'x' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      })
      const a = openAIAdapter()
      a.addUserMessage('hi')
      const step = await a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.toolCalls[0].args).toEqual({})
    })

    test('function name 없으면 빈 문자열 (openai)', async () => {
      mockOk({
        result: {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: 'c1', function: {} }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      })
      const a = openAIAdapter()
      a.addUserMessage('hi')
      const step = await a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.toolCalls[0].name).toBe('')
    })

    test('!ok → 에러', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 } as any)
      const a = openAIAdapter()
      a.addUserMessage('hi')
      await expect(
        a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ provider: 'workers-ai' })
    })

    test('fetch throw → 에러', async () => {
      mockFetch.mockRejectedValueOnce(new Error('net fail'))
      const a = openAIAdapter()
      a.addUserMessage('hi')
      await expect(
        a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ provider: 'workers-ai' })
    })

    test('accountId/token 없으면 에러', async () => {
      const a = new WorkersAIAdapter({ ai: mockAi, model: 'm', apiMode: 'openai' })
      a.addUserMessage('hi')
      await expect(
        a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ provider: 'workers-ai' })
    })

    test('URL과 헤더 확인', async () => {
      mockOk({ result: { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] } })
      const a = openAIAdapter()
      a.addUserMessage('hi')
      await a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })

      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toContain('acc123/ai/v1/chat/completions')
      expect(opts.headers.Authorization).toBe('Bearer tok123')
    })
  })

  describe('next() — native 모드', () => {
    const mockTool = {
      name: 't',
      description: 'd',
      parameters: { type: 'object' },
      mode: 'read' as const,
    }

    test('ai 바인딩 없으면 에러', async () => {
      const a = new WorkersAIAdapter({ ai: null, model: 'm', apiMode: 'native' })
      a.addUserMessage('hi')
      await expect(
        a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST', message: 'Workers AI binding missing' })
    })

    test('문자열 response → text', async () => {
      mockAi.run.mockResolvedValueOnce({ response: 'hello native' })
      const a = nativeAdapter()
      a.addUserMessage('hi')
      const step = await a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })

      expect(step.text).toBe('hello native')
      expect(step.toolCalls).toHaveLength(0)
      expect(step.finishReason).toBe('stop')
    })

    test('tool_calls 파싱', async () => {
      mockAi.run.mockResolvedValueOnce({
        tool_calls: [{ id: 'n1', name: 'search', arguments: '{"q":"b"}' }],
        response: { content: 'done' },
      })
      const a = nativeAdapter()
      a.addUserMessage('hi')
      const step = await a.next({ tools: [mockTool], toolChoice: 'auto', maxOutputTokens: 100 })

      expect(step.toolCalls).toHaveLength(1)
      expect(step.toolCalls[0].name).toBe('search')
      expect(step.finishReason).toBe('tool_calls')
    })

    test('tool_calls arguments 객체형', async () => {
      mockAi.run.mockResolvedValueOnce({
        tool_calls: [{ id: 'n1', name: 'x', arguments: { a: 1 } }],
      })
      const a = nativeAdapter()
      a.addUserMessage('hi')
      const step = await a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.toolCalls[0].args).toEqual({ a: 1 })
    })

    test('function.name 폴백', async () => {
      mockAi.run.mockResolvedValueOnce({
        tool_calls: [{ id: 'n1', function: { name: 'fn' }, arguments: '{}' }],
      })
      const a = nativeAdapter()
      a.addUserMessage('hi')
      const step = await a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.toolCalls[0].name).toBe('fn')
    })

    test('native id/name 모두 없으면 기본값', async () => {
      mockAi.run.mockResolvedValueOnce({
        tool_calls: [{ arguments: '{}' }],
      })
      const a = nativeAdapter()
      a.addUserMessage('hi')
      const step = await a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.toolCalls[0].id).toMatch(/^wai-native-/)
      expect(step.toolCalls[0].name).toBe('')
    })

    test('native arguments 없으면 빈 객체', async () => {
      mockAi.run.mockResolvedValueOnce({
        tool_calls: [{ id: 'n1', name: 'x' }],
      })
      const a = nativeAdapter()
      a.addUserMessage('hi')
      const step = await a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.toolCalls[0].args).toEqual({})
    })

    test('native response.content 없으면 null', async () => {
      mockAi.run.mockResolvedValueOnce({
        tool_calls: [{ id: 'n1', name: 'x', arguments: '{}' }],
        response: {},
      })
      const a = nativeAdapter()
      a.addUserMessage('hi')
      const step = await a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.text).toBeNull()
    })

    test('native response 자체가 없으면 null', async () => {
      mockAi.run.mockResolvedValueOnce({
        tool_calls: [{ id: 'n1', name: 'x', arguments: '{}' }],
      })
      const a = nativeAdapter()
      a.addUserMessage('hi')
      const step = await a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.text).toBeNull()
    })

    test('기타 응답 → JSON 문자열', async () => {
      mockAi.run.mockResolvedValueOnce({ response: { weird: 123 } })
      const a = nativeAdapter()
      a.addUserMessage('hi')
      const step = await a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.text).toBe(JSON.stringify({ weird: 123 }))
    })

    test('ai.run throw → 에러', async () => {
      mockAi.run.mockRejectedValueOnce(new Error('ai failed'))
      const a = nativeAdapter()
      a.addUserMessage('hi')
      await expect(
        a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ provider: 'workers-ai' })
    })

    test('tools 전달', async () => {
      mockAi.run.mockResolvedValueOnce({ response: 'x' })
      const a = nativeAdapter()
      a.addUserMessage('hi')
      await a.next({ tools: [mockTool], toolChoice: 'auto', maxOutputTokens: 100 })

      const input = mockAi.run.mock.calls[0][1]
      expect(input.tools[0].function.name).toBe('t')
    })

    test('toolChoice none → tools 제외', async () => {
      mockAi.run.mockResolvedValueOnce({ response: 'x' })
      const a = nativeAdapter()
      a.addUserMessage('hi')
      await a.next({ tools: [mockTool], toolChoice: 'none', maxOutputTokens: 100 })

      const input = mockAi.run.mock.calls[0][1]
      expect(input.tools).toBeUndefined()
    })

    test('응답이 messages에 보존', async () => {
      mockAi.run.mockResolvedValueOnce({ response: 'x' })
      const a = nativeAdapter()
      a.addUserMessage('hi')
      await a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })

      const msgs = a.getMessages()
      expect(msgs[msgs.length - 1].role).toBe('assistant')
    })
  })

  describe('appendToolResults', () => {
    test('hasExecutedTools 설정', () => {
      const a = nativeAdapter()
      expect((a as any).hasExecutedTools).toBe(false)
      a.appendToolResults([{ callId: 'c1', name: 't', output: { ok: true, data: 1 } } as any])
      expect((a as any).hasExecutedTools).toBe(true)
    })

    test('빈 배열 → hasExecutedTools 유지', () => {
      const a = nativeAdapter()
      a.appendToolResults([])
      expect((a as any).hasExecutedTools).toBe(false)
    })

    test('성공/실패 메시지', () => {
      const a = nativeAdapter()
      a.appendToolResults([
        { callId: 'c1', name: 't', output: { ok: true, data: { v: 1 } } } as any,
        { callId: 'c2', name: 't', output: { ok: false, errorCode: 'E', message: 'm' } } as any,
      ])
      const msgs = a.getMessages()
      expect(msgs).toHaveLength(2)
      expect(msgs[0].tool_call_id).toBe('c1')
      expect(JSON.parse(msgs[1].content).error).toBe('E')
    })
  })

  describe('toProviderError 분기', () => {
    test('rate 메시지 → RATE_LIMITED', async () => {
      mockAi.run.mockRejectedValueOnce(new Error('rate limit hit'))
      const a = nativeAdapter()
      a.addUserMessage('hi')
      await expect(
        a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true })
    })

    test('던져지는 오류는 실제 Error 객체 (결함 4 수정)', async () => {
      mockAi.run.mockRejectedValueOnce(new Error('rate limit hit'))
      const a = nativeAdapter()
      a.addUserMessage('hi')
      const p = a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      // 구 코드는 일반 객체를 던져 .toThrow() 계열로 잡히지 않았다.
      await expect(p).rejects.toThrow('Rate limited')
      await expect(p).rejects.toBeInstanceOf(Error)
      await expect(p).rejects.toBeInstanceOf(ProviderError)
      await expect(p).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true })
    })

    test('429 메시지 → RATE_LIMITED', async () => {
      mockAi.run.mockRejectedValueOnce(new Error('429 too many'))
      const a = nativeAdapter()
      a.addUserMessage('hi')
      await expect(
        a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    })

    test('auth 메시지 → AUTH_ERROR', async () => {
      mockAi.run.mockRejectedValueOnce(new Error('auth failed'))
      const a = nativeAdapter()
      a.addUserMessage('hi')
      await expect(
        a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'AUTH_ERROR' })
    })

    test('401 → AUTH_ERROR', async () => {
      mockAi.run.mockRejectedValueOnce(new Error('401 unauthorized'))
      const a = nativeAdapter()
      a.addUserMessage('hi')
      await expect(
        a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'AUTH_ERROR' })
    })

    test('timeout → TIMEOUT', async () => {
      const err: any = new Error('timeout')
      err.name = 'TimeoutError'
      mockAi.run.mockRejectedValueOnce(err)
      const a = nativeAdapter()
      a.addUserMessage('hi')
      await expect(
        a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true })
    })

    test('binding missing → INVALID_REQUEST', async () => {
      mockAi.run.mockRejectedValueOnce(new Error('AI binding missing'))
      const a = nativeAdapter()
      a.addUserMessage('hi')
      await expect(
        a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST', message: 'Workers AI binding missing' })
    })

    test('알 수 없는 에러 → UNKNOWN', async () => {
      mockAi.run.mockRejectedValueOnce(new Error('something weird'))
      const a = nativeAdapter()
      a.addUserMessage('hi')
      await expect(
        a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'UNKNOWN' })
    })

    test('빈 메시지 → Unknown error', async () => {
      mockAi.run.mockRejectedValueOnce({})
      const a = nativeAdapter()
      a.addUserMessage('hi')
      await expect(
        a.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ message: 'Unknown error' })
    })
  })
})
