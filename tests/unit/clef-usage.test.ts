/// <reference types="jest" />
/**
 * src/services/clef-usage.ts — Clef 사용량 귀속·추정·기록 성질 테스트.
 *
 * 핵심 성질: ① 용도 추론은 우선순위(assistant > 스튜디오 > 도구 > 맵)가
 * 고정이다 ② 보고된 usage가 있으면 그 값을, 없으면 추정으로 대체하되
 * neurons가 유한하지 않으면 보고값을 버린다 ③ 기록은 스키마가 없는 DB에서
 * 단계적으로 좁은 INSERT로 폴백하고 전부 실패하면 false를 반환한다.
 * 카나리아: inferClefPurpose에서 assistant 검사를 뒤로 미루거나
 * recordClefUsage의 폴백 INSERT를 지우면 실패한다.
 */
import {
  CLEF_USAGE_MODEL,
  estimateClefInputTokens,
  extractClefPersona,
  inferClefPurpose,
  inferClefPurposeFromSpecIds,
  isClefUsageAccounted,
  markClefUsageAccounted,
  neuronsForInputTokens,
  recordClefUsage,
  resolveClefUsage,
} from '../../src/services/clef-usage'

describe('markClefUsageAccounted / isClefUsageAccounted', () => {
  test('표시한 함수만 accounted이고, mark는 같은 함수를 반환한다', () => {
    const fn = () => 1
    expect(isClefUsageAccounted(fn)).toBe(false)
    expect(markClefUsageAccounted(fn)).toBe(fn)
    expect(isClefUsageAccounted(fn)).toBe(true)
    expect(isClefUsageAccounted(() => 2)).toBe(false)
  })

  test('함수가 아닌 값은 accounted가 아니다', () => {
    for (const v of [null, undefined, {}, 'fn', 42]) expect(isClefUsageAccounted(v)).toBe(false)
  })
})

describe('inferClefPurpose — 우선순위', () => {
  test('questions가 없거나 객체가 아니면 classify', () => {
    expect(inferClefPurpose(null)).toBe('classify')
    expect(inferClefPurpose({})).toBe('classify')
    expect(inferClefPurpose({ questions: 'nope' })).toBe('classify')
    expect(inferClefPurpose({ questions: { unknown_q: {} } })).toBe('classify')
  })

  test('assistant가 있으면 다른 키보다 우선해 router', () => {
    expect(inferClefPurpose({ questions: { assistant: {}, template_match: {} } })).toBe('router')
  })

  test('스튜디오·도구 계열 키 매핑', () => {
    expect(inferClefPurpose({ questions: { template_match: {} } })).toBe('studio-plan')
    expect(inferClefPurpose({ questions: { file_structure: {} } })).toBe('studio-plan')
    expect(inferClefPurpose({ questions: { completeness: {} } })).toBe('studio-validate')
    expect(inferClefPurpose({ questions: { primary_tool: {} } })).toBe('tool-plan')
    expect(inferClefPurpose({ questions: { sufficient: {} } })).toBe('tool-validate')
    expect(inferClefPurpose({ questions: { subagent: {} } })).toBe('subagent')
  })

  test('QUESTION_PURPOSE 맵 키 매핑', () => {
    expect(inferClefPurpose({ questions: { multiple_actions: {} } })).toBe('compound')
    expect(inferClefPurpose({ questions: { needs_history: {} } })).toBe('history')
    expect(inferClefPurpose({ questions: { tool: {} } })).toBe('tool')
    expect(inferClefPurpose({ questions: { quality: {} } })).toBe('quality')
    expect(inferClefPurpose({ questions: { urgency: {} } })).toBe('urgency')
    expect(inferClefPurpose({ questions: { complexity: {} } })).toBe('tier')
  })
})

describe('inferClefPurposeFromSpecIds', () => {
  test('assistant 우선, 맵, 기본 classify 순', () => {
    expect(inferClefPurposeFromSpecIds(['complexity', 'assistant'])).toBe('router')
    expect(inferClefPurposeFromSpecIds(['urgency'])).toBe('urgency')
    expect(inferClefPurposeFromSpecIds(['template_match'])).toBe('classify') // 스튜디오 키는 맵에 없다
    expect(inferClefPurposeFromSpecIds([])).toBe('classify')
  })
})

describe('extractClefPersona', () => {
  test('비어 있지 않은 문자열만 반환한다', () => {
    expect(extractClefPersona({ state: { persona: 'nova' } })).toBe('nova')
    expect(extractClefPersona({ state: { persona: '' } })).toBeUndefined()
    expect(extractClefPersona({ state: { persona: 42 } })).toBeUndefined()
    expect(extractClefPersona({ state: {} })).toBeUndefined()
    expect(extractClefPersona({})).toBeUndefined()
    expect(extractClefPersona(null)).toBeUndefined()
  })
})

describe('estimateClefInputTokens / neuronsForInputTokens', () => {
  test('직렬화 불가(순환 참조)·undefined는 0', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(estimateClefInputTokens(circular)).toBe(0)
    expect(estimateClefInputTokens(undefined)).toBe(0)
  })

  test('빈 문자열 JSON은 최소 1 토큰, 한글은 1.3 가중', () => {
    expect(estimateClefInputTokens('')).toBe(1) // '""' 2자 → ceil(0.5)=1
    const koreanOnly = '가'.repeat(10)
    const asJson = JSON.stringify(koreanOnly) // 따옴표 2자 + 한글 10자
    expect(estimateClefInputTokens(koreanOnly)).toBe(Math.ceil(10 * 1.3 + (asJson.length - 10) / 4))
    expect(neuronsForInputTokens(1_000_000)).toBe(3455)
    expect(neuronsForInputTokens(0)).toBe(0)
  })
})

describe('resolveClefUsage', () => {
  const req = { state: { current_message: 'hello' }, questions: {} }

  test('보고된 neurons가 유한하면 그대로 쓰고 토큰도 보고값을 우선한다', () => {
    expect(resolveClefUsage(req, { usage: { neurons: 12.5, prompt_tokens: 100, completion_tokens: 7 } }))
      .toEqual({ inputTokens: 100, outputTokens: 7, neurons: 12.5 })
    // input_tokens/output_tokens 별칭도 인정한다
    expect(resolveClefUsage(req, { usage: { neurons: 1, input_tokens: 55, output_tokens: 3 } }))
      .toEqual({ inputTokens: 55, outputTokens: 3, neurons: 1 })
  })

  test('neurons 보고가 없으면 보고 토큰으로 neurons를 계산한다', () => {
    const out = resolveClefUsage(req, { usage: { prompt_tokens: 1_000_000 } })
    expect(out).toEqual({ inputTokens: 1_000_000, outputTokens: null, neurons: 3455 })
  })

  test('neurons가 NaN이면 보고값으로 쓰지 않는다', () => {
    const out = resolveClefUsage(req, { usage: { neurons: NaN, prompt_tokens: 100 } })
    expect(out.inputTokens).toBe(100)
    expect(out.neurons).toBe(neuronsForInputTokens(100))
  })

  test('usage가 없으면 추정으로 대체하고 outputTokens는 null', () => {
    const est = estimateClefInputTokens(req)
    expect(resolveClefUsage(req, null)).toEqual({
      inputTokens: est,
      outputTokens: null,
      neurons: neuronsForInputTokens(est),
    })
    expect(resolveClefUsage(req, { usage: {} }).outputTokens).toBeNull()
    expect(resolveClefUsage(req, undefined).inputTokens).toBe(est)
  })

  test('neurons만 있고 토큰 보고가 없으면 입력은 추정, 출력은 null', () => {
    const out = resolveClefUsage(req, { usage: { neurons: 3 } })
    expect(out).toEqual({ inputTokens: estimateClefInputTokens(req), outputTokens: null, neurons: 3 })
  })
})

describe('recordClefUsage — 단계적 폴백 기록', () => {
  function fakeDb(failFirst: number) {
    const calls: Array<{ sql: string; args: unknown[] }> = []
    let n = 0
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async run() {
                calls.push({ sql, args })
                n++
                if (n <= failFirst) throw new Error(`schema missing (${n})`)
                return { meta: { changes: 1 } }
              },
            }
          },
        }
      },
    }
    return { db: db as unknown as D1Database, calls }
  }

  const entry = {
    purpose: 'router',
    request: { questions: { assistant: {} } },
    latencyMs: 123.6,
    outcome: 'answered',
  }

  test('첫 INSERT가 성공하면 전체 컬럼으로 1회만 기록한다', async () => {
    const { db, calls } = fakeDb(0)
    await expect(recordClefUsage(db, entry)).resolves.toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toContain('neurons')
    expect(calls[0].sql).toContain('persona')
    expect(calls[0].args[0]).toBe('workers-ai')
    expect(calls[0].args[1]).toBe(CLEF_USAGE_MODEL)
    expect(calls[0].args[2]).toBe('clef:router')
    expect(calls[0].args[3]).toBe(124) // latency 반올림
    expect(calls[0].args[14]).toBe('unattributed') // persona 기본값
  })

  test('persona가 있으면 그 값을 기록하고 음수 latency는 0으로 고정한다', async () => {
    const { db, calls } = fakeDb(0)
    await recordClefUsage(db, { ...entry, persona: 'cali', latencyMs: -5 })
    expect(calls[0].args[3]).toBe(0)
    expect(calls[0].args[14]).toBe('cali')
  })

  test('스키마가 좁은 DB에서는 폴백 INSERT로 기록한다', async () => {
    const one = fakeDb(1)
    await expect(recordClefUsage(one.db, entry)).resolves.toBe(true)
    expect(one.calls).toHaveLength(2)
    expect(one.calls[1].sql).not.toContain('persona')
    expect(one.calls[1].sql).toContain('neurons')

    const two = fakeDb(2)
    await expect(recordClefUsage(two.db, entry)).resolves.toBe(true)
    expect(two.calls).toHaveLength(3)
    expect(two.calls[2].sql).not.toContain('neurons')
  })

  test('전부 실패하면 false (throw하지 않는다)', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {})
    const { db, calls } = fakeDb(99)
    await expect(recordClefUsage(db, entry)).resolves.toBe(false)
    expect(calls).toHaveLength(3)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})
