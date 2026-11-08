import { isFCWriteTool } from './fc-tool-policy'

export interface LedgerRunContext {
  runId: string
  requestId?: string
  userId?: string
  personaId?: string | null
  provider?: string
  model?: string
}

export interface FinishLedgerRunInput {
  status: string
  requestedToolCalls?: number
  executedToolCalls?: number
  elapsedMs?: number | null
  errorCode?: string | null
}

export interface RecordToolExecutionInput extends LedgerRunContext {
  toolCallId?: string
  toolName: string
  mode?: 'read' | 'write'
  status?: string
  success: boolean
  durationMs?: number
  error?: string | null
  args?: unknown
  resultData?: unknown
}

export interface RecordToolExecutionResult {
  recorded: boolean
  ledgerId: number | null
  runId: string
  toolCallId: string
}

export interface MarkerToolExecutionContext {
  env?: { DB?: D1Database }
  ledgerRunId?: string
  ledgerRequestId?: string
  ledgerUserId?: string
  ledgerPersonaId?: string
  ledgerExecutions?: Array<{ toolName: string; success: boolean; ledgerRecorded: boolean }>
}

export interface MarkerToolExecutionInput {
  toolName: string
  mode?: 'read' | 'write'
  success: boolean
  startedAt: number
  error?: string | null
  args?: unknown
  resultData?: unknown
}

export interface LedgerExecutionLike {
  toolName?: string
  success?: boolean
  ledgerRecorded?: boolean
  /** 도구 실행 결과 데이터 (성공 확정 판정에 id 등을 읽는다) */
  data?: any
}

export function newLedgerRunId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `run_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
  }
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export function newToolCallId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `tc_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
  }
  return `tc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export function hashToolArgs(args: unknown): string {
  let s: string
  try {
    s = JSON.stringify(args ?? null) ?? 'null'
  } catch {
    s = String(args)
  }
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `fnv1a_${(h >>> 0).toString(16).padStart(8, '0')}_${s.length}`
}

function warn(label: string, error: unknown): void {
  const errorType = error instanceof Error ? error.name : 'Unknown'
  console.warn('TOOL_LEDGER_FAILED', { label, errorType })
}

function deriveStatus(input: { status?: string; success: boolean; error?: string | null }): string {
  if (input.status) return input.status
  if (input.success) return 'success'
  const e = String(input.error || '')
  if (
    e.includes('approval_required') ||
    e.includes('non_interactive_origin') ||
    e.startsWith('Unknown tool') ||
    e.includes('policy_violation') ||
    e === 'tool_not_allowed' ||
    e === 'tool_unclassified' ||
    e === 'unknown_persona'
  ) {
    return 'blocked'
  }
  return 'error'
}

function deriveResultRef(toolName: string, resultData: any): string | null {
  if (!resultData || typeof resultData !== 'object') return null
  const raw = resultData.id ?? resultData.memoId ?? resultData.jobId
  if (typeof raw !== 'number' && typeof raw !== 'string') return null
  const base = toolName.replace(/_(create|update|delete|add|done|toggle|set_enabled|from_source)$/i, '')
  return `${base}:${raw}`
}

export async function ensureLedgerRun(db: D1Database | null | undefined, ctx: LedgerRunContext): Promise<boolean> {
  if (!db || typeof db.prepare !== 'function') return false
  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO ai_runs (run_id, request_id, user_id, assistant_id, provider, model, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', datetime('now'))`,
      )
      .bind(
        ctx.runId,
        ctx.requestId || ctx.runId,
        ctx.userId || 'default',
        ctx.personaId || null,
        ctx.provider || 'unknown',
        ctx.model || 'unknown',
      )
      .run()
    return true
  } catch (e) {
    warn('ensureLedgerRun', e)
    return false
  }
}

export async function finishLedgerRun(
  db: D1Database | null | undefined,
  runId: string,
  finish: FinishLedgerRunInput,
): Promise<boolean> {
  if (!db || typeof db.prepare !== 'function') return false
  try {
    await db
      .prepare(
        `UPDATE ai_runs SET status = ?, requested_tool_calls = ?, executed_tool_calls = ?,
         elapsed_ms = ?, error_code = ?, finished_at = datetime('now')
         WHERE run_id = ?`,
      )
      .bind(
        finish.status,
        finish.requestedToolCalls ?? 0,
        finish.executedToolCalls ?? 0,
        finish.elapsedMs ?? null,
        finish.errorCode || null,
        runId,
      )
      .run()
    return true
  } catch (e) {
    warn('finishLedgerRun', e)
    return false
  }
}

export async function recordToolExecution(
  db: D1Database | null | undefined,
  input: RecordToolExecutionInput,
): Promise<RecordToolExecutionResult> {
  const toolCallId = input.toolCallId || newToolCallId()
  const fallback: RecordToolExecutionResult = {
    recorded: false,
    ledgerId: null,
    runId: input.runId,
    toolCallId,
  }
  if (!db || typeof db.prepare !== 'function') return fallback
  const mode = input.mode ?? (isFCWriteTool(input.toolName) ? 'write' : 'read')
  const status = deriveStatus(input)
  await ensureLedgerRun(db, input)
  let ledgerId: number | null = null
  try {
    const r = await db
      .prepare(
        `INSERT INTO ai_tool_runs (run_id, tool_call_id, tool_name, mode, status, duration_ms, error_code, cache_hit, operation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))`,
      )
      .bind(
        input.runId,
        toolCallId,
        input.toolName,
        mode,
        status,
        typeof input.durationMs === 'number' ? Math.max(0, Math.round(input.durationMs)) : null,
        input.success ? null : String(input.error || 'error').slice(0, 120),
        mode === 'write' ? toolCallId : null,
      )
      .run()
    const rawId = r?.meta?.last_row_id
    ledgerId = typeof rawId === 'number' && Number.isFinite(rawId) ? rawId : null
  } catch (e) {
    warn('recordToolExecution:ai_tool_runs', e)
    return fallback
  }
  if (mode === 'write') {
    try {
      await db
        .prepare(
          `INSERT INTO ai_tool_operations (user_id, operation_id, request_id, tool_name, args_hash, status, result_ref, error_code, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        )
        .bind(
          input.userId || 'default',
          toolCallId,
          input.requestId || input.runId,
          input.toolName,
          hashToolArgs(input.args),
          input.success ? 'succeeded' : 'failed',
          input.success ? deriveResultRef(input.toolName, input.resultData) : null,
          input.success ? null : String(input.error || 'error').slice(0, 120),
        )
        .run()
    } catch (e) {
      warn('recordToolExecution:ai_tool_operations', e)
    }
  }
  return { recorded: true, ledgerId, runId: input.runId, toolCallId }
}

export async function recordMarkerToolExecution(
  ctx: MarkerToolExecutionContext,
  input: MarkerToolExecutionInput,
): Promise<RecordToolExecutionResult> {
  const recorded = await recordToolExecution(ctx.env?.DB, {
    runId: ctx.ledgerRunId || newLedgerRunId(),
    requestId: ctx.ledgerRequestId,
    userId: ctx.ledgerUserId || 'default',
    personaId: ctx.ledgerPersonaId,
    toolName: input.toolName,
    mode: input.mode,
    success: input.success,
    durationMs: Date.now() - input.startedAt,
    error: input.error,
    args: input.args,
    resultData: input.resultData,
  })
  if (Array.isArray(ctx.ledgerExecutions)) {
    ctx.ledgerExecutions.push({
      toolName: input.toolName,
      success: input.success,
      ledgerRecorded: recorded.recorded,
    })
  }
  return recorded
}

export function isLedgerVerifiedSuccess(result: LedgerExecutionLike | null | undefined): boolean {
  return !!result && result.success === true && result.ledgerRecorded === true
}

export function findLedgerVerifiedSuccess(
  results: LedgerExecutionLike[] | null | undefined,
  toolNames: string[],
): LedgerExecutionLike | null {
  if (!Array.isArray(results)) return null
  return results.find((r) => toolNames.includes(r?.toolName as string) && isLedgerVerifiedSuccess(r)) ?? null
}

export function hasUnverifiedSuccess(
  results: LedgerExecutionLike[] | null | undefined,
  toolNames: string[],
): boolean {
  if (!Array.isArray(results)) return false
  return results.some(
    (r) => toolNames.includes(r?.toolName as string) && r?.success === true && !isLedgerVerifiedSuccess(r),
  )
}
