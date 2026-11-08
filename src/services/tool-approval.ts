/**
 * 도구 승인 + PII 마스킹 경계 — Octop 도구 승인·PII 마스킹 패턴 이식
 *
 * 도구 실행 전 게이트 (Parse → Authorize → Validate → Execute 중 Authorize):
 * - deny-by-default: 모르는 비서·허용 목록 밖 도구·미분류 도구는 거부.
 * - 위험 등급 (b트랙, 2026-10-26 개정 — 이전에는 쓰기가 무승인 실행이었음):
 *   읽기 = 승인 불필요, 쓰기 = 기본 승인 필요, 삭제·외부 발송 = 반드시 승인.
 *   잠금/해제 관련 도구는 승인 여부와 무관하게 절대 실행 불가
 *   (policy-guard와 동일 원칙 — 이 게이트가 잠금을 우회하지 않는다).
 * - 출처 게이트 (Talorys ③-A): 쓰기·파괴적 도구는 실행 출처가
 *   'interactive'일 때만 ask/allow가 된다. 비대화형(미지정 포함)은
 *   승인 여부와 무관하게 deny('non_interactive_origin').
 * - 채팅 게이트는 저장된 단건 승인을 자동 허용 근거로 쓰지 않는다
 *   (단건 승인은 일회성, 반복 허용은 "이 세션 허용"으로만).
 *   decideToolExecution의 approval 인자는 팀 경로·하위 호환용으로 유지한다.
 * - 모든 도구 인자는 secret-mask.ts의 maskSecrets로 마스킹한 뒤에만
 *   로그·응답·외부 전송에 사용한다 (마스킹 로직 중복 정의 금지).
 * - 잠긴 메모는 이 계층이 아니라 ai-access.ts에서 원천 차단한다.
 *   이 게이트는 그 전제를 바꾸지 않는다.
 */

import { maskWithPrivacyEngine } from './privacy-mask'
import { getExpert, getExpertTools } from './expert-registry'
import type { ExecutionOrigin } from '../ai/types'

export type ToolRisk = 'read' | 'write' | 'destructive' | 'unknown'

/** 승인 없이는 절대 실행하지 않는 도구 */
export const DESTRUCTIVE_TOOLS: ReadonlyArray<string> = [
  'MEMO_DELETE',
  'SCHEDULE_DELETE',
  'TODO_DELETE',
  'ARTIFACT_DELETE',
  'CRON_DELETE',
]

/** 외부 발송 도구 (푸시·이메일 등 — 반드시 승인; 채팅 마커에는 아직 없음) */
export const EXTERNAL_SEND_TOOLS: ReadonlyArray<string> = [
  'PUSH_SEND',
  'EMAIL_SEND',
  'SHARE_EXTERNAL',
]

/** 쓰기 도구 (기본 승인 필요 — 승인·세션 허용 없이는 실행 불가) */
export const WRITE_TOOLS: ReadonlyArray<string> = [
  'MEMO_CREATE',
  'MEMO_UPDATE',
  'SCHEDULE_CREATE',
  'SCHEDULE_UPDATE',
  'TODO_ADD',
  'TODO_DONE',
  'TODO_UPDATE',
  'ARTIFACT_CREATE',
  'ARTIFACT_FROM_GITHUB',
  'CRON_CREATE',
  'CRON_TOGGLE',
  'GCAL_CREATE', // Google 캘린더 일정 생성 (쓰기 scope 결정 전에는 scope_missing으로 거부)
]

/** 읽기 도구 (승인 없이 실행 가능) */
export const READ_TOOLS: ReadonlyArray<string> = [
  'MEMO_SEARCH',
  'MEMO_GET',
  'SCHEDULE_LIST',
  'TODO_LIST',
  'SEARCH',
  'IMG',
  'GITHUB',
  'PAGE', // 실제 브라우저로 페이지 본문 읽기 (읽기 전용 1단계)
  'FILE_SEARCH', // 보관함 전역 파일 검색 (이름·경로 메타데이터만, 내용 없음)
  'CRON_LIST',
  'GMAIL_SEARCH', // Gmail 검색 (읽기 전용 scope)
  'GMAIL_GET', // Gmail 단건 조회 (읽기 전용 scope)
  'GCAL_LIST', // Google 캘린더 조회 (읽기 전용 scope)
]

/**
 * 잠금/해제 관련 도구 — AI는 잠금/해제를 절대 할 수 없다.
 * policy-guard의 차단과 동일 원칙이며, 승인 여부와 무관하게 거부된다.
 */
export function isLockTool(tool: unknown): boolean {
  if (typeof tool !== 'string') return false
  return tool.toUpperCase().includes('LOCK')
}

export function classifyToolRisk(tool: unknown): ToolRisk {
  if (typeof tool !== 'string') return 'unknown'
  const upper = tool.toUpperCase()
  if (
    (DESTRUCTIVE_TOOLS as ReadonlyArray<string>).includes(upper) ||
    (EXTERNAL_SEND_TOOLS as ReadonlyArray<string>).includes(upper)
  )
    return 'destructive'
  if ((WRITE_TOOLS as ReadonlyArray<string>).includes(upper)) return 'write'
  if ((READ_TOOLS as ReadonlyArray<string>).includes(upper)) return 'read'
  return 'unknown'
}

/**
 * 승인 범위 키 — 승인은 도구 전체가 아니라 "도구+대상" 단위다.
 * 예: MEMO_DELETE:123 (메모 123 삭제만 승인, 다른 메모 삭제는 별도 승인).
 * 대상 id가 없으면 도구 단위 키.
 */
export function approvalScopeKey(tool: string, args: unknown): string {
  const upper = String(tool).toUpperCase()
  const id = extractTargetId(args)
  return id !== null ? `${upper}:${id}` : upper
}

function extractTargetId(args: unknown): string | null {
  if (args === null || typeof args !== 'object') return null
  const record = args as Record<string, unknown>
  // 키 집합은 sandbox.ts의 TARGET_ID_KEYS·approval-flow의 추출과 같아야
  // 한다 — 어긋나면 scope와 미리보기·요약이 서로 다른 대상을 가리킨다.
  for (const key of [
    'id',
    'memoId', 'scheduleId', 'todoId', 'cronId', 'artifactId',
    'memo_id', 'schedule_id', 'todo_id', 'cron_id', 'artifact_id',
  ]) {
    const value = record[key]
    if (typeof value === 'number' && Number.isInteger(value)) return String(value)
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** 팀 단계 문장에 파괴적 동사가 있는지 (승인 필요 여부 사전 판정) */
const DESTRUCTIVE_VERB_RE = /(삭제|지워|지우|파기|취소|없애|날려)/
export function requiresApprovalClause(clause: string): boolean {
  return DESTRUCTIVE_VERB_RE.test(clause)
}

/**
 * 도구 인자 전체를 재귀적으로 마스킹 (기존 maskSecrets 재사용).
 * 문자열이 아닌 값은 그대로 두고, 구조는 유지한다.
 */
export function maskToolArgs(args: unknown): { masked: unknown; count: number } {
  let count = 0
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const r = maskWithPrivacyEngine(value)
      count += r.count
      return r.masked
    }
    if (Array.isArray(value)) return value.map(walk)
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v)
      }
      return out
    }
    return value
  }
  return { masked: walk(args), count }
}

export interface ApprovalRecord {
  id?: number
  personaId: string
  tool: string
  scopeKey: string
  decision: 'approved' | 'denied'
  /** ISO UTC 문자열. null이면 무기한 */
  expiresAt: string | null
  createdAt?: string
}

export type ApprovalDecision = 'allow' | 'ask' | 'deny'

export interface ToolDecision {
  decision: ApprovalDecision
  reason: string
  /** 마스킹된 인자 (로그·외부 전송에는 이것만 사용) */
  maskedArgs: unknown
  maskedCount: number
  scopeKey: string
}

export interface DecideToolInput {
  personaId: unknown
  tool: unknown
  args?: unknown
  /** 저장된 승인 기록 (없으면 승인 없음으로 간주) */
  approval?: ApprovalRecord | null
  /** 같은 대화에서 같은 종류의 도구에 대해 사용자가 "이 세션 허용"을 준 경우 */
  sessionAllowed?: boolean
  /**
   * 실행 출처 (Talorys ③-A). 쓰기·파괴적 도구는 'interactive'에서만
   * ask/allow가 가능하고, 그 외(미지정 포함)는 deny — 물을 상대가 없는
   * 컨텍스트에서 ask는 대기가 아니라 방치이기 때문이다 (fail-closed).
   */
  origin?: ExecutionOrigin
  /** 기준 시각 (테스트용, 기본값 now) */
  now?: Date
}

/**
 * 도구 실행 가 결정 (순수 함수 — DB 접근 없음).
 * 순서: 잠금 도구 거부 → 비서 유효성 → 허용 목록 → 위험도 분류 →
 * 쓰기/파괴적 도구는 세션 허용 또는 유효한 승인 기록이 있어야 실행.
 */
export function decideToolExecution(input: DecideToolInput): ToolDecision {
  const now = input.now ?? new Date()
  const tool = typeof input.tool === 'string' ? input.tool.toUpperCase() : ''
  const scopeKey = approvalScopeKey(tool, input.args)
  const { masked, count } = maskToolArgs(input.args)

  const deny = (reason: string): ToolDecision => ({
    decision: 'deny',
    reason,
    maskedArgs: masked,
    maskedCount: count,
    scopeKey,
  })

  // 잠금/해제 도구는 승인 여부와 무관하게 절대 실행 불가
  if (isLockTool(tool)) return deny('lock_forbidden')

  const expert = getExpert(input.personaId)
  if (!expert) return deny('unknown_persona')
  const allowedTools = getExpertTools(expert.legacyId)
  if (!tool || !allowedTools.includes(tool)) return deny('tool_not_allowed')

  const risk = classifyToolRisk(tool)
  if (risk === 'unknown') return deny('tool_unclassified')

  if (risk === 'write' || risk === 'destructive') {
    // 출처 게이트 (Talorys ③-A): 비대화형 실행(예약·mcp·채널, 미지정 포함)은
    // 승인 기록·세션 허용으로도 쓰기·파괴적 도구를 실행할 수 없다.
    if (input.origin !== 'interactive') return deny('non_interactive_origin')
    // "이 세션 허용"이 있으면 재승인 없이 실행
    if (input.sessionAllowed) {
      return {
        decision: 'allow',
        reason: 'session_allowed',
        maskedArgs: masked,
        maskedCount: count,
        scopeKey,
      }
    }
    const approval = input.approval ?? null
    if (!approval || approval.decision !== 'approved') {
      return {
        decision: 'ask',
        reason: 'approval_required',
        maskedArgs: masked,
        maskedCount: count,
        scopeKey,
      }
    }
    if (
      approval.personaId !== expert.legacyId ||
      approval.tool.toUpperCase() !== tool ||
      approval.scopeKey !== scopeKey
    ) {
      return {
        decision: 'ask',
        reason: 'approval_scope_mismatch',
        maskedArgs: masked,
        maskedCount: count,
        scopeKey,
      }
    }
    if (approval.expiresAt !== null) {
      const expires = new Date(approval.expiresAt)
      if (Number.isNaN(expires.getTime()) || expires.getTime() <= now.getTime()) {
        return {
          decision: 'ask',
          reason: 'approval_expired',
          maskedArgs: masked,
          maskedCount: count,
          scopeKey,
        }
      }
    }
  }

  return {
    decision: 'allow',
    reason: risk === 'destructive' || risk === 'write' ? 'approved' : 'allowed',
    maskedArgs: masked,
    maskedCount: count,
    scopeKey,
  }
}

/**
 * 승인 기록 D1 저장소 (마이그레이션 0047 tool_approvals).
 * 만료 판정은 JS에서 수행한다 (D1 datetime('now')와 ISO 문자열의
 * 사전식 비교가 어긋나는 것을 피하기 위함).
 */
export class ToolApprovalStore {
  constructor(private db: D1Database) {}

  /**
   * 승인·거부 결정 기록 (감사 기록).
   * 같은 (persona, tool, scope)에는 1행만 유지한다 — 재결정은 UPDATE로 덮어쓴다
   * (UNIQUE 제약 위반으로 두 번째 결정이 실패하지 않도록).
   */
  async recordApproval(record: Omit<ApprovalRecord, 'id' | 'createdAt'>): Promise<number> {
    const result = await this.db
      .prepare(
        `INSERT INTO tool_approvals (persona_id, tool, scope_key, decision, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(persona_id, tool, scope_key) DO UPDATE SET
           decision = excluded.decision,
           expires_at = excluded.expires_at,
           created_at = datetime('now')`
      )
      .bind(
        record.personaId,
        record.tool.toUpperCase(),
        record.scopeKey,
        record.decision,
        record.expiresAt,
      )
      .run()
    const id = (result.meta as { last_row_id?: number } | undefined)?.last_row_id
    if (typeof id !== 'number') throw new Error('approval insert failed')
    return id
  }

  /** 가장 최근의 승인 기록 1건 (만료 여부는 호출자가 판정) */
  async findLatestApproval(
    personaId: string,
    tool: string,
    scopeKey: string,
  ): Promise<ApprovalRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, persona_id AS personaId, tool, scope_key AS scopeKey,
                decision, expires_at AS expiresAt, created_at AS createdAt
         FROM tool_approvals
         WHERE persona_id = ? AND tool = ? AND scope_key = ?
         ORDER BY id DESC LIMIT 1`
      )
      .bind(personaId, tool.toUpperCase(), scopeKey)
      .first<Record<string, unknown>>()
    if (!row || typeof row !== 'object') return null
    if (row.decision !== 'approved' && row.decision !== 'denied') return null
    return {
      id: typeof row.id === 'number' ? row.id : undefined,
      personaId: String(row.personaId ?? ''),
      tool: String(row.tool ?? ''),
      scopeKey: String(row.scopeKey ?? ''),
      decision: row.decision as 'approved' | 'denied',
      expiresAt: row.expiresAt === null ? null : String(row.expiresAt),
      createdAt: row.createdAt === null ? undefined : String(row.createdAt),
    }
  }

  /** 유효한(승인됨·미만료) 승인 기록이 있으면 반환, 없으면 null */
  async findValidApproval(
    personaId: string,
    tool: string,
    scopeKey: string,
    now: Date = new Date(),
  ): Promise<ApprovalRecord | null> {
    const record = await this.findLatestApproval(personaId, tool, scopeKey)
    if (!record || record.decision !== 'approved') return null
    if (record.expiresAt !== null) {
      const expires = new Date(record.expiresAt)
      if (Number.isNaN(expires.getTime()) || expires.getTime() <= now.getTime()) return null
    }
    return record
  }

  async revokeApproval(personaId: string, tool: string, scopeKey: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `DELETE FROM tool_approvals WHERE persona_id = ? AND tool = ? AND scope_key = ?`
      )
      .bind(personaId, tool.toUpperCase(), scopeKey)
      .run()
    return ((result.meta as { changes?: number } | undefined)?.changes ?? 0) > 0
  }

  // ---------- "이 세션 허용" ----------
  // 세션 = 채팅 대화(conversation_id). 허용은 "도구 종류" 단위이며, 해당 대화에서만
  // 유효하고 대화가 끝나면 다시 조회되지 않아 사실상 소멸한다. 안전장치로 24시간
  // 만료(expires_at)를 함께 기록한다. 저장소는 tool_approvals를 재사용한다
  // (scope_key = SESSION:<conversationId>:<TOOL>).
  /** 세션 허용 범위 키 */
  sessionScopeKey(conversationId: number | string, tool: string): string {
    return `SESSION:${conversationId}:${tool.toUpperCase()}`
  }

  /** 이 세션 허용 기록 (24시간 만료 — 대화 스코프가 1차 소멸 조건) */
  async recordSessionAllowance(
    personaId: string,
    tool: string,
    conversationId: number | string,
    now: Date = new Date(),
  ): Promise<number> {
    return this.recordApproval({
      personaId,
      tool: tool.toUpperCase(),
      scopeKey: this.sessionScopeKey(conversationId, tool),
      decision: 'approved',
      expiresAt: new Date(now.getTime() + SESSION_ALLOWANCE_TTL_MS).toISOString(),
    })
  }

  /** 유효한(승인됨·미만료) 세션 허용이 있으면 반환, 없으면 null */
  async findSessionAllowance(
    personaId: string,
    tool: string,
    conversationId: number | string,
    now: Date = new Date(),
  ): Promise<ApprovalRecord | null> {
    return this.findValidApproval(
      personaId,
      tool.toUpperCase(),
      this.sessionScopeKey(conversationId, tool),
      now,
    )
  }

  /** 세션 허용 철회 (세션 종료 시 명시적 정리용) */
  async revokeSessionAllowance(
    personaId: string,
    tool: string,
    conversationId: number | string,
  ): Promise<boolean> {
    return this.revokeApproval(
      personaId,
      tool.toUpperCase(),
      this.sessionScopeKey(conversationId, tool),
    )
  }
}

/** 세션 허용 유효기간 (24시간 — 대화 스코프가 1차 소멸 조건이라 안전장치 성격) */
export const SESSION_ALLOWANCE_TTL_MS = 24 * 60 * 60 * 1000
