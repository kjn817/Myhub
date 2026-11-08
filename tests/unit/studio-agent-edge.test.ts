/// <reference types="jest" />
/**
 * studio-agent.ts 엣지 브랜치 커버리지 테스트
 * - studio-tools 모듈을 mock하여 도달하기 어려운 분기들을 실행
 * - 소스 수정 없음
 */
jest.mock('../../src/services/studio-tools', () => {
  const actual = jest.requireActual('../../src/services/studio-tools')
  return {
    ...actual,
    // 테스트에서 동적으로 변경 가능하도록 getter 사용
    get STUDIO_AGENT_SYSTEM() { return (global as any).__MOCK_SYSTEM ?? '' },
    get STUDIO_TOOLS() { return (global as any).__MOCK_TOOLS },
  }
})

import { runStudioAgent } from '../../src/services/studio-agent'

if (!(AbortSignal as any).timeout) {
  (AbortSignal as any).timeout = (ms: number) => {
    const c = new AbortController()
    setTimeout(() => c.abort(), ms)
    return c.signal
  }
}

const mockFetch = jest.fn()

function mockResp(status: number, ok: boolean, data: any) {
  return {
    ok,
    status,
    text: jest.fn().mockResolvedValue(typeof data === 'string' ? data : JSON.stringify(data)),
  }
}

function geminiOk(parts: any[]) {
  return mockResp(200, true, {
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
  })
}

function groqOk(message: any) {
  return mockResp(200, true, { choices: [{ message, finish_reason: 'stop' }] })
}

beforeEach(() => {
  mockFetch.mockReset()
  ;(global as any).fetch = mockFetch
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('studio-agent 엣지 브랜치', () => {
  test('gemini + 빈 시스템 프롬프트 → systemInstruction 없음 (88행)', async () => {
    // STUDIO_AGENT_SYSTEM='' → geminiSystem='' (falsy) → `: {}` 분기
    // STUDIO_TOOLS=[] → .map 정상 동작
    ;(global as any).__MOCK_SYSTEM = ''
    ;(global as any).__MOCK_TOOLS = []
    mockFetch.mockResolvedValueOnce(geminiOk([{ text: 'hi' }]))
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'hello')
    expect(r.ok).toBe(true)
    const body = JSON.parse((mockFetch.mock.calls[0] as any[])[1].body)
    expect(body.systemInstruction).toBeUndefined()
  })

  test('groq + 도구 없음 → toolCount 0 폴백 (133행)', async () => {
    // STUDIO_TOOLS=undefined → body.tools=undefined → `?.length ?? 0` 폴백
    ;(global as any).__MOCK_SYSTEM = 'system'
    ;(global as any).__MOCK_TOOLS = undefined
    mockFetch.mockResolvedValueOnce(groqOk({ content: 'hi', tool_calls: [] }))
    const r = await runStudioAgent({ GROQ_API_KEY_1: 'k' }, 'hello', { provider: 'groq' })
    expect(r.ok).toBe(true)
  })

  test('gemini 도구 호출 + arguments 없음 → {} 폴백 (485행)', async () => {
    ;(global as any).__MOCK_SYSTEM = 'system'
    const actual = jest.requireActual('../../src/services/studio-tools')
    ;(global as any).__MOCK_TOOLS = actual.STUDIO_TOOLS
    // gemini functionCall에 args 없음 → tc.arguments || {} 폴백
    const fcNoArgs = { functionCall: { name: 'create_file' } }
    mockFetch
      .mockResolvedValueOnce(geminiOk([fcNoArgs]))
      .mockResolvedValueOnce(geminiOk([{ text: 'done' }]))
    const r = await runStudioAgent({ GEMINI_API_KEY_1: 'k' }, 'make app')
    expect(r.ok).toBe(true)
  })

  test('groq 응답 + content 없음 → text null 폴백 (502행)', async () => {
    ;(global as any).__MOCK_SYSTEM = 'system'
    const actual = jest.requireActual('../../src/services/studio-tools')
    ;(global as any).__MOCK_TOOLS = actual.STUDIO_TOOLS
    // content가 null인 응답 → safeResult.text || null 폴백
    mockFetch.mockResolvedValueOnce(groqOk({ content: null, tool_calls: [] }))
    const r = await runStudioAgent({ GROQ_API_KEY_1: 'k' }, 'hello', { provider: 'groq' })
    expect(r.ok).toBe(true)
  })
})
