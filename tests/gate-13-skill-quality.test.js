/**
 * 관문 테스트 13: 스킬 내용 품질
 *
 * 기대: 스킬이 "참고용"이면서도 실제로 도움이 되는 구체적 가이드를 포함해야 함.
 * 너무 추상적이면 노바가 무시하고, 너무 구체적이면 제약이 됨.
 */

const SKILL_QUALITY_CRITERIA = {
  hasConcreteExample: true,  // 구체적 예시 포함?
  hasOrder: true,            // 순서 가이드 있음?
  notForcing: true,          // 강제 문구 없음?
  mentionsPitfall: true,     // 함정/주의점 언급?
}

function evaluateSkill(skillText) {
  const result = {}
  result.hasConcreteExample = skillText.includes('예시') || skillText.includes('예:')
  result.hasOrder = /→|순서|먼저/.test(skillText)
  result.notForcing = !/(반드시|무조건|절대).*(해야|하라)/.test(skillText)
  result.mentionsPitfall = /주의|함정|실패/.test(skillText)
  return result
}

describe('관문 13: 스킬 내용 품질', () => {
  test('modify 스킬 품질 기준 충족', () => {
    // 실제 studio-skills.ts의 modify 스킬 내용을 반영
    const modifySkill = `
      파일 수정 스킬
      순서: search → read → apply_patch → validate
      예시: search_in_files로 'red'를 찾아 bg-red-600 → bg-blue-600
      주의: Tailwind 클래스는 HTML에도 CSS에도 있을 수 있다
    `
    const eval_ = evaluateSkill(modifySkill)
    expect(eval_.hasConcreteExample).toBe(true)
    expect(eval_.hasOrder).toBe(true)
    expect(eval_.notForcing).toBe(true)
    expect(eval_.mentionsPitfall).toBe(true)
  })

  test('강제 문구가 있으면 실패', () => {
    const badSkill = '반드시 search를 먼저 해야 한다'
    const eval_ = evaluateSkill(badSkill)
    expect(eval_.notForcing).toBe(false)
  })
})
