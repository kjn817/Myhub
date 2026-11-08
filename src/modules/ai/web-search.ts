// (routes.ts 분리, 2026-10-29 — 동작 변경 없는 순수 구조 분리로 이동된 코드)
// 외부 웹검색 (뉴스 소스 체인 → Tavily → Exa → Serper 폴백)
import { buildSearchFollowUpPrompt, validateItemSources, dedupeSources, filterFreshSources, isNewsQuery, resolveNewsIntent, noFreshNewsText, mergeSearchSources } from '../../lib/news-summary'
import { fetchNewsSources } from '../../services/news-sources'
import { withTimeout } from '../../lib/deadline'
import { guardSearchQuery } from '../../services/privacy-gateway'

// 외부 검색 API (뉴스 질의는 소스 체인 우선, 그 외 Tavily → Exa → Serper 순서로 폴백)
// API 키는 Worker secrets에 등록: TAVILY_API_KEY, EXA_API_KEY, SERPER_API_KEY
// 전체 시간 예산 (2026-10-26 트랙 A2 — websearch 502 timeout 실측 대응):
// 레그별 15초씩 순차 실행하면 30초 edge 제한을 넘김. 전체 deadline(20초)을
// 두고, 남은 예산이 없으면 남은 레그를 시도하지 않고 []를 반환한다.
// (호출처의 DuckDuckGo 폴백이 처리한다 — 조용한 실패가 아니라 빈 결과 반환.)
const EXTERNAL_SEARCH_TOTAL_TIMEOUT_MS = 20000
const EXTERNAL_SEARCH_LEG_TIMEOUT_MS = 10000

export async function externalWebSearch(env: any, query: string): Promise<{ title: string; url: string }[]> {
  if (guardSearchQuery(query) === null) return []
  const deadline = Date.now() + EXTERNAL_SEARCH_TOTAL_TIMEOUT_MS
  const remaining = () => Math.max(0, deadline - Date.now())
  // 뉴스 질의: 소스 체인(네이버 → Google News RSS → Tavily → Exa) 우선.
  // Exa/Tavily 일반 검색은 날짜 필터가 약해 오래된 기사가 섞이는 것이 실측됨.
  // 체인이 비면 Serper만 한 번 더 시도하고, 그래도 없으면 [] (호출처의
  // DuckDuckGo 폴백이 처리한다).
  if (isNewsQuery(query)) {
    try {
      const chain = await fetchNewsSources(env, query, { now: new Date(), totalTimeoutMs: remaining() })
      if (chain.items.length > 0) {
        return chain.items.map((r) => ({ title: r.title, url: r.url }))
      }
    } catch { /* Serper로 */ }
  } else if (remaining() > 0) {
    // 1. Tavily
    if (env.TAVILY_API_KEY) {
      try {
        const legTimeout = Math.min(EXTERNAL_SEARCH_LEG_TIMEOUT_MS, remaining())
        const res = await withTimeout(
          fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query, max_results: 5 }),
            signal: AbortSignal.timeout(legTimeout),
          }),
          legTimeout,
          'tavily timeout',
        )
        if (res.ok) {
          const data = (await res.json()) as any
          const items = (data.results || []).slice(0, 5).map((r: any) => ({ title: r.title, url: r.url }))
          if (items.length > 0) return items
        }
      } catch { /* 다음으로 */ }
    }
    // 2. Exa
    if (env.EXA_API_KEY && remaining() > 0) {
      try {
        const legTimeout = Math.min(EXTERNAL_SEARCH_LEG_TIMEOUT_MS, remaining())
        const res = await withTimeout(
          fetch('https://api.exa.ai/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': env.EXA_API_KEY },
            body: JSON.stringify({ query, numResults: 5, contents: { highlights: true } }),
            signal: AbortSignal.timeout(legTimeout),
          }),
          legTimeout,
          'exa timeout',
        )
        if (res.ok) {
          const data = (await res.json()) as any
          const items = (data.results || []).slice(0, 5).map((r: any) => ({ title: r.title, url: r.url }))
          if (items.length > 0) return items
        }
      } catch { /* 다음으로 */ }
    }
  }
  // 3. Serper
  if (env.SERPER_API_KEY && remaining() > 0) {
    try {
      const legTimeout = Math.min(EXTERNAL_SEARCH_LEG_TIMEOUT_MS, remaining())
      const res = await withTimeout(
        fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-KEY': env.SERPER_API_KEY },
          body: JSON.stringify({ q: query, num: 5 }),
          signal: AbortSignal.timeout(legTimeout),
        }),
        legTimeout,
        'serper timeout',
      )
      if (res.ok) {
        const data = (await res.json()) as any
        const items = (data.organic || []).slice(0, 5).map((r: any) => ({ title: r.title, url: r.link }))
        if (items.length > 0) return items
      }
    } catch { /* 다음으로 */ }
  }
  return []
}

// 웹검색 (DuckDuckGo, 무료, 키 불필요) - 모든 모델에서 사용 가능
// 2026-10-26 실측: DuckDuckGo HTML이 Worker egress에서 15초 타임아웃으로
// 502가 됨 ("The operation was aborted due to timeout"). A2의 체인
// deadline은 externalWebSearch 경로에만 적용돼 이 엔드포인트에는 닿지
// 않았음 — 그래서 뉴스 질의는 체인으로 직접 가고, 일반 질의는 DDG(5초)
// 실패 시 체인으로 폴백한다 (5초 + 체인 20초 < 30초 edge 제한).
