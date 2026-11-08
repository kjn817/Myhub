/**
 * 채팅 승인 흐름 — 위험 기반 승인 게이트 마감 (진짜 비서 1단계 b트랙)
 *
 * 흐름: 1) 모델이 쓰기/파괴적 도구 마커를 내면 게이트가 실행을 멈추고
 * ToolApprovalRequestStore에 대기 요청을 만든다. 2) 사용자가 "승인해" /
 * "거부해" / "이 세션 허용해"로 답하면 resolveApprovalReply가 결정을 내리고
 * tool_approvals에 감사 기록을 남기며, 승인 시에만 마커를 재실행한다.
 * 3) 대기 요청은 10분 후 만료된다. 4) "이 세션 허용"은 같은 대화에서 같은
 * 종류의 도구에 대해 재승인을 생략한다 (대화 스코프 + 24시간 만료).
 * 잠금/해제 도구는 이 흐름을 타지 않는다.
 */

import {
  ToolApprovalStore,
  type ApprovalRecord,
} from './tool-approval'
import { isCasualApprovalReply, parseApprovalReply } from './approval-text'
import {
  isEncrypted,
  isStorageEncryptionEnabled,
  protectText,
  revealText,
} from './storage-protection'

export {
  buildApprovalRequestText,
  describeMaskedToolAction,
  describeToolAction,
  isPossibleApprovalReply,
  parseApprovalReply,
  type ApprovalReplyKind,
  type ToolActionDescription,
} from './approval-text'

/** 승인 대기 타임아웃 — 10분 안에 답이 없으면 요청 만료 */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000
/** 단건 승인 감사 기록의 유효기간 표시 (게이트는 이 기록을 자동 허용 근거로 쓰지 않음) */
export const SINGLE_APPROVAL_TTL_MS = 30 * 60 * 1000

export interface ApprovalCryptoEnv {
  MEMO_ENCRYPTION_KEY?: string
}

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
  executedAt?: string | null // 0063: 실행 선점 시각 (실행 성패 판정이 아니다)
  executionResult?: string | null // 0063: 실행 시도 감사 기록 (결과 요약)
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

/** 대기 중인 승인 요청 D1 저장소 (0052). 만료 판정은 JS에서 수행한다. */
export class ToolApprovalRequestStore {
  /**
   * @param cryptoEnv MEMO_ENCRYPTION_KEY를 가진 env (R-14 저장 암호화용).
   *   없으면 암호화 저장/복호를 할 수 없다 — 스위치 ON 상태에서 암호화가
   *   필요한 순간에 명시적으로 실패한다 (평문 폴백 금지, fail-closed).
   *   스위치 OFF(기본)에서는 cryptoEnv 유무와 무관하게 기존 동작과 동일.
   */
  constructor(
    private db: D1Database,
    private cryptoEnv?: ApprovalCryptoEnv,
  ) {}
  /** 저장 암호화 ON인가 (ai_settings storage.protection). */
  async encryptionEnabled(): Promise<boolean> {
    return isStorageEncryptionEnabled(this.db)
  }
  /**
   * INSERT 직전 보호 변환. OFF면 입력 그대로(바이트 동일).
   * ON인데 키가 없으면 던진다 — 호출 측 게이트가 요청 생성을 실패로
   * 처리하므로 실행 본체가 평문으로 남는 일은 없다.
   */
  async protectInput(input: CreatePendingInput): Promise<CreatePendingInput> {
    if (!await this.encryptionEnabled()) return input
    if (!this.cryptoEnv?.MEMO_ENCRYPTION_KEY) {
      throw new Error('storage encryption enabled but MEMO_ENCRYPTION_KEY not configured')
    }
    return {
      ...input,
      markerText: await protectText(this.cryptoEnv, input.markerText),
      userRequest: await protectText(this.cryptoEnv, input.userRequest),
    }
  }
  /**
   * 읽은 행의 복원. 암호문이 아니면(구 평문·스위치 OFF) 무변환.
   * 암호문인데 복호할 키가 없거나 복호가 실패하면 던진다 — 암호문을
   * 원문인 것처럼 실행 경로에 넘기지 않기 위한 fail-closed.
   * 이 저장소의 반환값이 실행 직전 복원의 집행 지점이다 (routes.ts의
   * executor는 여기서 복원된 markerText만 받는다).
   */
  async revealPending(p: PendingApprovalRequest): Promise<PendingApprovalRequest> {
    const needsReveal = isEncrypted(p.markerText) || isEncrypted(p.userRequest) || (p.executionResult != null && isEncrypted(p.executionResult))
    if (!needsReveal) return p
    if (!this.cryptoEnv?.MEMO_ENCRYPTION_KEY) {
      throw new Error('storage encryption: MEMO_ENCRYPTION_KEY not configured for reveal')
    }
    return {
      ...p,
      markerText: await revealText(this.cryptoEnv, p.markerText),
      userRequest: await revealText(this.cryptoEnv, p.userRequest),
      executionResult: p.executionResult == null ? p.executionResult : await revealText(this.cryptoEnv, p.executionResult),
    }
  }
  /**
   * 대기 요청을 만든다. 단, 같은 (conversation_id, scope_key)의 pending이
   * 이미 있으면 새로 만들지 않고 그 건을 반환한다 (R-21, 2026-11-05).
   *
   * 경합 안전성: 호출자들의 find-then-insert(findPendingByScope → create)는
   * 동시 턴 2개가 모두 "없음"을 보고 각각 insert해 pending이 2건이 됐고,
   * 승인 처리는 최신 1건만 풀어 남은 1건이 다음 승인에 같은 쓰기를 또
   * 실행했다 (claimExecution은 건 단위라 중복 건을 막지 못한다). 그래서
   * 삽입 자체를 단일 원자 문장으로 한다 — INSERT … SELECT … WHERE NOT
   * EXISTS는 D1(SQLite)에서 문장 단위로 직렬화되므로, 동시 삽입 중 1건만
   * changes=1이 되고 나머지는 changes=0으로 기존 건을 재사용한다.
   * DB 레벨 방어는 0072 부분 유니크 인덱스(pending일 때만)가 맡는다.
   *
   * - changes=0이면 기존 pending을 조회해 반환한다. 그 건이 그동안
   *   만료·결정돼 조회가 비면(레이스) 삽입을 다시 시도한다 (최대 3회).
   * - changes가 없는 구형 응답(meta에 last_row_id만)은 기존과 같이
   *   last_row_id로 성패를 판정한다.
   */
  async createPending(input: CreatePendingInput): Promise<PendingApprovalRequest> {
    const storedInput = await this.protectInput(input)
    const created = new Date(input.createdAt)
    const lookupNow = Number.isNaN(created.getTime()) ? new Date() : created
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await this.db
        .prepare(
          `INSERT INTO tool_approval_requests
             (persona_id, conversation_id, tool, scope_key, marker_text, summary,
              user_request, reversible, impact, status, created_at, expires_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM tool_approval_requests
             WHERE conversation_id = ? AND scope_key = ? AND status = 'pending'
           )`
        )
        .bind(
          storedInput.personaId,
          storedInput.conversationId,
          storedInput.tool.toUpperCase(),
          storedInput.scopeKey,
          storedInput.markerText,
          storedInput.summary,
          storedInput.userRequest,
          storedInput.reversible ? 1 : 0,
          storedInput.impact,
          storedInput.createdAt,
          storedInput.expiresAt,
          storedInput.conversationId,
          storedInput.scopeKey,
        )
        .run()
      const meta = result.meta as { changes?: number; last_row_id?: number } | undefined
      if (meta?.changes === 0) {
        const existing = await this.findPendingByScope(input.conversationId, input.scopeKey, lookupNow)
        if (existing && existing.status === 'pending') return existing
        continue
      }
      const id = meta?.last_row_id
      if (typeof id !== 'number') throw new Error('approval request insert failed')
      return { ...input, id, tool: input.tool.toUpperCase(), status: 'pending', executedAt: null, executionResult: null }
    }
    const existing = await this.findPendingByScope(input.conversationId, input.scopeKey, lookupNow)
    if (existing && existing.status === 'pending') return existing
    throw new Error('approval request insert failed')
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
    const request = await this.revealPending(rowToPending(row))
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
    return this.revealPending(rowToPending(row))
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
    let stored = trimmed
    if (await this.encryptionEnabled()) {
      if (!this.cryptoEnv?.MEMO_ENCRYPTION_KEY) return false
      stored = await protectText(this.cryptoEnv, trimmed)
    }
    const result = await this.db
      .prepare(
        `UPDATE tool_approval_requests SET execution_result = ?
         WHERE id = ? AND executed_at IS NOT NULL`
      )
      .bind(stored, id)
      .run()
    return ((result.meta as { changes?: number } | undefined)?.changes ?? 0) === 1
  }
}

export const APPROVAL_CLEANUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** execution_result 감사 기록의 최대 길이 (결과 텍스트 전문이 아니라 요약만 남긴다) */
export const EXECUTION_RESULT_MAX = 500

export async function cleanupApprovalRequests(
  db: D1Database,
  cryptoEnv: ApprovalCryptoEnv | undefined,
  now: Date = new Date(),
  retentionMs: number = APPROVAL_CLEANUP_RETENTION_MS,
): Promise<{ skipped: boolean; expired: number; deleted: number }> {
  void cryptoEnv
  if (!await isStorageEncryptionEnabled(db)) {
    return { skipped: true, expired: 0, deleted: 0 }
  }
  const nowIso = now.toISOString()
  const expireResult = await db.prepare(
    `UPDATE tool_approval_requests SET status = 'expired', decided_at = ?
       WHERE status = 'pending' AND expires_at <= ?`
  ).bind(nowIso, nowIso).run()
  const cutoff = new Date(now.getTime() - retentionMs).toISOString()
  const deleteResult = await db.prepare(
    `DELETE FROM tool_approval_requests
       WHERE (status IN ('expired', 'denied')
              OR (status = 'approved' AND executed_at IS NOT NULL))
         AND COALESCE(decided_at, expires_at) <= ?`
  ).bind(cutoff).run()
  return {
    skipped: false,
    expired: (expireResult.meta as { changes?: number } | undefined)?.changes ?? 0,
    deleted: (deleteResult.meta as { changes?: number } | undefined)?.changes ?? 0,
  }
}

export interface ApprovedExecutionOutcome {
  claimed: boolean // true면 이 호출이 실행을 선점해 executor를 실제로 돌렸다
  resultText?: string
  error?: string
  executionResult: string | null // 저장된 감사 요약
  request: PendingApprovalRequest
}

/**
 * 승인된 요청을 정확히 한 번만 실행한다 (0063, Talorys ②-0).
 * 실행 직전 claimExecution으로 원자 선점하고, 선점에 성공한 호출만 executor를
 * 실행한다. 실패해도 executed_at을 되돌리지 않는다 (자동 재시도 금지).
 */
export async function executeApprovedRequestOnce(
  db: D1Database,
  request: PendingApprovalRequest,
  executor: (request: PendingApprovalRequest) => Promise<string>,
  now: Date = new Date(),
  cryptoEnv?: ApprovalCryptoEnv,
): Promise<ApprovedExecutionOutcome> {
  const store = new ToolApprovalRequestStore(db, cryptoEnv)
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

function wasApprovalJustPresented(
  messagesBeforeReply: Array<{ role: string; content: unknown }>,
  request: PendingApprovalRequest,
): boolean {
  for (let i = messagesBeforeReply.length - 1; i >= 0; i--) {
    const m = messagesBeforeReply[i]
    if (!m || m.role !== 'assistant' || typeof m.content !== 'string') continue
    return m.content.includes('[승인이 필요해요]') || m.content.includes(request.summary)
  }
  return false
}

// 승인 응답 해결 — /chat 핸들러가 모델 호출 전에 부른다
export type ApprovalResolutionStatus = 'none' | 'approved' | 'approved_session' | 'denied' | 'expired'

export interface ApprovalResolution {
  status: ApprovalResolutionStatus
  request?: PendingApprovalRequest
}

export interface ResolveApprovalReplyInput {
  conversationId: number
  personaId: string // 감사 기록은 pending의 비서를 우선 사용하고, 이 값은 폴백
  reply: string
  now?: Date
  cryptoEnv?: ApprovalCryptoEnv
  messagesBeforeReply?: Array<{ role: string; content: unknown }>
}

/**
 * 대기 중인 승인 요청에 대한 사용자의 답을 처리한다. pending이 없거나 승인
 * 응답이 아니면 { status: 'none' }. 승인은 tool_approvals에 감사 기록을 남기고
 * (단건 승인은 일회성), 세션 허용은 SESSION 스코프 행으로 저장한다.
 */
export async function resolveApprovalReply(
  db: D1Database,
  input: ResolveApprovalReplyInput,
): Promise<ApprovalResolution> {
  const now = input.now ?? new Date()
  const requestStore = new ToolApprovalRequestStore(db, input.cryptoEnv)
  const { request, expired } = await requestStore.findNewestPending(input.conversationId, now)
  if (!request) return { status: 'none' }
  if (expired) return { status: 'expired', request }

  const kind = parseApprovalReply(input.reply, request.tool)
  if (!kind) return { status: 'none' }

  if (kind === 'approve' && input.messagesBeforeReply && isCasualApprovalReply(input.reply) && !wasApprovalJustPresented(input.messagesBeforeReply, request)) {
    return { status: 'none' }
  }

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
