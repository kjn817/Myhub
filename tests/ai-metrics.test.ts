/**
 * 운영 지표 API 테스트 (src/services/ai-metrics.ts + GET /api/ai/metrics)
 *
 * 검증 방식: 고정 픽스처 행들의 기대값을 손계산으로 적어 두고 대조한다.
 * - p50/p95 (nearest-rank), 성공률·실패율 분모/분자, 토큰·뉴런 합
 * - engine NULL → unknown 분리, persona NULL → unknown 분리
 * - 폴백 근사: trace_id 그룹에서 실패 뒤 성공이 온 트레이스만 회복으로 셈
 * - 스키마 방어: 0065(engine·persona) 컬럼이 없는 DB에서도 200 + unknown 집계
 * - 중복 실행 차단 시도: 영속 기록이 없으므로 null + 사유 (0 위장 금지)
 *
 * 라우트는 admin-routes 전체를 import하면 무거운 서비스 mock이 대량으로
 * 필요하므로, 같은 핸들러 조합(getAiMetrics + parseMetricsDays)을 얇은
 * Hono 앱에 그대로 마운트해 HTTP 경유로 검증한다. 순수 집계 함수는
 * 직접 단위 테스트한다. 인증은 전역 미들웨어(index.ts) 소관이라
 * 모듈 단위 테스트에서는 다루지 않는다 (기존 모듈 테스트와 동일).
 */
/// <reference types="jest" />
import { Hono } from 'hono'
import {
  aggregateUsage,
  countFallbackTraces,
  getAiMetrics,
  parseMetricsDays,
  percentile,
  summarizeApprovals,
  type UsageRow,
} from '../src/services/ai-metrics'
import * as fs from 'fs'
import * as path from 'path'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createLocalD1 } = require('./helpers/local-d1.cjs')

const readMigration = (name: string) =>
  fs.readFileSync(path.join(__dirname, '../migrations', name), 'utf8')

// ---------------- 손계산 픽스처 ----------------
// id 순 = 호출 순. 기대값:
//  전체: 12건, success 6 (1,3,6,7,9,12), failed 5 (2,4,8,10,11), rate_limited 1 (5)
//        성공률 0.5, 실패율 0.5
//        latency 10..120 (10 간격) → p50=60 (6번째), p95=120 (12번째)
//        input 합 1295, output 합 530, total 1825, neurons 합 27 (5+7+3+2+10)
//  engine marker(1,2,9): 3건 success2 lat[10,20,90] p50=20 p95=90 in260 out125 neurons7
//  engine builtin-fc(3,10,11): 3건 success1 lat[30,100,110] p50=100 p95=110 in260 out80 neurons7
//  engine registry-fc(4,5): 2건 success0 lat[40,50] p50=40 p95=50 in20 out0
//  engine degraded(6,12): 2건 success2 lat[60,120] p50=60 p95=120 in700 out300 neurons13
//  engine unknown(7,8; NULL): 2건 success1 lat[70,80] p50=70 p95=80 in55 out25
//  persona keeper(1,2,3,9): 4건 success3 lat[10,20,30,90] p50=20 p95=90 in460 out205 neurons14
//  persona concierge(4,5,6,10,11,12): 6건 success2 lat[40,50,60,100,110,120] p50=60 p95=120 in780 out300 neurons13
//  persona unknown(7,8): engine unknown과 동일 행 집합
//  폴백: 트레이스 4개 (t-clean 성공만 / t-fallback 실패→성공 회복 /
//        t-fail 실패+제한, 회복 없음 / t-multi 실패,실패→성공 회복)
//        → traceTurns 4, tracesWithFailure 3, recoveredTurns 2, recoveryRate 2/3
const FIXTURE: UsageRow[] = [
  { provider: 'gemini', latency_ms: 10, input_tokens: 100, output_tokens: 50, neurons: 5, outcome: 'success', trace_id: 't-clean', engine: 'marker', persona: 'keeper' },
  { provider: 'gemini', latency_ms: 20, input_tokens: 10, output_tokens: 0, neurons: null, outcome: 'failed', trace_id: 't-fallback', engine: 'marker', persona: 'keeper' },
  { provider: 'workers-ai', latency_ms: 30, input_tokens: 200, output_tokens: 80, neurons: 7, outcome: 'success', trace_id: 't-fallback', engine: 'builtin-fc', persona: 'keeper' },
  { provider: 'groq', latency_ms: 40, input_tokens: 20, output_tokens: 0, neurons: null, outcome: 'failed', trace_id: 't-fail', engine: 'registry-fc', persona: 'concierge' },
  { provider: 'groq', latency_ms: 50, input_tokens: 0, output_tokens: 0, neurons: null, outcome: 'rate_limited', trace_id: 't-fail', engine: 'registry-fc', persona: 'concierge' },
  { provider: 'workers-ai', latency_ms: 60, input_tokens: 300, output_tokens: 100, neurons: 3, outcome: 'success', trace_id: null, engine: 'degraded', persona: 'concierge' },
  { provider: 'gemini', latency_ms: 70, input_tokens: 50, output_tokens: 25, neurons: null, outcome: 'success', trace_id: null, engine: null, persona: null },
  { provider: 'gemini', latency_ms: 80, input_tokens: 5, output_tokens: 0, neurons: null, outcome: 'failed', trace_id: null, engine: null, persona: null },
  { provider: 'gemini', latency_ms: 90, input_tokens: 150, output_tokens: 75, neurons: 2, outcome: 'success', trace_id: 't-clean', engine: 'marker', persona: 'keeper' },
  { provider: 'workers-ai', latency_ms: 100, input_tokens: 30, output_tokens: 0, neurons: null, outcome: 'failed', trace_id: 't-multi', engine: 'builtin-fc', persona: 'concierge' },
  { provider: 'workers-ai', latency_ms: 110, input_tokens: 30, output_tokens: 0, neurons: null, outcome: 'failed', trace_id: 't-multi', engine: 'builtin-fc', persona: 'concierge' },
  { provider: 'workers-ai', latency_ms: 120, input_tokens: 400, output_tokens: 200, neurons: 10, outcome: 'success', trace_id: 't-multi', engine: 'degraded', persona: 'concierge' },
]

// ---------------- 순수 함수 ----------------

describe('percentile (nearest-rank)', () => {
  test('손계산: 10..120 12개 값의 p50=60, p95=120', () => {
    const vals = [120, 10, 50, 30, 90, 20, 110, 40, 70, 60, 100, 80]
    expect(percentile(vals, 50)).toBe(60)
    expect(percentile(vals, 95)).toBe(120)
    // 입력 배열을 정렬로 변형하지 않는다
    expect(vals[0]).toBe(120)
  })
  test('빈 배열·전부 비숫자면 null, 1개면 그 값', () => {
    expect(percentile([], 95)).toBeNull()
    expect(percentile([42], 50)).toBe(42)
    expect(percentile([42], 95)).toBe(42)
  })
})

describe('parseMetricsDays', () => {
  test('기본 14, 하한 1, 상한 90, 비숫자는 기본값', () => {
    expect(parseMetricsDays(undefined)).toBe(14)
    expect(parseMetricsDays('7')).toBe(7)
    expect(parseMetricsDays('0')).toBe(1)
    expect(parseMetricsDays('-3')).toBe(1)
    expect(parseMetricsDays('9999')).toBe(90)
    expect(parseMetricsDays('abc')).toBe(14)
  })
})

describe('aggregateUsage — 손계산 대조', () => {
  const agg = aggregateUsage(FIXTURE)

  test('전체: 요청·성공/실패 분해·성공률·백분위·토큰·뉴런', () => {
    expect(agg.overall.requests).toBe(12)
    expect(agg.overall.success).toBe(6)
    expect(agg.overall.failed).toBe(5)
    expect(agg.overall.rateLimited).toBe(1)
    expect(agg.overall.other).toBe(0)
    expect(agg.overall.successRate).toBe(0.5)
    expect(agg.overall.failureRate).toBe(0.5)
    expect(agg.overall.p50LatencyMs).toBe(60)
    expect(agg.overall.p95LatencyMs).toBe(120)
    expect(agg.overall.inputTokens).toBe(1295)
    expect(agg.overall.outputTokens).toBe(530)
    expect(agg.overall.totalTokens).toBe(1825)
    expect(agg.overall.neurons).toBe(27)
  })

  test('engine별 분리 + NULL은 unknown 버킷', () => {
    expect(Object.keys(agg.byEngine).sort()).toEqual(
      ['builtin-fc', 'degraded', 'marker', 'registry-fc', 'unknown'],
    )
    expect(agg.byEngine.marker).toMatchObject({
      requests: 3, success: 2, failed: 1, successRate: 2 / 3,
      p50LatencyMs: 20, p95LatencyMs: 90,
      inputTokens: 260, outputTokens: 125, neurons: 7,
    })
    expect(agg.byEngine['builtin-fc']).toMatchObject({
      requests: 3, success: 1, p50LatencyMs: 100, p95LatencyMs: 110, neurons: 7,
    })
    expect(agg.byEngine['registry-fc']).toMatchObject({
      requests: 2, success: 0, successRate: 0, failureRate: 1,
      p50LatencyMs: 40, p95LatencyMs: 50,
    })
    expect(agg.byEngine.degraded).toMatchObject({
      requests: 2, success: 2, successRate: 1, neurons: 13,
    })
    expect(agg.byEngine.unknown).toMatchObject({
      requests: 2, success: 1, failed: 1, p50LatencyMs: 70, p95LatencyMs: 80,
      inputTokens: 55, outputTokens: 25,
    })
  })

  test('persona별 분리 + NULL은 unknown 버킷', () => {
    expect(agg.byPersona.keeper).toMatchObject({
      requests: 4, success: 3, successRate: 0.75,
      p50LatencyMs: 20, p95LatencyMs: 90, inputTokens: 460, neurons: 14,
    })
    expect(agg.byPersona.concierge).toMatchObject({
      requests: 6, success: 2, failed: 3, rateLimited: 1,
      p50LatencyMs: 60, p95LatencyMs: 120, inputTokens: 780, neurons: 13,
    })
    expect(agg.byPersona.unknown.requests).toBe(2)
  })

  test('계약 밖 engine 값도 unknown으로 접힌다', () => {
    const agg2 = aggregateUsage([
      { outcome: 'success', latency_ms: 5, engine: 'something-else', persona: 'keeper' },
      { outcome: 'success', latency_ms: 5, engine: '', persona: ' ' },
    ])
    expect(Object.keys(agg2.byEngine)).toEqual(['unknown'])
    expect(agg2.byEngine.unknown.requests).toBe(2)
    expect(agg2.byPersona.unknown.requests).toBe(1)
  })

  test('빈 입력: 비율은 null, 백분위는 null, 합은 0 (0/0 위장 금지)', () => {
    const empty = aggregateUsage([])
    expect(empty.overall.requests).toBe(0)
    expect(empty.overall.successRate).toBeNull()
    expect(empty.overall.failureRate).toBeNull()
    expect(empty.overall.p50LatencyMs).toBeNull()
    expect(empty.overall.totalTokens).toBe(0)
  })
})

describe('countFallbackTraces — 근사 카운트 손계산 대조', () => {
  test('실패→성공 트레이스만 회복으로 센다 (트레이스당 최대 1)', () => {
    const fb = countFallbackTraces(FIXTURE)
    expect(fb.traceTurns).toBe(4)
    expect(fb.tracesWithFailure).toBe(3)
    expect(fb.recoveredTurns).toBe(2)
    expect(fb.recoveryRate).toBeCloseTo(2 / 3)
    expect(fb.approximate).toBe(true)
  })
  test('성공 뒤 실패는 회복이 아니다 / trace_id 없는 행은 무시', () => {
    const fb = countFallbackTraces([
      { outcome: 'success', trace_id: 'a' },
      { outcome: 'failed', trace_id: 'a' },
      { outcome: 'failed', trace_id: null },
      { outcome: 'success', trace_id: '' },
    ])
    expect(fb.traceTurns).toBe(1)
    expect(fb.tracesWithFailure).toBe(1)
    expect(fb.recoveredTurns).toBe(0)
    expect(fb.recoveryRate).toBe(0)
  })
})

describe('summarizeApprovals', () => {
  test('audit action별 건수 + executed_at 선점 건수', () => {
    const m = summarizeApprovals(
      ['preview_shown', 'preview_shown', 'executed', 'executed', 'denied', 'expired'],
      [
        { status: 'approved', executed_at: '2026-10-30T00:00:00.000Z' },
        { status: 'approved', executed_at: null },
        { status: 'denied', executed_at: null },
        { status: 'pending', executed_at: null },
        { status: 'expired', executed_at: null },
      ],
      { executedAtColumn: true },
    )
    expect(m.audit.total).toBe(6)
    expect(m.audit.byAction).toMatchObject({
      preview_shown: 2, executed: 2, denied: 1, expired: 1, blocked: 0,
    })
    expect(m.audit.executed).toBe(2)
    expect(m.requests.total).toBe(5)
    expect(m.requests.byStatus).toEqual({ approved: 2, denied: 1, pending: 1, expired: 1 })
    expect(m.requests.executedClaimCount).toBe(1)
    expect(m.requests.executedClaimUnavailableReason).toBeNull()
  })
  test('중복 실행 차단 시도는 null + 사유 (0으로 위장 금지)', () => {
    const m = summarizeApprovals([], [], { executedAtColumn: true })
    expect(m.duplicateExecutionBlockedAttempts).toBeNull()
    expect(m.duplicateExecutionBlockedAttemptsReason).toContain('영속 기록이 없다')
  })
  test('executed_at 컬럼이 없으면 선점 건수도 null + 사유', () => {
    const m = summarizeApprovals([], [{ status: 'approved' }], { executedAtColumn: false })
    expect(m.requests.executedClaimCount).toBeNull()
    expect(m.requests.executedClaimUnavailableReason).toContain('0063')
  })
})

// ---------------- 라우트 (Fake D1) ----------------

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString()
}

/**
 * getAiMetrics가 발행하는 SQL만 처리하는 최소 fake.
 * 기간 필터(datetime('now', '-N days'))를 실제로 적용한다.
 * has0065=false면 ai_usage에 engine·persona 컬럼이 없는 스키마를 흉내 낸다.
 */
class MetricsFakeD1 {
  usage: any[] = []
  errors: any[] = []
  audit: any[] = []
  requests: any[] = []
  constructor(private has0065: boolean) {}

  prepare(sql: string) {
    const q = sql.replace(/\s+/g, ' ').trim()
    const self = this
    const stmt = (args: any[]) => ({
      async all() {
        return { results: self.all(q, args) }
      },
      async first() {
        return self.all(q, args)[0] ?? null
      },
      async run() {
        return { success: true, meta: { changes: 0 } }
      },
    })
    return {
      bind: (...args: any[]) => stmt(args),
      all: async () => ({ results: self.all(q, []) }),
    }
  }

  private cutoff(modifier: string): number {
    const m = /-(\d+) days/.exec(modifier || '')
    const days = m ? parseInt(m[1], 10) : 14
    return Date.now() - days * 86400000
  }

  private all(q: string, args: any[]): any[] {
    if (q.includes("pragma_table_info('ai_usage')")) {
      const base = ['id', 'provider', 'model', 'capability', 'latency_ms', 'input_tokens', 'output_tokens', 'outcome', 'created_at', 'run_id', 'call_index', 'trace_id', 'span_id', 'parent_span_id', 'prompt_version', 'neurons']
      const cols = this.has0065 ? [...base, 'engine', 'persona'] : base
      return cols.map((name) => ({ name }))
    }
    if (q.includes("pragma_table_info('tool_approval_requests')")) {
      return ['id', 'persona_id', 'conversation_id', 'tool', 'status', 'created_at', 'expires_at', 'decided_at', 'executed_at', 'execution_result'].map((name) => ({ name }))
    }
    const cut = this.cutoff(args[0])
    const inPeriod = (r: any) => new Date(r.created_at).getTime() >= cut
    if (q.startsWith('SELECT') && q.includes('FROM ai_usage')) {
      const rows = this.usage.filter(inPeriod)
      if (!this.has0065) {
        return rows.map(({ engine, persona, ...rest }) => rest)
      }
      return rows
    }
    if (q.includes('FROM ai_error_log')) return this.errors.filter(inPeriod)
    if (q.includes('FROM tool_execution_audit')) return this.audit.filter(inPeriod)
    if (q.includes('FROM tool_approval_requests')) return this.requests.filter(inPeriod)
    return []
  }
}

function makeApp(fake: MetricsFakeD1) {
  const app = new Hono()
  app.get('/metrics', async (c) => {
    const days = parseMetricsDays(c.req.query('days'))
    const metrics = await getAiMetrics(fake as any, days)
    return c.json({ ok: true, ...metrics })
  })
  return (path: string) => app.request(path, {}, {} as any)
}

function seedFake(has0065: boolean): MetricsFakeD1 {
  const fake = new MetricsFakeD1(has0065)
  const recent = daysAgoIso(1)
  fake.usage = FIXTURE.map((r, i) => ({ id: i + 1, ...r, created_at: recent }))
  // 기간 밖(30일 전) 행 1건 — days=14에서는 제외돼야 한다
  fake.usage.push({
    id: 99, provider: 'gemini', latency_ms: 9999, input_tokens: 9999, output_tokens: 9999,
    neurons: 9999, outcome: 'success', trace_id: 't-old', engine: 'marker', persona: 'keeper',
    created_at: daysAgoIso(30),
  })
  fake.errors = [
    { provider: 'gemini', created_at: recent },
    { provider: 'gemini', created_at: recent },
    { provider: 'groq', created_at: recent },
  ]
  fake.audit = ['preview_shown', 'preview_shown', 'executed', 'executed', 'denied', 'expired']
    .map((action) => ({ action, created_at: recent }))
  fake.requests = [
    { status: 'approved', executed_at: recent, created_at: recent },
    { status: 'approved', executed_at: null, created_at: recent },
    { status: 'denied', executed_at: null, created_at: recent },
    { status: 'pending', executed_at: null, created_at: recent },
    { status: 'expired', executed_at: null, created_at: recent },
  ]
  return fake
}

describe('GET /metrics (0065 적용 스키마)', () => {
  test('집계·폴백·승인·에러가 손계산 픽스처와 일치하고 기간 밖 행은 제외된다', async () => {
    const req = makeApp(seedFake(true))
    const res = await req('/metrics?days=14')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.days).toBe(14)
    expect(body.schema.aiUsageEngineColumn).toBe(true)
    expect(body.schema.aiUsagePersonaColumn).toBe(true)
    expect(body.usage.overall.requests).toBe(12)
    expect(body.usage.overall.successRate).toBe(0.5)
    expect(body.usage.overall.p95LatencyMs).toBe(120)
    expect(body.usage.byEngine.unknown.requests).toBe(2)
    expect(body.usage.byPersona.keeper.requests).toBe(4)
    expect(body.fallback).toMatchObject({ traceTurns: 4, tracesWithFailure: 3, recoveredTurns: 2 })
    expect(body.errors).toEqual({ total: 3, byProvider: { gemini: 2, groq: 1 } })
    expect(body.approvals.audit.byAction.executed).toBe(2)
    expect(body.approvals.requests.executedClaimCount).toBe(1)
    expect(body.approvals.duplicateExecutionBlockedAttempts).toBeNull()
    expect(body.approvals.duplicateExecutionBlockedAttemptsReason).toContain('영속 기록이 없다')
  })

  test('days=90이면 30일 전 행까지 포함된다 / days 상한 클램프', async () => {
    const req = makeApp(seedFake(true))
    const res = await req('/metrics?days=9999')
    const body = await res.json()
    expect(body.days).toBe(90)
    expect(body.usage.overall.requests).toBe(13)
    expect(body.fallback.traceTurns).toBe(5)
  })
})

describe('GET /metrics (0065 미적용 스키마 — 방어)', () => {
  test('컬럼이 없어도 200이며 engine·persona는 전부 unknown으로 접힌다', async () => {
    const req = makeApp(seedFake(false))
    const res = await req('/metrics')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.days).toBe(14)
    expect(body.schema.aiUsageEngineColumn).toBe(false)
    expect(body.schema.aiUsagePersonaColumn).toBe(false)
    expect(body.schema.note).toContain('0065 미적용')
    expect(Object.keys(body.usage.byEngine)).toEqual(['unknown'])
    expect(body.usage.byEngine.unknown.requests).toBe(12)
    expect(Object.keys(body.usage.byPersona)).toEqual(['unknown'])
    // 컬럼과 무관한 지표는 그대로 산출된다
    expect(body.usage.overall.successRate).toBe(0.5)
    expect(body.usage.overall.totalTokens).toBe(1825)
    expect(body.fallback.recoveredTurns).toBe(2)
  })

  test('테이블이 전부 비어 있어도 200 + 빈 집계', async () => {
    const req = makeApp(new MetricsFakeD1(false))
    const res = await req('/metrics')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.usage.overall.requests).toBe(0)
    expect(body.usage.overall.successRate).toBeNull()
    expect(body.approvals.requests.executedClaimCount).toBe(0)
  })
})

// ---------------- 실DB (better-sqlite3 + 실제 마이그레이션 파일) ----------------
// Fake가 아니라 실제 SQLite에 마이그레이션 파일들을 순서대로 적용해 검증한다.
// 특히 0065는 파일 자체를 읽어 적용한다 — pragma_table_info 기반 스키마
// 방어와 datetime('now', ?) 기간 필터가 실제 SQL로 동작하는지 본다.

const MIGRATION_CHAIN = [
  '0007_ai_usage.sql',
  '0012_ai_error_log.sql',
  '0021_ai_run_logs.sql',
  '0022_ai_usage_run_id.sql',
  '0052_tool_approval_requests.sql',
  '0055_tool_execution_audit.sql',
  '0057_otel_spans.sql',
  '0063_tool_approval_executed.sql',
  '0064_ai_usage_neurons.sql',
]

function makeRealDb(with0065: boolean): any {
  const d1 = createLocalD1()
  for (const f of MIGRATION_CHAIN) d1.exec(readMigration(f))
  if (with0065) d1.exec(readMigration('0065_ai_usage_attribution.sql'))
  return d1
}

const hoursAgoIso = (h: number) => new Date(Date.now() - h * 3600000).toISOString()
const daysAgoIsoReal = (d: number) => new Date(Date.now() - d * 86400000).toISOString()

async function insertUsage(d1: any, row: Record<string, unknown>) {
  const cols = Object.keys(row)
  await d1
    .prepare(`INSERT INTO ai_usage (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .bind(...cols.map((c) => row[c]))
    .run()
}

describe('getAiMetrics — 실DB + 실제 0065 마이그레이션', () => {
  test('0065 적용 DB: 분리 집계·폴백·승인 선점이 실제 SQL로 산출된다', async () => {
    const d1 = makeRealDb(true)
    // u1 keeper/marker 성공, u2→u3 같은 trace에서 실패→성공 (폴백 회복 1),
    // u4·u5 레거시(NULL 귀속), u6는 기간 밖(20일 전)이라 제외돼야 한다.
    await insertUsage(d1, { provider: 'workers-ai', model: 'm1', capability: 'chat', latency_ms: 100, input_tokens: 10, output_tokens: 5, neurons: 2, outcome: 'success', trace_id: 'rt-1', engine: 'marker', persona: 'keeper', created_at: hoursAgoIso(1) })
    await insertUsage(d1, { provider: 'workers-ai', model: 'm1', capability: 'chat', latency_ms: 300, input_tokens: 0, output_tokens: 0, neurons: null, outcome: 'failed', trace_id: 'rt-2', engine: 'marker', persona: 'keeper', created_at: hoursAgoIso(3) })
    await insertUsage(d1, { provider: 'workers-ai', model: 'm2', capability: 'chat', latency_ms: 200, input_tokens: 20, output_tokens: 10, neurons: null, outcome: 'success', trace_id: 'rt-2', engine: 'builtin-fc', persona: 'keeper', created_at: hoursAgoIso(2) })
    await insertUsage(d1, { provider: 'gemini', model: 'm3', capability: 'chat', latency_ms: 1000, input_tokens: 100, output_tokens: 50, neurons: null, outcome: 'success', trace_id: null, engine: null, persona: null, created_at: hoursAgoIso(5) })
    await insertUsage(d1, { provider: 'gemini', model: 'm3', capability: 'chat', latency_ms: 50, input_tokens: 0, output_tokens: 0, neurons: null, outcome: 'failed', trace_id: null, engine: null, persona: null, created_at: hoursAgoIso(6) })
    await insertUsage(d1, { provider: 'gemini', model: 'm3', capability: 'chat', latency_ms: 9999, input_tokens: 9999, output_tokens: 9999, neurons: null, outcome: 'success', trace_id: 'rt-old', engine: 'marker', persona: 'keeper', created_at: daysAgoIsoReal(20) })

    await d1.prepare('INSERT INTO ai_error_log (provider, model, capability, error, http_status, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind('gemini', 'm3', 'chat', 'boom', 500, hoursAgoIso(1)).run()
    await d1.prepare('INSERT INTO ai_error_log (provider, model, capability, error, http_status, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind('groq', 'm4', 'chat', 'boom', 429, hoursAgoIso(2)).run()
    await d1.prepare('INSERT INTO ai_error_log (provider, model, capability, error, http_status, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind('gemini', 'm3', 'chat', 'old', 500, daysAgoIsoReal(20)).run()

    const auditInsert = 'INSERT INTO tool_execution_audit (persona_id, conversation_id, tool, scope_key, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    await d1.prepare(auditInsert).bind('keeper', 1, 'MEMO_CREATE', 'MEMO_CREATE', 'executed', '', hoursAgoIso(1)).run()
    await d1.prepare(auditInsert).bind('keeper', 1, 'MEMO_DELETE', 'MEMO_DELETE', 'denied', '', hoursAgoIso(2)).run()
    await d1.prepare(auditInsert).bind('keeper', 1, 'MEMO_CREATE', 'MEMO_CREATE', 'preview_shown', '', daysAgoIsoReal(20)).run()

    const reqInsert = 'INSERT INTO tool_approval_requests (persona_id, conversation_id, tool, scope_key, marker_text, summary, user_request, reversible, impact, status, created_at, expires_at, decided_at, executed_at, execution_result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    await d1.prepare(reqInsert).bind('keeper', 1, 'MEMO_CREATE', 'MEMO_CREATE', '[M]', 's', 'u', 1, '', 'approved', hoursAgoIso(1), hoursAgoIso(0), hoursAgoIso(1), hoursAgoIso(1), 'done').run()
    await d1.prepare(reqInsert).bind('keeper', 1, 'MEMO_DELETE', 'MEMO_DELETE', '[M]', 's', 'u', 0, '', 'pending', hoursAgoIso(2), hoursAgoIso(0), null, null, null).run()
    await d1.prepare(reqInsert).bind('keeper', 1, 'MEMO_CREATE', 'MEMO_CREATE', '[M]', 's', 'u', 1, '', 'approved', daysAgoIsoReal(20), daysAgoIsoReal(20), daysAgoIsoReal(20), daysAgoIsoReal(20), 'old').run()

    const m = await getAiMetrics(d1 as any, 14)
    expect(m.schema.aiUsageEngineColumn).toBe(true)
    expect(m.schema.aiUsagePersonaColumn).toBe(true)
    expect(m.schema.approvalExecutedAtColumn).toBe(true)
    // 전체: 5건 (u6 제외), 성공 3, 실패 2, latency [50,100,200,300,1000]
    expect(m.usage.overall).toMatchObject({
      requests: 5, success: 3, failed: 2, successRate: 0.6, failureRate: 0.4,
      p50LatencyMs: 200, p95LatencyMs: 1000,
      inputTokens: 130, outputTokens: 65, totalTokens: 195, neurons: 2,
    })
    expect(m.usage.byEngine.marker).toMatchObject({ requests: 2, success: 1 })
    expect(m.usage.byEngine['builtin-fc']).toMatchObject({ requests: 1, success: 1 })
    expect(m.usage.byEngine.unknown).toMatchObject({ requests: 2, success: 1, failed: 1 })
    expect(m.usage.byPersona.keeper).toMatchObject({ requests: 3, success: 2 })
    expect(m.usage.byPersona.unknown).toMatchObject({ requests: 2, success: 1 })
    expect(m.fallback).toMatchObject({ traceTurns: 2, tracesWithFailure: 1, recoveredTurns: 1, recoveryRate: 1 })
    expect(m.errors).toEqual({ total: 2, byProvider: { gemini: 1, groq: 1 } })
    expect(m.approvals.audit).toMatchObject({ total: 2 })
    expect(m.approvals.audit.byAction).toMatchObject({ executed: 1, denied: 1, preview_shown: 0, blocked: 0 })
    expect(m.approvals.requests).toMatchObject({ total: 2, executedClaimCount: 1 })
    expect(m.approvals.requests.byStatus).toEqual({ approved: 1, pending: 1 })
    expect(m.approvals.duplicateExecutionBlockedAttempts).toBeNull()
    d1.close()
  })

  test('0065 미적용 실DB: 500 없이 전부 unknown으로 접히고 나머지 지표는 산출된다', async () => {
    const d1 = makeRealDb(false)
    await insertUsage(d1, { provider: 'gemini', model: 'm3', capability: 'chat', latency_ms: 100, input_tokens: 1, output_tokens: 1, neurons: null, outcome: 'success', trace_id: 'x', created_at: hoursAgoIso(1) })
    await insertUsage(d1, { provider: 'gemini', model: 'm3', capability: 'chat', latency_ms: 200, input_tokens: 1, output_tokens: 1, neurons: null, outcome: 'failed', trace_id: 'y', created_at: hoursAgoIso(2) })
    await insertUsage(d1, { provider: 'gemini', model: 'm3', capability: 'chat', latency_ms: 300, input_tokens: 1, output_tokens: 1, neurons: null, outcome: 'success', trace_id: 'y', created_at: hoursAgoIso(1) })

    const m = await getAiMetrics(d1 as any, 14)
    expect(m.schema.aiUsageEngineColumn).toBe(false)
    expect(m.schema.aiUsagePersonaColumn).toBe(false)
    expect(m.schema.note).toContain('0065 미적용')
    expect(m.usage.overall).toMatchObject({ requests: 3, success: 2, successRate: 2 / 3 })
    expect(Object.keys(m.usage.byEngine)).toEqual(['unknown'])
    expect(m.usage.byEngine.unknown.requests).toBe(3)
    expect(Object.keys(m.usage.byPersona)).toEqual(['unknown'])
    expect(m.fallback).toMatchObject({ traceTurns: 2, tracesWithFailure: 1, recoveredTurns: 1 })
    d1.close()
  })
})
