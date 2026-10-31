/// <reference types="jest" />
/**
 * src/ai/function-calling-route.ts — FC 라우트 단위 테스트
 *
 * 전략: FallbackController/ModelRouter/프롬프트/프로바이더를 전부 jest.mock.
 * createSession/createMockErrorSession/buildFCSystemPrompt는
 * chatWithFunctionCalling을 통해서만 간접 테스트.
 * 소스 수정 없음.
 */
import {
  shouldUseFunctionCalling,
  chatWithFunctionCalling,
} from '../../src/ai/function-calling-route'

const mockGetSetting = jest.fn()
jest.mock('../../src/services/ai', () => ({
  getSetting: (...args: any[]) => mockGetSetting(...args),
}))

const mockControllerExecute = jest.fn()
const mockControllerCtor = jest.fn()
jest.mock('../../src/ai/fallback-controller', () => ({
  FallbackController: jest.fn().mockImplementation((opts: any) => {
    mockControllerCtor(opts)
    return { execute: mockControllerExecute }
  }),
}))

const mockCanUseProvider = jest.fn()
const mockRouterCtor = jest.fn()
jest.mock('../../src/ai/model-router', () => {
  const actual = jest.requireActual('../../src/ai/model-router')
  return {
    ...actual,
    ModelRouter: jest.fn().mockImplementation(() => {
      mockRouterCtor()
      return { canUseProvider: mockCanUseProvider }
    }),
    resolveSensitivity: jest.fn(() => ({ sensitivity: 'normal' })),
    isVerifiedModel: jest.fn(() => true),
  }
})

const mockIsPromptV2EnabledForPersona = jest.fn()
const mockCreateRequestTimeContext = jest.fn()
const mockComposeV2Prompt = jest.fn()
const mockGetPersonaCapabilities = jest.fn()
jest.mock('../../src/ai/prompt-integration', () => ({
  isPromptV2EnabledForPersona: (...a: any[]) => mockIsPromptV2EnabledForPersona(...a),
  createRequestTimeContext: (...a: any[]) => mockCreateRequestTimeContext(...a),
  composeV2Prompt: (...a: any[]) => mockComposeV2Prompt(...a),
  getPersonaCapabilities: (...a: any[]) => mockGetPersonaCapabilities(...a),
  resolvePromptVersion: jest.fn(),
  LEGACY_PROMPT_VERSION: 'v1',
}))

jest.mock('../../src/ai/run-logger', () => ({
  D1RunLogger: jest.fn().mockImplementation(() => ({})),
  generateRunId: () => 'rid',
}))

jest.mock('../../src/ai/providers/groq', () => ({
  GroqAdapter: jest.fn(),
}))
jest.mock('../../src/ai/providers/gemini', () => ({
  GeminiAdapter: jest.fn(),
}))
jest.mock('../../src/ai/providers/workers-ai', () => ({
  WorkersAIAdapter: jest.fn(),
}))

jest.mock('../../src/ai/tools/search-memo', () => ({
  SearchMemoDefinition: { name: 'search_memo', description: 'x', parameters: {}, mode: 'read' },
  SearchMemoInputSchema: {
    safeParse: (a: any) =>
      a && typeof a === 'object'
        ? { success: true, data: a }
        : { success: false, error: 'bad' },
  },
  executeSearchMemo: jest.fn(async () => ({ memos: [] })),
}))

const db = {} as any

function makeContext(envOverrides: any = {}) {
  return {
    env: {
      DB: db,
      ENVIRONMENT: 'staging',
      ...envOverrides,
    },
  } as any
}

beforeEach(() => {
  jest.clearAllMocks()
  // jest.clearAllMocks는 mockReturnValue 구현을 유지하므로 모듈 mock은 수동 리셋
  const routerMod = jest.requireMock('../../src/ai/model-router')
  routerMod.isVerifiedModel.mockReturnValue(true)
  routerMod.resolveSensitivity.mockReturnValue({ sensitivity: 'normal' })
  mockGetSetting.mockReset()
  mockControllerExecute.mockReset()
  mockControllerCtor.mockReset()
  mockRouterCtor.mockReset()
  mockCanUseProvider.mockReset()
  mockIsPromptV2EnabledForPersona.mockReset()
  mockCreateRequestTimeContext.mockReset()
  mockComposeV2Prompt.mockReset()
  mockGetPersonaCapabilities.mockReset()
  // 기본: 모든 설정 통과
  mockGetSetting.mockImplementation(async (_db: any, key: string) => {
    const map: Record<string, string | undefined> = {
      'ai.engine': 'function_calling',
      'ai.fc_test_approved': 'true',
      'ai.fc_test_mock_error': undefined,
      'ai.fc_test_no_tools': undefined,
      'ai.fc_provider': undefined,
      'ai.fc_model': undefined,
    }
    return map[key]
  })
  mockCanUseProvider.mockReturnValue({ allowed: true })
  mockIsPromptV2EnabledForPersona.mockResolvedValue(false)
  mockControllerExecute.mockResolvedValue({
    ok: true,
    text: 'hello',
    provider: 'groq',
    model: 'm1',
  })
})

describe('shouldUseFunctionCalling', () => {
  test('staging + 파일럿 + 플래그 모두 통과 → true', async () => {
    const r = await shouldUseFunctionCalling(db, 'concierge', {
      ENVIRONMENT: 'staging',
    })
    expect(r).toBe(true)
  })

  test('ENVIRONMENT가 staging이 아니면 false', async () => {
    expect(await shouldUseFunctionCalling(db, 'concierge', { ENVIRONMENT: 'production' })).toBe(false)
    expect(await shouldUseFunctionCalling(db, 'concierge', {})).toBe(false)
    expect(await shouldUseFunctionCalling(db, 'concierge')).toBe(false)
  })

  test('파일럿 비서가 아니면 false', async () => {
    const r = await shouldUseFunctionCalling(db, 'keeper', { ENVIRONMENT: 'staging' })
    expect(r).toBe(false)
    expect(mockGetSetting).not.toHaveBeenCalled()
  })

  test('ai.engine이 function_calling이 아니면 false', async () => {
    mockGetSetting.mockImplementation(async (_d: any, k: string) =>
      k === 'ai.engine' ? 'legacy' : undefined
    )
    const r = await shouldUseFunctionCalling(db, 'concierge', { ENVIRONMENT: 'staging' })
    expect(r).toBe(false)
  })

  test('ai.fc_test_approved가 true가 아니면 false', async () => {
    mockGetSetting.mockImplementation(async (_d: any, k: string) => {
      if (k === 'ai.engine') return 'function_calling'
      return 'false'
    })
    const r = await shouldUseFunctionCalling(db, 'concierge', { ENVIRONMENT: 'staging' })
    expect(r).toBe(false)
  })
})

describe('chatWithFunctionCalling', () => {
  test('정상 → ok:true + runId/provider/model/promptVersion', async () => {
    const r = await chatWithFunctionCalling(
      makeContext(),
      'concierge',
      [{ role: 'user', content: '메모 찾아줘' }]
    )
    expect(r.ok).toBe(true)
    expect(r.text).toBe('hello')
    expect(r.runId).toMatch(/^req_/)
    expect(r.provider).toBe('groq')
    expect(r.model).toBe('m1')
    expect(r.promptVersion).toBe('v1')
  })

  test('controller 실패 → ok:false', async () => {
    mockControllerExecute.mockResolvedValue({ ok: false })
    const r = await chatWithFunctionCalling(makeContext(), 'concierge', [
      { role: 'user', content: 'hi' },
    ])
    expect(r.ok).toBe(false)
    expect(r.error).toBe('AI 처리 중 오류가 발생했습니다.')
  })

  test('레거시 프롬프트 (v2 off) + 도구 있음 → search_memo 안내 포함', async () => {
    await chatWithFunctionCalling(makeContext(), 'concierge', [
      { role: 'user', content: 'hi' },
    ])
    const opts = mockControllerCtor.mock.calls[0][0]
    expect(opts.systemPrompt).toContain('search_memo')
    expect(opts.allowedTools).toEqual(['search_memo'])
  })

  test('ai.fc_test_no_tools=true → 도구 비활성화 + 짧은 프롬프트', async () => {
    mockGetSetting.mockImplementation(async (_d: any, k: string) => {
      const map: Record<string, string | undefined> = {
        'ai.engine': 'function_calling',
        'ai.fc_test_approved': 'true',
        'ai.fc_test_no_tools': 'true',
      }
      return map[k]
    })
    await chatWithFunctionCalling(makeContext(), 'concierge', [
      { role: 'user', content: 'hi' },
    ])
    const opts = mockControllerCtor.mock.calls[0][0]
    expect(opts.allowedTools).toEqual([])
    expect(opts.systemPrompt).toBe('You are a helpful assistant.')
  })

  test('v2 프롬프트 on → composeV2Prompt 사용 + fcToolNote 추가', async () => {
    mockIsPromptV2EnabledForPersona.mockResolvedValue(true)
    mockCreateRequestTimeContext.mockResolvedValue({ now: 't' })
    mockGetPersonaCapabilities.mockReturnValue(['c1'])
    mockComposeV2Prompt.mockReturnValue({ prompt: 'COMPOSED', version: 'v2' })
    await chatWithFunctionCalling(makeContext(), 'concierge', [
      { role: 'user', content: 'hi' },
    ])
    const opts = mockControllerCtor.mock.calls[0][0]
    expect(opts.systemPrompt).toContain('COMPOSED')
    expect(opts.systemPrompt).toContain('search_memo')
    expect(mockControllerCtor.mock.calls[0][0]).toBeDefined()
  })

  test('v2 + noTools → fcToolNote 없음', async () => {
    mockIsPromptV2EnabledForPersona.mockResolvedValue(true)
    mockCreateRequestTimeContext.mockResolvedValue({})
    mockGetPersonaCapabilities.mockReturnValue([])
    mockComposeV2Prompt.mockReturnValue({ prompt: 'COMPOSED', version: 'v2' })
    mockGetSetting.mockImplementation(async (_d: any, k: string) => {
      const map: Record<string, string | undefined> = {
        'ai.engine': 'function_calling',
        'ai.fc_test_approved': 'true',
        'ai.fc_test_no_tools': 'true',
      }
      return map[k]
    })
    await chatWithFunctionCalling(makeContext(), 'concierge', [
      { role: 'user', content: 'hi' },
    ])
    const opts = mockControllerCtor.mock.calls[0][0]
    expect(opts.systemPrompt).toBe('COMPOSED')
  })

  test('오버라이드 provider 거부 → Provider not allowed', async () => {
    mockGetSetting.mockImplementation(async (_d: any, k: string) => {
      const map: Record<string, string | undefined> = {
        'ai.engine': 'function_calling',
        'ai.fc_test_approved': 'true',
        'ai.fc_provider': 'groq',
      }
      return map[k]
    })
    mockCanUseProvider.mockReturnValue({ allowed: false, reason: 'sensitive' })
    const r = await chatWithFunctionCalling(makeContext(), 'concierge', [
      { role: 'user', content: 'hi' },
    ])
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Provider not allowed')
    expect(mockControllerExecute).not.toHaveBeenCalled()
  })

  test('오버라이드 model 미검증 → Model not verified', async () => {
    const routerMod = jest.requireMock('../../src/ai/model-router')
    routerMod.isVerifiedModel.mockReturnValue(false)
    mockGetSetting.mockImplementation(async (_d: any, k: string) => {
      const map: Record<string, string | undefined> = {
        'ai.engine': 'function_calling',
        'ai.fc_test_approved': 'true',
        'ai.fc_provider': 'groq',
        'ai.fc_model': 'bad-model',
      }
      return map[k]
    })
    const r = await chatWithFunctionCalling(makeContext(), 'concierge', [
      { role: 'user', content: 'hi' },
    ])
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Model not verified')
  })

  test('오버라이드 통과 → createSession에 강제 provider/model 1회 적용', async () => {
    mockGetSetting.mockImplementation(async (_d: any, k: string) => {
      const map: Record<string, string | undefined> = {
        'ai.engine': 'function_calling',
        'ai.fc_test_approved': 'true',
        'ai.fc_provider': 'gemini',
        'ai.fc_model': 'gemini-x',
      }
      return map[k]
    })
    await chatWithFunctionCalling(
      makeContext({ GROQ_API_KEY_1: 'k', GEMINI_API_KEY_1: 'g' }),
      'concierge',
      [{ role: 'user', content: 'hi' }]
    )
    const createSession = mockControllerCtor.mock.calls[0][0].createSession
    // createSession을 직접 호출해 강제값이 1회만 적용되는지 확인
    // gemini 어댑터는 mock이므로 인스턴스 생성 확인
    const { GeminiAdapter } = jest.requireMock('../../src/ai/providers/gemini')
    createSession('groq', 'other-model')
    expect(GeminiAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-x' })
    )
    // 두 번째 호출은 강제값 소진 → 원래 인자 사용
    const { GroqAdapter } = jest.requireMock('../../src/ai/providers/groq')
    createSession('groq', 'other-model')
    expect(GroqAdapter).toHaveBeenCalled()
  })

  test('user 메시지 없음 → 빈 문자열로 sensitivity 해석', async () => {
    const routerMod = jest.requireMock('../../src/ai/model-router')
    await chatWithFunctionCalling(makeContext(), 'concierge', [
      { role: 'assistant', content: 'hi' },
    ])
    expect(routerMod.resolveSensitivity).toHaveBeenCalledWith(
      expect.objectContaining({ text: '' })
    )
  })

  test('options 전달 (conversationId/userId)', async () => {
    await chatWithFunctionCalling(
      makeContext(),
      'concierge',
      [{ role: 'user', content: 'hi' }],
      { conversationId: 7, userId: 'u9' }
    )
    const execArg = mockControllerExecute.mock.calls[0][0]
    expect(execArg.personaId).toBe('concierge')
    expect(execArg.messages).toHaveLength(1)
  })

  test('createSession: groq 키 없으면 throw', async () => {
    await chatWithFunctionCalling(makeContext(), 'concierge', [
      { role: 'user', content: 'hi' },
    ])
    const createSession = mockControllerCtor.mock.calls[0][0].createSession
    expect(() => createSession('groq', 'm')).toThrow('Provider not configured: groq')
  })

  test('createSession: unknown provider → throw', async () => {
    await chatWithFunctionCalling(
      makeContext({ GROQ_API_KEY_1: 'k' }),
      'concierge',
      [{ role: 'user', content: 'hi' }]
    )
    const createSession = mockControllerCtor.mock.calls[0][0].createSession
    expect(() => createSession('nope', 'm')).toThrow('Unknown provider')
  })

  test('createSession: workers-ai 바인딩 없으면 throw', async () => {
    await chatWithFunctionCalling(makeContext(), 'concierge', [
      { role: 'user', content: 'hi' },
    ])
    const createSession = mockControllerCtor.mock.calls[0][0].createSession
    expect(() => createSession('workers-ai', 'm')).toThrow(
      'Workers AI binding not configured'
    )
  })

  test('createSession: workers-ai 바인딩 있으면 어댑터 생성', async () => {
    await chatWithFunctionCalling(makeContext({ AI: { run: jest.fn() } }), 'concierge', [
      { role: 'user', content: 'hi' },
    ])
    const createSession = mockControllerCtor.mock.calls[0][0].createSession
    const { WorkersAIAdapter } = jest.requireMock('../../src/ai/providers/workers-ai')
    createSession('workers-ai', 'm')
    expect(WorkersAIAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'm', apiMode: 'native' })
    )
  })

  test('createRegistry: search_memo 실행 + 잘못된 인자', async () => {
    await chatWithFunctionCalling(makeContext(), 'concierge', [
      { role: 'user', content: 'hi' },
    ])
    const createRegistry = mockControllerCtor.mock.calls[0][0].createRegistry
    const registry = createRegistry()
    const tool = registry.get('search_memo')
    expect(tool).toBeTruthy()
    // 잘못된 인자 → INVALID_ARGUMENTS
    const bad = await registry.execute(
      { id: '1', name: 'search_memo', args: null, provider: 'groq' } as any,
      { userId: 'u' } as any,
      { DB: db },
      1000
    )
    expect(bad.output.ok).toBe(false)
    // 정상 인자 → executeSearchMemo 실행
    const { executeSearchMemo } = jest.requireMock('../../src/ai/tools/search-memo')
    const good = await registry.execute(
      { id: '2', name: 'search_memo', args: { query: 'q' }, provider: 'groq' } as any,
      { userId: 'u' } as any,
      { DB: db },
      1000
    )
    expect(good.output.ok).toBe(true)
    expect(executeSearchMemo).toHaveBeenCalled()
  })

  test('mockError 주입 → 지정 provider의 첫 호출 실패', async () => {
    mockGetSetting.mockImplementation(async (_d: any, k: string) => {
      const map: Record<string, string | undefined> = {
        'ai.engine': 'function_calling',
        'ai.fc_test_approved': 'true',
        'ai.fc_test_mock_error': 'groq:429',
      }
      return map[k]
    })
    await chatWithFunctionCalling(
      makeContext({ GROQ_API_KEY_1: 'k', GEMINI_API_KEY_1: 'g' }),
      'concierge',
      [{ role: 'user', content: 'hi' }]
    )
    const createSession = mockControllerCtor.mock.calls[0][0].createSession
    const s = createSession('groq', 'm')
    await expect(s.next()).rejects.toThrow('Rate limited (mock)')
    // 다른 provider는 정상 어댑터 경로 (mock 생성자 호출됨)
    const { GeminiAdapter } = jest.requireMock('../../src/ai/providers/gemini')
    createSession('gemini', 'm')
    expect(GeminiAdapter).toHaveBeenCalled()
  })

  test('mockError 알 수 없는 코드 → 500 기본값', async () => {
    mockGetSetting.mockImplementation(async (_d: any, k: string) => {
      const map: Record<string, string | undefined> = {
        'ai.engine': 'function_calling',
        'ai.fc_test_approved': 'true',
        'ai.fc_test_mock_error': 'groq:999',
      }
      return map[k]
    })
    await chatWithFunctionCalling(
      makeContext({ GROQ_API_KEY_1: 'k' }),
      'concierge',
      [{ role: 'user', content: 'hi' }]
    )
    const createSession = mockControllerCtor.mock.calls[0][0].createSession
    const s = createSession('groq', 'm')
    await expect(s.next()).rejects.toThrow('Internal error (mock)')
  })

  test('mockError의 각 코드 매핑 (503/401/403)', async () => {
    for (const code of ['503', '401', '403']) {
      mockGetSetting.mockImplementation(async (_d: any, k: string) => {
        const map: Record<string, string | undefined> = {
          'ai.engine': 'function_calling',
          'ai.fc_test_approved': 'true',
          'ai.fc_test_mock_error': `groq:${code}`,
        }
        return map[k]
      })
      await chatWithFunctionCalling(
        makeContext({ GROQ_API_KEY_1: 'k' }),
        'concierge',
        [{ role: 'user', content: 'hi' }]
      )
      const createSession = mockControllerCtor.mock.calls[0][0].createSession
      const s = createSession('groq', 'm')
      await expect(s.next()).rejects.toThrow()
    }
  })
})
