/**
 * 메모 Function Calling Tool Dispatcher
 *
 * 2026-10-13 P0: 에코 메모 도구 구조 전환
 * - 모델의 tool_calls를 검증하고 실행
 * - 기존 memo-tools.ts의 비즈니스 로직 재사용
 * - 인증·권한·잠금 검사를 서버에서 수행 (모델이 결정하지 않음)
 */

import { validateFCArgs } from './memo-fc-tools'
import { validateCronFCArgs } from './cron-fc-tools'
import { validateScheduleFCArgs } from './schedule-fc-tools'
import { executeScheduleCreate } from '../services/schedule-tools'
import { assertToolCallAllowed, PolicyViolationError } from '../services/policy-guard'
import {
  executeMemoCreate,
  executeMemoUpdate,
  executeMemoSearch,
  executeMemoGet,
} from '../services/memo-tools'
import { dispatchCronToolCall } from '../services/cron-tools'
import {
  checkFCDispatchPolicy,
  FC_TOOL_NAMES,
} from '../services/fc-tool-policy'
import { recordToolExecution, newLedgerRunId } from '../services/tool-ledger'
import {
  normalizeText,
  updateContextAfterSuccess,
  executeMemoCreateFromSource,
  executeMemoDeleteApproved,
  executeMemoDeleteConfirm,
  executeMemoUiAction,
} from './memo-tool-executors'


export interface ToolCallRequest {
  name: string
  arguments: any
}

export interface ToolCallResult {
  success: boolean
  toolName: string
  data?: any
  error?: string
  /** 도구 실행 원장(ai_tool_runs) 기록 ID — 기록 실패 시 null */
  ledgerId?: number | null
  /** 원장에 실제로 기록됐는지 */
  ledgerRecorded?: boolean
}

/**
 * 디스패처 컨텍스트 (원문 참조용)
 */
export interface DispatcherContext {
  /** 원본 사용자 메시지들 (원문 보존용) */
  originalMessages?: Array<{ role: string; content: string }>
  /** 사용자 ID (문맥 저장용, 65차) */
  userId?: string
  /** 대화 ID (문맥 저장용, 65차) */
  conversationId?: string
  /**
   * 실행 비서 (트랙 3, D5) — 디스패처 공통 게이트가 스킬 레지스트리
   * 기준 비서별 허용 목록을 이 값으로 강제한다. 운영 호출자(ai.ts FC
   * 루프·승인 실행)는 전원 명시한다. 미지정 시의 기본값·근거는
   * fc-tool-policy.ts의 checkFCDispatchPolicy 주석 참조 (keeper).
   */
  personaId?: string
  /**
   * 실행 출처 (Talorys ③-A) — 트랙 3(D4)부터 디스패처 공통 게이트가
   * 강제한다: 쓰기·파괴적 도구는 'interactive'가 아니면(미지정 포함)
   * 실행 전에 deny된다. ai.ts FC 루프의 사전 거부와 판정 함수를
   * 공유하므로, 어떤 경로로 들어와도 결론이 같다.
   */
  origin?: import('./types').ExecutionOrigin
  /**
   * 승인 완료된 삭제인가 (D3, 2026-10-31).
   * - false/미지정: memo_delete는 확인 요청(confirmation_required)까지만
   *   반환한다 (기존 70차 동작 — 직접 호출자의 안전 기본값).
   * - true: 사용자가 승인 게이트(fc-approval-gate)를 통과해 승인했고
   *   executed_at 선점까지 끝난 실행이다. 확인 단계를 건너뛰고 실제
   *   삭제까지 완주한다. 이 플래그를 세울 수 있는 코드는 승인 실행
   *   경로(executeFCApprovalPayload)뿐이어야 한다.
   */
  approvedDelete?: boolean
  /** 추적 ID (67차: 디버깅용) */
  traceId?: string
  /** 도구 실행 원장의 실행(run) ID — 미지정 시 디스패처가 발급 */
  runId?: string
  /** 요청 ID (원장 기록용) */
  requestId?: string
  /** 실행 Provider (원장 기록용) */
  provider?: string
  /** 실행 모델 (원장 기록용) */
  model?: string
  /** 테스트용 기준 시각 주입 (일정 과거 거부 판정용) */
  nowMs?: number
}

/**
 * 단일 도구 호출 실행
 *
 * @param env Worker 환경 (DB, AI 바인딩 등)
 * @param call 모델이 요청한 도구 호출
 * @param ctx 디스패처 컨텍스트 (원문 참조용)
 * @returns 실행 결과
 */
export async function dispatchToolCall(
  env: any,
  call: ToolCallRequest,
  ctx?: DispatcherContext
): Promise<ToolCallResult> {
  const startedAt = Date.now()
  const result = await dispatchToolCallInner(env, call, ctx)
  const ledger = await recordToolExecution(env?.DB, {
    runId: ctx?.runId || newLedgerRunId(),
    requestId: ctx?.requestId,
    userId: ctx?.userId || 'default',
    personaId: ctx?.personaId,
    provider: ctx?.provider,
    model: ctx?.model,
    toolName: call.name,
    success: result.success,
    durationMs: Date.now() - startedAt,
    error: result.error,
    args: call.arguments,
    resultData: result.data,
  })
  return { ...result, ledgerId: ledger.ledgerId, ledgerRecorded: ledger.recorded }
}

async function dispatchToolCallInner(
  env: any,
  call: ToolCallRequest,
  ctx?: DispatcherContext
): Promise<ToolCallResult> {
  const { name, arguments: args } = call
  const traceId = ctx?.traceId || 'no-trace'

  // 67차: 인자 타입 로깅 (디버깅용)
  const argTypes: Record<string, string> = {}
  if (args && typeof args === 'object') {
    for (const [k, v] of Object.entries(args)) {
      argTypes[k] = typeof v
    }
  }

  // 0. 정책 가드 (트랙 5): 잠금/해제 도구·잠금 필드는 코드로 거부
  // 프롬프트가 허용해도, 모델이 호출해도 여기서 차단된다 (allowlist 검사보다 먼저).
  try {
    assertToolCallAllowed(name, args)
  } catch (e) {
    if (e instanceof PolicyViolationError) {
      console.log(`[${traceId}] DISPATCH_REJECTED tool=${name} reason=policy_violation code=${e.code} argTypes=${JSON.stringify(argTypes)}`)
      return {
        success: false,
        toolName: name,
        error: e.message,
      }
    }
    throw e
  }

  // 1. 도구 이름 검증 (69차: 6개 메모 도구 + 2026-10-26: 4개 자동화 도구
  //    + 일정 등록 1개 = 11종. 목록은 공통 정책 계층(fc-tool-policy)의
  //    FC_TOOL_NAMES가 단일 원천이다 — 여기서 이름을 다시 적지 않는다)
  if (!FC_TOOL_NAMES.includes(name)) {
    console.log(`[${traceId}] DISPATCH_REJECTED tool=${name} reason=unknown_tool argTypes=${JSON.stringify(argTypes)}`)
    return {
      success: false,
      toolName: name,
      error: `Unknown tool: ${name}`,
    }
  }

  // 2. 인자 스키마 검증 (cron·일정 도구는 전용 검증기 사용)
  const validation = name.startsWith('cron_')
    ? validateCronFCArgs(name, args)
    : name.startsWith('schedule_')
      ? validateScheduleFCArgs(name, args)
      : validateFCArgs(name, args)
  if (!validation.valid) {
    console.log(`[${traceId}] DISPATCH_REJECTED tool=${name} reason=validation_failed error=${validation.error} argTypes=${JSON.stringify(argTypes)}`)
    return {
      success: false,
      toolName: name,
      error: validation.error,
    }
  }

  // 2.5. 공통 실행 정책 게이트 (트랙 3, D4·D5) — 실행 계층 진입 전 강제.
  // - D5: 비서별 허용 목록(스킬 레지스트리 기준) 밖 도구는 실행 전에 deny.
  // - D4: 비대화형 origin(미지정 포함)의 쓰기·파괴적 도구는 deny.
  //   판정은 fc-tool-policy.ts 단일 원천이며, ai.ts FC 루프도 같은
  //   함수를 사전 거부에 쓴다 — 강제 지점은 여기(디스패처)다.
  const policy = checkFCDispatchPolicy({
    toolName: name,
    personaId: ctx?.personaId,
    origin: ctx?.origin,
  })
  if (!policy.allowed) {
    console.log(`[${traceId}] DISPATCH_REJECTED tool=${name} reason=${policy.reason} argTypes=${JSON.stringify(argTypes)}`)
    return {
      success: false,
      toolName: name,
      error: policy.reason,
    }
  }

  console.log(`[${traceId}] DISPATCH_STARTED tool=${name} argTypes=${JSON.stringify(argTypes)}`)

  // 3. 도구 실행 (기존 비즈니스 로직 재사용)
  // 인증은 env의 세션을 통해 기존 함수들이 처리함
  //
  // 61차 출처별 실행 정책:
  // - memo_create_from_source: 사용자의 원본 텍스트를 그대로 저장 (직접 받아쓰기)
  //   → 서버가 원본에서 추출하므로 모델의 한글 생성 오류가 저장에 영향을 주지 않음
  // - memo_create: AI가 생성한 텍스트 저장 (요약·재작성 등)
  //   → 모델이 새 문장을 만드는 경우에만 사용
  // 모델은 프롬프트의 안내에 따라 적절한 도구를 선택함
  try {
    let result: any

    // 자동화(cron) 도구 — services/cron-tools.ts의 전용 실행기로 위임
    if (name.startsWith('cron_')) {
      result = await dispatchCronToolCall(env, name, args)
      if (!result) {
        return { success: false, toolName: name, error: `Unknown tool: ${name}` }
      }
    } else if (name === 'schedule_create') {
      // 단일 일정 등록 — 마커 경로와 같은 실행기(services/schedule-tools.ts)를
      // 재사용한다 (중복 체크·할일 연동 로직 공유).
      // AI 도구 경로는 과거 start_at을 거부한다 (신규 일정의 과거 등록은
      // 어떤 경우에도 오답 — 모델이 오류를 보고 재시도할 수 있다).
      result = await executeScheduleCreate(env, args, { rejectPast: true, nowMs: ctx?.nowMs })
    } else {
    switch (name) {
      case 'memo_create':
        result = await executeMemoCreate(env, normalizeText(args.text))
        break

      case 'memo_create_from_source':
        result = await executeMemoCreateFromSource(env, args, ctx)
        break

      case 'memo_search': {
        const query = normalizeText(args.query)
        // 81차: Memo Target Resolver 사용 (GPT 80차 자문)
        // "방금 만든" 등의 상대 참조를 서버에서 확정적 ID로 변환
        const isRelativeRef = query.includes('방금') || query.includes('그 메모') ||
                              query.includes('이 메모') || query.includes('최근')
        if (isRelativeRef) {
          try {
            const { resolveMemoTarget } = await import('../services/memo-target-resolver')
            const resolved = await resolveMemoTarget(
              env,
              { kind: 'last_target' },
              {
                userId: ctx?.userId || 'default',
                conversationId: ctx?.conversationId || 'default',
              }
            )
            if (resolved.ok && resolved.memoId) {
              result = await executeMemoGet(env, resolved.memoId)
              break
            }
          } catch { /* 폴백: 일반 검색 */ }
        }
        result = await executeMemoSearch(env, query)
        break
      }

      case 'memo_get':
        result = await executeMemoGet(env, args.id)
        break

      case 'memo_update':
        result = await executeMemoUpdate(env, args.id, normalizeText(args.text))
        break

      case 'memo_delete':
        // 70차: 삭제는 확인 절차 필요. 실제 삭제하지 않고 확인 요청 반환.
        // D3 정렬 (2026-10-31): FC 경로는 승인 게이트가 확인을 담당한다 —
        // 게이트를 통과한 승인 실행(ctx.approvedDelete)만 실제 삭제까지
        // 완주하고, 그 외 직접 호출은 기존대로 확인 단계에서 멈춘다.
        result = ctx?.approvedDelete
          ? await executeMemoDeleteApproved(env, args.id)
          : await executeMemoDeleteConfirm(env, args.id)
        break

      case 'memo_ui_action':
        result = await executeMemoUiAction(env, args, ctx)
        break
    }
    }

    // 5. 실행 결과 검증
    if (!result || typeof result.success !== 'boolean') {
      return {
        success: false,
        toolName: name,
        error: 'Invalid tool result format',
      }
    }

    return {
      success: result.success,
      toolName: name,
      data: result.data,
      error: result.error,
    }
  } catch (e: any) {
    return {
      success: false,
      toolName: name,
      error: `Execution failed: ${String(e?.message || e)}`,
    }
  }
}

/**
 * 여러 도구 호출 순차 실행
 */
export async function dispatchToolCalls(
  env: any,
  calls: ToolCallRequest[],
  ctx?: DispatcherContext
): Promise<ToolCallResult[]> {
  const results: ToolCallResult[] = []

  // 안전을 위해 순차 실행 (병렬 실행 시 race condition 방지)
  // 턴당 최대 3개로 제한
  const limited = calls.slice(0, 3)

  for (const call of limited) {
    const result = await dispatchToolCall(env, call, ctx)
    results.push(result)

    // 65차: 성공한 도구 실행 후 문맥 업데이트
    if (result.success && ctx?.userId && ctx?.conversationId) {
      await updateContextAfterSuccess(env, ctx.userId, ctx.conversationId, call, result)
    }

    // 실패 시 중단 (후속 도구가 실패한 결과에 의존할 수 있음)
    if (!result.success) {
      break
    }
  }

  return results
}






