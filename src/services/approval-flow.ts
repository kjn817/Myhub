/**
 * 채팅 승인 흐름 — 위험 기반 승인 게이트 마감 (진짜 비서 1단계 b트랙)
 *
 * Suna식 위험 기반 승인 + HumanLayer식 승인 요청 형식을 MyHub 채팅에 연결한다.
 *
 * 흐름:
 * 1) 모델이 쓰기/파괴적 도구 마커를 내면 routes.ts의 게이트가 실행을 멈추고
 *    ToolApprovalRequestStore에 대기 요청을 만든다 (tool_approval_requests).
 *    사용자에게는 무엇을 하려는지 + 근거 + 되돌릴 수 있는지 + 영향 범위를 보여준다.
 * 2) 사용자가 "승인해" / "거부해" / "이 세션 허용해"로 답하면 /chat 핸들러가
 *    resolveApprovalReply로 결정을 내리고 tool_approvals에 감사 기록을 남긴다.
 *    승인 시에만 저장된 마커를 재실행한다. 거부 시 실행하지 않는다.
 * 3) 대기 요청은 10분 후 만료된다 (무한 대기 금지 — lazy expiry, 별도 스윕 없음).
 * 4) "이 세션 허용"은 같은 대화(conversation_id)에서 같은 종류의 도구에 대해
 *    재승인을 생략한다. 세션 종료 시 소멸한다 (대화 스코프 + 24시간 만료).
 *
 * 잠금/해제 도구는 이 흐름을 타지 않는다 — decideToolExecution에서 승인 여부와
 * 무관하게 거부되며, 잠긴 메모 삭제는 실행기(executeMemoDelete)도 막는다.
 */

import {
  ToolApprovalStore,
  maskToolArgs,
  type ApprovalRecord,
} from './tool-approval'

/** 승인 대기 타임아웃 — 10분 안에 답이 없으면 요청 만료 */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000
/** 단건 승인 감사 기록의 유효기간 표시 (게이트는 이 기록을 자동 허용 근거로 쓰지 않음) */
export const SINGLE_APPROVAL_TTL_MS = 30 * 60 * 1000

export type ApprovalReplyKind = 'approve' | 'deny' | 'approve_session'

export interface ApprovalRequestSummary {
  id: number
  tool: string
  scopeKey: string
  summary: string
  reversible: boolean
  impact: string
  expiresAt: string
}

export interface PendingApprovalRequest extends ApprovalRequestSummary {
  personaId: string
  conversationId: number
  markerText: string
  userRequest: string
  status: 'pending' | 'approved' | 'denied' | 'expired'
  createdAt: string
  /** 0063: 실행 선점 시각 (null = 아직 실행 선점 안 됨). 실행 성패 판정이 아니다. */
  executedAt?: string | null
  /** 0063: 실행 시도 감사 기록 (결과 요약). 실행 성패 판정 용도가 아니다. */
  executionResult?: string | null
}

export interface CreatePendingInput {
  personaId: string
  conversationId: number
  tool: string
  scopeKey: string
  markerText: string
  summary: string
  userRequest: string
  reversible: boolean
  impact: string
  expiresAt: string
  createdAt: string
}

function rowToPending(row: Record<string, unknown>): PendingApprovalRequest {
  return {
    id: Number(row.id),
    personaId: String(row.personaId ?? ''),
    conversationId: Number(row.conversationId),
    tool: String(row.tool ?? ''),
    scopeKey: String(row.scopeKey ?? ''),
    markerText: String(row.markerText ?? ''),
    summary: String(row.summary ?? ''),
    userRequest: String(row.userRequest ?? ''),
    reversible: row.reversible === 1 || row.reversible === true,
    impact: String(row.impact ?? ''),
    status: row.status as PendingApprovalRequest['status'],
    createdAt: String(row.createdAt ?? ''),
    expiresAt: String(row.expiresAt ?? ''),
    executedAt: row.executedAt == null ? null : String(row.executedAt),
    executionResult: row.executionResult == null ? null : String(row.executionResult),
  }
}

function toSummary(p: PendingApprovalRequest): ApprovalRequestSummary {
  return {
    id: p.id,
    tool: p.tool,
    scopeKey: p.scopeKey,
    summary: p.summary,
    reversible: p.reversible,
    impact: p.impact,
    expiresAt: p.expiresAt,
  }
}

/**
 * 대기 중인 승인 요청 D1 저장소 (마이그레이션 0052 tool_approval_requests).
 * 만료 판정은 JS에서 수행한다 (D1 datetime('now')와 ISO 문자열의
 * 사전식 비교가 어긋나는 것을 피하기 위함 — 0047과 같은 방식).
 */
export class ToolApprovalRequestStore {
  constructor(private db: D1Database) {}

  async createPending(input: CreatePendingInput): Promise<PendingApprovalRequest> {
    const result = await this.db
      .prepare(
        `INSERT INTO tool_approval_requests
           (persona_id, conversation_id, tool, scope_key, marker_text, summary,
            user_request, reversible, impact, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .bind(
        input.personaId,
        input.conversationId,
        input.tool.toUpperCase(),
        input.scopeKey,
        input.markerText,
        input.summary,
        input.userRequest,
        input.reversible ? 1 : 0,
        input.impact,
        input.createdAt,
        input.expiresAt,
      )
      .run()
    const id = (result.meta as { last_row_id?: number } | undefined)?.last_row_id
    if (typeof id !== 'number') throw new Error('approval request insert failed')
    return { ...input, id, tool: input.tool.toUpperCase(), status: 'pending', executedAt: null, executionResult: null }
  }

  private async markExpired(id: number, now: Date): Promise<void> {
    await this.db
      .prepare(
        `UPDATE tool_approval_requests SET status = 'expired', decided_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .bind(now.toISOString(), id)
      .run()
  }

  private async fetchPendingRow(
    whereSql: string,
    args: unknown[],
    now: Date,
  ): Promise<{ request: PendingApprovalRequest | null; expired: boolean }> {
    const row = await this.db
      .prepare(
        `SELECT id, persona_id AS personaId, conversation_id AS conversationId,
                tool, scope_key AS scopeKey, marker_text AS markerText,
                summary, user_request AS userRequest, reversible, impact,
                status, created_at AS createdAt, expires_at AS expiresAt,
                executed_at AS executedAt, execution_result AS executionResult
         FROM tool_approval_requests
         WHERE ${whereSql}
         ORDER BY id DESC LIMIT 1`
      )
      .bind(...(args as never[]))
      .first<Record<string, unknown>>()
    if (!row || typeof row !== 'object') return { request: null, expired: false }
    const request = rowToPending(row)
    if (request.status !== 'pending') return { request: null, expired: false }
    const expires = new Date(request.expiresAt)
    if (Number.isNaN(expires.getTime()) || expires.getTime() <= now.getTime()) {
      await this.markExpired(request.id, now)
      return { request: { ...request, status: 'expired' }, expired: true }
    }
    return { request, expired: false }
  }

  /**
   * 이 대화의 가장 최근 대기 요청 (사용자가 "승인해"라고 하면 이 요청을 푼다).
   * 만료된 요청은 status='expired'로 갱신하고 expired=true와 함께 돌려준다.
   */
  async findNewestPending(
    conversationId: number,
    now: Date = new Date(),
  ): Promise<{ request: PendingApprovalRequest | null; expired: boolean }> {
    return this.fetchPendingRow(`conversation_id = ? AND status = 'pending'`, [conversationId], now)
  }

  /** 같은 범위의 대기 요청 (중복 승인 요청 방지용 — 있으면 재사용) */
  async findPendingByScope(
    conversationId: number,
    scopeKey: string,
    now: Date = new Date(),
  ): Promise<PendingApprovalRequest | null> {
    const { request } = await this.fetchPendingRow(
      `conversation_id = ? AND scope_key = ? AND status = 'pending'`,
      [conversationId, scopeKey],
      now,
    )
    return request
  }

  /** 대기 요청을 결정 상태로 바꾼다 (pending일 때만). */
  async resolveRequest(
    id: number,
    status: 'approved' | 'denied' | 'expired',
    now: Date = new Date(),
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE tool_approval_requests SET status = ?, decided_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .bind(status, now.toISOString(), id)
      .run()
    return ((result.meta as { changes?: number } | undefined)?.changes ?? 0) > 0
  }

  /** id로 요청 1건을 상태 무관하게 조회한다 (실행 선점 결과 안내용). */
  async getRequestById(id: number): Promise<PendingApprovalRequest | null> {
    const row = await this.db
      .prepare(
        `SELECT id, persona_id AS personaId, conversation_id AS conversationId,
                tool, scope_key AS scopeKey, marker_text AS markerText,
                summary, user_request AS userRequest, reversible, impact,
                status, created_at AS createdAt, expires_at AS expiresAt,
                executed_at AS executedAt, execution_result AS executionResult
         FROM tool_approval_requests
         WHERE id = ?`
      )
      .bind(id)
      .first<Record<string, unknown>>()
    if (!row || typeof row !== 'object') return null
    return rowToPending(row)
  }

  /**
   * 승인된 요청의 실행을 원자적으로 선점한다 (0063, Talorys ②-0).
   * changes=1인 호출만 실제로 도구를 실행할 수 있다. 동시 재실행·이중
   * 승인 응답·클라이언트 재전송이 겹쳐도 실행은 최대 1회다.
   */
  async claimExecution(id: number, now: Date = new Date()): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE tool_approval_requests SET executed_at = ?
         WHERE id = ? AND status = 'approved' AND executed_at IS NULL`
      )
      .bind(now.toISOString(), id)
      .run()
    return ((result.meta as { changes?: number } | undefined)?.changes ?? 0) === 1
  }

  /**
   * 실행 시도 감사 기록을 남긴다 (0063).
   * 주의: execution_result는 성공/실패를 판정하는 용도가 아니다 (0052의
   * 설계 의도 유지) — "시도했다 + 결과 요약(생성된 리소스 id·오류 요약)"의
   * 감사 기록이며, 이미 실행된 승인 건을 다시 안내할 때만 읽는다.
   * 실행이 실패해도 executed_at은 절대 되돌리지 않는다: 부작용이 났을 수
   * 있는 실패를 자동 재시도하면 중복 실행이 되기 때문이다. 다시 실행하려면
   * 사용자의 명시적 새 요청으로 새 승인 건을 만드는 것이 복구 경로다.
   */
  async recordExecutionResult(id: number, resultSummary: string): Promise<boolean> {
    const trimmed = String(resultSummary ?? '').slice(0, EXECUTION_RESULT_MAX)
    const result = await this.db
      .prepare(
        `UPDATE tool_approval_requests SET execution_result = ?
         WHERE id = ? AND executed_at IS NOT NULL`
      )
      .bind(trimmed, id)
      .run()
    return ((result.meta as { changes?: number } | undefined)?.changes ?? 0) === 1
  }
}

/** execution_result 감사 기록의 최대 길이 (결과 텍스트 전문이 아니라 요약만 남긴다) */
export const EXECUTION_RESULT_MAX = 500

export interface ApprovedExecutionOutcome {
  /** true면 이 호출이 실행을 선점해 executor를 실제로 돌렸다 */
  claimed: boolean
  /** claimed일 때 executor가 반환한 결과 텍스트 */
  resultText?: string
  /** claimed인데 executor가 던진 경우의 오류 요약 */
  error?: string
  /** 저장된 감사 요약 (already-executed일 때는 기존에 저장된 값) */
  executionResult: string | null
  request: PendingApprovalRequest
}

/**
 * 승인된 요청을 정확히 한 번만 실행한다 (0063, Talorys ②-0).
 *
 * - 실행 직전 claimExecution으로 원자 선점하고, 선점에 성공한 호출만
 *   executor를 실행한다.
 * - 선점에 실패하면 executor를 실행하지 않고, 저장된 execution_result를
 *   함께 돌려줘 호출자가 "이미 실행됨 + 이전 결과"를 안내하게 한다.
 * - executor가 성공하든 실패하든 execution_result에 시도 감사 기록을
 *   남기고, 실패해도 executed_at을 되돌리지 않는다 (자동 재시도 금지).
 * - 감사 기록(recordExecutionResult) 자체의 실패가 실행 결과를 바꾸지는
 *   않는다 — executed_at 선점이 1차 기록이다.
 */
export async function executeApprovedRequestOnce(
  db: D1Database,
  request: PendingApprovalRequest,
  executor: (request: PendingApprovalRequest) => Promise<string>,
  now: Date = new Date(),
): Promise<ApprovedExecutionOutcome> {
  const store = new ToolApprovalRequestStore(db)
  const claimed = await store.claimExecution(request.id, now)
  if (!claimed) {
    let stored: PendingApprovalRequest | null = null
    try {
      stored = await store.getRequestById(request.id)
    } catch {
      stored = null
    }
    return {
      claimed: false,
      executionResult: stored?.executionResult ?? request.executionResult ?? null,
      request: stored ?? request,
    }
  }
  const record = async (summary: string): Promise<void> => {
    try {
      await store.recordExecutionResult(request.id, summary)
    } catch (e) {
      console.error('[approval] execution result record failed:', (e as Error)?.message || e)
    }
  }
  try {
    const resultText = await executor(request)
    const summary = String(resultText ?? '').replace(/\s+/g, ' ').trim().slice(0, EXECUTION_RESULT_MAX)
    await record(summary || '실행됨 (결과 텍스트 없음)')
    return { claimed: true, resultText, executionResult: summary || null, request }
  } catch (e) {
    const error = String((e as Error)?.message || e).slice(0, 200)
    await record(`실행 시도 실패: ${error}`)
    return { claimed: true, error, executionResult: `실행 시도 실패: ${error}`, request }
  }
}

// ---------------------------------------------------------------------------
// 도구 설명 — 무엇을 하려는지 + 되돌릴 수 있는지 + 영향 범위
// ---------------------------------------------------------------------------

export interface ToolActionDescription {
  summary: string
  reversible: boolean
  impact: string
}

function targetId(args: Record<string, unknown>): string | null {
  for (const key of ['id', 'memoId', 'scheduleId', 'todoId', 'artifactId']) {
    const v = args[key]
    if (typeof v === 'number' && Number.isInteger(v)) return String(v)
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function textOf(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/**
 * 도구별 한글 설명. 인자는 마스킹된 것만 받는다 (미리보기에 시크릿이 새지 않도록).
 * reversible=false는 "되돌릴 수 없음"을 뜻한다 — 이전 내용을 복원할 방법이 없거나
 * (수정), 영구 삭제이기 때문이다.
 */
export function describeToolAction(tool: string, maskedArgs: unknown): ToolActionDescription {
  const upper = String(tool).toUpperCase()
  const args =
    maskedArgs !== null && typeof maskedArgs === 'object'
      ? (maskedArgs as Record<string, unknown>)
      : {}
  const id = targetId(args)
  const title = textOf(args, ['title'])
  const text = textOf(args, ['text', 'content'])
  const preview = text ? ` "${text.slice(0, 50)}${text.length > 50 ? '…' : ''}"` : ''
  const titlePart = title ? ` "${title.slice(0, 50)}"` : ''

  switch (upper) {
    case 'MEMO_CREATE':
      return { summary: `메모 생성${preview}`, reversible: true, impact: '새 메모 1개가 만들어집니다. 필요 없으면 삭제할 수 있어요.' }
    case 'MEMO_UPDATE':
      return { summary: `메모 #${id ?? '?'} 수정${preview}`, reversible: false, impact: '메모 내용이 바뀝니다. 수정 전 내용은 복원되지 않아요.' }
    case 'MEMO_DELETE':
      return { summary: `메모 #${id ?? '?'} 삭제`, reversible: false, impact: '메모 1개가 영구히 삭제됩니다. 되돌릴 수 없어요.' }
    case 'SCHEDULE_CREATE':
      return { summary: `일정${titlePart} 등록`, reversible: true, impact: '새 일정 1개가 등록됩니다. 필요 없으면 삭제할 수 있어요.' }
    case 'SCHEDULE_UPDATE':
      return { summary: `일정 #${id ?? '?'} 수정`, reversible: false, impact: '일정 내용이 바뀝니다. 수정 전 내용은 복원되지 않아요.' }
    case 'SCHEDULE_DELETE':
      return { summary: `일정${titlePart || (id ? ` #${id}` : '')} 삭제`, reversible: false, impact: '일정 1개가 영구히 삭제됩니다. 되돌릴 수 없어요.' }
    case 'TODO_ADD':
      return { summary: `할 일${titlePart} 추가`, reversible: true, impact: '할 일 1개가 추가됩니다. 필요 없으면 삭제할 수 있어요.' }
    case 'TODO_DONE':
      return { summary: `할 일 #${id ?? '?'} 완료 처리`, reversible: true, impact: '할 일 1개가 완료로 바뀝니다. 다시 미완료로 되돌릴 수 있어요.' }
    case 'TODO_UPDATE':
      return { summary: `할 일 #${id ?? '?'} 수정`, reversible: false, impact: '할 일 내용이 바뀝니다. 수정 전 내용은 복원되지 않아요.' }
    case 'TODO_DELETE':
      return { summary: `할 일 #${id ?? '?'} 삭제`, reversible: false, impact: '할 일 1개가 영구히 삭제됩니다. 되돌릴 수 없어요.' }
    case 'ARTIFACT_CREATE':
      return { summary: `아티팩트${titlePart} 생성`, reversible: true, impact: '아티팩트 1개가 만들어집니다. 필요 없으면 삭제할 수 있어요.' }
    case 'ARTIFACT_DELETE':
      return { summary: `아티팩트 #${id ?? '?'} 삭제`, reversible: false, impact: '아티팩트 1개가 영구히 삭제됩니다. 되돌릴 수 없어요.' }
    case 'ARTIFACT_FROM_GITHUB':
      return { summary: 'GitHub에서 아티팩트 가져오기', reversible: true, impact: '아티팩트 1개가 만들어집니다. 필요 없으면 삭제할 수 있어요.' }
    case 'CRON_CREATE':
      return { summary: `자동화 저장${preview}`, reversible: true, impact: '반복 자동화 1개가 저장됩니다. 필요 없으면 끄거나 삭제할 수 있어요.' }
    case 'CRON_DELETE':
      return { summary: `자동화 #${id ?? '?'} 삭제`, reversible: false, impact: '자동화 1개가 영구히 삭제됩니다. 다시 만들려면 처음부터 저장해야 해요.' }
    case 'CRON_TOGGLE': {
      const enabled = args.enabled
      const verb = enabled === true ? '켜기' : enabled === false ? '끄기' : '켜기/끄기'
      return { summary: `자동화 #${id ?? '?'} ${verb}`, reversible: true, impact: '자동화가 켜지거나 꺼집니다. 언제든 다시 바꿀 수 있어요.' }
    }
    default:
      return { summary: `${upper} 실행`, reversible: false, impact: '이 작업의 영향을 확인하지 못했어요.' }
  }
}

/**
 * 승인 요청 문안 (HumanLayer식: 무엇을 + 근거 + 되돌릴 수 있는지 + 영향 범위).
 * 마커 원문은 노출하지 않는다. 답하는 방법과 만료 시간도 함께 적는다.
 */
export function buildApprovalRequestText(input: {
  summary: string
  userRequest: string
  reversible: boolean
  impact: string
  /** i트랙 dry-run 미리보기 문안 (있으면 문안 뒤에 붙는다) */
  dryRunPreview?: string
}): string {
  const lines = [
    '[승인이 필요해요]',
    `하려는 일: ${input.summary}`,
  ]
  if (input.userRequest) lines.push(`근거: "${input.userRequest}" 요청에 따라`)
  lines.push(
    input.reversible
      ? '되돌릴 수 있나요: 네, 되돌릴 수 있어요'
      : '되돌릴 수 있나요: 아니요, 되돌릴 수 없어요',
    `영향 범위: ${input.impact}`,
  )
  if (input.dryRunPreview) lines.push('', input.dryRunPreview)
  lines.push(
    '',
    '답변으로 "승인해" / "거부해" / "이 세션 허용해"라고 보내주세요.',
    '(10분 안에 답하지 않으면 이 요청은 만료돼요)',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 승인 응답 파싱 — 채팅에서 "승인해" / "거부해" / "이 세션 허용해"
// ---------------------------------------------------------------------------

const APPROVE_EXACT = new Set([
  '승인', '승인해', '승인해줘', '승인합니다',
  '실행해', '실행해줘', '진행해', '진행해줘',
  '응', '어', '좋아', '좋아요', '오케이', 'ok', 'yes', '네', '예', '확인',
])
const DENY_EXACT = new Set([
  '거부', '거부해', '거부해줘',
  '하지마', '하지 마', '안 해', '안해', '취소', '취소해', '취소해줘',
  '중단', '그만', '싫어', '안 돼', '안돼', 'no', '아니', '아니요',
  '하지 말아줘', '하지말아줘', '실행하지마', '실행하지 마',
])
/** 삭제 동사 승인 — 삭제 요청일 때만 승인으로 본다 (다른 도구 승인과 혼동 방지) */
const DELETE_VERB_EXACT = new Set(['삭제해', '삭제해줘', '지워', '지워줘', '지워버려'])
const SESSION_ALLOW_RE = /(세션|대화).*허용|허용.*(세션|대화)|계속\s*허용/

function normalizeReply(text: string): string {
  return text.trim().replace(/[.!?~…\s]+$/u, '').trim().toLowerCase()
}

/**
 * 사용자 메시지가 승인 응답인지 판정한다. 짧은 완전 일치만 인정한다
 * ("승인해 그리고 요약해줘" 같은 긴 문장은 일반 채팅으로 흘려보낸다).
 * pendingTool이 주어지면 삭제 동사는 삭제 도구일 때만 승인으로 본다.
 */
export function parseApprovalReply(text: unknown, pendingTool?: string): ApprovalReplyKind | null {
  if (typeof text !== 'string') return null
  const normalized = normalizeReply(text)
  if (!normalized) return null
  if (SESSION_ALLOW_RE.test(normalized)) return 'approve_session'
  if (APPROVE_EXACT.has(normalized)) return 'approve'
  if (DENY_EXACT.has(normalized)) return 'deny'
  if (DELETE_VERB_EXACT.has(normalized)) {
    const tool = (pendingTool || '').toUpperCase()
    if (tool.endsWith('_DELETE')) return 'approve'
    return null
  }
  return null
}

/**
 * 승인 응답일 "가능성"이 있는 메시지인지 1차 판정한다 (DB 조회 전 필터용).
 * 삭제 동사는 도구 맥락이 있어야 확정되므로, 가능성 단계에서는 포함한다.
 */
export function isPossibleApprovalReply(text: unknown): boolean {
  if (typeof text !== 'string') return false
  const normalized = normalizeReply(text)
  if (!normalized) return false
  if (SESSION_ALLOW_RE.test(normalized)) return true
  return (
    APPROVE_EXACT.has(normalized) ||
    DENY_EXACT.has(normalized) ||
    DELETE_VERB_EXACT.has(normalized)
  )
}

// ---------------------------------------------------------------------------
// 승인 응답 해결 — /chat 핸들러가 모델 호출 전에 부른다
// ---------------------------------------------------------------------------

export type ApprovalResolutionStatus = 'none' | 'approved' | 'approved_session' | 'denied' | 'expired'

export interface ApprovalResolution {
  status: ApprovalResolutionStatus
  request?: PendingApprovalRequest
}

export interface ResolveApprovalReplyInput {
  conversationId: number
  /** 채팅의 비서 (감사 기록은 pending의 비서를 우선 사용하고, 이 값은 폴백) */
  personaId: string
  reply: string
  now?: Date
}

/**
 * 대기 중인 승인 요청에 대한 사용자의 답을 처리한다.
 * - pending이 없거나 승인 응답이 아니면 { status: 'none' } (일반 채팅으로 진행).
 * - 승인/세션 허용/거부는 tool_approvals에 감사 기록을 남긴다
 *   (기록 실패가 승인 실행 자체를 막지는 않는다 — 요청 행의 상태가 1차 감사).
 *   단건 승인은 일회성이다. 채팅 게이트는 저장된 단건 승인을 자동 허용 근거로
 *   쓰지 않으므로, 이 기록의 expires_at은 감사 표시용이다.
 * - 세션 허용은 tool_approvals에 SESSION 스코프 행으로 저장한다.
 */
export async function resolveApprovalReply(
  db: D1Database,
  input: ResolveApprovalReplyInput,
): Promise<ApprovalResolution> {
  const now = input.now ?? new Date()
  const requestStore = new ToolApprovalRequestStore(db)
  const { request, expired } = await requestStore.findNewestPending(input.conversationId, now)
  if (!request) return { status: 'none' }
  if (expired) return { status: 'expired', request }

  const kind = parseApprovalReply(input.reply, request.tool)
  if (!kind) return { status: 'none' }

  // 감사·세션 허용은 요청을 만든 비서 기준으로 기록한다 (승인 답을 보낸
  // 채팅의 비서와 다를 수 있기 때문 — 게이트는 요청 비서로 조회한다).
  const auditPersonaId = request.personaId || input.personaId
  const approvalStore = new ToolApprovalStore(db)
  const audit = async (decision: ApprovalRecord['decision']): Promise<void> => {
    try {
      await approvalStore.recordApproval({
        personaId: auditPersonaId,
        tool: request.tool,
        scopeKey: request.scopeKey,
        decision,
        expiresAt:
          decision === 'approved'
            ? new Date(now.getTime() + SINGLE_APPROVAL_TTL_MS).toISOString()
            : null,
      })
    } catch (e) {
      console.error('[approval] audit record failed:', (e as Error)?.message || e)
    }
  }

  if (kind === 'deny') {
    await requestStore.resolveRequest(request.id, 'denied', now)
    await audit('denied')
    return { status: 'denied', request }
  }

  await requestStore.resolveRequest(request.id, 'approved', now)
  await audit('approved')
  if (kind === 'approve_session') {
    try {
      await approvalStore.recordSessionAllowance(
        auditPersonaId,
        request.tool,
        input.conversationId,
        now,
      )
    } catch (e) {
      console.error('[approval] session allowance failed:', (e as Error)?.message || e)
    }
    return { status: 'approved_session', request }
  }
  return { status: 'approved', request }
}

/** 마스킹된 인자로 도구 설명을 만든다 (게이트에서 호출 — 시크릿 노출 방지) */
export function describeMaskedToolAction(tool: string, args: unknown): ToolActionDescription {
  const { masked } = maskToolArgs(args)
  return describeToolAction(tool, masked)
}

export { toSummary as approvalRequestSummary }
