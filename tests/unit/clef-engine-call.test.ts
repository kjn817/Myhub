/// <reference types="jest" />
/**
 * src/services/clef-engine.ts — 호출 파이프라인·결정 로그·정적 검사 성질 테스트.
 *
 * clef-engine-validators.test.ts가 검증기(답안 형식)를 덮은 뒤 남은
 * 28%의 핵심은 callClef 실행 경로다. 고정하는 성질:
 * - 깨진 스펙은 호출 전에 throw로 거부한다 (모델을 부르지 않는다).
 * - 쿼터 오류만 quotaExhausted로 삼키고, 일반 오류는 그대로 던진다.
 * - 일관성 검사에 걸린 답안은 value=null + inconsistent로 버려진다.
 * - 사용량 기록은 성공/실패 모두 남기되, 이미 회계 처리된 invoker는
 *   이중 기록하지 않는다.
 * - 결정 로그에는 원문 메시지 대신 해시·길이만 들어간다.
 * 카나리아: callClef의 일관성 검사를 무력화하면 실패한다.
 */
import {
  ROUTING_SPEC,
  COMPOUND_SPEC,
  CLEF_THRESHOLD_VERSION,
  callClef,
  buildDecisionLogEntry,
  recordDecisionLog,
  staticCheckResponse,
  hasWriteIntent,
  enforceStateSize,
  hashText,
  specHash,
  validateChoiceAnswer,
  type ClefSpec,
} from '../../src/services/clef-engine'
import { markClefUsageAccounted } from '../../src/services/clef-usage'

/** prepare→bind→run 호출을 전부 기록하는 가짜 D1 */
function capturingDb() {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        run: async () => { calls.push({ sql, params }); return { success: true } },
        first: async () => null,
      }),
    }),
  }
  return { db: db as any, calls }
}

const goodRaw = {
  answers: {
    assistant: {
      type: 'choice',
      choice: 'code',
      probabilities: { chat: 0.05, summarize: 0.05, code: 0.8, schedule: 0.05, unclear: 0.05 },
    },
  },
}

describe('callClef — 호출 파이프라인', () => {
  const parse = (raw: unknown) => validateChoiceAnswer(raw, ROUTING_SPEC)

  test('정상 호출: 값을 파싱하고 메타(스펙 해시·선택지 순서·임계 버전)를 돌려준다', async () => {
    const seen: any[] = []
    const invoker = async (req: any) => { seen.push(req); return goodRaw }
    const r = await callClef(invoker, { specs: [ROUTING_SPEC], state: { current_message: '코드 짜줘' }, parse })
    expect(r.value?.choice).toBe('code')
    expect(r.meta.specHash).toBe(specHash([ROUTING_SPEC]))
    expect(r.meta.optionOrder).toEqual(ROUTING_SPEC.options)
    expect(r.meta.thresholdVersion).toBe(CLEF_THRESHOLD_VERSION)
    expect(r.meta.traceId).toMatch(/^clef-/)
    // invoker에는 엔진 표준 요청 형태가 간다
    expect(seen).toHaveLength(1)
    expect(seen[0].model).toBe('clef-flash')
    expect(seen[0].questions.assistant.type).toBe('choice')
    expect(seen[0].questions.assistant.instructions).toBe(ROUTING_SPEC.instructions)
    expect(seen[0].state.current_message).toBe('코드 짜줘')
  })

  test('깨진 스펙은 invoker를 부르기 전에 throw로 거부한다', async () => {
    const bad: ClefSpec = { id: 'broken', type: 'choice', version: 'v', instructions: '', criteria: { a: '1' }, options: ['a'] }
    let called = 0
    const invoker = async () => { called++; return goodRaw }
    await expect(callClef(invoker, { specs: [bad], state: {}, parse })).rejects.toThrow('invalid_spec:broken:')
    expect(called).toBe(0)
  })

  test('파싱 불가 답안은 value=null로 버리고 원본을 함께 돌려준다', async () => {
    const invoker = async () => ({ answers: { assistant: { type: 'choice', choice: 'nope' } } })
    const r = await callClef(invoker, { specs: [ROUTING_SPEC], state: {}, parse })
    expect(r.value).toBeNull()
    expect(r.raw).toBeDefined()
    expect(r.inconsistent).toBeUndefined()
  })

  test('일관성 검사에 걸리면 value를 버리고 inconsistent 사유를 남긴다', async () => {
    const invoker = async () => goodRaw
    const r = await callClef(invoker, {
      specs: [ROUTING_SPEC], state: {}, parse,
      consistency: (v) => (v.choice === 'code' ? 'code_not_allowed_here' : null),
    })
    expect(r.value).toBeNull()
    expect(r.inconsistent).toBe('code_not_allowed_here')
  })

  test('쿼터 오류는 던지지 않고 quotaExhausted로 알린다', async () => {
    const invoker = async () => { throw new Error('daily free allocation has been used up') }
    const r = await callClef(invoker, { specs: [ROUTING_SPEC], state: {}, parse })
    expect(r.value).toBeNull()
    expect(r.quotaExhausted).toBe(true)
  })

  test('일반 오류는 삼키지 않고 그대로 던진다', async () => {
    const invoker = async () => { throw new Error('provider exploded') }
    await expect(callClef(invoker, { specs: [ROUTING_SPEC], state: {}, parse })).rejects.toThrow('provider exploded')
  })

  test('noul 스펙은 criteria를 그대로 실어 보낸다', async () => {
    const seen: any[] = []
    const invoker = async (req: any) => { seen.push(req); return { answers: { multiple_actions: { type: 'noul', noul: 0.3 } } } }
    const r = await callClef(invoker, {
      specs: [COMPOUND_SPEC], state: {},
      parse: (raw: any) => raw?.answers?.multiple_actions?.noul ?? null,
    })
    expect(r.value).toBe(0.3)
    expect(seen[0].questions.multiple_actions.criteria).toEqual(COMPOUND_SPEC.criteria)
  })
})

describe('callClef — 사용량 회계', () => {
  const parse = (raw: unknown) => validateChoiceAnswer(raw, ROUTING_SPEC)

  test('성공 호출은 ai_usage에 outcome=success, capability=clef:router로 기록된다', async () => {
    const { db, calls } = capturingDb()
    const invoker = async () => goodRaw
    await callClef(invoker, { specs: [ROUTING_SPEC], state: { persona: 'nova' }, parse, usage: { db } })
    const usage = calls.filter((c) => c.sql.includes('ai_usage'))
    expect(usage).toHaveLength(1)
    expect(usage[0].params).toContain('success')
    expect(usage[0].params).toContain('clef:router')
    // persona는 state.persona에서 온다
    expect(usage[0].params).toContain('nova')
  })

  test('실패 호출도 outcome=failed로 기록된 뒤 오류가 전파된다', async () => {
    const { db, calls } = capturingDb()
    const invoker = async () => { throw new Error('provider exploded') }
    await expect(callClef(invoker, { specs: [ROUTING_SPEC], state: {}, parse, usage: { db } })).rejects.toThrow('provider exploded')
    const usage = calls.filter((c) => c.sql.includes('ai_usage'))
    expect(usage).toHaveLength(1)
    expect(usage[0].params).toContain('failed')
  })

  test('usage.purpose를 주면 그 용도로, 이미 회계된 invoker면 이중 기록하지 않는다', async () => {
    const { db, calls } = capturingDb()
    const invoker = async () => goodRaw
    await callClef(invoker, { specs: [COMPOUND_SPEC], state: {}, parse: () => 1, usage: { db, purpose: 'quality-check' } })
    const usage = calls.filter((c) => c.sql.includes('ai_usage'))
    expect(usage).toHaveLength(1)
    expect(usage[0].params).toContain('clef:quality-check')

    const accounted = markClefUsageAccounted(async () => goodRaw)
    await callClef(accounted, { specs: [ROUTING_SPEC], state: {}, parse, usage: { db } })
    expect(calls.filter((c) => c.sql.includes('ai_usage'))).toHaveLength(1) // 늘지 않았다
  })

  test('usage.db가 없으면 기록 없이 호출만 한다', async () => {
    const invoker = async () => goodRaw
    const r = await callClef(invoker, { specs: [ROUTING_SPEC], state: {}, parse, usage: { purpose: 'router' } })
    expect(r.value?.choice).toBe('code')
  })
})

describe('결정 로그 — 원문 대신 해시·길이만', () => {
  const input = {
    traceId: 'clef-t1', kind: 'routing', specHash: 'sh1', optionOrder: ['chat', 'code'],
    message: '비밀스러운 원문 메시지', choice: 'code', probabilitiesJson: '{"code":0.8}',
    top: 0.8, margin: 0.6, applied: true, servedPersona: 'builder', mode: 'active', reason: 'classified',
  }

  test('buildDecisionLogEntry: message 필드가 없고 해시·길이·임계 버전이 들어간다', () => {
    const e = buildDecisionLogEntry(input)
    expect((e as any).message).toBeUndefined()
    expect(e.messageHash).toBe(hashText('비밀스러운 원문 메시지'))
    expect(e.messageLength).toBe('비밀스러운 원문 메시지'.length)
    expect(e.thresholdVersion).toBe(CLEF_THRESHOLD_VERSION)
    expect(e.traceId).toBe('clef-t1')
    expect(e.applied).toBe(true)
  })

  test('recordDecisionLog: clef_decision_log에 위치 인자로 정확히 바인딩한다', async () => {
    const { db, calls } = capturingDb()
    await recordDecisionLog(db, buildDecisionLogEntry(input))
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toContain('INSERT INTO clef_decision_log')
    const p = calls[0].params
    expect(p[0]).toBe('clef-t1') // trace_id
    expect(p[1]).toBe('routing') // kind
    expect(p[3]).toBe(JSON.stringify(['chat', 'code'])) // option_order는 JSON 문자열
    expect(p[5]).toBe(hashText('비밀스러운 원문 메시지')) // message_hash
    expect(p[6]).toBe('비밀스러운 원문 메시지'.length)
    expect(p[9]).toBe(0.8) // top
    expect(p[11]).toBe(1) // applied true → 1
    expect(p[12]).toBe('builder')
    expect(typeof p[15]).toBe('string') // created_at ISO
  })

  test('recordDecisionLog: applied=false는 0으로 바인딩한다', async () => {
    const { db, calls } = capturingDb()
    await recordDecisionLog(db, buildDecisionLogEntry({ ...input, applied: false }))
    expect(calls[0].params[11]).toBe(0)
  })
})

describe('staticCheckResponse — 응답 정적 검사', () => {
  test('빈 응답은 empty_response', () => {
    expect(staticCheckResponse('질문', '')).toEqual({ ok: false, issues: ['empty_response'] })
    expect(staticCheckResponse('질문', '   ')).toEqual({ ok: false, issues: ['empty_response'] })
  })

  test('복합 요청에 너무 짧은 응답은 too_short_for_compound', () => {
    const r = staticCheckResponse('일정 등록하고 메모 정리해줘', '네')
    expect(r.ok).toBe(false)
    expect(r.issues).toContain('too_short_for_compound')
    const ok = staticCheckResponse('일정 등록하고 메모 정리해줘', '일정을 등록했고 메모도 정리했습니다. 두 작업 모두 완료했어요.')
    expect(ok.issues).not.toContain('too_short_for_compound')
  })

  test('출처를 요구했는데 출처 표기가 없으면 missing_source', () => {
    expect(staticCheckResponse('근거를 들어 설명해줘', '그냥 그렇습니다. 믿어주세요, 길게 설명합니다.').issues).toContain('missing_source')
    expect(staticCheckResponse('근거를 들어 설명해줘', '출처: 공식 문서에 따르면 그렇습니다.').issues).not.toContain('missing_source')
    expect(staticCheckResponse('근거를 들어 설명해줘', 'https://example.com/docs 를 참고했습니다.').issues).not.toContain('missing_source')
  })

  test('개수 지정 + 완전 빈 응답이면 count_not_addressed가 함께 붙는다', () => {
    const r = staticCheckResponse('메모 3개 찾아줘', '')
    expect(r.issues).toContain('empty_response')
    expect(r.issues).toContain('count_not_addressed')
    // 빈 응답이 아니면 개수 검사는 발동하지 않는다 (현행 계약)
    expect(staticCheckResponse('메모 3개 보여줘', '여기 있습니다').issues).not.toContain('count_not_addressed')
  })

  test('정상 응답은 ok', () => {
    expect(staticCheckResponse('오늘 날씨 어때', '맑고 화창합니다. 외출하기 좋은 날씨예요.')).toEqual({ ok: true, issues: [] })
  })
})

describe('enforceStateSize — 최종 절단 (current_message)', () => {
  test('긴 문자열이 없어 1차 절단이 안 되면 current_message에 생략 표지를 끼워 넣는다', () => {
    const msg = 'x'.repeat(150)
    const state: Record<string, unknown> = { current_message: msg }
    // 각 190자(절단 기준 200 이하)인 키가 많아 JSON 총량만으로 상한을 넘긴다
    for (let i = 0; i < 30; i++) state[`k${i}`] = 'b'.repeat(190)
    const out = enforceStateSize(state)
    // 머리(1000자)·꼬리(1500자) 절단 구간보다 짧으면 원문이 양쪽에 그대로 남고 사이에 표지가 들어간다
    expect(out.current_message).toBe(`${msg}\n[중간 생략]\n${msg}`)
    // 다른 키는 건드리지 않는다
    expect(out.k0).toBe('b'.repeat(190))
    expect(out.k29).toBe('b'.repeat(190))
  })

  test('긴 current_message는 1차 절단에서 먼저 잘리고, 그래도 넘치면 생략 표지까지 붙는다', () => {
    const state: Record<string, unknown> = { current_message: 'a'.repeat(3000) }
    for (let i = 0; i < 30; i++) state[`k${i}`] = 'b'.repeat(190)
    const out = enforceStateSize(state)
    const cm = out.current_message as string
    expect(cm).toContain('…[절단]')
    expect(cm).toContain('[중간 생략]')
    expect(cm.length).toBeLessThan(3000)
  })
})

describe('hasWriteIntent — write-intent 위임', () => {
  test('쓰기 의도 판정을 그대로 노출한다', () => {
    expect(hasWriteIntent('메모 저장해줘')).toBe(true)
    expect(hasWriteIntent('메모 보여줘')).toBe(false)
    expect(hasWriteIntent('')).toBe(false)
  })
})
