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
  executeMemoDelete,
  executeMemoSearch,
  executeMemoGet,
} from '../services/memo-tools'
import { dispatchCronToolCall } from '../services/cron-tools'
import { searchAnchor, getLastUserMessage } from './source-preservation'
import { getMemoContext } from '../services/memo-context'

/**
 * 텍스트 정규화: 인코딩 문제 방지
 * - 문자열이 아니면 문자열로 변환
 * - 앞뒤 공백 제거
 * - null/undefined 처리
 */
function normalizeText(text: any): string {
  if (text == null) return ''
  if (typeof text !== 'string') {
    text = String(text)
  }
  // NFC 정규화 (한글 자모 분리 방지)
  try {
    return text.normalize('NFC').trim()
  } catch {
    return text.trim()
  }
}

export interface ToolCallRequest {
  name: string
  arguments: any
}

export interface ToolCallResult {
  success: boolean
  toolName: string
  data?: any
  error?: string
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
   * 실행 출처 (Talorys ③-A) — provenance 기록용. 쓰기 차단은 호출자
   * (aiChat FC 루프)가 디스패치 전에 수행하므로 여기서는 강제하지 않는다.
   */
  origin?: import('./types').ExecutionOrigin
  /** 추적 ID (67차: 디버깅용) */
  traceId?: string
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

  // 1. 도구 이름 검증 (69차: 6개 메모 도구 + 2026-10-26: 4개 자동화 도구)
  const validTools = [
    'memo_create', 'memo_create_from_source', 'memo_search', 'memo_get', 'memo_delete', 'memo_ui_action',
    'cron_create', 'cron_list', 'cron_set_enabled', 'cron_delete',
    'schedule_create',
  ]
  if (!validTools.includes(name)) {
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

      case 'memo_delete':
        // 70차: 삭제는 확인 절차 필요. 실제 삭제하지 않고 확인 요청 반환.
        // 사용자가 "삭제해줘"라고 하면 AI가 확인을 요청하고,
        // 사용자가 "응", "삭제해"라고 하면 그때 실제 삭제.
        // 여기서는 확인 단계로 처리.
        result = await executeMemoDeleteConfirm(env, args.id)
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

/**
 * 성공한 도구 실행 후 문맥 업데이트 (65차)
 */
async function updateContextAfterSuccess(
  env: any,
  userId: string,
  conversationId: string,
  call: ToolCallRequest,
  result: ToolCallResult
): Promise<void> {
  try {
    const { updateMemoContext } = await import('../services/memo-context')

    const toolName = call.name
    const data = result.data as any

    if (toolName === 'memo_create' || toolName === 'memo_create_from_source') {
      const memoId = data?.memoId || data?.id
      if (memoId) {
        await updateMemoContext(env, userId, conversationId, {
          last_created_memo_id: memoId,
          last_target_memo_id: memoId,
        })
      }
    } else if (toolName === 'memo_get' || toolName === 'memo_ui_action') {
      const memoId = data?.memoId || data?.id || call.arguments?.id || call.arguments?.memo_id
      if (memoId) {
        await updateMemoContext(env, userId, conversationId, {
          last_target_memo_id: memoId,
        })
      }
    } else if (toolName === 'memo_search') {
      const ids = data?.memos?.map((m: any) => m.id) || data?.ids || []
      if (ids.length > 0) {
        await updateMemoContext(env, userId, conversationId, {
          last_search_result_ids: ids,
        })
      }
    }
  } catch {
    // 문맥 업데이트 실패는 도구 실행 결과에 영향을 주지 않음
  }
}

/**
 * 원문 참조형 메모 생성 (61차)
 *
 * 모델이 제시한 source_text를 서버가 보존한 원본 사용자 메시지에서 검색하고,
 * 유일하게 매칭될 때만 원본에서 그대로 추출하여 저장합니다.
 * 모델이 생성한 텍스트는 저장되지 않습니다.
 *
 * @param env Worker 환경
 * @param args 도구 인자 { source_text, title? }
 * @param ctx 디스패처 컨텍스트 (원본 메시지 포함)
 */
async function executeMemoCreateFromSource(
  env: any,
  args: any,
  ctx?: DispatcherContext
): Promise<{ success: boolean; data?: any; error?: string }> {
  // 1. 원본 메시지 확인
  if (!ctx?.originalMessages || ctx.originalMessages.length === 0) {
    return {
      success: false,
      error: 'Original messages not available for source reference',
    }
  }

  const lastUserMessage = getLastUserMessage(ctx.originalMessages)
  if (!lastUserMessage) {
    return {
      success: false,
      error: 'No user message found for source reference',
    }
  }

  // 2. 앵커 검색 (서버 원본에서)
  const sourceText = args.source_text
  if (typeof sourceText !== 'string' || !sourceText.trim()) {
    return {
      success: false,
      error: 'source_text must be a non-empty string',
    }
  }

  const searchResult = searchAnchor(lastUserMessage, sourceText)

  // 3. 검색 결과 검증
  if (!searchResult.found) {
    const reasonMap: Record<string, string> = {
      'NOT_FOUND': 'Source text not found in original message. Please ask the user to clarify.',
      'MULTIPLE_MATCHES': 'Source text matches multiple locations. Please ask the user to specify which one.',
      'EMPTY_ANCHOR': 'Source text is empty.',
    }
    return {
      success: false,
      error: reasonMap[searchResult.reason || 'NOT_FOUND'] || 'Source text validation failed',
    }
  }

  // 4. 원본에서 추출한 텍스트로 메모 생성 (모델 출력이 아님!)
  const extractedText = searchResult.extractedText!
  return await executeMemoCreate(env, normalizeText(extractedText))
}

/**
 * 메모 삭제 확인 (70차)
 *
 * 실제 삭제하지 않고 확인 요청을 반환합니다.
 * 사용자가 명시적으로 "삭제해", "응" 등으로 확인하면
 * 별도 도구 호출로 실제 삭제를 수행합니다.
 *
 * 현재는 1단계만 구현: 확인 요청 반환
 * TODO: 2단계 확인 후 실제 삭제하는 memo_delete_confirm 도구 추가
 */
async function executeMemoDeleteConfirm(
  env: any,
  memoId: number
): Promise<{ success: boolean; data?: any; error?: string }> {
  if (typeof memoId !== 'number') {
    return { success: false, error: 'Memo ID must be a number' }
  }

  // 메모 존재·잠금 확인
  const getResult = await executeMemoGet(env, memoId)
  if (!getResult.success) {
    return getResult
  }

  const memo = getResult.data as any
  const preview = String(memo.text || memo.content || '').slice(0, 50)

  return {
    success: true,
    data: {
      memoId,
      requiresConfirmation: true,
      status: 'confirmation_required',
      message: `메모 ID ${memoId}("${preview}...")를 삭제하시겠습니까? "삭제해" 또는 "응"이라고 답하면 삭제됩니다.`,
      uiAction: 'confirm_delete',
    },
  }
}

/**
 * 메모 UI 액션 (69차)
 *
 * 모델이 UI 동작을 제안하고, 서버가 대상 메모를 검증한 뒤,
 * 클라이언트가 실제 액션을 실행합니다.
 *
 * - open: 메모 패널 열기
 * - close: 메모 패널 닫기
 * - start_edit: 편집 모드 진입
 * - start_format: 서식 편집 모드 진입
 */
async function executeMemoUiAction(
  env: any,
  args: any,
  ctx?: DispatcherContext
): Promise<{ success: boolean; data?: any; error?: string }> {
  const action = args.action
  let memoId = args.memo_id

  const allowedActions = ['open', 'close', 'start_edit', 'start_format']
  if (!allowedActions.includes(action)) {
    return {
      success: false,
      error: `Invalid action: ${action}. Allowed: ${allowedActions.join(', ')}`,
    }
  }

  // 81차: Memo Target Resolver 사용 (GPT 80차 자문)
  // memo_id가 없으면 서버에서 확정적 ID 조회
  if (typeof memoId !== 'number' && action !== 'close') {
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
        memoId = resolved.memoId
      }
    } catch { /* 폴백 실패 */ }
  }

  if (typeof memoId !== 'number' && action !== 'close') {
    return {
      success: false,
      error: 'memo_id must be a number (could not resolve from context)',
    }
  }

  // open/start_edit/start_format은 메모 존재·권한 확인 필요
  // close는 메모 ID 없이도 동작 가능하지만, 지정되면 검증
  if (action !== 'close') {
    const getResult = await executeMemoGet(env, memoId)
    if (!getResult.success) {
      return getResult
    }
  }

  // UI 액션 매핑
  const uiActionMap: Record<string, string> = {
    open: 'open_memo',
    close: 'close_memo',
    start_edit: 'start_edit_memo',
    start_format: 'start_format_memo',
  }

  const actionMessages: Record<string, string> = {
    open: '열기 요청이 UI에 전달되었습니다. 실제 표시 여부는 화면에서 확인됩니다.',
    close: '닫기 요청이 UI에 전달되었습니다. 실제 닫기 여부는 화면에서 확인됩니다.',
    start_edit: '편집 모드 요청이 UI에 전달되었습니다.',
    start_format: '서식 편집 모드 요청이 UI에 전달되었습니다.',
  }

  return {
    success: true,
    data: {
      memoId,
      action,
      uiAction: uiActionMap[action],
      status: 'ui_pending',
      message: actionMessages[action],
    },
  }
}

