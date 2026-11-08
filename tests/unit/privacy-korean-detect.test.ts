/// <reference types="jest" />
/**
 * src/services/privacy-korean.ts — 한국어 PII 후보 추출·채점·판정 성질 테스트.
 *
 * (2026-11-08 최종 배치 커버리지 보강) 보안엔진의 한국어 경로가 53%에
 * 머물러, 라벨/직함/주소처럼 설계상 확정적인 케이스와 동형어 오탐 방지,
 * 그리고 제로폭 문자 우회 차단(형식 제거 사본으로 판정하고 위치를 원본에
 * 되돌리는 구조)을 고정한다. 경계값은 THRESHOLDS 표 그 자체로 검증한다.
 * 카나리아: NAME tokenize 임계(0.8)나 김밥 패널티를 바꾸면 실패한다.
 */
import {
  extractCandidates,
  actionFor,
  detectKorean,
  judgeKorean,
} from '../../src/services/privacy-korean'

describe('actionFor — THRESHOLDS 경계값', () => {
  test('NAME: tokenize 0.8 / gray 0.6', () => {
    expect(actionFor(0.8, 'NAME', false)).toBe('tokenize')
    expect(actionFor(0.79, 'NAME', false)).toBe('gray')
    expect(actionFor(0.6, 'NAME', false)).toBe('gray')
    expect(actionFor(0.59, 'NAME', false)).toBe('pass')
  })

  test('ADDRESS: tokenize 0.75 / gray 0.55', () => {
    expect(actionFor(0.75, 'ADDRESS', false)).toBe('tokenize')
    expect(actionFor(0.55, 'ADDRESS', false)).toBe('gray')
    expect(actionFor(0.54, 'ADDRESS', false)).toBe('pass')
  })

  test('RELATION: tokenize 0.85 / gray 0.7', () => {
    expect(actionFor(0.85, 'RELATION', false)).toBe('tokenize')
    expect(actionFor(0.7, 'RELATION', false)).toBe('gray')
    expect(actionFor(0.69, 'RELATION', false)).toBe('pass')
  })

  test('민감 출처에서는 gray 구간도 tokenize로 승격된다 (fail-closed)', () => {
    expect(actionFor(0.6, 'NAME', true)).toBe('tokenize')
    expect(actionFor(0.55, 'ADDRESS', true)).toBe('tokenize')
    expect(actionFor(0.7, 'RELATION', true)).toBe('tokenize')
    // gray 미만은 출처와 무관하게 pass
    expect(actionFor(0.59, 'NAME', true)).toBe('pass')
  })
})

describe('extractCandidates — 스팬 무결성', () => {
  test('문자열이 아닌 입력은 빈 결과', () => {
    expect(extractCandidates(undefined as any)).toEqual({ candidates: [], overflow: 0 })
    expect(extractCandidates(123 as any)).toEqual({ candidates: [], overflow: 0 })
  })

  test('모든 후보의 [start,end)는 원본 텍스트 범위 안이고 비어 있지 않다', () => {
    const text = '이름: 홍길동, 주소: 서울특별시 강남구 테헤란로 123, 김정남 부장님 참석'
    const { candidates } = extractCandidates(text)
    expect(candidates.length).toBeGreaterThan(0)
    for (const c of candidates) {
      expect(c.start).toBeGreaterThanOrEqual(0)
      expect(c.end).toBeGreaterThan(c.start)
      expect(c.end).toBeLessThanOrEqual(text.length)
      expect(text.slice(c.start, c.end).length).toBe(c.end - c.start)
    }
  })
})

describe('detectKorean — 토큰화 판정', () => {
  test('라벨이 붙은 이름은 NAME으로 토큰화된다', () => {
    const text = '이름: 홍길동'
    const findings = detectKorean(text)
    const names = findings.filter((f) => f.type === 'NAME')
    expect(names).toHaveLength(1)
    expect(text.slice(names[0].start, names[0].end)).toBe('홍길동')
    expect(names[0].level).toBe(2)
    expect(names[0].source).toBe('context')
  })

  test('직함이 붙은 이름은 NAME으로 토큰화된다', () => {
    const text = '김정남 부장님이 내일 참석합니다'
    const names = detectKorean(text).filter((f) => f.type === 'NAME')
    expect(names).toHaveLength(1)
    expect(text.slice(names[0].start, names[0].end)).toBe('김정남')
  })

  test('라벨+시도+도로명 주소는 ADDRESS로 토큰화된다', () => {
    const text = '주소: 서울특별시 강남구 테헤란로 123'
    const addrs = detectKorean(text).filter((f) => f.type === 'ADDRESS')
    expect(addrs.length).toBeGreaterThanOrEqual(1)
    expect(text.slice(addrs[0].start, addrs[0].end)).toContain('서울특별시')
  })

  test('동형어(김밥)는 이름으로 토큰화되지 않는다', () => {
    const findings = detectKorean('김밥을 먹었다')
    expect(findings.filter((f) => f.type === 'NAME')).toEqual([])
  })

  test('개인정보가 없는 문장은 빈 결과', () => {
    expect(detectKorean('오늘 날씨가 좋습니다')).toEqual([])
  })

  test('제로폭 문자를 끼운 이름도 원본 좌표로 탐지된다 (우회 차단)', () => {
    const text = '이름: 김\u200B정남'
    const names = detectKorean(text).filter((f) => f.type === 'NAME')
    expect(names).toHaveLength(1)
    const span = text.slice(names[0].start, names[0].end)
    // 원본 스팬은 제로폭 문자를 포함한 채로 잘려야 한다 (정본 위치 복원)
    expect(span).toContain('\u200B')
    expect(span.startsWith('김')).toBe(true)
    expect(span.endsWith('남')).toBe(true)
  })
})

describe('judgeKorean — 후보 상한과 관계 신호', () => {
  test('maxCandidates를 넘기면 overflow로 셈하고 그만큼만 채점한다', () => {
    const text = '이름: 홍길동, 이름: 김철수, 이름: 이영희, 이름: 박민수'
    const r = judgeKorean(text, { maxCandidates: 2 })
    expect(r.scored).toHaveLength(2)
    expect(r.overflow).toBe(2)
    expect(r.actions).toHaveLength(2)
  })

  test('관계어가 있으면 relationSignal이 켜진다', () => {
    expect(judgeKorean('아내에게 전화했다').relationSignal).toBe(true)
    expect(judgeKorean('오늘 날씨가 좋다').relationSignal).toBe(false)
  })

  test('라벨 이름은 actions에서 tokenize 판정을 받는다', () => {
    const r = judgeKorean('이름: 홍길동')
    const idx = r.scored.findIndex((s) => s.type === 'NAME')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(r.actions[idx]).toBe('tokenize')
  })
})
