/// <reference types="jest" />
/**
 * src/services/privacy-korean.ts — 한국어 개인정보 판정 성질 테스트 (보강).
 * (privacy-korean-detect·privacy-gateway 스위트와 겹치지 않는 채점 맥락들.
 *  모든 기대값은 2026-11-08 실측으로 확정한 현행 판정이다.)
 *
 * 핵심 성질: ① 직함·존칭·라벨·요청 동사 맥락이 이름 점수를 임계 위로
 * 올리고, 맥락 없는 동형어·일반명사(김밥)는 임계 아래에 머문다
 * ② 주소는 시도 확장·건물 상세까지 한 구간으로 잡고, 회색 지대 주소는
 * 민감 출처에서만 tokenize로 승격된다 ③ 성+직함은 RELATION으로 잡힌다
 * ④ 보이지 않는 형식 문자(U+200B 등)로 쪼갠 이름도 원본 좌표로 탐지한다
 * ⑤ 한글 덩어리 중간에 낀 이름 형태는 경계가 없어 후보가 되지 않는다.
 * 카나리아: scoreName의 직함 가점(+0.4)이나 scoreAddress의 시도 가점을
 * 지우면 실패한다.
 */
import {
  actionFor,
  detectKorean,
  extractCandidates,
  judgeKorean,
} from '../../src/services/privacy-korean'

const spansOf = (text: string, opts?: { sensitiveSource?: boolean }) =>
  detectKorean(text, opts).map((f) => ({ type: f.type, text: text.slice(f.start, f.end), level: f.level }))

describe('actionFor — 유형별 임계 경계', () => {
  test('NAME: tokenize 0.8, gray 0.6', () => {
    expect(actionFor(0.8, 'NAME', false)).toBe('tokenize')
    expect(actionFor(0.79, 'NAME', false)).toBe('gray')
    expect(actionFor(0.79, 'NAME', true)).toBe('tokenize')
    expect(actionFor(0.6, 'NAME', false)).toBe('gray')
    expect(actionFor(0.59, 'NAME', true)).toBe('pass')
  })

  test('ADDRESS: tokenize 0.75, gray 0.55 / RELATION: tokenize 0.85, gray 0.7', () => {
    expect(actionFor(0.75, 'ADDRESS', false)).toBe('tokenize')
    expect(actionFor(0.55, 'ADDRESS', false)).toBe('gray')
    expect(actionFor(0.54, 'ADDRESS', true)).toBe('pass')
    expect(actionFor(0.85, 'RELATION', false)).toBe('tokenize')
    expect(actionFor(0.7, 'RELATION', false)).toBe('gray')
    expect(actionFor(0.7, 'RELATION', true)).toBe('tokenize')
  })
})

describe('이름 판정 — 맥락 가점', () => {
  test('직함+선언 어미(대리입니다)는 tokenize', () => {
    expect(spansOf('김민준 대리입니다')).toEqual([{ type: 'NAME', text: '김민준', level: 2 }])
  })

  test('라벨(담당자·수령인·연락처) 뒤 이름은 tokenize', () => {
    expect(spansOf('담당자: 김민준')).toEqual([{ type: 'NAME', text: '김민준', level: 2 }])
    expect(spansOf('수령인 이영희')).toEqual([{ type: 'NAME', text: '이영희', level: 2 }])
    expect(spansOf('연락처 김민준')).toEqual([{ type: 'NAME', text: '김민준', level: 2 }])
  })

  test('라벨 뒤라도 정지 단어(확인)가 오면 후보를 만들지 않는다', () => {
    expect(judgeKorean('담당자 확인 부탁드립니다').scored).toEqual([])
  })

  test('요청 맥락(말고·쉼표+부탁·을 불러·이랑 같이·참석)이 이름을 끌어올린다', () => {
    for (const text of [
      '김민준 말고 다른 담당자로 바꿔 주세요',
      '김민준, 확인 부탁드립니다',
      '김민준을 불러 주세요',
      '김민준이랑 같이 점심 먹었어요',
      '김민준은 참석했습니다',
    ]) {
      const findings = spansOf(text)
      expect(findings.some((f) => f.type === 'NAME' && f.text.startsWith('김민준'))).toBe(true)
    }
  })

  test('존칭(씨가)도 맥락 가점이 된다', () => {
    expect(spansOf('김민준 씨가 왔습니다')).toEqual([{ type: 'NAME', text: '김민준', level: 2 }])
  })

  test('복합 성(남궁)도 이름으로 잡는다', () => {
    expect(spansOf('남궁민수 대표에게 보고했다')).toEqual([{ type: 'NAME', text: '남궁민수', level: 2 }])
  })

  test('이름 선언문(이름은 ~입니다)도 잡는다', () => {
    expect(spansOf('이름은 김민준입니다')).toEqual([{ type: 'NAME', text: '김민준', level: 2 }])
  })
})

describe('이름 판정 — 오탐 억제', () => {
  test('일반명사(김밥)는 점수가 0으로 눌려 탐지되지 않는다', () => {
    const j = judgeKorean('김밥 먹었습니다')
    expect(j.scored.some((s) => s.score === 0)).toBe(true)
    expect(detectKorean('김밥 먹었습니다')).toEqual([])
  })

  test('한글 덩어리 중간에 낀 이름 형태는 경계가 없어 후보가 아니다', () => {
    expect(judgeKorean('그는김민준이다').scored).toEqual([])
    expect(detectKorean('그는김민준이다')).toEqual([])
  })

  test('짧은 이름+직함은 회색 지대 — 민감 출처에서만 승격된다', () => {
    const text = '김준 과장 회의에서 발표했습니다'
    const j = judgeKorean(text)
    const name = j.scored.find((s) => s.type === 'NAME')
    expect(name).toBeDefined()
    expect(name!.score).toBeCloseTo(0.8, 1)
    expect(judgeKorean(text).actions[j.scored.indexOf(name!)]).toBe('gray')
    expect(judgeKorean(text, { sensitiveSource: true }).actions[j.scored.indexOf(name!)]).toBe('tokenize')
  })
})

describe('주소 판정', () => {
  test('도로명 주소는 시도·구까지 확장해 한 구간으로 잡는다', () => {
    expect(spansOf('배송지는 서울특별시 강남구 테헤란로 123 입니다')).toEqual([
      { type: 'ADDRESS', text: '서울특별시 강남구 테헤란로 123', level: 2 },
    ])
  })

  test('건물명·동·호 상세까지 구간에 포함한다', () => {
    const findings = spansOf('배송지 서울특별시 강남구 테헤란로 123 삼성타워 101호')
    expect(findings).toEqual([
      { type: 'ADDRESS', text: '서울특별시 강남구 테헤란로 123 삼성타워 101호', level: 2 },
    ])
  })

  test('지번 주소도 잡는다', () => {
    const findings = spansOf('경기도 성남시 분당구 정자동 12-3번지에 산다')
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe('ADDRESS')
    expect(findings[0].text).toContain('정자동 12-3')
  })

  test('주소 라벨 뒤 주소는 tokenize', () => {
    expect(spansOf('주소: 서울특별시 마포구 월드컵북로 396')).toEqual([
      { type: 'ADDRESS', text: '서울특별시 마포구 월드컵북로 396', level: 2 },
    ])
  })

  test('맥락 없는 구+도로명만으로는 회색 지대 — 민감 출처에서만 탐지', () => {
    const text = '강남구 테헤란로 123'
    const j = judgeKorean(text)
    const addr = j.scored.find((s) => s.type === 'ADDRESS')
    expect(addr!.score).toBeCloseTo(0.55, 2)
    expect(detectKorean(text)).toEqual([])
    expect(spansOf(text, { sensitiveSource: true })).toEqual([
      { type: 'ADDRESS', text: '강남구 테헤란로 123', level: 2 },
    ])
  })
})

describe('관계 판정', () => {
  test('성+직함(김 과장)은 RELATION으로 tokenize', () => {
    expect(spansOf('우리 팀 김 과장이 발표했다')).toEqual([
      { type: 'RELATION', text: '김 과장', level: 2 },
    ])
  })

  test('관계어가 있으면 relationSignal이 서고 이름도 함께 잡힌다', () => {
    const text = '김철수 과장의 아내에게도 공유했다'
    const j = judgeKorean(text)
    expect(j.relationSignal).toBe(true)
    expect(spansOf(text).some((f) => f.text === '김철수')).toBe(true)
    expect(judgeKorean('오늘 회의는 세 시입니다').relationSignal).toBe(false)
  })
})

describe('우회 저항 — 보이지 않는 형식 문자', () => {
  test('제로폭 문자로 쪼갠 이름도 원본 좌표 그대로 탐지한다', () => {
    const text = '김\u200B민준 대리입니다'
    const findings = detectKorean(text)
    expect(findings).toHaveLength(1)
    // 원본 문자열 기준 구간 — 제로폭 문자를 포함한 원래 이름이 정확히 잡힌다
    expect(text.slice(findings[0].start, findings[0].end)).toBe('김\u200B민준')
    expect(findings[0].end - findings[0].start).toBe(4) // 김 + ZWSP + 민준
    expect(findings[0].type).toBe('NAME')
  })

  test('형식 문자가 없으면 같은 문장도 동일하게 탐지한다', () => {
    expect(spansOf('김민준 대리입니다')).toEqual([{ type: 'NAME', text: '김민준', level: 2 }])
  })
})

describe('extractCandidates — 입력 경계', () => {
  test('문자열이 아닌 입력은 빈 결과', () => {
    expect(extractCandidates(undefined as any)).toEqual({ candidates: [], overflow: 0 })
    expect(extractCandidates(null as any)).toEqual({ candidates: [], overflow: 0 })
    expect(extractCandidates(42 as any)).toEqual({ candidates: [], overflow: 0 })
  })

  test('maxCandidates를 주면 자르고 overflow를 보고한다', () => {
    const text = '김철수 과장, 이영희 대리, 박민수 팀장, 최지현 부장'
    const full = extractCandidates(text, { maxCandidates: 512 })
    const capped = extractCandidates(text, { maxCandidates: 2 })
    expect(full.overflow).toBe(0)
    expect(capped.candidates).toHaveLength(2)
    expect(capped.overflow).toBe(full.candidates.length - 2)
  })
})
