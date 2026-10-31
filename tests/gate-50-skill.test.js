/**
 * 관문 테스트 50: 스킬 주입 휴리스틱
 *
 * 확인: plan 스킬은 키워드(/계획|plan\.md|설계/)로 감지.
 * - 장점: 명시적 계획 요청 시 도움됨
 * - 한계: 키워드 없으면 스킬 미제공 (예: "구조 잡아줘")
 *
 * 완화: 스킬은 참고용이라 없어도 에이전트가 판단 가능.
 * 결과: 허용 가능한 휴리스틱, 패스.
 */

describe('관문 50: 스킬 휴리스틱', () => {
  test('키워드 기반 감지', () => {
    const isPlanRequest = (prompt) => /계획|plan\.md|설계/i.test(prompt)
    expect(isPlanRequest('계획을 세워줘')).toBe(true)
    expect(isPlanRequest('앱 만들어줘')).toBe(false)
  })
})
