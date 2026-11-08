/// <reference types="jest" />
/**
 * ai_usage 경로 귀속 (0065: engine·persona) 테스트.
 *
 * 성질: 모델 호출 원장의 각 행은 그 호출이 실제로 속한 분기의 engine 태그와
 * 실제 personaId를 실어야 한다.
 * - E1 마커 경로 (useFC 게이트 OFF) → 'marker'
 * - E2 운영 내장 FC (useFC 게이트 ON: keeper + workers-ai) → 'builtin-fc'
 * - E3 Registry FC (run-logger) → 'registry-fc' 고정
 * - 뉴런 소진 degraded 재시도 → 'degraded' (1차 시도의 실패 행은 원래 태그 유지)
 * - 비서 맥락이 없는 호출 → persona 'unattributed' (NULL로 비우지 않음 — 원본 번들 동작)
 *
 * 카나리아 성질: aiChat에서 useFC 게이트 값을 무시하고 attemptEngine을
 * 상수로 만들거나, degraded 플래그를 무시하면 이 파일의 단언이 실패해야
 * 한다 (실제 절단 실험은 작업 보고에 기록).
 */

import { aiChat, type TaskPolicy } from '../../src/services/ai'
import { resolvePersonaProvider } from '../../src/services/provider-registry'
import { D1RunLogger } from '../../src/ai/run-logger'
import { AgentRunner } from '../../src/ai/runner'
import { ToolRegistry } from '../../src/ai/tools/registry'

// ---------------------------------------------------------------------------
// Mock DB — INSERT INTO ai_usage의 컬럼 목록과 bind 파라미터를 짝지어 행으로 복원
// ---------------------------------------------------------------------------
function makeDb(settings: Record<string, string> = {}) {
  const calls: { sql: string; params: any[] }[] = []
  return {
    calls,
    prepare: jest.fn((sql: string) => ({
      bind: jest.fn((...params: any[]) => ({
        first: jest.fn(async () => {
          if (sql.includes('ai_settings')) {
            const key = params[0]
            return settings[key] ? { value: settings[key] } : null
          }
          return null
        }),
        all: jest.fn(async () => ({ results: [] })),
        run: jest.fn(async () => {
          calls.push({ sql, params })
          return {}
        }),
      })),
    })),
  }
}

type UsageRow = Record<string, any>

/** ai_usage INSERT 호출들을 {컬럼명: 값} 행으로 복원한다 */
function usageRows(db: ReturnType<typeof makeDb>): UsageRow[] {
  return db.calls
    .filter((c) => c.sql.includes('INSERT INTO ai_usage'))
    .map((c) => {
      const cols = c.sql
        .slice(c.sql.indexOf('(') + 1, c.sql.indexOf(')'))
        .split(',')
        .map((s) => s.trim())
      const row: UsageRow = {}
      // run-logger의 created_at은 bind가 아닌 datetime('now') 리터럴이라
      // 파라미터를 소비하지 않는다 — 그 컬럼만 건너뛰고 나머지를 순서대로 짝짓는다.
      let p = 0
      for (const col of cols) {
        if (col === 'created_at' && c.sql.includes("datetime('now')")) {
          row[col] = '<now>'
        } else {
          row[col] = c.params[p++]
        }
      }
      return row
    })
}

function personaPolicy(personaId: string, capability: TaskPolicy['capability']): TaskPolicy {
  return {
    capability,
    privacy: 'external-ok',
    latency: 'interactive',
    quality: 'balanced',
    personaId,
    providerPin: resolvePersonaProvider(personaId),
    origin: 'interactive',
  } as TaskPolicy
}

function geminiOk(text = 'gemini 답변') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }),
  } as any
}

function groqOk(text = 'groq 답변') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 8, completion_tokens: 4 },
    }),
  } as any
}

// ---------------------------------------------------------------------------
// aiChat (E1/E2/degraded) 귀속
// ---------------------------------------------------------------------------
describe('aiChat ai_usage 귀속 (0065)', () => {
  const originalFetch = global.fetch
  afterEach(() => {
    global.fetch = originalFetch
  })

  test('E1 마커: concierge(gemini) 성공 호출은 engine=marker, persona=concierge', async () => {
    global.fetch = jest.fn(async () => geminiOk()) as any
    const db = makeDb()
    const env = { DB: db, GEMINI_API_KEY_1: 'k' } as any
    const result = await aiChat(env, personaPolicy('concierge', 'chat'), [
      { role: 'user', content: '안녕' },
    ])
    expect(result.provider).toBe('gemini')
    const rows = usageRows(db as any)
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('success')
    expect(rows[0].engine).toBe('marker')
    expect(rows[0].persona).toBe('concierge')
  })

  test('E1 마커: scheduler(groq)도 marker + 실제 personaId', async () => {
    global.fetch = jest.fn(async () => groqOk()) as any
    const db = makeDb()
    const env = { DB: db, GROQ_API_KEY_1: 'k' } as any
    const result = await aiChat(env, personaPolicy('scheduler', 'schedule'), [
      { role: 'user', content: '내일 일정 알려줘' },
    ])
    expect(result.provider).toBe('groq')
    const rows = usageRows(db as any)
    expect(rows).toHaveLength(1)
    expect(rows[0].engine).toBe('marker')
    expect(rows[0].persona).toBe('scheduler')
  })

  test('E2 내장 FC: keeper + workers-ai (useFC 게이트 ON)는 engine=builtin-fc', async () => {
    const mockAi = {
      run: jest.fn().mockResolvedValue({
        response: '메모를 찾았어',
        usage: { prompt_tokens: 30, completion_tokens: 12, neurons: 9 },
      }),
    }
    const db = makeDb()
    const env = { DB: db, AI: mockAi } as any
    const result = await aiChat(env, personaPolicy('keeper', 'summarize'), [
      { role: 'user', content: '메모 찾아줘' },
    ])
    expect(result.provider).toBe('workers-ai')
    const rows = usageRows(db as any)
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('success')
    expect(rows[0].engine).toBe('builtin-fc')
    expect(rows[0].persona).toBe('keeper')
  })

  test('실패 기록도 같은 태그를 쓴다: concierge gemini 실패 → marker + failed', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'server error',
      json: async () => ({}),
    } as any)) as any
    const db = makeDb()
    const env = { DB: db, GEMINI_API_KEY_1: 'k' } as any
    await expect(
      aiChat(env, personaPolicy('concierge', 'chat'), [{ role: 'user', content: '안녕' }], { disableRetry: true })
    ).rejects.toThrow()
    const rows = usageRows(db as any)
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('failed')
    expect(rows[0].engine).toBe('marker')
    expect(rows[0].persona).toBe('concierge')
  })

  test('degraded: 4006 1차 실패 행은 builtin-fc, Gemini lite 재시도 행은 degraded', async () => {
    global.fetch = jest.fn(async () => geminiOk('degraded 답변')) as any
    const mockAi = { run: jest.fn().mockRejectedValue(new Error('4006: daily free allocation exhausted')) }
    const db = makeDb()
    const env = { DB: db, AI: mockAi, GEMINI_API_KEY_1: 'k' } as any
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})
    try {
      // degraded 폴백은 1차 시도가 Workers AI일 때만 발동한다. 2026-11-05 이후
      // keeper 비메모 턴은 NVIDIA 핀이므로, 메모 턴(메모 가드가 workers-ai로
      // 재라우팅하는 턴)으로 시나리오를 구성한다.
      const result = await aiChat(env, personaPolicy('keeper', 'summarize'), [
        { role: 'user', content: '메모 찾아줘' },
      ])
      expect(result.provider).toBe('gemini')
      expect(result.model).toBe('gemini-3.5-flash-lite')
    } finally {
      infoSpy.mockRestore()
    }
    const rows = usageRows(db as any)
    expect(rows).toHaveLength(2)
    // 1차 시도(workers-ai, FC 게이트 ON)의 실패 행 — degraded로 소급하지 않는다
    expect(rows[0].provider).toBe('workers-ai')
    expect(rows[0].outcome).toBe('failed')
    expect(rows[0].engine).toBe('builtin-fc')
    expect(rows[0].persona).toBe('keeper')
    // degraded 재시도 행
    expect(rows[1].provider).toBe('gemini')
    expect(rows[1].outcome).toBe('success')
    expect(rows[1].engine).toBe('degraded')
    expect(rows[1].persona).toBe('keeper')
  })

  test('degraded 재시도까지 실패하면 그 실패 행도 degraded로 남는다', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
      json: async () => ({}),
    } as any)) as any
    const mockAi = { run: jest.fn().mockRejectedValue(new Error('used up your daily free allocation (4006)')) }
    const db = makeDb()
    const env = { DB: db, AI: mockAi, GEMINI_API_KEY_1: 'k' } as any
    await expect(
      aiChat(env, personaPolicy('keeper', 'summarize'), [{ role: 'user', content: '메모 찾아줘' }])
    ).rejects.toThrow()
    const rows = usageRows(db as any)
    const degradedRows = rows.filter((r) => r.provider === 'gemini')
    expect(degradedRows).toHaveLength(1)
    expect(degradedRows[0].engine).toBe('degraded')
    expect(degradedRows[0].outcome).toBe('rate_limited')
    expect(degradedRows[0].persona).toBe('keeper')
  })

  test('비서 맥락 없는 호출(news-briefing 요약형)은 persona unattributed, engine=marker', async () => {
    const mockAi = {
      run: jest.fn().mockResolvedValue({
        response: '요약 완료',
        usage: { prompt_tokens: 50, completion_tokens: 20, neurons: 20 },
      }),
    }
    const db = makeDb()
    const env = { DB: db, AI: mockAi } as any
    // news-briefing.summarizeNewsWithModel과 같은 형태: personaId 없음
    const policy = {
      capability: 'summarize',
      privacy: 'external-ok',
      latency: 'background',
      quality: 'balanced',
      providerPin: 'workers-ai',
      origin: 'scheduled',
    } as unknown as TaskPolicy
    const result = await aiChat(env, policy, [{ role: 'user', content: '기사 목록' }])
    expect(result.provider).toBe('workers-ai')
    const rows = usageRows(db as any)
    expect(rows).toHaveLength(1)
    expect(rows[0].persona).toBe('unattributed')
    // personaId가 없으면 useFC 게이트가 켜질 수 없다 → marker가 정직한 태그
    expect(rows[0].engine).toBe('marker')
  })
})

// ---------------------------------------------------------------------------
// run-logger (E3) 귀속
// ---------------------------------------------------------------------------
describe('D1RunLogger ai_usage 귀속 (0065)', () => {
  test('onModelCall은 engine=registry-fc 고정 + 이벤트의 persona를 싣는다', async () => {
    const db = makeDb()
    const logger = new D1RunLogger({ db: db as any })
    await logger.onModelCall({
      runId: 'run_1',
      callIndex: 0,
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      inputTokens: 100,
      outputTokens: 50,
      usageSource: 'provider',
      durationMs: 123,
      status: 'success',
      persona: 'concierge',
    })
    const rows = usageRows(db as any)
    expect(rows).toHaveLength(1)
    expect(rows[0].engine).toBe('registry-fc')
    expect(rows[0].persona).toBe('concierge')
    expect(rows[0].capability).toBe('function_calling')
  })

  test('persona 없는 이벤트는 persona unattributed로 남는다', async () => {
    const db = makeDb()
    const logger = new D1RunLogger({ db: db as any })
    await logger.onModelCall({
      runId: 'run_2',
      callIndex: 0,
      provider: 'gemini',
      model: 'm',
      usageSource: 'unavailable',
      durationMs: 10,
      status: 'error',
      errorCode: 'TIMEOUT',
    })
    const rows = usageRows(db as any)
    expect(rows).toHaveLength(1)
    expect(rows[0].engine).toBe('registry-fc')
    expect(rows[0].persona).toBe('unattributed')
  })

  test('0065 미적용 DB(귀속 컬럼 INSERT 실패)에서는 기존 형식으로 폴백해 원장이 끊기지 않는다', async () => {
    const seen: string[] = []
    const db = {
      prepare: jest.fn((sql: string) => ({
        bind: jest.fn((..._params: any[]) => ({
          run: jest.fn(async () => {
            seen.push(sql)
            if (sql.includes('engine')) throw new Error('no such column: engine')
            return {}
          }),
        })),
      })),
    }
    const logger = new D1RunLogger({ db: db as any })
    await logger.onModelCall({
      runId: 'run_3',
      callIndex: 0,
      provider: 'groq',
      model: 'm',
      usageSource: 'provider',
      durationMs: 5,
      status: 'success',
      persona: 'concierge',
    })
    // 1차(귀속 포함) 실패 후 2차(기존 형식)가 실행돼 총 2번 시도된다
    expect(seen).toHaveLength(2)
    expect(seen[0]).toContain('engine')
    expect(seen[1]).not.toContain('engine')
    expect(seen[1]).toContain('INSERT INTO ai_usage')
  })
})

// ---------------------------------------------------------------------------
// runner → run-logger 전파 (E3): assistantId가 ai_usage.persona로 닿는가
// ---------------------------------------------------------------------------
describe('AgentRunner persona 전파 (0065)', () => {
  const budget = {
    maxModelCalls: 5,
    maxToolCalls: 4,
    maxTotalInputTokens: 8000,
    maxOutputTokensPerCall: 1024,
    maxToolResultChars: 1500,
    toolTimeoutMs: 1000,
  }

  function makeRunnerInput(session: any, db: any, assistantId?: string) {
    return {
      session,
      registry: new ToolRegistry(),
      ctx: { userId: 'u1', requestId: 'req-1' } as any,
      env: { DB: db },
      budget,
      allowedTools: [],
      systemPrompt: 'sys',
      requestId: 'req-1',
      assistantId,
      logger: new D1RunLogger({ db }),
    }
  }

  test('성공 호출: assistantId가 ai_usage.persona로, engine은 registry-fc로 기록된다', async () => {
    const db = makeDb()
    const session = {
      provider: 'groq',
      modelId: 'openai/gpt-oss-120b',
      next: jest.fn(async () => ({
        text: '안녕',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, source: 'provider' },
      })),
      appendToolResults: jest.fn(),
      estimateInputTokens: jest.fn(() => 100),
    }
    const runner = new AgentRunner()
    const result = await runner.run(makeRunnerInput(session, db as any, 'concierge') as any)
    expect(result.status).toBe('completed')
    const rows = usageRows(db as any)
    expect(rows).toHaveLength(1)
    expect(rows[0].engine).toBe('registry-fc')
    expect(rows[0].persona).toBe('concierge')
  })

  test('실패 호출도 persona가 전파된다 (provider_error 경로)', async () => {
    const db = makeDb()
    const session = {
      provider: 'groq',
      modelId: 'openai/gpt-oss-120b',
      next: jest.fn(async () => {
        const e: any = new Error('boom')
        e.code = 'PROVIDER_ERROR'
        throw e
      }),
      appendToolResults: jest.fn(),
      estimateInputTokens: jest.fn(() => 100),
    }
    const runner = new AgentRunner()
    const result = await runner.run(makeRunnerInput(session, db as any, 'concierge') as any)
    expect(result.status).toBe('provider_error')
    const rows = usageRows(db as any)
    expect(rows).toHaveLength(1)
    expect(rows[0].engine).toBe('registry-fc')
    expect(rows[0].persona).toBe('concierge')
    expect(rows[0].outcome).toBe('PROVIDER_ERROR')
  })

  test('assistantId가 없으면 persona는 unattributed로 남는다', async () => {
    const db = makeDb()
    const session = {
      provider: 'groq',
      modelId: 'm',
      next: jest.fn(async () => ({
        text: 'ok',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, source: 'provider' },
      })),
      appendToolResults: jest.fn(),
      estimateInputTokens: jest.fn(() => 100),
    }
    const runner = new AgentRunner()
    const result = await runner.run(makeRunnerInput(session, db as any, undefined) as any)
    expect(result.status).toBe('completed')
    const rows = usageRows(db as any)
    expect(rows).toHaveLength(1)
    expect(rows[0].persona).toBe('unattributed')
    expect(rows[0].engine).toBe('registry-fc')
  })
})
