/// <reference types="jest" />
/**
 * trace-viewer / lib/trace 커버리지 보강 (트랙 1 최약 지점)
 * - trace-viewer.ts: auditStatus/toolRunStatus 상태 매핑표 전체 분기
 *   (기존 tests/unit/trace.test.ts는 executed→ok, success→ok, failed→error만
 *   다루고 denied/blocked/cached/expired·status 컬럼 우선순위는 미검증)
 * - lib/trace.ts: randomHexChars의 randomUUID·Math.random 폴백 경로
 *   (기존 테스트는 getRandomValues 기본 경로만 다룸)
 * - 종료시각 동률 tie-break: getTraceSpans의 정렬 계약을 고정한다.
 *   (참고: V8 sort가 stable하고 스팬 push 순서가 llm→tool이라, tie-break
 *   비교자를 제거해도 현재 출력은 같다 — 이 테스트는 push 순서 변경 등
 *   미래 회귀에 대한 계약 고정이며, 카나리아 한계는 보고서에 기록한다.)
 */
import { getTraceSpans } from '../../src/services/trace-viewer'
import { newSpanId, newTraceId } from '../../src/lib/trace'

// ---------------- Mock D1 (getTraceSpans가 발행하는 3개 SELECT만 처리) ----------------

interface ViewerRows {
  llm?: any[]
  audit?: any[]
  runs?: any[]
}

function makeViewerDb(rows: ViewerRows): any {
  return {
    prepare(sql: string) {
      return {
        bind(..._p: any[]) {
          return this
        },
        async all() {
          if (sql.includes('FROM ai_usage')) return { results: rows.llm ?? [] }
          if (sql.includes('FROM tool_execution_audit')) return { results: rows.audit ?? [] }
          if (sql.includes('FROM ai_tool_runs')) return { results: rows.runs ?? [] }
          return { results: [] }
        },
      }
    },
  }
}

const TRACE = 'c'.repeat(32)

function auditRow(over: Record<string, unknown>): any {
  return {
    traceId: TRACE,
    spanId: 'a'.repeat(16),
    parentSpanId: null,
    toolName: 'MEMO_DELETE',
    toolCallId: 'tc_1',
    durationMs: 100,
    action: 'executed',
    status: null,
    createdAt: '2026-10-26T10:00:00.000Z',
    ...over,
  }
}

function runRow(over: Record<string, unknown>): any {
  return {
    traceId: TRACE,
    spanId: 'b'.repeat(16),
    parentSpanId: null,
    toolName: 'MEMO_SEARCH',
    toolCallId: 'tc_2',
    durationMs: 50,
    status: 'success',
    createdAt: '2026-10-26T10:00:00.000Z',
    ...over,
  }
}

function llmRow(over: Record<string, unknown>): any {
  return {
    traceId: TRACE,
    spanId: 'd'.repeat(16),
    parentSpanId: null,
    model: 'gemini-3.5-flash-lite',
    inputTokens: 10,
    outputTokens: 5,
    durationMs: 200,
    outcome: 'success',
    promptVersion: 'persona-v1',
    createdAt: '2026-10-26T10:00:00.000Z',
    ...over,
  }
}

// ---------------- auditStatus 매핑표 ----------------

describe('trace-viewer auditStatus — 감사 action/status → 스팬 상태', () => {
  test.each([
    // [action, status, 기대 상태, 사유]
    ['executed', null, 'ok', '실행 완료'],
    ['preview_shown', null, 'ok', '미리보기 표시도 정상'],
    ['denied', null, 'denied', '거부는 denied로 구분'],
    ['expired', null, 'blocked', '만료는 blocked'],
    ['blocked', null, 'blocked', '차단은 blocked'],
    ['unknown_action', null, 'ok', '알 수 없는 action은 기본 ok'],
    ['denied', 'ok', 'ok', 'status 컬럼이 있으면 action보다 우선'],
    ['executed', 'error', 'error', 'status=error가 action보다 우선'],
  ])('action=%s status=%s → %s (%s)', async (action, status, expected, _why) => {
    const spans = await getTraceSpans(makeViewerDb({ audit: [auditRow({ action, status })] }), TRACE)
    expect(spans).toHaveLength(1)
    expect(spans[0].status).toBe(expected)
  })
})

// ---------------- toolRunStatus 매핑표 ----------------

describe('trace-viewer toolRunStatus — ai_tool_runs.status → 스팬 상태', () => {
  test.each([
    ['success', 'ok'],
    ['cached', 'cached'],
    ['blocked', 'blocked'],
    ['error', 'error'],
    ['weird_status', 'ok'],
  ])('status=%s → %s', async (status, expected) => {
    const spans = await getTraceSpans(makeViewerDb({ runs: [runRow({ status })] }), TRACE)
    expect(spans).toHaveLength(1)
    expect(spans[0].status).toBe(expected)
  })
})

// ---------------- 수치·문자열 변환 가드 ----------------

describe('getTraceSpans — 수치·문자열 변환 가드', () => {
  test('음수 duration은 0, 숫자가 아닌 토큰은 null, 빈 문자열은 null', async () => {
    const spans = await getTraceSpans(
      makeViewerDb({
        llm: [
          llmRow({
            durationMs: -5,
            inputTokens: 'abc',
            outputTokens: null,
            parentSpanId: '',
            promptVersion: '',
          }),
        ],
      }),
      TRACE,
    )
    expect(spans).toHaveLength(1)
    expect(spans[0].durationMs).toBe(0)
    expect(spans[0].inputTokens).toBeNull()
    expect(spans[0].outputTokens).toBeNull()
    expect(spans[0].parentSpanId).toBeNull()
    expect(spans[0].promptVersion).toBeNull()
  })
})

// ---------------- 종료시각 동률 tie-break ----------------

describe('getTraceSpans 정렬 — 종료시각 동률 시 LLM 스팬 우선', () => {
  test('같은 endedAt이면 LLM 스팬이 도구 스팬보다 앞에 온다', async () => {
    const at = '2026-10-26T10:00:00.000Z'
    const spans = await getTraceSpans(
      makeViewerDb({
        llm: [llmRow({ createdAt: at })],
        audit: [auditRow({ createdAt: at })],
        runs: [runRow({ createdAt: at })],
      }),
      TRACE,
    )
    expect(spans).toHaveLength(3)
    expect(spans[0].kind).toBe('llm')
    expect(spans.map((s) => s.kind)).toEqual(['llm', 'tool', 'tool'])
  })
})

// ---------------- randomHexChars 폴백 경로 ----------------

describe('lib/trace randomHexChars 폴백', () => {
  const origCrypto = globalThis.crypto

  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', {
      value: origCrypto,
      configurable: true,
      writable: true,
    })
    jest.restoreAllMocks()
  })

  test('randomUUID 폴백: getRandomValues가 없으면 UUID 하이픈 제거 후 자른다', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: { randomUUID: () => '123e4567-e89b-12d3-a456-426614174000' },
      configurable: true,
    })
    expect(newTraceId()).toBe('123e4567e89b12d3a456426614174000')
    expect(newSpanId()).toBe('123e4567e89b12d3')
  })

  test('Math.random 폴백: crypto 메서드가 둘 다 없으면 16진 난수를 쓴다', () => {
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true })
    jest.spyOn(Math, 'random').mockReturnValue(0.5) // floor(0.5*16)=8
    expect(newSpanId()).toBe('8'.repeat(16))
    expect(newTraceId()).toBe('8'.repeat(32))
  })

  test('Math.random 폴백: 0과 15 경계값이 0/f 문자로 나온다', () => {
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true })
    const spy = jest.spyOn(Math, 'random')
    let i = 0
    spy.mockImplementation(() => (i++ % 2 === 0 ? 0 : 15 / 16))
    expect(newSpanId()).toBe('0f'.repeat(8))
  })
})
