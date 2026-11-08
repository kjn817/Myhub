import {
  buildDatedNewsQuery,
  dedupeSources,
  exaNewsParams,
  type SearchSource,
} from '../lib/news-summary'

export interface NewsEnv {
  NAVER_CLIENT_ID?: string
  NAVER_CLIENT_SECRET?: string
  TAVILY_API_KEY?: string
  EXA_API_KEY?: string
}

export type FetchFn = (input: string, init?: any) => Promise<Response>

/** 소스 1레그당 fetch 타임아웃 (15000 → 8000 단축 — RSS 15초는 과도하다는 실측) */
export const LEG_FETCH_TIMEOUT_MS = 8000
const NAVER_NEWS_URL = 'https://naverapihub.apigw.ntruss.com/search/v1/news'
const GNEWS_RSS_URL = 'https://news.google.com/rss/search'
const TAVILY_SEARCH_URL = 'https://api.tavily.com/search'
const EXA_SEARCH_URL = 'https://api.exa.ai/search'

function stripHtmlTags(s: string): string {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

function toIsoDate(s: unknown): string | undefined {
  if (typeof s !== 'string' || !s) return undefined
  const t = Date.parse(s)
  return Number.isNaN(t) ? undefined : new Date(t).toISOString()
}

function isHttpUrl(u: unknown): u is string {
  return typeof u === 'string' && u.startsWith('http')
}

/** 네이버 응답 파싱 — HUB 이관 후 응답 형태가 확정되지 않아 여러 형태를 허용하고, 형태 이상은 warnings로 보고한다. */
export function parseNaverNewsResponse(data: any): { items: SearchSource[]; warnings: string[] } {
  const warnings: string[] = []
  let raw: any[] | null = null
  if (Array.isArray(data?.items)) raw = data.items
  else if (Array.isArray(data?.result?.items)) raw = data.result.items
  else if (Array.isArray(data?.result)) raw = data.result
  else if (Array.isArray(data?.news)) raw = data.news
  if (!raw) {
    warnings.push('no_items_array: 응답에서 항목 배열을 찾지 못함')
    return { items: [], warnings }
  }
  const items: SearchSource[] = []
  raw.forEach((it: any, idx: number) => {
    if (!it || typeof it !== 'object') {
      warnings.push(`item_${idx}: not_an_object`)
      return
    }
    const urlCandidates = [it.originallink, it.originalLink, it.link, it.url]
    const url = urlCandidates.find((u: unknown) => isHttpUrl(u))
    if (!url) {
      warnings.push(`item_${idx}: missing_url`)
      return
    }
    const dateRaw = it.pubDate ?? it.publishedAt ?? it.published_at ?? it.pub_date ?? it.date
    const publishedDate = toIsoDate(dateRaw)
    if (!publishedDate) warnings.push(`item_${idx}: missing_or_bad_date`)
    const desc = stripHtmlTags(it.description ?? it.summary ?? '')
    items.push({
      title: stripHtmlTags(it.title ?? it.headline) || url,
      url,
      publishedDate,
      ...(desc ? { highlights: [desc] } : {}),
    })
  })
  return { items, warnings }
}

/**
 * 네이버 뉴스 검색 API (NAVER API HUB) — 한국 뉴스 1차 (sort=date 최신순이 구조적으로 보장됨).
 * 키가 없으면 빈 배열 (호출자가 다음 소스로 넘어감).
 * 본문 요약이 필요하면 기사 URL 직접 fetch는 이번 작업 범위 밖.
 *
 * 이관 (2026-10-28, 브랜치 apply/naver-hub): 구 Developers Center
 * `openapi.naver.com/v1/search/news.json` + `X-Naver-Client-*` 헤더에서
 * HUB `naverapihub.apigw.ntruss.com/search/v1/news` + `X-NCP-APIGW-API-KEY-*`
 * 헤더로 교체. 근거: NCP 공식 이관 가이드
 * https://guide.ncloud-docs.com/docs/apihub-migration (§4 호출 정보 변경 예시 —
 * 뉴스 검색 기준 curl 예시). 구 엔드포인트 폴백 없음 (구 키가 없고
 * 2027-06-30에 차단됨). HUB 호출 실패 시 체인이 다음 소스로 넘어간다.
 *
 * 미확인 (공식 이관 가이드가 "응답 Body 구조 — API별 확인 필요"로 명시):
 * HUB 응답의 필드명·날짜 형식을 공식 문서의 응답 샘플로 확인하지 못했다.
 * 파서는 구 API 형태(`items[].title/originallink/link/pubDate`, pubDate는
 * RFC 822 문자열)를 그대로 쓴다 — 이관 가이드가 "기존 주요 응답 필드가
 * 동일하게 반환되는지 확인"하라고만 하고 동일성을 보장하지 않으므로,
 * 스테이징 실제 호출로 필드·날짜 형식을 검증해야 한다 (별도 트랙).
 * `sort=date` 파라미터도 HUB curl 예시에는 `query`·`display`만 나와
 * 명시 확인이 안 됐으므로, 실제 호출로 동작 확인이 필요하다.
 * 환경변수 이름은 `NAVER_CLIENT_ID`·`NAVER_CLIENT_SECRET` 그대로 둔다
 * (값만 HUB 발급 키로 교체됨).
 */
export async function searchNaverNews(
  env: NewsEnv,
  query: string,
  fetchFn: FetchFn = fetch,
  timeoutMs: number = LEG_FETCH_TIMEOUT_MS,
): Promise<SearchSource[]> {
  const id = env.NAVER_CLIENT_ID
  const secret = env.NAVER_CLIENT_SECRET
  if (!id || !secret) return []
  const url = `${NAVER_NEWS_URL}?query=${encodeURIComponent(query)}&display=10&sort=date`
  const res = await fetchFn(url, {
    headers: { 'X-NCP-APIGW-API-KEY-ID': id, 'X-NCP-APIGW-API-KEY': secret },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`네이버 ${res.status}`)
  const data = (await res.json()) as any
  const { items, warnings } = parseNaverNewsResponse(data)
  if (warnings.length > 0) {
    console.warn('naver_response_shape', { warnings, kept: items.length })
  }
  return items
}

/** RSS 2.0 <item> 파싱 (의존성 없이 직접 구현 — Workers에 DOMParser 없음).
 * Google News RSS 전용이 아니라 RSS 2.0 피드 공용이다 (언론사 직접 RSS도
 * 같은 구조). 구 이름 parseGoogleNewsRss는 하위 호환 별칭으로 남긴다. */
export function parseRssItems(xml: string): SearchSource[] {
  const out: SearchSource[] = []
  const itemRe = /<item>([\s\S]*?)<\/item>/gi
  const field = (block: string, tag: string): string | undefined => {
    const m = block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i'))
    if (!m) return undefined
    return stripHtmlTags(m[1])
  }
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) !== null && out.length < 10) {
    const block = m[1]
    const title = field(block, 'title')
    const link = field(block, 'link')
    const pubDate = field(block, 'pubDate')
    const sourceMatch = block.match(/<source\b[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/source>/i)
    const source = sourceMatch ? stripHtmlTags(sourceMatch[1]) : undefined
    if (title && isHttpUrl(link)) {
      out.push({
        title,
        url: link,
        publishedDate: toIsoDate(pubDate),
        ...(source ? { publisher: source } : {}),
      })
    }
  }
  return out
}

/** 구 이름 — 하위 호환 별칭 (기존 호출처·테스트 유지). */
export const parseGoogleNewsRss = parseRssItems

/**
 * RSS fetch 공용 브라우저 헤더.
 * 2026-10-26 실측: UA 없이 보내면 Worker egress에서 Google News가 503으로
 * 막음 (VM curl은 됨). 2026-10-28 실측: 같은 조건에서 한경·매경 RSS는
 * 403으로 막힘 (UA 있으면 200). 언론사 직접 RSS도 이 헤더를 쓴다.
 */
const RSS_BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
  Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
}

/**
 * Google News RSS — 한국 헤드라인 백업 (키 불필요, 실시간 피드).
 * 비공식 피드라 구조 변경 리스크가 있어 실패 시 조용히 다음 소스로 넘어간다.
 *
 * 2026-10-26 라이브 실측: UA 헤더 없이 보내면 Worker egress에서 Google이
 * 503으로 막음 (VM curl은 됨). 브라우저 UA/Accept를 보낸다. 그래도 503이면
 * 체인이 statuses에 ok:false + error로 기록하고 [news-chain] 로그에 남긴 뒤
 * 다음 소스로 계속한다 — 조용히 넘기지 않는다. UA로 해결되는지는 라이브
 * tail 로그로 확인 필요 (OTP 리셋 후 재검증 예정).
 */
export async function fetchGoogleNewsRss(
  query: string,
  fetchFn: FetchFn = fetch,
  timeoutMs: number = LEG_FETCH_TIMEOUT_MS,
): Promise<SearchSource[]> {
  const url = `${GNEWS_RSS_URL}?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`
  const res = await fetchFn(url, {
    headers: RSS_BROWSER_HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`Google News RSS ${res.status}`)
  const xml = await res.text()
  return parseRssItems(xml)
}

/**
 * 언론사 직접 RSS 피드 목록 (2026-10-28 Worker egress 실측 통과 — docs/rss-press-experiment-20261028.md).
 *
 * 저작권 경계 — 반드시 지킬 것:
 * - 연합뉴스 피드 채널에 명시됨: "저작권자(c) 연합뉴스, 무단 전재-재배포,
 *   AI 학습 및 활용 금지". 한경·매경도 각사 저작권을 갖는다.
 * - 이 모듈은 피드에서 제목·링크·pubDate만 읽어 검색 결과(SearchSource)로
 *   쓴다. 기사 본문(<description> 포함)은 저장하지 않고, 외부 AI에 본문을
 *   통째로 전송하거나 재배포하지 않는다. 요약은 제목+링크+검증된 날짜만으로
 *   하고, 본문이 필요하면 기사 URL을 직접 fetch해 날짜만 검증한다
 *   (verifyArticleDates — 본문은 날짜 추출 후 버린다).
 * - 피드 구조 변경 시 파서 수정 필요 (모니터링 대상).
 */
export interface PressRssFeed {
  id: string
  /** 표시 이름 */
  name: string
  url: string
  /** 분야 */
  category: 'general' | 'economy' | 'finance'
  lang: 'ko' | 'en'
}

export const PRESS_RSS_FEEDS: PressRssFeed[] = [
  { id: 'yna-all', name: '연합뉴스 전체', url: 'https://www.yna.co.kr/rss/news.xml', category: 'general', lang: 'ko' },
  { id: 'yna-economy', name: '연합뉴스 경제', url: 'https://www.yna.co.kr/rss/economy.xml', category: 'economy', lang: 'ko' },
  { id: 'yna-en', name: '연합뉴스 영문', url: 'https://en.yna.co.kr/RSS/news.xml', category: 'general', lang: 'en' },
  { id: 'hankyung-finance', name: '한국경제 증권', url: 'https://www.hankyung.com/feed/finance', category: 'finance', lang: 'ko' },
  { id: 'hankyung-economy', name: '한국경제 경제', url: 'https://www.hankyung.com/feed/economy', category: 'economy', lang: 'ko' },
  { id: 'mk-economy', name: '매일경제 경제', url: 'https://www.mk.co.kr/rss/30100041/', category: 'economy', lang: 'ko' },
]

/**
 * 체인이 쓰는 한국어 피드만 (yna-en은 실측 통과했으나 영문 피드라 한국어
 * 뉴스 체인·브리핑 범위 밖 — 목록에는 남겨 후속 영문 브리핑에서 쓴다).
 */
export const PRESS_RSS_KO_FEEDS: PressRssFeed[] = PRESS_RSS_FEEDS.filter((f) => f.lang === 'ko')

/** 질의에서 주제 토큰만 남긴다 (일반어·날짜 토큰 제거). */
const PRESS_GENERIC_WORDS = new Set([
  '오늘', '주요', '뉴스', '헤드라인', '최신', '한국', '속보', '기사', '전체',
  '아침', '브리핑', '요약', '알려줘', '찾아줘', '보여줘', '검색', '관련',
  '경제', '증권', '금융', '사회', '정치', '국제', '연예', '스포츠', '문화',
])

export function pressQueryTokens(query: string): string[] {
  const raw = String(query || '')
    .replace(/\[SEARCH:?\s*/gi, ' ')
    .replace(/[\[\]]/g, ' ')
  const tokens = raw.split(/[\s,.;!?·•|/()"'“”‘’]+/).map((t) => t.trim()).filter(Boolean)
  const out: string[] = []
  for (const t of tokens) {
    if (t.length < 2) continue
    if (PRESS_GENERIC_WORDS.has(t)) continue
    // 날짜 토큰 제외 (2026년·10월·26일·2026-10-26 — sanitizeNewsQueryDate가 앞에 붙인 오늘 날짜 포함)
    if (/^\d{2,4}[-./년월일]\d{0,2}[-./월일]?\d{0,2}$/.test(t)) continue
    if (/^\d{4}$/.test(t)) continue
    if (!out.includes(t)) out.push(t)
  }
  return out
}

/**
 * 언론사 직접 RSS 헤드라인 수집 (키 불필요).
 * - 5개 한국어 피드를 병렬 fetch (한 피드 실패가 전체를 죽이지 않음 —
 *   Promise.allSettled; 전부 실패했을 때만 throw해 체인이 ok:false로 기록).
 * - 피드는 검색이 아니라 최신 헤드라인 목록이다: 주제 토큰이 있으면 제목에
 *   토큰이 하나라도 들어간 항목만 남기고, 일반 질의("오늘 주요 뉴스" —
 *   토큰이 남지 않음)에는 창 안 헤드라인 전체를 쓴다. 토큰 필터가 없으면
 *   주제 질의에 무관한 헤드라인이 목표 수를 채워 체인을 멈추게 한다.
 * - 날짜 하드 필터는 체인 단계에서 filterNewsWindow로 공통 적용한다.
 * - 반드시 브라우저 UA로 보낸다 (UA 없으면 한경·매경이 Worker egress에서
 *   403 — 2026-10-28 실측).
 */
export async function fetchPressRssHeadlines(
  query: string,
  fetchFn: FetchFn = fetch,
  timeoutMs: number = LEG_FETCH_TIMEOUT_MS,
  feeds: PressRssFeed[] = PRESS_RSS_KO_FEEDS,
): Promise<SearchSource[]> {
  const tokens = pressQueryTokens(query)
  const settled = await Promise.allSettled(
    feeds.map(async (feed) => {
      const res = await fetchFn(feed.url, {
        headers: RSS_BROWSER_HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`${feed.name} RSS ${res.status}`)
      const outlet = feed.name.replace(/\s+(전체|경제|증권|금융)$/, '')
      return parseRssItems(await res.text()).map((it) =>
        (it as any).publisher ? it : { ...it, publisher: outlet },
      )
    }),
  )
  const merged: SearchSource[] = []
  const failures: string[] = []
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]
    if (s.status === 'fulfilled') merged.push(...s.value)
    else failures.push(`${feeds[i].id}: ${String((s.reason as any)?.message || s.reason)}`)
  }
  if (merged.length === 0 && failures.length === feeds.length) {
    // 피드 전부가 fetch 실패일 때만 throw (체인이 ok:false로 기록).
    // 피드는 살아 있으나 항목이 0건이면 빈 배열 — 실패가 아니다.
    throw new Error(`언론사 RSS 전부 실패 (${failures.join('; ')})`)
  }
  const deduped = dedupeSources(merged)
  if (tokens.length === 0) return deduped
  const lowered = tokens.map((t) => t.toLowerCase())
  return deduped.filter((it) => {
    const title = (it.title || '').toLowerCase()
    return lowered.some((t) => title.includes(t))
  })
}

/**
 * Tavily — 글로벌/일반 뉴스 (topic:'news' + time_range:'day' + advanced).
 * basic은 최신 결과 중앙값이 10일 전이라 advanced 필수 (2026-10-26 조사).
 * 키가 없으면 빈 배열.
 */
export async function searchTavilyNews(
  env: NewsEnv,
  query: string,
  fetchFn: FetchFn = fetch,
  timeoutMs: number = LEG_FETCH_TIMEOUT_MS,
): Promise<SearchSource[]> {
  const key = env.TAVILY_API_KEY
  if (!key) return []
  const res = await fetchFn(TAVILY_SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      query,
      topic: 'news',
      time_range: 'day',
      search_depth: 'advanced',
      max_results: 10,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`Tavily ${res.status}`)
  const data = (await res.json()) as any
  return ((data.results || []) as any[])
    .map((r: any) => {
      const content = typeof r.content === 'string' ? r.content.replace(/\s+/g, ' ').trim() : ''
      return {
        title: r.title || r.url,
        url: r.url,
        publishedDate: toIsoDate(r.published_date),
        ...(content ? { highlights: [content.slice(0, 600)] } : {}),
      }
    })
    .filter((r) => isHttpUrl(r.url))
}

/**
 * Exa — 심층·보강용 (뉴스 1차가 아님).
 * 최적화 본문: 질의에 오늘 날짜 문장 포함 + 1~2일 창 + userLocation KR.
 * 폐기 파라미터(neural/keyword 타입, useAutoprompt, livecrawl, includeText)는
 * 보내지 않는다. type 미지정(auto) 유지.
 */
export async function searchExaNews(
  env: NewsEnv,
  query: string,
  now: Date = new Date(),
  fetchFn: FetchFn = fetch,
  timeoutMs: number = LEG_FETCH_TIMEOUT_MS,
): Promise<SearchSource[]> {
  const key = env.EXA_API_KEY
  if (!key) return []
  const datedQuery = buildDatedNewsQuery(query, now)
  const params = exaNewsParams(now)
  const body = { query: datedQuery, numResults: 10, contents: { highlights: true }, ...params }
  const res = await fetchFn(EXA_SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`Exa ${res.status}`)
  const data = (await res.json()) as any
  const rawItems: SearchSource[] = ((data.results || []) as any[])
    .slice(0, 10)
    .map((r: any) => ({
      title: r.title || r.url,
      url: r.url,
      highlights: Array.isArray(r.highlights) ? r.highlights.slice(0, 2) : undefined,
      publishedDate: typeof r.publishedDate === 'string' ? r.publishedDate : undefined,
    }))
    .filter((r) => isHttpUrl(r.url))
  // 진단 로그 (조사 6.1): 무시된 필드·발행일·전송 질의(앞 80자만 — 원문 전체는 남기지 않음)
  console.log(
    '[news-exa]',
    JSON.stringify({
      q: datedQuery.slice(0, 80),
      params,
      warnings: Array.isArray(data.warnings) ? data.warnings : [],
      publishedDates: rawItems.map((r) => r.publishedDate ?? null),
    }),
  )
  return rawItems
}
