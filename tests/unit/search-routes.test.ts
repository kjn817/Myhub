/**
 * src/modules/search/routes.ts 100% 커버리지 단위 테스트
 * - normalizeSearchLimit 순수 함수 직접 테스트
 * - unifiedSearch 서비스 mock (hoisted)
 * - Hono app.request()로 HTTP 시뮬레이션
 *
 * 데드 코드 검토: routes.ts 전체 45줄 — 모든 줄이 아래 테스트로 도달 가능하며,
 * grep으로 확인한 결과 normalizeSearchLimit은 routes.ts 내부 GET 핸들러에서
 * 사용 중이고 searchApp은 src/modules.ts 레지스트리에서 마운트됨.
 * 도달 불가한 코드 없음.
 */
/// <reference types="jest" />
import { Hono } from 'hono'

// ---------------- 모듈 mock (hoisted) ----------------
jest.mock('../../src/services/unified-search', () => ({
  unifiedSearch: jest.fn(),
}))

import { searchApp, normalizeSearchLimit } from '../../src/modules/search/routes'
import { unifiedSearch } from '../../src/services/unified-search'

const mockUnifiedSearch = unifiedSearch as jest.Mock

// DB는 mock된 unifiedSearch가 실제로 사용하지 않으므로 최소 스텁
function makeApp() {
  const db: any = {}
  const app = new Hono()
  app.route('/s', searchApp)
  const env: any = { DB: db }
  const req = (path: string, init?: RequestInit) => {
    const q = path.indexOf('?')
    const p = q >= 0 ? path.slice(0, q) : path
    const qs = q >= 0 ? path.slice(q) : ''
    return app.request('/s' + (p === '/' ? '' : p) + qs, init, env)
  }
  return { app, db, env, req }
}

async function body(res: Response) {
  return res.json() as Promise<any>
}

const sampleResults = [
  { source_type: 'memo', source_id: 1, title: 'a', snippet: 'a', created_at: 'c', rank: 1 },
  { source_type: 'todo', source_id: 2, title: 'b', snippet: 'b', created_at: 'c', rank: 2 },
]

beforeEach(() => {
  jest.clearAllMocks()
  mockUnifiedSearch.mockResolvedValue(sampleResults)
})

// ---------------- normalizeSearchLimit (순수 함수) ----------------
describe('normalizeSearchLimit', () => {
  test('undefined → 20', () => expect(normalizeSearchLimit(undefined)).toBe(20))
  test('null → 20', () => expect(normalizeSearchLimit(null)).toBe(20))
  test('빈 문자열 → 20', () => expect(normalizeSearchLimit('')).toBe(20))
  test('공백만 → 20', () => expect(normalizeSearchLimit('   ')).toBe(20))
  test('숫자 아닌 문자열 → 20', () => expect(normalizeSearchLimit('abc')).toBe(20))
  test('소수 → 20', () => expect(normalizeSearchLimit('1.5')).toBe(20))
  test('0 → 20', () => expect(normalizeSearchLimit('0')).toBe(20))
  test('음수 → 20', () => expect(normalizeSearchLimit('-3')).toBe(20))
  test('유효값 통과', () => {
    expect(normalizeSearchLimit('50')).toBe(50)
    expect(normalizeSearchLimit(30)).toBe(30)
    expect(normalizeSearchLimit('1')).toBe(1)
    expect(normalizeSearchLimit('100')).toBe(100)
    expect(normalizeSearchLimit('  42  ')).toBe(42)
  })
  test('100 초과 → 100', () => {
    expect(normalizeSearchLimit('150')).toBe(100)
    expect(normalizeSearchLimit(1000)).toBe(100)
  })
})

// ---------------- GET / ----------------
describe('GET / (통합 검색)', () => {
  test('쿼리 없음 → 400 query required', async () => {
    const { req } = makeApp()
    const res = await req('/')
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('query required')
    expect(mockUnifiedSearch).not.toHaveBeenCalled()
  })

  test('공백 쿼리 → 400 query required', async () => {
    const { req } = makeApp()
    const res = await req('/?q=%20%20%20')
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('query required')
  })

  test('201자 쿼리 → 400 query too long', async () => {
    const { req } = makeApp()
    const res = await req('/?q=' + '가'.repeat(201))
    expect(res.status).toBe(400)
    expect((await body(res)).error).toBe('query too long')
  })

  test('정확히 200자 쿼리 → 통과', async () => {
    const { req } = makeApp()
    const res = await req('/?q=' + '가'.repeat(200))
    expect(res.status).toBe(200)
  })

  test('성공 → 200 + results + count', async () => {
    const { req } = makeApp()
    const res = await req('/?q=hello')
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(j.results).toEqual(sampleResults)
    expect(j.count).toBe(2)
  })

  test('빈 결과 → count 0', async () => {
    const { req } = makeApp()
    mockUnifiedSearch.mockResolvedValue([])
    const res = await req('/?q=nothing')
    const j = await body(res)
    expect(j.results).toEqual([])
    expect(j.count).toBe(0)
  })

  test('unifiedSearch에 query/limit/types 전달', async () => {
    const { req, db } = makeApp()
    await req('/?q=%20hello%20&limit=50&types=memo,chat')
    expect(mockUnifiedSearch).toHaveBeenCalledTimes(1)
    expect(mockUnifiedSearch).toHaveBeenCalledWith(db, {
      query: 'hello', // 양쪽 trim 적용
      limit: 50,
      types: ['memo', 'chat'],
    })
  })

  test('limit 미지정 → 기본값 20', async () => {
    const { req } = makeApp()
    await req('/?q=x')
    expect(mockUnifiedSearch.mock.calls[0][1].limit).toBe(20)
  })

  test('limit=abc → 기본값 20', async () => {
    const { req } = makeApp()
    await req('/?q=x&limit=abc')
    expect(mockUnifiedSearch.mock.calls[0][1].limit).toBe(20)
  })

  test('limit=250 → 상한 100', async () => {
    const { req } = makeApp()
    await req('/?q=x&limit=250')
    expect(mockUnifiedSearch.mock.calls[0][1].limit).toBe(100)
  })

  test('types 미지정 → undefined', async () => {
    const { req } = makeApp()
    await req('/?q=x')
    expect(mockUnifiedSearch.mock.calls[0][1].types).toBeUndefined()
  })

  test('types 공백 → undefined', async () => {
    const { req } = makeApp()
    await req('/?q=x&types=%20%20')
    expect(mockUnifiedSearch.mock.calls[0][1].types).toBeUndefined()
  })

  test('types 유효값만 유지, 무효값 필터링', async () => {
    const { req } = makeApp()
    await req('/?q=x&types=memo,bogus,todo,xxx')
    expect(mockUnifiedSearch.mock.calls[0][1].types).toEqual(['memo', 'todo'])
  })

  test('types 전부 무효 → 빈 배열', async () => {
    const { req } = makeApp()
    await req('/?q=x&types=bogus')
    expect(mockUnifiedSearch.mock.calls[0][1].types).toEqual([])
  })

  test('types 단일 유효값', async () => {
    const { req } = makeApp()
    await req('/?q=x&types=schedule')
    expect(mockUnifiedSearch.mock.calls[0][1].types).toEqual(['schedule'])
  })

  test('unifiedSearch throw → 500 search failed', async () => {
    const { req } = makeApp()
    mockUnifiedSearch.mockRejectedValue(new Error('db down'))
    const res = await req('/?q=x')
    expect(res.status).toBe(500)
    const j = await body(res)
    expect(j.ok).toBe(false)
    expect(j.error).toBe('search failed')
  })
})
