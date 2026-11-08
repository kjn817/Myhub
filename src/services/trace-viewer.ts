/**
 * 트레이스 뷰어 조회 서비스 (트랙 C2+C3)
 *
 * 마이그레이션 0057의 OTEL 스팬 필드로 D1에 남긴 ai_usage( LLM 호출 )와
 * tool_execution_audit(도구 실행 감사)를 하나의 타임라인용 스팬 목록으로
 * 합친다. 외부 전송 없음 — D1 읽기만 한다.
 *
 * 보안: 스팬에는 모델·토큰·소요시간·상태만 담는다. ai_usage에는 애초에
 * 본문이 없고 tool_execution_audit.detail은 마스킹된 값만 들어가므로
 * 잠긴 메모 내용은 여기에 나타날 수 없다. detail은 뷰어에 노출하지 않는다.
 */

export type TraceSpanStatus = 'ok' | 'error' | 'cached' | 'blocked' | 'denied'

export type TraceSpanKind = 'llm' | 'tool'

export interface TraceSpan {
  traceId: string
  spanId: string
  parentSpanId: string | null
  kind: TraceSpanKind
  /** LLM: 모델명, 도구: 도구명 */
  name: string
  status: TraceSpanStatus
  /** ISO 시각 (스팬 종료 시점 — created_at) */
  endedAt: string
  /** ms (latency_ms / duration_ms) */
  durationMs: number
  /** 부모 연결로 계산한 중첩 깊이 (루트=0) */
  depth: number
  model?: string
  inputTokens?: number | null
  outputTokens?: number | null
  promptVersion?: string | null
  toolCallId?: string | null
}

export interface TraceSummary {
  traceId: string
  startedAt: string
  spanCount: number
  /** 트레이스 전체 소요 (첫 스팬 종료 ~ 마지막 스팬 종료, ms) */
  totalMs: number
  hasError: boolean
}

const TRACE_LIST_LIMIT_MAX = 50
const TRACE_SPAN_LIMIT = 500

function toInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function toNullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.floor(n) : null
}

function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const s = String(value)
  return s === '' ? null : s
}

/** ai_usage.outcome → 스팬 상태 (success 외는 전부 error) */
function llmStatus(outcome: unknown): TraceSpanStatus {
  return outcome === 'success' ? 'ok' : 'error'
}

/**
 * tool_execution_audit → 스팬 상태.
 * status 컬럼(OTEL 의미: ok|error)이 있으면 그것을 우선하고,
 * 없으면(0057 적용 전 행) 감사 action에서 유추한다.
 */
function auditStatus(action: unknown, status: unknown): TraceSpanStatus {
  if (status === 'ok' || status === 'error') return status
  switch (action) {
    case 'executed':
    case 'preview_shown':
      return 'ok'
    case 'denied':
      return 'denied'
    case 'expired':
    case 'blocked':
      return 'blocked'
    default:
      return 'ok'
  }
}

/** ai_tool_runs.status → 스팬 상태 (FC 경로 도구 호출) */
function toolRunStatus(status: unknown): TraceSpanStatus {
  switch (status) {
    case 'success':
      return 'ok'
    case 'cached':
      return 'cached'
    case 'blocked':
      return 'blocked'
    case 'error':
      return 'error'
    default:
      return 'ok'
  }
}

/**
 * ai_tool_runs.status → 스팬 상태 (FC 경로 도구 호출)
 */
type RawSpanRow = Record<string, unknown>

/** 부모 연결로 깊이를 계산한다. 순환·누락된 부모는 깊이 0으로 끊는다. */
export function computeDepths(spans: TraceSpan[]): TraceSpan[] {
  const byId = new Map(spans.map((s) => [s.spanId, s]))
  const depthOf = (span: TraceSpan, seen: Set<string>): number => {
    if (!span.parentSpanId) return 0
    if (seen.has(span.spanId)) return 0
    const parent = byId.get(span.parentSpanId)
    if (!parent) return 0
    seen.add(span.spanId)
    return depthOf(parent, seen) + 1
  }
  return spans.map((s) => ({ ...s, depth: depthOf(s, new Set()) }))
}

/** 최근 트레이스 목록 — 최신순. trace_id가 있는 행만 대상. */
export async function listRecentTraces(db: D1Database, limit = 20): Promise<TraceSummary[]> {
  const n = Math.max(1, Math.min(TRACE_LIST_LIMIT_MAX, Math.floor(limit) || 20))
  const { results } = await db
    .prepare(
      `SELECT trace_id AS traceId, MIN(created_at) AS startedAt, COUNT(*) AS spanCount,
              CAST(ROUND((julianday(MAX(created_at)) - julianday(MIN(created_at))) * 86400000) AS INTEGER) AS totalMs,
              MAX(CASE WHEN outcome NOT IN ('success') OR status = 'error' THEN 1 ELSE 0 END) AS hasError
       FROM (
         SELECT trace_id, created_at, latency_ms, NULL AS duration_ms, outcome, NULL AS status
         FROM ai_usage WHERE trace_id IS NOT NULL AND trace_id != ''
         UNION ALL
         SELECT trace_id, created_at, NULL AS latency_ms, duration_ms, NULL AS outcome, status
         FROM tool_execution_audit WHERE trace_id IS NOT NULL AND trace_id != ''
         UNION ALL
         SELECT trace_id, created_at, NULL AS latency_ms, duration_ms,
                CASE WHEN status = 'success' THEN 'success' ELSE status END AS outcome,
                CASE WHEN status = 'success' THEN 'ok' WHEN status = 'error' THEN 'error' ELSE NULL END AS status
         FROM ai_tool_runs WHERE trace_id IS NOT NULL AND trace_id != ''
       )
       GROUP BY trace_id ORDER BY startedAt DESC LIMIT ?`,
    )
    .bind(n)
    .all<RawSpanRow>()
  return (results ?? []).map((row) => ({
    traceId: String(row.traceId ?? ''),
    startedAt: String(row.startedAt ?? ''),
    spanCount: toInt(row.spanCount),
    totalMs: toInt(row.totalMs),
    hasError: Number(row.hasError ?? 0) === 1,
  }))
}

/** 한 트레이스의 전체 스팬 — 종료 시각순 (타임라인 렌더링용). */
export async function getTraceSpans(db: D1Database, traceId: string): Promise<TraceSpan[]> {
  const llm = await db
    .prepare(
      `SELECT trace_id AS traceId, span_id AS spanId, parent_span_id AS parentSpanId,
              model, input_tokens AS inputTokens, output_tokens AS outputTokens,
              latency_ms AS durationMs, outcome, prompt_version AS promptVersion,
              created_at AS createdAt
       FROM ai_usage WHERE trace_id = ? ORDER BY created_at ASC LIMIT ?`,
    )
    .bind(traceId, TRACE_SPAN_LIMIT)
    .all<RawSpanRow>()
  const tools = await db
    .prepare(
      `SELECT trace_id AS traceId, span_id AS spanId, parent_span_id AS parentSpanId,
              tool AS toolName, tool_call_id AS toolCallId, duration_ms AS durationMs,
              action, status, created_at AS createdAt
       FROM tool_execution_audit WHERE trace_id = ? ORDER BY created_at ASC LIMIT ?`,
    )
    .bind(traceId, TRACE_SPAN_LIMIT)
    .all<RawSpanRow>()
  const toolRuns = await db
    .prepare(
      `SELECT trace_id AS traceId, span_id AS spanId, parent_span_id AS parentSpanId,
              tool_name AS toolName, tool_call_id AS toolCallId, duration_ms AS durationMs,
              status, created_at AS createdAt
       FROM ai_tool_runs WHERE trace_id = ? ORDER BY created_at ASC LIMIT ?`,
    )
    .bind(traceId, TRACE_SPAN_LIMIT)
    .all<RawSpanRow>()

  const spans: TraceSpan[] = []
  for (const row of llm.results ?? []) {
    spans.push({
      traceId: String(row.traceId ?? traceId),
      spanId: String(row.spanId ?? ''),
      parentSpanId: toNullableString(row.parentSpanId),
      kind: 'llm',
      name: String(row.model ?? ''),
      status: llmStatus(row.outcome),
      endedAt: String(row.createdAt ?? ''),
      durationMs: toInt(row.durationMs),
      depth: 0,
      model: String(row.model ?? ''),
      inputTokens: toNullableInt(row.inputTokens),
      outputTokens: toNullableInt(row.outputTokens),
      promptVersion: toNullableString(row.promptVersion),
    })
  }
  for (const row of tools.results ?? []) {
    spans.push({
      traceId: String(row.traceId ?? traceId),
      spanId: String(row.spanId ?? ''),
      parentSpanId: toNullableString(row.parentSpanId),
      kind: 'tool',
      name: String(row.toolName ?? ''),
      status: auditStatus(row.action, row.status),
      endedAt: String(row.createdAt ?? ''),
      durationMs: toInt(row.durationMs),
      depth: 0,
      toolCallId: toNullableString(row.toolCallId),
    })
  }
  for (const row of toolRuns.results ?? []) {
    spans.push({
      traceId: String(row.traceId ?? traceId),
      spanId: String(row.spanId ?? ''),
      parentSpanId: toNullableString(row.parentSpanId),
      kind: 'tool',
      name: String(row.toolName ?? ''),
      status: toolRunStatus(row.status),
      endedAt: String(row.createdAt ?? ''),
      durationMs: toInt(row.durationMs),
      depth: 0,
      toolCallId: toNullableString(row.toolCallId),
    })
  }
  // 종료 시각순 정렬 (created_at이 동률이면 LLM 스팬을 먼저)
  spans.sort((a, b) => {
    if (a.endedAt !== b.endedAt) return a.endedAt < b.endedAt ? -1 : 1
    return a.kind === b.kind ? 0 : a.kind === 'llm' ? -1 : 1
  })
  return computeDepths(spans)
}
