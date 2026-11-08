/**
 * 뉴스 요약 브리핑 커버리지 보강 (그룹 D)
 * - Exa 다리(searchExaNews): 응답 JSON 파싱 실패, 결과 매핑 분기(제목 폴백·비http 제외·10건 절단·날짜 비문자열)
 * - summarizeNewsWithModel(기본 요약기): aiChat 1회 호출 계약 + buildNewsContext 분기
 * - generateNewsSummary: 요약기 빈 응답 → NewsSearchError
 * 실제 Exa·모델 호출 없음 (fetch 목 + aiChat 모듈 목).
 *
 * 2026-11-08 재작성 (배치 3, A1): 단독 searchNews는 소스 체인의 Exa 다리
 * (news-source-legs.searchExaNews)로 개편됐다. 다리는 오류를 감싸지 않고
 * 그대로 던진다 (NewsSearchError 변환은 체인 종단 generateNewsSummary의 몫).
 */
import { generateNewsSummary, NewsSearchError } from '../src/services/news-briefing'
import { searchExaNews } from '../src/services/news-source-legs'
import { aiChat } from '../src/services/ai'

jest.mock('../src/services/ai', () => ({
  aiChat: jest.fn(),
}))

const mockAiChat = aiChat as jest.Mock

const NOW_ISO = new Date().toISOString()

afterEach(() => {
  jest.restoreAllMocks()
  mockAiChat.mockReset()
})

function exaResponse(results: any[]) {
  return { ok: true, json: async () => ({ results }) } as Response
}

/**
 * 체인용 라우팅 목 fetch (2026-10-26 트랙 A2 — Exa 단계 기사 날짜 직접 검증):
 * Exa JSON / RSS 빈 피드 / 기사 페이지는 신선한 메타 날짜의 HTML을 반환한다.
 * generateNewsSummary 테스트 전용 (searchNews는 Exa 직접 호출이라 단일 응답 목 유지).
 */
function chainFetch(results: any[]) {
  return jest.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('api.exa.ai')) return exaResponse(results)
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

describe('searchExaNews — 응답 파싱·매핑 분기', () => {
  test('JSON 파싱 실패 시 파싱 오류가 그대로 전파된다 (다리는 감싸지 않음)', async () => {
    const fetchFn = jest.fn(async () => ({
      ok: true,
      json: async () => {
        throw new Error('unexpected token')
      },
    }) as any)
    await expect(
      searchExaNews({ EXA_API_KEY: 'k' }, '오늘 주요 뉴스', new Date(), fetchFn),
    ).rejects.toThrow('unexpected token')
  })

  test('fetch가 문자열로 reject되면 그대로 전파된다', async () => {
    const fetchFn = jest.fn(async () => {
      throw 'plain string failure'
    })
    await expect(
      searchExaNews({ EXA_API_KEY: 'k' }, '오늘 주요 뉴스', new Date(), fetchFn as any),
    ).rejects.toBe('plain string failure')
  })

  test('results 키가 없으면 빈 배열', async () => {
    const fetchFn = jest.fn(async () => ({ ok: true, json: async () => ({}) }) as Response)
    expect(
      await searchExaNews({ EXA_API_KEY: 'k' }, '오늘 주요 뉴스', new Date(), fetchFn as any),
    ).toEqual([])
  })

  test('제목 없으면 URL로 폴백, 비http URL 제외, 날짜 비문자열은 버림', async () => {
    const results = [
      { url: 'https://example.com/a', highlights: ['h1'], publishedDate: NOW_ISO },
      { title: '두번째', url: 'https://example.com/b', publishedDate: 12345 },
      { title: 'ftp 제외', url: 'ftp://example.com/c' },
      { title: 'URL 없음' },
      { title: '네번째', url: 'https://example.com/d', publishedDate: NOW_ISO },
      { title: '다섯번째', url: 'https://example.com/e', publishedDate: NOW_ISO },
    ]
    const fetchFn = jest.fn(async () => exaResponse(results))
    const items = await searchExaNews(
      { EXA_API_KEY: 'k' },
      '오늘 주요 뉴스',
      new Date(),
      fetchFn as any,
    )
    expect(items.map((i) => i.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/d',
      'https://example.com/e',
    ])
    expect(items[0].title).toBe('https://example.com/a') // 제목 폴백
    expect(items[1].publishedDate).toBeUndefined() // 숫자 날짜는 버림
    expect(items[0].highlights).toEqual(['h1'])
    // highlights 3개 이상이면 2개로 절단
    const fetchFn2 = jest.fn(async () =>
      exaResponse([
        {
          title: 't',
          url: 'https://example.com/h',
          highlights: ['1', '2', '3'],
          publishedDate: NOW_ISO,
        },
      ]),
    )
    const one = await searchExaNews(
      { EXA_API_KEY: 'k' },
      '오늘 주요 뉴스',
      new Date(),
      fetchFn2 as any,
    )
    expect(one[0].highlights).toEqual(['1', '2'])
  })

  test('결과는 10건으로 절단된다 (필터보다 먼저)', async () => {
    const results = Array.from({ length: 12 }, (_, i) => ({
      title: `뉴스 ${i}`,
      url: `https://example.com/n${i}`,
      publishedDate: NOW_ISO,
    }))
    const fetchFn = jest.fn(async () => exaResponse(results))
    const items = await searchExaNews(
      { EXA_API_KEY: 'k' },
      '오늘 주요 뉴스',
      new Date(),
      fetchFn as any,
    )
    expect(items).toHaveLength(10)
    expect(items[9].url).toBe('https://example.com/n9')
  })

  test('results 없음·fetch 요청 계약 (POST·news 카테고리·10건·highlights·날짜 창)', async () => {
    const fetchFn = jest.fn(async (_url: string, _init?: any) => exaResponse([]))
    expect(
      await searchExaNews({ EXA_API_KEY: 'k' }, '커스텀 검색어', new Date(), fetchFn as any),
    ).toEqual([])
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.exa.ai/search')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('k')
    const body = JSON.parse(String(init.body))
    expect(body.query).toContain('커스텀 검색어') // 날짜 소독으로 오늘 날짜가 앞에 붙는다
    expect(body).toMatchObject({
      category: 'news',
      numResults: 10,
      contents: { highlights: true },
    })
    expect(typeof body.startPublishedDate).toBe('string')
    expect(typeof body.endPublishedDate).toBe('string')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('generateNewsSummary — 기본 요약기 (aiChat 경유)', () => {
  const fixture = [
    {
      title: '오늘의 주요 뉴스 1',
      url: 'https://example.com/news1',
      highlights: ['핵심 내용 1'],
      publishedDate: NOW_ISO,
    },
    { title: '날짜·내용 없는 뉴스', url: 'https://example.com/news2' },
  ]

  test('aiChat 1회 호출: 백그라운드 전용 계약 + 검색 맥락 전달 + 출처 검증 적용', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(chainFetch(fixture))
    mockAiChat.mockResolvedValue({
      text:
        '1. 오늘의 주요 뉴스 1: 한 줄 요약 — [출처](https://example.com/news1)\n' +
        '2. 날짜·내용 없는 뉴스: 한 줄 요약 — [출처](https://example.com/news2)',
    })
    const text = await generateNewsSummary({ EXA_API_KEY: 'k' })
    expect(mockAiChat).toHaveBeenCalledTimes(1)
    const [envArg, capsArg, messages] = mockAiChat.mock.calls[0]
    expect(envArg).toMatchObject({ EXA_API_KEY: 'k' })
    // personaId 없음 → FC 도구 미부착, 백그라운드 전용
    // origin 'scheduled' 명시 (③-A): 예약 경로의 AI 호출임을 정책 객체로 고정
    expect(capsArg).toEqual({
      capability: 'summarize',
      privacy: 'external-ok',
      latency: 'background',
      quality: 'balanced',
      origin: 'scheduled',
    })
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('도구를 호출하지 않고 텍스트로만 답해')
    const userContent = messages[1].content as string
    // buildNewsContext: 번호·제목·URL·날짜·내용
    expect(userContent).toContain('1. 오늘의 주요 뉴스 1\n   URL: https://example.com/news1')
    expect(userContent).toContain(`날짜: ${NOW_ISO.slice(0, 10)}`)
    expect(userContent).toContain('내용: 핵심 내용 1')
    // 날짜 없는 항목은 체인 하드 필터에서 제외돼 요약 맥락에 들어가지 않는다 (2026-10-26)
    expect(userContent).not.toContain('날짜·내용 없는 뉴스')
    // 날짜·내용 없는 항목에는 해당 줄이 없음
    expect(userContent).not.toContain('날짜: \n')
    expect(userContent).toContain('[출처](URL)')
    expect(userContent).toContain('30일 이상 지난 결과는 인용하지 말 것')
    expect(text).toContain('[출처](https://example.com/news1)')
    expect(text).toContain('[출처](https://example.com/news2)')
  })

  test('aiChat 빈 응답 시 NewsSearchError (기본 요약기 내부 검사)', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(chainFetch(fixture))
    mockAiChat.mockResolvedValue({ text: '   ' })
    await expect(generateNewsSummary({ EXA_API_KEY: 'k' })).rejects.toThrow(
      '뉴스 요약 실패: 모델 응답 없음',
    )
  })

  test('aiChat text 없음(null) 시에도 NewsSearchError', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(chainFetch(fixture))
    mockAiChat.mockResolvedValue({ text: null })
    await expect(generateNewsSummary({ EXA_API_KEY: 'k' })).rejects.toBeInstanceOf(
      NewsSearchError,
    )
  })

  test('aiChat 예외는 그대로 전파 (호출자가 다음 틱 재시도)', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(chainFetch(fixture))
    mockAiChat.mockRejectedValue(new Error('model exploded'))
    await expect(generateNewsSummary({ EXA_API_KEY: 'k' })).rejects.toThrow('model exploded')
  })
})

describe('generateNewsSummary — 주입 요약기 빈 응답 검사', () => {
  test('요약기가 빈 문자열 반환 시 NewsSearchError', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(
      chainFetch([
        {
          title: '뉴스',
          url: 'https://example.com/n',
          highlights: [],
          publishedDate: NOW_ISO,
        },
      ]),
    )
    await expect(
      generateNewsSummary({ EXA_API_KEY: 'k' }, { summarize: async () => '' }),
    ).rejects.toThrow('뉴스 요약 실패: 모델 응답 없음')
  })

  test('요약기가 공백만 반환 시 NewsSearchError', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(
      chainFetch([
        {
          title: '뉴스',
          url: 'https://example.com/n',
          highlights: [],
          publishedDate: NOW_ISO,
        },
      ]),
    )
    await expect(
      generateNewsSummary({ EXA_API_KEY: 'k' }, { summarize: async () => '  \n ' }),
    ).rejects.toThrow('뉴스 요약 실패: 모델 응답 없음')
  })

  test('요약기가 undefined 반환 시 NewsSearchError', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(
      chainFetch([
        {
          title: '뉴스',
          url: 'https://example.com/n',
          highlights: [],
          publishedDate: NOW_ISO,
        },
      ]),
    )
    await expect(
      generateNewsSummary(
        { EXA_API_KEY: 'k' },
        { summarize: async () => undefined as unknown as string },
      ),
    ).rejects.toThrow('뉴스 요약 실패: 모델 응답 없음')
  })
})
