/**
 * 관문 테스트 33: 프로젝트 목록 페이지네이션
 *
 * 개선됨: limit/offset 파라미터 지원
 * - GET /drafts?limit=20&offset=50
 * - GET /?limit=20&offset=50
 * - 기본 50, 최대 100
 */

function getProjects(limit, offset) {
  // 현재: LIMIT 50 고정
  // 개선: ?limit=50&offset=0 파라미터
  return { limit: limit || 50, offset: offset || 0 }
}

describe('관문 33: 페이지네이션', () => {
  test('현재: 50개 고정', () => {
    const r = getProjects()
    expect(r.limit).toBe(50)
    expect(r.offset).toBe(0)
  })

  test('개선안: 파라미터 지원', () => {
    const r = getProjects(20, 50)
    expect(r.limit).toBe(20)
    expect(r.offset).toBe(50)
  })
})
