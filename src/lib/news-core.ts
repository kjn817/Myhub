/**
 * 뉴스 출처 공용 코어 — 날짜·URL 정규화·중복 제거·신선도 필터.
 * news-summary(의도·윈도우), news-source-links(출처 검증), news-answer(답변 체인)가 공유한다.
 */

export interface SearchSource {
  title: string
  url: string
  /** Exa가 반환한 발행일 (ISO 8601). 없으면 신선도를 알 수 없음. */
  publishedDate?: string
}

/** 출처 신선도 기준: 이 일수보다 오래된 결과는 제외 대상 (기본 30일). */
export const SOURCE_MAX_AGE_DAYS = 30

/** KST 기준 오늘 날짜 'YYYY-MM-DD' (공용 코어 src/lib/kst.ts). */
export { kstDateStr as kstTodayStr } from './kst'

/** 출처 URL 정규화: 프래그먼트 제거, 호스트 소문자화, 말단 슬래시 제거. */
export function normalizeSourceUrl(url: string): string {
  let u = String(url || '').trim()
  const hashIdx = u.indexOf('#')
  if (hashIdx >= 0) u = u.slice(0, hashIdx)
  const schemeIdx = u.indexOf('://')
  if (schemeIdx >= 0) {
    const rest = u.slice(schemeIdx + 3)
    const slashIdx = rest.indexOf('/')
    const host = (slashIdx >= 0 ? rest.slice(0, slashIdx) : rest).toLowerCase()
    const path = slashIdx >= 0 ? rest.slice(slashIdx) : ''
    u = `${u.slice(0, schemeIdx + 3)}${host}${path}`
  }
  if (u.length > 1) {
    while (u.endsWith('/')) u = u.slice(0, -1)
  }
  return u
}

/** 정규화 URL 기준으로 출처 중복을 제거한다 (첫 등장 유지). */
export function dedupeSources(sources: SearchSource[]): SearchSource[] {
  const seen = new Set<string>()
  const out: SearchSource[] = []
  for (const s of sources) {
    const key = normalizeSourceUrl(s.url)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

/**
 * 신선도 필터: maxAgeDays보다 오래된 출처를 제거한다.
 * - 발행일이 없거나 파싱 불가면 관대 모드에서는 유지, strict면 제거.
 * - 전부 걸러지면 관대 모드에서는 원본을 반환한다 (strict면 빈 배열).
 */
export function filterFreshSources(
  sources: SearchSource[],
  maxAgeDays: number = SOURCE_MAX_AGE_DAYS,
  now: Date = new Date(),
  strict = false,
): SearchSource[] {
  if (sources.length === 0) return sources
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000
  const kept = sources.filter((s) => {
    if (!s.publishedDate) return !strict
    const t = Date.parse(s.publishedDate)
    if (Number.isNaN(t)) return !strict
    return t >= cutoff
  })
  if (kept.length > 0) return kept
  return strict ? [] : sources
}
