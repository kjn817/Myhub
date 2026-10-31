/**
 * 뉴스 소스 체인 — "오늘 뉴스" 신뢰성 확보 (2026-10-26 Exa 조사 권장안)
 *
 * 우선순위: 네이버 뉴스 API(sort=date) → 언론사 직접 RSS(YNA·한경·매경)
 * → Google News RSS → Tavily(news/day/advanced) → Exa(최적화 본문, 심층·보강용).
 * - 각 소스 결과는 뉴스 창(어제~오늘 KST) 하드 필터 + 날짜 없음 제외를 거친다.
 *   2026-10-26 라이브 실측 추가 가드: URL 경로 날짜 대조(Exa publishedDate가
 *   가짜인 경우 대응) + Exa 단계 자정 UTC 발행일 미상 취급 + 마커 질의 날짜
 *   소독(잘못된 날짜를 오늘 날짜로 교체).
 * - 언론사 직접 RSS (2026-10-28 Worker egress 실측, docs/rss-press-experiment-20261028.md):
 *   YNA 3개·한경 2개·매경 1개 전부 200 + pubDate 신선. 단, 한경·매경은
 *   브라우저 UA 없이 403이므로 RSS fetch에는 반드시 브라우저 UA를 보낸다
 *   (Google News RSS 503 전례와 같은 패턴). 피드는 검색이 아니라 최신
 *   헤드라인 목록이라, 주제 질의에는 제목 토큰 매칭으로 좁히고 일반 질의
 *   ("오늘 주요 뉴스")에만 전체 헤드라인을 쓴다.
 * - Google News RSS는 브라우저 UA/Accept를 보낸다 (UA 없이 Worker egress에서
 *   503 실측). 실패하면 statuses에 기록하고 다음 소스로 계속한다.
 * - 키가 없는 소스는 조용히 스킵한다 (사용자에게 에러를 노출하지 않음).
 * - 소스별 실패는 상태로 기록하고 다음 소스로 계속한다. 체인 자체는 던지지 않는다.
 * - 진단 로그: Exa warnings[]·publishedDate·전송 질의(앞 80자만)를 남긴다.
 * - 쓰지 않는 것 (조사에서 제외 판정): Brave·GNews·NewsAPI·Perplexity·
 *   Cloudflare Web Search API·DeepSeek Search API.
 */

import {
  dedupeSources,
  exaNewsParams,
  buildDatedNewsQuery,
  filterNewsWindow,
  newsWindow,
  normalizeSourceUrl,
  sanitizeNewsQueryDate,
  type SearchSource,
} from '../lib/news-summary'
import { remainingMs, withTimeout } from '../lib/deadline'
import { verifyArticleDates } from './article-date'

export type NewsSourceName = 'naver' | 'press-rss' | 'gnews-rss' | 'tavily' | 'exa'

export interface NewsSourceItem extends SearchSource {
  source: NewsSourceName
}

export interface NewsSourceStatus {
  source: NewsSourceName
  ok: boolean
  /** 키가 없어 호출하지 않고 건너뜀 */
  skipped?: boolean
  /** 해당 소스가 반환한 원본 결과 수 */
  fetched: number
  /** 하드 필터 후 누적에 기여한 수 */
  kept: number
  /** 기사 날짜 직접 검증에서 제외된 수 (Exa·press-rss 단계) */
  verifyDropped?: number
  error?: string
}

export interface NewsChainResult {
  items: NewsSourceItem[]
  statuses: NewsSourceStatus[]
  window: { startDate: string; endDate: string }
  /** 전체 시간 예산을 소진해 체인을 중단했으면 true (조용한 실패 금지 — 로그에도 남김) */
  timedOut?: boolean
}

export interface NewsEnv {
  NAVER_CLIENT_ID?: string
  NAVER_CLIENT_SECRET?: string
  TAVILY_API_KEY?: string
  EXA_API_KEY?: string
}

export interface FetchNewsSourcesOpts {
  /** 목표 신선 항목 수 (기본 5). 도달하면 남은 소스를 부르지 않는다. */
  targetCount?: number
  now?: Date
  /** 테스트 주입용 fetch */
  fetchFn?: typeof fetch
  /**
   * 체인 전체 시간 예산 ms (기본 20000).
   * 2026-10-26 실측: 레그별 15초씩 순차 실행하면 30초 edge 제한을 넘어
   * websearch가 502 timeout이 됨 — 전체 deadline으로 묶는다.
   */
  totalTimeoutMs?: number
  /** Exa 결과 기사 날짜 직접 검증 여부 (기본 true — 잔존 간극을 닫는 단계) */
  verifyArticles?: boolean
  /** 기사 1건당 fetch 타임아웃 ms (기본 5000) */
  verifyTimeoutMs?: number
  /** 기사 검증 병렬 수 (기본 3) */
  verifyConcurrency?: number
}

export const NEWS_CHAIN_TARGET = 5
/** 체인 전체 시간 예산 (기본 20000ms — 30초 edge 제한 안에 마쳐야 함) */
export const NEWS_CHAIN_TOTAL_TIMEOUT_MS = 20000
/** 소스 1레그당 fetch 타임아웃 (15000 → 8000 단축 — RSS 15초는 과도하다는 실측) */
export const LEG_FETCH_TIMEOUT_MS = 8000
const NAVER_NEWS_URL = 'https://naverapihub.apigw.ntruss.com/search/v1/news'
const GNEWS_RSS_URL = 'https://news.google.com/rss/search'
const TAVILY_SEARCH_URL = 'https://api.tavily.com/search'
const EXA_SEARCH_URL = 'https://api.exa.ai/search'

type FetchFn = (input: string, init?: any) => Promise<Response>

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
  return ((data.items || []) as any[])
    .map((it: any) => ({
      title: stripHtmlTags(it.title) || stripHtmlTags(it.originallink || it.link || ''),
      url: isHttpUrl(it.originallink) ? it.originallink : it.link,
      publishedDate: toIsoDate(it.pubDate),
    }))
    .filter((r) => isHttpUrl(r.url))
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
    if (title && isHttpUrl(link)) {
      out.push({ title, url: link, publishedDate: toIsoDate(pubDate) })
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
      return parseRssItems(await res.text())
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
    .map((r: any) => ({
      title: r.title || r.url,
      url: r.url,
      publishedDate: toIsoDate(r.published_date),
    }))
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

/**
 * 뉴스 소스 체인 실행.
 * 네이버 → 언론사 직접 RSS → Google News RSS → Tavily → Exa 순서로 신선 항목을 모아 목표 수에
 * 도달하면 중단한다. 각 소스 결과는 뉴스 창 하드 필터(창 밖·날짜 없음 제외)를
 * 거친다. 소스별 실패는 상태에 기록하고 계속한다 — 체인 자체는 던지지 않는다.
 *
 * 시간 예산 (2026-10-26 트랙 A2 — websearch 502 timeout 실측 대응):
 * - 체인 전체 deadline(기본 20초)을 둔다. 레그 하나가 hang에 빠져도
 *   withTimeout race로 deadline 안에 끊고, 남은 레그는 시도하지 않고
 *   statuses에 'chain deadline exceeded'로 정직하게 기록한다.
 * - 레그별 fetch 타임아웃은 8초로 단축 (기존 15초).
 * - deadline 초과 시 이미 모은 신선 항목으로 반환한다 (빈 결과가 아님).
 *
 * 기사 날짜 직접 검증 (Exa·press-rss 단계):
 * - Exa publishedDate 가짜 실측 + URL 날짜 가드의 잔존 간극(bbcbreakingnews
 *   미러) 대응 — 필터를 통과한 Exa 후보의 기사 페이지를 직접 fetch해 HTML
 *   메타 날짜(article:published_time·JSON-LD·<time>)로 재검증한다.
 * - press-rss도 같은 검증을 거친다 (기사 페이지 실존 + 날짜 창 안 확인 —
 *   2026-10-28 실측에서 3사 기사 페이지 전부 200 + 메타 날짜 보유).
 * - 검증 실패(fetch 실패·날짜 없음·창 밖)는 해당 항목 제외 (strict).
 * - 검증도 체인 deadline 안에서만 수행한다 (예산 초과 시 미검증 항목 제외).
 */
export async function fetchNewsSources(
  env: NewsEnv,
  query: string,
  opts: FetchNewsSourcesOpts = {},
): Promise<NewsChainResult> {
  const now = opts.now ?? new Date()
  // 마커 질의 날짜 소독 (2026-10-26 실측: 모델이 [SEARCH:]에 "2025년 1월
  // 22일" 같은 잘못된 날짜를 넣으면 질의가 오염됨 — 전 소스에 깨끗한 질의
  // 사용. buildDatedNewsQuery(Exa)도 같은 소독을 하지만, 네이버·RSS·
  // Tavily까지 깨끗한 질의를 받으려면 체인 진입점에서 한 번 더 소독한다.)
  const cleanQuery = sanitizeNewsQueryDate(query, now)
  const target = opts.targetCount ?? NEWS_CHAIN_TARGET
  const fetchFn = (opts.fetchFn ?? fetch) as FetchFn
  const window = newsWindow(now)
  const totalTimeoutMs = opts.totalTimeoutMs ?? NEWS_CHAIN_TOTAL_TIMEOUT_MS
  const deadline = Date.now() + totalTimeoutMs
  const verifyArticles = opts.verifyArticles ?? true
  const items: NewsSourceItem[] = []
  const statuses: NewsSourceStatus[] = []
  let timedOut = false
  let verifySummary: { checked: number; kept: number; dropped: number } | undefined
  const steps: Array<{
    name: NewsSourceName
    hasKey: boolean
    run: (timeoutMs: number) => Promise<SearchSource[]>
  }> = [
    {
      name: 'naver',
      hasKey: Boolean(env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET),
      run: (timeoutMs) => searchNaverNews(env, cleanQuery, fetchFn, timeoutMs),
    },
    {
      name: 'press-rss',
      hasKey: true,
      run: (timeoutMs) => fetchPressRssHeadlines(cleanQuery, fetchFn, timeoutMs),
    },
    {
      name: 'gnews-rss',
      hasKey: true,
      run: (timeoutMs) => fetchGoogleNewsRss(cleanQuery, fetchFn, timeoutMs),
    },
    {
      name: 'tavily',
      hasKey: Boolean(env.TAVILY_API_KEY),
      run: (timeoutMs) => searchTavilyNews(env, cleanQuery, fetchFn, timeoutMs),
    },
    {
      name: 'exa',
      hasKey: Boolean(env.EXA_API_KEY),
      run: (timeoutMs) => searchExaNews(env, cleanQuery, now, fetchFn, timeoutMs),
    },
  ]
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (items.length >= target) break
    // 전체 deadline 소진 시 남은 레그는 시도하지 않고 정직하게 기록한다.
    if (remainingMs(deadline) <= 0) {
      timedOut = true
      for (let j = i; j < steps.length; j++) {
        statuses.push({
          source: steps[j].name,
          ok: false,
          fetched: 0,
          kept: 0,
          error: 'chain deadline exceeded',
        })
      }
      break
    }
    if (!step.hasKey) {
      statuses.push({ source: step.name, ok: true, skipped: true, fetched: 0, kept: 0 })
      continue
    }
    let raw: SearchSource[] = []
    try {
      const legTimeout = Math.min(LEG_FETCH_TIMEOUT_MS, remainingMs(deadline))
      // AbortSignal만으로는 signal을 무시하는 hang을 끊을 수 없어 race를 둔다
      // (실측: RSS 503이 아니라 hang이면 15초씩 쌓여 30초 edge 제한 초과 → 502).
      raw = await withTimeout(step.run(legTimeout), legTimeout, `news leg timeout: ${step.name}`)
      // 자정 UTC 규칙은 Exa 단계에만 적용한다 (2026-10-26 실측: 가짜 자정
      // 발행일은 Exa에서만 확인됨. 네이버·RSS·Tavily는 발행사가 준 실제
      // 시각이라 09:00 KST 정각(= 자정 UTC) 발행이 진짜로 있음).
      let fresh = filterNewsWindow(
        dedupeSources(raw),
        window.startDate,
        window.endDate,
        step.name === 'exa' ? { treatMidnightAsUnknown: true } : undefined,
      )
      let verifyDropped: number | undefined
      // 기사 날짜 직접 검증 — Exa publishedDate 가짜 + URL 가드 잔존 간극 대응.
      // press-rss도 같은 검증을 거친다: RSS pubDate는 발행사 직접 날짜라 Exa와
      // 달리 위조 전례가 없으나, 본문 fetch 검증 패턴을 동일하게 적용해
      // 기사 페이지가 실제로 살아 있고 날짜가 창 안에 있음을 확인한다
      // (2026-10-28 실측: YNA·한경·매경 기사 페이지 전부 Worker egress 200 +
      // article:published_time 보유).
      if ((step.name === 'exa' || step.name === 'press-rss') && verifyArticles && fresh.length > 0 && items.length < target) {
        // fetch 실패·날짜 없음·창 밖이면 제외 (strict). deadline 안에서만 수행.
        const { verified, checks } = await verifyArticleDates(fresh, window, {
          fetchFn: fetchFn as typeof fetch,
          now,
          deadline,
          perFetchTimeoutMs: opts.verifyTimeoutMs,
          concurrency: opts.verifyConcurrency,
          limit: target - items.length,
        })
        const dropped = checks.filter((c) => c.reason !== 'verified').length
        if (dropped > 0) verifyDropped = dropped
        verifySummary = { checked: checks.length, kept: verified.length, dropped }
        fresh = verified
      }
      const seen = new Set(items.map((i) => normalizeSourceUrl(i.url)))
      let kept = 0
      for (const it of fresh) {
        if (items.length >= target) break
        const key = normalizeSourceUrl(it.url)
        if (seen.has(key)) continue
        seen.add(key)
        items.push({ ...it, source: step.name })
        kept++
      }
      statuses.push({
        source: step.name,
        ok: true,
        fetched: raw.length,
        kept,
        ...(verifyDropped !== undefined ? { verifyDropped } : {}),
      })
    } catch (e: any) {
      statuses.push({
        source: step.name,
        ok: false,
        fetched: raw.length,
        kept: 0,
        error: String(e?.message || e).slice(0, 120),
      })
    }
  }
  console.log(
    '[news-chain]',
    JSON.stringify({
      q: cleanQuery.slice(0, 80),
      window,
      target,
      ...(timedOut ? { timedOut: true } : {}),
      ...(verifySummary ? { verify: verifySummary } : {}),
      statuses: statuses.map(({ source, ok, skipped, fetched, kept, verifyDropped, error }) => ({
        source,
        ok,
        ...(skipped ? { skipped: true } : {}),
        fetched,
        kept,
        ...(verifyDropped !== undefined ? { verifyDropped } : {}),
        ...(error ? { error } : {}),
      })),
      total: items.length,
    }),
  )
  return { items, statuses, window, ...(timedOut ? { timedOut: true } : {}) }
}
