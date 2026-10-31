/**
 * Gemini Provider Adapter 테스트 — 100% 커버리지 목표
 */
/// <reference types="jest" />
import { GeminiAdapter } from '../../src/ai/providers/gemini'
import { ProviderError } from '../../src/ai/types'

// fetch mock
const mockFetch = jest.fn()
global.fetch = mockFetch as any

// AbortSignal.timeout mock (Node 18+ has it, but ensure)
if (!AbortSignal.timeout) {
  (AbortSignal as any).timeout = (ms: number) => {
    const controller = new AbortController()
    return controller.signal
  }
}

describe('GeminiAdapter', () => {
  let adapter: GeminiAdapter

  beforeEach(() => {
    mockFetch.mockClear()
    adapter = new GeminiAdapter({ apiKey: 'test-key', model: 'gemini-test' })
  })

  describe('constructor & basic', () => {
    test('provider와 modelId 설정', () => {
      expect(adapter.provider).toBe('gemini')
      expect(adapter.modelId).toBe('gemini-test')
    })

    test('relay 설정 포함', () => {
      const a = new GeminiAdapter({
        apiKey: 'k',
        model: 'm',
        relayUrl: 'https://relay.test',
        relaySecret: 'secret',
      })
      expect(a.provider).toBe('gemini')
    })
  })

  describe('setSystemPrompt / addUserMessage', () => {
    test('setSystemPrompt', () => {
      adapter.setSystemPrompt('system prompt')
      const contents = adapter.getContents()
      expect(contents).toHaveLength(0) // systemInstruction은 별도 저장
    })

    test('addUserMessage', () => {
      adapter.addUserMessage('hello')
      const contents = adapter.getContents()
      expect(contents).toHaveLength(1)
      expect(contents[0].role).toBe('user')
      expect(contents[0].parts[0].text).toBe('hello')
    })

    test('getContents는 복사본 반환', () => {
      adapter.addUserMessage('hi')
      const c1 = adapter.getContents()
      c1.push({ role: 'user' })
      expect(adapter.getContents()).toHaveLength(1)
    })
  })

  describe('next() — 성공 케이스', () => {
    const mockTool = {
      name: 'test_tool',
      description: 'test',
      parameters: { type: 'object', properties: {} },
      mode: 'read' as const,
    }

    function mockGeminiResponse(overrides: any = {}) {
      return {
        candidates: [
          {
            content: {
              parts: [{ text: 'hello world' }],
            },
            finishReason: 'STOP',
            ...overrides.candidate,
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
        },
        ...overrides.root,
      }
    }

    test('텍스트 응답', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockGeminiResponse(),
      } as any)

      adapter.addUserMessage('hi')
      const step = await adapter.next({
        tools: [],
        toolChoice: 'auto',
        maxOutputTokens: 100,
      })

      expect(step.text).toBe('hello world')
      expect(step.toolCalls).toHaveLength(0)
      expect(step.finishReason).toBe('stop')
      expect(step.usage.inputTokens).toBe(10)
      expect(step.usage.source).toBe('provider')
    })

    test('toolChoice none이면 tools 제외', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockGeminiResponse(),
      } as any)

      adapter.addUserMessage('hi')
      await adapter.next({
        tools: [mockTool],
        toolChoice: 'none',
        maxOutputTokens: 100,
      })

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.tools).toBeUndefined()
    })

    test('tools 포함 시 functionDeclarations 생성', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockGeminiResponse(),
      } as any)

      adapter.addUserMessage('hi')
      await adapter.next({
        tools: [mockTool],
        toolChoice: 'auto',
        maxOutputTokens: 100,
      })

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.tools[0].functionDeclarations[0].name).toBe('test_tool')
    })

    test('systemPrompt 옵션', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockGeminiResponse(),
      } as any)

      adapter.addUserMessage('hi')
      await adapter.next({
        tools: [],
        toolChoice: 'auto',
        maxOutputTokens: 100,
        systemPrompt: 'be helpful',
      })

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.systemInstruction.parts[0].text).toBe('be helpful')
    })

    test('functionCall → ToolCall 변환', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          mockGeminiResponse({
            candidate: {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'search',
                      args: { q: 'test' },
                      id: 'call-123',
                    },
                  },
                ],
              },
              finishReason: 'STOP',
            },
          }),
      } as any)

      adapter.addUserMessage('search please')
      const step = await adapter.next({
        tools: [mockTool],
        toolChoice: 'auto',
        maxOutputTokens: 100,
      })

      expect(step.toolCalls).toHaveLength(1)
      expect(step.toolCalls[0].name).toBe('search')
      expect(step.toolCalls[0].args).toEqual({ q: 'test' })
      expect(step.toolCalls[0].id).toBe('call-123')
      expect(step.toolCalls[0].provider).toBe('gemini')
      expect(step.finishReason).toBe('tool_calls')
    })

    test('functionCall ID 없으면 생성', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          mockGeminiResponse({
            candidate: {
              content: {
                parts: [{ functionCall: { name: 'x', args: {} } }],
              },
            },
          }),
      } as any)

      adapter.addUserMessage('hi')
      const step = await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.toolCalls[0].id).toMatch(/^gemini-/)
    })

    test('MAX_TOKENS → length', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          mockGeminiResponse({ candidate: { content: { parts: [] }, finishReason: 'MAX_TOKENS' } }),
      } as any)

      adapter.addUserMessage('hi')
      const step = await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.finishReason).toBe('length')
    })

    test('알 수 없는 finishReason → unknown', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          mockGeminiResponse({ candidate: { content: { parts: [] }, finishReason: 'WEIRD' } }),
      } as any)

      adapter.addUserMessage('hi')
      const step = await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.finishReason).toBe('unknown')
    })

    test('usageMetadata 없으면 unavailable', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }),
      } as any)

      adapter.addUserMessage('hi')
      const step = await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.usage.source).toBe('unavailable')
      expect(step.usage.inputTokens).toBeUndefined()
    })

    test('여러 text parts 연결', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          mockGeminiResponse({
            candidate: {
              content: { parts: [{ text: 'a' }, { text: 'b' }] },
              finishReason: 'STOP',
            },
          }),
      } as any)

      adapter.addUserMessage('hi')
      const step = await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.text).toBe('ab')
    })

    test('text 없으면 null', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          mockGeminiResponse({
            candidate: { content: { parts: [{ thoughtSignature: 'x' }] }, finishReason: 'STOP' },
          }),
      } as any)

      adapter.addUserMessage('hi')
      const step = await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.text).toBeNull()
    })

    test('모델 응답이 contents에 보존됨', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockGeminiResponse(),
      } as any)

      adapter.addUserMessage('hi')
      await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      const contents = adapter.getContents()
      expect(contents).toHaveLength(2)
      expect(contents[1].role).toBe('model')
    })
  })

  describe('next() — 에러 케이스', () => {
    test('candidates 없음 → 에러', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ candidates: [] }),
      } as any)

      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ provider: 'gemini' })
    })

    test('던져지는 오류는 실제 Error 객체 (결함 4 수정)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ candidates: [] }),
      } as any)

      adapter.addUserMessage('hi')
      const p = adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      await expect(p).rejects.toThrow('Empty response from Gemini')
      await expect(p).rejects.toBeInstanceOf(Error)
      await expect(p).rejects.toBeInstanceOf(ProviderError)
      await expect(p).rejects.toMatchObject({ provider: 'gemini' })
    })

    test('429 → RATE_LIMITED (retryable)', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 429, text: async () => '' } as any)

      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true })
    })

    test('401 → AUTH_ERROR', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'unauthorized' } as any)

      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'AUTH_ERROR', retryable: false })
    })

    test('403 → AUTH_ERROR', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403, text: async () => '' } as any)
      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'AUTH_ERROR' })
    })

    test('API key 메시지 → AUTH_ERROR', async () => {
      mockFetch.mockRejectedValueOnce(new Error('API key invalid'))
      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'AUTH_ERROR' })
    })

    test('timeout → TIMEOUT (retryable)', async () => {
      const err: any = new Error('timeout')
      err.name = 'TimeoutError'
      mockFetch.mockRejectedValueOnce(err)
      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true })
    })

    test('503 → SERVICE_UNAVAILABLE', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503, text: async () => '' } as any)
      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true })
    })

    test('400 → INVALID_REQUEST', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'bad' } as any)
      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    })

    test('지역 제한 → INVALID_REQUEST', async () => {
      mockFetch.mockRejectedValueOnce(new Error('User location is not supported for the API use'))
      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    })

    test('알 수 없는 에러 → UNKNOWN', async () => {
      mockFetch.mockRejectedValueOnce(new Error('weird thing happened'))
      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'UNKNOWN' })
    })

    test('rate_limited 메시지 → RATE_LIMITED', async () => {
      mockFetch.mockRejectedValueOnce(new Error('rate_limited exceeded'))
      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    })
  })

  describe('appendToolResults', () => {
    test('성공 결과 → functionResponse', () => {
      adapter.addUserMessage('hi')
      adapter.appendToolResults([
        { callId: 'c1', name: 'search', output: { ok: true, data: { x: 1 } } } as any,
      ])
      const contents = adapter.getContents()
      const last = contents[contents.length - 1]
      expect(last.role).toBe('user')
      expect(last.parts[0].functionResponse.name).toBe('search')
      expect(last.parts[0].functionResponse.response.result).toEqual({ x: 1 })
    })

    test('실패 결과 → error 포함', () => {
      adapter.appendToolResults([
        { callId: 'c1', name: 'search', output: { ok: false, errorCode: 'E1', message: 'boom' } } as any,
      ])
      const contents = adapter.getContents()
      const last = contents[contents.length - 1]
      expect(last.parts[0].functionResponse.response.error).toBe('E1')
    })
  })

  describe('relay', () => {
    test('relayUrl 있으면 릴레이 호출', async () => {
      const relayAdapter = new GeminiAdapter({
        apiKey: 'k',
        model: 'm',
        relayUrl: 'https://relay.test/gemini',
        relaySecret: 's3cr3t',
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          body: JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'via relay' }] }, finishReason: 'STOP' }],
          }),
        }),
      } as any)

      relayAdapter.addUserMessage('hi')
      const step = await relayAdapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })

      expect(step.text).toBe('via relay')
      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toBe('https://relay.test/gemini')
      expect(opts.headers['X-Relay-Key']).toBe('s3cr3t')
      const body = JSON.parse(opts.body)
      expect(body.model).toBe('m')
      expect(body.key).toBe('k')
    })

    test('릴레이 !ok → 에러', async () => {
      const relayAdapter = new GeminiAdapter({
        apiKey: 'k',
        model: 'm',
        relayUrl: 'https://relay.test',
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, status: 500, body: 'relay exploded' }),
      } as any)

      relayAdapter.addUserMessage('hi')
      await expect(
        relayAdapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ provider: 'gemini' })
    })

    test('릴레이 bad body → 에러', async () => {
      const relayAdapter = new GeminiAdapter({
        apiKey: 'k',
        model: 'm',
        relayUrl: 'https://relay.test',
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, body: 'not-json{{{' }),
      } as any)

      relayAdapter.addUserMessage('hi')
      await expect(
        relayAdapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ provider: 'gemini' })
    })

    test('릴레이 HTTP !ok → 에러', async () => {
      const relayAdapter = new GeminiAdapter({
        apiKey: 'k',
        model: 'm',
        relayUrl: 'https://relay.test',
      })
      mockFetch.mockResolvedValueOnce({ ok: false, status: 502 } as any)

      relayAdapter.addUserMessage('hi')
      await expect(
        relayAdapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ provider: 'gemini' })
    })
  })

  describe('sanitizeForGemini', () => {
    test('지원하지 않는 필드 제거', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
        }),
      } as any)

      const tool = {
        name: 't',
        description: 'd',
        parameters: {
          type: 'object',
          properties: { a: { type: 'string' } },
          additionalProperties: false,
          $schema: 'x',
          examples: ['e'],
        },
        mode: 'read' as const,
      }
      adapter.addUserMessage('hi')
      await adapter.next({ tools: [tool], toolChoice: 'auto', maxOutputTokens: 10 })

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      const params = body.tools[0].functionDeclarations[0].parameters
      expect(params.additionalProperties).toBeUndefined()
      expect(params.$schema).toBeUndefined()
      expect(params.examples).toBeUndefined()
      expect(params.properties.a.type).toBe('string')
    })

    test('배열 스키마 재귀 처리', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
        }),
      } as any)

      const tool = {
        name: 't',
        description: 'd',
        parameters: {
          type: 'array',
          items: [{ type: 'string', examples: ['x'] }],
        },
        mode: 'read' as const,
      }
      adapter.addUserMessage('hi')
      await adapter.next({ tools: [tool], toolChoice: 'auto', maxOutputTokens: 10 })

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.tools[0].functionDeclarations[0].parameters.items[0].examples).toBeUndefined()
    })

    test('null/원시값은 그대로', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
        }),
      } as any)

      const tool = {
        name: 't',
        description: 'd',
        parameters: { type: 'string' } as any,
        mode: 'read' as const,
      }
      adapter.addUserMessage('hi')
      await adapter.next({ tools: [tool], toolChoice: 'auto', maxOutputTokens: 10 })
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.tools[0].functionDeclarations[0].parameters.type).toBe('string')
    })
  })

  describe('generationConfig', () => {
    test('maxOutputTokens와 temperature 전송', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
        }),
      } as any)

      adapter.addUserMessage('hi')
      await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 777 })

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.generationConfig.maxOutputTokens).toBe(777)
      expect(body.generationConfig.temperature).toBe(0.1)
    })

    test('API key가 URL에 포함됨', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
        }),
      } as any)

      const a2 = new GeminiAdapter({ apiKey: 'KEY123', model: 'my-model' })
      a2.addUserMessage('hi')
      await a2.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 10 })

      const url = mockFetch.mock.calls[0][0]
      expect(url).toContain('my-model:generateContent')
      expect(url).toContain('key=KEY123')
    })
  })

  describe('엣지 케이스', () => {
    test('빈 메시지 에러 → UNKNOWN (Unknown error)', async () => {
      mockFetch.mockRejectedValueOnce({})
      adapter.addUserMessage('hi')
      await expect(
        adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ code: 'UNKNOWN', message: 'Unknown error' })
    })

    test('parts 없으면 빈 배열', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: {}, finishReason: 'STOP' }],
        }),
      } as any)

      adapter.addUserMessage('hi')
      const step = await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.text).toBeNull()
      expect(step.toolCalls).toHaveLength(0)
    })

    test('functionCall name/args 없으면 기본값', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: { parts: [{ functionCall: {} }] },
              finishReason: 'STOP',
            },
          ],
        }),
      } as any)

      adapter.addUserMessage('hi')
      const step = await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      expect(step.toolCalls[0].name).toBe('')
      expect(step.toolCalls[0].args).toEqual({})
    })

    test('릴레이 error 필드 사용', async () => {
      const relayAdapter = new GeminiAdapter({
        apiKey: 'k',
        model: 'm',
        relayUrl: 'https://relay.test',
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, status: 500, error: 'relay failed badly' }),
      } as any)

      relayAdapter.addUserMessage('hi')
      await expect(
        relayAdapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ provider: 'gemini' })
    })

    test('릴레이 body/error 모두 없음', async () => {
      const relayAdapter = new GeminiAdapter({
        apiKey: 'k',
        model: 'm',
        relayUrl: 'https://relay.test',
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, status: 500 }),
      } as any)

      relayAdapter.addUserMessage('hi')
      await expect(
        relayAdapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
      ).rejects.toMatchObject({ provider: 'gemini' })
    })
  })
})
