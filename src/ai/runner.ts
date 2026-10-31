/**
 * MyHub Agent Runner — Phase 1D
 *
 * 모든 Function Calling 실행을 통제하는 중앙 제어기.
 * - Provider Adapter와 Tool Registry를 각각 호출
 * - 멀티턴 루프, 예산 관리, 오류 처리, 안전한 종료
 */

import type {
  ToolCall,
  ToolResult,
  ModelStep,
  ProviderSession,
  ProviderError,
  Budget,
  ExecutionContext,
} from './types'
import { ToolRegistry } from './tools/registry'
import { DEFAULT_BUDGET } from './types'
import type { WriteExecutionGuard, WriteApproval } from './tools/write-guard'
import type { RunLogger } from './run-logger'
import { generateRunId } from './run-logger'
import { newRootTrace, childSpan, newSpanId, type TraceContext } from '../lib/trace'

export type AgentRunStatus =
  | 'completed'
  | 'budget_exceeded'
  | 'provider_error'
  | 'tool_error'
  | 'invalid_response'
  | 'cancelled'

export type AgentRunInput = {
  session: ProviderSession
  registry: ToolRegistry
  ctx: ExecutionContext
  env: { DB: D1Database }
  budget: Budget
  allowedTools: string[]
  systemPrompt?: string
  requestId: string
  abortSignal?: AbortSignal
  /**
   * Write Guard (쓰기 도구용).
   * 설정되지 않으면 쓰기 도구는 실행 거부 (fail-closed).
   */
  writeGuard?: WriteExecutionGuard
  /**
   * 쓰기 승인 조회 함수.
   * 서버에서 승인된 작업만 반환. 모델 인자는 무시.
   */
  getWriteApproval?: (toolName: string, args: unknown) => Promise<WriteApproval | null>
  /**
   * Run Logger (실행 추적용).
   * 설정되지 않으면 로깅하지 않음.
   */
  logger?: RunLogger
  /**
   * Run ID (없으면 자동 생성)
   */
  runId?: string
  /**
   * OTEL trace_id (0057) — 없으면 런마다 새로 생성한다.
   * FallbackController가 재시도할 때 같은 trace_id를 넘기면
   * 재시도까지 한 트레이스로 묶인다.
   */
  traceId?: string
  /**
   * Assistant ID (로깅용)
   */
  assistantId?: string
  /**
   * Phase 2B-L: Run 시작/종료 로그 건너뛰기
   * FallbackController가 전체 수명주기를 관리할 때 사용.
   * true이면 onRunStart/onRunFinish를 호출하지 않음 (ai_usage 등 세부 로그는 유지).
   */
  skipRunLogging?: boolean
  /**
   * Phase 2B-L: callIndex 오프셋
   * Fallback 시 이전 시도의 호출 횟수를 더해 전체 Run에서 순차적으로 기록.
   */
  callIndexOffset?: number
}

export type AgentRunResult = {
  status: AgentRunStatus
  text: string
  modelCalls: number
  requestedToolCalls: number
  executedToolCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  usageSource: 'provider' | 'estimated' | 'unavailable' | 'mixed'
  /** 추정 토큰 사용 여부 (실제 usage가 없을 때) */
  estimatedTokensUsed?: boolean
  errorCode?: string
  errorMessage?: string
  elapsedMs: number
}

export { DEFAULT_BUDGET }

/**
 * 보수적 토큰 추정.
 * - 한글: 1자 ≈ 1.5토큰
 * - 영문/숫자: 1단어 ≈ 1.3토큰 (공백 기준)
 * - JSON 오버헤드: 20% 추가
 * - 안전 여유: 1.5배
 *
 * 실제 토큰보다 크게 추정하여 예산을 보수적으로 관리.
 */
export function estimateTokensConservative(text: string): number {
  if (!text) return 0
  // 한글 문자 수
  const korean = (text.match(/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g) || []).length
  // 나머지 텍스트 (영문, 숫자, 기호)
  const rest = text.length - korean
  const words = rest > 0 ? text.replace(/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g, '').split(/\s+/).length : 0
  const estimated = korean * 1.5 + words * 1.3
  // JSON 오버헤드 + 안전 여유
  return Math.ceil(estimated * 1.2 * 1.5)
}

/** 안전 여유 (토큰 추정 오차 감안) */
const SAFETY_MARGIN_TOKENS = 500

export class AgentRunner {
  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const startTime = Date.now()
    const { session, registry, ctx, env, budget, allowedTools, systemPrompt, logger } = input
    const runId = input.runId || generateRunId()
    // OTEL 트레이스 (0057): 런 하나가 트레이스 하나. 모델 호출은 루트의
    // 자식 스팬, 도구 호출은 해당 모델 호출 스팬의 자식이다.
    const rootTrace: TraceContext = input.traceId
      ? { traceId: input.traceId, spanId: newSpanId(), parentSpanId: null }
      : newRootTrace()
    // 직전 모델 호출 스팬 (도구 호출의 부모). 아직 없으면 루트가 부모.
    let currentModelSpanId: string | null = null
    const modelSpan = (): TraceContext => {
      const span = childSpan(rootTrace)
      currentModelSpanId = span.spanId
      return span
    }
    const toolSpanParent = (): string => currentModelSpanId ?? rootTrace.spanId
    // Phase 2B-L: callIndex 오프셋 (Fallback 시 이전 시도의 호출 수)
    const callIndexOffset = input.callIndexOffset || 0

    // Run 시작 로그 (skipRunLogging이 아닐 때만)
    // Phase 2B-L: FallbackController가 관리하는 경우 건너뜀
    if (logger && !input.skipRunLogging) {
      await logger.onRunStart({
        runId,
        requestId: input.requestId,
        userId: ctx.userId,
        assistantId: input.assistantId,
        provider: session.provider,
        model: session.modelId,
      }).catch(() => {})
    }

    let modelCalls = 0
    let requestedToolCalls = 0
    let executedToolCalls = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let hasProviderUsage = false
    let hasEstimatedUsage = false
    const readCache = new Map<string, unknown>()
    const toolDefinitions = registry.list(allowedTools)
    const allowedSet = new Set(allowedTools)

    const buildResult = (partial: Partial<AgentRunResult> & { status: AgentRunStatus }): AgentRunResult => {
      const result: AgentRunResult = {
        status: partial.status,
        text: partial.text || '',
        modelCalls,
        requestedToolCalls,
        executedToolCalls,
        totalInputTokens,
        totalOutputTokens,
        usageSource: hasProviderUsage && hasEstimatedUsage ? 'mixed' : hasProviderUsage ? 'provider' : hasEstimatedUsage ? 'estimated' : 'unavailable',
        errorCode: partial.errorCode,
        errorMessage: partial.errorMessage,
        elapsedMs: Date.now() - startTime,
      }
      // Run 종료 로그 (비동기, 실패 무시)
      // Phase 2B-L: skipRunLogging이면 Controller가 관리
      if (logger && !input.skipRunLogging) {
        logger.onRunFinish({
          runId,
          status: result.status,
          modelCalls: result.modelCalls,
          requestedToolCalls: result.requestedToolCalls,
          executedToolCalls: result.executedToolCalls,
          totalInputTokens: result.totalInputTokens,
          totalOutputTokens: result.totalOutputTokens,
          usageSource: result.usageSource,
          elapsedMs: result.elapsedMs,
          errorCode: result.errorCode,
        }).catch(() => {})
      }
      return result
    }

    try {
      for (let step = 0; step < budget.maxModelCalls; step++) {
        if (input.abortSignal?.aborted) {
          return buildResult({ status: 'cancelled', errorCode: 'CANCELLED', errorMessage: 'Request cancelled' })
        }

        const isLastCall = step === budget.maxModelCalls - 1

        // R1: 호출 전 입력 토큰 추정 및 예산 확인
        const nextOptions = {
          tools: isLastCall ? [] : toolDefinitions,
          toolChoice: (isLastCall ? 'none' : 'auto') as 'auto' | 'none',
          maxOutputTokens: budget.maxOutputTokensPerCall,
          systemPrompt: step === 0 ? systemPrompt : undefined,
        }

        let estimatedInput = 0
        if (session.estimateInputTokens) {
          const est = session.estimateInputTokens(nextOptions)
          estimatedInput = est !== null ? est : estimateTokensConservative(JSON.stringify(nextOptions.tools).slice(0, 2000))
        } else {
          // Adapter가 추정 미구현 시 보수적 추정
          // (실제 메시지 크기는 알 수 없으므로 도구 정의 기준)
          estimatedInput = estimateTokensConservative(JSON.stringify(nextOptions.tools).slice(0, 2000)) + 1000
        }

        // 예산 확인: 누적 + 예상 + 안전여유 <= 상한
        if (totalInputTokens + estimatedInput + SAFETY_MARGIN_TOKENS > budget.maxTotalInputTokens) {
          return buildResult({
            status: 'budget_exceeded',
            errorCode: 'TOKEN_BUDGET_EXCEEDED',
            errorMessage: `Estimated input tokens (${totalInputTokens + estimatedInput}) would exceed budget`,
          })
        }

        let modelStep: ModelStep
        const modelCallStart = Date.now()
        try {
          modelStep = await session.next(nextOptions)
          modelCalls++
        } catch (e: any) {
          const pe = e as ProviderError
          // Phase 2B-L: 실패한 호출도 시도 횟수에 포함
          const failedCallIndex = callIndexOffset + modelCalls
          modelCalls++
          // 모델 호출 실패 로그
          if (logger) {
            const span = modelSpan()
            await logger.onModelCall({
              runId,
              callIndex: failedCallIndex,
              provider: session.provider,
              model: session.modelId,
              usageSource: 'unavailable',
              durationMs: Date.now() - modelCallStart,
              status: 'error',
              errorCode: pe.code || 'PROVIDER_ERROR',
              persona: input.assistantId,
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId,
            }).catch(() => {})
          }
          return buildResult({ status: 'provider_error', errorCode: pe.code || 'PROVIDER_ERROR', errorMessage: 'Model API error' })
        }
        const modelCallDuration = Date.now() - modelCallStart

        // R1: 호출 후 보정 - 실제 usage가 있으면 사용, 없으면 추정치 기록
        let callInputTokens: number | undefined
        let callUsageSource: 'provider' | 'estimated' | 'unavailable' = 'unavailable'
        if (modelStep.usage?.inputTokens) {
          totalInputTokens += modelStep.usage.inputTokens
          callInputTokens = modelStep.usage.inputTokens
          callUsageSource = 'provider'
          hasProviderUsage = true
        } else if (modelStep.usage?.source !== 'unavailable') {
          totalInputTokens += estimatedInput
          callInputTokens = estimatedInput
          callUsageSource = 'estimated'
          hasEstimatedUsage = true
        } else {
          totalInputTokens += estimatedInput
          callInputTokens = estimatedInput
          callUsageSource = 'estimated'
          hasEstimatedUsage = true
        }
        let callOutputTokens: number | undefined
        if (modelStep.usage?.outputTokens) {
          totalOutputTokens += modelStep.usage.outputTokens
          callOutputTokens = modelStep.usage.outputTokens
          hasProviderUsage = true
        }

        // 모델 호출 로그
        if (logger) {
          const span = modelSpan()
          await logger.onModelCall({
            runId,
            callIndex: callIndexOffset + modelCalls - 1,
            provider: session.provider,
            model: session.modelId,
            inputTokens: callInputTokens,
            outputTokens: callOutputTokens,
            usageSource: callUsageSource,
            durationMs: modelCallDuration,
            status: 'success',
            persona: input.assistantId,
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
          }).catch(() => {})
        }

        if (modelStep.toolCalls.length === 0) {
          if (modelStep.finishReason === 'length') {
            return buildResult({ status: 'invalid_response', text: modelStep.text || '', errorCode: 'OUTPUT_TRUNCATED', errorMessage: 'Response truncated' })
          }
          return buildResult({ status: 'completed', text: modelStep.text || '' })
        }

        if (isLastCall) {
          return buildResult({ status: 'budget_exceeded', text: modelStep.text || '', errorCode: 'TOOL_CALL_ON_LAST_STEP', errorMessage: 'Tool call on final step' })
        }

        requestedToolCalls += modelStep.toolCalls.length
        const remaining = budget.maxToolCalls - executedToolCalls
        if (remaining <= 0) {
          return buildResult({ status: 'budget_exceeded', errorCode: 'TOOL_BUDGET_EXCEEDED', errorMessage: 'Tool call budget exceeded' })
        }

        const callsToExecute = modelStep.toolCalls.slice(0, remaining)
        const results: ToolResult[] = []

        for (const call of callsToExecute) {
          if (call.parseError) {
            results.push({ callId: call.id, name: call.name, output: { ok: false, errorCode: 'INVALID_ARGUMENTS', message: 'Failed to parse arguments' } })
            continue
          }
          if (!allowedSet.has(call.name)) {
            results.push({ callId: call.id, name: call.name, output: { ok: false, errorCode: 'ACCESS_DENIED', message: 'Tool not allowed' } })
            continue
          }
          const toolDef = toolDefinitions.find(t => t.name === call.name)

          // 쓰기 도구는 Write Guard 필수 (fail-closed)
          if (toolDef?.mode === 'write') {
            if (!input.writeGuard) {
              results.push({ callId: call.id, name: call.name, output: { ok: false, errorCode: 'WRITE_GUARD_MISSING', message: 'Write guard not configured' } })
              continue
            }
            // 승인 조회 (서버에서, 모델 인자 무시)
            let approval: WriteApproval | null = null
            if (input.getWriteApproval) {
              try {
                approval = await input.getWriteApproval(call.name, call.args)
              } catch {
                approval = null
              }
            }
            const check = await input.writeGuard.checkBeforeExecute(call, ctx, approval)
            if (!check.allowed) {
              // 이미 성공한 경우 기존 결과 반환
              if (check.errorCode === 'ALREADY_SUCCEEDED' && approval) {
                const existing = await input.writeGuard.getOperation(ctx.userId, approval.operationId)
                results.push({
                  callId: call.id, name: call.name,
                  output: { ok: true, data: { resultRef: existing?.resultRef, deduplicated: true } }
                })
              } else {
                results.push({ callId: call.id, name: call.name, output: { ok: false, errorCode: check.errorCode, message: check.message } })
              }
              continue
            }
            // Write Guard 통과 → Registry 실행 (실제 쓰기는 도구의 executor에서 원자적으로 처리)
          }

          if (toolDef?.mode === 'read') {
            const cacheKey = `${call.name}:${JSON.stringify(call.args)}:${ctx.userId}`
            if (readCache.has(cacheKey)) {
              results.push({ callId: call.id, name: call.name, output: { ok: true, data: readCache.get(cacheKey) } })
              // 캐시 히트 로그
              if (logger) {
                await logger.onToolCall({
                  runId, toolCallId: call.id, toolName: call.name,
                  mode: toolDef?.mode || 'read', status: 'cached',
                  durationMs: 0, cacheHit: true,
                  traceId: rootTrace.traceId, spanId: newSpanId(), parentSpanId: toolSpanParent(),
                }).catch(() => {})
              }
              continue
            }
          }
          const toolStart = Date.now()
          const result = await registry.execute(call, ctx, env, budget.toolTimeoutMs)
          const toolDuration = Date.now() - toolStart
          executedToolCalls++
          // 도구 실행 로그
          if (logger) {
            await logger.onToolCall({
              runId, toolCallId: call.id, toolName: call.name,
              mode: toolDef?.mode || 'read',
              status: result.output.ok ? 'success' : 'error',
              durationMs: toolDuration,
              errorCode: result.output.ok ? undefined : result.output.errorCode,
              cacheHit: false,
              traceId: rootTrace.traceId, spanId: newSpanId(), parentSpanId: toolSpanParent(),
            }).catch(() => {})
          }
          if (result.output.ok) {
            const toolDef2 = toolDefinitions.find(t => t.name === call.name)
            if (toolDef2?.mode === 'read') {
              const cacheKey = `${call.name}:${JSON.stringify(call.args)}:${ctx.userId}`
              readCache.set(cacheKey, result.output.data)
            }
          }
          results.push(result)
        }

        for (let i = remaining; i < modelStep.toolCalls.length; i++) {
          const call = modelStep.toolCalls[i]
          results.push({ callId: call.id, name: call.name, output: { ok: false, errorCode: 'TOOL_BUDGET_EXCEEDED', message: 'Tool budget exceeded' } })
        }

        session.appendToolResults(results)
      }

      return buildResult({ status: 'budget_exceeded', errorCode: 'MAX_MODEL_CALLS', errorMessage: 'Max model calls reached' })
    } catch (e: any) {
      return buildResult({ status: 'tool_error', errorCode: 'INTERNAL_ERROR', errorMessage: 'Internal runner error' })
    }
  }
}
