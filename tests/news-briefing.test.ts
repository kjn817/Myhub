/**
 * 뉴스 요약 브리핑 생성 테스트 — Exa 검색 + 요약 + 출처 검증
 * 실제 Exa·모델 호출 없음 (searchNews는 MSW 핸들러로 가로챈 Exa 응답 사용,
 * generateNewsSummary는 fetch 라우팅 목 + 요약기 주입).
 */
import {
  searchNews,
  generateNewsSummary,
  NewsSearchError,
} from '../src/services/news-briefing'
import { createMswServer, http, HttpResponse } from './helpers/msw-server'

const NOW_ISO = new Date().toISOString()
const OLD_ISO = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString() // 60일 전

const exaFixture = {
  results: [
    {
      title: '오늘의 주요 뉴스 1',
      url: 'https://example.com/news1',
      highlights: ['핵심 내용 1'],
      publishedDate: NOW_ISO,
    },
    {
      title: '60일 전 오래된 뉴스',
      url: 'https://example.com/old',
      highlights: ['오래된 내용'],
      publishedDate: OLD_ISO,
    },
    {
      title: '오늘의 주요 뉴스 2',
      url: 'https://example.com/news2',
      highlights: ['핵심 내용 2'],
      publishedDate: NOW_ISO,
    },
  ],
}

afterEach(() => {
  jest.restoreAllMocks()
})

/**
 * searchNews용 MSW 서버 (2026-10-27 MSW 적용).
 * 핸들러가 요청 형태를 검사한다: POST + x-api-key 헤더 + 본문
 * (category news·질의·numResults 5·highlights). 호출 자체가 틀리면
 * 핸들러 단언이 실패해 searchNews가 NewsSearchError를 던진다.
 */
const server = createMswServer(
  http.post('https://api.exa.ai/search', async ({ request }) => {
    expect(request.headers.get('x-api-key')).toBe('test-key')
    expect(request.headers.get('Content-Type')).toContain('application/json')
    const body = (await request.json()) as any
    expect(body.category).toBe('news')
    expect(body.query).toBe('오늘 주요 뉴스')
    expect(body.numResults).toBe(5)
    expect(body.contents).toEqual({ highlights: true })
    return HttpResponse.json(exaFixture)
  }),
)

describe('searchNews', () => {
  test('키가 없으면 빈 배열 (호출자가 사유 문장으로 구분)', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
    expect(await searchNews({})).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('Exa 결과를 신선도 필터 후 반환 (30일 초과 제외)', async () => {
    const items = await searchNews({ EXA_API_KEY: 'test-key' })
    expect(items.map((i) => i.url)).toEqual([
      'https://example.com/news1',
      'https://example.com/news2',
    ])
  })

  test('Exa 비정상 응답 시 NewsSearchError', async () => {
    server.use(
      http.post('https://api.exa.ai/search', () =>
        HttpResponse.json({ error: 'exa down' }, { status: 500 }),
      ),
    )
    await expect(searchNews({ EXA_API_KEY: 'test-key' })).rejects.toBeInstanceOf(NewsSearchError)
  })

  test('fetch 자체 실패 시 NewsSearchError', async () => {
    server.use(http.post('https://api.exa.ai/search', () => HttpResponse.error()))
    await expect(searchNews({ EXA_API_KEY: 'test-key' })).rejects.toBeInstanceOf(NewsSearchError)
  })
})

describe('generateNewsSummary', () => {
  /**
   * 체인용 라우팅 목 fetch (2026-10-26 트랙 A2 — Exa 단계 기사 날짜 직접 검증):
   * Exa JSON / RSS 빈 피드 / 기사 페이지는 신선한 메타 날짜의 HTML을 반환한다.
   * 단일 응답 목은 기사 fetch에서 text()가 없어 검증이 전부 실패하므로 쓰지 않는다.
   */
  function chainFetch(exaBody: any) {
    return jest.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('api.exa.ai')) return { ok: true, json: async () => exaBody } as Response
      if (u.includes('news.google.com')) {
        return { ok: true, text: async () => '<rss version="2.0"><channel></channel></rss>' } as Response
      }
      return {
        ok: true,
        text: async () =>
          `<html><head><meta property="article:published_time" content="${NOW_ISO}"></head></html>`,
      } as Response
    })
  }

  test('키 미설정 + RSS도 비면 예외 (체인 결과가 없으면 일시적 실패 — 2026-10-26)', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(chainFetch({ results: [] }))
    await expect(generateNewsSummary({})).rejects.toBeInstanceOf(NewsSearchError)
  })

  test('검색 결과 없음 시 예외 (호출자가 다음 틱 재시도)', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(chainFetch({ results: [] }))
    await expect(generateNewsSummary({ EXA_API_KEY: 'test-key' })).rejects.toBeInstanceOf(
      NewsSearchError,
    )
  })

  test('요약문에 출처가 없으면 Exa URL을 결정적으로 붙임', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(chainFetch(exaFixture))
    const text = await generateNewsSummary(
      { EXA_API_KEY: 'test-key' },
      {
        summarize: async (items) =>
          items.map((it, i) => `${i + 1}. ${it.title}: 한 줄 요약`).join('\n'),
      },
    )
    expect(text).toContain('[출처](https://example.com/news1)')
    expect(text).toContain('[출처](https://example.com/news2)')
    expect(text).not.toContain('example.com/old')
  })

  test('요약기가 지어낸 URL을 쓰면 Exa URL로 교체', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(chainFetch(exaFixture))
    const text = await generateNewsSummary(
      { EXA_API_KEY: 'test-key' },
      {
        summarize: async () =>
          '1. 가짜 뉴스: 요약 — [출처](https://fake.example.com/made-up)\n' +
          '2. 진짜 뉴스: 요약 — [출처](https://example.com/news2)',
      },
    )
    expect(text).not.toContain('fake.example.com')
    expect(text).toContain('https://example.com/news1')
    expect(text).toContain('https://example.com/news2')
  })

  test('요약기 실패 시 예외 전파', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(chainFetch(exaFixture))
    await expect(
      generateNewsSummary(
        { EXA_API_KEY: 'test-key' },
        { summarize: async () => { throw new Error('model down') } },
      ),
    ).rejects.toThrow('model down')
  })
})
