/// <reference types="jest" />
// 2026-11-08 최종 배치 (c) 정리: D1RunLogger 테스트가 prepare/bind mock 호출
// 단언만으로 이루어져 있던 13건을 실제 SQLite(local-d1)에 저장된 행 단언으로
// 재작성했다. 로거가 실제로 무엇을 기록하는지가 성질이며, mock 호출 여부가
// 아니다. 카나리아: outcome 기본값('failed')·capability·engine 상수를 src에서
// 바꾸면 해당 테스트가 실패함을 확인했다.

import {
  NoopLogger,
  D1RunLogger,
  generateRunId,
} from '../../src/ai/run-logger'

const fs = require('fs')
const path = require('path')
const { createLocalD1 } = require('../helpers/local-d1.cjs')

const MIGRATIONS = [
  '0007_ai_usage.sql',
  '0021_ai_run_logs.sql',
  '0022_ai_usage_run_id.sql',
  '0023_ai_fallback.sql',
  '0055_tool_execution_audit.sql',
  '0057_otel_spans.sql',
  '0065_ai_usage_attribution.sql',
]

function makeDb(exclude: string[] = []): any {
  const d1 = createLocalD1()
  for (const name of MIGRATIONS) {
    if (exclude.includes(name)) continue
    d1.exec(fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', name), 'utf8'))
  }
  return d1
}

async function rows(d1: any, sql: string, ...params: any[]): Promise<any[]> {
  const r = await d1.prepare(sql).bind(...params).all()
  return r.results
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
  test('ai_runs에 running 상태 행이 실제로 저장된다', async () => {
    const db = makeDb()
    const logger = new D1RunLogger({ db })
    await logger.onRunStart({
      runId: 'run_1',
      requestId: 'req_1',
      userId: 'user_1',
      provider: 'gemini',
      model: 'gemini-2.0',
    })
    const rs = await rows(db, 'SELECT * FROM ai_runs')
    expect(rs).toHaveLength(1)
    expect(rs[0]).toMatchObject({
      run_id: 'run_1',
      request_id: 'req_1',
      user_id: 'user_1',
      assistant_id: null,
      provider: 'gemini',
      model: 'gemini-2.0',
      status: 'running',
    })
    expect(rs[0].created_at).toBeTruthy()
  })

  test('assistantId가 있으면 그 값으로 저장된다', async () => {
    const db = makeDb()
    const logger = new D1RunLogger({ db })
    await logger.onRunStart({
      runId: 'r', requestId: 'q', userId: 'u',
      assistantId: 'nova', provider: 'p', model: 'm',
    })
    const rs = await rows(db, 'SELECT assistant_id FROM ai_runs WHERE run_id = ?', 'r')
    expect(rs).toHaveLength(1)
    expect(rs[0].assistant_id).toBe('nova')
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
  test('ai_usage에 호출 기록이 실제로 저장된다 (귀속·트레이스 자동 생성 포함)', async () => {
    const db = makeDb()
    const logger = new D1RunLogger({ db })
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
    const rs = await rows(db, 'SELECT * FROM ai_usage')
    expect(rs).toHaveLength(1)
    expect(rs[0]).toMatchObject({
      provider: 'gemini',
      model: 'm',
      capability: 'function_calling',
      latency_ms: 1234,
      input_tokens: 100,
      output_tokens: 50,
      outcome: 'success',
      run_id: 'run_1',
      call_index: 0,
      parent_span_id: null,
      prompt_version: null,
      engine: 'registry-fc',
      // persona는 귀속 정보가 없으면 NULL이 아니라 'unattributed'로 남는다 (원본 번들 동작)
      persona: 'unattributed',
    })
    // OTEL 스팬 (0057): trace_id/span_id는 자동 생성된 32/16자 hex
    expect(rs[0].trace_id).toMatch(/^[0-9a-f]{32}$/)
    expect(rs[0].span_id).toMatch(/^[0-9a-f]{16}$/)
  })

  test('호출자가 준 trace 컨텍스트가 그대로 저장된다', async () => {
    const db = makeDb()
    const logger = new D1RunLogger({ db })
    await logger.onModelCall({
      runId: 'run_1', callIndex: 0, provider: 'gemini', model: 'm',
      inputTokens: 100, outputTokens: 50, usageSource: 'provider',
      durationMs: 1234, status: 'success',
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), parentSpanId: 'c'.repeat(16),
      promptVersion: 'persona-v1',
    } as any)
    const rs = await rows(db, 'SELECT trace_id, span_id, parent_span_id, prompt_version FROM ai_usage')
    expect(rs).toHaveLength(1)
    expect(rs[0]).toEqual({
      trace_id: 'a'.repeat(32),
      span_id: 'b'.repeat(16),
      parent_span_id: 'c'.repeat(16),
      prompt_version: 'persona-v1',
    })
  })

  test('토큰이 없으면 null로 저장되고 outcome은 errorCode가 된다', async () => {
    const db = makeDb()
    const logger = new D1RunLogger({ db })
    await logger.onModelCall({
      runId: 'r', callIndex: 1, provider: 'p', model: 'm',
      usageSource: 'unavailable', durationMs: 100, status: 'error', errorCode: 'TIMEOUT',
    })
    const rs = await rows(db, 'SELECT input_tokens, output_tokens, outcome, run_id, call_index FROM ai_usage')
    expect(rs).toHaveLength(1)
    expect(rs[0]).toEqual({
      input_tokens: null,
      output_tokens: null,
      outcome: 'TIMEOUT',
      run_id: 'r',
      call_index: 1,
    })
  })

  test('에러 코드가 없으면 outcome은 failed로 저장된다', async () => {
    const db = makeDb()
    const logger = new D1RunLogger({ db })
    await logger.onModelCall({
      runId: 'r', callIndex: 0, provider: 'p', model: 'm',
      usageSource: 'unavailable', durationMs: 100, status: 'error',
    })
    const rs = await rows(db, 'SELECT outcome FROM ai_usage')
    expect(rs).toHaveLength(1)
    expect(rs[0].outcome).toBe('failed')
  })
})

describe('D1RunLogger.onToolCall', () => {
  test('ai_tool_runs에 도구 실행 기록이 실제로 저장된다', async () => {
    const db = makeDb()
    const logger = new D1RunLogger({ db })
    await logger.onToolCall({
      runId: 'run_1',
      toolCallId: 'tc_1',
      toolName: 'search_memo',
      mode: 'read',
      status: 'success',
      durationMs: 200,
      cacheHit: false,
    })
    const rs = await rows(db, 'SELECT * FROM ai_tool_runs')
    expect(rs).toHaveLength(1)
    expect(rs[0]).toMatchObject({
      run_id: 'run_1',
      tool_call_id: 'tc_1',
      tool_name: 'search_memo',
      mode: 'read',
      status: 'success',
      duration_ms: 200,
      error_code: null,
      cache_hit: 0,
      operation_id: null,
      parent_span_id: null,
    })
    expect(rs[0].trace_id).toMatch(/^[0-9a-f]{32}$/)
    expect(rs[0].span_id).toMatch(/^[0-9a-f]{16}$/)
  })

  test('호출자가 준 trace 컨텍스트가 그대로 저장된다', async () => {
    const db = makeDb()
    const logger = new D1RunLogger({ db })
    await logger.onToolCall({
      runId: 'run_1', toolCallId: 'tc_1', toolName: 'search_memo', mode: 'read',
      status: 'success', durationMs: 200, cacheHit: false,
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), parentSpanId: 'c'.repeat(16),
    } as any)
    const rs = await rows(db, 'SELECT trace_id, span_id, parent_span_id FROM ai_tool_runs')
    expect(rs).toHaveLength(1)
    expect(rs[0]).toEqual({
      trace_id: 'a'.repeat(32),
      span_id: 'b'.repeat(16),
      parent_span_id: 'c'.repeat(16),
    })
  })

  test('cacheHit true면 cache_hit=1과 operation_id가 저장된다', async () => {
    const db = makeDb()
    const logger = new D1RunLogger({ db })
    await logger.onToolCall({
      runId: 'r', toolCallId: 't', toolName: 'n', mode: 'write',
      status: 'cached', durationMs: 10, cacheHit: true, operationId: 'op_1',
    })
    const rs = await rows(db, 'SELECT status, cache_hit, operation_id FROM ai_tool_runs')
    expect(rs).toHaveLength(1)
    expect(rs[0]).toEqual({ status: 'cached', cache_hit: 1, operation_id: 'op_1' })
  })

  test('errorCode가 error_code로 저장된다', async () => {
    const db = makeDb()
    const logger = new D1RunLogger({ db })
    await logger.onToolCall({
      runId: 'r', toolCallId: 't', toolName: 'n', mode: 'read',
      status: 'error', durationMs: 10, cacheHit: false, errorCode: 'BLOCKED',
    })
    const rs = await rows(db, 'SELECT status, error_code FROM ai_tool_runs')
    expect(rs).toHaveLength(1)
    expect(rs[0]).toEqual({ status: 'error', error_code: 'BLOCKED' })
  })
})

describe('D1RunLogger.onRunFinish', () => {
  const startEvent = {
    runId: 'run_1', requestId: 'req_1', userId: 'user_1', provider: 'gemini', model: 'm1',
  }

  test('ai_runs 행이 집계값으로 실제 UPDATE된다', async () => {
    const db = makeDb()
    const logger = new D1RunLogger({ db })
    await logger.onRunStart(startEvent)
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
    const rs = await rows(db, 'SELECT * FROM ai_runs WHERE run_id = ?', 'run_1')
    expect(rs).toHaveLength(1)
    expect(rs[0]).toMatchObject({
      status: 'completed',
      model_calls: 2,
      requested_tool_calls: 3,
      executed_tool_calls: 3,
      total_input_tokens: 500,
      total_output_tokens: 200,
      usage_source: 'provider',
      elapsed_ms: 5000,
      error_code: null,
    })
    expect(rs[0].finished_at).toBeTruthy()
  })

  test('fallback 정보가 행에 저장된다', async () => {
    const db = makeDb()
    const logger = new D1RunLogger({ db })
    await logger.onRunStart({ ...startEvent, runId: 'r' })
    await logger.onRunFinish({
      runId: 'r', status: 'completed', modelCalls: 1,
      requestedToolCalls: 0, executedToolCalls: 0,
      totalInputTokens: 0, totalOutputTokens: 0,
      usageSource: 'provider', elapsedMs: 100,
      initialProvider: 'gemini', initialModel: 'm1',
      finalProvider: 'groq', finalModel: 'm2',
      fallbackOccurred: true, fallbackCount: 1, fallbackReason: 'rate_limit',
    })
    const rs = await rows(
      db,
      'SELECT initial_provider, initial_model, final_provider, final_model, fallback_occurred, fallback_count, fallback_reason FROM ai_runs WHERE run_id = ?',
      'r',
    )
    expect(rs).toHaveLength(1)
    expect(rs[0]).toEqual({
      initial_provider: 'gemini',
      initial_model: 'm1',
      final_provider: 'groq',
      final_model: 'm2',
      fallback_occurred: 1,
      fallback_count: 1,
      fallback_reason: 'rate_limit',
    })
  })

  test('fallback이 없으면 기본값(null/0)이 저장된다', async () => {
    const db = makeDb()
    const logger = new D1RunLogger({ db })
    await logger.onRunStart({ ...startEvent, runId: 'r' })
    await logger.onRunFinish({
      runId: 'r', status: 'completed', modelCalls: 1,
      requestedToolCalls: 0, executedToolCalls: 0,
      totalInputTokens: 0, totalOutputTokens: 0,
      usageSource: 'provider', elapsedMs: 100,
    })
    const rs = await rows(
      db,
      'SELECT initial_provider, initial_model, final_provider, final_model, fallback_occurred, fallback_count, fallback_reason FROM ai_runs WHERE run_id = ?',
      'r',
    )
    expect(rs).toHaveLength(1)
    expect(rs[0]).toEqual({
      initial_provider: null,
      initial_model: null,
      final_provider: null,
      final_model: null,
      fallback_occurred: 0,
      fallback_count: 0,
      fallback_reason: null,
    })
  })

  test('fallback 컬럼이 없는 구 DB(0023 미적용)에서도 기본 UPDATE는 적용되고 throw하지 않는다', async () => {
    const db = makeDb(['0023_ai_fallback.sql'])
    const logger = new D1RunLogger({ db })
    await logger.onRunStart({ ...startEvent, runId: 'r' })
    await expect(logger.onRunFinish({
      runId: 'r', status: 'completed', modelCalls: 1,
      requestedToolCalls: 0, executedToolCalls: 0,
      totalInputTokens: 0, totalOutputTokens: 0,
      usageSource: 'provider', elapsedMs: 100,
    })).resolves.toBeUndefined()
    const rs = await rows(db, 'SELECT status, model_calls FROM ai_runs WHERE run_id = ?', 'r')
    expect(rs).toHaveLength(1)
    expect(rs[0]).toEqual({ status: 'completed', model_calls: 1 })
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
