/**
 * 뉴스 질의 의도·날짜 윈도우·쿼리 정제 — 뉴스 답변 체인의 입구.
 * 출처 공용 코어는 news-core, 출처 검증은 news-source-links, 답변 조립은 news-answer가 맡는다.
 * (구 import 경로 호환을 위해 news-core·news-source-links의 공개 표면을 여기서 재노출한다.)
 */

import { kstTodayStr, type SearchSource } from './news-core'
import { kstDateKoStr } from './kst'

export {
  kstTodayStr,
  normalizeSourceUrl,
  dedupeSources,
  filterFreshSources,
  type SearchSource,
} from './news-core'
export {
  NEWS_CATEGORY_GUIDE,
  NEWS_ITEM_FORMAT_INSTRUCTION,
  buildSearchFollowUpPrompt,
  extractUrlsFromText,
  mergeSearchSources,
  validateItemSources,
} from './news-source-links'

/** 질의가 뉴스 의도인지 판정한다. */
export function isNewsQuery(query: string): boolean {
  return /뉴스|속보|헤드라인|브리핑|breaking/i.test(query || '')
}

/** 마커 쿼리·원문 어느 한쪽이라도 뉴스 의도면 뉴스로 본다. */
export function resolveNewsIntent(markerQuery: string, userMessage: string): boolean {
  return isNewsQuery(markerQuery) || isNewsQuery(userMessage)
}

/** 뉴스 윈도우: 어제~오늘 (KST 날짜 문자열). */
export function newsWindow(now: Date = new Date()): { startDate: string; endDate: string } {
  return {
    startDate: kstTodayStr(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
    endDate: kstTodayStr(now),
  }
}

/** 'YYYY년 M월 D일' 형태의 오늘 표기 (공용 코어 src/lib/kst.ts). */
export function kstTodayKoStr(now: Date = new Date()): string {
  return kstDateKoStr(now)
}

/** 검색 쿼리에 오늘 날짜를 명시해 최신 뉴스로 유도한다. */
export function buildDatedNewsQuery(query: string, now: Date = new Date()): string {
  const q = (query || '').trim()
  if (!q) return q
  return sanitizeNewsQueryDate(q, now)
}

const NEWS_QUERY_DATE_PATTERNS: RegExp[] = [
  /\d{4}년\s*\d{1,2}월\s*\d{1,2}일/g,
  /\d{4}년\s*\d{1,2}월/g,
  /\d{4}년/g,
  /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g,
  /\d{1,2}월\s*\d{1,2}일/g,
  /\b(?:19|20)\d{2}\b/g,
]

/** 쿼리에 섞인 날짜 표기를 제거하고 오늘 날짜를 앞에 붙인다 (과거 날짜로 새는 것 방지). */
export function sanitizeNewsQueryDate(query: string, now: Date = new Date()): string {
  let q = (query || '').trim()
  for (const re of NEWS_QUERY_DATE_PATTERNS) q = q.replace(re, ' ')
  q = q.replace(/\s+/g, ' ').trim()
  const today = kstTodayKoStr(now)
  return q ? `${today} ${q}` : today
}

function isValidYmd(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false
  if (y < 1900 || y > 2100) return false
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export interface ExtractedUrlDate {
  date: string
  /** 연/월/일까지 특정되면 true, 연도만이면 false. */
  precise: boolean
}

/**
 * URL 경로에서 발행 날짜를 추출한다.
 * 세그먼트 분리형(2026/11/07), 결합형(2026-11-07·20261107·YYMMDD),
 * 한글형(2026년 11월 7일)을 모두 시도하고, 마지막으로 본 유효 후보를 반환한다.
 */
export function extractUrlDate(rawUrl: string): ExtractedUrlDate | null {
  let path = ''
  try {
    path = new URL(String(rawUrl || '')).pathname
  } catch {
    return null
  }
  try {
    path = decodeURIComponent(path)
  } catch {
    // 디코딩 실패 시 원문 경로로 계속한다
  }
  const segments = path.split('/').filter(Boolean)
  let found: ExtractedUrlDate | null = null
  const consider = (cand: ExtractedUrlDate | null) => {
    if (cand) found = cand
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (/^\d{4}$/.test(seg) && i + 2 < segments.length && /^\d{1,2}$/.test(segments[i + 1]) && /^\d{1,2}$/.test(segments[i + 2])) {
      const y = Number(seg)
      const m = Number(segments[i + 1])
      const d = Number(segments[i + 2])
      if (isValidYmd(y, m, d)) {
        consider({ date: `${y}-${pad2(m)}-${pad2(d)}`, precise: true })
      }
      i += 2
      continue
    }
    let m = seg.match(/(?<!\d)(\d{4})[-.](\d{1,2})[-.](\d{1,2})(?!\d)/)
    if (m) {
      if (isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]))) {
        consider({ date: `${m[1]}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`, precise: true })
      }
      continue
    }
    m = seg.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/)
    if (m) {
      if (isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]))) {
        consider({ date: `${m[1]}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`, precise: true })
      }
      continue
    }
    m = seg.match(/(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/)
    if (m) {
      if (isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]))) {
        consider({ date: `${m[1]}-${m[2]}-${m[3]}`, precise: true })
      }
      continue
    }
    m = seg.match(/(?<!\d)(\d{2})(\d{2})(\d{2})(?!\d)/)
    if (m) {
      if (isValidYmd(2000 + Number(m[1]), Number(m[2]), Number(m[3]))) {
        consider({ date: `${2000 + Number(m[1])}-${m[2]}-${m[3]}`, precise: true })
      }
      continue
    }
    m = seg.match(/(?<!\d)(\d{4})년(?!\d)/)
    if (m) {
      const y = Number(m[1])
      if (y >= 1900 && y <= 2100) consider({ date: `${m[1]}-01-01`, precise: false })
      continue
    }
    if (/^\d{4}$/.test(seg)) {
      const y = Number(seg)
      if (y >= 1900 && y <= 2100) consider({ date: `${seg}-01-01`, precise: false })
      continue
    }
  }
  return found
}

/** 발행일시가 UTC 자정 정확히 일치하는지 — 날짜만 있는 값의 흔적 판정용. */
export function isExactlyMidnightUtc(publishedDate: string | undefined): boolean {
  if (!publishedDate || !publishedDate.includes('T')) return false
  const t = Date.parse(publishedDate)
  if (Number.isNaN(t)) return false
  const d = new Date(t)
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0
}

/**
 * 뉴스 윈도우(어제~오늘) 안의 항목만 남긴다.
 * URL에서 읽은 날짜가 윈도우 밖이면 발행일과 무관하게 제외하고,
 * treatMidnightAsUnknown이면 UTC 자정 발행은 URL 날짜의 뒷받침이 있을 때만 인정한다.
 */
export function filterNewsWindow(
  items: SearchSource[],
  startDate: string,
  endDate: string,
  opts?: { treatMidnightAsUnknown?: boolean },
): SearchSource[] {
  const start = Date.parse(`${startDate}T00:00:00+09:00`)
  const end = Date.parse(`${endDate}T23:59:59.999+09:00`)
  if (Number.isNaN(start) || Number.isNaN(end)) return []
  return items.filter((s) => {
    const urlDate = extractUrlDate(s.url || '')
    if (urlDate) {
      if (urlDate.precise) {
        if (urlDate.date < startDate || urlDate.date > endDate) return false
      } else {
        const y = urlDate.date.slice(0, 4)
        if (y < startDate.slice(0, 4) || y > endDate.slice(0, 4)) return false
      }
    }
    if (!s.publishedDate) return false
    const t = Date.parse(s.publishedDate)
    if (Number.isNaN(t)) return false
    if (t < start || t > end) return false
    if (opts?.treatMidnightAsUnknown && isExactlyMidnightUtc(s.publishedDate)) {
      const corroborated = !!urlDate && urlDate.precise && urlDate.date >= startDate && urlDate.date <= endDate
      if (!corroborated) return false
    }
    return true
  })
}

/** 최신 뉴스를 못 찾았을 때의 정직한 안내문 (오래된 뉴스를 오늘 것으로 보이지 않는다). */
export function noFreshNewsText(today: Date = new Date()): string {
  return `오늘(${kstTodayStr(today)}) 기준 최신 뉴스를 찾지 못했어요. 오늘·어제 날짜의 기사가 검색되지 않아서, 오래된 뉴스를 오늘 뉴스로 보여주지 않았어요. 다른 키워드로 다시 물어봐 주세요.`
}

/** Exa 뉴스 검색 파라미터 (윈도우·국내 위치 고정). */
export function exaNewsParams(now: Date = new Date()): {
  category: 'news'
  startPublishedDate: string
  endPublishedDate: string
  userLocation: 'KR'
} {
  const { startDate, endDate } = newsWindow(now)
  return { category: 'news', startPublishedDate: startDate, endPublishedDate: endDate, userLocation: 'KR' }
}
