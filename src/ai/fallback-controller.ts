/**
 * Phase 2B — Fallback 실행 컨트롤러
 *
 * 역할:
 * - 첫 Provider 선택 (ModelRouter 사용)
 * - 실패 유형 확인
 * - Fallback 허용 여부 판단 (ModelRouter.decideFallback)
 * - 대체 Provider 선택 및 새 세션 생성
 * - 전체 요청 예산 관리 (Fallback해도 리셋 금지)
 * - 시도별 결과 및 사용량 기록
 *
 * 핵심 원칙:
 * - 도구 실행 후에는 Fallback 금지
 * - 개인정보 전송 권한은 Fallback으로 우회 불가
 * - 예산은 전체 요청에서 공유
 * - Provider 전용 세션 이력은 이식하지 않음
 */

import type { ProviderId } from '../services/ai'
import { ModelRouter, resolveSensitivity, type SensitivityLevel } from './model-router'
import { AgentRunner } from './runner'
import type { Budget } from './types'
import type { AgentRunInput } from './runner'
import { ToolRegistry } from './tools/registry'
import type { D1RunLogger } from './run-logger'
import type { ExecutionOrigin } from './types'

// ---------------------------------------------------------------------------
// 타입 정의
// ---------------------------------------------------------------------------

/** Fallback 컨트롤러 설정 */
export interface FallbackControllerConfig {
  db: any // D1Database
  env: any
  logger?: D1RunLogger
  router?: ModelRouter
  /** 세션 생성 팩토리 (Provider별 Adapter 생성) */
  createSession: (provider: ProviderId, model: string) => any
  /** 도구 레지스트리 생성 팩토리 */
  createRegistry?: () => ToolRegistry
  /** 시스템 프롬프트 */
  systemPrompt?: string
  /** 허용된 도구 목록 */
  allowedTools?: string[]
  /** 최대 Fallback 횟수 (기본: 1) */
  maxFallbacks?: number
}

/** 실행 요청 */
export interface ExecuteRequest {
  userId: string
  personaId: string
  /**
   * 실행 출처 (Talorys ③-A) — 이 컨트롤러가 만드는 ExecutionContext에
   * 그대로 찍힌다 (FC 실행 컨텍스트의 단일 생성 지점). 미지정이면
   * 쓰기 판정에서 fail-closed로 막힌다.
   */
  origin?: ExecutionOrigin
  messages: Array<{ role: string; content: string }>
  /** 사용 가능한 도구 이름 */
  availableTools: string[]
  /** 대화 이력의 민감도 */
  historySensitivity?: SensitivityLevel
  /** 예산 (없으면 기본값) */
  budget?: Partial<Budget>
  /** 취소 신호 */
  abortSignal?: AbortSignal
}

/** 실행 결과 */
export interface ExecuteResult {
  ok: boolean
  text?: string
  error?: string
  /** 최종 Provider/모델 */
  provider?: ProviderId
  model?: string
  /** Fallback 발생 여부 */
  fallbackOccurred: boolean
  fallbackCount: number
  fallbackReason?: string
  /** 전체 사용량 */
  totalInputTokens: number
  totalOutputTokens: number
  totalModelCalls: number
}

// ---------------------------------------------------------------------------
// Fallback 컨트롤러
// ---------------------------------------------------------------------------

export class FallbackController {
  private db: any
  private env: any
  private logger?: D1RunLogger
  private router: ModelRouter
  private createSession: (provider: ProviderId, model: string) => any
  private createRegistry: () => ToolRegistry
  private systemPrompt?: string
  private allowedTools: string[]
  private maxFallbacks: number

  constructor(config: FallbackControllerConfig) {
    this.db = config.db
    this.env = config.env
    this.logger = config.logger
    this.router = config.router || new ModelRouter()
    this.createSession = config.createSession
    this.createRegistry = config.createRegistry || (() => new ToolRegistry())
    this.systemPrompt = config.systemPrompt
    this.allowedTools = config.allowedTools || []
    this.maxFallbacks = config.maxFallbacks ?? 1
  }

  /**
   * 요청 실행 (Fallback 포함)
   *
   * Phase 2B-L: 하나의 논리적 Run으로 추적
   * - Controller가 최상위 runId 생성 및 onRunStart/onRunFinish 관리
   * - 각 Provider 시도는 동일한 runId 공유 (skipRunLogging)
   * - ai_usage는 시도별로 기록되지만 동일한 run_id로 연결
   */
  async execute(request: ExecuteRequest): Promise<ExecuteResult> {
    const { sensitivity } = resolveSensitivity({
      text: this.getLastUserMessage(request.messages),
      historySensitivity: request.historySensitivity,
      availableTools: request.availableTools,
    })

    // 논리적 Run ID 생성 (전체 요청에서 공유)
    const logicalRunId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const requestId = `req_${Date.now().toString(36)}`
    const startTime = Date.now()

    // 예산 초기화 (전체 요청에서 공유)
    const budget = this.initBudget(request.budget)
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalModelCalls = 0
    let totalRequestedToolCalls = 0
    let totalExecutedToolCalls = 0
    let fallbackCount = 0
    let fallbackReason: string | undefined

    const triedProviders = new Set<ProviderId>()
    let toolsExecuted = false
    let writeUncertain = false

    // 첫 Provider 선택
    let decision = this.router.route({
      text: this.getLastUserMessage(request.messages),
      capability: 'fc-chat',
      sensitivityContext: {
        historySensitivity: request.historySensitivity,
        availableTools: request.availableTools,
      },
    })

    if (!decision) {
      // Run 시작/종료 로그 (실패 시도도 기록)
      await this.logRunStart(logicalRunId, requestId, request, 'none', 'none')
      await this.logRunFinish(logicalRunId, {
        status: 'provider_error',
        modelCalls: 0,
        requestedToolCalls: 0,
        executedToolCalls: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        usageSource: 'unavailable',
        elapsedMs: Date.now() - startTime,
        errorCode: 'NO_PROVIDER',
        initialProvider: 'none',
        initialModel: 'none',
        finalProvider: 'none',
        finalModel: 'none',
        fallbackOccurred: false,
        fallbackCount: 0,
      })
      return {
        ok: false,
        error: 'No suitable provider available',
        fallbackOccurred: false,
        fallbackCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalModelCalls: 0,
      }
    }

    let currentProvider = decision.provider
    let currentModel = decision.model
    const initialProvider = currentProvider
    const initialModel = currentModel

    // 논리적 Run 시작 로그
    await this.logRunStart(logicalRunId, requestId, request, initialProvider, initialModel)

    // callIndex 추적 (전체 Run에서 순차)
    let globalCallIndex = 0

    while (true) {
      // 취소 확인
      if (request.abortSignal?.aborted) {
        await this.logRunFinish(logicalRunId, {
          status: 'cancelled',
          modelCalls: totalModelCalls,
          requestedToolCalls: totalRequestedToolCalls,
          executedToolCalls: totalExecutedToolCalls,
          totalInputTokens,
          totalOutputTokens,
          usageSource: totalInputTokens > 0 ? 'provider' : 'unavailable',
          elapsedMs: Date.now() - startTime,
          errorCode: 'CANCELLED',
          initialProvider,
          initialModel,
          finalProvider: currentProvider,
          finalModel: currentModel,
          fallbackOccurred: fallbackCount > 0,
          fallbackCount,
          fallbackReason,
        })
        return {
          ok: false,
          error: 'Request cancelled',
          provider: currentProvider,
          model: currentModel,
          fallbackOccurred: fallbackCount > 0,
          fallbackCount,
          fallbackReason,
          totalInputTokens,
          totalOutputTokens,
          totalModelCalls,
        }
      }

      triedProviders.add(currentProvider)

      // 새 세션 생성 (Provider 전용 이력은 이식하지 않음)
      const session = this.createSession(currentProvider, currentModel)

      // 사용자 메시지 추가 (각 새 세션마다)
      const lastUserMessage = this.getLastUserMessage(request.messages)
      if (lastUserMessage && typeof session.addUserMessage === 'function') {
        session.addUserMessage(lastUserMessage)
      }

      // Runner 실행 (논리적 runId 공유, Run 로그는 Controller가 관리)
      const runner = new AgentRunner()
      const runInput: AgentRunInput = {
        session,
        registry: this.createRegistry(),
        ctx: {
          userId: request.userId,
          requestId,
          approvedWrites: false,
          origin: request.origin,
          dataSensitivity: sensitivity === 'restricted' ? 'highly_sensitive' : sensitivity,
        },
        env: { DB: this.db },
        budget: this.remainingBudget(budget, totalModelCalls, totalInputTokens),
        allowedTools: this.allowedTools.length > 0 ? this.allowedTools : request.availableTools,
        requestId,
        abortSignal: request.abortSignal,
        logger: this.logger as any,
        assistantId: request.personaId,
        systemPrompt: this.systemPrompt,
        runId: logicalRunId, // 논리적 Run ID 공유
        skipRunLogging: true, // Controller가 관리
        callIndexOffset: totalModelCalls, // 전체 Run에서 순차적 callIndex
      }

      const result = await runner.run(runInput)

      // 사용량 누적
      totalInputTokens += result.totalInputTokens || 0
      totalOutputTokens += result.totalOutputTokens || 0
      totalModelCalls += result.modelCalls || 0
      totalRequestedToolCalls += result.requestedToolCalls || 0
      totalExecutedToolCalls += result.executedToolCalls || 0

      // 도구 실행 여부 추적
      if ((result.executedToolCalls || 0) > 0) {
        toolsExecuted = true
      }

      // 성공 시 논리적 Run 종료 로그 후 반환
      if (result.status === 'completed') {
        await this.logRunFinish(logicalRunId, {
          status: 'completed',
          modelCalls: totalModelCalls,
          requestedToolCalls: totalRequestedToolCalls,
          executedToolCalls: totalExecutedToolCalls,
          totalInputTokens,
          totalOutputTokens,
          usageSource: totalInputTokens > 0 ? 'provider' : 'unavailable',
          elapsedMs: Date.now() - startTime,
          initialProvider,
          initialModel,
          finalProvider: currentProvider,
          finalModel: currentModel,
          fallbackOccurred: fallbackCount > 0,
          fallbackCount,
          fallbackReason,
        })
        return {
          ok: true,
          text: result.text,
          provider: currentProvider,
          model: currentModel,
          fallbackOccurred: fallbackCount > 0,
          fallbackCount,
          fallbackReason,
          totalInputTokens,
          totalOutputTokens,
          totalModelCalls,
        }
      }

      // 실패 시 Fallback 판단
      const fallbackDecision = this.router.decideFallback({
        failedProvider: currentProvider,
        failedModel: currentModel,
        errorCode: result.errorCode || 'UNKNOWN',
        toolsExecuted,
        writeUncertain,
        sensitivity,
        triedProviders: new Set(triedProviders),
        fallbackCount,
      })

      // Fallback 불가 시 논리적 Run 종료 로그 후 종료
      if (!fallbackDecision.allowed || !fallbackDecision.candidate) {
        await this.logRunFinish(logicalRunId, {
          status: 'provider_error',
          modelCalls: totalModelCalls,
          requestedToolCalls: totalRequestedToolCalls,
          executedToolCalls: totalExecutedToolCalls,
          totalInputTokens,
          totalOutputTokens,
          usageSource: totalInputTokens > 0 ? 'provider' : 'unavailable',
          elapsedMs: Date.now() - startTime,
          errorCode: result.errorCode,
          initialProvider,
          initialModel,
          finalProvider: currentProvider,
          finalModel: currentModel,
          fallbackOccurred: fallbackCount > 0,
          fallbackCount,
          fallbackReason: fallbackDecision.reason,
        })
        return {
          ok: false,
          error: result.errorMessage || `Execution failed: ${fallbackDecision.reason}`,
          provider: currentProvider,
          model: currentModel,
          fallbackOccurred: fallbackCount > 0,
          fallbackCount,
          fallbackReason: fallbackDecision.reason,
          totalInputTokens,
          totalOutputTokens,
          totalModelCalls,
        }
      }

      // Fallback 실행
      fallbackCount++
      fallbackReason = fallbackDecision.reason
      currentProvider = fallbackDecision.candidate.provider
      currentModel = fallbackDecision.candidate.model

      // 최대 횟수 초과 방지 (이중 체크)
      if (fallbackCount > this.maxFallbacks) {
        await this.logRunFinish(logicalRunId, {
          status: 'provider_error',
          modelCalls: totalModelCalls,
          requestedToolCalls: totalRequestedToolCalls,
          executedToolCalls: totalExecutedToolCalls,
          totalInputTokens,
          totalOutputTokens,
          usageSource: totalInputTokens > 0 ? 'provider' : 'unavailable',
          elapsedMs: Date.now() - startTime,
          errorCode: 'FALLBACK_LIMIT',
          initialProvider,
          initialModel,
          finalProvider: currentProvider,
          finalModel: currentModel,
          fallbackOccurred: true,
          fallbackCount,
          fallbackReason: 'fallback-limit-exceeded',
        })
        return {
          ok: false,
          error: 'Fallback limit exceeded',
          provider: currentProvider,
          model: currentModel,
          fallbackOccurred: true,
          fallbackCount,
          fallbackReason: 'fallback-limit-exceeded',
          totalInputTokens,
          totalOutputTokens,
          totalModelCalls,
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 내부 헬퍼
  // -------------------------------------------------------------------------

  /**
   * 논리적 Run 시작 로그
   */
  private async logRunStart(
    runId: string,
    requestId: string,
    request: ExecuteRequest,
    provider: string,
    model: string
  ): Promise<void> {
    if (!this.logger) return
    try {
      await (this.logger as any).onRunStart({
        runId,
        requestId,
        userId: request.userId,
        assistantId: request.personaId,
        provider,
        model,
      })
    } catch {
      // 로그 실패는 무시 (업무 결과와 분리)
    }
  }

  /**
   * 논리적 Run 종료 로그 (Fallback 정보 포함)
   */
  private async logRunFinish(
    runId: string,
    event: {
      status: string
      modelCalls: number
      requestedToolCalls: number
      executedToolCalls: number
      totalInputTokens: number
      totalOutputTokens: number
      usageSource: string
      elapsedMs: number
      errorCode?: string
      initialProvider?: string
      initialModel?: string
      finalProvider?: string
      finalModel?: string
      fallbackOccurred?: boolean
      fallbackCount?: number
      fallbackReason?: string
    }
  ): Promise<void> {
    if (!this.logger) return
    try {
      await (this.logger as any).onRunFinish({
        runId,
        status: event.status as any,
        modelCalls: event.modelCalls,
        requestedToolCalls: event.requestedToolCalls,
        executedToolCalls: event.executedToolCalls,
        totalInputTokens: event.totalInputTokens,
        totalOutputTokens: event.totalOutputTokens,
        usageSource: event.usageSource,
        elapsedMs: event.elapsedMs,
        errorCode: event.errorCode,
        initialProvider: event.initialProvider,
        initialModel: event.initialModel,
        finalProvider: event.finalProvider,
        finalModel: event.finalModel,
        fallbackOccurred: event.fallbackOccurred,
        fallbackCount: event.fallbackCount,
        fallbackReason: event.fallbackReason,
      })
    } catch {
      // 로그 실패는 무시 (업무 결과와 분리)
    }
  }

  private getLastUserMessage(messages: Array<{ role: string; content: string }>): string {
    const userMessages = messages.filter((m) => m.role === 'user')
    return userMessages[userMessages.length - 1]?.content || ''
  }

  private initBudget(partial?: Partial<Budget>): Budget {
    return {
      maxModelCalls: partial?.maxModelCalls ?? 3,
      maxToolCalls: partial?.maxToolCalls ?? 4,
      maxTotalInputTokens: partial?.maxTotalInputTokens ?? 8000,
      maxOutputTokensPerCall: partial?.maxOutputTokensPerCall ?? 1024,
      maxToolResultChars: partial?.maxToolResultChars ?? 1500,
      toolTimeoutMs: partial?.toolTimeoutMs ?? 10000,
    }
  }

  /**
   * 남은 예산 계산 (Fallback해도 리셋하지 않음)
   */
  private remainingBudget(budget: Budget, usedCalls: number, usedTokens: number): Budget {
    return {
      maxModelCalls: Math.max(0, budget.maxModelCalls - usedCalls),
      maxToolCalls: budget.maxToolCalls, // 도구 호출은 새 세션에서 리셋 (도구 미실행 시에만 Fallback)
      maxTotalInputTokens: Math.max(0, budget.maxTotalInputTokens - usedTokens),
      maxOutputTokensPerCall: budget.maxOutputTokensPerCall,
      maxToolResultChars: budget.maxToolResultChars,
      toolTimeoutMs: budget.toolTimeoutMs,
    }
  }
}
