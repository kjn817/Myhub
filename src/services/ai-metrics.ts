/**
 * 운영 지표 산출 (GPT 재평가 P1 — 2026-10-30)
 *
 * 데이터 근거 (전부 기존 테이블, 신규 수집 없음):
 * - ai_usage: LLM 호출 원장. provider·model·capability·latency_ms·
 *   input/output_tokens·neurons(0064)·outcome·trace_id·created_at.
 *   0065(병렬 트랙)가 engine·persona 컬럼을 추가한다.
 *   어휘 계약: engine ∈ marker|builtin-fc|registry-fc|degraded,
 *   NULL = 레거시(unknown). persona는 personaId 문자열, NULL 가능.
 * - ai_error_log: 프로바이더 오류 로그 (건수·프로바이더별 분포만 사용).
 * - tool_execution_audit(0055): 승인 흐름 감사. action ∈
 *   preview_shown|executed|denied|expired|blocked.
 * - tool_approval_requests(0052+0063): status 분포와 executed_at
 *   원자 선점(claim) 건수.
 *
 * 산출 불가 지표는 0으로 위장하지 않는다:
 * - "중복 실행 차단 시도"는 차단이 일어날 때 남는 영속 기록이 없다.
 *   실행 선점(claim)은 성공한 1건만 executed_at으로 남고, 선점에 실패한
 *   재시도 호출은 어디에도 기록되지 않는다. 따라서 이 지표는
 *   null + 사유로 반환한다 (duplicateExecutionBlockedAttempts).
 *
 * 스키마 방어: 0065가 아직 적용되지 않은 DB(컬럼 부재)에서도 500으로
 * 죽지 않는다. pragma_table_info로 컬럼 존재를 먼저 확인하고,
 * 없으면 해당 차원은 전부 unknown 버킷으로 집계하며 schema 플래그로
 * 그 사실을 응답에 명시한다. tool_approval_requests.executed_at(0063)
 * 도 같은 방식으로 방어한다 (없으면 executedClaimCount=null + 사유).
 */

export const METRICS_DEFAULT_DAYS = 14
export const METRICS_MAX_DAYS = 90

export const ENGINE_VOCAB = ['marker', 'builtin-fc', 'registry-fc', 'degraded'] as const
export type EngineName = (typeof ENGINE_VOCAB)[number] | 'unknown'

export interface UsageRow {
  provider?: string | null
  model?: string | null
  capability?: string | null
  latency_ms?: number | null
  input_tokens?: number | null
  output_tokens?: number | null
  neurons?: number | null
  outcome?: string | null
  trace_id?: string | null
  engine?: string | null
  persona?: string | null
  created_at?: string | null
}

export interface GroupSummary {
  requests: number
  success: number
  failed: number
  rateLimited: number
  /** success/failed/rate_limited 어디에도 속하지 않는 outcome 건수 */
  other: number
  /** success / requests. requests=0이면 null */
  successRate: number | null
  /** (requests - success) / requests. requests=0이면 null */
  failureRate: number | null
  /** latency_ms가 있는 행만으로 계산. 없으면 null */
  p50LatencyMs: number | null
  p95LatencyMs: number | null
  inputTokens: number
  outputTokens: number
  totalTokens: number
  neurons: number
}

export interface FallbackSummary {
  method: string
  /** trace_id가 있는 서로 다른 트레이스 수 */
  traceTurns: number
  /** 비성공 행이 1개 이상 있는 트레이스 수 */
  tracesWithFailure: number
  /** 비성공 행 뒤에 성공 행이 다시 온 트레이스 수 (폴백 회복 근사) */
  recoveredTurns: number
  /** recoveredTurns / tracesWithFailure. 분모 0이면 null */
  recoveryRate: number | null
  approximate: true
}

export interface UsageAggregate {
  overall: GroupSummary
  byPersona: Record<string, GroupSummary>
  byEngine: Record<string, GroupSummary>
  byProvider: Record<string, GroupSummary>
}

/** days 파라미터 파싱: 기본 14, 1~90으로 클램프. 숫자가 아니면 기본값. */
export function parseMetricsDays(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw === '') return METRICS_DEFAULT_DAYS
  const n = parseInt(raw, 10)
  if (Number.isNaN(n)) return METRICS_DEFAULT_DAYS
  return Math.min(Math.max(n, 1), METRICS_MAX_DAYS)
}

/** nearest-rank 백분위. 빈 배열이면 null. 입력 배열은 변형하지 않는다. */
export function percentile(values: number[], p: number): number | null {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (nums.length === 0) return null
  const sorted = [...nums].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]
}

/** engine 어휘 정규화: 계약 어휘 밖·NULL·빈 값은 전부 unknown(레거시). */
export function normalizeEngine(v: string | null | undefined): EngineName {
  if (v && (ENGINE_VOCAB as readonly string[]).includes(v)) return v as EngineName
  return 'unknown'
}

/** persona 정규화: NULL·빈 값은 unknown 버킷. */
export function normalizePersona(v: string | null | undefined): string {
  const s = (v ?? '').trim()
  return s === '' ? 'unknown' : s
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export function summarizeGroup(rows: UsageRow[]): GroupSummary {
  const requests = rows.length
  let success = 0
  let failed = 0
  let rateLimited = 0
  let other = 0
  let inputTokens = 0
  let outputTokens = 0
  let neurons = 0
  const latencies: number[] = []
  for (const r of rows) {
    if (r.outcome === 'success') success++
    else if (r.outcome === 'failed') failed++
    else if (r.outcome === 'rate_limited') rateLimited++
    else other++
    inputTokens += num(r.input_tokens)
    outputTokens += num(r.output_tokens)
    neurons += num(r.neurons)
    if (typeof r.latency_ms === 'number' && Number.isFinite(r.latency_ms)) {
      latencies.push(r.latency_ms)
    }
  }
  return {
    requests,
    success,
    failed,
    rateLimited,
    other,
    successRate: requests === 0 ? null : success / requests,
    failureRate: requests === 0 ? null : (requests - success) / requests,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    neurons,
  }
}

function groupBy(rows: UsageRow[], keyOf: (r: UsageRow) => string): Record<string, GroupSummary> {
  const buckets = new Map<string, UsageRow[]>()
  for (const r of rows) {
    const k = keyOf(r)
    const arr = buckets.get(k)
    if (arr) arr.push(r)
    else buckets.set(k, [r])
  }
  const out: Record<string, GroupSummary> = {}
  for (const [k, arr] of buckets) out[k] = summarizeGroup(arr)
  return out
}

/**
 * 전체·비서별·경로별·프로바이더별 집계.
 * engine/persona 컬럼이 없는 행(NULL 포함)은 unknown 버킷으로 분리된다.
 */
export function aggregateUsage(rows: UsageRow[]): UsageAggregate {
  return {
    overall: summarizeGroup(rows),
    byPersona: groupBy(rows, (r) => normalizePersona(r.persona)),
    byEngine: groupBy(rows, (r) => normalizeEngine(r.engine)),
    byProvider: groupBy(rows, (r) => (r.provider ?? '').trim() || 'unknown'),
  }
}

/**
 * 폴백 근사: trace_id로 묶어, 비성공 행이 나온 뒤 같은 트레이스에서
 * 성공 행이 다시 오면 "폴백으로 회복된 턴"으로 센다 (트레이스당 최대 1).
 * 행 순서(id 오름차순 = 호출 순서)를 전제한다. 재시도·모델 교체 등
 * 실제 폴백 메커니즘을 직접 기록한 값이 아니므로 근사임을 명시한다.
 */
export function countFallbackTraces(rows: UsageRow[]): FallbackSummary {
  const traces = new Map<string, UsageRow[]>()
  for (const r of rows) {
    const t = (r.trace_id ?? '').trim()
    if (!t) continue
    const arr = traces.get(t)
    if (arr) arr.push(r)
    else traces.set(t, [r])
  }
  let tracesWithFailure = 0
  let recoveredTurns = 0
  for (const arr of traces.values()) {
    let seenFailure = false
    let recovered = false
    for (const r of arr) {
      if (r.outcome === 'success') {
        if (seenFailure) recovered = true
      } else {
        seenFailure = true
      }
    }
    if (seenFailure) tracesWithFailure++
    if (recovered) recoveredTurns++
  }
  return {
    method:
      'trace_id 그룹에서 비성공 행 뒤에 성공 행이 오는 트레이스를 폴백 회복으로 근사 집계 (트레이스당 최대 1건). 실제 폴백 메커니즘의 직접 기록이 아니다.',
    traceTurns: traces.size,
    tracesWithFailure,
    recoveredTurns,
    recoveryRate: tracesWithFailure === 0 ? null : recoveredTurns / tracesWithFailure,
    approximate: true,
  }
}

export interface ApprovalMetrics {
  audit: {
    total: number
    byAction: Record<string, number>
    /** tool_execution_audit의 action='executed' 건수 (실행 성공률의 분자 근사) */
    executed: number
  }
  requests: {
    total: number
    byStatus: Record<string, number>
    /** executed_at(0063)이 채워진 건수 = 실행 선점이 실제로 일어난 건수. 컬럼이 없으면 null */
    executedClaimCount: number | null
    executedClaimUnavailableReason: string | null
  }
  /** 영속 기록이 없어 산출 불가 — 0으로 위장하지 않고 null로 반환한다 */
  duplicateExecutionBlockedAttempts: null
  duplicateExecutionBlockedAttemptsReason: string
}

export const DUPLICATE_BLOCKED_REASON =
  '중복 실행 차단 시도는 영속 기록이 없다: 0063의 executed_at 선점은 성공한 호출 1건만 남기고, 선점에 실패한 재시도 호출은 ai_usage·tool_execution_audit·tool_approval_requests 어디에도 기록되지 않는다. executedClaimCount는 "선점된 실행 수"일 뿐 차단 시도 수가 아니다.'

export function summarizeApprovals(
  auditActions: string[],
  requests: { status?: string | null; executed_at?: string | null }[],
  opts: { executedAtColumn: boolean },
): ApprovalMetrics {
  const byAction: Record<string, number> = {
    preview_shown: 0,
    executed: 0,
    denied: 0,
    expired: 0,
    blocked: 0,
  }
  for (const a of auditActions) {
    byAction[a] = (byAction[a] ?? 0) + 1
  }
  const byStatus: Record<string, number> = {}
  let claimCount = 0
  for (const r of requests) {
    const s = (r.status ?? '').trim() || 'unknown'
    byStatus[s] = (byStatus[s] ?? 0) + 1
    if (r.executed_at) claimCount++
  }
  return {
    audit: { total: auditActions.length, byAction, executed: byAction.executed ?? 0 },
    requests: {
      total: requests.length,
      byStatus,
      executedClaimCount: opts.executedAtColumn ? claimCount : null,
      executedClaimUnavailableReason: opts.executedAtColumn
        ? null
        : 'tool_approval_requests.executed_at 컬럼이 없다 (마이그레이션 0063 미적용) — 선점 건수를 산출할 수 없다.',
    },
    duplicateExecutionBlockedAttempts: null,
    duplicateExecutionBlockedAttemptsReason: DUPLICATE_BLOCKED_REASON,
  }
}

// ---------------- DB 조회 (스키마 방어 포함) ----------------

type Db = D1Database

async function tableColumns(db: Db, table: string): Promise<Set<string> | null> {
  try {
    const { results } = await db
      .prepare(`SELECT name FROM pragma_table_info('${table}')`)
      .all<{ name: string }>()
    if (!results || results.length === 0) return null
    return new Set(results.map((r) => r.name))
  } catch {
    return null
  }
}

async function safeAll<T>(db: Db, sql: string, modifier: string): Promise<T[]> {
  try {
    const { results } = await db.prepare(sql).bind(modifier).all<T>()
    return results || []
  } catch {
    return []
  }
}

export interface AiMetricsResult {
  days: number
  generatedAt: string
  schema: {
    aiUsageTable: boolean
    aiUsageEngineColumn: boolean
    aiUsagePersonaColumn: boolean
    approvalExecutedAtColumn: boolean
    /** 0065 미적용 시 engine/persona 차원이 unknown으로 접힌다는 고지 */
    note: string
  }
  usage: UsageAggregate
  fallback: FallbackSummary
  errors: {
    total: number
    byProvider: Record<string, number>
  }
  approvals: ApprovalMetrics
  notes: string[]
}

/**
 * 기간 내 운영 지표를 산출한다. 어떤 테이블·컬럼이 없어도 throw하지
 * 않고, 없는 부분은 빈 집계 + schema/사유 필드로 정직하게 표기한다.
 */
export async function getAiMetrics(db: Db, days: number): Promise<AiMetricsResult> {
  const modifier = `-${days} days`
  const usageCols = await tableColumns(db, 'ai_usage')
  const hasEngine = usageCols?.has('engine') ?? false
  const hasPersona = usageCols?.has('persona') ?? false
  const hasNeurons = usageCols?.has('neurons') ?? false
  const approvalCols = await tableColumns(db, 'tool_approval_requests')
  const hasExecutedAt = approvalCols?.has('executed_at') ?? false

  const usageSelect = [
    'provider', 'model', 'capability', 'latency_ms', 'input_tokens',
    'output_tokens', 'outcome', 'trace_id', 'created_at',
    // 0064(neurons) 미적용 DB에서 SELECT 전체가 실패해 사용량 집계가
    // 통째로 비는 것을 막는다 — 없으면 행의 neurons는 undefined→0으로 집계.
    ...(hasNeurons ? ['neurons'] : []),
    ...(hasEngine ? ['engine'] : []),
    ...(hasPersona ? ['persona'] : []),
  ].join(', ')
  const usageRows = usageCols
    ? await safeAll<UsageRow>(
        db,
        `SELECT ${usageSelect} FROM ai_usage WHERE created_at >= datetime('now', ?) ORDER BY id ASC`,
        modifier,
      )
    : []

  const errorRows = await safeAll<{ provider?: string | null }>(
    db,
    `SELECT provider FROM ai_error_log WHERE created_at >= datetime('now', ?)`,
    modifier,
  )
  const errorByProvider: Record<string, number> = {}
  for (const r of errorRows) {
    const p = (r.provider ?? '').trim() || 'unknown'
    errorByProvider[p] = (errorByProvider[p] ?? 0) + 1
  }

  const auditRows = await safeAll<{ action?: string | null }>(
    db,
    `SELECT action FROM tool_execution_audit WHERE created_at >= datetime('now', ?)`,
    modifier,
  )
  const requestRows = await safeAll<{ status?: string | null; executed_at?: string | null }>(
    db,
    hasExecutedAt
      ? `SELECT status, executed_at FROM tool_approval_requests WHERE created_at >= datetime('now', ?)`
      : `SELECT status FROM tool_approval_requests WHERE created_at >= datetime('now', ?)`,
    modifier,
  )

  const notes: string[] = [
    '성공 판정은 ai_usage.outcome 기준: success만 성공, failed·rate_limited·기타는 실패로 계산한다.',
    'p50/p95는 기간 내 latency_ms 값들을 모아 nearest-rank로 계산한다 (SQL 근사 아님).',
    '폴백 지표는 trace_id 기반 근사다 (fallback.method 참조).',
  ]
  if (!hasEngine || !hasPersona) {
    notes.push(
      'ai_usage에 engine/persona 컬럼이 없어(0065 미적용) 해당 차원은 전부 unknown 버킷으로 집계했다. 컬럼이 생기면 같은 엔드포인트가 자동으로 분리 집계한다.',
    )
  }

  return {
    days,
    generatedAt: new Date().toISOString(),
    schema: {
      aiUsageTable: usageCols !== null,
      aiUsageEngineColumn: hasEngine,
      aiUsagePersonaColumn: hasPersona,
      approvalExecutedAtColumn: hasExecutedAt,
      note:
        usageCols === null
          ? 'ai_usage 테이블이 없거나 읽을 수 없어 사용량 집계가 비어 있다.'
          : hasEngine && hasPersona
            ? '0065 적용됨: engine·persona 분리 집계.'
            : '0065 미적용: engine/persona는 unknown 버킷으로 분리 집계 (500으로 죽지 않음).',
    },
    usage: aggregateUsage(usageRows),
    fallback: countFallbackTraces(usageRows),
    errors: { total: errorRows.length, byProvider: errorByProvider },
    approvals: summarizeApprovals(
      auditRows.map((r) => (r.action ?? '').trim() || 'unknown'),
      requestRows,
      { executedAtColumn: hasExecutedAt },
    ),
    notes,
  }
}
