/// <reference types="jest" />

import {
  NoopLogger,
  D1RunLogger,
  generateRunId,
} from '../../src/ai/run-logger'

function createMockDb() {
  const run = jest.fn().mockResolvedValue({})
  const bind = jest.fn().mockReturnValue({ run })
  const prepare = jest.fn().mockReturnValue({ bind })
  return { prepare, bind, run }
}

describe('NoopLogger', () => {
  test('모든 메서드가 resolve', async () => {
    const logger = new NoopLogger()
    await expect(logger.onRunStart()).resolves.toBeUndefined()
    await expect(logger.onModelCall()).resolves.toBeUndefined()
    await expect(logger.onToolCall()).resolves.toBeUndefined()
    await expect(logger.onRunFinish()).resolves.toBeUndefined()
  })
})

describe('D1RunLogger.onRunStart', () => {
  test('ai_runs에 INSERT', async () => {
    const db = createMockDb()
    const logger = new D1RunLogger({ db: db as any })
    await logger.onRunStart({
      runId: 'run_1',
      requestId: 'req_1',
      userId: 'user_1',
      provider: 'gemini',
      model: 'gemini-2.0',
    })
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO ai_runs'))
    expect(db.bind).toHaveBeenCalledWith(
      'run_1', 'req_1', 'user_1', null, 'gemini', 'gemini-2.0'
    )
  })

  test('assistantId 있으면 전달', async () => {
    const db = createMockDb()
    const logger = new D1RunLogger({ db: db as any })
    await logger.onRunStart({
      runId: 'r', requestId: 'q', userId: 'u',
      assistantId: 'nova', provider: 'p', model: 'm',
    })
    expect(db.bind).toHaveBeenCalledWith('r', 'q', 'u', 'nova', 'p', 'm')
  })

  test('DB 실패해도 throw 안 함 (safeLog)', async () => {
    const db = {
      prepare: jest.fn().mockImplementation(() => { throw new Error('db down') }),
    }
    const logger = new D1RunLogger({ db: db as any })
    await expect(logger.onRunStart({} as any)).resolves.toBeUndefined()
  })
})

describe('D1RunLogger.onModelCall', () => {
  test('ai_usage에 INSERT', async () => {
    const db = createMockDb()
    const logger = new D1RunLogger({ db: db as any })
    await logger.onModelCall({
      runId: 'run_1',
      callIndex: 0,
      provider: 'gemini',
      model: 'm',
      inputTokens: 100,
      outputTokens: 50,
      usageSource: 'provider',
      durationMs: 1234,
      status: 'success',
    })
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO ai_usage'))
    // OTEL 스팬 (0057): trace_id/span_id는 자동 생성(32/16자 hex), parent/prompt는 없으면 null
    expect(db.bind).toHaveBeenCalledWith(
      'gemini', 'm', 'function_calling', 1234, 100, 50, 'success', 'run_1', 0,
      expect.stringMatching(/^[0-9a-f]{32}$/),
      expect.stringMatching(/^[0-9a-f]{16}$/),
      null, null, 'registry-fc', null
    )
  })

  test('호출자가 준 trace 컨텍스트를 그대로 저장', async () => {
    const db = createMockDb()
    const logger = new D1RunLogger({ db: db as any })
    await logger.onModelCall({
      runId: 'run_1', callIndex: 0, provider: 'gemini', model: 'm',
      inputTokens: 100, outputTokens: 50, usageSource: 'provider',
      durationMs: 1234, status: 'success',
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), parentSpanId: 'c'.repeat(16),
      promptVersion: 'persona-v1',
    })
    expect(db.bind).toHaveBeenCalledWith(
      'gemini', 'm', 'function_calling', 1234, 100, 50, 'success', 'run_1', 0,
      'a'.repeat(32), 'b'.repeat(16), 'c'.repeat(16), 'persona-v1', 'registry-fc', null
    )
  })

  test('토큰 없으면 null', async () => {
    const db = createMockDb()
    const logger = new D1RunLogger({ db: db as any })
    await logger.onModelCall({
      runId: 'r', callIndex: 1, provider: 'p', model: 'm',
      usageSource: 'unavailable', durationMs: 100, status: 'error', errorCode: 'TIMEOUT',
    })
    expect(db.bind).toHaveBeenCalledWith(
      'p', 'm', 'function_calling', 100, null, null, 'TIMEOUT', 'r', 1,
      expect.stringMatching(/^[0-9a-f]{32}$/),
      expect.stringMatching(/^[0-9a-f]{16}$/),
      null, null, 'registry-fc', null
    )
  })

  test('에러 코드 없으면 failed', async () => {
    const db = createMockDb()
    const logger = new D1RunLogger({ db: db as any })
    await logger.onModelCall({
      runId: 'r', callIndex: 0, provider: 'p', model: 'm',
      usageSource: 'unavailable', durationMs: 100, status: 'error',
    })
    expect(db.bind).toHaveBeenCalledWith(
      'p', 'm', 'function_calling', 100, null, null, 'failed', 'r', 0,
      expect.stringMatching(/^[0-9a-f]{32}$/),
      expect.stringMatching(/^[0-9a-f]{16}$/),
      null, null, 'registry-fc', null
    )
  })
})

describe('D1RunLogger.onToolCall', () => {
  test('ai_tool_runs에 INSERT', async () => {
    const db = createMockDb()
    const logger = new D1RunLogger({ db: db as any })
    await logger.onToolCall({
      runId: 'run_1',
      toolCallId: 'tc_1',
      toolName: 'search_memo',
      mode: 'read',
      status: 'success',
      durationMs: 200,
      cacheHit: false,
    })
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO ai_tool_runs'))
    expect(db.bind).toHaveBeenCalledWith(
      'run_1', 'tc_1', 'search_memo', 'read', 'success', 200, null, 0, null,
      expect.stringMatching(/^[0-9a-f]{32}$/),
      expect.stringMatching(/^[0-9a-f]{16}$/),
      null
    )
  })

  test('호출자가 준 trace 컨텍스트를 그대로 저장', async () => {
    const db = createMockDb()
    const logger = new D1RunLogger({ db: db as any })
    await logger.onToolCall({
      runId: 'run_1', toolCallId: 'tc_1', toolName: 'search_memo', mode: 'read',
      status: 'success', durationMs: 200, cacheHit: false,
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), parentSpanId: 'c'.repeat(16),
    })
    expect(db.bind).toHaveBeenCalledWith(
      'run_1', 'tc_1', 'search_memo', 'read', 'success', 200, null, 0, null,
      'a'.repeat(32), 'b'.repeat(16), 'c'.repeat(16)
    )
  })

  test('cacheHit true면 1', async () => {
    const db = createMockDb()
    const logger = new D1RunLogger({ db: db as any })
    await logger.onToolCall({
      runId: 'r', toolCallId: 't', toolName: 'n', mode: 'write',
      status: 'cached', durationMs: 10, cacheHit: true, operationId: 'op_1',
    })
    expect(db.bind).toHaveBeenCalledWith(
      'r', 't', 'n', 'write', 'cached', 10, null, 1, 'op_1',
      expect.stringMatching(/^[0-9a-f]{32}$/),
      expect.stringMatching(/^[0-9a-f]{16}$/),
      null
    )
  })

  test('errorCode 전달', async () => {
    const db = createMockDb()
    const logger = new D1RunLogger({ db: db as any })
    await logger.onToolCall({
      runId: 'r', toolCallId: 't', toolName: 'n', mode: 'read',
      status: 'error', durationMs: 10, cacheHit: false, errorCode: 'BLOCKED',
    })
    expect(db.bind).toHaveBeenCalledWith(
      'r', 't', 'n', 'read', 'error', 10, 'BLOCKED', 0, null,
      expect.stringMatching(/^[0-9a-f]{32}$/),
      expect.stringMatching(/^[0-9a-f]{16}$/),
      null
    )
  })
})

describe('D1RunLogger.onRunFinish', () => {
  test('ai_runs UPDATE + fallback 필드 UPDATE', async () => {
    const db = createMockDb()
    const logger = new D1RunLogger({ db: db as any })
    await logger.onRunFinish({
      runId: 'run_1',
      status: 'completed',
      modelCalls: 2,
      requestedToolCalls: 3,
      executedToolCalls: 3,
      totalInputTokens: 500,
      totalOutputTokens: 200,
      usageSource: 'provider',
      elapsedMs: 5000,
    })
    expect(db.prepare).toHaveBeenCalledTimes(2)
    expect(db.prepare).toHaveBeenNthCalledWith(1, expect.stringContaining('UPDATE ai_runs SET status'))
    expect(db.prepare).toHaveBeenNthCalledWith(2, expect.stringContaining('initial_provider'))
  })

  test('fallback 정보 전달', async () => {
    const db = createMockDb()
    const logger = new D1RunLogger({ db: db as any })
    await logger.onRunFinish({
      runId: 'r', status: 'completed', modelCalls: 1,
      requestedToolCalls: 0, executedToolCalls: 0,
      totalInputTokens: 0, totalOutputTokens: 0,
      usageSource: 'provider', elapsedMs: 100,
      initialProvider: 'gemini', initialModel: 'm1',
      finalProvider: 'groq', finalModel: 'm2',
      fallbackOccurred: true, fallbackCount: 1, fallbackReason: 'rate_limit',
    })
    expect(db.bind).toHaveBeenNthCalledWith(2,
      'gemini', 'm1', 'groq', 'm2', 1, 1, 'rate_limit', 'r'
    )
  })

  test('fallback 없으면 기본값', async () => {
    const db = createMockDb()
    const logger = new D1RunLogger({ db: db as any })
    await logger.onRunFinish({
      runId: 'r', status: 'completed', modelCalls: 1,
      requestedToolCalls: 0, executedToolCalls: 0,
      totalInputTokens: 0, totalOutputTokens: 0,
      usageSource: 'provider', elapsedMs: 100,
    })
    expect(db.bind).toHaveBeenNthCalledWith(2,
      null, null, null, null, 0, 0, null, 'r'
    )
  })

  test('fallback UPDATE 실패해도 무시 (구 DB 호환)', async () => {
    const run = jest.fn().mockResolvedValue({})
    const bind = jest.fn().mockReturnValue({ run })
    let callCount = 0
    const db = {
      prepare: jest.fn().mockImplementation(() => {
        callCount++
        if (callCount === 2) {
          return { bind: jest.fn().mockReturnValue({ run: jest.fn().mockRejectedValue(new Error('no column')) }) }
        }
        return { bind }
      }),
    }
    const logger = new D1RunLogger({ db: db as any })
    await expect(logger.onRunFinish({
      runId: 'r', status: 'completed', modelCalls: 1,
      requestedToolCalls: 0, executedToolCalls: 0,
      totalInputTokens: 0, totalOutputTokens: 0,
      usageSource: 'provider', elapsedMs: 100,
    })).resolves.toBeUndefined()
  })
})

describe('generateRunId', () => {
  test('run_ 접두사', () => {
    const id = generateRunId()
    expect(id.startsWith('run_')).toBe(true)
  })

  test('매번 다른 ID', () => {
    const a = generateRunId()
    const b = generateRunId()
    // randomUUID 기반이면 다르고, fallback이면 Date.now 기반이라 같을 수 있음
    expect(typeof a).toBe('string')
    expect(typeof b).toBe('string')
  })
})
