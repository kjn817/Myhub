/// <reference types="jest" />
/**
 * OTEL 스팬 차용 (트랙 C2+C3) 테스트
 * - src/lib/trace: 식별자 형식 (OTEL 128/64-bit hex)
 * - 마이그레이션 0057: 실제 SQLite에 0007·0021·0022·0055·0057 적용 후
 *   스팬 컬럼 존재 + 기존 행 보존 확인 (운영 DB에 닿지 않음)
 * - src/services/trace-viewer: 3개 테이블 합집합, depth, 상태 매핑
 * - SandboxAuditStore.recordAudit: trace 필드 저장 + status 기본값
 * - GET /api/ai/traces(+/:traceId): 라우트 동작 (스텁 DB, 인증 미들웨어 제외)
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  newTraceId, newSpanId, newRootTrace, childSpan,
  isValidTraceId, isValidSpanId,
} from '../../src/lib/trace'
import {
  listRecentTraces, getTraceSpans, computeDepths,
  type TraceSpan,
} from '../../src/services/trace-viewer'
import { SandboxAuditStore } from '../../src/services/sandbox'
import { aiApp } from '../../src/modules/ai/routes'
import { FakeD1, asD1 } from '../fake-d1'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createLocalD1 } = require('../helpers/local-d1.cjs')

const SQL_0007 = fs.readFileSync(path.join(__dirname, '../../migrations/0007_ai_usage.sql'), 'utf8')
const SQL_0021 = fs.readFileSync(path.join(__dirname, '../../migrations/0021_ai_run_logs.sql'), 'utf8')
const SQL_0022 = fs.readFileSync(path.join(__dirname, '../../migrations/0022_ai_usage_run_id.sql'), 'utf8')
const SQL_0055 = fs.readFileSync(path.join(__dirname, '../../migrations/0055_tool_execution_audit.sql'), 'utf8')
const SQL_0057 = fs.readFileSync(path.join(__dirname, '../../migrations/0057_otel_spans.sql'), 'utf8')

function makeDb(): any {
  const d1 = createLocalD1()
  d1.exec(SQL_0007)
  d1.exec(SQL_0021)
  d1.exec(SQL_0022)
  d1.exec(SQL_0055)
  d1.exec(SQL_0057)
  return d1
}

describe('lib/trace — OTEL 식별자', () => {
  test('trace_id는 32자 소문자 hex, span_id는 16자 소문자 hex', () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/)
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/)
    expect(isValidTraceId(newTraceId())).toBe(true)
    expect(isValidSpanId(newSpanId())).toBe(true)
  })

  test('연속 생성 시 충돌 없음 (1000개)', () => {
    const traces = new Set(Array.from({ length: 1000 }, () => newTraceId()))
    const spans = new Set(Array.from({ length: 1000 }, () => newSpanId()))
    expect(traces.size).toBe(1000)
    expect(spans.size).toBe(1000)
  })

  test('childSpan은 trace_id를 잇고 부모를 가리킨다', () => {
    const root = newRootTrace()
    const child = childSpan(root)
    expect(child.traceId).toBe(root.traceId)
    expect(child.parentSpanId).toBe(root.spanId)
    expect(child.spanId).not.toBe(root.spanId)
    expect(isValidTraceId(root.traceId)).toBe(true)
  })

  test('검증기는 형식이 아니면 false', () => {
    expect(isValidTraceId('zz'.repeat(16))).toBe(false)
    expect(isValidTraceId('a'.repeat(31))).toBe(false)
    expect(isValidTraceId(null)).toBe(false)
    expect(isValidSpanId('A'.repeat(16))).toBe(false)
    expect(isValidSpanId(undefined)).toBe(false)
  })
})

describe('마이그레이션 0057 — 실제 SQLite', () => {
  test('스팬 컬럼이 3개 테이블에 추가된다', async () => {
    const d1 = makeDb()
    const cols = async (table: string): Promise<string[]> =>
      (await d1.prepare(`SELECT name FROM pragma_table_info('${table}')`).all()).results.map((r: any) => r.name)
    for (const col of ['trace_id', 'span_id', 'parent_span_id', 'prompt_version']) {
      expect(await cols('ai_usage')).toContain(col)
    }
    for (const col of ['trace_id', 'span_id', 'parent_span_id']) {
      expect(await cols('ai_tool_runs')).toContain(col)
    }
    for (const col of ['trace_id', 'span_id', 'parent_span_id', 'tool_call_id', 'duration_ms', 'status']) {
      expect(await cols('tool_execution_audit')).toContain(col)
    }
  })

  test('0057 적용 전 행이 보존되고 스팬 컬럼은 NULL이다', async () => {
    const d1 = createLocalD1()
    d1.exec(SQL_0007)
    d1.exec(SQL_0021)
    d1.exec(SQL_0055)
    await d1.prepare(
      `INSERT INTO ai_usage (provider, model, capability, latency_ms, outcome, created_at)
       VALUES ('gemini', 'm', 'chat', 100, 'success', '2026-10-26T00:00:00.000Z')`,
    ).run()
    d1.exec(SQL_0057)
    const row = (await d1.prepare('SELECT trace_id, span_id, prompt_version FROM ai_usage').all()).results[0]
    expect(row.trace_id).toBeNull()
    expect(row.span_id).toBeNull()
    expect(row.prompt_version).toBeNull()
  })

  test('0057은 추가형 변경만 포함한다 (기존 테이블·컬럼을 손대지 않음)', () => {
    // SQLite ADD COLUMN에는 IF NOT EXISTS가 없어 마이그레이션 러너가
    // 1회 적용을 보장하는 것이 전제다 — 파일 자체는 추가형이어야 한다.
    const stmts = SQL_0057.split(';').map((s) => s.trim()).filter((s) => s && !s.startsWith('--'))
    for (const stmt of stmts) {
      expect(stmt).toMatch(/^(ALTER TABLE \w+ ADD COLUMN|CREATE INDEX IF NOT EXISTS)/)
    }
  })
})

const TRACE_A = 'a'.repeat(32)
const TRACE_B = 'b'.repeat(32)

async function seedTraceDb(d1: any): Promise<void> {
  // 트레이스 A: LLM 루트 → LLM 자식 → 도구 자식 (부모 연결 있음)
  const rootSpan = '1'.repeat(16)
  const llmChild = '2'.repeat(16)
  const toolSpan = '3'.repeat(16)
  await d1.prepare(
    `INSERT INTO ai_usage (provider, model, capability, latency_ms, input_tokens, output_tokens,
       outcome, run_id, call_index, trace_id, span_id, parent_span_id, prompt_version, created_at)
     VALUES ('gemini', 'gemini-3.5-flash-lite', 'function_calling', 1200, 100, 50,
       'success', 'run_1', 0, ?, ?, NULL, 'persona-v1', '2026-10-26T10:00:01.200Z')`,
  ).bind(TRACE_A, rootSpan).run()
  await d1.prepare(
    `INSERT INTO ai_usage (provider, model, capability, latency_ms, input_tokens, output_tokens,
       outcome, run_id, call_index, trace_id, span_id, parent_span_id, prompt_version, created_at)
     VALUES ('gemini', 'gemini-3.5-flash-lite', 'function_calling', 800, 200, 80,
       'failed', 'run_1', 1, ?, ?, ?, 'persona-v1', '2026-10-26T10:00:02.000Z')`,
  ).bind(TRACE_A, llmChild, rootSpan).run()
  await d1.prepare(
    `INSERT INTO ai_tool_runs (run_id, tool_call_id, tool_name, mode, status, duration_ms,
       error_code, cache_hit, operation_id, trace_id, span_id, parent_span_id, created_at)
     VALUES ('run_1', 'tc_1', 'MEMO_SEARCH', 'read', 'success', 300,
       NULL, 0, NULL, ?, ?, ?, '2026-10-26T10:00:01.800Z')`,
  ).bind(TRACE_A, toolSpan, llmChild).run()
  // 트레이스 B: 감사 로그만 (승인 게이트 경로)
  await d1.prepare(
    `INSERT INTO tool_execution_audit (persona_id, conversation_id, tool, scope_key, action, detail,
       created_at, trace_id, span_id, parent_span_id, tool_call_id, duration_ms, status)
     VALUES ('keeper', 7, 'MEMO_DELETE', 'MEMO_DELETE:1', 'executed', '메모 #1 삭제',
       '2026-10-26T11:00:00.000Z', ?, ?, NULL, 'tc_9', 150, 'ok')`,
  ).bind(TRACE_B, '4'.repeat(16)).run()
  // trace_id 없는 구행 — 목록에서 제외되어야 한다
  await d1.prepare(
    `INSERT INTO ai_usage (provider, model, capability, latency_ms, outcome, created_at)
     VALUES ('groq', 'm', 'chat', 50, 'success', '2026-10-26T09:00:00.000Z')`,
  ).run()
}

describe('trace-viewer 서비스', () => {
  test('listRecentTraces: trace_id 있는 트레이스만, 최신순, 오류 표시', async () => {
    const d1 = makeDb()
    await seedTraceDb(d1)
    const traces = await listRecentTraces(d1, 20)
    expect(traces).toHaveLength(2)
    expect(traces[0].traceId).toBe(TRACE_B)
    expect(traces[1].traceId).toBe(TRACE_A)
    expect(traces[1].spanCount).toBe(3)
    expect(traces[1].hasError).toBe(true) // outcome=failed 스팬 포함
    expect(traces[0].hasError).toBe(false)
    expect(traces[1].totalMs).toBeGreaterThanOrEqual(0)
  })

  test('getTraceSpans: 3개 테이블 합집합 + depth + 상태·토큰 매핑', async () => {
    const d1 = makeDb()
    await seedTraceDb(d1)
    const spans = await getTraceSpans(d1, TRACE_A)
    expect(spans).toHaveLength(3)
    const [root, tool, llm2] = spans
    expect(root.kind).toBe('llm')
    expect(root.depth).toBe(0)
    expect(root.status).toBe('ok')
    expect(root.inputTokens).toBe(100)
    expect(root.promptVersion).toBe('persona-v1')
    expect(tool.kind).toBe('tool')
    expect(tool.name).toBe('MEMO_SEARCH')
    expect(tool.depth).toBe(2) // LLM 자식의 자식
    expect(tool.toolCallId).toBe('tc_1')
    expect(llm2.status).toBe('error')
    expect(llm2.depth).toBe(1)
  })

  test('getTraceSpans: 감사 로그 스팬은 action에서 상태를 유추한다', async () => {
    const d1 = makeDb()
    await seedTraceDb(d1)
    const spans = await getTraceSpans(d1, TRACE_B)
    expect(spans).toHaveLength(1)
    expect(spans[0].kind).toBe('tool')
    expect(spans[0].name).toBe('MEMO_DELETE')
    expect(spans[0].status).toBe('ok')
    // detail(감사 문안)은 스팬에 노출하지 않는다 — 잠긴 메모 내용 유출 방지
    expect(JSON.stringify(spans)).not.toContain('메모 #1 삭제')
  })

  test('computeDepths: 부모 없음·순환은 깊이 0으로 끊는다', () => {
    const base: TraceSpan = {
      traceId: TRACE_A, spanId: 'x', parentSpanId: null, kind: 'llm',
      name: 'm', status: 'ok', endedAt: '2026-10-26T10:00:00.000Z', durationMs: 10, depth: 0,
    }
    const orphan = { ...base, spanId: 'y', parentSpanId: 'missing-parent' }
    const cycleA = { ...base, spanId: 'c1', parentSpanId: 'c2' }
    const cycleB = { ...base, spanId: 'c2', parentSpanId: 'c1' }
    const out = computeDepths([orphan, cycleA, cycleB])
    expect(out[0].depth).toBe(0)
    expect(out[1].depth).toBeGreaterThanOrEqual(0)
    expect(out[2].depth).toBeGreaterThanOrEqual(0)
  })
})

describe('SandboxAuditStore.recordAudit — trace 필드', () => {
  test('호출자가 준 trace 컨텍스트를 저장하고 executed는 status ok', async () => {
    const fake = new FakeD1()
    const store = new SandboxAuditStore(asD1(fake))
    const id = await store.recordAudit({
      personaId: 'keeper', conversationId: 7, tool: 'MEMO_DELETE',
      scopeKey: 'MEMO_DELETE:1', action: 'executed', detail: 'ok',
      traceId: TRACE_A, spanId: '5'.repeat(16), parentSpanId: '6'.repeat(16),
      toolCallId: 'tc_7', durationMs: 120, status: 'ok',
    })
    const row = fake.tables.tool_execution_audit.find((r) => r.id === id)
    expect(row?.trace_id).toBe(TRACE_A)
    expect(row?.span_id).toBe('5'.repeat(16))
    expect(row?.parent_span_id).toBe('6'.repeat(16))
    expect(row?.tool_call_id).toBe('tc_7')
    expect(row?.duration_ms).toBe(120)
    expect(row?.status).toBe('ok')
  })

  test('trace를 안 주면 자동 생성하고 denied는 status를 비워둔다', async () => {
    const fake = new FakeD1()
    const store = new SandboxAuditStore(asD1(fake))
    const id = await store.recordAudit({
      personaId: 'keeper', conversationId: 7, tool: 'MEMO_DELETE',
      scopeKey: 'MEMO_DELETE:1', action: 'denied', detail: '거부됨',
    })
    const row = fake.tables.tool_execution_audit.find((r) => r.id === id)
    expect(row?.trace_id).toMatch(/^[0-9a-f]{32}$/)
    expect(row?.span_id).toMatch(/^[0-9a-f]{16}$/)
    // status NULL → 뷰어가 action에서 'denied'로 구분한다
    expect(row?.status).toBeNull()
  })
})

describe('GET /api/ai/traces 라우트', () => {  function stubDb() {
    return {
      prepare(sql: string) {
        return {
          bind(...args: any[]) {
            return {
              async all() {
                if (sql.includes('GROUP BY trace_id')) {
                  return { results: [{ traceId: TRACE_A, startedAt: '2026-10-26T10:00:01.200Z', spanCount: 3, totalMs: 800, hasError: 1 }] }
                }
                if (sql.includes('FROM ai_usage WHERE trace_id')) {
                  return { results: [{ traceId: TRACE_A, spanId: '1'.repeat(16), parentSpanId: null, model: 'm', inputTokens: 10, outputTokens: 5, durationMs: 100, outcome: 'success', promptVersion: 'persona-v1', createdAt: '2026-10-26T10:00:01.200Z' }] }
                }
                if (sql.includes('FROM tool_execution_audit WHERE trace_id')) {
                  return { results: [] }
                }
                if (sql.includes('FROM ai_tool_runs WHERE trace_id')) {
                  return { results: [] }
                }
                return { results: [] }
              },
            }
          },
        }
      },
    }
  }

  test('목록: traces 배열 반환', async () => {
    const res = await aiApp.request('/traces', {}, { DB: stubDb() } as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.traces).toHaveLength(1)
    expect(body.traces[0].traceId).toBe(TRACE_A)
    expect(body.traces[0].hasError).toBe(true)
  })

  test('상세: 스팬 배열 반환', async () => {
    const res = await aiApp.request(`/traces/${TRACE_A}`, {}, { DB: stubDb() } as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.traceId).toBe(TRACE_A)
    expect(body.spans).toHaveLength(1)
    expect(body.spans[0].name).toBe('m')
  })

  test('trace_id 형식이 아니면 400', async () => {
    const res = await aiApp.request('/traces/not-a-trace-id', {}, { DB: stubDb() } as any)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe('invalid_trace_id')
  })
})

describe('deploy_full.py 정적 목록 — trace 페이지 포함', () => {
  test('trace.html/js가 에셋 집합에 있고 trace.html은 버전 관리 대상이다', () => {
    // 구 인라인 목록(files/CT/HTML_PAGES/staticBufs) 대신
    // scripts/static-assets.json + deploy_full.py ver()가 같은 속성을 보장한다.
    const assetList = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../scripts/static-assets.json'), 'utf8'),
    )
    expect(assetList.files).toContain('/trace.html')
    expect(assetList.files).toContain('/js/trace.js')
    expect(assetList.versioned).toContain('/trace.html')
    const deployPy = fs.readFileSync(path.join(__dirname, '../../deploy_full.py'), 'utf8')
    // 캐시 무효화: ?v= 부착은 createVersioner(매니페스트 집합 기준)가 담당하고
    // js/trace.js는 집합에 있으므로 부착 대상이다 (2026-11-01 고정 목록 폐지).
    expect(deployPy).toContain('createVersioner')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createVersioner } = require('../../scripts/asset-version.cjs')
    const ver = createVersioner(assetList, 'testver1')
    expect(ver('<script src="/js/trace.js"></script>')).toContain('/js/trace.js?v=testver1')
    // 실제 파일 존재
    expect(fs.existsSync(path.join(__dirname, '../../public/trace.html'))).toBe(true)
    expect(fs.existsSync(path.join(__dirname, '../../public/js/trace.js'))).toBe(true)
  })
})
