/**
 * 관문 테스트 25: 프롬프트 길이 제한
 *
 * 품질 이슈: POST /jobs에서 prompt 길이 검증 없음.
 * 1MB짜리 프롬프트도 받아들여짐 (DB에는 5000자로 잘라서 저장).
 * 대역폭 낭비 및 악용 가능.
 *
 * 기대: 입력 시점에서 길이 제한 (예: 10000자).
 */

function validatePrompt(prompt) {
  const MAX_PROMPT = 10000
  if (!prompt) return { ok: false, error: 'prompt 필요' }
  if (prompt.length > MAX_PROMPT) {
    return { ok: false, error: `prompt가 너무 깁니다 (${MAX_PROMPT}자 제한)` }
  }
  return { ok: true }
}

describe('관문 25: 프롬프트 길이', () => {
  test('정상 길이 → 통과', () => {
    expect(validatePrompt('버튼 만들어줘').ok).toBe(true)
  })

  test('빈 프롬프트 → 실패', () => {
    expect(validatePrompt('').ok).toBe(false)
  })

  test('초과 길이 → 실패', () => {
    const long = 'a'.repeat(10001)
    const r = validatePrompt(long)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('너무 깁니다')
  })

  test('경계값 10000자 → 통과', () => {
    const exact = 'a'.repeat(10000)
    expect(validatePrompt(exact).ok).toBe(true)
  })
})
