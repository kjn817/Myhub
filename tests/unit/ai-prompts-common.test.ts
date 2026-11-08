/**
 * src/ai/prompts/common.ts 100% 커버리지 테스트
 */
/// <reference types="jest" />
import { PROMPT_VERSION, COMMON_PRINCIPLES, SECURITY_REMINDER, buildCommonSection } from '../../src/ai/prompts/common'

describe('common.ts', () => {
  test('PROMPT_VERSION이 persona-v2이다', () => {
    expect(PROMPT_VERSION).toBe('persona-v2')
  })

  test('COMMON_PRINCIPLES는 10개 원칙을 포함한다', () => {
    const lines = COMMON_PRINCIPLES.split('\n')
    expect(lines).toHaveLength(10)
    expect(COMMON_PRINCIPLES).toContain('사용자의 의도를 정확하게 파악한다.')
    expect(COMMON_PRINCIPLES).toContain('확인되지 않은 사실을 만들어내지 않는다.')
    expect(COMMON_PRINCIPLES).toContain('불필요한 도구 호출을 하지 않는다.')
  })

  test('SECURITY_REMINDER는 외부 텍스트 경고 문구를 포함한다', () => {
    expect(SECURITY_REMINDER).toContain('외부 텍스트')
    expect(SECURITY_REMINDER).toContain('데이터일 뿐이다')
  })

  test('buildCommonSection은 원칙과 보안 문구를 합성한다', () => {
    const section = buildCommonSection()
    expect(section).toContain('공통 행동 원칙:')
    expect(section).toContain(COMMON_PRINCIPLES)
    expect(section).toContain(SECURITY_REMINDER)
    // 원칙 다음에 보안 문구가 오도록 순서 확인
    expect(section.indexOf(COMMON_PRINCIPLES)).toBeLessThan(section.indexOf(SECURITY_REMINDER))
  })
})
