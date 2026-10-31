/**
 * 샌드박스 격리 — dry-run 미리보기 + 실행 감사 로그 (진짜 비서 3단계 i트랙)
 *
 * 전제: Cloudflare Workers에는 컨테이너·VM 수준의 샌드박스가 없다.
 * Cloudflare Sandbox(Containers)는 Workers Paid 플랜($5/월)이 필요해
 * 무료 티어 원칙과 충돌하고, MyHub 도구(타입 고정 D1 연산)에는 임의 코드
 * 실행 표면이 없어 과잉이다 — 옵션 평가는 docs/sandbox-options.md 참조.
 * 그래서 이 트랙은 논리적 격리를 구현한다:
 *
 * 1) dry-run 미리보기 — 위험한 도구 실행 전에 읽기 전용 조회만으로
 *    "무엇이 바뀌는지"를 계산해 사용자에게 보여준다. 아무것도 바꾸지 않는다.
 * 2) 명시 승인 — 파괴적 실행은 b트랙 승인 게이트를 그대로 타며,
 *    미리보기는 게이트를 우회하지 않는다. 미리보기 실패 시에도 실행하지 않는다.
 * 3) 감사 로그 — 무엇을·언제·누가 승인했는지 tool_execution_audit에 남긴다.
 *
 * 잠금 정책: 미리보기는 잠긴 메모의 내용을 절대 노출하지 않는다
 * (잠긴 메모는 id만 표시, 내용은 '(잠긴 메모 — 내용을 볼 수 없어요)'로 대체).
 * sensitivity >= 2인 메모도 마찬가지다 (ai-access.ts와 같은 기준).
 * 잠긴 메모 삭제·수정은 실행기가 실행 시점에 차단하므로, 미리보기는
 * "승인해도 실행이 차단된다"는 경고를 함께 보여준다.
 *
 * 인자는 반드시 마스킹된 것만 받는다 (호출자는 tool-approval의
 * decideToolExecution이 돌려준 maskedArgs를 넘긴다). DB에서 읽은
 * 스니펫도 maskSecrets로 한 번 더 마스킹한다 — 미리보기 문안과 감사
 * 로그에 시크릿이 새지 않도록.
 */

import { classifyToolRisk, type ToolRisk } from './tool-approval'
import { maskSecrets } from './secret-mask'
import { newSpanId, newTraceId } from '../lib/trace'

/** 미리보기 스니펫 최대 길이 */
export const DRY_RUN_SNIPPET_MAX = 100
/** 감사 로그 detail(JSON) 최대 길이 */
export const AUDIT_DETAIL_MAX = 2000

export interface DryRunChange {
  field: string
  /** 변경 전 (없으면 null — 새로 만드는 경우) */
  before: string | null
  /** 변경 후 (없으면 null — 삭제되는 경우) */
  after: string | null
}

export interface DryRunPreview {
  tool: string
  scopeKey: string
  risk: ToolRisk
  /** 대상 행을 찾았는지 (못 찾으면 승인해도 실행 실패) */
  targetFound: boolean
  /** 대상이 잠긴 메모인지 (내용 비노출 + 실행 차단 경고) */
  targetLocked: boolean
  /** 대상 표시 ("메모 #123" 등, 잠긴 메모는 내용 없이 id만) */
  targetLabel: string
  changes: DryRunChange[]
  warnings: string[]
  /** 미리보기를 만들 수 없는 도구 (예: ARTIFACT_CREATE — 실행 결과를 봐야 앎) */
  unavailable: boolean
}

function snippet(value: string): string {
  const masked = maskSecrets(value).masked
  const flat = masked.replace(/\s+/g, ' ').trim()
  if (flat.length <= DRY_RUN_SNIPPET_MAX) return flat
  return `${flat.slice(0, DRY_RUN_SNIPPET_MAX)}…`
}

function textOf(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function targetId(args: Record<string, unknown>): number | null {
  for (const key of ['id', 'memoId', 'scheduleId', 'todoId', 'artifactId']) {
    const v = args[key]
    if (typeof v === 'number' && Number.isInteger(v)) return v
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim())
  }
  return null
}

function asRecord(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {}
}

/** 잠긴 메모·민감 메모의 내용은 미리보기에서 숨긴다 */
function memoHidden(row: { is_locked?: unknown; sensitivity?: unknown }): boolean {
  return row.is_locked === 1 || row.is_locked === true || Number(row.sensitivity ?? 1) >= 2
}

const LOCKED_LABEL = '(잠긴 메모 — 내용을 볼 수 없어요)'
const HIDDEN_LABEL = '(내용을 볼 수 없어요)'

/**
 * dry-run 미리보기 — 읽기 전용 SELECT만 발행한다 (쓰기 쿼리 없음).
 * db 조회 실패는 예외로 전파한다 — 호출자(승인 게이트)가 잡아
 * 미리보기 없이 승인 요청을 만들거나 실행하지 않는다.
 */
export async function buildDryRunPreview(
  db: D1Database,
  tool: string,
  maskedArgs: unknown,
  scopeKey: string,
): Promise<DryRunPreview> {
  const upper = String(tool).toUpperCase()
  const args = asRecord(maskedArgs)
  const id = targetId(args)
  const risk = classifyToolRisk(upper)
  const base: DryRunPreview = {
    tool: upper,
    scopeKey,
    risk,
    targetFound: false,
    targetLocked: false,
    targetLabel: '',
    changes: [],
    warnings: [],
    unavailable: false,
  }

  // --- 생성 도구: 대상이 없어서 만들 내용을 인자에서 보여준다 ---
  switch (upper) {
    case 'MEMO_CREATE': {
      const text = textOf(args, ['text', 'content'])
      return {
        ...base,
        targetLabel: '새 메모',
        changes: [{ field: '내용', before: null, after: text ? `"${snippet(text)}"` : '(빈 메모)' }],
      }
    }
    case 'SCHEDULE_CREATE': {
      const title = textOf(args, ['title'])
      const when = textOf(args, ['startAt', 'start_at', 'date'])
      return {
        ...base,
        targetLabel: '새 일정',
        changes: [
          { field: '일정', before: null, after: title ? `"${snippet(title)}"` : '(제목 없음)' },
          ...(when ? [{ field: '시간', before: null, after: when }] : []),
        ],
      }
    }
    case 'TODO_ADD': {
      const title = textOf(args, ['title', 'text'])
      return {
        ...base,
        targetLabel: '새 할 일',
        changes: [{ field: '할 일', before: null, after: title ? `"${snippet(title)}"` : '(제목 없음)' }],
      }
    }
    case 'CRON_CREATE': {
      const text = textOf(args, ['text', 'nlText', 'content'])
      return {
        ...base,
        targetLabel: '새 자동화',
        changes: [{ field: '자동화', before: null, after: text ? `"${snippet(text)}"` : '(내용 없음)' }],
      }
    }
    case 'ARTIFACT_CREATE':
    case 'ARTIFACT_FROM_GITHUB':
    case 'GCAL_CREATE':
      // 실행 결과를 봐야 아는 도구 — 미리보기 불가 (승인 게이트는 그대로 동작)
      return { ...base, targetLabel: '새 항목', unavailable: true, warnings: ['이 작업은 미리보기를 만들 수 없어요. 승인 후 실행 결과를 확인해주세요.'] }
    default:
      break
  }

  // --- 기존 대상 도구: 대상 id가 없으면 미리보기 불가 ---
  if (id === null) {
    return { ...base, unavailable: true, warnings: ['대상을 특정할 수 없어서 미리보기를 만들 수 없어요.'] }
  }

  switch (upper) {
    case 'MEMO_DELETE':
    case 'MEMO_UPDATE': {
      const row = await db
        .prepare(
          'SELECT id, substr(text, 1, 200) AS snippet, sensitivity, is_locked FROM memos WHERE id = ?',
        )
        .bind(id)
        .first<Record<string, unknown>>()
      if (!row || typeof row !== 'object') {
        return { ...base, targetLabel: `메모 #${id}`, warnings: ['대상을 찾을 수 없어요. 승인해도 실행이 실패할 거예요.'] }
      }
      const locked = row.is_locked === 1 || row.is_locked === true
      const hidden = memoHidden(row)
      const label = `메모 #${id}`
      const before = hidden ? (locked ? LOCKED_LABEL : HIDDEN_LABEL) : `"${snippet(String(row.snippet ?? ''))}"`
      if (upper === 'MEMO_DELETE') {
        return {
          ...base,
          targetFound: true,
          targetLocked: locked,
          targetLabel: label,
          changes: [{ field: '메모', before, after: null }],
          warnings: locked ? ['잠긴 메모는 삭제할 수 없어요. 승인해도 실행이 차단돼요.'] : [],
        }
      }
      const next = textOf(args, ['text', 'content'])
      return {
        ...base,
        targetFound: true,
        targetLocked: locked,
        targetLabel: label,
        changes: [{ field: '내용', before, after: next ? `"${snippet(next)}"` : '(빈 내용)' }],
        warnings: locked ? ['잠긴 메모는 수정할 수 없어요. 승인해도 실행이 차단돼요.'] : [],
      }
    }
    case 'SCHEDULE_DELETE':
    case 'SCHEDULE_UPDATE': {
      const row = await db
        .prepare('SELECT id, title, start_at FROM schedules WHERE id = ?')
        .bind(id)
        .first<Record<string, unknown>>()
      if (!row || typeof row !== 'object') {
        return { ...base, targetLabel: `일정 #${id}`, warnings: ['대상을 찾을 수 없어요. 승인해도 실행이 실패할 거예요.'] }
      }
      const label = `일정 #${id} "${snippet(String(row.title ?? ''))}"`
      const when = String(row.start_at ?? '')
      if (upper === 'SCHEDULE_DELETE') {
        return {
          ...base,
          targetFound: true,
          targetLabel: label,
          changes: [{ field: '일정', before: when ? `${label} (${when})` : label, after: null }],
        }
      }
      const nextTitle = textOf(args, ['title'])
      return {
        ...base,
        targetFound: true,
        targetLabel: label,
        changes: [
          { field: '제목', before: `"${snippet(String(row.title ?? ''))}"`, after: nextTitle ? `"${snippet(nextTitle)}"` : null },
        ],
      }
    }
    case 'TODO_DELETE':
    case 'TODO_UPDATE':
    case 'TODO_DONE': {
      const row = await db
        .prepare('SELECT id, title, status FROM todos WHERE id = ?')
        .bind(id)
        .first<Record<string, unknown>>()
      if (!row || typeof row !== 'object') {
        return { ...base, targetLabel: `할 일 #${id}`, warnings: ['대상을 찾을 수 없어요. 승인해도 실행이 실패할 거예요.'] }
      }
      const label = `할 일 #${id} "${snippet(String(row.title ?? ''))}"`
      if (upper === 'TODO_DELETE') {
        return { ...base, targetFound: true, targetLabel: label, changes: [{ field: '할 일', before: label, after: null }] }
      }
      if (upper === 'TODO_DONE') {
        return {
          ...base,
          targetFound: true,
          targetLabel: label,
          changes: [{ field: '상태', before: String(row.status ?? 'pending'), after: 'done' }],
        }
      }
      const nextTitle = textOf(args, ['title'])
      return {
        ...base,
        targetFound: true,
        targetLabel: label,
        changes: [
          { field: '제목', before: `"${snippet(String(row.title ?? ''))}"`, after: nextTitle ? `"${snippet(nextTitle)}"` : null },
        ],
      }
    }
    case 'CRON_DELETE':
    case 'CRON_TOGGLE': {
      const row = await db
        .prepare('SELECT id, nl_text, cron_kst, enabled FROM user_cron_jobs WHERE id = ?')
        .bind(id)
        .first<Record<string, unknown>>()
      if (!row || typeof row !== 'object') {
        return { ...base, targetLabel: `자동화 #${id}`, warnings: ['대상을 찾을 수 없어요. 승인해도 실행이 실패할 거예요.'] }
      }
      const label = `자동화 #${id} "${snippet(String(row.nl_text ?? ''))}"`
      if (upper === 'CRON_DELETE') {
        return { ...base, targetFound: true, targetLabel: label, changes: [{ field: '자동화', before: label, after: null }] }
      }
      const enabled = args.enabled
      const nextState = enabled === true ? '켜짐' : enabled === false ? '꺼짐' : '변경'
      return {
        ...base,
        targetFound: true,
        targetLabel: label,
        changes: [{ field: '상태', before: row.enabled === 1 ? '켜짐' : '꺼짐', after: nextState }],
      }
    }
    default:
      return { ...base, targetLabel: upper, unavailable: true, warnings: ['이 작업은 미리보기를 만들 수 없어요. 승인 후 실행 결과를 확인해주세요.'] }
  }
}

/** 미리보기 문안 — 승인 요청 메시지(b트랙 문안) 뒤에 붙는다 */
export function formatDryRunPreview(preview: DryRunPreview): string {
  const lines = ['[실행 전 미리보기 — 아직 아무것도 바뀌지 않았어요]']
  if (preview.unavailable) {
    lines.push(`대상: ${preview.targetLabel || preview.tool}`)
  } else {
    lines.push(`대상: ${preview.targetLabel}`)
    for (const change of preview.changes) {
      if (change.before !== null && change.after !== null) {
        lines.push(`- ${change.field}: ${change.before} → ${change.after}`)
      } else if (change.before !== null) {
        lines.push(`- ${change.field}: ${change.before} → (삭제됨)`)
      } else if (change.after !== null) {
        lines.push(`- ${change.field}: (없음) → ${change.after}`)
      }
    }
  }
  for (const warning of preview.warnings) lines.push(`⚠️ ${warning}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 실행 감사 로그 — 무엇을·언제·누가 승인했는지 (마이그레이션 0055)
// ---------------------------------------------------------------------------

export type SandboxAuditAction = 'preview_shown' | 'executed' | 'denied' | 'expired' | 'blocked'

export interface SandboxAuditRecord {
  id?: number
  personaId: string
  conversationId: number | null
  tool: string
  scopeKey: string
  action: SandboxAuditAction
  /** 미리보기 요약·실행 결과 등 (마스킹된 값만 — 시크릿 금지) */
  detail: string
  createdAt?: string
  /** OTEL 스팬 (0057) — 없으면 recordAudit이 이 감사 기록을 루트로 삼는다 */
  traceId?: string
  spanId?: string
  parentSpanId?: string | null
  toolCallId?: string
  durationMs?: number
  /** OTEL 스팬 상태 (ok|error) — action의 감사 의미와 별개 */
  status?: 'ok' | 'error'
}

export class SandboxAuditStore {
  constructor(private db: D1Database) {}

  async recordAudit(record: Omit<SandboxAuditRecord, 'id' | 'createdAt'> & { createdAt?: string }): Promise<number> {
    const detail = record.detail.length > AUDIT_DETAIL_MAX ? record.detail.slice(0, AUDIT_DETAIL_MAX) : record.detail
    // OTEL 스팬 (0057): 호출자가 안 주면 이 감사 기록을 루트로 삼는다.
    const traceId = record.traceId || newTraceId()
    const spanId = record.spanId || newSpanId()
    const result = await this.db
      .prepare(
        `INSERT INTO tool_execution_audit
           (persona_id, conversation_id, tool, scope_key, action, detail, created_at,
            trace_id, span_id, parent_span_id, tool_call_id, duration_ms, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.personaId,
        record.conversationId,
        record.tool.toUpperCase(),
        record.scopeKey,
        record.action,
        detail,
        record.createdAt ?? new Date().toISOString(),
        traceId,
        spanId,
        record.parentSpanId ?? null,
        record.toolCallId ?? null,
        record.durationMs ?? null,
        // denied/expired/blocked는 status를 비워두어 뷰어가 action에서
        // denied/blocked로 구분하게 한다 (OTEL status는 ok|error만 있음).
        record.status ?? (record.action === 'executed' || record.action === 'preview_shown' ? 'ok' : null),
      )
      .run()
    const id = (result.meta as { last_row_id?: number } | undefined)?.last_row_id
    if (typeof id !== 'number') throw new Error('sandbox audit insert failed')
    return id
  }

  /** 이 대화의 최근 감사 기록 (최신순) */
  async listRecent(conversationId: number, limit = 20): Promise<SandboxAuditRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, persona_id AS personaId, conversation_id AS conversationId,
                tool, scope_key AS scopeKey, action, detail, created_at AS createdAt
         FROM tool_execution_audit
         WHERE conversation_id = ?
         ORDER BY id DESC LIMIT ?`,
      )
      .bind(conversationId, limit)
      .all<Record<string, unknown>>()
    return (results ?? []).map((row) => ({
      id: typeof row.id === 'number' ? row.id : undefined,
      personaId: String(row.personaId ?? ''),
      conversationId: row.conversationId === null ? null : Number(row.conversationId),
      tool: String(row.tool ?? ''),
      scopeKey: String(row.scopeKey ?? ''),
      action: row.action as SandboxAuditAction,
      detail: String(row.detail ?? ''),
      createdAt: String(row.createdAt ?? ''),
    }))
  }
}
