/// <reference types="jest" />
/**
 * src/services/privacy-korean-clef.ts — Clef 한국어 후보 분류기 성질 테스트.
 *
 * 기존에는 privacy-gateway 경유로만 13% 닿던 모듈을 직접 검증한다:
 * 요청 조립(질문·기준·문맥 창·300자 절단), 점수 경계(0/1 허용, 범위 밖·
 * NaN·문자열은 malformed), 오류 분류(quota/capacity/unavailable/timeout),
 * 그리고 "형식이 깨진 응답은 절대 점수로 승격되지 않는다"는 fail-closed 성질.
 * 카나리아: quota 정규식에서 3036을 지우거나 isProb의 상한(<=1)을 풀면 실패한다.
 */
import {
  classifyWithClef,
  isRecord,
  KoreanClassifierError,
  type ClefInvoke,
  type ClefInvokeRequest,
} from '../../src/services/privacy-korean-clef'
import { PrivacyEngineError } from '../../src/services/privacy-engine'
import type { KoreanCandidate } from '../../src/services/privacy-korean'

const TEXT = '오늘 김철수 과장이 회의에서 보고했다'
const NAME_CAND: KoreanCandidate = { type: 'NAME', start: 3, end: 6, cue: '과장' }

function okInvoke(scores: number[], capture?: (r: ClefInvokeRequest) => void): ClefInvoke {
  return async (req) => {
    capture?.(req)
    const answers: Record<string, unknown> = {}
    scores.forEach((s, i) => {
      answers[`cand_${i}`] = { type: 'noul', noul: s }
    })
    return { answers }
  }
}

describe('KoreanClassifierError', () => {
  test('reasonCode를 보존하고 PrivacyEngineError 계열이다', () => {
    const e = new KoreanClassifierError('context-quota')
    expect(e).toBeInstanceOf(PrivacyEngineError)
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('KoreanClassifierError')
    expect(e.reasonCode).toBe('context-quota')
    expect(e.message).toBe('korean-classifier:context-quota')
  })
})

describe('isRecord', () => {
  test.each([
    [{}, true],
    [{ a: 1 }, true],
    [Object.create(null), true],
    [null, false],
    [undefined, false],
    [[], false],
    [[1, 2], false],
    ['x', false],
    [0, false],
    [true, false],
  ])('isRecord(%p) === %p', (v, expected) => {
    expect(isRecord(v)).toBe(expected)
  })
})

describe('classifyWithClef — 빈 후보', () => {
  test('후보가 없으면 invoke를 호출하지 않고 []를 반환한다', async () => {
    const invoke = jest.fn(async () => {
      throw new Error('must not be called')
    })
    await expect(classifyWithClef(invoke as ClefInvoke, TEXT, [])).resolves.toEqual([])
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('classifyWithClef — 요청 조립', () => {
  test('모델·상태·질문 구조가 계약대로 조립된다', async () => {
    let captured: ClefInvokeRequest | undefined
    const out = await classifyWithClef(okInvoke([0.9], (r) => (captured = r)), TEXT, [NAME_CAND])
    expect(out).toEqual([{ ...NAME_CAND, score: 0.9 }])
    expect(captured?.model).toBe('clef-flash')
    expect(captured?.state).toEqual({
      current_message: TEXT,
      previous_message: '',
      previous_persona: null,
      active_workflow: false,
    })
    const q = captured?.questions.cand_0
    expect(q?.type).toBe('noul')
    expect(q?.criteria.true).toBe('특정 개인 한 사람을 가리키는 성명이다.')
    expect(q?.criteria.false).toBe(
      '직함만, 지명, 상호, 음식·사물 이름, 일반 명사, 예시 이름(홍길동)은 성명이 아니다.',
    )
    // 문맥 창에는 후보 구간이 ⟦⟧로 표시되어 들어간다
    expect(q?.instructions).toContain('⟦김철수⟧')
    expect(q?.instructions.startsWith('아래 문장에서 표시된 구간이 특정 개인의 성명(성+이름 전체)인가?')).toBe(true)
  })

  test('후보 타입마다 서로 다른 기준(true/false)이 실린다', async () => {
    const text = '서울시 강남구 테헤란로 123에 사는 우리 팀장 김 부장'
    const cands: KoreanCandidate[] = [
      { type: 'NAME', start: 24, end: 27, cue: '부장' },
      { type: 'ADDRESS', start: 0, end: 16, cue: '로' },
      { type: 'RELATION', start: 20, end: 27, cue: '팀장' },
    ]
    let captured: ClefInvokeRequest | undefined
    await classifyWithClef(okInvoke([0.1, 0.2, 0.3], (r) => (captured = r)), text, cands)
    const qs = [captured?.questions.cand_0, captured?.questions.cand_1, captured?.questions.cand_2]
    expect(new Set(qs.map((q) => q?.criteria.true)).size).toBe(3)
    expect(new Set(qs.map((q) => q?.instructions.split(' 문맥:')[0])).size).toBe(3)
    expect(qs[1]?.instructions).toContain('⟦서울시 강남구 테헤란로 123⟧')
  })

  test('긴 텍스트는 상태 메시지가 300자로 절단되고 문맥 창도 300자를 넘지 않는다', async () => {
    const longText = '가'.repeat(200) + '김철수' + '나'.repeat(200)
    const cand: KoreanCandidate = { type: 'NAME', start: 200, end: 203, cue: '' }
    let captured: ClefInvokeRequest | undefined
    await classifyWithClef(okInvoke([0.5], (r) => (captured = r)), longText, [cand])
    expect(captured?.state.current_message).toBe(longText.slice(0, 300))
    expect(captured?.state.current_message.length).toBe(300)
    const instr = captured?.questions.cand_0.instructions ?? ''
    const window = instr.split(' 문맥: ')[1] ?? ''
    expect(window.length).toBeLessThanOrEqual(300)
    expect(window).toContain('⟦김철수⟧')
  })

  test('텍스트 맨 앞의 후보는 창 시작이 0으로 고정되어도 표시된다', async () => {
    const cand: KoreanCandidate = { type: 'NAME', start: 0, end: 3, cue: '' }
    let captured: ClefInvokeRequest | undefined
    await classifyWithClef(okInvoke([0.5], (r) => (captured = r)), '김철수가 왔다', [cand])
    expect(captured?.questions.cand_0.instructions).toContain('⟦김철수⟧가 왔다')
  })
})

describe('classifyWithClef — 점수 매핑', () => {
  test('점수는 후보 순서대로 매핑되고 원본 필드가 보존된다', async () => {
    const cands: KoreanCandidate[] = [
      { type: 'NAME', start: 0, end: 3, cue: 'a' },
      { type: 'ADDRESS', start: 5, end: 9, cue: 'b' },
      { type: 'RELATION', start: 11, end: 14, cue: 'c' },
    ]
    const out = await classifyWithClef(okInvoke([0, 1, 0.42]), 'x'.repeat(20), cands)
    expect(out.map((o) => o.score)).toEqual([0, 1, 0.42])
    expect(out.map((o) => o.cue)).toEqual(['a', 'b', 'c'])
  })

  test('경계 점수 0과 1은 유효하다', async () => {
    const out = await classifyWithClef(okInvoke([0, 1]), TEXT, [NAME_CAND, NAME_CAND])
    expect(out.map((o) => o.score)).toEqual([0, 1])
  })
})

describe('classifyWithClef — malformed 응답은 fail-closed', () => {
  const badRaws: Array<[string, unknown]> = [
    ['null', null],
    ['배열', []],
    ['문자열', 'answers'],
    ['숫자', 42],
    ['answers 없음', {}],
    ['answers null', { answers: null }],
    ['answers 배열', { answers: [] }],
    ['답변 null', { answers: { cand_0: null } }],
    ['답변 타입 불일치', { answers: { cand_0: { type: 'bool', noul: 0.5 } } }],
    ['noul 없음', { answers: { cand_0: { type: 'noul' } } }],
    ['noul 음수', { answers: { cand_0: { type: 'noul', noul: -0.01 } } }],
    ['noul 1 초과', { answers: { cand_0: { type: 'noul', noul: 1.01 } } }],
    ['noul NaN', { answers: { cand_0: { type: 'noul', noul: NaN } } }],
    ['noul Infinity', { answers: { cand_0: { type: 'noul', noul: Infinity } } }],
    ['noul 문자열', { answers: { cand_0: { type: 'noul', noul: '0.5' } } }],
  ]
  test.each(badRaws)('%s → context-malformed', async (_label, raw) => {
    const invoke: ClefInvoke = async () => raw
    await expect(classifyWithClef(invoke, TEXT, [NAME_CAND])).rejects.toMatchObject({
      name: 'KoreanClassifierError',
      reasonCode: 'context-malformed',
    })
  })

  test('두 번째 후보의 답변이 깨지면 부분 결과를 반환하지 않고 전체가 실패한다', async () => {
    const invoke: ClefInvoke = async () => ({
      answers: { cand_0: { type: 'noul', noul: 0.9 }, cand_1: { type: 'noul', noul: 2 } },
    })
    await expect(classifyWithClef(invoke, TEXT, [NAME_CAND, NAME_CAND])).rejects.toMatchObject({
      reasonCode: 'context-malformed',
    })
  })

  test('답변이 후보보다 적으면 malformed', async () => {
    const invoke: ClefInvoke = async () => ({ answers: { cand_0: { type: 'noul', noul: 0.5 } } })
    await expect(classifyWithClef(invoke, TEXT, [NAME_CAND, NAME_CAND])).rejects.toMatchObject({
      reasonCode: 'context-malformed',
    })
  })
})

describe('classifyWithClef — 오류 분류', () => {
  const cases: Array<[string, unknown, string]> = [
    ['코드 3036', new Error('workers ai error 3036'), 'context-quota'],
    ['코드 4006', new Error('4006 bad request'), 'context-quota'],
    ['quota 문구', new Error('Quota exceeded for today'), 'context-quota'],
    ['neuron 문구', new Error('NEURON limit reached'), 'context-quota'],
    ['코드 3040', new Error('error 3040'), 'context-capacity'],
    ['capacity 문구', new Error('Capacity temporarily unavailable'), 'context-capacity'],
    ['overloaded 문구', new Error('model overloaded'), 'context-capacity'],
    ['일반 오류', new Error('network down'), 'context-unavailable'],
    ['문자열로 reject된 3036', 'error 3036', 'context-quota'],
    ['문자열 reject 일반', 'boom', 'context-unavailable'],
    ['객체 reject (message 없음)', { code: 1 }, 'context-unavailable'],
  ]
  test.each(cases)('%s → %s', async (_label, thrown, reason) => {
    const invoke: ClefInvoke = async () => {
      throw thrown
    }
    await expect(classifyWithClef(invoke, TEXT, [NAME_CAND])).rejects.toMatchObject({
      name: 'KoreanClassifierError',
      reasonCode: reason,
    })
  })

  test('KoreanClassifierError는 그대로 통과한다 (재분류 금지)', async () => {
    const original = new KoreanClassifierError('context-malformed')
    const invoke: ClefInvoke = async () => {
      throw original
    }
    await expect(classifyWithClef(invoke, TEXT, [NAME_CAND])).rejects.toBe(original)
  })

  test('timeoutMs 안에 응답이 없으면 context-timeout', async () => {
    const invoke: ClefInvoke = () => new Promise(() => {})
    await expect(
      classifyWithClef(invoke, TEXT, [NAME_CAND], { timeoutMs: 25 }),
    ).rejects.toMatchObject({ reasonCode: 'context-timeout' })
  })

  test('opts 없이(기본 타임아웃) 빠른 응답은 정상 처리된다', async () => {
    const out = await classifyWithClef(okInvoke([0.7]), TEXT, [NAME_CAND])
    expect(out[0].score).toBe(0.7)
  })

  test('opts가 빈 객체여도 기본 타임아웃으로 동작한다', async () => {
    const out = await classifyWithClef(okInvoke([0.3]), TEXT, [NAME_CAND], {})
    expect(out[0].score).toBe(0.3)
  })
})
