/**
 * Run Logger — Phase 1F
 *
 * Agent Runner의 실행 이벤트를 기록.
 * - ai_runs: Run 단위 집계
 * - ai_usage: 기존 테이블 재사용 (모델 호출별)
 * - ai_tool_runs: 도구 실행 추적
 *
 * 원칙:
 * - ai_tool_operations(멱등성 원장)와 분리
 * - 로그 실패가 업무 실행에 영향 없음
 * - 개인정보 원문 기록 금지
 */

import type { AgentRunResult, AgentRunStatus } from './runner'
import { newSpanId, newTraceId, type TraceContext } from '../lib/trace'

// ---------------------------------------------------------------------------
// 로그 이벤트 타입
// ---------------------------------------------------------------------------

export type RunStartEvent = {
  runId: string
  requestId: string
  userId: string
  assistantId?: string
  provider: string
  model: string
}

export type ModelCallEvent = {
  runId: string
  callIndex: number
  provider: string
  model: string
  inputTokens?: number
  outputTokens?: number
  usageSource: 'provider' | 'estimated' | 'unavailable'
  durationMs: number
  status: 'success' | 'error'
  errorCode?: string
  /** OTEL 스팬 (0057) — 없으면 D1RunLogger가 런 단위로 생성한다 */
  traceId?: string
  spanId?: string
  parentSpanId?: string | null
  promptVersion?: string
  /**
   * 비서 귀속 (0065 ai_usage.persona) — 실제 personaId.
   * 이 로거는 E3(Registry FC) 전용이라 engine은 기록 시점에
   * 'registry-fc'로 고정 태깅한다. persona가 없으면 NULL(unknown).
   */
  persona?: string
}

export type ToolCallEvent = {
  runId: string
  toolCallId: string
  toolName: string
  mode: 'read' | 'write'
  status: 'success' | 'error' | 'cached' | 'blocked'
  durationMs: number
  errorCode?: string
  cacheHit: boolean
  operationId?: string
  /** OTEL 스팬 (0057) — 없으면 D1RunLogger가 생성한다 */
  traceId?: string
  spanId?: string
  parentSpanId?: string | null
}

export type RunFinishEvent = {
  runId: string
  status: AgentRunStatus
  modelCalls: number
  requestedToolCalls: number
  executedToolCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  usageSource: string
  elapsedMs: number
  errorCode?: string
  // Phase 2B: Fallback 추적 필드
  /** 최초 Provider */
  initialProvider?: string
  /** 최초 모델 */
  initialModel?: string
  /** 최종 Provider */
  finalProvider?: string
  /** 최종 모델 */
  finalModel?: string
  /** Fallback 발생 여부 */
  fallbackOccurred?: boolean
  /** Fallback 횟수 */
  fallbackCount?: number
  /** Fallback 사유 코드 */
  fallbackReason?: string
}

// ---------------------------------------------------------------------------
// Logger 인터페이스
// ---------------------------------------------------------------------------

export interface RunLogger {
  onRunStart(event: RunStartEvent): Promise<void>
  onModelCall(event: ModelCallEvent): Promise<void>
  onToolCall(event: ToolCallEvent): Promise<void>
  onRunFinish(event: RunFinishEvent): Promise<void>
}

/**
 * No-op Logger (테스트용, 로깅 비활성화)
 */
export class NoopLogger implements RunLogger {
  async onRunStart(): Promise<void> {}
  async onModelCall(): Promise<void> {}
  async onToolCall(): Promise<void> {}
  async onRunFinish(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// D1 Logger
// ---------------------------------------------------------------------------

export type D1LoggerConfig = {
  db: D1Database
}

/**
 * 안전한 로그 래퍼.
 * 로그 실패를 업무 실패와 구분하고, 민감 정보 없이 진단 정보만 남김.
 */
async function safeLog(
  operation: () => Promise<void>,
  label: string
): Promise<void> {
  try {
    await operation()
  } catch (error) {
    // 민감 정보 제외, 오류 유형만 기록
    const errorType = error instanceof Error ? error.name : 'Unknown'
    // console.warn은 Workers에서 로그로 수집됨
    console.warn('AI_LOG_FAILED', { label, errorType })
  }
}

export class D1RunLogger implements RunLogger {
  private db: D1Database

  constructor(config: D1LoggerConfig) {
    this.db = config.db
  }

  async onRunStart(event: RunStartEvent): Promise<void> {
    await safeLog(async () => {
      await this.db
        .prepare(
          `INSERT INTO ai_runs (run_id, request_id, user_id, assistant_id, provider, model, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'running', datetime('now'))`
        )
        .bind(event.runId, event.requestId, event.userId, event.assistantId || null, event.provider, event.model)
        .run()
    }, 'onRunStart')
  }

  async onModelCall(event: ModelCallEvent): Promise<void> {
    await safeLog(async () => {
      // OTEL 스팬 (0057): 호출자가 안 주면 이 호출을 루트로 삼는다.
      // 런 전체를 한 트레이스로 묶는 것은 runner가 traceId를 넘겨서 한다.
      const trace: TraceContext = {
        traceId: event.traceId || newTraceId(),
        spanId: event.spanId || newSpanId(),
        parentSpanId: event.parentSpanId ?? null,
      }
      // 기존 ai_usage 테이블 재사용 (capability는 'function_calling'으로, run_id/call_index 별도 컬럼)
      // 경로 귀속 (0065): 이 로거를 타는 호출은 전부 E3(Registry FC)라
      // engine='registry-fc' 고정, persona는 이벤트가 실어 온 실제 personaId.
      const outcome = event.status === 'success' ? 'success' : event.errorCode || 'failed'
      try {
        await this.db
          .prepare(
            `INSERT INTO ai_usage (provider, model, capability, latency_ms, input_tokens, output_tokens, outcome, run_id, call_index, trace_id, span_id, parent_span_id, prompt_version, created_at, engine, persona)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)`
          )
          .bind(
            event.provider,
            event.model,
            'function_calling',
            event.durationMs,
            event.inputTokens ?? null,
            event.outputTokens ?? null,
            outcome,
            event.runId,
            event.callIndex,
            trace.traceId,
            trace.spanId,
            trace.parentSpanId,
            event.promptVersion ?? null,
            'registry-fc',
            event.persona ?? null
          )
          .run()
      } catch {
        // 0065(귀속 컬럼) 미적용 DB — 귀속 없는 기존 형식으로 한 번 더
        // 시도해 원장 자체가 끊기지 않게 한다 (services/ai.ts logUsage와 동일 원칙).
        await this.db
          .prepare(
            `INSERT INTO ai_usage (provider, model, capability, latency_ms, input_tokens, output_tokens, outcome, run_id, call_index, trace_id, span_id, parent_span_id, prompt_version, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
          )
          .bind(
            event.provider,
            event.model,
            'function_calling',
            event.durationMs,
            event.inputTokens ?? null,
            event.outputTokens ?? null,
            outcome,
            event.runId,
            event.callIndex,
            trace.traceId,
            trace.spanId,
            trace.parentSpanId,
            event.promptVersion ?? null
          )
          .run()
      }
    }, 'onModelCall')
  }

  async onToolCall(event: ToolCallEvent): Promise<void> {
    await safeLog(async () => {
      // OTEL 스팬 (0057): 호출자가 안 주면 이 호출을 루트로 삼는다.
      const trace: TraceContext = {
        traceId: event.traceId || newTraceId(),
        spanId: event.spanId || newSpanId(),
        parentSpanId: event.parentSpanId ?? null,
      }
      await this.db
        .prepare(
          `INSERT INTO ai_tool_runs (run_id, tool_call_id, tool_name, mode, status, duration_ms, error_code, cache_hit, operation_id, trace_id, span_id, parent_span_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        )
        .bind(
          event.runId,
          event.toolCallId,
          event.toolName,
          event.mode,
          event.status,
          event.durationMs,
          event.errorCode || null,
          event.cacheHit ? 1 : 0,
          event.operationId || null,
          trace.traceId,
          trace.spanId,
          trace.parentSpanId
        )
        .run()
    }, 'onToolCall')
  }

  async onRunFinish(event: RunFinishEvent): Promise<void> {
    await safeLog(async () => {
      // 기본 필드 업데이트 (하위 호환)
      await this.db
        .prepare(
          `UPDATE ai_runs SET status = ?, model_calls = ?, requested_tool_calls = ?, executed_tool_calls = ?,
           total_input_tokens = ?, total_output_tokens = ?, usage_source = ?, elapsed_ms = ?, error_code = ?,
           finished_at = datetime('now')
           WHERE run_id = ?`
        )
        .bind(
          event.status,
          event.modelCalls,
          event.requestedToolCalls,
          event.executedToolCalls,
          event.totalInputTokens,
          event.totalOutputTokens,
          event.usageSource,
          event.elapsedMs,
          event.errorCode || null,
          event.runId
        )
        .run()

      // Phase 2B: Fallback 필드 업데이트 (컬럼이 없으면 무시)
      // 마이그레이션 0023 적용 전 DB와의 하위 호환성 유지
      try {
        await this.db
          .prepare(
            `UPDATE ai_runs SET
             initial_provider = ?, initial_model = ?, final_provider = ?, final_model = ?,
             fallback_occurred = ?, fallback_count = ?, fallback_reason = ?
             WHERE run_id = ?`
          )
          .bind(
            event.initialProvider || null,
            event.initialModel || null,
            event.finalProvider || null,
            event.finalModel || null,
            event.fallbackOccurred ? 1 : 0,
            event.fallbackCount || 0,
            event.fallbackReason || null,
            event.runId
          )
          .run()
      } catch {
        // 컬럼이 없는旧 DB에서는 무시 (safeLog가 이미 감싸고 있음)
      }
    }, 'onRunFinish')
  }
}

// ---------------------------------------------------------------------------
// ID 생성
// ---------------------------------------------------------------------------

export function generateRunId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `run_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
  }
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(0, 8)}`
}
