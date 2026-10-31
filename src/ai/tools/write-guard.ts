/**
 * Write Execution Guard — Phase 1E
 *
 * 쓰기 도구의 안전한 실행을 위한 가드.
 * - 승인 검증 (서버에서 생성된 승인만 인정)
 * - 멱등성 검사 (operationId 기반)
 * - D1 원자적 쓰기
 *
 * 책임 분리:
 * - Agent Runner: 호출 순서, 예산, 결과 수집
 * - Tool Registry: 도구 존재, Zod 검증, 권한
 * - Write Guard: 승인, 멱등성, 실행 상태 (이 파일)
 * - D1 Repository: 실제 DB 쓰기
 */

import type { ToolCall, ToolResult, ExecutionContext } from '../types'

// ---------------------------------------------------------------------------
// 승인 타입
// ---------------------------------------------------------------------------

export type ApprovalLevel = 'low_risk' | 'confirmation_required' | 'restricted'

export type WriteApproval = {
  userId: string
  operationId: string
  toolName: string
  /** 정규화된 인자의 해시 */
  argsHash: string
  level: ApprovalLevel
  /** 승인 상태 */
  status: 'pending' | 'approved' | 'expired' | 'rejected'
  approvedAt?: string
  expiresAt?: string
}

// ---------------------------------------------------------------------------
// Operation 상태
// ---------------------------------------------------------------------------

export type OperationStatus =
  | 'pending'
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'unknown'

export type OperationRecord = {
  id: number
  userId: string
  operationId: string
  requestId: string
  toolName: string
  argsHash: string
  status: OperationStatus
  resultRef?: string
  errorCode?: string
  createdAt: string
  updatedAt: string
}

// 허용된 상태 전이
const ALLOWED_TRANSITIONS: Record<OperationStatus, OperationStatus[]> = {
  pending: ['in_progress', 'failed'],
  in_progress: ['succeeded', 'failed', 'unknown'],
  succeeded: [], // 최종 상태, 변경 불가
  failed: ['pending'], // 재시도 시 pending으로
  unknown: ['pending', 'in_progress'], // 복구 시
}

export function canTransition(from: OperationStatus, to: OperationStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}

// ---------------------------------------------------------------------------
// 인자 해시
// ---------------------------------------------------------------------------

/**
 * 인자를 안정적인 순서로 정규화 후 해시.
 * 개인정보 원문이 로그에 남지 않도록 해시만 사용.
 */
export async function hashArgs(args: unknown): Promise<string> {
  const normalized = normalizeArgs(args)
  const json = JSON.stringify(normalized)
  // Web Crypto API 사용 (Workers 환경)
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json))
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 32)
  }
  // 폴백: 간단한 해시 (테스트 환경)
  let hash = 0
  for (let i = 0; i < json.length; i++) {
    const char = json.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(16).padStart(8, '0') + json.length.toString(16)
}

function normalizeArgs(args: unknown): unknown {
  if (args === null || args === undefined) return null
  if (Array.isArray(args)) return args.map(normalizeArgs)
  if (typeof args === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(args as Record<string, unknown>).sort()) {
      sorted[k] = normalizeArgs((args as Record<string, unknown>)[k])
    }
    return sorted
  }
  return args
}

// ---------------------------------------------------------------------------
// Write Guard
// ---------------------------------------------------------------------------

export type WriteGuardConfig = {
  db: D1Database
}

export type WriteCheckResult =
  | { allowed: true; operationId: string; argsHash: string }
  | { allowed: false; errorCode: string; message: string }

export class WriteExecutionGuard {
  private db: D1Database

  constructor(config: WriteGuardConfig) {
    this.db = config.db
  }

  /**
   * 쓰기 실행 전 검사.
   * - 승인 검증
   * - 멱등성 검사 (기존 operation 확인)
   */
  async checkBeforeExecute(
    call: ToolCall,
    ctx: ExecutionContext,
    approval: WriteApproval | null
  ): Promise<WriteCheckResult> {
    // 0. 출처 게이트 (Talorys ③-A): 이 가드는 쓰기 도구 전용 판정 지점이라
    // decideToolExecution과 같은 규칙을 적용한다 — 'interactive'가 아닌
    // 실행(미지정 포함, fail-closed)은 승인 여부와 무관하게 거부.
    if (ctx.origin !== 'interactive') {
      return {
        allowed: false,
        errorCode: 'NON_INTERACTIVE_ORIGIN',
        message: 'Write tools require an interactive origin',
      }
    }
    // 1. 승인 검증
    if (!approval) {
      return { allowed: false, errorCode: 'APPROVAL_REQUIRED', message: 'Write approval required' }
    }
    if (approval.userId !== ctx.userId) {
      return { allowed: false, errorCode: 'APPROVAL_USER_MISMATCH', message: 'Approval user mismatch' }
    }
    if (approval.toolName !== call.name) {
      return { allowed: false, errorCode: 'APPROVAL_TOOL_MISMATCH', message: 'Approval tool mismatch' }
    }
    if (approval.status !== 'approved') {
      return { allowed: false, errorCode: 'APPROVAL_NOT_GRANTED', message: 'Approval not granted' }
    }
    if (approval.expiresAt && new Date(approval.expiresAt) < new Date()) {
      return { allowed: false, errorCode: 'APPROVAL_EXPIRED', message: 'Approval expired' }
    }

    // 2. 인자 해시 검증 (승인된 인자와 동일한지)
    const argsHash = await hashArgs(call.args)
    if (approval.argsHash !== argsHash) {
      return { allowed: false, errorCode: 'IDEMPOTENCY_CONFLICT', message: 'Args changed after approval' }
    }

    // 3. 멱등성 검사 - 기존 operation 확인
    const existing = await this.getOperation(ctx.userId, approval.operationId)
    if (existing) {
      if (existing.status === 'succeeded') {
        // 이미 성공 - 중복 실행하지 않고 기존 결과 반환 신호
        // (호출자가 기존 결과를 반환하도록)
        return { allowed: false, errorCode: 'ALREADY_SUCCEEDED', message: 'Operation already succeeded' }
      }
      if (existing.status === 'in_progress') {
        return { allowed: false, errorCode: 'ALREADY_IN_PROGRESS', message: 'Operation in progress' }
      }
      if (existing.argsHash !== argsHash) {
        return { allowed: false, errorCode: 'IDEMPOTENCY_CONFLICT', message: 'Different args for same operation' }
      }
      // pending, failed, unknown → 재실행 가능
    }

    return { allowed: true, operationId: approval.operationId, argsHash }
  }

  /**
   * Operation 기록 조회
   */
  async getOperation(userId: string, operationId: string): Promise<OperationRecord | null> {
    try {
      const row = await this.db
        .prepare('SELECT * FROM ai_tool_operations WHERE user_id = ? AND operation_id = ?')
        .bind(userId, operationId)
        .first() as any
      if (!row) return null
      return {
        id: row.id,
        userId: row.user_id,
        operationId: row.operation_id,
        requestId: row.request_id,
        toolName: row.tool_name,
        argsHash: row.args_hash,
        status: row.status as OperationStatus,
        resultRef: row.result_ref,
        errorCode: row.error_code,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    } catch {
      return null
    }
  }

  /**
   * Operation 상태 전이 (원자적)
   */
  async transitionStatus(
    userId: string,
    operationId: string,
    from: OperationStatus,
    to: OperationStatus
  ): Promise<boolean> {
    if (!canTransition(from, to)) return false
    try {
      const result = await this.db
        .prepare(
          `UPDATE ai_tool_operations SET status = ?, updated_at = datetime('now')
           WHERE user_id = ? AND operation_id = ? AND status = ?`
        )
        .bind(to, userId, operationId, from)
        .run()
      return (result.meta?.changes ?? 0) > 0
    } catch {
      return false
    }
  }

  /**
   * 새 Operation 생성 (UNIQUE 제약으로 동시성 방어)
   */
  async createOperation(
    userId: string,
    operationId: string,
    requestId: string,
    toolName: string,
    argsHash: string
  ): Promise<{ created: boolean; existing?: OperationRecord }> {
    try {
      await this.db
        .prepare(
          `INSERT INTO ai_tool_operations (user_id, operation_id, request_id, tool_name, args_hash, status)
           VALUES (?, ?, ?, ?, ?, 'pending')`
        )
        .bind(userId, operationId, requestId, toolName, argsHash)
        .run()
      return { created: true }
    } catch (e: any) {
      // UNIQUE 제약 위반 → 이미 존재
      if (String(e?.message).includes('UNIQUE') || String(e?.message).includes('unique')) {
        const existing = await this.getOperation(userId, operationId)
        return { created: false, existing: existing ?? undefined }
      }
      throw e
    }
  }
}

// ---------------------------------------------------------------------------
// 테스트용 승인 생성 헬퍼
// ---------------------------------------------------------------------------

export async function createTestApproval(
  userId: string,
  operationId: string,
  toolName: string,
  args: unknown,
  level: ApprovalLevel = 'low_risk'
): Promise<WriteApproval> {
  const argsHash = await hashArgs(args)
  const now = new Date()
  const expires = new Date(now.getTime() + 5 * 60 * 1000) // 5분
  return {
    userId,
    operationId,
    toolName,
    argsHash,
    level,
    status: 'approved',
    approvedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  }
}
