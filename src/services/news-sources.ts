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
  filterNewsWindow,
  newsWindow,
  normalizeSourceUrl,
  sanitizeNewsQueryDate,
  type SearchSource,
} from '../lib/news-summary'
import { remainingMs, withTimeout } from '../lib/deadline'
import { verifyArticleDates } from './article-date'
import { guardSearchQuery } from './privacy-gateway'
import {
  LEG_FETCH_TIMEOUT_MS,
  fetchGoogleNewsRss,
  fetchPressRssHeadlines,
  searchExaNews,
  searchNaverNews,
  searchTavilyNews,
  type FetchFn,
  type NewsEnv,
} from './news-source-legs'

export {
  PRESS_RSS_FEEDS,
  PRESS_RSS_KO_FEEDS,
  fetchGoogleNewsRss,
  fetchPressRssHeadlines,
  parseGoogleNewsRss,
  parseRssItems,
  pressQueryTokens,
  searchExaNews,
  searchNaverNews,
  searchTavilyNews,
  type NewsEnv,
} from './news-source-legs'

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
/**
 * 레그 시작 최소 잔여 예산 (10ms). 레그 타임아웃은 남은 예산 전부를 쓰므로
 * 타임아웃 직후 남은 예산은 0ms 근처가 되는데, Date.now() 1ms 양자화 +
 * 타이머/시계 오차로 0인지 1~2ms인지가 실행마다 달라져, 다음 레그를
 * 1ms짜리로 시작하는 레이스가 생긴다 (2026-11-13 CI #76 flake — gnews가
 * 'chain deadline exceeded' 대신 'news leg timeout: gnews-rss'을 받음).
 * 10ms로는 fetch 한 번도 못 하니 시작하지 않는 게 맞다.
 */
export const NEWS_CHAIN_MIN_LEG_REMAINING_MS = 10

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
  if (guardSearchQuery(query) === null) {
    return { items: [], statuses: [], window: newsWindow(now) }
  }
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
    // MIN_LEG_REMAINING_MS 이하도 소진으로 본다 — 경계 1~2ms 레이스 방지
    // (NEWS_CHAIN_MIN_LEG_REMAINING_MS 주석 참조).
    if (remainingMs(deadline) <= NEWS_CHAIN_MIN_LEG_REMAINING_MS) {
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
