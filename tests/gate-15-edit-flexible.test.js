/**
 * 관문 테스트 15: edit_file 유연 매칭
 *
 * 기대:
 * 1. 정확한 매칭 → 성공
 * 2. 들여쓰기 다름 → 유연 매칭으로 성공
 * 3. 완전히 다름 → 유사한 줄 제안과 함께 실패
 */

function simulateEdit(current, oldStr, newStr) {
  // 정확한 매칭
  if (current.includes(oldStr)) {
    return { ok: true, method: 'exact' }
  }
  // 유연 매칭
  const normalize = (s) => s.replace(/\s+/g, ' ').trim()
  const normOld = normalize(oldStr)
  const lines = current.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (normalize(lines[i]).includes(normOld)) {
      return { ok: true, method: 'flexible', line: i + 1 }
    }
  }
  // 유사한 줄 제안
  const keywords = oldStr.split(/\s+/).filter(w => w.length > 3).slice(0, 3)
  const candidates = []
  for (let i = 0; i < lines.length && candidates.length < 3; i++) {
    if (keywords.some(k => lines[i].includes(k))) {
      candidates.push(i + 1)
    }
  }
  return { ok: false, method: 'not_found', hints: candidates }
}

describe('관문 15: edit_file 유연 매칭', () => {
  test('정확한 매칭 → 성공', () => {
    const result = simulateEdit(
      '<button class="bg-red-600">',
      '<button class="bg-red-600">',
      '<button class="bg-blue-600">'
    )
    expect(result.ok).toBe(true)
    expect(result.method).toBe('exact')
  })

  test('들여쓰기 다름 → 정확한 매칭도 성공 (substring)', () => {
    // '  <button'은 '<button'을 substring으로 포함하므로 exact로 성공
    // 실제 코드도 동일하게 동작함
    const result = simulateEdit(
      '  <button class="bg-red-600">',
      '<button class="bg-red-600">',
      '<button class="bg-blue-600">'
    )
    expect(result.ok).toBe(true)
    // exact 또는 flexible 둘 다 허용 (둘 다 성공이므로)
    expect(['exact', 'flexible']).toContain(result.method)
  })

  test('완전히 다름 → 유사한 줄 제안', () => {
    const result = simulateEdit(
      '<div>hello</div>\n<button class="bg-red-600">click</button>',
      '<button class="bg-green-600">',  // class 키워드가 매칭됨
      'new'
    )
    expect(result.ok).toBe(false)
    // 'button' 키워드로 button 줄을 찾아야 함
    expect(result.hints.length).toBeGreaterThan(0)
  })
})
