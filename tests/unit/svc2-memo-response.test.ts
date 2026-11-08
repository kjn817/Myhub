/// <reference types="jest" />
/**
 * memo-response.ts 커버리지 테스트
 * - processSearchMarker: 검색 마커를 실제 결과로 교체
 * - 실패 시 / 성공+결과 / 성공+0건 / 상태문장 대체
 */
import { processSearchMarker } from '../../src/services/memo-response'

const marker = { full: '[SEARCH:회의]', query: '회의' }
const sanitize = (s: string) => s

describe('processSearchMarker', () => {
  test('검색 실패 → 오류 문구로 교체', () => {
    const text = '잠깐만 [SEARCH:회의] 찾아볼게'
    const out = processSearchMarker(text, marker, { success: false }, sanitize)
    expect(out).toBe('잠깐만 메모 검색 중 오류가 발생했습니다. 찾아볼게')
  })

  test('결과 있음 → 목록으로 교체', () => {
    const text = '결과야 [SEARCH:회의] 끝'
    const out = processSearchMarker(
      text,
      marker,
      { success: true, data: [{ id: 1, title: '회의록', snippet: '내용' }] },
      sanitize
    )
    expect(out).toContain('메모 검색 결과입니다:')
    expect(out).toContain('- 회의록')
    expect(out).toContain('내용')
  })

  test('결과 여러 개 → 모두 나열', () => {
    const text = '[SEARCH:회의]'
    const out = processSearchMarker(
      text,
      marker,
      {
        success: true,
        data: [
          { id: 1, title: 'A', snippet: 'a' },
          { id: 2, title: 'B', snippet: 'b' },
        ],
      },
      sanitize
    )
    expect(out).toContain('- A')
    expect(out).toContain('- B')
  })

  test('sanitizeFn 적용됨', () => {
    const text = '[SEARCH:회의]'
    const out = processSearchMarker(
      text,
      marker,
      { success: true, data: [{ id: 1, title: 't', snippet: 's' }] },
      (s) => s.toUpperCase()
    )
    expect(out).toContain('메모 검색 결과입니다:')
    // sanitize는 items에만 적용되어 대문자로 변환됨
    expect(out).toContain('- T')
    expect(out).toContain('  S')
  })

  test('성공 + 결과 0개 → "결과 없어" 문구', () => {
    const text = '봤는데 [SEARCH:회의] 없네'
    const out = processSearchMarker(text, marker, { success: true, data: [] }, sanitize)
    expect(out).toBe('봤는데 메모 검색 결과가 없습니다. 없네')
  })

  test('성공 + data 없음 → "결과 없어" 문구', () => {
    const text = '[SEARCH:회의]'
    const out = processSearchMarker(text, marker, { success: true }, sanitize)
    expect(out).toBe('메모 검색 결과가 없습니다.')
  })

  test('마커 앞 상태문장 "검색 결과가 없" → 결과로 대체', () => {
    const text = '검색 결과가 없어. [SEARCH:회의] 미안해'
    const out = processSearchMarker(
      text,
      marker,
      { success: true, data: [{ id: 5, title: '찾음', snippet: '있음' }] },
      sanitize
    )
    expect(out).not.toContain('검색 결과가 없어.')
    expect(out).toContain('메모 검색 결과입니다:')
    expect(out).toContain('찾음')
  })

  test('마커 앞 상태문장 "찾은 메모가 없" → 결과로 대체', () => {
    const text = '찾은 메모가 없습니다. [SEARCH:회의]'
    const out = processSearchMarker(
      text,
      marker,
      { success: true, data: [{ id: 5, title: 'T', snippet: 'S' }] },
      sanitize
    )
    expect(out).toContain('메모 검색 결과입니다:')
  })

  test('마커 앞 상태문장 "메모가 없" → 결과로 대체', () => {
    const text = '관련 메모가 없어요. [SEARCH:회의]'
    const out = processSearchMarker(
      text,
      marker,
      { success: true, data: [{ id: 5, title: 'T', snippet: 'S' }] },
      sanitize
    )
    expect(out).toContain('메모 검색 결과입니다:')
  })

  test('마커 앞에 상태문장 없으면 단순 교체', () => {
    const text = '이거 봐 [SEARCH:회의] 좋아'
    const out = processSearchMarker(
      text,
      marker,
      { success: true, data: [{ id: 5, title: 'T', snippet: 'S' }] },
      sanitize
    )
    expect(out).toContain('이거 봐 메모 검색 결과입니다:')
  })

  test('마커가 텍스트에 없으면 그대로 (실패)', () => {
    const text = '마커 없음'
    const out = processSearchMarker(text, marker, { success: false }, sanitize)
    expect(out).toBe('마커 없음')
  })

  test('마커가 텍스트에 없으면 그대로 (성공)', () => {
    const text = '마커 없음'
    const out = processSearchMarker(
      text,
      marker,
      { success: true, data: [{ id: 1, title: 'T', snippet: 'S' }] },
      sanitize
    )
    expect(out).toBe('마커 없음')
  })
})
