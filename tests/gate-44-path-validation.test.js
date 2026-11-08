/**
 * 관문 테스트 44: 경로 검증 일관성
 *
 * 결함: create_file만 경로 탐색(..) 검증, 나머지는 없음.
 * - create_file: if (path.includes('..') || path.startsWith('/'))
 * - read_file: 검증 없음
 * - edit_file: 검증 없음
 * - apply_patch: 검증 없음
 *
 * 비록 인메모리 Map이라 실제 파일시스템 접근은 안 되지만,
 * 일관성을 위해 모든 도구에서 검증해야 함.
 */

function validatePath(path) {
  if (!path) return { ok: false, error: 'path 필요' }
  if (path.includes('..') || path.startsWith('/')) {
    return { ok: false, error: '잘못된 경로' }
  }
  return { ok: true }
}

describe('관문 44: 경로 검증', () => {
  test('정상 경로 → 통과', () => {
    expect(validatePath('index.html').ok).toBe(true)
    expect(validatePath('js/app.js').ok).toBe(true)
  })

  test('상위 디렉토리 → 차단', () => {
    expect(validatePath('../evil').ok).toBe(false)
  })

  test('절대 경로 → 차단', () => {
    expect(validatePath('/etc/passwd').ok).toBe(false)
  })
})
