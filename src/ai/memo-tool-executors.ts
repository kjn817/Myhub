/**
 * 메모 도구 실행기 — 디스패처에서 분리된 개별 도구 구현.
 * (원문 참조 생성·삭제 확인/승인·UI 액션·성공 후 문맥 갱신)
 */

import {
  executeMemoCreate,
  executeMemoDelete,
  executeMemoGet,
} from '../services/memo-tools'
import { searchAnchor, getLastUserMessage } from './source-preservation'
import type { DispatcherContext, ToolCallRequest, ToolCallResult } from './memo-tool-dispatcher'

/**
 * 텍스트 정규화: 인코딩 문제 방지
 * - 문자열이 아니면 문자열로 변환
 * - 앞뒤 공백 제거
 * - null/undefined 처리
 */
export function normalizeText(text: any): string {
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

/**
 * 성공한 도구 실행 후 문맥 업데이트 (65차)
 */
export async function updateContextAfterSuccess(
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
    } else if (toolName === 'memo_get' || toolName === 'memo_ui_action' || toolName === 'memo_update') {
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
export async function executeMemoCreateFromSource(
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
 * 메모 삭제 — 승인 완료 실행 (D3, 2026-10-31)
 *
 * 승인 게이트를 통과한 삭제(ctx.approvedDelete)만 이 경로로 온다.
 * 승인 자체가 사용자의 확인이므로 확인 단계를 다시 밟지 않고 실제
 * 삭제까지 완주한다. 차단은 기존 실행층 검사를 그대로 유지한다:
 * - 접근 검사(executeMemoGet → getAccessibleMemo): 잠긴 메모와
 *   민감도 2 이상 메모는 "찾을 수 없음"으로 차단 (FC 확인 단계와 동일).
 * - 삭제 실행(executeMemoDelete): 잠긴 메모를 다시 한 번 거부.
 */
export async function executeMemoDeleteApproved(
  env: any,
  memoId: number
): Promise<{ success: boolean; data?: any; error?: string }> {
  if (typeof memoId !== 'number') {
    return { success: false, error: 'Memo ID must be a number' }
  }
  const getResult = await executeMemoGet(env, memoId)
  if (!getResult.success) {
    return getResult
  }
  const delResult = await executeMemoDelete(env, memoId)
  if (!delResult.success) {
    return delResult
  }
  return { success: true, data: { id: memoId, deleted: true, status: 'deleted' } }
}

/**
 * 메모 삭제 확인 (70차)
 *
 * 실제 삭제하지 않고 확인 요청을 반환합니다.
 * 사용자가 명시적으로 "삭제해", "응" 등으로 확인하면
 * 별도 도구 호출로 실제 삭제를 수행합니다.
 *
 * D3 정렬 (2026-10-31): FC 경로의 확인은 승인 게이트(fc-approval-gate)가
 * 담당하고, 승인 실행은 executeMemoDeleteApproved가 완주한다. 이 확인
 * 단계는 게이트를 거치지 않는 직접 호출자의 기본값으로 남는다.
 */
export async function executeMemoDeleteConfirm(
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
export async function executeMemoUiAction(
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
