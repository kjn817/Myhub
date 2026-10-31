/**
 * 관문 테스트 16: validate_files 검증 범위
 *
 * 현재: HTML(DOCTYPE, html/body 태그), JS(문법)만 검증. CSS는 미검증.
 * 개선: CSS 중괄호 균형 검증 추가.
 */

function validateCss(content) {
  const open = (content.match(/{/g) || []).length
  const close = (content.match(/}/g) || []).length
  if (open !== close) return `중괄호 불일치: { ${open}개 vs } ${close}개`
  return null
}

describe('관문 16: validate_files', () => {
  test('CSS 중괄호 불일치 감지', () => {
    const bad = 'body { color: red; '
    expect(validateCss(bad)).toContain('불일치')
  })

  test('CSS 정상 → 통과', () => {
    const good = 'body { color: red; }'
    expect(validateCss(good)).toBeNull()
  })

  test('빈 CSS → 통과', () => {
    expect(validateCss('')).toBeNull()
  })
})
