/**
 * 기사 날짜 직접 검증 (2026-10-26 트랙 A2 — docs/github-apply-research-20261026.md 1-2절)
 *
 * 배경: Exa publishedDate가 가짜인 것이 라이브 tail 로그로 확정됨 — 오래된
 * 글에 최근 날짜 스탬프, 다수가 정확히 자정 UTC. URL 날짜 가드(7089ef9)로
 * 10건 중 6건은 제외되나 잔존 간극 1건이 남았다: bbcbreakingnews 미러 —
 * 가짜지만 자정이 아닌 시각(21:23:30) + 날짜 없는 URL이라 신호만으로 구분
 * 불가. 유일하게 믿을 수 있는 것은 기사 페이지 자체의 날짜다.
 *
 * 패턴 출처 (코드 복사 아님, 패턴만 TS로 포팅 — Python 설치 금지):
 * - newspaper3k (MIT): <meta property="article:published_time">·JSON-LD 등에서
 *   publish_date 추출.
 * - trafilatura (Apache-2.0): 메타데이터(JSON 출력 with_metadata=True) 추출.
 * - dateparser (BSD-3-Clause): 사람 읽는 날짜 파싱 — 한국어 "10월 26일"에 참고.
 *
 * 규칙 (strict 뉴스 모드):
 * - HTML 메타 날짜가 뉴스 창(어제~오늘 KST) 안이면 유지, publishedDate를
 *   검증된 날짜로 교체한다 (Exa 메타보다 페이지 자체가 믿을 만하다).
 * - fetch 실패·날짜 없음·창 밖이면 해당 항목을 제외한다 — 실패를 "신선함"으로
 *   간주하지 않는다.
 * - 체인 전체 deadline을 넘기지 않는다: deadline이 지나면 새 fetch를 시작하지
 *   않고, 이미 검증된 항목만 반환한다 (미검증 나머지는 제외 — 조용한 fail-open 금지).
 * - 라이브 fetch는 테스트에서 하지 않는다 — 테스트는 fixture HTML로 검증한다.
 */

import { kstTodayStr, type SearchSource } from '../lib/news-summary'
import { remainingMs, withTimeout } from '../lib/deadline'
import { metaContent } from '../lib/html-meta'

export interface ArticleDateWindow {
  startDate: string
  endDate: string
}

export type ArticleDateReason = 'verified' | 'fetch-failed' | 'no-date' | 'out-of-window'

export interface ArticleDateCheck {
  url: string
  reason: ArticleDateReason
  /** 검증된 발행일 (ISO). verified일 때만 있다. */
  verifiedDate?: string
}

export interface VerifyArticleDatesOpts {
  /** 테스트 주입용 fetch */
  fetchFn?: typeof fetch
  now?: Date
  /** epoch ms. 이 시각 이후에는 새 fetch를 시작하지 않는다. */
  deadline?: number
  /** 기사 1건당 fetch 타임아웃 (기본 5000). */
  perFetchTimeoutMs?: number
  /** 병렬 fetch 수 (기본 3). */
  concurrency?: number
  /** 검증 성공 목표 수 (기본: 후보 전체). 도달하면 중단한다. */
  limit?: number
}

export const ARTICLE_FETCH_TIMEOUT_MS = 5000
export const ARTICLE_FETCH_CONCURRENCY = 3

const ARTICLE_FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
}

function isValidYmd(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/** KST 벽시계를 UTC ISO로 변환한다 (한국어 날짜에는 타임존 정보가 없다). */
function kstWallToIso(y: number, m: number, d: number, hh = 0, mm = 0): string | undefined {
  if (!isValidYmd(y, m, d) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return undefined
  return new Date(Date.UTC(y, m - 1, d, hh - 9, mm)).toISOString()
}

/**
 * 한국어·자유 형식 날짜 파싱 (dateparser 패턴 참고).
 * - "2026년 10월 26일", "2026년 10월 26일 21시 23분", "10월 26일"(연도는 now의 KST 연도)
 * - "2026.10.26", "2026/10/26" (Date.parse가 못 읽는 경우의 보조)
 * ISO·RFC 날짜는 Date.parse가 처리하므로 여기서는 한국어·점 표기만 다룬다.
 */
export function parseKoreanDate(text: string, now: Date = new Date()): string | undefined {
  const s = String(text || '').trim()
  if (!s) return undefined
  let m = s.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일(?:\s*(\d{1,2})\s*(?:[:시])\s*(\d{1,2})?\s*분?)?/)
  if (m) {
    return kstWallToIso(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0))
  }
  m = s.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일(?:\s*(\d{1,2})\s*(?:[:시])\s*(\d{1,2})?\s*분?)?/)
  if (m) {
    const year = Number(kstTodayStr(now).slice(0, 4))
    return kstWallToIso(year, Number(m[1]), Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0))
  }
  m = s.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/)
  if (m) {
    return kstWallToIso(Number(m[1]), Number(m[2]), Number(m[3]))
  }
  return undefined
}

/**
 * 날짜 문자열 파싱: ISO·RFC는 Date.parse, 한국어·점 표기는 parseKoreanDate.
 * 파싱 불가면 undefined.
 */
export function parseDateValue(raw: unknown, now: Date = new Date()): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const s = raw.trim()
  const t = Date.parse(s)
  if (!Number.isNaN(t)) return new Date(t).toISOString()
  return parseKoreanDate(s, now)
}

/** JSON-LD 블록 안에서 datePublished를 재귀 탐색한다. */
function findJsonLdDate(value: unknown, now: Date): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findJsonLdDate(v, now)
      if (found) return found
    }
    return undefined
  }
  const obj = value as Record<string, unknown>
  if (typeof obj.datePublished === 'string') {
    const parsed = parseDateValue(obj.datePublished, now)
    if (parsed) return parsed
  }
  for (const key of Object.keys(obj)) {
    const found = findJsonLdDate(obj[key], now)
    if (found) return found
  }
  return undefined
}

function jsonLdDate(html: string, now: Date): string | undefined {
  const blocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || []
  for (const block of blocks) {
    const inner = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '')
    try {
      const parsed = JSON.parse(inner)
      const found = findJsonLdDate(parsed, now)
      if (found) return found
    } catch {
      // JSON 파싱 실패 시 datePublished 문자열만 정규식으로 찾는다
      // (trafilatura도 같은 폴백을 쓴다 — 깨진 JSON-LD가 흔하다).
      const m = inner.match(/"datePublished"\s*:\s*"([^"]+)"/)
      if (m) {
        const parsed = parseDateValue(m[1], now)
        if (parsed) return parsed
      }
    }
  }
  return undefined
}

/**
 * HTML에서 기사 발행일을 추출한다 (newspaper3k·trafilatura 패턴).
 * 우선순위: article:published_time 메타 → JSON-LD datePublished →
 * <time datetime> → <time> 본문(한국어 날짜 포함) → publishdate/pubdate 메타.
 * 없으면 undefined (날짜 없음 = 신선도를 알 수 없음 — strict 모드에서 제외 사유).
 */
export function extractArticlePublishedDate(html: string, now: Date = new Date()): string | undefined {
  if (!html) return undefined
  const meta = metaContent(html, 'property', 'article:published_time')
  if (meta) {
    const parsed = parseDateValue(meta, now)
    if (parsed) return parsed
  }
  const ld = jsonLdDate(html, now)
  if (ld) return ld
  const timeAttr = html.match(/<time\b[^>]*datetime\s*=\s*["']([^"']+)["']/i)
  if (timeAttr) {
    const parsed = parseDateValue(timeAttr[1], now)
    if (parsed) return parsed
  }
  const timeTexts = [...html.matchAll(/<time\b[^>]*>([\s\S]*?)<\/time>/gi)]
  for (const m of timeTexts) {
    const text = m[1].replace(/<[^>]*>/g, ' ').trim()
    const parsed = parseDateValue(text, now)
    if (parsed) return parsed
  }
  for (const name of ['publishdate', 'pubdate', 'date']) {
    const v = metaContent(html, 'name', name)
    if (v) {
      const parsed = parseDateValue(v, now)
      if (parsed) return parsed
    }
  }
  return undefined
}

/**
 * 후보 기사를 직접 fetch해 HTML 메타 날짜로 신선도를 검증한다.
 * - 창 안이면 유지하고 publishedDate를 검증된 날짜로 교체한다.
 * - fetch 실패·날짜 없음·창 밖이면 제외한다 (strict — 실패를 신선함으로 간주 금지).
 * - limit에 도달하거나 후보가 떨어지거나 deadline이 지나면 중단한다.
 *   deadline 경과로 검증하지 못한 나머지는 제외한다 (fail-open 금지).
 */
export async function verifyArticleDates(
  items: SearchSource[],
  window: ArticleDateWindow,
  opts: VerifyArticleDatesOpts = {},
): Promise<{ verified: SearchSource[]; checks: ArticleDateCheck[] }> {
  const fetchFn = (opts.fetchFn ?? fetch) as (input: string, init?: any) => Promise<Response>
  const now = opts.now ?? new Date()
  const perFetchTimeoutMs = opts.perFetchTimeoutMs ?? ARTICLE_FETCH_TIMEOUT_MS
  const concurrency = Math.max(1, opts.concurrency ?? ARTICLE_FETCH_CONCURRENCY)
  const limit = opts.limit ?? items.length
  const deadline = opts.deadline
  const verified: SearchSource[] = []
  const checks: ArticleDateCheck[] = []

  const checkOne = async (item: SearchSource): Promise<void> => {
    const url = item.url
    try {
      const remain = deadline !== undefined ? remainingMs(deadline) : perFetchTimeoutMs
      // remain <= 0이면 timeoutMs <= 0 → withTimeout이 즉시 reject한다 (별도 분기 불필요 —
      // 배치는 동기적으로 시작하므로 이 지점에서 deadline이 지난 경우는 사실상 없음).
      const timeoutMs = Math.min(perFetchTimeoutMs, remain)
      const res = await withTimeout(
        fetchFn(url, {
          headers: ARTICLE_FETCH_HEADERS,
          signal: AbortSignal.timeout(timeoutMs),
        }),
        timeoutMs,
        `article fetch timeout: ${url.slice(0, 80)}`,
      )
      if (!res.ok) {
        checks.push({ url, reason: 'fetch-failed' })
        return
      }
      const html = await res.text()
      const published = extractArticlePublishedDate(html, now)
      if (!published) {
        checks.push({ url, reason: 'no-date' })
        return
      }
      const kstDate = kstTodayStr(new Date(published))
      if (kstDate < window.startDate || kstDate > window.endDate) {
        checks.push({ url, reason: 'out-of-window', verifiedDate: published })
        return
      }
      checks.push({ url, reason: 'verified', verifiedDate: published })
      verified.push({ ...item, publishedDate: published })
    } catch {
      // fetch 실패·타임아웃·본문 읽기 실패 모두 "검증 불가" → 제외
      checks.push({ url, reason: 'fetch-failed' })
    }
  }

  let idx = 0
  while (idx < items.length && verified.length < limit) {
    if (deadline !== undefined && Date.now() >= deadline) break
    // 목표까지 남은 수만큼만 묶어서 fetch한다 (limit 1인데 3개를 긁지 않음).
    const batchSize = Math.min(concurrency, limit - verified.length, items.length - idx)
    const batch = items.slice(idx, idx + batchSize)
    idx += batch.length
    await Promise.all(batch.map((item) => checkOne(item)))
  }
  // 배치 단위라 limit을 초과해 검증될 수 있다 — 목표 수만큼만 반환한다.
  return { verified: verified.slice(0, limit), checks }
}
