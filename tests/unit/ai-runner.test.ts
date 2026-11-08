/// <reference types="jest" />
/**
 * src/ai/runner.ts — AgentRunner 멀티턴 루프 단위 테스트
 *
 * 전략: 실제 ToolRegistry + 가짜 ProviderSession + mock logger/writeGuard.
 * 소스 수정 없음.
 */
import { z } from 'zod'
import {
  AgentRunner,
  estimateTokensConservative,
  DEFAULT_BUDGET,
} from '../../src/ai/runner'
import { ToolRegistry } from '../../src/ai/tools/registry'
import type {
  Budget,
  ModelStep,
  ToolCall,
} from '../../src/ai/types'

jest.mock('../../src/ai/run-logger', () => ({
  generateRunId: () => 'test-run-id-123',
  D1RunLogger: jest.fn(),
}))

const BASE_BUDGET: Budget = {
  maxModelCalls: 5,
  maxToolCalls: 4,
  maxTotalInputTokens: 8000,
  maxOutputTokensPerCall: 1024,
  maxToolResultChars: 1500,
  toolTimeoutMs: 1000,
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(
    {
      name: 'search_memo',
      description: 'search memos',
      parameters: {},
      mode: 'read',
    },
    z.object({ query: z.string() }),
    async (args: any) => ({ memos: [`hit:${args.query}`] })
  )
  registry.register(
    {
      name: 'memo_create',
      description: 'create memo',
      parameters: {},
      mode: 'write',
    },
    z.object({ text: z.string() }),
    async (args: any) => ({ memoId: 42, text: args.text })
  )
  return registry
}

function makeSession(steps: Array<ModelStep | Error>) {
  const calls: any[] = []
  let i = 0
  return {
    provider: 'groq',
    modelId: 'test-model',
    calls,
    next: jest.fn(async (opts: any) => {
      calls.push(opts)
      const step = steps[Math.min(i, steps.length - 1)]
      i++
      if (step instanceof Error) throw step
      return step
    }),
    appendToolResults: jest.fn(),
    estimateInputTokens: jest.fn(() => 100),
  }
}

function makeInput(session: any, registry: ToolRegistry, overrides: any = {}) {
  return {
    session,
    registry,
    ctx: { userId: 'u1' } as any,
    env: { DB: {} as any },
    budget: BASE_BUDGET,
    allowedTools: ['search_memo', 'memo_create'],
    systemPrompt: 'sys',
    requestId: 'req-1',
    ...overrides,
  }
}

function toolCall(name: string, args: any = {}, extra: any = {}): ToolCall {
  return { id: 'c1', name, args, provider: 'groq', ...extra } as ToolCall
}

function modelStep(partial: Partial<ModelStep>): ModelStep {
  return {
    text: null,
    toolCalls: [],
    finishReason: 'stop',
    ...partial,
  } as ModelStep
}

describe('estimateTokensConservative', () => {
  test('빈 문자열은 0', () => {
    expect(estimateTokensConservative('')).toBe(0)
    expect(estimateTokensConservative(null as any)).toBe(0)
  })
  test('한글은 1.5배 추정', () => {
    const t = estimateTokensConservative('가나다')
    expect(t).toBeGreaterThan(0)
    expect(t).toBe(Math.ceil(3 * 1.5 * 1.2 * 1.5))
  })
  test('영문은 단어 기준', () => {
    const t = estimateTokensConservative('hello world')
    expect(t).toBe(Math.ceil(2 * 1.3 * 1.2 * 1.5))
  })
  test('한영 혼합', () => {
    expect(estimateTokensConservative('안녕 hello')).toBeGreaterThan(0)
  })
})

describe('AgentRunner.run', () => {
  test('도구 호출 없이 즉시 완료', async () => {
    const session = makeSession([modelStep({ text: 'hello', finishReason: 'stop' })])
    const r = await new AgentRunner().run(makeInput(session, makeRegistry()))
    expect(r.status).toBe('completed')
    expect(r.text).toBe('hello')
    expect(r.modelCalls).toBe(1)
    expect(r.requestedToolCalls).toBe(0)
    // usage 미제공 시: usage?.source(undefined) !== 'unavailable' → estimated 경로
    expect(r.usageSource).toBe('estimated')
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  test('runId 미지정 시 자동 생성', async () => {
    const session = makeSession([modelStep({ text: 'x' })])
    const r = await new AgentRunner().run(makeInput(session, makeRegistry()))
    expect(r.status).toBe('completed')
  })

  test('finishReason=length + 도구 없음 → invalid_response', async () => {
    const session = makeSession([modelStep({ text: 'cut', finishReason: 'length' })])
    const r = await new AgentRunner().run(makeInput(session, makeRegistry()))
    expect(r.status).toBe('invalid_response')
    expect(r.errorCode).toBe('OUTPUT_TRUNCATED')
  })

  test('모델 호출 실패 → provider_error (코드 있음)', async () => {
    const err: any = new Error('boom')
    err.code = 'RATE_LIMITED'
    const session = makeSession([err])
    const logger = {
      onRunStart: jest.fn(async () => {}),
      onRunFinish: jest.fn(async () => {}),
      onModelCall: jest.fn(async () => {}),
      onToolCall: jest.fn(async () => {}),
    }
    const r = await new AgentRunner().run(
      makeInput(session, makeRegistry(), { logger })
    )
    expect(r.status).toBe('provider_error')
    expect(r.errorCode).toBe('RATE_LIMITED')
    expect(logger.onModelCall).toHaveBeenCalled()
  })

  test('모델 호출 실패 → 코드 없으면 PROVIDER_ERROR', async () => {
    const session = makeSession([new Error('x')])
    const r = await new AgentRunner().run(makeInput(session, makeRegistry()))
    expect(r.errorCode).toBe('PROVIDER_ERROR')
  })

  test('abortSignal 중단 → cancelled', async () => {
    const session = makeSession([modelStep({ text: 'x' })])
    const ctrl = new AbortController()
    ctrl.abort()
    const r = await new AgentRunner().run(
      makeInput(session, makeRegistry(), { abortSignal: ctrl.signal })
    )
    expect(r.status).toBe('cancelled')
    expect(r.errorCode).toBe('CANCELLED')
  })

  test('입력 토큰 예산 초과 → budget_exceeded', async () => {
    const session = makeSession([modelStep({ text: 'x' })])
    const r = await new AgentRunner().run(
      makeInput(session, makeRegistry(), {
        budget: { ...BASE_BUDGET, maxTotalInputTokens: 10 },
      })
    )
    expect(r.status).toBe('budget_exceeded')
    expect(r.errorCode).toBe('TOKEN_BUDGET_EXCEEDED')
  })

  test('estimateInputTokens 미구현 → 보수적 추정 경로', async () => {
    const session = makeSession([modelStep({ text: 'x' })])
    delete (session as any).estimateInputTokens
    const r = await new AgentRunner().run(makeInput(session, makeRegistry()))
    expect(r.status).toBe('completed')
  })

  test('estimateInputTokens null 반환 → estimateTokensConservative 폴백', async () => {
    const session = makeSession([modelStep({ text: 'x' })])
    session.estimateInputTokens.mockReturnValue(null)
    const r = await new AgentRunner().run(makeInput(session, makeRegistry()))
    expect(r.status).toBe('completed')
  })

  test('provider usage 있으면 provider 출처', async () => {
    const session = makeSession([
      modelStep({
        text: 'x',
        usage: { inputTokens: 50, outputTokens: 10, source: 'provider' },
      }),
    ])
    const r = await new AgentRunner().run(makeInput(session, makeRegistry()))
    expect(r.usageSource).toBe('provider')
    expect(r.totalInputTokens).toBe(50)
    expect(r.totalOutputTokens).toBe(10)
  })

  test('usage.source=estimated → estimated 출처', async () => {
    const session = makeSession([
      modelStep({ text: 'x', usage: { source: 'estimated' } }),
    ])
    const r = await new AgentRunner().run(makeInput(session, makeRegistry()))
    expect(r.usageSource).toBe('estimated')
  })

  test('usage.source=unavailable → estimated 추정 경로', async () => {
    const session = makeSession([
      modelStep({ text: 'x', usage: { source: 'unavailable' } }),
    ])
    const r = await new AgentRunner().run(makeInput(session, makeRegistry()))
    expect(r.usageSource).toBe('estimated')
    expect(r.totalInputTokens).toBeGreaterThan(0)
  })

  test('usage 없음 → estimated', async () => {
    const session = makeSession([modelStep({ text: 'x' })])
    const r = await new AgentRunner().run(makeInput(session, makeRegistry()))
    expect(r.usageSource).toBe('estimated')
  })

  test('mixed 출처 (provider + estimated)', async () => {
    const session = makeSession([
      modelStep({
        text: null,
        toolCalls: [toolCall('search_memo', { query: 'a' })],
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 2, source: 'provider' },
      }),
      modelStep({ text: 'done' }),
    ])
    const r = await new AgentRunner().run(makeInput(session, makeRegistry()))
    expect(r.status).toBe('completed')
    expect(r.usageSource).toBe('mixed')
  })

  test('도구 호출 → 실행 후 텍스트 반환', async () => {
    const session = makeSession([
      modelStep({
        text: null,
        toolCalls: [toolCall('search_memo', { query: 'hi' })],
        finishReason: 'tool_calls',
      }),
      modelStep({ text: 'found it' }),
    ])
    const r = await new AgentRunner().run(makeInput(session, makeRegistry()))
    expect(r.status).toBe('completed')
    expect(r.text).toBe('found it')
    expect(r.requestedToolCalls).toBe(1)
    expect(r.executedToolCalls).toBe(1)
    expect(session.appendToolResults).toHaveBeenCalled()
    const results = session.appendToolResults.mock.calls[0][0]
    expect(results[0].output.ok).toBe(true)
  })

  test('마지막 호출에서 도구 호출 → TOOL_CALL_ON_LAST_STEP', async () => {
    const session = makeSession([
      modelStep({
        text: 't',
        toolCalls: [toolCall('search_memo', { query: 'a' })],
        finishReason: 'tool_calls',
      }),
    ])
    const r = await new AgentRunner().run(
      makeInput(session, makeRegistry(), {
        budget: { ...BASE_BUDGET, maxModelCalls: 1 },
      })
    )
    expect(r.status).toBe('budget_exceeded')
    expect(r.errorCode).toBe('TOOL_CALL_ON_LAST_STEP')
  })

  test('마지막 호출은 도구 없이 호출 (toolChoice=none)', async () => {
    const session = makeSession([modelStep({ text: 'x' })])
    await new AgentRunner().run(
      makeInput(session, makeRegistry(), {
        budget: { ...BASE_BUDGET, maxModelCalls: 1 },
      })
    )
    expect(session.calls[0].toolChoice).toBe('none')
    expect(session.calls[0].tools).toEqual([])
  })

  test('첫 호출에만 systemPrompt 전달', async () => {
    const session = makeSession([
      modelStep({
        text: null,
        toolCalls: [toolCall('search_memo', { query: 'a' })],
        finishReason: 'tool_calls',
      }),
      modelStep({ text: 'done' }),
    ])
    await new AgentRunner().run(makeInput(session, makeRegistry()))
    expect(session.calls[0].systemPrompt).toBe('sys')
    expect(session.calls[1].systemPrompt).toBeUndefined()
  })

  test('parseError 있는 도구 호출 → INVALID_ARGUMENTS', async () => {
    const session = makeSession([
      modelStep({
        text: null,
        toolCalls: [toolCall('search_memo', {}, { parseError: true })],
        finishReason: 'tool_calls',
      }),
      modelStep({ text: 'ok' }),
    ])
    const r = await new AgentRunner().run(makeInput(session, makeRegistry()))
    expect(r.status).toBe('completed')
    const results = session.appendToolResults.mock.calls[0][0]
    expect(results[0].output.errorCode).toBe('INVALID_ARGUMENTS')
  })

  test('허용 목록에 없는 도구 → ACCESS_DENIED', async () => {
    const session = makeSession([
      modelStep({
        text: null,
        toolCalls: [toolCall('evil_tool', {})],
        finishReason: 'tool_calls',
      }),
      modelStep({ text: 'ok' }),
    ])
    const r = await new AgentRunner().run(
      makeInput(session, makeRegistry(), { allowedTools: ['search_memo'] })
    )
    const results = session.appendToolResults.mock.calls[0][0]
    expect(results[0].output.errorCode).toBe('ACCESS_DENIED')
    expect(r.executedToolCalls).toBe(0)
  })

  test('도구 예산 초과 → TOOL_BUDGET_EXCEEDED', async () => {
    const session = makeSession([
      modelStep({
        text: null,
        toolCalls: [
          toolCall('search_memo', { query: 'a' }, { id: 'c1' }),
          toolCall('search_memo', { query: 'b' }, { id: 'c2' }),
        ],
        finishReason: 'tool_calls',
      }),
      modelStep({ text: 'ok' }),
    ])
    const r = await new AgentRunner().run(
      makeInput(session, makeRegistry(), {
        budget: { ...BASE_BUDGET, maxToolCalls: 1 },
      })
    )
    expect(r.status).toBe('completed')
    const results = session.appendToolResults.mock.calls[0][0]
    expect(results[0].output.ok).toBe(true)
    expect(results[1].output.errorCode).toBe('TOOL_BUDGET_EXCEEDED')
  })

  test('남은 도구 예산 0 → 즉시 budget_exceeded', async () => {
    const session = makeSession([
      modelStep({
        text: null,
        toolCalls: [toolCall('search_memo', { query: 'a' })],
        finishReason: 'tool_calls',
      }),
    ])
    const r = await new AgentRunner().run(
      makeInput(session, makeRegistry(), {
        budget: { ...BASE_BUDGET, maxToolCalls: 0 },
      })
    )
    expect(r.status).toBe('budget_exceeded')
    expect(r.errorCode).toBe('TOOL_BUDGET_EXCEEDED')
  })

  test('maxModelCalls 소진 → MAX_MODEL_CALLS', async () => {
    const session = makeSession([
      modelStep({
        text: null,
        toolCalls: [toolCall('search_memo', { query: 'a' })],
        finishReason: 'tool_calls',
      }),
    ])
    const r = await new AgentRunner().run(
      makeInput(session, makeRegistry(), {
        budget: { ...BASE_BUDGET, maxModelCalls: 1, maxTotalInputTokens: 100000 },
      })
    )
    // maxModelCalls=1이면 첫 호출이 마지막 호출이므로 TOOL_CALL_ON_LAST_STEP
    expect(r.status).toBe('budget_exceeded')
  })

  test('쓰기 도구 + writeGuard 없음 → WRITE_GUARD_MISSING', async () => {
    const session = makeSession([
      modelStep({
        text: null,
        toolCalls: [toolCall('memo_create', { text: 'hi' })],
        finishReason: 'tool_calls',
      }),
      modelStep({ text: 'ok' }),
    ])
    const r = await new AgentRunner().run(makeInput(session, makeRegistry()))
    const results = session.appendToolResults.mock.calls[0][0]
    expect(results[0].output.errorCode).toBe('WRITE_GUARD_MISSING')
    expect(r.executedToolCalls).toBe(0)
  })

  test('쓰기 도구 + writeGuard 승인 → 실행', async () => {
    const session = makeSession([
      modelStep({
        text: null,
        toolCalls: [toolCall('memo_create', { text: 'hi' })],
        finishReason: 'tool_calls',
      }),
      modelStep({ text: 'ok' }),
    ])
    const writeGuard = {
      checkBeforeExecute: jest.fn(async () => ({ allowed: true })),
      getOperation: jest.fn(),
    }
    const r = await new AgentRunner().run(
      makeInput(session, makeRegistry(), {
        writeGuard,
        getWriteApproval: async () => ({ operationId: 'op1' } as any),
      })
    )
    expect(r.executedToolCalls).toBe(1)
    const results = session.appendToolResults.mock.calls[0][0]
    expect(results[0].output.ok).toBe(true)
  })

  test('쓰기 도구 + writeGuard 거부 → 에러 반환', async () => {
    const session = makeSession([
      modelStep({
        text: null,
        toolCalls: [toolCall('memo_create', { text: 'hi' })],
        finishReason: 'tool_calls',
      }),
      modelStep({ text: 'ok' }),
    ])
    const writeGuard = {
      checkBeforeExecute: jest.fn(async () => ({
        allowed: false,
        errorCode: 'DENIED',
        message: 'no',
      })),
      getOperation: jest.fn(),
    }
    const r = await new AgentRunner().run(
      makeInput(session, makeRegistry(), {
        writeGuard,
        getWriteApproval: async () => ({ operationId: 'op1' } as any),
      })
    )
    const results = session.appendToolResults.mock.calls[0][0]
    expect(results[0].output.errorCode).toBe('DENIED')
  })

  test('ALREADY_SUCCEEDED → 기존 결과 반환 (중복 제거)', async () => {
    const session = makeSession([
      modelStep({
        text: null,
        toolCalls: [toolCall('memo_create', { text: 'hi' })],
        finishReason: 'tool_calls',
      }),
      modelStep({ text: 'ok' }),
    ])
    const writeGuard = {
      checkBeforeExecute: jest.fn(async () => ({
        allowed: false,
        errorCode: 'ALREADY_SUCCEEDED',
        message: 'dup',
      })),
      getOperation: jest.fn(async () => ({ resultRef: 'memo:1' })),
    }
    const r = await new AgentRunner().run(
      makeInput(session, makeRegistry(), {
        writeGuard,
        getWriteApproval: async () => ({ operationId: 'op1' } as any),
      })
    )
    const results = session.appendToolResults.mock.calls[0][0]
    expect(results[0].output.ok).toBe(true)
    expect(results[0].output.data.deduplicated).toBe(true)
    expect(r.executedToolCalls).toBe(0)
  })

  test('getWriteApproval throw → approval null로 진행', async () => {
    const session = makeSession([
      modelStep({
        text: null,
        toolCalls: [toolCall('memo_create', { text: 'hi' })],
        finishReason: 'tool_calls',
      }),
      modelStep({ text: 'ok' }),
    ])
    const writeGuard = {
      checkBeforeExecute: jest.fn(async () => ({ allowed: true })),
      getOperation: jest.fn(),
    }
    const r = await new AgentRunner().run(
      makeInput(session, makeRegistry(), {
        writeGuard,
        getWriteApproval: async () => {
          throw new Error('db fail')
        },
      })
    )
    expect(writeGuard.checkBeforeExecute).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      null
    )
    expect(r.executedToolCalls).toBe(1)
  })

  test('read 캐시: 동일 호출 2턴째는 캐시 히트', async () => {
    const session = makeSession([
      modelStep({
        text: null,
        toolCalls: [toolCall('search_memo', { query: 'a' }, { id: 'c1' })],
        finishReason: 'tool_calls',
      }),
      modelStep({
        text: null,
        toolCalls: [toolCall('search_memo', { query: 'a' }, { id: 'c2' })],
        finishReason: 'tool_calls',
      }),
      modelStep({ text: 'done' }),
    ])
    const logger = {
      onRunStart: jest.fn(async () => {}),
      onRunFinish: jest.fn(async () => {}),
      onModelCall: jest.fn(async () => {}),
      onToolCall: jest.fn(async () => {}),
    }
    const r = await new AgentRunner().run(
      makeInput(session, makeRegistry(), { logger })
    )
    expect(r.executedToolCalls).toBe(1) // 두 번째는 캐시
    const cachedCall = logger.onToolCall.mock.calls.find(
      (c: any) => c[0].status === 'cached'
    )
    expect(cachedCall).toBeTruthy()
  })

  test('skipRunLogging이면 Run 시작/종료 로그만 생략 (세부 로그는 유지)', async () => {
    // (c) 정리: 기록형 logger가 받은 이벤트로 단언한다 (mock 호출 단언
    // 대체). 실제 계약(runner.ts): skipRunLogging은 onRunStart/
    // onRunFinish만 끄고, ai_usage 같은 세부 로그(onModelCall)는 유지한다
    // — 구 테스트가 start/finish만 단언했던 이유다. 재작성 1차에서 전
    // 이벤트가 비어야 한다고 과하게 단언했다가 실측으로 교정했다.
    const session = makeSession([modelStep({ text: 'x' })])
    const events: string[] = []
    const logger = {
      onRunStart: async () => { events.push('start') },
      onRunFinish: async () => { events.push('finish') },
      onModelCall: async () => { events.push('model') },
      onToolCall: async () => { events.push('tool') },
    }
    const r = await new AgentRunner().run(
      makeInput(session, makeRegistry(), { logger, skipRunLogging: true } as any)
    )
    expect(events).toEqual(['model'])
    expect(r.status).toBe('completed')
    expect(r.text).toBe('x')
  })

  test('logger 실패해도 무시 (catch)', async () => {
    const session = makeSession([modelStep({ text: 'x' })])
    const logger = {
      onRunStart: jest.fn(async () => {
        throw new Error('log fail')
      }),
      onRunFinish: jest.fn(async () => {
        throw new Error('log fail')
      }),
      onModelCall: jest.fn(async () => {
        throw new Error('log fail')
      }),
      onToolCall: jest.fn(async () => {}),
    }
    const r = await new AgentRunner().run(
      makeInput(session, makeRegistry(), { logger })
    )
    expect(r.status).toBe('completed')
  })

  test('내부 예외 → tool_error INTERNAL_ERROR', async () => {
    const session = makeSession([modelStep({ text: 'x' })])
    // registry.execute가 throw하도록: Zod 검증 통과 후 executor에서 throw
    const registry = makeRegistry()
    const bad = new ToolRegistry()
    bad.register(
      { name: 'search_memo', description: 'x', parameters: {}, mode: 'read' },
      z.object({ query: z.string() }),
      async () => {
        throw new Error('executor boom')
      }
    )
    // registry.execute 자체를 throw하게
    jest.spyOn(bad, 'execute').mockRejectedValue(new Error('nope'))
    const s2 = makeSession([
      modelStep({
        text: null,
        toolCalls: [toolCall('search_memo', { query: 'a' })],
        finishReason: 'tool_calls',
      }),
    ])
    const r = await new AgentRunner().run(makeInput(s2, bad))
    expect(r.status).toBe('tool_error')
    expect(r.errorCode).toBe('INTERNAL_ERROR')
  })

  test('도구 실행 실패 로그 (error 상태)', async () => {
    const session = makeSession([
      modelStep({
        text: null,
        toolCalls: [toolCall('search_memo', { query: 123 } as any)],
        finishReason: 'tool_calls',
      }),
      modelStep({ text: 'ok' }),
    ])
    const logger = {
      onRunStart: jest.fn(async () => {}),
      onRunFinish: jest.fn(async () => {}),
      onModelCall: jest.fn(async () => {}),
      onToolCall: jest.fn(async () => {}),
    }
    await new AgentRunner().run(
      makeInput(session, makeRegistry(), { logger })
    )
    const errCall = logger.onToolCall.mock.calls.find(
      (c: any) => c[0].status === 'error'
    )
    expect(errCall).toBeTruthy()
  })

  test('DEFAULT_BUDGET 재노출', () => {
    expect(DEFAULT_BUDGET.maxModelCalls).toBe(3)
    expect(DEFAULT_BUDGET.maxToolCalls).toBe(4)
  })
})

describe('runner 브랜치 커버리지 추가', () => {
  test('provider_error + logger + 코드 없음 → PROVIDER_ERROR (240행)', async () => {
    const session = makeSession([new Error('no code')])
    const logger = {
      onRunStart: jest.fn(async () => {}),
      onRunFinish: jest.fn(async () => {}),
      onModelCall: jest.fn(async () => {}),
      onToolCall: jest.fn(async () => {}),
    }
    const r = await new AgentRunner().run(makeInput(session, makeRegistry(), { logger }))
    expect(r.status).toBe('provider_error')
    expect(r.errorCode).toBe('PROVIDER_ERROR')
    // logger.onModelCall이 호출되었고 errorCode가 PROVIDER_ERROR
    expect(logger.onModelCall).toHaveBeenCalled()
    const callArg = (logger.onModelCall.mock.calls[0] as any[])[0]
    expect(callArg.errorCode).toBe('PROVIDER_ERROR')
  })

  test('logger.onModelCall reject → catch 무시 (241행)', async () => {
    const err: any = new Error('boom')
    err.code = 'E1'
    const session = makeSession([err])
    const logger = {
      onRunStart: jest.fn(async () => {}),
      onRunFinish: jest.fn(async () => {}),
      onModelCall: jest.fn(async () => { throw new Error('log fail') }),
      onToolCall: jest.fn(async () => {}),
    }
    const r = await new AgentRunner().run(makeInput(session, makeRegistry(), { logger }))
    expect(r.status).toBe('provider_error')
    expect(r.errorCode).toBe('E1')
  })

  test('finishReason=length + text null → invalid_response text "" (290행)', async () => {
    const session = makeSession([modelStep({ text: null as any, finishReason: 'length' })])
    const r = await new AgentRunner().run(makeInput(session, makeRegistry()))
    expect(r.status).toBe('invalid_response')
    expect(r.text).toBe('')
  })

  test('completed + text null → text "" (292행)', async () => {
    const session = makeSession([modelStep({ text: null as any, finishReason: 'stop' })])
    const r = await new AgentRunner().run(makeInput(session, makeRegistry()))
    expect(r.status).toBe('completed')
    expect(r.text).toBe('')
  })

  test('write 도구 + getWriteApproval 없음 → approval null로 진행 (327행)', async () => {
    const session = makeSession([
      modelStep({ toolCalls: [toolCall('memo_create', { text: 'hi' })] }),
      modelStep({ text: 'done', finishReason: 'stop' }),
    ])
    // writeGuard는 있지만 getWriteApproval은 없음 → approval=null, writeGuard가 승인 여부 결정
    const writeGuard = {
      checkBeforeExecute: jest.fn(async () => ({ allowed: true })),
      getOperation: jest.fn(),
    }
    const r = await new AgentRunner().run(
      makeInput(session, makeRegistry(), { writeGuard })
    )
    expect(r.status).toBe('completed')
  })

  test('도구 호출 + logger 없음 → onToolCall 스킵 (356행)', async () => {
    const session = makeSession([
      modelStep({ toolCalls: [toolCall('search_memo', { query: 'q' })] }),
      modelStep({ toolCalls: [toolCall('search_memo', { query: 'q' })] }), // 캐시 히트
      modelStep({ text: 'done', finishReason: 'stop' }),
    ])
    // logger 없이 실행 → if (logger) false 분기 (캐시 히트 로그 스킵)
    const r = await new AgentRunner().run(makeInput(session, makeRegistry()))
    expect(r.status).toBe('completed')
  })

  test('캐시 히트 + logger.onToolCall reject → catch 무시 (361행)', async () => {
    const session = makeSession([
      modelStep({ toolCalls: [toolCall('search_memo', { query: 'q2' })] }),
      modelStep({ toolCalls: [toolCall('search_memo', { query: 'q2' })] }), // 캐시 히트
      modelStep({ text: 'done', finishReason: 'stop' }),
    ])
    const logger = {
      onRunStart: jest.fn(async () => {}),
      onRunFinish: jest.fn(async () => {}),
      onModelCall: jest.fn(async () => {}),
      onToolCall: jest.fn(async () => { throw new Error('log fail') }),
    }
    const r = await new AgentRunner().run(makeInput(session, makeRegistry(), { logger }))
    expect(r.status).toBe('completed')
  })

  test('도구 실행 + logger.onToolCall reject → catch 무시 (379행)', async () => {
    const session = makeSession([
      modelStep({ toolCalls: [toolCall('search_memo', { query: 'q3' })] }),
      modelStep({ text: 'done', finishReason: 'stop' }),
    ])
    const logger = {
      onRunStart: jest.fn(async () => {}),
      onRunFinish: jest.fn(async () => {}),
      onModelCall: jest.fn(async () => {}),
      onToolCall: jest.fn(async () => { throw new Error('log fail') }),
    }
    const r = await new AgentRunner().run(makeInput(session, makeRegistry(), { logger }))
    expect(r.status).toBe('completed')
  })

  test('캐시 히트 + toolDef.mode 없음 → mode "read" 폴백 (359행)', async () => {
    // mode가 없는 도구 정의로 레지스트리 구성
    const registry = new ToolRegistry()
    registry.register(
      { name: 'no_mode_tool', description: 'no mode', parameters: {} } as any,
      z.object({ q: z.string() }),
      async (args: any) => ({ ok: true })
    )
    const session = makeSession([
      modelStep({ toolCalls: [toolCall('no_mode_tool', { q: 'x' })] }),
      modelStep({ toolCalls: [toolCall('no_mode_tool', { q: 'x' })] }), // 두 번째는 캐시 히트
      modelStep({ text: 'done', finishReason: 'stop' }),
    ])
    const logger = {
      onRunStart: jest.fn(async () => {}),
      onRunFinish: jest.fn(async () => {}),
      onModelCall: jest.fn(async () => {}),
      onToolCall: jest.fn(async () => {}),
    }
    const r = await new AgentRunner().run(
      makeInput(session, registry, { logger, allowedTools: ['no_mode_tool'] })
    )
    expect(r.status).toBe('completed')
    // 캐시된 호출의 mode가 'read' 폴백으로 기록됨
    const cachedCall = (logger.onToolCall.mock.calls as any[]).find((c: any) => c[0].status === 'cached')
    if (cachedCall) {
      expect((cachedCall as any[])[0].mode).toBe('read')
    }
  })

  test('도구 실행 + toolDef.mode 없음 → mode "read" 폴백 (374행)', async () => {
    const registry = new ToolRegistry()
    registry.register(
      { name: 'no_mode_tool2', description: 'no mode', parameters: {} } as any,
      z.object({ q: z.string() }),
      async (args: any) => ({ ok: true })
    )
    const session = makeSession([
      modelStep({ toolCalls: [toolCall('no_mode_tool2', { q: 'x' })] }),
      modelStep({ text: 'done', finishReason: 'stop' }),
    ])
    const logger = {
      onRunStart: jest.fn(async () => {}),
      onRunFinish: jest.fn(async () => {}),
      onModelCall: jest.fn(async () => {}),
      onToolCall: jest.fn(async () => {}),
    }
    const r = await new AgentRunner().run(
      makeInput(session, registry, { logger, allowedTools: ['no_mode_tool2'] })
    )
    expect(r.status).toBe('completed')
    const calls = logger.onToolCall.mock.calls as any[][]
    expect(calls[0][0].mode).toBe('read')
  })
})
