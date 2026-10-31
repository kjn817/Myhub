/// <reference types="jest" />

// Mock the ai-access module before importing the module under test
jest.mock('../../src/services/ai-access', () => ({
  searchAccessibleMemos: jest.fn(),
  getAccessibleMemo: jest.fn(),
}))

import { z } from 'zod'
import {
  SearchMemoInputSchema,
  SearchMemoDefinition,
  executeSearchMemo,
} from '../../src/ai/tools/search-memo'
import { searchAccessibleMemos, getAccessibleMemo } from '../../src/services/ai-access'

const mockSearch = searchAccessibleMemos as jest.Mock
const mockGet = getAccessibleMemo as jest.Mock

function makeDb(firstValue: any): { DB: D1Database } {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => firstValue, all: async () => ({ results: [] }), run: async () => ({}) }),
        first: async () => firstValue,
      }),
    } as unknown as D1Database,
  }
}

beforeEach(() => {
  mockSearch.mockReset()
  mockGet.mockReset()
})

describe('SearchMemoInputSchema', () => {
  test('accepts valid query', () => {
    const parsed = SearchMemoInputSchema.safeParse({ query: 'hello' })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.query).toBe('hello')
      expect(parsed.data.limit).toBe(3) // default
    }
  })

  test('trims query', () => {
    const parsed = SearchMemoInputSchema.safeParse({ query: '  hello  ' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.query).toBe('hello')
  })

  test('rejects empty query', () => {
    expect(SearchMemoInputSchema.safeParse({ query: '' }).success).toBe(false)
  })

  test('rejects whitespace-only query', () => {
    expect(SearchMemoInputSchema.safeParse({ query: '   ' }).success).toBe(false)
  })

  test('rejects query over 120 chars', () => {
    expect(SearchMemoInputSchema.safeParse({ query: 'x'.repeat(121) }).success).toBe(false)
  })

  test('accepts exactly 120 chars', () => {
    expect(SearchMemoInputSchema.safeParse({ query: 'x'.repeat(120) }).success).toBe(true)
  })

  test('accepts limit 1-5', () => {
    expect(SearchMemoInputSchema.safeParse({ query: 'q', limit: 1 }).success).toBe(true)
    expect(SearchMemoInputSchema.safeParse({ query: 'q', limit: 5 }).success).toBe(true)
  })

  test('rejects limit 0 and 6', () => {
    expect(SearchMemoInputSchema.safeParse({ query: 'q', limit: 0 }).success).toBe(false)
    expect(SearchMemoInputSchema.safeParse({ query: 'q', limit: 6 }).success).toBe(false)
  })

  test('rejects strict extra fields', () => {
    expect(SearchMemoInputSchema.safeParse({ query: 'q', extra: 1 }).success).toBe(false)
  })

  test('rejects non-string query', () => {
    expect(SearchMemoInputSchema.safeParse({ query: 123 }).success).toBe(false)
  })
})

describe('SearchMemoDefinition', () => {
  test('has correct name, mode and description', () => {
    expect(SearchMemoDefinition.name).toBe('search_memo')
    expect(SearchMemoDefinition.mode).toBe('read')
    expect(typeof SearchMemoDefinition.description).toBe('string')
    expect(SearchMemoDefinition.description.length).toBeGreaterThan(0)
  })

  test('parameters require query', () => {
    const params = SearchMemoDefinition.parameters as any
    expect(params.required).toContain('query')
    expect(params.additionalProperties).toBe(false)
  })
})

describe('executeSearchMemo', () => {
  test('returns mapped matches from searchAccessibleMemos', async () => {
    mockSearch.mockResolvedValue([
      { id: 1, title: 'Title 1', snippet: 'snippet one' },
      { id: 2, title: null, snippet: 'snippet two' },
    ])
    const result = await executeSearchMemo(
      { query: 'hello', limit: 3 },
      { userId: 'u1' },
      makeDb(null)
    )
    expect(mockSearch).toHaveBeenCalledWith(expect.anything(), 'hello', 3)
    expect(result.matches).toEqual([
      { id: 1, title: 'Title 1', excerpt: 'snippet one' },
      { id: 2, title: '(제목 없음)', excerpt: 'snippet two' },
    ])
  })

  test('truncates long excerpts to 200 chars', async () => {
    mockSearch.mockResolvedValue([{ id: 1, title: 'T', snippet: 'x'.repeat(500) }])
    const result = await executeSearchMemo({ query: 'q', limit: 3 }, { userId: 'u1' }, makeDb(null))
    expect(result.matches[0].excerpt.length).toBe(200)
  })

  test('returns empty matches when no results', async () => {
    mockSearch.mockResolvedValue([])
    const result = await executeSearchMemo({ query: 'q', limit: 3 }, { userId: 'u1' }, makeDb(null))
    expect(result.matches).toEqual([])
  })

  test('handles missing snippet', async () => {
    mockSearch.mockResolvedValue([{ id: 5, title: 'T' }])
    const result = await executeSearchMemo({ query: 'q', limit: 3 }, { userId: 'u1' }, makeDb(null))
    expect(result.matches).toEqual([{ id: 5, title: 'T', excerpt: '' }])
  })

  // 상대 참조 ("방금", "그 메모", "이 메모") → 최근 메모 (getAccessibleMemo 경유)
  test('방금 refers to the most recent memo', async () => {
    mockGet.mockResolvedValue({ id: 42, title: '(제목 없음)', content: '최근 메모 내용입니다.' })
    const db = makeDb({ id: 42, text: '최근 메모 내용입니다.' })
    const result = await executeSearchMemo({ query: '방금 만든 메모', limit: 3 }, { userId: 'u1' }, db)
    expect(mockGet).toHaveBeenCalledWith(expect.anything(), 42)
    expect(result.matches).toEqual([
      { id: 42, title: '(제목 없음)', excerpt: '최근 메모 내용입니다.' },
    ])
    expect(mockSearch).not.toHaveBeenCalled()
  })

  test('그 메모 refers to the most recent memo', async () => {
    mockGet.mockResolvedValue({ id: 7, title: '그 메모 내용', content: '그 메모 내용' })
    const db = makeDb({ id: 7, text: '그 메모 내용' })
    const result = await executeSearchMemo({ query: '그 메모 요약해줘', limit: 3 }, { userId: 'u1' }, db)
    expect(result.matches[0].id).toBe(7)
  })

  test('이 메모 refers to the most recent memo', async () => {
    mockGet.mockResolvedValue({ id: 9, title: '이 메모 내용', content: '이 메모 내용' })
    const db = makeDb({ id: 9, text: '이 메모 내용' })
    const result = await executeSearchMemo({ query: '이 메모', limit: 3 }, { userId: 'u1' }, db)
    expect(result.matches[0].id).toBe(9)
  })

  test('truncates recent memo text to 200 chars', async () => {
    mockGet.mockResolvedValue({ id: 1, title: 'T', content: 'y'.repeat(300) })
    const db = makeDb({ id: 1, text: 'y'.repeat(300) })
    const result = await executeSearchMemo({ query: '방금', limit: 3 }, { userId: 'u1' }, db)
    expect(result.matches[0].excerpt.length).toBe(200)
  })

  test('falls back to search when recent memo query fails', async () => {
    const brokenDb = {
      DB: {
        prepare: () => { throw new Error('DB down') },
      },
    } as unknown as D1Database
    mockSearch.mockResolvedValue([{ id: 3, title: 'Fallback', snippet: 'fb' }])
    const result = await executeSearchMemo({ query: '방금', limit: 3 }, { userId: 'u1' }, { DB: brokenDb })
    expect(result.matches).toEqual([{ id: 3, title: 'Fallback', excerpt: 'fb' }])
  })

  test('falls back to search when no recent memo exists', async () => {
    mockSearch.mockResolvedValue([{ id: 4, title: 'S', snippet: 's' }])
    const result = await executeSearchMemo({ query: '방금 만든 것', limit: 3 }, { userId: 'u1' }, makeDb(null))
    expect(mockSearch).toHaveBeenCalled()
    expect(result.matches[0].id).toBe(4)
  })

  test('falls back to search when recent has no id', async () => {
    mockSearch.mockResolvedValue([{ id: 6, title: 'S2', snippet: 's2' }])
    const result = await executeSearchMemo({ query: '방금', limit: 3 }, { userId: 'u1' }, makeDb({ text: 'no id' }))
    expect(mockSearch).toHaveBeenCalled()
    expect(result.matches[0].id).toBe(6)
  })

  test('handles empty query via direct call (defensive || fallback)', async () => {
    // schema guarantees query, but the function defends against falsy input
    mockSearch.mockResolvedValue([])
    const result = await executeSearchMemo(
      { query: '', limit: 3 } as any,
      { userId: 'u1' },
      makeDb(null)
    )
    expect(mockSearch).toHaveBeenCalledWith(expect.anything(), '', 3)
    expect(result.matches).toEqual([])
  })

  test('handles recent memo with null text', async () => {
    mockGet.mockResolvedValue({ id: 5, title: '(제목 없음)', content: '' })
    const db = makeDb({ id: 5, text: null })
    const result = await executeSearchMemo({ query: '방금', limit: 3 }, { userId: 'u1' }, db)
    expect(result.matches).toEqual([{ id: 5, title: '(제목 없음)', excerpt: '' }])
  })

  // 상대 참조 보안 회귀 (P1-1, 2026-10-28):
  // 수정 전에는 최근 메모 원문을 직접 SELECT해 반환해 민감도·마스킹 경계를
  // 우회했다. 이제는 getAccessibleMemo 경유라 (a) 민감도 2 메모는 null로
  // 차단되고 (b) 본문은 정제된(sanitizeForAI) 내용만 나온다. 마스킹 실함수
  // 자체는 svc-secret-mask + svc2-ai-access(sanitizeForAI)에서 검증한다.
  test('민감도 2 최신 메모는 반환되지 않는다 (P1-1)', async () => {
    // DB에는 민감 메모가 최신으로 있지만, 실제 getAccessibleMemo는
    // sensitivity 2 → null을 반환한다 (SQL 필터 + 코드 가드 이중화).
    const db = makeDb({ id: 99, text: '민감 메모 원문 sk-live-SECRET99' })
    mockGet.mockResolvedValue(null)
    mockSearch.mockResolvedValue([])
    const result = await executeSearchMemo({ query: '방금 만든 메모', limit: 3 }, { userId: 'u1' }, db)
    expect(mockGet).toHaveBeenCalledWith(expect.anything(), 99)
    expect(result.matches).toEqual([])
    expect(JSON.stringify(result)).not.toContain('민감 메모 원문')
    expect(JSON.stringify(result)).not.toContain('sk-live-SECRET99')
  })

  test('민감도 2 최신 메모는 폴백 검색 결과에도 섞이지 않는다 (P1-1)', async () => {
    const db = makeDb({ id: 99, text: '민감 메모 원문' })
    mockGet.mockResolvedValue(null)
    mockSearch.mockResolvedValue([{ id: 2, title: 'S', snippet: 'safe' }])
    const result = await executeSearchMemo({ query: '방금 만든 메모', limit: 3 }, { userId: 'u1' }, db)
    expect(result.matches.map((m) => m.id)).not.toContain(99)
    expect(result.matches).toEqual([{ id: 2, title: 'S', excerpt: 'safe' }])
  })

  test('최신 메모 내 시크릿은 마스킹된 채로만 반환된다 (P1-1)', async () => {
    // DB 원문에는 평문 시크릿이 있지만, 반환되는 것은 getAccessibleMemo가
    // sanitizeForAI로 정제한 내용뿐이다 — executor는 recent.text를 읽지 않는다.
    const db = makeDb({ id: 1, text: 'API 키 sk-live-SECRET12345 입니다' })
    mockGet.mockResolvedValue({ id: 1, title: 'T', content: 'API 키 [MASKED] 입니다' })
    const result = await executeSearchMemo({ query: '그 메모', limit: 3 }, { userId: 'u1' }, db)
    expect(result.matches).toEqual([{ id: 1, title: 'T', excerpt: 'API 키 [MASKED] 입니다' }])
    expect(JSON.stringify(result)).not.toContain('sk-live-SECRET12345')
  })
})
