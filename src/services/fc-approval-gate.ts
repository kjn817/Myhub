/**
 * E2(에코 FC) 쓰기 승인 게이트 — D1 정렬 (2026-10-31, 사용자 결정 A안)
 *
 * 배경: docs/gate-policy-equivalence-20261030.md 불일치 D1 — E1(마커)은
 * 쓰기 전부 승인(ask)이 기본인데 E2(운영 FC)는 대화형 출처이기만 하면
 * 승인 없이 즉시 실행됐다. 이 모듈이 FC 루프(ai.ts)의 디스패치 직전에
 * E1과 같은 승인 왕복을 건다.
 *
 * 재사용 (새로 만들지 않음 — E1과 같은 형태):
 * - 대기 요청 저장소·승인 문안·도구 설명·세션 허용·executed_at 선점은
 *   전부 approval-flow.ts / tool-approval.ts의 기존 구현을 쓴다.
 * - 대기 요청의 marker_text 컬럼에는 FC 페이로드를 인코딩해 저장한다
 *   (아래 encodeFCPayload). routes.ts의 승인 응답 가로채기가 이
 *   페이로드를 알아보고 마커 대신 FC 디스패처로 실행한다.
 *
 * decideToolExecution을 통째로 쓰지 않는 이유 (의도된 차이):
 * - decide는 E1 마커 허용 목록(getLegacyMarkerTools)을 강제하는데,
 *   keeper의 FC 도구에는 마커 목록에 없는 schedule_create(의도된 확장,
 *   D5-보충)와 이름이 다른 cron_set_enabled(CRON_TOGGLE 대응)가 있다.
 *   허용 목록 강제를 그대로 가져오면 이 도구들이 영구 deny가 된다.
 * - 그래서 위험 분류(classifyToolRisk)·범위 키(approvalScopeKey)·
 *   세션 허용 저장소라는 원자 단위만 공유한다. 비서별 허용 목록 강제는
 *   트랙 3(2026-10-31, D5 해소)에서 디스패처 공통 계층
 *   (fc-tool-policy.ts의 checkFCDispatchPolicy, 스킬 레지스트리 기준)이
 *   담당한다 — 승인 실행도 persona를 디스패처에 전달해 같은 강제를 받는다.
 * - 출처 게이트는 공통 계층(디스패처)이 최종 강제 지점이며, 이 모듈도
 *   origin !== 'interactive'면 게이트 단계에서 deny로 fail-closed 한다.
 */

import {
  ToolApprovalStore,
  approvalScopeKey,
  classifyToolRisk,
  isLockTool,
} from './tool-approval'
import {
  ToolApprovalRequestStore,
  buildApprovalRequestText,
  describeMaskedToolAction,
  APPROVAL_TIMEOUT_MS,
  type ApprovalCryptoEnv,
  type ApprovalRequestSummary,
  type PendingApprovalRequest,
} from './approval-flow'
import { dispatchToolCall, type DispatcherContext } from '../ai/memo-tool-dispatcher'
import type { ExecutionOrigin } from '../ai/types'

/**
 * FC 도구명 ↔ 승인 도구명 표와 판정 함수들은 트랙 3(2026-10-31)에서
 * 공통 계층 fc-tool-policy.ts로 승격됐다 (디스패처·루프·게이트가 같은
 * 표를 쓴다). 기존 import 경로(fc-approval-gate) 호환을 위해 재노출한다.
 */
export {
  FC_TO_APPROVAL_TOOL,
  FC_APPROVAL_GATED_TOOLS,
  fcApprovalToolFor,
  isFCApprovalGated,
} from './fc-tool-policy'
import { fcApprovalToolFor } from './fc-tool-policy'

// ---------------------------------------------------------------------------
// FC 페이로드 인코딩 — tool_approval_requests.marker_text에 저장되는 형태
// ---------------------------------------------------------------------------

export interface FCPayload {
  v: 1
  kind: 'fc'
  /** FC 도구명 (소문자, 예: 'memo_create') */
  name: string
  /** 도구 인자 (모델이 낸 원본 그대로) */
  arguments: Record<string, unknown>
  /**
   * 원본 사용자 메시지 (memo_create_from_source의 앵커 검증용).
   * 승인 실행은 다음 턴("승인해")에서 일어나므로, 원본 턴의 사용자
   * 메시지가 없으면 디스패처가 source_text를 원본에서 찾을 수 없다.
   * 받아쓰기 도구일 때만 채운다.
   */
  sourceUserText?: string
}

const FC_PAYLOAD_PREFIX = 'FC:'

export function encodeFCPayload(payload: FCPayload): string {
  return FC_PAYLOAD_PREFIX + JSON.stringify(payload)
}

export function isFCPayload(markerText: unknown): boolean {
  return typeof markerText === 'string' && markerText.startsWith(FC_PAYLOAD_PREFIX)
}

export function decodeFCPayload(markerText: unknown): FCPayload | null {
  if (!isFCPayload(markerText)) return null
  try {
    const parsed = JSON.parse(String(markerText).slice(FC_PAYLOAD_PREFIX.length))
    if (!parsed || parsed.kind !== 'fc' || typeof parsed.name !== 'string') return null
    if (!parsed.arguments || typeof parsed.arguments !== 'object') return null
    return parsed as FCPayload
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 게이트 판정
// ---------------------------------------------------------------------------

export type FCGateOutcome =
  | { action: 'allow'; approvalTool: string }
  | { action: 'deny'; approvalTool: string; error: string }
  | {
      action: 'ask'
      approvalTool: string
      request: ApprovalRequestSummary
      approvalText: string
    }
  | {
      /** 대화 ID가 없어 대기 요청을 만들 수 없음 — 실행하지 않는다 (E1과 동일) */
      action: 'blocked'
      approvalTool: string
      error: 'approval_required'
    }

export interface FCGateInput {
  /** DB (env.DB). 없으면 대기 요청을 만들 수 없어 blocked가 된다. */
  db: D1Database | null | undefined
  /** 레거시 비서 ID (FC는 keeper 전용 — 호출자가 policy.personaId를 넘긴다) */
  personaId: string
  /** 숫자 대화 ID. null/'default' 등 숫자가 아니면 pending을 만들 수 없다. */
  conversationId: number | null
  /** FC 도구명 (소문자) */
  toolName: string
  /** 도구 인자 */
  args: Record<string, unknown> | unknown
  /** 사용자 원 요청 문장 (승인 문안의 근거 + user_request 기록용) */
  userRequest: string
  /** 원본 사용자 메시지 (memo_create_from_source 페이로드 보존용) */
  sourceUserText?: string
  origin?: ExecutionOrigin
  now?: Date
  cryptoEnv?: ApprovalCryptoEnv
}

/** 설명용 인자 정규화 — describeToolAction이 아는 필드명으로 맞춘다 */
function descriptionArgs(fcToolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (fcToolName === 'memo_create_from_source') {
    // 본문 필드가 source_text라 MEMO_CREATE 설명의 미리보기가 비지 않게 한다
    return { text: typeof args.source_text === 'string' ? args.source_text : '', title: args.title }
  }
  return args
}

/**
 * FC 쓰기 호출 1건에 대한 승인 게이트 판정.
 * - 읽기·UI 도구는 게이트 대상이 아니므로 호출자가 isFCApprovalGated로
 *   먼저 거르는 것이 원칙이지만, 대상이 아니면 allow를 돌려준다.
 * - allow가 아닌 모든 결과는 "실행하지 않음"을 뜻한다.
 */
export async function gateFCToolCall(input: FCGateInput): Promise<FCGateOutcome> {
  const approvalTool = fcApprovalToolFor(input.toolName)
  if (!approvalTool) return { action: 'allow', approvalTool: '' }
  const args =
    input.args !== null && typeof input.args === 'object'
      ? (input.args as Record<string, unknown>)
      : {}

  // 잠금/해제 도구는 승인으로도 못 뚫는다 (E1·정책 가드와 동일 원칙).
  // 게이트 대상 표에 잠금 도구는 없지만, 이름 판정은 방어적으로 유지한다.
  if (isLockTool(approvalTool) || isLockTool(input.toolName)) {
    return { action: 'deny', approvalTool, error: 'lock_forbidden' }
  }
  // 위험 분류표에 없는 이름이면 deny-by-default (표 확장 누락 방지)
  const risk = classifyToolRisk(approvalTool)
  if (risk !== 'write' && risk !== 'destructive') {
    return { action: 'deny', approvalTool, error: 'tool_unclassified' }
  }
  // 출처 게이트 (③-A): 비대화형은 승인 절차가 아니라 전면 deny.
  // 공통 계층(디스패처 게이트·루프 사전 거부)과 같은 판정의 게이트 단계 방어다.
  if (input.origin !== 'interactive') {
    return { action: 'deny', approvalTool, error: 'non_interactive_origin' }
  }

  const conversationId = input.conversationId
  if (!input.db || conversationId === null || !Number.isInteger(conversationId) || conversationId <= 0) {
    return { action: 'blocked', approvalTool, error: 'approval_required' }
  }
  const now = input.now ?? new Date()
  const db = input.db
  const scopeKey = approvalScopeKey(approvalTool, args)

  // "이 세션 허용"이 있으면 재승인 없이 실행 (E1과 같은 저장소·같은 키)
  try {
    const session = await new ToolApprovalStore(db).findSessionAllowance(
      input.personaId,
      approvalTool,
      conversationId,
      now,
    )
    if (session) return { action: 'allow', approvalTool }
  } catch {
    // 세션 확인 실패는 ask로 진행한다 (실행은 하지 않음 — E1과 동일)
  }

  const requestStore = new ToolApprovalRequestStore(db, input.cryptoEnv)
  try {
    const existing = await requestStore.findPendingByScope(conversationId, scopeKey, now)
    if (existing) {
      return {
        action: 'ask',
        approvalTool,
        request: existing,
        approvalText: buildApprovalRequestText(existing),
      }
    }
    const desc = describeMaskedToolAction(approvalTool, descriptionArgs(input.toolName, args))
    const payload: FCPayload = {
      v: 1,
      kind: 'fc',
      name: input.toolName,
      arguments: args,
      ...(input.toolName === 'memo_create_from_source' && input.sourceUserText
        ? { sourceUserText: input.sourceUserText.slice(0, 8000) }
        : {}),
    }
    const pending = await requestStore.createPending({
      personaId: input.personaId,
      conversationId,
      tool: approvalTool,
      scopeKey,
      markerText: encodeFCPayload(payload),
      summary: desc.summary,
      userRequest: String(input.userRequest || '').slice(0, 200),
      reversible: desc.reversible,
      impact: desc.impact,
      expiresAt: new Date(now.getTime() + APPROVAL_TIMEOUT_MS).toISOString(),
      createdAt: now.toISOString(),
    })
    return {
      action: 'ask',
      approvalTool,
      request: pending,
      approvalText: buildApprovalRequestText(pending),
    }
  } catch {
    // 대기 요청을 만들지 못하면 실행하지 않는다 (fail-closed — E1과 동일)
    return { action: 'blocked', approvalTool, error: 'approval_required' }
  }
}

// ---------------------------------------------------------------------------
// 승인된 FC 페이로드 실행 (routes.ts 승인 가로채기가 호출)
// ---------------------------------------------------------------------------

/**
 * 디스패처 실행 결과를 사용자 안내 문장으로 바꾼다.
 * 문구는 마커 경로의 결정적 확인 문구와 같은 형태를 쓴다
 * (메모 생성 "메모를 생성했어 (id: N).", 일정 "일정 등록했어: <제목>").
 */
export function formatFCExecutionResult(
  fcToolName: string,
  args: Record<string, unknown>,
  result: { success: boolean; data?: any; error?: string },
): string {
  if (!result.success) {
    return `실행에 실패했어: ${result.error || '알 수 없는 오류'}`
  }
  const data = result.data ?? {}
  switch (fcToolName) {
    case 'memo_create':
    case 'memo_create_from_source': {
      const id = data.id ?? data.memoId
      return Number.isInteger(id) ? `메모를 생성했어 (id: ${id}).` : '메모를 생성했어.'
    }
    case 'memo_delete': {
      const id = args.id ?? data.id
      return id !== undefined && id !== null ? `메모 ${id}를 삭제했어.` : '메모를 삭제했어.'
    }
    case 'schedule_create':
      return `일정 등록했어: ${String(args.title ?? data.title ?? '')}`.trim()
    case 'cron_create':
      return data.description
        ? `자동화를 저장했어: ${data.description}`
        : '자동화를 저장했어.'
    case 'cron_set_enabled':
      return `자동화 #${data.id ?? args.id}를 ${data.enabled ? '켰어' : '껐어'}.`
    case 'cron_delete':
      return `자동화 #${data.id ?? args.id}를 삭제했어.`
    default:
      return '요청한 작업을 실행했어.'
  }
}

/**
 * 승인된 FC 요청 1건을 디스패처로 실행하고 안내 문장을 돌려준다.
 * - executed_at 선점(executeApprovedRequestOnce)은 호출자(routes.ts)가
 *   이 함수를 executor로 감싸 수행한다 — 여기서는 실행만 담당한다.
 * - memo_delete는 approvedDelete 플래그로 확인 단계를 건너뛰고 실제
 *   삭제까지 완주한다 (D3). 승인 자체가 사용자의 확인이다.
 */
export async function executeFCApprovalPayload(
  env: any,
  request: PendingApprovalRequest,
  ctx?: { userId?: string },
): Promise<string> {
  const payload = decodeFCPayload(request.markerText)
  if (!payload) {
    throw new Error('승인된 FC 요청의 내용을 읽을 수 없습니다')
  }
  const dispatchCtx: DispatcherContext = {
    userId: ctx?.userId || 'default',
    conversationId: String(request.conversationId),
    // 트랙 3 (D5): 승인 요청에 기록된 비서를 디스패처 공통 게이트에
    // 그대로 전달한다 — 승인 실행도 비서별 허용 목록 강제를 받는다.
    personaId: request.personaId,
    origin: 'interactive',
    ...(payload.sourceUserText
      ? { originalMessages: [{ role: 'user', content: payload.sourceUserText }] }
      : {}),
    ...(payload.name === 'memo_delete' ? { approvedDelete: true } : {}),
  }
  const result = await dispatchToolCall(
    env,
    { name: payload.name, arguments: payload.arguments },
    dispatchCtx,
  )
  return formatFCExecutionResult(payload.name, payload.arguments, result)
}
