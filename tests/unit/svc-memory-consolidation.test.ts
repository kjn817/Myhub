/// <reference types="jest" />
/**
 * memory-consolidation.ts 단위 테스트 (순수 헬퍼 — 결정적 규칙)
 * - kstParts: KST 날짜·시간 변환
 * - contentTokens: 토큰화 + 조사 제거
 * - findDuplicateGroups / pickMergeSurvivor: 중복 그룹·생존자
 * - detectContradiction: 모순 판정 (부정 표지 + 토큰 교집합 + 엔티티 완화)
 * - tierOf: 노화 티어 파생
 */
import {
  CONSOLIDATION_HOUR_KST,
  contentTokens,
  detectContradiction,
  findDuplicateGroups,
  hasNegationMarker,
  kstParts,
  pickMergeSurvivor,
  tierOf,
  type ConsolidationRow,
} from '../../src/services/memory-consolidation'

function row(over: Partial<ConsolidationRow> & { id: number; content: string }): ConsolidationRow {
  return {
    summary: null,
    entities: null,
    accessCount: 0,
    lastAccessedAt: null,
    updatedAt: '2026-10-26T00:00:00.000Z',
    contradictionFlag: 0,
    ...over,
  }
}

describe('kstParts', () => {
  test('03:10 KST → date 2026-10-26, hour 3', () => {
    const p = kstParts(new Date('2026-10-26T03:10:00+09:00'))
    expect(p).toEqual({ date: '2026-10-26', hour: 3 })
  })
  test('UTC 18:00 → 다음날 03:00 KST', () => {
    const p = kstParts(new Date('2026-10-25T18:00:00Z'))
    expect(p).toEqual({ date: '2026-10-26', hour: 3 })
  })
  test('10:00 KST는 수면 창이 아님', () => {
    expect(kstParts(new Date('2026-10-26T10:00:00+09:00')).hour).not.toBe(CONSOLIDATION_HOUR_KST)
  })
})

describe('contentTokens', () => {
  test('조사 제거 후 토큰 집합 (1글자는 제외)', () => {
    const tokens = contentTokens('팀 회의는 매주 월요일 10시에 열린다.')
    expect(tokens.has('회의')).toBe(true)
    expect(tokens.has('회의는')).toBe(false)
    expect(tokens.has('10시')).toBe(true)
    expect(tokens.has('월요일')).toBe(true)
    expect(tokens.has('팀')).toBe(false) // 1글자 토큰은 제외
  })
})

describe('findDuplicateGroups / pickMergeSurvivor', () => {
  test('대소문자·공백·구두점 차이만 있는 기억을 한 그룹으로 묶는다', () => {
    const rows = [
      row({ id: 1, content: 'Hello World' }),
      row({ id: 2, content: 'hello world!' }),
      row({ id: 3, content: 'Hello  World' }),
      row({ id: 4, content: '전혀 다른 내용입니다.' }),
    ]
    const groups = findDuplicateGroups(rows)
    expect(groups).toHaveLength(1)
    expect(groups[0].map((r) => r.id).sort()).toEqual([1, 2, 3])
  })

  test('생존자는 최신 updated_at, 동점 시 접근 횟수, 그 다음 id', () => {
    const group = [
      row({ id: 1, content: 'x', updatedAt: '2026-10-20T00:00:00.000Z', accessCount: 10 }),
      row({ id: 2, content: 'x', updatedAt: '2026-10-25T00:00:00.000Z', accessCount: 0 }),
      row({ id: 3, content: 'x', updatedAt: '2026-10-25T00:00:00.000Z', accessCount: 5 }),
    ]
    expect(pickMergeSurvivor(group).id).toBe(3)
    const tie = [
      row({ id: 4, content: 'x', updatedAt: '2026-10-25T00:00:00.000Z', accessCount: 5 }),
      row({ id: 5, content: 'x', updatedAt: '2026-10-25T00:00:00.000Z', accessCount: 5 }),
    ]
    expect(pickMergeSurvivor(tie).id).toBe(5)
  })
})

describe('hasNegationMarker / detectContradiction', () => {
  test('변경 표지 감지', () => {
    expect(hasNegationMarker('회의 시간이 변경됐다.')).toBe(true)
    expect(hasNegationMarker('회의 시간은 10시다.')).toBe(false)
  })

  test('공유 토큰 + 한쪽만 변경 표지 → 모순', () => {
    const a = { content: '팀 회의는 매주 월요일 10시에 열린다.', entities: null }
    const b = { content: '팀 회의 시간이 10시에서 11시로 변경됐다.', entities: null }
    expect(detectContradiction(a, b)).toBe(true)
  })

  test('둘 다 표지 없음 → 모순 아님', () => {
    const a = { content: '점심은 보통 12시에 먹는다.', entities: null }
    const b = { content: '저녁은 보통 7시에 먹는다.', entities: null }
    expect(detectContradiction(a, b)).toBe(false)
  })

  test('둘 다 표지 있음 → 모순 아님', () => {
    const a = { content: '회의가 취소됐다.', entities: null }
    const b = { content: '모임이 변경됐다.', entities: null }
    expect(detectContradiction(a, b)).toBe(false)
  })

  test('정규화 동일(near-duplicate)은 모순이 아니라 병합 대상', () => {
    const a = { content: 'Hello World', entities: null }
    const b = { content: 'hello world!', entities: null }
    expect(detectContradiction(a, b)).toBe(false)
  })

  test('엔티티 공유 시 토큰 기준 완화 (교집합 0.33 + 엔티티 공유 → 모순)', () => {
    const a = {
      content: '아내는 아침마다 커피를 마시고 신문을 읽는다.',
      entities: JSON.stringify(['아내']),
    }
    const b = {
      content: '아내가 커피를 그만 마신다고 어제 저녁에 말했다.',
      entities: JSON.stringify(['아내']),
    }
    expect(detectContradiction(a, b)).toBe(true)
  })

  test('엔티티 공유 없이 교집합 0.33 → 모순 아님', () => {
    const a = {
      content: '아내는 아침마다 커피를 마시고 신문을 읽는다.',
      entities: null,
    }
    const b = {
      content: '아내가 커피를 그만 마신다고 어제 저녁에 말했다.',
      entities: null,
    }
    expect(detectContradiction(a, b)).toBe(false)
  })
})

describe('tierOf', () => {
  test('100일 전·접근 0 → archived', () => {
    expect(tierOf(row({
      id: 1, content: '오래된 기억이다.',
      updatedAt: '2026-07-18T00:00:00.000Z',
    }))).toBe('archived')
  })
  test('최근 → hot', () => {
    expect(tierOf(row({
      id: 2, content: '최근 기억이다.',
      updatedAt: new Date().toISOString(),
    }))).toBe('hot')
  })
})
