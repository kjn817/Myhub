export const PRUNE_BATCH_LIMIT = 5000
export const LOG_PRUNE_MARKER_KEY = 'log_prune.last_date'
export const PRUNE_WEEKDAY_KST = 0
export const PRUNE_HOUR_KST = 4

export interface LogPrunePolicy {
  table: string
  column: string
  retentionDays: number
  reason: string
}

export const LOG_PRUNE_POLICIES: LogPrunePolicy[] = [
  { table: 'google_sync_log', column: 'created_at', retentionDays: 90, reason: '동기화 감사 로그 — 정보량은 상태·건수뿐' },
  { table: 'ai_error_log', column: 'created_at', retentionDays: 90, reason: '프로바이더 에러 디버깅 로그' },
  { table: 'clef_decision_log', column: 'created_at', retentionDays: 90, reason: 'Clef 결정 로그 — 결정당 1행으로 가장 빨리 쌓이는 축' },
  { table: 'ai_memo_audit', column: 'created_at', retentionDays: 90, reason: 'AI 메모 접근 감사 로그' },
  { table: 'tool_execution_audit', column: 'created_at', retentionDays: 90, reason: '도구 실행 감사 로그' },
  { table: 'artifact_job_events', column: 'created_at', retentionDays: 90, reason: '잡 이벤트 스트림 — 잡 본체가 아니라 이벤트만' },
  { table: 'memory_consolidation_log', column: 'created_at', retentionDays: 90, reason: '수면 통합 실행 로그' },
  { table: 'ai_usage', column: 'created_at', retentionDays: 180, reason: '사용량 원장 — 추세 확인용으로 반년 보존' },
]

export interface LogPruneTableResult {
  table: string
  deleted: number
  capped: boolean
  error?: string
}

export interface LogPruneResult {
  tables: LogPruneTableResult[]
  rateLimitsDeleted: number
  rateLimitsError?: string
  totalDeleted: number
}

export function pruneCutoffIso(now: Date, retentionDays: number): string {
  const t = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  return t.toISOString().replace('T', ' ').slice(0, 19)
}

export async function runLogPrune(env: { DB: D1Database }, now: Date = new Date()): Promise<LogPruneResult> {
  const tables: LogPruneTableResult[] = []
  let totalDeleted = 0
  for (const p of LOG_PRUNE_POLICIES) {
    const cutoff = pruneCutoffIso(now, p.retentionDays)
    try {
      const r = await env.DB.prepare(
        `DELETE FROM ${p.table} WHERE id IN (SELECT id FROM ${p.table} WHERE ${p.column} < ? ORDER BY id ASC LIMIT ?)`,
      )
        .bind(cutoff, PRUNE_BATCH_LIMIT)
        .run()
      const deleted = r.meta?.changes ?? 0
      tables.push({ table: p.table, deleted, capped: deleted >= PRUNE_BATCH_LIMIT })
      totalDeleted += deleted
    } catch (e) {
      tables.push({
        table: p.table,
        deleted: 0,
        capped: false,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      })
    }
  }
  let rateLimitsDeleted = 0
  let rateLimitsError: string | undefined
  try {
    const nowIso = now.toISOString()
    const r = await env.DB.prepare(
      `DELETE FROM rate_limits WHERE window_expires_at IS NOT NULL AND window_expires_at <= ?`,
    )
      .bind(nowIso)
      .run()
    rateLimitsDeleted = r.meta?.changes ?? 0
    totalDeleted += rateLimitsDeleted
  } catch (e) {
    rateLimitsError = (e instanceof Error ? e.message : String(e)).slice(0, 200)
  }
  return { tables, rateLimitsDeleted, rateLimitsError, totalDeleted }
}

export async function getLastPruneDate(env: { DB: D1Database }): Promise<string | null> {
  try {
    const row = await env.DB.prepare('SELECT value FROM ai_settings WHERE key = ?')
      .bind(LOG_PRUNE_MARKER_KEY)
      .first<{ value: string }>()
    return row?.value ?? null
  } catch {
    return null
  }
}

export async function markPruneRun(env: { DB: D1Database }, kstDate: string): Promise<void> {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO ai_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
  )
    .bind(LOG_PRUNE_MARKER_KEY, kstDate)
    .run()
}
