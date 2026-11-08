/// <reference types="jest" />
/**
 * src/services/clef-engine.ts — 순수 검증기·유틸 성질 테스트.
 *
 * (2026-11-08 최종 배치 커버리지 보강) 기존 Clef 테스트는 라우터 서비스
 * 계층을 주로 덮어 엔진의 답안 검증기(validateChoiceAnswer 등)가
 * 39%에 머물렀다. 여기는 모델 원시 응답을 받아들이는 경계 검증이므로
 * "형식이 깨진 답안은 반드시 null"이라는 fail-closed 성질을 고정한다.
 * 카나리아: 합계 허용 오차(0.03)나 argmax 검사를 바꾸면 실패한다.
 */
import {
  ROUTING_SPEC,
  COMPOUND_SPEC,
  HISTORY_SPEC,
  URGENCY_SPEC,
  validateSpec,
  validateChoiceAnswer,
  validateNoulAnswer,
  isQuotaError,
  enforceStateSize,
  isRecord,
  isProbability,
  hashText,
  specHash,
  newTraceId,
  MAX_STATE_CHARS,
  type ClefSpec,
} from '../../src/services/clef-engine'

describe('validateSpec — 운영 스펙은 전부 유효, 깨진 스펙은 코드로 거부', () => {
  test('운영 스펙 4종은 오류가 없다', () => {
    for (const spec of [ROUTING_SPEC, COMPOUND_SPEC, HISTORY_SPEC, URGENCY_SPEC]) {
      expect(validateSpec(spec)).toEqual([])
    }
  })

  test('choice: 선택지가 2개 미만이면 choice_needs_options', () => {
    const spec: ClefSpec = { id: 'x', type: 'choice', version: 'v', instructions: '', criteria: { unclear: 'u' }, options: ['unclear'] }
    expect(validateSpec(spec)).toContain('choice_needs_options')
  })

  test('choice: unclear 탈출구가 없으면 choice_needs_unclear_escape', () => {
    const spec: ClefSpec = { id: 'x', type: 'choice', version: 'v', instructions: '', criteria: { a: '1', b: '2' }, options: ['a', 'b'] }
    expect(validateSpec(spec)).toContain('choice_needs_unclear_escape')
  })

  test('choice: options 순서가 criteria 키 순서와 다르면 option_order_mismatch', () => {
    const spec: ClefSpec = { id: 'x', type: 'choice', version: 'v', instructions: '', criteria: { a: '1', unclear: 'u' }, options: ['unclear', 'a'] }
    expect(validateSpec(spec)).toContain('option_order_mismatch')
  })

  test('noul: 경계 기준(true/false)이 없으면 noul_needs_boundary_criteria', () => {
    const spec: ClefSpec = { id: 'x', type: 'noul', version: 'v', instructions: '', criteria: { true: 't' } }
    expect(validateSpec(spec)).toContain('noul_needs_boundary_criteria')
  })

  test('score: 단계가 2개 미만이면 score_needs_levels', () => {
    const spec: ClefSpec = { id: 'x', type: 'score', version: 'v', instructions: '', criteria: {}, options: ['low'] }
    expect(validateSpec(spec)).toContain('score_needs_levels')
  })
})

describe('validateChoiceAnswer — 형식 검증 (fail-closed)', () => {
  const validRaw = {
    answers: {
      assistant: {
        type: 'choice',
        choice: 'code',
        probabilities: { chat: 0.05, summarize: 0.05, code: 0.8, schedule: 0.05, unclear: 0.05 },
      },
    },
  }

  test('정상 답안 → choice/top/second/margin을 계산해 돌려준다', () => {
    const r = validateChoiceAnswer(validRaw, ROUTING_SPEC)
    expect(r).not.toBeNull()
    expect(r!.choice).toBe('code')
    expect(r!.top).toBeCloseTo(0.8)
    expect(r!.second).toBeCloseTo(0.05)
    expect(r!.margin).toBeCloseTo(0.75)
  })

  test('확률 합이 1에서 벗어나면 null', () => {
    const raw = structuredClone(validRaw)
    raw.answers.assistant.probabilities.code = 0.4 // 합 0.6
    expect(validateChoiceAnswer(raw, ROUTING_SPEC)).toBeNull()
  })

  test('choice가 확률 최대 항목과 다르면 null (말과 확률의 불일치 거부)', () => {
    const raw = structuredClone(validRaw)
    raw.answers.assistant.choice = 'chat'
    expect(validateChoiceAnswer(raw, ROUTING_SPEC)).toBeNull()
  })

  test('스펙에 없는 확률 키가 있으면 null', () => {
    const raw: any = structuredClone(validRaw)
    raw.answers.assistant.probabilities.bogus = 0.01
    expect(validateChoiceAnswer(raw, ROUTING_SPEC)).toBeNull()
  })

  test('확률이 [0,1] 밖이면 null', () => {
    const raw = structuredClone(validRaw)
    raw.answers.assistant.probabilities.code = 1.2
    raw.answers.assistant.probabilities.chat = -0.25
    expect(validateChoiceAnswer(raw, ROUTING_SPEC)).toBeNull()
  })

  test('answers가 없거나 답안 타입이 다르면 null', () => {
    expect(validateChoiceAnswer({}, ROUTING_SPEC)).toBeNull()
    expect(validateChoiceAnswer(null, ROUTING_SPEC)).toBeNull()
    const raw: any = structuredClone(validRaw)
    raw.answers.assistant.type = 'noul'
    expect(validateChoiceAnswer(raw, ROUTING_SPEC)).toBeNull()
  })

  test('questionId를 주면 그 키의 답안을 읽는다', () => {
    const raw = { answers: { custom_q: validRaw.answers.assistant } }
    const r = validateChoiceAnswer(raw, ROUTING_SPEC, 'custom_q')
    expect(r).not.toBeNull()
    expect(r!.choice).toBe('code')
    // 기본 키(assistant)에는 답이 없으므로 questionId 없이는 null
    expect(validateChoiceAnswer(raw, ROUTING_SPEC)).toBeNull()
  })
})

describe('validateNoulAnswer', () => {
  test('정상 답안 → noul 값을 돌려준다', () => {
    const raw = { answers: { multiple_actions: { type: 'noul', noul: 0.9 } } }
    expect(validateNoulAnswer(raw, COMPOUND_SPEC)).toBeCloseTo(0.9)
  })

  test('noul이 확률 범위를 벗어나거나 타입이 다르면 null', () => {
    expect(validateNoulAnswer({ answers: { multiple_actions: { type: 'noul', noul: 1.5 } } }, COMPOUND_SPEC)).toBeNull()
    expect(validateNoulAnswer({ answers: { multiple_actions: { type: 'choice', noul: 0.5 } } }, COMPOUND_SPEC)).toBeNull()
    expect(validateNoulAnswer({ answers: {} }, COMPOUND_SPEC)).toBeNull()
  })
})

describe('isQuotaError — 쿼터 소진 신호만 골라낸다', () => {
  test('일일 할당량·뉴런 소진 문구와 숫자 코드를 인식한다', () => {
    expect(isQuotaError(new Error('used up your daily free allocation'))).toBe(true)
    expect(isQuotaError(new Error('Daily quota exhausted'))).toBe(true)
    expect(isQuotaError({ code: '3036', message: 'x' })).toBe(true)
    expect(isQuotaError({ errorCode: '4006' })).toBe(true)
  })

  test('일반 오류는 쿼터 오류가 아니다', () => {
    expect(isQuotaError(new Error('network timeout'))).toBe(false)
    expect(isQuotaError(new Error('문법 오류'))).toBe(false)
    expect(isQuotaError(null)).toBe(false)
  })
})

describe('enforceStateSize — 상태 크기 상한', () => {
  test('작은 상태는 그대로 (우선순위 키 persona 포함)', () => {
    const out = enforceStateSize({ persona: 'keeper', note: '짧은 메모' })
    expect(out.persona).toBe('keeper')
    expect(out.note).toBe('짧은 메모')
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_STATE_CHARS)
  })

  test('긴 문자열 필드는 절단 표지와 함께 상한 안으로 줄어든다', () => {
    const out = enforceStateSize({ persona: 'keeper', blob: 'x'.repeat(5000) })
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_STATE_CHARS)
    expect(String(out.blob)).toContain('…[절단]')
    expect(out.persona).toBe('keeper')
  })
})

describe('기본 유틸', () => {
  test('isRecord / isProbability 경계', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isProbability(0)).toBe(true)
    expect(isProbability(1)).toBe(true)
    expect(isProbability(1.01)).toBe(false)
    expect(isProbability(NaN)).toBe(false)
    expect(isProbability('0.5')).toBe(false)
  })

  test('hashText는 결정적이고 입력에 민감하다', () => {
    expect(hashText('abc')).toBe(hashText('abc'))
    expect(hashText('abc')).not.toBe(hashText('abd'))
    expect(hashText('abc')).toMatch(/^h[0-9a-f]{16}$/)
  })

  test('specHash는 버전이 바뀌면 달라진다', () => {
    expect(specHash(ROUTING_SPEC)).toBe(specHash(ROUTING_SPEC))
    expect(specHash(ROUTING_SPEC)).not.toBe(specHash({ ...ROUTING_SPEC, version: 'routing-v4' }))
    expect(specHash([ROUTING_SPEC, COMPOUND_SPEC])).not.toBe(specHash(ROUTING_SPEC))
  })

  test('newTraceId는 clef- 접두사와 매번 다른 값', () => {
    const a = newTraceId()
    const b = newTraceId()
    expect(a.startsWith('clef-')).toBe(true)
    expect(a).not.toBe(b)
  })
})
