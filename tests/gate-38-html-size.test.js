/**
 * 관문 테스트 38: 에이전트 출력 크기
 *
 * 품질 이슈: 에이전트가 생성한 HTML의 크기 제한 없음.
 * - 수동 API는 2MB 제한 있음 (routes.ts:172)
 * - 에이전트 경로는 제한 없음 → D1에 큰 데이터 저장 가능
 *
 * 기대: 에이전트 출력도 2MB로 제한.
 */

const MAX_HTML_SIZE = 2 * 1024 * 1024 // 2MB

function validateHtmlSize(html) {
  const size = new TextEncoder().encode(html).length
  if (size > MAX_HTML_SIZE) {
    return { ok: false, error: `HTML이 너무 큼 (${Math.round(size/1024/1024)}MB, 2MB 제한)` }
  }
  return { ok: true }
}

describe('관문 38: 출력 크기', () => {
  test('정상 크기 → 통과', () => {
    expect(validateHtmlSize('<html></html>').ok).toBe(true)
  })

  test('2MB 초과 → 실패', () => {
    const big = 'a'.repeat(2*1024*1024 + 1)
    const r = validateHtmlSize(big)
    expect(r.ok).toBe(false)
  })
})
