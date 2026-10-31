/// <reference types="jest" />
/**
 * 인용 잠금 (citation-lock) 단위 테스트
 * - checkReferences: 허용 집합 기준 분할 + ungrounded 판정
 * - pickFirstValidReference: 허용·미사용 첫 참조 선택
 * - extractMemoryCitations / validateMemoryCitations: [기억 #id] 검증
 * - citableMemoryIds: 대체된 기억 제외
 * - detectMemoryRecallIntent: 회상 의도 (보수적 — 오탐 케이스 고정)
 */
import {
  checkReferences,
  pickFirstValidReference,
  extractMemoryCitations,
  validateMemoryCitations,
  citableMemoryIds,
  detectMemoryRecallIntent,
  ABSTAIN_NO_MEMORY_TEXT,
  ABSTAIN_UNGROUNDED_TEXT,
  MEMORY_CITATION_INSTRUCTION,
} from '../../src/lib/citation-lock'

describe('checkReferences', () => {
  test('허용된 것만 valid, 나머지는 removed', () => {
    const r = checkReferences(['1', '9', '2'], new Set(['1', '2']))
    expect(r.valid).toEqual(['1', '2'])
    expect(r.removed).toEqual(['9'])
    expect(r.cited).toEqual(['1', '9', '2'])
    expect(r.ungrounded).toBe(false)
  })
  test('인용을 시도했으나 유효한 것이 없으면 ungrounded', () => {
    const r = checkReferences(['9', '10'], new Set(['1']))
    expect(r.ungrounded).toBe(true)
    expect(r.valid).toEqual([])
  })
  test('인용이 없으면 ungrounded 아님 (일반 대화는 판정 대상 아님)', () => {
    const r = checkReferences([], new Set(['1']))
    expect(r.ungrounded).toBe(false)
  })
  test('중복은 valid/removed에서 1번만', () => {
    const r = checkReferences(['1', '1', '9', '9'], new Set(['1']))
    expect(r.valid).toEqual(['1'])
    expect(r.removed).toEqual(['9'])
  })
  test('빈 허용 집합 + 인용 있음 → ungrounded', () => {
    expect(checkReferences(['3'], new Set()).ungrounded).toBe(true)
  })
})

describe('pickFirstValidReference', () => {
  test('허용·미사용 첫 후보 반환', () => {
    const used = new Set(['a'])
    expect(
      pickFirstValidReference(['a', 'b', 'c'], (k) => ['a', 'b', 'c'].includes(k), used),
    ).toBe('b')
  })
  test('허용되지 않은 후보는 건너뜀', () => {
    expect(
      pickFirstValidReference(['x', 'b'], (k) => k === 'b', new Set()),
    ).toBe('b')
  })
  test('없으면 null (지어내지 않는다)', () => {
    expect(pickFirstValidReference(['x'], (k) => k === 'b', new Set())).toBeNull()
    expect(pickFirstValidReference([], () => true, new Set())).toBeNull()
  })
  test('빈 문자열 후보는 건너뜀', () => {
    expect(pickFirstValidReference(['', 'b'], (k) => k === 'b', new Set())).toBe('b')
  })
})

describe('extractMemoryCitations', () => {
  test('[기억 #12] / [기억 12] 모두 추출', () => {
    expect(extractMemoryCitations('답 [기억 #12]이고 [기억 3]도')).toEqual([12, 3])
  })
  test('없으면 []', () => {
    expect(extractMemoryCitations('그냥 답변입니다.')).toEqual([])
  })
  test('0·음수·비숫자는 무시', () => {
    expect(extractMemoryCitations('[기억 #0] [기억 #abc]')).toEqual([])
  })
  test('빈 텍스트 → []', () => {
    expect(extractMemoryCitations('')).toEqual([])
  })
})

describe('validateMemoryCitations', () => {
  test('유효한 인용은 그대로 유지', () => {
    const r = validateMemoryCitations('전화번호는 010-1234 [기억 #12]입니다.', [12])
    expect(r.text).toContain('[기억 #12]')
    expect(r.validIds).toEqual([12])
    expect(r.removedIds).toEqual([])
    expect(r.ungrounded).toBe(false)
  })
  test('지어낸 인용 마커는 제거하고 ungrounded 판정', () => {
    const r = validateMemoryCitations('전화번호는 010-9999 [기억 #99]입니다.', [12])
    expect(r.text).not.toContain('[기억 #99]')
    expect(r.text).toContain('010-9999')
    expect(r.removedIds).toEqual([99])
    expect(r.ungrounded).toBe(true)
  })
  test('유효+지어낸 혼합: 지어낸 것만 제거, 유효는 유지', () => {
    const r = validateMemoryCitations('A [기억 #12]이고 B [기억 #99]입니다.', [12, 13])
    expect(r.text).toContain('[기억 #12]')
    expect(r.text).not.toContain('[기억 #99]')
    expect(r.validIds).toEqual([12])
    expect(r.removedIds).toEqual([99])
    expect(r.ungrounded).toBe(false)
  })
  test('인용이 없으면 텍스트 그대로, ungrounded 아님', () => {
    const r = validateMemoryCitations('안녕하세요.', [12])
    expect(r.text).toBe('안녕하세요.')
    expect(r.ungrounded).toBe(false)
  })
  test('주입된 기억이 없는데 인용하면 전부 제거 + ungrounded', () => {
    const r = validateMemoryCitations('기억에 따르면 [기억 #5]입니다.', [])
    expect(r.text).not.toContain('[기억 #5]')
    expect(r.ungrounded).toBe(true)
  })
  test('대체된 기억 ID를 인용해도 제거 대상 (허용 집합에 없음)', () => {
    // routes는 citableMemoryIds로 대체 기억을 제외한 집합을 넘긴다
    const r = validateMemoryCitations('옛 번호 [기억 #9]입니다.', [1])
    expect(r.removedIds).toEqual([9])
    expect(r.ungrounded).toBe(true)
  })
  test('Set 입력도 받는다', () => {
    const r = validateMemoryCitations('x [기억 #2]', new Set([2]))
    expect(r.validIds).toEqual([2])
  })
  test('지어낸 인용 제거 후 생긴 이중 공백을 정리하고 문장 끝 공백을 trim한다 (감사 §4 #9)', () => {
    // 마커 제거로 생긴 공백 3개가 하나로 정리돼야 한다 (L144 이중 공백 정리 뮤턴트)
    const r = validateMemoryCitations('A [기억 #99]  B입니다.', [12])
    expect(r.text).toBe('A B입니다.')
    // 문장 끝 마커 제거 후 남은 공백도 trim된다
    expect(validateMemoryCitations('A입니다 [기억 #99]', [12]).text).toBe('A입니다')
    // 마커 앞 공백만 남은 경우: 단일 공백은 유지된다 (이중 공백만 정리 대상)
    expect(validateMemoryCitations('A [기억 #99]입니다.', [12]).text).toBe('A 입니다.')
  })
  test('[기억#1] 무공백 형태도 인식하고 검증한다 (감사 §4 #9)', () => {
    expect(extractMemoryCitations('답은 [기억#1]이야.')).toEqual([1])
    const kept = validateMemoryCitations('답은 [기억#1]이야.', [1])
    expect(kept.text).toContain('[기억#1]')
    expect(kept.validIds).toEqual([1])
    const removed = validateMemoryCitations('답은 [기억#1]이야.', [2])
    expect(removed.text).not.toContain('[기억#1]')
    expect(removed.removedIds).toEqual([1])
  })
})

describe('citableMemoryIds', () => {
  test('대체된 기억 제외', () => {
    expect(
      citableMemoryIds([
        { id: 1, superseded: false },
        { id: 9, superseded: true },
        { id: 2 },
      ]),
    ).toEqual([1, 2])
  })
  test('빈 배열 → []', () => {
    expect(citableMemoryIds([])).toEqual([])
  })
})

describe('detectMemoryRecallIntent', () => {
  test.each([
    '내 전화번호 기억해?',
    '내 반려견 이름 기억나?',
    '내 생일 기억하고 있어?',
    '내가 좋아하는 음식 기억해?',
    '내 주소 기억해?',
  ])('회상 질문: %s', (q) => {
    expect(detectMemoryRecallIntent(q)).toBe(true)
  })
  test.each([
    '내 취미가 뭐야?',
    '내 전화번호가 뭐야?',
    '내 생일은 언제야?',
    '내가 좋아하는 음식이 뭐야?',
  ])('소유 표현만 있는 일반 질문은 회상 아님: %s', (q) => {
    expect(detectMemoryRecallIntent(q)).toBe(false)
  })
  test('내 전화번호 알고 있어?', () => {
    expect(detectMemoryRecallIntent('내 전화번호 알고 있어?')).toBe(true)
  })
  test('동사 없는 회상 문구도 인식한다 (감사 §4 #9 — RECALL_VERB_RE 선택 그룹 뮤턴트)', () => {
    // '(하|해|하고|나|에|을|이)?' 선택 그룹이 사라지면 '기억?' 단독은 못 잡는다
    expect(detectMemoryRecallIntent('내 반려견 이름 기억?')).toBe(true)
    expect(detectMemoryRecallIntent('내 반려견 이름 기억')).toBe(true)
    expect(detectMemoryRecallIntent('내 생일 기억?')).toBe(true)
  })
  test.each([
    '내일 뭐해?',
    '이거 뭐야?',
    '오늘 날씨 어때?',
    '메모 작성해줘',
    '뉴스 요약해줘',
    '',
  ])('회상 아님: %s', (q) => {
    expect(detectMemoryRecallIntent(q)).toBe(false)
  })
})

describe('abstain 문구', () => {
  test('기록 없음 응답에 "기록에 없습니다" 포함', () => {
    expect(ABSTAIN_NO_MEMORY_TEXT).toContain('기록에 없습니다')
  })
  test('근거 없음 응답에 단정 금지 취지 포함', () => {
    expect(ABSTAIN_UNGROUNDED_TEXT).toContain('단정하지 않겠습니다')
  })
  test('인용 지시에 [기억 #id] 형식 + 대체됨 경고 포함', () => {
    expect(MEMORY_CITATION_INSTRUCTION).toContain('[기억 #id]')
    expect(MEMORY_CITATION_INSTRUCTION).toContain('기록에 없습니다')
    expect(MEMORY_CITATION_INSTRUCTION).toContain('[대체됨]')
  })
})
