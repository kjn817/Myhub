/**
 * 뉴스 요약 브리핑 생성 테스트 — Exa 검색 + 요약 + 출처 검증
 * 실제 Exa·모델 호출 없음 (Exa 다리는 주입한 fetchFn으로,
 * generateNewsSummary는 fetch 라우팅 목 + 요약기 주입).
 *
 * 2026-11-08 재작성 (배치 3, A1): 단독 searchNews 함수는 사라지고 검색은
 * 소스 체인(news-sources.fetchNewsSources)의 다리 구조로 개편됐다. 구
 * searchNews의 성질 중 Exa 다리에 남은 것(키 없음→빈 배열, 요청 형태,
 * 결과 매핑, 오류 전파)은 searchExaNews로 검증하고, 신선도 하드 필터는
 * 체인 종단인 generateNewsSummary 테스트가 검증한다 (구 '30일 초과 제외'는
 * 다리 자체가 아니라 Exa 날짜 창 파라미터 + 체인 필터의 몫으로 이동).
 */
import {
  generateNewsSummary,
  NewsSearchError,
} from '../src/services/news-briefing'
import { searchExaNews } from '../src/services/news-source-legs'

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

describe('searchExaNews (Exa 다리)', () => {
  test('키가 없으면 빈 배열 + fetch 미호출', async () => {
    const fetchFn = jest.fn()
    expect(await searchExaNews({}, '오늘 주요 뉴스', new Date(), fetchFn as any)).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  test('요청 형태(POST·x-api-key·news 카테고리·날짜 창)와 결과 매핑', async () => {
    let seenUrl = ''
    let seenInit: any
    const fetchFn = jest.fn(async (url: string, init: any) => {
      seenUrl = String(url)
      seenInit = init
      return { ok: true, json: async () => exaFixture } as Response
    })
    const items = await searchExaNews(
      { EXA_API_KEY: 'test-key' },
      '오늘 주요 뉴스',
      new Date(),
      fetchFn as any,
    )
    expect(seenUrl).toBe('https://api.exa.ai/search')
    expect(seenInit.method).toBe('POST')
    expect(seenInit.headers['x-api-key']).toBe('test-key')
    const body = JSON.parse(seenInit.body)
    expect(body.category).toBe('news')
    expect(body.numResults).toBe(10)
    expect(body.contents).toEqual({ highlights: true })
    expect(body.query).toContain('오늘 주요 뉴스')
    // 신선도 창: 발행일 범위 파라미터를 Exa에 보낸다 (하드 필터는 체인 몫)
    expect(typeof body.startPublishedDate).toBe('string')
    expect(typeof body.endPublishedDate).toBe('string')
    expect(body.startPublishedDate <= body.endPublishedDate).toBe(true)
    // 결과 매핑: 제목/URL/하이라이트/발행일 (다리는 날짜로 거르지 않는다)
    expect(items.map((i) => i.url)).toEqual([
      'https://example.com/news1',
      'https://example.com/old',
      'https://example.com/news2',
    ])
    expect(items[0].title).toBe('오늘의 주요 뉴스 1')
    expect(items[0].publishedDate).toBe(NOW_ISO)
  })

  test('Exa 비정상 응답 시 오류 전파 (체인에서 다리 실패로 처리)', async () => {
    const fetchFn = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response)
    await expect(
      searchExaNews({ EXA_API_KEY: 'test-key' }, '오늘 주요 뉴스', new Date(), fetchFn as any),
    ).rejects.toThrow('Exa 500')
  })

  test('fetch 자체 실패 시 오류 전파', async () => {
    const fetchFn = jest.fn(async () => { throw new Error('network down') })
    await expect(
      searchExaNews({ EXA_API_KEY: 'test-key' }, '오늘 주요 뉴스', new Date(), fetchFn as any),
    ).rejects.toThrow('network down')
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
