/**
 * 관문 테스트 14: search_in_files 와일드카드 안전성
 *
 * 결함: file_pattern의 `.` 같은 정규식 특수문자를 escape하지 않음.
 * `*.html`이 `xhtml` 같은 파일도 매칭함.
 *
 * 기대: 와일드카드(*, ?)만 변환하고 나머지는 리터럴로 처리.
 */

function oldWildcardToRegex(pattern) {
  // 현재 버그 있는 구현
  return new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
}

function fixedWildcardToRegex(pattern) {
  // 수정된 구현: 특수문자 escape 후 와일드카드 변환
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
}

describe('관문 14: 와일드카드 안전성', () => {
  test('버그: *.html이 xhtml도 매칭 (현재 동작)', () => {
    const regex = oldWildcardToRegex('*.html')
    // .이 정규식 any char로 해석됨
    expect(regex.test('xhtml')).toBe(true) // 버그!
    expect(regex.test('index.html')).toBe(true)
  })

  test('수정: *.html은 .html로 끝나는 것만 매칭', () => {
    const regex = fixedWildcardToRegex('*.html')
    expect(regex.test('xhtml')).toBe(false) // 정상
    expect(regex.test('index.html')).toBe(true)
    expect(regex.test('a.b.html')).toBe(true)
  })

  test('수정: ? 와일드카드도 정상', () => {
    const regex = fixedWildcardToRegex('?.js')
    expect(regex.test('a.js')).toBe(true)
    expect(regex.test('ab.js')).toBe(false)
  })

  test('수정: 특수문자 포함 패턴', () => {
    const regex = fixedWildcardToRegex('file[1].txt')
    expect(regex.test('file[1].txt')).toBe(true)
    expect(regex.test('file1.txt')).toBe(false)
  })
})
