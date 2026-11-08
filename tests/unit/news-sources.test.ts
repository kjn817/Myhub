/// <reference types="jest" />
/**
 * 뉴스 소스 체인 단위 테스트 (2026-10-26 Exa 조사 권장안)
 * - 네이버 sort=date / Google News RSS 파싱 / Tavily news+day+advanced /
 *   Exa 최적화 본문 / 체인 순서·하드 필터·키 없음 스킵·진단 로그
 * 실제 외부 호출 없음 — 체인·파싱 테스트는 fetch 주입, 호출 형태가 성질인
 * 단건 소스 테스트(네이버·RSS UA·Exa 파라미터)는 MSW 핸들러로 검증한다
 * (2026-10-27 MSW 적용 — docs/msw-20261027.md).
 */
import {
  fetchNewsSources,
  searchNaverNews,
  fetchGoogleNewsRss,
  parseGoogleNewsRss,
  parseRssItems,
  searchTavilyNews,
  searchExaNews,
  fetchPressRssHeadlines,
  pressQueryTokens,
  PRESS_RSS_FEEDS,
  PRESS_RSS_KO_FEEDS,
  NEWS_CHAIN_TARGET,
} from '../../src/services/news-sources'
import { createMswServer, http, HttpResponse } from '../helpers/msw-server'

const NOW = new Date('2026-10-26T12:00:00Z') // KST 21:00 → 창 2026-10-25~2026-10-26
const TODAY_ISO = '2026-10-26T09:00:00+09:00'
const OLD_ISO = '2025-01-19T00:00:00Z'

afterEach(() => {
  jest.restoreAllMocks()
})

// 호출 형태(URL·헤더·바디)가 성질인 단건 소스 테스트용 MSW 서버.
// 핸들러는 테스트 안에서 server.use()로 등록한다 (응답 fixture가 테스트마다 다름).
// 체인 테스트는 fetchFn 주입 방식을 유지하므로 이 서버를 타지 않는다.
const server = createMswServer()

function okJson(body: any): Response {
  return { ok: true, json: async () => body } as unknown as Response
}

function okText(text: string): Response {
  return { ok: true, text: async () => text } as unknown as Response
}

describe('searchNaverNews', () => {
  it('키가 없으면 fetch 없이 빈 배열 (조용히 스킵)', async () => {
    const fetchFn = jest.fn()
    expect(await searchNaverNews({}, '뉴스', fetchFn as any)).toEqual([])
    expect(await searchNaverNews({ NAVER_CLIENT_ID: 'id' }, '뉴스', fetchFn as any)).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('sort=date + HUB 헤더 + <b> 제거 + pubDate 매핑 + 비http 제외 (MSW: 실제 호출 형태 검증)', async () => {
    // fetchFn을 주입하지 않는다 — 기본 전역 fetch가 MSW 핸들러로 간다.
    server.use(
      http.get('https://naverapihub.apigw.ntruss.com/search/v1/news', ({ request }) => {
        const url = new URL(request.url)
        expect(url.searchParams.get('sort')).toBe('date')
        expect(url.searchParams.get('display')).toBe('10')
        expect(url.searchParams.get('query')).toBe('한국 뉴스')
        expect(request.headers.get('X-NCP-APIGW-API-KEY-ID')).toBe('id')
        expect(request.headers.get('X-NCP-APIGW-API-KEY')).toBe('s')
        // 구 헤더가 실수로 같이/대신 보내지면 안 된다 (HUB 이관 — 2026-10-28)
        expect(request.headers.get('X-Naver-Client-Id')).toBeNull()
        expect(request.headers.get('X-Naver-Client-Secret')).toBeNull()
        return HttpResponse.json({
          items: [
            { title: '<b>오늘</b> 뉴스', originallink: 'https://example.com/n1', link: 'https://example.com/n1', pubDate: 'Mon, 26 Oct 2026 09:00:00 +0900' },
            { title: '두번째', originallink: 'javascript:void(0)', link: 'https://example.com/n2', pubDate: 'Mon, 26 Oct 2026 08:00:00 +0900' },
          ],
        })
      }),
    )
    const out = await searchNaverNews({ NAVER_CLIENT_ID: 'id', NAVER_CLIENT_SECRET: 's' }, '한국 뉴스')
    expect(out).toHaveLength(2)
    expect(out[0].title).toBe('오늘 뉴스')
    expect(out[0].publishedDate).toBe('2026-10-26T00:00:00.000Z')
    expect(out[1].url).toBe('https://example.com/n2')
  })

  it('!ok면 throw (체인에서 다음 소스로 넘어감)', async () => {
    const fetchFn = jest.fn(async () => ({ ok: false, status: 401 }) as unknown as Response)
    await expect(searchNaverNews({ NAVER_CLIENT_ID: 'id', NAVER_CLIENT_SECRET: 's' }, 'q', fetchFn as any)).rejects.toThrow('네이버 401')
  })

  it('originallink·link 둘 다 비http면 최종 제외한다 (감사 §4 #5 — 최종 .filter 뮤턴트)', async () => {
    // 기존 테스트는 originallink 비http → link 폴백까지만 검증한다.
    // 둘 다 비http인 항목이 필터를 통과하면 결과에 남는다 (필터 제거 뮤턴트).
    const fetchFn = jest.fn(async () => okJson({
      items: [
        { title: '둘 다 비http', originallink: 'ftp://example.com/a', link: 'notaurl', pubDate: 'Mon, 26 Oct 2026 09:00:00 +0900' },
        { title: '둘 다 비http 2', originallink: 'javascript:void(0)', link: 'mailto:a@b.c', pubDate: 'Mon, 26 Oct 2026 09:00:00 +0900' },
        { title: '정상', originallink: 'https://example.com/ok', link: 'https://example.com/ok', pubDate: 'Mon, 26 Oct 2026 09:00:00 +0900' },
      ],
    }))
    const out = await searchNaverNews({ NAVER_CLIENT_ID: 'id', NAVER_CLIENT_SECRET: 's' }, 'q', fetchFn as any)
    expect(out.map((r) => r.title)).toEqual(['정상'])
    expect(out[0].url).toBe('https://example.com/ok')
  })

  it('HTML 엔티티를 디코딩한다 (감사 §4 #7 — stripHtmlTags 교체값 뮤턴트)', async () => {
    const fetchFn = jest.fn(async () => okJson({
      items: [
        { title: 'A &amp; B &quot;C&quot; &#39;D&#39; &lt;E&gt; &gt;', originallink: 'https://example.com/e', link: 'https://example.com/e', pubDate: 'Mon, 26 Oct 2026 09:00:00 +0900' },
        { title: 'X &apos;Y&apos;', originallink: 'https://example.com/e2', link: 'https://example.com/e2', pubDate: 'Mon, 26 Oct 2026 09:00:00 +0900' },
      ],
    }))
    const out = await searchNaverNews({ NAVER_CLIENT_ID: 'id', NAVER_CLIENT_SECRET: 's' }, 'q', fetchFn as any)
    expect(out[0].title).toBe(`A & B "C" 'D' <E> >`)
    expect(out[1].title).toBe(`X 'Y'`)
  })
})

describe('parseGoogleNewsRss / fetchGoogleNewsRss', () => {
  const XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<item><title><![CDATA[오늘 헤드라인 - 매체]]></title><link>https://example.com/r1</link><pubDate>Mon, 26 Oct 2026 09:00:00 GMT</pubDate></item>
<item><title>두번째 뉴스</title><link>https://example.com/r2</link><pubDate>Sun, 25 Oct 2026 23:00:00 GMT</pubDate></item>
<item><title>날짜 없음</title><link>https://example.com/r3</link></item>
<item><title>링크 없음</title><pubDate>Mon, 26 Oct 2026 09:00:00 GMT</pubDate></item>
<item><title>비http</title><link>ftp://example.com/x</link></item>
</channel></rss>`

  it('CDATA·일반 제목·pubDate 파싱, 제목/링크 없는 항목 제외', () => {
    const out = parseGoogleNewsRss(XML)
    expect(out.map((r) => r.title)).toEqual(['오늘 헤드라인 - 매체', '두번째 뉴스', '날짜 없음'])
    expect(out[0].publishedDate).toBe('2026-10-26T09:00:00.000Z')
    expect(out[1].publishedDate).toBe('2026-10-25T23:00:00.000Z')
    expect(out[2].publishedDate).toBeUndefined()
  })

  it('빈 피드·이상 XML은 빈 배열', () => {
    expect(parseGoogleNewsRss('<rss><channel></channel></rss>')).toEqual([])
    expect(parseGoogleNewsRss('not xml at all')).toEqual([])
  })

  it('12개 item 피드는 10건까지만 반환하고, 정확히 10건인 피드는 10건을 다 반환한다 (감사 §4 #6)', () => {
    const item = (i: number) =>
      `<item><title>뉴스 ${i}</title><link>https://example.com/r${i}</link><pubDate>Mon, 26 Oct 2026 09:00:00 GMT</pubDate></item>`
    const xml12 = `<rss><channel>${Array.from({ length: 12 }, (_, i) => item(i + 1)).join('')}</channel></rss>`
    const out12 = parseGoogleNewsRss(xml12)
    expect(out12).toHaveLength(10)
    expect(out12.map((r) => r.title)).toEqual(Array.from({ length: 10 }, (_, i) => `뉴스 ${i + 1}`))
    const xml10 = `<rss><channel>${Array.from({ length: 10 }, (_, i) => item(i + 1)).join('')}</channel></rss>`
    expect(parseGoogleNewsRss(xml10)).toHaveLength(10)
  })

  it('제목의 HTML 엔티티를 디코딩한다 (감사 §4 #7 — RSS 경로)', () => {
    const xml = `<rss><channel>
<item><title>A &amp; B &quot;C&quot; &#39;D&#39; &lt;E&gt; &gt;</title><link>https://example.com/r1</link><pubDate>Mon, 26 Oct 2026 09:00:00 GMT</pubDate></item>
<item><title>X &apos;Y&apos;</title><link>https://example.com/r2</link><pubDate>Mon, 26 Oct 2026 09:00:00 GMT</pubDate></item>
</channel></rss>`
    const out = parseGoogleNewsRss(xml)
    expect(out[0].title).toBe(`A & B "C" 'D' <E> >`)
    expect(out[1].title).toBe(`X 'Y'`)
  })

  it('hl=ko&gl=KR&ceid=KR:ko 로 요청, !ok면 throw (MSW: 실제 호출 형태 검증)', async () => {
    server.use(
      http.get('https://news.google.com/rss/search', ({ request }) => {
        const url = new URL(request.url)
        expect(url.searchParams.get('hl')).toBe('ko')
        expect(url.searchParams.get('gl')).toBe('KR')
        expect(url.searchParams.get('ceid')).toBe('KR:ko')
        return HttpResponse.text(XML)
      }),
    )
    const out = await fetchGoogleNewsRss('한국 뉴스')
    expect(out).toHaveLength(3)
    server.use(
      http.get('https://news.google.com/rss/search', () =>
        HttpResponse.text('err', { status: 500 }),
      ),
    )
    await expect(fetchGoogleNewsRss('q')).rejects.toThrow('Google News RSS 500')
  })

  it('브라우저 UA/Accept 헤더를 보낸다 (2026-10-26 실측: UA 없이 Worker egress에서 Google 503) (MSW)', async () => {
    server.use(
      http.get('https://news.google.com/rss/search', ({ request }) => {
        expect(String(request.headers.get('User-Agent'))).toMatch(/^Mozilla\/5\.0/)
        expect(String(request.headers.get('Accept'))).toContain('application/rss+xml')
        return HttpResponse.text(XML)
      }),
    )
    await fetchGoogleNewsRss('한국 뉴스')
  })
})

describe('press RSS (언론사 직접 RSS — 2026-10-28 Worker egress 실측)', () => {
  // 실제 피드 응답 기록 (2026-10-28 12:57 KST 전후 수집, 앞 3개 item만 발췌 —
  // 전문은 docs/rss-press-experiment-20261028.md 참조. 본문 description은
  // 파서가 읽지 않으므로 원문 그대로 둔다).
  const YNA_ECONOMY = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:sy="http://purl.org/rss/1.0/modules/syndication/">
\t<channel>
\t\t<title><![CDATA[연합뉴스 경제 최신기사]]></title>
\t\t<link>https://www.yna.co.kr/economy/all</link>
\t\t<copyright><![CDATA[저작권자(c) 연합뉴스, 무단 전재-재배포, AI 학습 및 활용 금지]]></copyright>
\t\t<language>ko-KR</language>
\t\t<item>
\t\t\t<title><![CDATA[국고채 금리 일제히 상승…3년물 장중 연 3.792%]]></title>
\t\t\t<link>https://www.yna.co.kr/view/AKR20261028096400008</link>
\t\t\t<pubDate>Wed, 28 Oct 2026 12:04:28 +0900</pubDate>
\t\t\t<description><![CDATA[(서울=연합뉴스) 28일 국고채 금리가 일제히 상승하고 있다.]]></description>
\t\t</item><item>
\t\t\t<title><![CDATA[고용·투자 늘리면 세무조사 면제…중소기업 부담 던다]]></title>
\t\t\t<link>https://www.yna.co.kr/view/AKR20261028066300002</link>
\t\t\t<pubDate>Wed, 28 Oct 2026 12:00:10 +0900</pubDate>
\t\t\t<description><![CDATA[(세종=연합뉴스) 송정은 기자 = 과세당국이 고용과 투자를 늘린 중소기업에는 정기 세무조사를 면제한다.]]></description>
\t\t</item><item>
\t\t\t<title><![CDATA['유니콘 창업을 꿈꾼다'…청소년 창업경진대회 결선 개최]]></title>
\t\t\t<link>https://www.yna.co.kr/view/AKR20261028071500530</link>
\t\t\t<pubDate>Wed, 28 Oct 2026 12:00:08 +0900</pubDate>
\t\t\t<description><![CDATA[(세종=연합뉴스) 고상민 기자 = 교육부는 16개 시도교육청, 한국청년기업가정신재단과 함께 29일 서울 에이티(aT)센터에서 &apos;2026 대한민국...]]></description>
\t\t</item></channel></rss>`
  const HANKYUNG_FINANCE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
    <channel>
        <title><![CDATA[한국경제 | 뉴스 | 증권]]></title>
        <link>https://www.hankyung.com/all-news-finance</link>
        <language>ko</language>
        <copyright>Copyright (c)  2005 hankyung.com All rights reserved</copyright>
        <item>
            <title><![CDATA[셀레스티카, 3분기 실적 호조·전망 상향에 12% 폭등]]></title>
            <link><![CDATA[https://www.hankyung.com/article/202610280276i]]></link>
            <pubDate>Wed, 28 Oct 2026 11:37:22 +0900</pubDate>
        </item><item>
            <title><![CDATA["상속세 대신 4.7조 주식 받았는데"…정부 '진땀' 흘린 까닭 [김익환의 부처 핸즈업]]]></title>
            <link><![CDATA[https://www.hankyung.com/article/202610280125i]]></link>
            <pubDate>Wed, 28 Oct 2026 11:33:10 +0900</pubDate>
        </item><item>
            <title><![CDATA[[오늘의 증권가 콜] LG이노텍, 셀트리온, HD현대일렉트릭, 한화오션, 에스티팜, 성광벤드 등]]></title>
            <link><![CDATA[https://www.hankyung.com/article/202610289683i]]></link>
            <pubDate>Wed, 28 Oct 2026 11:22:29 +0900</pubDate>
        </item></channel></rss>`
  const MK_ECONOMY = `<?xml version='1.0' encoding='UTF-8'?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:nyt="http://www.nytimes.com/namespaces/rss/2.0" version="2.0">
<channel>
  <title><![CDATA[매일경제 : 경제]]></title>
  <link>https://www.mk.co.kr/</link>
  <language>ko</language>
  <copyright>Copyright 2026 MK</copyright>
  <item>
    <no>12188232</no>
    <title><![CDATA[[단독] 韓, 블룸버그채권지수 선진국 승격 추진]]></title>
    <link><![CDATA[https://www.mk.co.kr/news/economy/12188232]]></link>
    <category><![CDATA[경제]]></category>
    <pubDate>Wed, 28 Oct 2026 11:18:04 +09:00</pubDate>
    <description><![CDATA[WGBI 편입 이어 채권시장 선진화 속도 블룸버그와 협의…내년 초 재분류 검토]]></description>
  </item><item>
    <no>12188202</no>
    <title><![CDATA[이찬진 금감원장, 금융지주 이사회에 “자회사 CEO 승계절차 투명해야”]]></title>
    <link><![CDATA[https://www.mk.co.kr/news/economy/12188202]]></link>
    <category><![CDATA[경제]]></category>
    <pubDate>Wed, 28 Oct 2026 10:52:05 +09:00</pubDate>
    <description><![CDATA[“어제 금투사서 해킹사고 발생 IT 보안 대응 역량 높여야” 주문]]></description>
  </item><item>
    <no>12188187</no>
    <title><![CDATA[끝없이 밀리는 수협은행장 인선에…“위원 전면 교체” 내건 노조]]></title>
    <link><![CDATA[https://www.mk.co.kr/news/economy/12188187]]></link>
    <category><![CDATA[경제]]></category>
    <pubDate>Wed, 28 Oct 2026 10:35:00 +09:00</pubDate>
    <description><![CDATA[임기 20일 남았지만 결론 못 나와 국감서도 행추위 구조 문제 지적돼]]></description>
  </item></channel></rss>`

  const FEEDS3 = ['yna-economy', 'hankyung-finance', 'mk-economy'].map(
    (id) => PRESS_RSS_FEEDS.find((f) => f.id === id)!,
  )

  it('레지스트리: 6개 피드(한국어 5개) + URL이 실측 통과 주소와 일치', () => {
    expect(PRESS_RSS_FEEDS.map((f) => f.id)).toEqual([
      'yna-all',
      'yna-economy',
      'yna-en',
      'hankyung-finance',
      'hankyung-economy',
      'mk-economy',
    ])
    expect(PRESS_RSS_KO_FEEDS.map((f) => f.id)).toEqual([
      'yna-all',
      'yna-economy',
      'hankyung-finance',
      'hankyung-economy',
      'mk-economy',
    ])
    const byId = new Map(PRESS_RSS_FEEDS.map((f) => [f.id, f.url]))
    expect(byId.get('yna-all')).toBe('https://www.yna.co.kr/rss/news.xml')
    expect(byId.get('yna-economy')).toBe('https://www.yna.co.kr/rss/economy.xml')
    expect(byId.get('yna-en')).toBe('https://en.yna.co.kr/RSS/news.xml')
    expect(byId.get('hankyung-finance')).toBe('https://www.hankyung.com/feed/finance')
    expect(byId.get('hankyung-economy')).toBe('https://www.hankyung.com/feed/economy')
    expect(byId.get('mk-economy')).toBe('https://www.mk.co.kr/rss/30100041/')
  })

  it('pressQueryTokens: 일반 질의·날짜 토큰은 비우고 주제 토큰만 남긴다', () => {
    expect(pressQueryTokens('오늘 주요 뉴스')).toEqual([])
    expect(pressQueryTokens('2026년 10월 26일 한국 주요 뉴스')).toEqual([])
    expect(pressQueryTokens('2026-10-26 삼성전자 실적')).toEqual(['삼성전자', '실적'])
    expect(pressQueryTokens('삼성전자 실적 뉴스')).toEqual(['삼성전자', '실적'])
    expect(pressQueryTokens('[SEARCH: 국고채 금리]')).toEqual(['국고채', '금리'])
    expect(pressQueryTokens('경제 뉴스')).toEqual([])
    expect(pressQueryTokens('국고채 국고채 금리')).toEqual(['국고채', '금리'])
  })

  it('parseRssItems: 실제 3사 피드 발췌를 파싱한다 (CDATA 링크·+09:00 콜론 오프셋 포함)', () => {
    const yna = parseRssItems(YNA_ECONOMY)
    expect(yna).toHaveLength(3)
    expect(yna[0]).toEqual({
      title: '국고채 금리 일제히 상승…3년물 장중 연 3.792%',
      url: 'https://www.yna.co.kr/view/AKR20261028096400008',
      publishedDate: '2026-10-28T03:04:28.000Z',
    })
    expect(yna[1].publishedDate).toBe('2026-10-28T03:00:10.000Z')
    const hk = parseRssItems(HANKYUNG_FINANCE)
    expect(hk).toHaveLength(3)
    expect(hk[0].url).toBe('https://www.hankyung.com/article/202610280276i')
    expect(hk[0].publishedDate).toBe('2026-10-28T02:37:22.000Z')
    const mk = parseRssItems(MK_ECONOMY)
    expect(mk).toHaveLength(3)
    expect(mk[0].title).toBe('[단독] 韓, 블룸버그채권지수 선진국 승격 추진')
    expect(mk[0].url).toBe('https://www.mk.co.kr/news/economy/12188232')
    // 매경 pubDate는 +09:00 콜론 표기 — Date.parse가 읽어야 한다
    expect(mk[0].publishedDate).toBe('2026-10-28T02:18:04.000Z')
    // 별칭도 같은 파서다
    expect(parseGoogleNewsRss(MK_ECONOMY)).toEqual(mk)
  })

  it('일반 질의면 3사 헤드라인을 합치고 브라우저 UA를 보낸다 (MSW)', async () => {
    const seenUa: string[] = []
    server.use(
      http.get('https://www.yna.co.kr/rss/economy.xml', ({ request }) => {
        seenUa.push(String(request.headers.get('User-Agent')))
        return HttpResponse.text(YNA_ECONOMY)
      }),
      http.get('https://www.hankyung.com/feed/finance', ({ request }) => {
        seenUa.push(String(request.headers.get('User-Agent')))
        return HttpResponse.text(HANKYUNG_FINANCE)
      }),
      http.get('https://www.mk.co.kr/rss/30100041/', ({ request }) => {
        seenUa.push(String(request.headers.get('User-Agent')))
        return HttpResponse.text(MK_ECONOMY)
      }),
    )
    const out = await fetchPressRssHeadlines('오늘 주요 뉴스', undefined, undefined, FEEDS3)
    expect(out).toHaveLength(9)
    expect(out.map((r) => r.url)).toEqual([
      'https://www.yna.co.kr/view/AKR20261028096400008',
      'https://www.yna.co.kr/view/AKR20261028066300002',
      'https://www.yna.co.kr/view/AKR20261028071500530',
      'https://www.hankyung.com/article/202610280276i',
      'https://www.hankyung.com/article/202610280125i',
      'https://www.hankyung.com/article/202610289683i',
      'https://www.mk.co.kr/news/economy/12188232',
      'https://www.mk.co.kr/news/economy/12188202',
      'https://www.mk.co.kr/news/economy/12188187',
    ])
    // UA 없으면 한경·매경이 Worker egress에서 403 — 헤더가 성질이다
    expect(seenUa).toHaveLength(3)
    expect(seenUa.every((ua) => /^Mozilla\/5\.0/.test(ua))).toBe(true)
  })

  it('주제 질의면 제목에 토큰이 들어간 항목만 남긴다', async () => {
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes('yna.co.kr')) return okText(YNA_ECONOMY)
      if (url.includes('hankyung.com')) return okText(HANKYUNG_FINANCE)
      if (url.includes('mk.co.kr')) return okText(MK_ECONOMY)
      throw new Error('unexpected ' + url)
    })
    const out = await fetchPressRssHeadlines('국고채 금리', fetchFn as any, undefined, FEEDS3)
    expect(out.map((r) => r.title)).toEqual(['국고채 금리 일제히 상승…3년물 장중 연 3.792%'])
    // 토큰이 하나도 안 맞는 질의면 빈 배열 (무관한 헤드라인이 체인을 채우지 않음)
    expect(await fetchPressRssHeadlines('화성 탐사선 발사', fetchFn as any, undefined, FEEDS3)).toEqual([])
  })

  it('피드 하나가 403이어도 나머지 피드 결과는 유지한다 (부분 실패 허용)', async () => {
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes('yna.co.kr')) return okText(YNA_ECONOMY)
      if (url.includes('hankyung.com')) return { ok: false, status: 403 } as unknown as Response
      if (url.includes('mk.co.kr')) return okText(MK_ECONOMY)
      throw new Error('unexpected ' + url)
    })
    const out = await fetchPressRssHeadlines('오늘 주요 뉴스', fetchFn as any, undefined, FEEDS3)
    expect(out).toHaveLength(6)
    expect(out.every((r) => !r.url.includes('hankyung.com'))).toBe(true)
  })

  it('피드는 살아 있으나 항목이 0건이면 빈 배열 (실패가 아님)', async () => {
    const fetchFn = jest.fn(async () =>
      okText('<rss version="2.0"><channel></channel></rss>'),
    )
    const out = await fetchPressRssHeadlines('오늘 주요 뉴스', fetchFn as any, undefined, FEEDS3)
    expect(out).toEqual([])
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('피드 전부가 실패하면 throw (체인이 ok:false로 기록)', async () => {
    const fetchFn = jest.fn(async () => ({ ok: false, status: 403 }) as unknown as Response)
    await expect(
      fetchPressRssHeadlines('오늘 주요 뉴스', fetchFn as any, undefined, FEEDS3),
    ).rejects.toThrow('언론사 RSS 전부 실패')
  })

  it('중복 URL은 피드 간에도 한 번만 남긴다', async () => {
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes('yna.co.kr')) return okText(YNA_ECONOMY)
      if (url.includes('hankyung.com')) return okText(
        `<rss><channel><item><title>국고채 금리 일제히 상승…3년물 장중 연 3.792%</title><link>https://www.yna.co.kr/view/AKR20261028096400008</link><pubDate>Wed, 28 Oct 2026 12:04:28 +0900</pubDate></item></channel></rss>`,
      )
      return okText(MK_ECONOMY)
    })
    const out = await fetchPressRssHeadlines('오늘 주요 뉴스', fetchFn as any, undefined, FEEDS3)
    const dupes = out.filter((r) => r.url === 'https://www.yna.co.kr/view/AKR20261028096400008')
    expect(dupes).toHaveLength(1)
    expect(out).toHaveLength(6)
  })
})

describe('searchTavilyNews', () => {
  it('키가 없으면 fetch 없이 빈 배열', async () => {
    const fetchFn = jest.fn()
    expect(await searchTavilyNews({}, 'q', fetchFn as any)).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('topic news + time_range day + advanced + published_date 매핑', async () => {
    const fetchFn: jest.Mock = jest.fn(async () => okJson({
      results: [
        { title: '글로벌 뉴스', url: 'https://example.com/t1', published_date: TODAY_ISO },
        { title: '날짜 없음', url: 'https://example.com/t2' },
      ],
    }))
    const out = await searchTavilyNews({ TAVILY_API_KEY: 'tv' }, 'news', fetchFn as any)
    const [url, init] = fetchFn.mock.calls[0]
    expect(String(url)).toContain('api.tavily.com/search')
    const body = JSON.parse(String(init.body))
    expect(body.topic).toBe('news')
    expect(body.time_range).toBe('day')
    expect(body.search_depth).toBe('advanced')
    expect(body.max_results).toBe(10)
    expect(body.api_key).toBe('tv')
    expect(out[0].publishedDate).toBe('2026-10-26T00:00:00.000Z')
    expect(out[1].publishedDate).toBeUndefined()
  })

  it('!ok면 throw', async () => {
    const fetchFn = jest.fn(async () => ({ ok: false, status: 429 }) as unknown as Response)
    await expect(searchTavilyNews({ TAVILY_API_KEY: 'tv' }, 'q', fetchFn as any)).rejects.toThrow('Tavily 429')
  })
})

describe('searchExaNews', () => {
  it('키가 없으면 fetch 없이 빈 배열', async () => {
    const fetchFn = jest.fn()
    expect(await searchExaNews({}, 'q', NOW, fetchFn as any)).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('날짜 포함 질의 + 1~2일 창 + userLocation KR + numResults 10 (폐기 파라미터 없음) (MSW: 실제 호출 형태 검증)', async () => {
    // fetchFn을 주입하지 않는다 — 기본 전역 fetch가 MSW 핸들러로 간다.
    server.use(
      http.post('https://api.exa.ai/search', async ({ request }) => {
        const body = (await request.json()) as any
        expect(body.query).toBe('2026년 10월 26일 오늘 한국 주요 뉴스')
        expect(body.category).toBe('news')
        expect(body.startPublishedDate).toBe('2026-10-25')
        expect(body.endPublishedDate).toBe('2026-10-26')
        expect(body.userLocation).toBe('KR')
        expect(body.numResults).toBe(10)
        // 폐기 파라미터 미사용
        expect(body.type).toBeUndefined()
        expect(body.useAutoprompt).toBeUndefined()
        expect(body.livecrawl).toBeUndefined()
        expect(body.includeText).toBeUndefined()
        return HttpResponse.json({
          results: [
            { title: '뉴스', url: 'https://example.com/e1', highlights: ['h1', 'h2', 'h3'], publishedDate: TODAY_ISO },
            { title: '날짜 없음', url: 'https://example.com/e2' },
          ],
          warnings: [{ field: 'includeText', reason: 'IGNORED_FIELD' }],
        })
      }),
    )
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const out = await searchExaNews({ EXA_API_KEY: 'ex' }, '오늘 한국 주요 뉴스', NOW)
    expect(out).toHaveLength(2)
    expect(out[0].highlights).toEqual(['h1', 'h2'])
    // 진단 로그: warnings + publishedDate + 질의(80자)
    const exaLog = logSpy.mock.calls.find((c) => c[0] === '[news-exa]')
    expect(exaLog).toBeDefined()
    const logged = JSON.parse(String(exaLog![1]))
    expect(logged.warnings).toEqual([{ field: 'includeText', reason: 'IGNORED_FIELD' }])
    expect(logged.publishedDates).toEqual([TODAY_ISO, null])
    expect(logged.q).toBe('2026년 10월 26일 오늘 한국 주요 뉴스')
  })

  it('!ok면 throw', async () => {
    const fetchFn = jest.fn(async () => ({ ok: false, status: 401 }) as unknown as Response)
    await expect(searchExaNews({ EXA_API_KEY: 'ex' }, 'q', NOW, fetchFn as any)).rejects.toThrow('Exa 401')
  })

  it('비http URL 결과는 최종 제외한다 (감사 §4 #5 — 최종 .filter 뮤턴트)', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const fetchFn = jest.fn(async () => okJson({
        results: [
          { title: 'ftp', url: 'ftp://example.com/a', publishedDate: TODAY_ISO },
          { title: '상대경로', url: '/news/1', publishedDate: TODAY_ISO },
          { title: '정상', url: 'https://example.com/ok', publishedDate: TODAY_ISO },
        ],
      }))
      const out = await searchExaNews({ EXA_API_KEY: 'ex' }, 'q', NOW, fetchFn as any)
      expect(out.map((r) => r.title)).toEqual(['정상'])
      expect(out[0].url).toBe('https://example.com/ok')
    } finally {
      logSpy.mockRestore()
    }
  })

  it('Exa 결과 12건은 10건까지만 반환한다 (감사 §4 #6 — .slice(0, 10) 뮤턴트)', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const results = Array.from({ length: 12 }, (_, i) => ({
        title: `뉴스 ${i + 1}`,
        url: `https://example.com/e${i + 1}`,
        publishedDate: TODAY_ISO,
      }))
      const fetchFn = jest.fn(async () => okJson({ results }))
      const out = await searchExaNews({ EXA_API_KEY: 'ex' }, 'q', NOW, fetchFn as any)
      expect(out).toHaveLength(10)
      expect(out.map((r) => r.title)).toEqual(Array.from({ length: 10 }, (_, i) => `뉴스 ${i + 1}`))
    } finally {
      logSpy.mockRestore()
    }
  })
})

describe('fetchNewsSources — 체인', () => {
  /** URL별 라우팅 목 fetch */
  function routedFetch(handlers: Record<string, (url: string, init?: any) => Response | Promise<Response>>) {
    return jest.fn(async (url: string, init?: any) => {
      for (const [key, fn] of Object.entries(handlers)) {
        if (url.includes(key)) return fn(url, init)
      }
      throw new Error('unexpected ' + url)
    })
  }

  const rssXml = (items: string) => `<rss version="2.0"><channel>${items}</channel></rss>`
  const rssItem = (title: string, url: string, pubDate: string) =>
    `<item><title>${title}</title><link>${url}</link><pubDate>${pubDate}</pubDate></item>`

  it('네이버가 목표 수(5)를 채우면 나머지 소스를 부르지 않는다', async () => {
    const naverItems = Array.from({ length: 6 }, (_, i) => ({
      title: `네이버 ${i + 1}`,
      originallink: `https://example.com/n${i + 1}`,
      link: `https://example.com/n${i + 1}`,
      pubDate: 'Mon, 26 Oct 2026 09:00:00 +0900',
    }))
    const fetchFn = routedFetch({
      'naverapihub.apigw.ntruss.com': () => okJson({ items: naverItems }),
      'news.google.com': () => { throw new Error('불러선 안 됨') },
      'api.tavily.com': () => { throw new Error('불러선 안 됨') },
      'api.exa.ai': () => { throw new Error('불러선 안 됨') },
    })
    const r = await fetchNewsSources(
      { NAVER_CLIENT_ID: 'id', NAVER_CLIENT_SECRET: 's', TAVILY_API_KEY: 'tv', EXA_API_KEY: 'ex' },
      '한국 뉴스',
      { now: NOW, fetchFn: fetchFn as any },
    )
    expect(r.items).toHaveLength(NEWS_CHAIN_TARGET)
    expect(r.items.every((i) => i.source === 'naver')).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(r.statuses).toHaveLength(1)
    expect(r.statuses[0]).toMatchObject({ source: 'naver', ok: true, fetched: 6, kept: 5 })
    expect(r.window).toEqual({ startDate: '2026-10-25', endDate: '2026-10-26' })
  })

  it('네이버 빈약 → RSS 보강 → Tavily/Exa 순서로 누적, 창 밖·날짜 없음 제외', async () => {
    const fetchFn = routedFetch({
      'naverapihub.apigw.ntruss.com': () => okJson({ items: [
        { title: '네이버 신선', originallink: 'https://example.com/n1', link: 'https://example.com/n1', pubDate: 'Mon, 26 Oct 2026 09:00:00 +0900' },
        { title: '네이버 오래됨', originallink: 'https://example.com/nold', link: 'https://example.com/nold', pubDate: 'Mon, 19 Jan 2026 09:00:00 +0900' },
      ] }),
      // 언론사 직접 RSS는 이 테스트에서 빈 피드 (체인 순서·상태만 확인)
      'yna.co.kr': () => okText(rssXml('')),
      'hankyung.com': () => okText(rssXml('')),
      'mk.co.kr': () => okText(rssXml('')),
      'news.google.com': () => okText(rssXml(
        rssItem('RSS 신선', 'https://example.com/r1', 'Mon, 26 Oct 2026 09:00:00 GMT') +
        rssItem('RSS 날짜없음', 'https://example.com/r2', '') +
        rssItem('RSS 중복', 'https://example.com/n1', 'Mon, 26 Oct 2026 09:00:00 GMT'),
      )),
      'api.tavily.com': () => okJson({ results: [
        { title: 'Tavily 신선', url: 'https://example.com/t1', published_date: TODAY_ISO },
      ] }),
      'api.exa.ai': () => okJson({ results: [
        // Exa 신선 항목의 발행일은 자정 UTC가 아니어야 한다 — 자정 UTC는
        // Exa 단계에서 "날짜 미상"으로 제외됨 (2026-10-26 tail 로그 실측).
        // 09:00 KST 정각(= 자정 UTC)은 네이버·RSS·Tavily에만 허용된다.
        { title: 'Exa 신선', url: 'https://example.com/e1', publishedDate: '2026-10-26T10:30:00+09:00' },
        { title: 'Exa 오래됨', url: 'https://example.com/eold', publishedDate: OLD_ISO },
      ] }),
      // Exa 단계 기사 날짜 직접 검증용 fixture HTML (신선 — 메타 날짜 창 안)
      'example.com/e1': () => okText(
        '<html><head><meta property="article:published_time" content="2026-10-26T10:30:00+09:00"></head></html>',
      ),
    })
    const r = await fetchNewsSources(
      { NAVER_CLIENT_ID: 'id', NAVER_CLIENT_SECRET: 's', TAVILY_API_KEY: 'tv', EXA_API_KEY: 'ex' },
      '한국 뉴스',
      { now: NOW, fetchFn: fetchFn as any },
    )
    expect(r.items.map((i) => i.url)).toEqual([
      'https://example.com/n1',
      'https://example.com/r1',
      'https://example.com/t1',
      'https://example.com/e1',
    ])
    expect(r.items.map((i) => i.source)).toEqual(['naver', 'gnews-rss', 'tavily', 'exa'])
    // Exa 항목은 기사 날짜 직접 검증에서 publishedDate가 검증된 날짜로 교체된다
    expect(r.items[3].publishedDate).toBe('2026-10-26T01:30:00.000Z')
    expect(r.statuses.map((s) => [s.source, s.ok, s.fetched, s.kept])).toEqual([
      ['naver', true, 2, 1],
      ['press-rss', true, 0, 0],
      ['gnews-rss', true, 3, 1],
      ['tavily', true, 1, 1],
      ['exa', true, 2, 1],
    ])
  })

  it('press-rss: 일반 질의면 헤드라인 보강 + 기사 날짜 검증 통과분 유지, source=press-rss', async () => {
    // 창 2026-10-27~2026-10-28 (fixture pubDate 10-28과 맞춤)
    const NOW28 = new Date('2026-10-28T12:00:00Z')
    const articleHtml =
      '<html><head><meta property="article:published_time" content="2026-10-28T12:00:00+09:00"></head></html>'
    const fetchFn = routedFetch({
      'yna.co.kr/rss': () => okText(rssXml(
        rssItem('국고채 금리 상승', 'https://www.yna.co.kr/view/AKR20261028096400008', 'Wed, 28 Oct 2026 12:04:28 +0900') +
        rssItem('고용 투자 세무조사 면제', 'https://www.yna.co.kr/view/AKR20261028066300002', 'Wed, 28 Oct 2026 12:00:10 +0900'),
      )),
      'hankyung.com/feed': () => okText(rssXml(
        rssItem('셀레스티카 실적 호조', 'https://www.hankyung.com/article/202610280276i', 'Wed, 28 Oct 2026 11:37:22 +0900'),
      )),
      'mk.co.kr/rss': () => okText(rssXml(
        rssItem('블룸버그채권지수 승격 추진', 'https://www.mk.co.kr/news/economy/12188232', 'Wed, 28 Oct 2026 11:18:04 +09:00'),
      )),
      'news.google.com': () => okText(rssXml('')),
      // 기사 페이지 검증용 HTML (전부 창 안 날짜 — 검증된 날짜로 교체됨)
      'yna.co.kr/view': () => okText(articleHtml),
      'hankyung.com/article': () => okText(articleHtml),
      'mk.co.kr/news': () => okText(articleHtml),
    })
    const r = await fetchNewsSources({}, '오늘 주요 뉴스', { now: NOW28, fetchFn: fetchFn as any })
    // yna-all/yna-economy·hankyung-finance/economy가 같은 항목을 돌려줘도 dedupe로 4건
    expect(r.items.map((i) => i.url)).toEqual([
      'https://www.yna.co.kr/view/AKR20261028096400008',
      'https://www.yna.co.kr/view/AKR20261028066300002',
      'https://www.hankyung.com/article/202610280276i',
      'https://www.mk.co.kr/news/economy/12188232',
    ])
    expect(r.items.every((i) => i.source === 'press-rss')).toBe(true)
    // 기사 날짜 직접 검증이 RSS pubDate를 검증된 날짜로 교체한다
    expect(r.items.every((i) => i.publishedDate === '2026-10-28T03:00:00.000Z')).toBe(true)
    expect(r.statuses[1]).toMatchObject({ source: 'press-rss', ok: true, fetched: 4, kept: 4 })
  })

  it('press-rss: 기사 페이지 검증 실패분은 제외 (strict) + verifyDropped 기록', async () => {
    const NOW28 = new Date('2026-10-28T12:00:00Z')
    const articleHtml =
      '<html><head><meta property="article:published_time" content="2026-10-28T12:00:00+09:00"></head></html>'
    const fetchFn = routedFetch({
      'yna.co.kr/rss': () => okText(rssXml(
        rssItem('국고채 금리 상승', 'https://www.yna.co.kr/view/AKR20261028096400008', 'Wed, 28 Oct 2026 12:04:28 +0900'),
      )),
      'hankyung.com/feed': () => okText(rssXml(
        rssItem('셀레스티카 실적 호조', 'https://www.hankyung.com/article/202610280276i', 'Wed, 28 Oct 2026 11:37:22 +0900'),
      )),
      'mk.co.kr/rss': () => okText(rssXml(
        rssItem('블룸버그채권지수 승격 추진', 'https://www.mk.co.kr/news/economy/12188232', 'Wed, 28 Oct 2026 11:18:04 +09:00'),
      )),
      'news.google.com': () => okText(rssXml('')),
      // YNA 기사 페이지만 fetch 실패 → 해당 항목 제외
      'yna.co.kr/view': () => { throw new Error('article down') },
      'hankyung.com/article': () => okText(articleHtml),
      'mk.co.kr/news': () => okText(articleHtml),
    })
    const r = await fetchNewsSources({}, '오늘 주요 뉴스', { now: NOW28, fetchFn: fetchFn as any })
    expect(r.items.map((i) => i.url)).toEqual([
      'https://www.hankyung.com/article/202610280276i',
      'https://www.mk.co.kr/news/economy/12188232',
    ])
    expect(r.statuses[1]).toMatchObject({ source: 'press-rss', ok: true, fetched: 3, kept: 2, verifyDropped: 1 })
  })

  it('키 없는 소스는 skipped 상태로 기록하고 호출하지 않는다', async () => {
    const fetchFn = routedFetch({
      'yna.co.kr': () => okText(rssXml('')),
      'hankyung.com': () => okText(rssXml('')),
      'mk.co.kr': () => okText(rssXml('')),
      'news.google.com': () => okText(rssXml(rssItem('RSS 신선', 'https://example.com/r1', 'Mon, 26 Oct 2026 09:00:00 GMT'))),
    })
    const r = await fetchNewsSources({}, '한국 뉴스', { now: NOW, fetchFn: fetchFn as any })
    expect(r.items).toHaveLength(1)
    expect(r.statuses).toEqual([
      { source: 'naver', ok: true, skipped: true, fetched: 0, kept: 0 },
      { source: 'press-rss', ok: true, fetched: 0, kept: 0 },
      { source: 'gnews-rss', ok: true, fetched: 1, kept: 1 },
      { source: 'tavily', ok: true, skipped: true, fetched: 0, kept: 0 },
      { source: 'exa', ok: true, skipped: true, fetched: 0, kept: 0 },
    ])
  })

  it('소스 실패는 상태에 기록하고 다음 소스로 계속한다 (체인 자체는 던지지 않음)', async () => {
    const fetchFn = routedFetch({
      'naverapihub.apigw.ntruss.com': () => { throw new Error('naver down') },
      'yna.co.kr': () => okText(rssXml('')),
      'hankyung.com': () => okText(rssXml('')),
      'mk.co.kr': () => okText(rssXml('')),
      'news.google.com': () => { throw new Error('rss down') },
      'api.tavily.com': () => okJson({ results: [{ title: 'T', url: 'https://example.com/t1', published_date: TODAY_ISO }] }),
      'api.exa.ai': () => { throw new Error('불러선 안 됨 — 목표 도달') },
    })
    const r = await fetchNewsSources(
      { NAVER_CLIENT_ID: 'id', NAVER_CLIENT_SECRET: 's', TAVILY_API_KEY: 'tv', EXA_API_KEY: 'ex' },
      '한국 뉴스',
      { now: NOW, targetCount: 1, fetchFn: fetchFn as any },
    )
    expect(r.items).toHaveLength(1)
    expect(r.statuses[0]).toMatchObject({ source: 'naver', ok: false })
    expect(r.statuses[0].error).toContain('naver down')
    expect(r.statuses[1]).toMatchObject({ source: 'press-rss', ok: true, fetched: 0, kept: 0 })
    expect(r.statuses[2]).toMatchObject({ source: 'gnews-rss', ok: false })
    expect(r.statuses[3]).toMatchObject({ source: 'tavily', ok: true, kept: 1 })
    expect(r.statuses).toHaveLength(4)
  })

  it('전부 비면 items 빈 배열 + 진단 로그에 질의 80자까지만', async () => {
    const fetchFn = routedFetch({
      'yna.co.kr': () => okText(rssXml('')),
      'hankyung.com': () => okText(rssXml('')),
      'mk.co.kr': () => okText(rssXml('')),
      'news.google.com': () => okText(rssXml('')),
    })
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const longQuery = 'x'.repeat(200)
    const r = await fetchNewsSources({}, longQuery, { now: NOW, fetchFn: fetchFn as any })
    expect(r.items).toEqual([])
    const chainLog = logSpy.mock.calls.find((c) => c[0] === '[news-chain]')
    expect(chainLog).toBeDefined()
    const logged = JSON.parse(String(chainLog![1]))
    expect(logged.q).toHaveLength(80)
    expect(logged.total).toBe(0)
    expect(logged.statuses.map((s: any) => s.source)).toEqual(['naver', 'press-rss', 'gnews-rss', 'tavily', 'exa'])
  })

  it('tail 로그 회귀 (2026-10-26, /tmp/tail_news.log 체인 1): RSS 503 + Exa 가짜 날짜 5건', async () => {
    // 라이브에서 실제로 돌았던 질의·결과를 그대로 재현한다 (fixture).
    // 마커 질의: "[SEARCH: 2025년 1월 22일 한국 주요 뉴스]"
    // Exa publishedDates는 [news-exa] 로그의 10건 중 유지된 앞 5건 순서대로.
    let exaBody: any = null
    const fetchFn = routedFetch({
      'yna.co.kr': () => okText(rssXml('')),
      'hankyung.com': () => okText(rssXml('')),
      'mk.co.kr': () => okText(rssXml('')),
      'news.google.com': () => ({ ok: false, status: 503 }) as unknown as Response,
      'api.exa.ai': (_url: string, init?: any) => {
        exaBody = JSON.parse(String(init?.body || '{}'))
        return okJson({ results: [
          { title: 'Paspampres Korsel Bantah Gunakan Peluru Tajam', url: 'https://www.katakini.com/artikel/118442/paspampres-korsel-bantah-gunakan-peluru-tajam/', publishedDate: '2026-10-25T00:00:00.000Z' },
          { title: 'BBC Learning English', url: 'https://meleleh.pages.dev/learningenglish/thai/features/learning-english-from-the-news_2025/250108', publishedDate: '2026-10-25T00:00:00.000Z' },
          { title: '완도군 전복 양식 어가', url: 'https://kffnews.com/News/Section/articleView/4157', publishedDate: '2026-10-26T00:00:00.000Z' },
          { title: '韓國總統尹錫悅彈劾案', url: 'https://bbcbreakingnews.pages.dev/zhongwen/articles/cm2ny3gvmd1o/trad', publishedDate: '2026-10-25T21:23:30.000Z' },
          { title: '많이본뉴스 전국 - 아시아경제', url: 'https://www.asiae.co.kr/ranking/nationwide/20260622/20250720', publishedDate: '2026-10-25T00:00:00.000Z' },
        ] })
      },
      // 잔존 간극 fixture의 기사 페이지 (HTML 메타 날짜가 진짜 날짜 — 2025-01-19 서부지법 습격):
      // Exa publishedDate는 가짜(2026-10-25T21:23:30)이지만 페이지 JSON-LD는 오래된 날짜를 가리킨다.
      'bbcbreakingnews.pages.dev': () => okText(
        '<html><head><script type="application/ld+json">{"@type": "NewsArticle", "datePublished": "2025-01-19T12:00:00+09:00"}</script></head></html>',
      ),
    })
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const r = await fetchNewsSources(
      { EXA_API_KEY: 'ex' },
      '2025년 1월 22일 한국 주요 뉴스',
      { now: NOW, fetchFn: fetchFn as any },
    )
    // B: 마커의 잘못된 날짜가 Exa 질의에 가지 않는다 — 오늘 날짜로 교체됨
    expect(exaBody.query).toBe('2026년 10월 26일 한국 주요 뉴스')
    expect(exaBody.query).not.toContain('2025')
    // C: RSS 503은 상태에 기록되고 (조용히 넘기지 않음) 체인은 Exa로 계속 간다
    expect(r.statuses).toEqual([
      { source: 'naver', ok: true, skipped: true, fetched: 0, kept: 0 },
      { source: 'press-rss', ok: true, fetched: 0, kept: 0 },
      { source: 'gnews-rss', ok: false, fetched: 0, kept: 0, error: 'Google News RSS 503' },
      { source: 'tavily', ok: true, skipped: true, fetched: 0, kept: 0 },
      { source: 'exa', ok: true, fetched: 5, kept: 0, verifyDropped: 1 },
    ])
    // A+E: katakini·meleleh·kffnews·asiae 제외 (자정 규칙 + URL 날짜 가드).
    // 잔존 간극 CLOSED (2026-10-26 트랙 A2): bbcbreakingnews도 기사 날짜 직접
    // 검증에서 제외된다 — Exa publishedDate는 가짜(2026-10-25T21:23:30)지만
    // 페이지 JSON-LD datePublished가 2025-01-19라 창 밖으로 판정된다.
    // 이전에는 신호만으로 구분이 안 돼 남았으나 (KNOWN RESIDUAL GAP),
    // 이제 페이지 직접 fetch가 간극을 닫는다.
    expect(r.items).toEqual([])
    const chainLog = logSpy.mock.calls.find((c) => c[0] === '[news-chain]')
    const logged = JSON.parse(String(chainLog![1]))
    expect(logged.verify).toEqual({ checked: 1, kept: 0, dropped: 1 })
    expect(logged.q).toBe('2026년 10월 26일 한국 주요 뉴스')
    expect(logged.q).not.toContain('2025')
  })

  it('Exa 검증: 기사 fetch 실패 시 제외 (strict), verifyArticles:false면 유지', async () => {
    const freshExa = () =>
      okJson({
        results: [
          { title: 'Exa 신선', url: 'https://example.com/e1', publishedDate: '2026-10-26T10:30:00+09:00' },
        ],
      })
    const fetchFn = routedFetch({
      'yna.co.kr': () => okText(rssXml('')),
      'hankyung.com': () => okText(rssXml('')),
      'mk.co.kr': () => okText(rssXml('')),
      'news.google.com': () => okText(rssXml('')),
      'api.exa.ai': freshExa,
      'example.com/e1': () => {
        throw new Error('article down')
      },
    })
    // fetch 실패 → 검증 불가 → 제외 (실패를 "신선함"으로 간주 금지)
    const r1 = await fetchNewsSources({ EXA_API_KEY: 'ex' }, '한국 뉴스', {
      now: NOW,
      fetchFn: fetchFn as any,
    })
    expect(r1.items).toEqual([])
    expect(r1.statuses[4]).toMatchObject({ source: 'exa', ok: true, fetched: 1, kept: 0, verifyDropped: 1 })
    // opt-out → 검증 없이 유지 (기존 동작)
    const r2 = await fetchNewsSources({ EXA_API_KEY: 'ex' }, '한국 뉴스', {
      now: NOW,
      fetchFn: fetchFn as any,
      verifyArticles: false,
    })
    expect(r2.items.map((i) => i.url)).toEqual(['https://example.com/e1'])
    expect(r2.statuses[4]).toMatchObject({ source: 'exa', ok: true, fetched: 1, kept: 1 })
  })

  it('체인 전체 deadline: RSS hang → 예산 안에 반환, 이미 모은 항목 유지 + 정직한 상태', async () => {
    const fetchFn = routedFetch({
      'naverapihub.apigw.ntruss.com': () =>
        okJson({
          items: [
            { title: '네이버 신선', originallink: 'https://example.com/n1', link: 'https://example.com/n1', pubDate: 'Mon, 26 Oct 2026 09:00:00 +0900' },
          ],
        }),
      // signal을 무시하고 절대 끝나지 않는 hang (구 15초 타임아웃이면 여기서 15초 소진)
      'news.google.com': () => new Promise<Response>(() => {}),
      'api.tavily.com': () => {
        throw new Error('불러선 안 됨 — deadline 초과')
      },
      'api.exa.ai': () => {
        throw new Error('불러선 안 됨 — deadline 초과')
      },
    })
    const start = Date.now()
    const r = await fetchNewsSources(
      { NAVER_CLIENT_ID: 'id', NAVER_CLIENT_SECRET: 's', TAVILY_API_KEY: 'tv', EXA_API_KEY: 'ex' },
      '한국 뉴스',
      { now: NOW, fetchFn: fetchFn as any, totalTimeoutMs: 300 },
    )
    expect(Date.now() - start).toBeLessThan(3000)
    expect(r.items.map((i) => i.url)).toEqual(['https://example.com/n1'])
    expect(r.timedOut).toBe(true)
    expect(r.statuses).toEqual([
      { source: 'naver', ok: true, fetched: 1, kept: 1 },
      expect.objectContaining({ source: 'press-rss', ok: false, fetched: 0, kept: 0 }),
      { source: 'gnews-rss', ok: false, fetched: 0, kept: 0, error: 'news leg timeout: gnews-rss' },
      { source: 'tavily', ok: false, fetched: 0, kept: 0, error: 'chain deadline exceeded' },
      { source: 'exa', ok: false, fetched: 0, kept: 0, error: 'chain deadline exceeded' },
    ])
    // press-rss는 라우팅 목에 핸들러가 없어 5개 피드 전부 즉시 실패 → 전부 실패 throw
    expect(String(r.statuses[1].error)).toContain('언론사 RSS 전부 실패')
  })

  it('websearch 502 회귀: 전 레그 hang → 주입 예산 안에 빈 결과 + timedOut (30초 edge 초과 방지)', async () => {
    // 구 코드면 레그별 15초씩 순차 실행돼 30초를 넘기고 502가 났다.
    const fetchFn = jest.fn(async () => new Promise<Response>(() => {}))
    const start = Date.now()
    const r = await fetchNewsSources({ EXA_API_KEY: 'ex' }, '오늘 뉴스', {
      now: NOW,
      fetchFn: fetchFn as any,
      totalTimeoutMs: 400,
    })
    expect(Date.now() - start).toBeLessThan(3000)
    expect(r.items).toEqual([])
    expect(r.timedOut).toBe(true)
    expect(r.statuses).toEqual([
      { source: 'naver', ok: true, skipped: true, fetched: 0, kept: 0 },
      { source: 'press-rss', ok: false, fetched: 0, kept: 0, error: 'news leg timeout: press-rss' },
      { source: 'gnews-rss', ok: false, fetched: 0, kept: 0, error: 'chain deadline exceeded' },
      { source: 'tavily', ok: false, fetched: 0, kept: 0, error: 'chain deadline exceeded' },
      { source: 'exa', ok: false, fetched: 0, kept: 0, error: 'chain deadline exceeded' },
    ])
  })
})
