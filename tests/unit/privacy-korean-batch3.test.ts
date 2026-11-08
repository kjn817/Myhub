/// <reference types="jest" />
/**
 * src/services/privacy-korean.ts 성질 테스트 (3차 배치 — 잔여 채점 맥락).
 * 기존 privacy-korean-cov/detect와 겹치지 않는 맥락들: 존칭+전달 동사,
 * 선언·요청 L3 단서, 관계(성+직함)의 동작 단서와 복성, 지번 주소의 시도
 * 확장, 제로폭으로 쪼개진 관계어 신호. 모든 기대값은 현행 판정 실측이다.
 * 카나리아: scoreName의 에게+동사 가점(+0.45)이나 scoreRelation의
 * 동작 가점(+0.2)을 지우면 아래 점수 단언이 실패한다.
 */
import { judgeKorean, detectKorean } from '../../src/services/privacy-korean'

const scoredOf = (text: string) =>
  judgeKorean(text).scored.map((s) => ({ type: s.type, span: text.slice(s.start, s.end), score: s.score, cue: s.cue }))

describe('이름 채점 — 존칭·요청 단서', () => {
  test('존칭 님+에게+전달 동사는 만점(1.0)으로 tokenize된다', () => {
    const j = judgeKorean('김민준 님에게 전달해 주세요')
    const name = j.scored.find((s) => s.type === 'NAME' && s.score === 1)
    expect(name).toBeDefined()
    expect(j.actions[j.scored.indexOf(name!)]).toBe('tokenize')
  })

  test('씨+에게+묻다도 만점이다', () => {
    const j = judgeKorean('김민준 씨에게 물어봐 주세요')
    expect(j.scored.some((s) => s.type === 'NAME' && s.score === 1)).toBe(true)
    expect(detectKorean('김민준 씨에게 물어봐 주세요').some((f) => f.type === 'NAME')).toBe(true)
  })

  test('주격 조사+발표 동사(L3)는 0.85로 tokenize된다', () => {
    const scored = scoredOf('김민준이 발표했습니다')
    expect(scored).toHaveLength(1)
    expect(scored[0]).toMatchObject({ type: 'NAME', span: '김민준', cue: 'surname+given' })
    expect(scored[0].score).toBeCloseTo(0.85, 5)
    expect(judgeKorean('김민준이 발표했습니다').actions[0]).toBe('tokenize')
  })

  test('에게+보내다, 한테+전화하다, 을+초대하다는 모두 tokenize 구간을 만든다', () => {
    for (const text of ['김민준에게 보내 주세요', '김민준한테 전화해 주세요', '김민준을 초대해 주세요']) {
      const findings = detectKorean(text)
      expect(findings.some((f) => f.type === 'NAME' && text.slice(f.start, f.end) === '김민준')).toBe(true)
    }
  })

  test('이랑+과거 동사(같이 없이)도 동행 단서로 tokenize된다', () => {
    const j = judgeKorean('이영희랑 통화했어요')
    expect(j.scored).toHaveLength(1)
    expect(j.scored[0].score).toBeCloseTo(0.85, 5)
    expect(j.actions[0]).toBe('tokenize')
  })

  test('출석 단서(는+출석)는 0.9로 tokenize된다', () => {
    expect(scoredOf('김민준는 출석했습니다')[0].score).toBeCloseTo(0.9, 5)
    expect(detectKorean('김민준는 출석했습니다')).toHaveLength(1)
  })

  test('직함+승인 동사가 붙은 이름은 0.95다', () => {
    expect(scoredOf('박민수 팀장이 승인했습니다')[0].score).toBeCloseTo(0.95, 5)
  })
})

describe('이름 채점 — 동형어 감점의 맥락 의존성', () => {
  test('동형어(바다)는 맥락이 없으면 0.15로 pass, 이름 선언 안에서는 tokenize', () => {
    const bare = judgeKorean('김바다 갔어요')
    expect(bare.scored[0].score).toBeCloseTo(0.15, 5)
    expect(bare.actions[0]).toBe('pass')
    expect(detectKorean('김바다 갔어요')).toEqual([])
    // 라벨 직후(이름은 ~입니다)에서는 감점이 상쇄돼 탐지된다
    expect(detectKorean('이름은 김바다입니다').map((f) => '김바다')).toEqual(['김바다'])
  })
})

describe('관계 채점 — 성+직함의 동작·소속 단서', () => {
  test('결재 요청 동작이 뒤에 오면 RELATION 0.9로 tokenize', () => {
    const scored = scoredOf('김 과장이 결재를 요청했다')
    expect(scored).toHaveLength(1)
    expect(scored[0]).toMatchObject({ type: 'RELATION', span: '김 과장', cue: 'surname+title' })
    expect(scored[0].score).toBeCloseTo(0.9, 5)
    expect(detectKorean('김 과장이 결재를 요청했다')).toHaveLength(1)
  })

  test('복성+직함(남궁 과장)은 회색 지대 — 민감 출처에서만 tokenize로 승격', () => {
    const j = judgeKorean('남궁 과장이 왔다')
    expect(j.scored).toHaveLength(1)
    expect(j.scored[0].type).toBe('RELATION')
    expect(j.scored[0].score).toBeCloseTo(0.7, 5)
    expect(j.actions[0]).toBe('gray')
    const sensitive = judgeKorean('남궁 과장이 왔다', { sensitiveSource: true })
    expect(sensitive.actions[0]).toBe('tokenize')
    expect(detectKorean('남궁 과장이 왔다')).toEqual([])
    expect(detectKorean('남궁 과장이 왔다', { sensitiveSource: true })).toHaveLength(1)
  })
})

describe('주소 채점 — 지번의 시도 확장', () => {
  test('지번 주소는 시도·구까지 한 구간으로 잡아 0.85로 tokenize', () => {
    const scored = scoredOf('서울특별시 강남구 개포동 12번지에 산다')
    expect(scored).toHaveLength(1)
    expect(scored[0]).toMatchObject({ type: 'ADDRESS', span: '서울특별시 강남구 개포동 12번지', cue: 'jibun' })
    expect(scored[0].score).toBeCloseTo(0.85, 5)
  })

  test('번길 주소는 도로명 구간이 나뉘어 잡히고 점수는 pass 지대에 머문다', () => {
    const j = judgeKorean('테헤란로 123번길 45')
    expect(j.scored.every((s) => s.type === 'ADDRESS')).toBe(true)
    expect(j.actions.every((a) => a === 'pass')).toBe(true)
    expect(detectKorean('테헤란로 123번길 45')).toEqual([])
  })
})

describe('관계 신호 — 보이지 않는 문자로 쪼개진 관계어', () => {
  test('제로폭으로 쪼갠 관계어도 clean 뷰 기준으로 relationSignal이 선다', () => {
    expect(judgeKorean('아\u200B내에게 물어봐').relationSignal).toBe(true)
    expect(judgeKorean('동료에게 물어봐').relationSignal).toBe(true)
    expect(judgeKorean('회의실로 가봐').relationSignal).toBe(false)
  })
})
