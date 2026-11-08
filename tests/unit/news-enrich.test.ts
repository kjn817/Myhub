/// <reference types="jest" />
/**
 * src/services/news-enrich.ts — 기사 본문 추출·근거 확보 성질 테스트.
 *
 * 핵심 성질: ① 본문 근거는 JSON-LD > 문단 > og 설명 순으로 찾고,
 * 짧은 문단·상용구(무단 전재 등)·중복 문단은 근거로 세지 않는다
 * ② 본문이 없으면 하이라이트가 있는 기사만 근거로 남고, 둘 다 없으면
 * 클러스터를 버리되 "요청 도달로 시작조차 안 한 클러스터"는 탈락으로
 * 세지 않는다 ③ 교차 참조는 발행처 기준 중복을 제거하고 3개로 제한한다
 * ④ http(s)가 아닌 URL과 실패한 fetch는 본문 없음으로 fail-soft 한다.
 * 카나리아: 상용구 필터(isBoilerplateParagraph)를 지우거나
 * enrichCluster의 대표 탐색을 첫 멤버 고정으로 바꾸면 실패한다.
 */
import {
  enrichNewsItems,
  extractArticleBodyText,
  fetchArticleBodyText,
  type NewsEnrichCandidate,
} from '../../src/services/news-enrich'
import { NEWS_BODY_MAX_CHARS } from '../../src/lib/news-answer'

const P1 = '오늘 서울에서는 새로운 교통 정책이 발표되어 많은 시민들의 관심을 모았다고 시가 밝혔습니다.'
const P2 = '이번 정책은 대중교통 이용을 늘리고 도심 혼잡을 줄이기 위한 것으로 다음 달부터 단계적으로 시행됩니다.'
const P3 = '전문가들은 정책 효과를 지켜봐야 한다면서도 방향성 자체는 긍정적으로 평가하고 있다고 전했습니다.'
const BODY_HTML = `<html><head><title>t</title></head><body><p>${P1}</p><p>${P2}</p><p>${P3}</p></body></html>`

describe('extractArticleBodyText — JSON-LD 우선', () => {
  test('articleBody가 충분히 길면 그것을 본문으로 쓴다', () => {
    const body = `${P1} ${P2} ${P3}`
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', articleBody: body })}</script></head><body><p>짧음</p></body></html>`
    expect(extractArticleBodyText(html)).toBe(body)
  })

  test('@graph·배열에 중첩된 articleBody도 찾는다', () => {
    const body = `${P1} ${P2} ${P3}`
    const ld = { '@graph': [{ '@type': 'WebPage' }, { '@type': 'NewsArticle', articleBody: body }] }
    const html = `<script type="application/ld+json">${JSON.stringify(ld)}</script>`
    expect(extractArticleBodyText(html)).toBe(body)
  })

  test('JSON 파싱이 깨져도 articleBody 문자열을 정규식으로 건져 이스케이프를 푼다', () => {
    const inner = `{"@type":"NewsArticle","articleBody": "그는 \\"합의\\" 라고 말했습니다. ${P1} ${P2}", 깨진꼬리`
    const html = `<script type="application/ld+json">${inner}</script>`
    const out = extractArticleBodyText(html)
    expect(out).toContain('그는 "합의" 라고 말했습니다')
    expect(out).toContain('교통 정책')
  })

  test('articleBody가 최소 길이보다 짧으면 문단 경로로 넘어간다', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ articleBody: '짧은 본문' })}</script><body>${BODY_HTML}</body>`
    const out = extractArticleBodyText(html)
    expect(out).toContain('교통 정책')
    expect(out).not.toBe('짧은 본문')
  })

  test('articleBody 안의 HTML 태그는 텍스트로 펴진다', () => {
    const body = `${P1} <b>강조</b> ${P2} ${P3}`
    const html = `<script type="application/ld+json">${JSON.stringify({ articleBody: body })}</script>`
    expect(extractArticleBodyText(html)).toBe(`${P1} 강조 ${P2} ${P3}`)
  })
})

describe('extractArticleBodyText — 문단 경로와 필터', () => {
  test('빈 입력·본문 없는 HTML은 undefined', () => {
    expect(extractArticleBodyText('')).toBeUndefined()
    expect(extractArticleBodyText('<html><body><div>본문 아님</div></body></html>')).toBeUndefined()
  })

  test('짧은 문단·상용구·중복 문단은 근거에서 제외된다', () => {
    const boiler = '이 기사는 저작권법의 보호를 받으며 무단 전재 및 재배포를 금지합니다. 이를 어길 시 법적 책임을 물을 수 있습니다.'
    const html = `<body>
      <p>짧은 문단</p>
      <p>${boiler}</p>
      <p>${P1}</p><p>${P1}</p><p>${P2}</p><p>${P3}</p>
    </body>`
    const out = extractArticleBodyText(html) as string
    expect(out).toContain('교통 정책')
    expect(out).not.toContain('무단 전재')
    // 중복 문단은 한 번만
    expect(out.split('교통 정책').length - 1).toBe(1)
  })

  test('script·style·주석 안의 문단은 본문으로 세지 않는다', () => {
    const html = `<body>
      <script>var x = "<p>${P1}</p>";</script>
      <style>.a::after { content: "<p>${P2}</p>"; }</style>
      <!-- <p>${P3}</p> -->
    </body>`
    expect(extractArticleBodyText(html)).toBeUndefined()
  })

  test('HTML 엔티티를 디코딩한다', () => {
    const html = `<body><p>그는 &quot;동의&quot; &amp; &#39;수용&#39; 의사를 밝혔으며&nbsp;${P1} ${P2}</p></body>`
    const out = extractArticleBodyText(html) as string
    expect(out).toContain('그는 "동의" & \'수용\' 의사를 밝혔으며')
  })

  test('숫자 엔티티 범위를 벗어난 코드포인트는 공백으로 바꾼다', () => {
    const html = `<body><p>기호&#1114112;뒤 ${P1} ${P2} ${P3}</p></body>`
    const out = extractArticleBodyText(html) as string
    expect(out).toContain('기호 뒤')
  })

  test('문단이 최소 길이에 못 미치면 og:description으로 폴백한다', () => {
    const og = '이것은 오픈그래프 설명으로 문단 본문이 부족할 때 근거로 쓰이는 충분히 긴 설명 문장이며 독자에게 맥락을 제공합니다.'
    expect(og.length).toBeGreaterThanOrEqual(60)
    const html = `<html><head><meta property="og:description" content="${og}"></head><body><p>${P1}</p></body></html>`
    expect(extractArticleBodyText(html)).toBe(og)
  })

  test('og가 없으면 name=description 메타를 쓴다', () => {
    const desc = '메타 설명 태그에 들어 있는 충분히 긴 대체 본문으로 최소 길이를 넘는 문장입니다. 추가 문장과 보충 설명을 더합니다.'
    const html = `<html><head><meta name="description" content="${desc}"></head><body></body></html>`
    expect(extractArticleBodyText(html)).toBe(desc)
  })

  test('og 설명도 최소 길이보다 짧으면 근거 없음', () => {
    const html = `<html><head><meta property="og:description" content="짧은 설명"></head><body></body></html>`
    expect(extractArticleBodyText(html)).toBeUndefined()
  })
})

describe('extractArticleBodyText — 본문 절단(capBody)', () => {
  test('상한을 넘는 본문은 문장 경계(60% 지점 이후)에서 자른다', () => {
    const head = '가'.repeat(800)
    const tail = '나'.repeat(900)
    const out = extractArticleBodyText(`<body><p>${head}다. ${tail}</p></body>`) as string
    expect(out.length).toBe(802)
    expect(out.endsWith('다.')).toBe(true)
  })

  test('문장 경계가 없으면 상한에서 그대로 자른다', () => {
    const out = extractArticleBodyText(`<body><p>${'가'.repeat(2000)}</p></body>`) as string
    expect(out.length).toBe(NEWS_BODY_MAX_CHARS)
  })

  test('공백+개행은 개행으로 정리된다', () => {
    const html = `<body><p>${P1}   \n${P2} ${P3}</p></body>`
    const out = extractArticleBodyText(html) as string
    expect(out).not.toContain('   \n')
  })
})

describe('fetchArticleBodyText', () => {
  test('http(s)가 아닌 URL은 fetch 없이 undefined', async () => {
    let called = false
    const fn = async () => { called = true; return { ok: true, text: async () => BODY_HTML } as Response }
    await expect(fetchArticleBodyText('ftp://example.com/a', fn as any)).resolves.toBeUndefined()
    await expect(fetchArticleBodyText('', fn as any)).resolves.toBeUndefined()
    expect(called).toBe(false)
  })

  test('비정상 응답·네트워크 오류는 undefined로 fail-soft', async () => {
    const notOk = async () => ({ ok: false, text: async () => '' }) as unknown as Response
    await expect(fetchArticleBodyText('https://a.com/1', notOk as any)).resolves.toBeUndefined()
    const boom = async () => { throw new Error('net') }
    await expect(fetchArticleBodyText('https://a.com/1', boom as any)).resolves.toBeUndefined()
  })

  test('정상 응답에서는 본문을 추출하고 브라우저 헤더를 보낸다', async () => {
    let seenInit: any
    const fn = async (_url: string, init: any) => {
      seenInit = init
      return { ok: true, text: async () => BODY_HTML } as unknown as Response
    }
    const out = await fetchArticleBodyText('https://a.com/1', fn as any)
    expect(out).toContain('교통 정책')
    expect(seenInit.headers['User-Agent']).toContain('Mozilla')
    expect(seenInit.headers.Accept).toContain('text/html')
  })

  test('응답이 타임아웃을 넘기면 undefined (데드라인)', async () => {
    const hang = () => new Promise<Response>(() => {})
    await expect(fetchArticleBodyText('https://a.com/slow', hang as any, 10)).resolves.toBeUndefined()
  })
})

describe('enrichNewsItems', () => {
  let logSpy: jest.SpyInstance
  beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}) })
  afterEach(() => logSpy.mockRestore())

  function fetchStub(map: Record<string, 'fail' | 'throw' | string>) {
    const calls: string[] = []
    const fn = async (url: string) => {
      calls.push(url)
      const entry = map[url]
      if (entry === undefined || entry === 'throw') throw new Error('net fail')
      if (entry === 'fail') return { ok: false, text: async () => '' }
      return { ok: true, text: async () => entry }
    }
    return { fn: fn as any, calls }
  }

  const cand = (over: Partial<NewsEnrichCandidate>): NewsEnrichCandidate => ({
    title: '서울시 새 교통 정책 발표',
    url: 'https://a.com/1',
    ...over,
  })

  test('빈 후보는 빈 결과', async () => {
    const { fn } = fetchStub({})
    const r = await enrichNewsItems([], { fetchFn: fn, requestedCount: 3 })
    expect(r).toMatchObject({ items: [], candidateCount: 0, clusterCount: 0, droppedUngrounded: 0, bodyOk: 0, bodyFailed: 0 })
  })

  test('본문을 얻은 멤버가 대표가 되고 나머지 발행처는 교차 참조가 된다', async () => {
    const { fn } = fetchStub({
      'https://a.com/1': 'fail',
      'https://b.com/2': BODY_HTML,
      'https://c.com/3': 'fail',
    })
    const members = [
      cand({ url: 'https://a.com/1', publisher: '연합뉴스' }),
      cand({ url: 'https://b.com/2', publisher: '조선일보', publishedDate: '2026-11-08T01:00:00.000Z' }),
      cand({ url: 'https://c.com/3', publisher: '한겨레' }),
    ]
    const r = await enrichNewsItems(members, { fetchFn: fn, requestedCount: 3 })
    expect(r.candidateCount).toBe(3)
    expect(r.clusterCount).toBe(1)
    expect(r.bodyOk).toBe(1)
    expect(r.bodyFailed).toBe(1) // 대표가 정해지면 나머지 멤버는 시도하지 않는다
    expect(r.items).toHaveLength(1)
    const item = r.items[0]
    expect(item.url).toBe('https://b.com/2')
    expect(item.publisher).toBe('조선일보')
    expect(item.groundedBy).toBe('body')
    expect(item.bodyText).toContain('교통 정책')
    expect(item.publishedKst).toContain('11월 8일')
    expect(item.crossRefs.map((x) => x.publisher)).toEqual(['연합뉴스', '한겨레'])
  })

  test('본문이 전부 실패하면 하이라이트 보유 멤버가 근거가 된다 (2개로 제한)', async () => {
    const { fn } = fetchStub({ 'https://a.com/1': 'fail', 'https://b.com/2': 'throw' })
    const members = [
      cand({ url: 'https://a.com/1', publisher: '연합뉴스' }),
      cand({ url: 'https://b.com/2', publisher: '한겨레', highlights: ['핵심1', '핵심2', '핵심3'] }),
    ]
    const r = await enrichNewsItems(members, { fetchFn: fn, requestedCount: 3 })
    expect(r.bodyFailed).toBe(2)
    expect(r.items).toHaveLength(1)
    expect(r.items[0].groundedBy).toBe('highlights')
    expect(r.items[0].highlights).toEqual(['핵심1', '핵심2'])
    expect(r.items[0].bodyText).toBeUndefined()
  })

  test('본문도 하이라이트도 없으면 클러스터를 버리고 droppedUngrounded로 센다', async () => {
    const { fn } = fetchStub({ 'https://a.com/1': 'fail' })
    const r = await enrichNewsItems([cand({})], { fetchFn: fn, requestedCount: 3 })
    expect(r.items).toEqual([])
    expect(r.droppedUngrounded).toBe(1)
  })

  test('교차 참조는 발행처 중복을 제거하고 최대 3개', async () => {
    const urls = ['https://a.com/1', 'https://b.com/2', 'https://c.com/3', 'https://d.com/4', 'https://e.com/5', 'https://f.com/6']
    const pubs = ['대표사', '대표사', '둘째사', '셋째사', '넷째사', '다섯째사']
    const map: Record<string, string> = { 'https://a.com/1': BODY_HTML }
    for (const u of urls.slice(1)) map[u] = 'fail'
    const { fn } = fetchStub(map)
    const members = urls.map((url, i) => cand({ url, publisher: pubs[i] }))
    const r = await enrichNewsItems(members, { fetchFn: fn, requestedCount: 5 })
    expect(r.items).toHaveLength(1)
    expect(r.items[0].crossRefs.map((x) => x.publisher)).toEqual(['둘째사', '셋째사', '넷째사'])
  })

  test('요청 수에 도달하면 이후 클러스터는 시작하지 않고 탈락으로도 세지 않는다', async () => {
    const { fn, calls } = fetchStub({
      'https://a.com/1': BODY_HTML, 'https://b.com/2': BODY_HTML, 'https://c.com/3': BODY_HTML,
    })
    const members = [
      cand({ title: '전혀 다른 첫 번째 소식 이야기', url: 'https://a.com/1' }),
      cand({ title: '두 번째로 서로 무관한 경제 소식', url: 'https://b.com/2' }),
      cand({ title: '세 번째 스포츠 경기 결과 속보', url: 'https://c.com/3' }),
    ]
    const r = await enrichNewsItems(members, { fetchFn: fn, requestedCount: 1, concurrency: 1 })
    expect(r.items).toHaveLength(1)
    expect(r.clusterCount).toBe(3)
    expect(r.droppedUngrounded).toBe(0)
    expect(calls).toEqual(['https://a.com/1'])
  })

  test('결과는 클러스터 순서를 유지하고 요청 수로 자른다', async () => {
    const { fn } = fetchStub({
      'https://a.com/1': BODY_HTML, 'https://b.com/2': BODY_HTML, 'https://c.com/3': BODY_HTML,
    })
    const members = [
      cand({ title: '전혀 다른 첫 번째 소식 이야기', url: 'https://a.com/1' }),
      cand({ title: '두 번째로 서로 무관한 경제 소식', url: 'https://b.com/2' }),
      cand({ title: '세 번째 스포츠 경기 결과 속보', url: 'https://c.com/3' }),
    ]
    const r = await enrichNewsItems(members, { fetchFn: fn, requestedCount: 2 })
    expect(r.items.map((i) => i.url)).toEqual(['https://a.com/1', 'https://b.com/2'])
  })

  test('발행일이 없거나 파싱 불가면 publishedKst가 없다', async () => {
    const { fn } = fetchStub({ 'https://a.com/1': BODY_HTML, 'https://b.com/2': BODY_HTML })
    const members = [
      cand({ title: '전혀 다른 첫 번째 소식 이야기', url: 'https://a.com/1' }),
      cand({ title: '두 번째로 서로 무관한 경제 소식', url: 'https://b.com/2', publishedDate: '알 수 없음' }),
    ]
    const r = await enrichNewsItems(members, { fetchFn: fn, requestedCount: 2 })
    expect(r.items[0].publishedKst).toBeUndefined()
    expect(r.items[1].publishedKst).toBeUndefined()
  })

  test('발행처 미지정 시 URL 호스트에서 도출한다', async () => {
    const { fn } = fetchStub({ 'https://www.example-news.com/a': BODY_HTML })
    const r = await enrichNewsItems(
      [cand({ url: 'https://www.example-news.com/a' })],
      { fetchFn: fn, requestedCount: 1 },
    )
    expect(r.items[0].publisher).toBe('example-news.com')
  })
})
