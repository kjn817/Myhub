/// <reference types="jest" />
/**
 * 기사 날짜 직접 검증 단위 테스트 (2026-10-26 트랙 A2)
 * - extractArticlePublishedDate: 메타 → JSON-LD → <time> 우선순위, 한국어 날짜
 * - parseKoreanDate: "2026년 10월 26일"·"10월 26일"·점 표기
 * - verifyArticleDates: fixture HTML로 검증 (라이브 fetch 금지) — fetch 실패·
 *   날짜 없음·창 밖은 제외(strict), deadline·동시성·타임아웃 상한
 * 실제 외부 호출 없음 — fetch 주입/mock.
 */
import {
  extractArticlePublishedDate,
  parseDateValue,
  parseKoreanDate,
  verifyArticleDates,
} from '../../src/services/article-date'

const NOW = new Date('2026-10-26T12:00:00Z') // KST 21:00 → 창 2026-10-25~2026-10-26
const WINDOW = { startDate: '2026-10-25', endDate: '2026-10-26' }
const FRESH_ISO = '2026-10-26T10:30:00+09:00'
const OLD_ISO = '2025-01-19T00:00:00Z'

function okText(text: string): Response {
  return { ok: true, text: async () => text } as unknown as Response
}

function articleHtml(parts: {
  meta?: string
  jsonLd?: string
  timeAttr?: string
  timeText?: string
  pubdateMeta?: string
}): string {
  return `<html><head>
    ${parts.meta ? `<meta property="article:published_time" content="${parts.meta}">` : ''}
    ${parts.pubdateMeta ? `<meta name="publishdate" content="${parts.pubdateMeta}">` : ''}
    ${parts.jsonLd ? `<script type="application/ld+json">${parts.jsonLd}</script>` : ''}
  </head><body>
    ${parts.timeAttr ? `<time datetime="${parts.timeAttr}">2026년 10월 26일</time>` : ''}
    ${parts.timeText ? `<time>${parts.timeText}</time>` : ''}
  </body></html>`
}

describe('parseKoreanDate', () => {
  it('"2026년 10월 26일" → KST 자정(UTC 전날 15:00)', () => {
    expect(parseKoreanDate('2026년 10월 26일', NOW)).toBe('2026-10-25T15:00:00.000Z')
  })

  it('"10월 26일" → now의 KST 연도 사용', () => {
    expect(parseKoreanDate('10월 26일', NOW)).toBe('2026-10-25T15:00:00.000Z')
  })

  it('"2026년 10월 26일 21시 23분" → 시각 포함', () => {
    expect(parseKoreanDate('2026년 10월 26일 21시 23분', NOW)).toBe('2026-10-26T12:23:00.000Z')
  })

  it('"2026.10.26" 점 표기', () => {
    expect(parseKoreanDate('2026.10.26', NOW)).toBe('2026-10-25T15:00:00.000Z')
  })

  it('무효 날짜·빈 문자열 → undefined', () => {
    expect(parseKoreanDate('2026년 13월 40일', NOW)).toBeUndefined()
    expect(parseKoreanDate('', NOW)).toBeUndefined()
    expect(parseKoreanDate('날짜 없음', NOW)).toBeUndefined()
  })

  it('연도 범위 가드: 1900~2100년 밖은 날짜가 아니다 (감사 §4 #1 — 달력 검사가 흡수 못 함)', () => {
    expect(parseKoreanDate('1899년 6월 15일', NOW)).toBeUndefined()
    expect(parseKoreanDate('2101년 1월 1일', NOW)).toBeUndefined()
    // 경계 1900-01-01·2100-12-31은 유효하다
    expect(parseKoreanDate('1900년 1월 1일', NOW)).toBe('1899-12-31T15:00:00.000Z')
    expect(parseKoreanDate('2100년 12월 31일', NOW)).toBe('2100-12-30T15:00:00.000Z')
  })

  it('월/일 경계: 12월·31일·1월 1일은 유효하다 (감사 §4 #2)', () => {
    expect(parseKoreanDate('2026년 12월 31일', NOW)).toBe('2026-12-30T15:00:00.000Z')
    expect(parseKoreanDate('2026년 1월 1일', NOW)).toBe('2025-12-31T15:00:00.000Z')
    expect(parseKoreanDate('2026년 12월 1일', NOW)).toBe('2026-11-30T15:00:00.000Z')
  })

  it('시간 가드: 24시·60분은 무효, 23시 59분은 유효하다 (감사 §4 #3)', () => {
    expect(parseKoreanDate('2026년 10월 26일 24시 00분', NOW)).toBeUndefined()
    expect(parseKoreanDate('2026년 10월 26일 21시 60분', NOW)).toBeUndefined()
    expect(parseKoreanDate('2026년 10월 26일 23시 59분', NOW)).toBe('2026-10-26T14:59:00.000Z')
    expect(parseKoreanDate('2026년 10월 26일 0시 0분', NOW)).toBe('2026-10-25T15:00:00.000Z')
  })

  it('앞뒤 공백이 있어도 파싱된다 (감사 §4 #8 — trim 뮤턴트)', () => {
    expect(parseKoreanDate('  2026년 10월 26일  ', NOW)).toBe('2026-10-25T15:00:00.000Z')
    expect(parseKoreanDate('\t2026년 10월 26일 21시 23분\n', NOW)).toBe('2026-10-26T12:23:00.000Z')
  })
})

describe('parseDateValue', () => {
  it('ISO·RFC는 Date.parse 경유', () => {
    expect(parseDateValue('2026-10-26T10:30:00+09:00', NOW)).toBe('2026-10-26T01:30:00.000Z')
    expect(parseDateValue('Mon, 26 Oct 2026 09:00:00 GMT', NOW)).toBe('2026-10-26T09:00:00.000Z')
  })

  it('한국어 날짜는 parseKoreanDate 경유', () => {
    expect(parseDateValue('10월 26일', NOW)).toBe('2026-10-25T15:00:00.000Z')
  })

  it('비문자열·파싱 불가 → undefined', () => {
    expect(parseDateValue(12345, NOW)).toBeUndefined()
    expect(parseDateValue('not a date', NOW)).toBeUndefined()
  })
})

describe('extractArticlePublishedDate', () => {
  it('article:published_time 메타 (작은따옴표·속성 순서 무관)', () => {
    expect(extractArticlePublishedDate(articleHtml({ meta: FRESH_ISO }), NOW)).toBe(
      '2026-10-26T01:30:00.000Z',
    )
    const single = `<meta content='${FRESH_ISO}' property='article:published_time'>`
    expect(extractArticlePublishedDate(single, NOW)).toBe('2026-10-26T01:30:00.000Z')
  })

  it('JSON-LD datePublished (최상위·@graph·중첩)', () => {
    expect(
      extractArticlePublishedDate(
        articleHtml({ jsonLd: JSON.stringify({ '@type': 'NewsArticle', datePublished: OLD_ISO }) }),
        NOW,
      ),
    ).toBe('2025-01-19T00:00:00.000Z')
    expect(
      extractArticlePublishedDate(
        articleHtml({
          jsonLd: JSON.stringify({
            '@graph': [{ '@type': 'WebPage' }, { '@type': 'NewsArticle', datePublished: OLD_ISO }],
          }),
        }),
        NOW,
      ),
    ).toBe('2025-01-19T00:00:00.000Z')
  })

  it('깨진 JSON-LD는 datePublished 정규식 폴백으로 찾는다', () => {
    const broken = `{"@type": "NewsArticle", "datePublished": "${OLD_ISO}", "broken": }`
    expect(extractArticlePublishedDate(articleHtml({ jsonLd: broken }), NOW)).toBe(
      '2025-01-19T00:00:00.000Z',
    )
  })

  it('datePublished이 파싱 불가면 다른 키의 날짜로 계속 탐색한다', () => {
    const html = articleHtml({
      jsonLd: JSON.stringify({
        datePublished: 'not-a-date',
        author: { datePublished: OLD_ISO },
      }),
    })
    expect(extractArticlePublishedDate(html, NOW)).toBe('2025-01-19T00:00:00.000Z')
  })

  it('JSON-LD 어디에도 날짜가 없으면 undefined', () => {
    const html = articleHtml({
      jsonLd: JSON.stringify({ '@graph': [{ '@type': 'WebPage' }, { '@type': 'Thing' }] }),
    })
    expect(extractArticlePublishedDate(html, NOW)).toBeUndefined()
  })

  it('<time datetime> → <time> 본문 한국어 날짜 → publishdate 메타 순', () => {
    expect(extractArticlePublishedDate(articleHtml({ timeAttr: OLD_ISO }), NOW)).toBe(
      '2025-01-19T00:00:00.000Z',
    )
    expect(extractArticlePublishedDate(articleHtml({ timeText: '10월 26일' }), NOW)).toBe(
      '2026-10-25T15:00:00.000Z',
    )
    expect(extractArticlePublishedDate(articleHtml({ pubdateMeta: OLD_ISO }), NOW)).toBe(
      '2025-01-19T00:00:00.000Z',
    )
  })

  it('우선순위: 메타 > JSON-LD > <time>', () => {
    const html = articleHtml({
      meta: FRESH_ISO,
      jsonLd: JSON.stringify({ datePublished: OLD_ISO }),
      timeAttr: OLD_ISO,
    })
    expect(extractArticlePublishedDate(html, NOW)).toBe('2026-10-26T01:30:00.000Z')
    const html2 = articleHtml({
      jsonLd: JSON.stringify({ datePublished: OLD_ISO }),
      timeAttr: FRESH_ISO,
    })
    expect(extractArticlePublishedDate(html2, NOW)).toBe('2025-01-19T00:00:00.000Z')
  })

  it('날짜 없음·가짜 날짜 → undefined', () => {
    expect(extractArticlePublishedDate('<html><body>기사 본문만</body></html>', NOW)).toBeUndefined()
    expect(
      extractArticlePublishedDate(articleHtml({ meta: 'not-a-date' }), NOW),
    ).toBeUndefined()
  })
})

describe('verifyArticleDates', () => {
  const freshItem = { title: '신선', url: 'https://example.com/fresh', publishedDate: FRESH_ISO }
  // 잔존 간극 fixture (2026-10-26 tail 로그): bbcbreakingnews 미러 — 가짜지만
  // 자정이 아닌 시각(21:23:30) + 날짜 없는 URL. HTML 메타 날짜가 진짜 날짜다.
  const gapItem = {
    title: '韓國總統尹錫悅彈劾案',
    url: 'https://bbcbreakingnews.pages.dev/zhongwen/articles/cm2ny3gvmd1o/trad',
    publishedDate: '2026-10-25T21:23:30.000Z',
  }
  const gapHtml = articleHtml({
    jsonLd: JSON.stringify({ '@type': 'NewsArticle', datePublished: '2025-01-19T12:00:00+09:00' }),
  })

  it('HTML 메타 날짜가 창 안이면 유지 + publishedDate를 검증된 날짜로 교체', async () => {
    const fetchFn: jest.Mock = jest.fn(async () => okText(articleHtml({ meta: FRESH_ISO })))
    const { verified, checks } = await verifyArticleDates([freshItem], WINDOW, {
      now: NOW,
      fetchFn: fetchFn as any,
    })
    expect(verified).toHaveLength(1)
    expect(verified[0].publishedDate).toBe('2026-10-26T01:30:00.000Z')
    expect(verified[0].title).toBe('신선')
    expect(checks).toEqual([
      { url: freshItem.url, reason: 'verified', verifiedDate: '2026-10-26T01:30:00.000Z' },
    ])
    // 브라우저 UA로 fetch (기사 사이트 차단 회피)
    expect(String((fetchFn.mock.calls[0][1] as any).headers['User-Agent'])).toMatch(/^Mozilla\/5\.0/)
  })

  it('잔존 간극 fixture: HTML 날짜가 오래되면 제외 (out-of-window)', async () => {
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes('bbcbreakingnews')) return okText(gapHtml)
      throw new Error('unexpected ' + url)
    })
    const { verified, checks } = await verifyArticleDates([gapItem], WINDOW, {
      now: NOW,
      fetchFn: fetchFn as any,
    })
    expect(verified).toEqual([])
    expect(checks).toEqual([
      { url: gapItem.url, reason: 'out-of-window', verifiedDate: '2025-01-19T03:00:00.000Z' },
    ])
  })

  it('fetch 실패·!ok·날짜 없음은 모두 제외 (strict — 실패를 신선함으로 간주 금지)', async () => {
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes('throw')) throw new Error('net down')
      if (url.includes('notok')) return { ok: false, status: 403 } as unknown as Response
      return okText('<html><body>날짜 없음</body></html>')
    })
    const items = [
      { title: 'a', url: 'https://example.com/throw', publishedDate: FRESH_ISO },
      { title: 'b', url: 'https://example.com/notok', publishedDate: FRESH_ISO },
      { title: 'c', url: 'https://example.com/nodate', publishedDate: FRESH_ISO },
    ]
    const { verified, checks } = await verifyArticleDates(items, WINDOW, {
      now: NOW,
      fetchFn: fetchFn as any,
    })
    expect(verified).toEqual([])
    expect(checks.map((c) => c.reason)).toEqual(['fetch-failed', 'fetch-failed', 'no-date'])
  })

  it('limit 도달하면 남은 후보는 fetch하지 않는다', async () => {
    const fetchFn = jest.fn(async () => okText(articleHtml({ meta: FRESH_ISO })))
    const items = [0, 1, 2].map((i) => ({
      title: `n${i}`,
      url: `https://example.com/n${i}`,
      publishedDate: FRESH_ISO,
    }))
    const { verified } = await verifyArticleDates(items, WINDOW, {
      now: NOW,
      fetchFn: fetchFn as any,
      limit: 1,
    })
    expect(verified).toHaveLength(1)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('병렬 최대 3개 (동시성 상한)', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const fetchFn = jest.fn(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 20))
      inFlight--
      return okText(articleHtml({ meta: FRESH_ISO }))
    })
    const items = Array.from({ length: 6 }, (_, i) => ({
      title: `n${i}`,
      url: `https://example.com/n${i}`,
      publishedDate: FRESH_ISO,
    }))
    const { verified } = await verifyArticleDates(items, WINDOW, {
      now: NOW,
      fetchFn: fetchFn as any,
    })
    expect(verified).toHaveLength(6)
    expect(maxInFlight).toBeLessThanOrEqual(3)
    expect(maxInFlight).toBeGreaterThan(1)
  })

  it('hang fetch도 perFetchTimeout 안에 끊고 제외한다 (signal 무시 mock 재현)', async () => {
    const fetchFn = jest.fn(async () => new Promise<Response>(() => {}))
    const start = Date.now()
    const { verified, checks } = await verifyArticleDates([freshItem], WINDOW, {
      now: NOW,
      fetchFn: fetchFn as any,
      perFetchTimeoutMs: 100,
    })
    expect(verified).toEqual([])
    expect(checks[0].reason).toBe('fetch-failed')
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('deadline 이후에는 새 fetch를 시작하지 않는다 (시작 시각이 deadline 이전)', async () => {
    const deadline = Date.now() + 120
    const starts: number[] = []
    const fetchFn: jest.Mock = jest.fn(async () => {
      starts.push(Date.now())
      await new Promise((r) => setTimeout(r, 80))
      return okText(articleHtml({ meta: FRESH_ISO }))
    })
    const items = [0, 1, 2, 3].map((i) => ({
      title: `n${i}`,
      url: `https://example.com/n${i}`,
      publishedDate: FRESH_ISO,
    }))
    const start = Date.now()
    const { verified } = await verifyArticleDates(items, WINDOW, {
      now: NOW,
      fetchFn: fetchFn as any,
      concurrency: 1,
      perFetchTimeoutMs: 5000,
      deadline,
    })
    // 모든 fetch 시작 시각은 deadline을 초과하지 않아야 한다.
    // Date.now() 1ms 단위라 검사 통과 후 같은 ms에 시작할 수 있음 — 시작 시각이
    // deadline을 초과하지 않음이 불변식 (검사·기록이 서로 다른 Date.now() 읽기라
    // 엄격한 < 단언은 같은 ms에서 간헐 실패한다 — 2026-10-28 감사 §6).
    expect(starts.length).toBeGreaterThan(0)
    for (const t of starts) expect(t).toBeLessThanOrEqual(deadline)
    // deadline 안에 검증이 끝난 항목만 유지된다 — 전체가 검증되지는 않는다
    expect(verified.length).toBeLessThan(items.length)
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('이미 지난 deadline이면 fetch 없이 빈 결과', async () => {
    const fetchFn = jest.fn()
    const { verified, checks } = await verifyArticleDates([freshItem], WINDOW, {
      now: NOW,
      fetchFn: fetchFn as any,
      deadline: Date.now() - 1,
    })
    expect(verified).toEqual([])
    expect(checks).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
