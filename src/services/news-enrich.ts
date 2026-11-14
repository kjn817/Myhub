import {
  clusterNewsItems,
  formatPublishedKst,
  resolvePublisher,
  NEWS_BODY_MAX_CHARS,
  NEWS_BODY_MIN_CHARS,
} from '../lib/news-answer'
import { withTimeout } from '../lib/deadline'
import { metaContent } from '../lib/html-meta'

export const NEWS_BODY_FETCH_TIMEOUT_MS = 4000
export const NEWS_BODY_FETCH_CONCURRENCY = 3
export const NEWS_HTML_MAX_CHARS = 1000000
export const NEWS_OG_DESC_MIN_CHARS = 60
export const NEWS_PARAGRAPH_MIN_CHARS = 24

const ARTICLE_FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
}

export interface NewsEnrichCandidate {
  title: string
  url: string
  publishedDate?: string
  highlights?: string[]
  publisher?: string
}

export interface EnrichedClusterItem {
  title: string
  url: string
  publisher: string
  publishedDate?: string
  publishedKst?: string
  bodyText?: string
  highlights?: string[]
  groundedBy: 'body' | 'highlights'
  crossRefs: Array<{ publisher: string; title: string; url: string }>
}

export interface EnrichNewsItemsOpts {
  fetchFn?: typeof fetch
  perFetchTimeoutMs?: number
  concurrency?: number
  requestedCount: number
  now?: Date
}

export interface EnrichNewsItemsResult {
  items: EnrichedClusterItem[]
  candidateCount: number
  clusterCount: number
  droppedUngrounded: number
  bodyOk: number
  bodyFailed: number
}

type FetchFn = (input: string, init?: any) => Promise<Response>

function decodeEntities(s: string): string {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n)
      return code > 0 && code <= 1114111 ? String.fromCodePoint(code) : ' '
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const code = parseInt(h, 16)
      return code > 0 && code <= 1114111 ? String.fromCodePoint(code) : ' '
    })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function htmlToText(fragment: string): string {
  return decodeEntities(String(fragment || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/** og:description·description 메타에서 본문 요약 후보를 찾는다 (엔티티 디코드 + trim). */
function metaDescription(html: string, attr: 'property' | 'name', value: string): string | undefined {
  return metaContent(html, attr, value, (content) => decodeEntities(content).trim())
}

function findJsonLdBody(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findJsonLdBody(v)
      if (found) return found
    }
    return undefined
  }
  const obj = value as Record<string, unknown>
  if (typeof obj.articleBody === 'string' && obj.articleBody.trim()) return obj.articleBody
  for (const key of Object.keys(obj)) {
    const found = findJsonLdBody(obj[key])
    if (found) return found
  }
  if (typeof obj.description === 'string' && obj.description.trim()) return obj.description
  return undefined
}

function jsonLdBody(html: string): string | undefined {
  const blocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || []
  for (const block of blocks) {
    const inner = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '')
    try {
      const found = findJsonLdBody(JSON.parse(inner))
      if (found) return found
    } catch {
      const m = inner.match(/"articleBody"\s*:\s*"((?:[^"\\]|\\.)*)"/)
      if (m) {
        try {
          return JSON.parse(`"${m[1]}"`)
        } catch {
          return m[1]
        }
      }
    }
  }
  return undefined
}

function isBoilerplateParagraph(p: string): boolean {
  return /(무단\s*전재|재배포\s*(금지|불가)|저작권자\s*©|ⓒ\s*[^\s]+\s*무단|AI\s*학습\s*및\s*활용\s*금지)/.test(p)
}

function capBody(text: string): string {
  const t = String(text || '').replace(/\s+\n/g, '\n').trim()
  if (t.length <= NEWS_BODY_MAX_CHARS) return t
  const slice = t.slice(0, NEWS_BODY_MAX_CHARS)
  const lastStop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('다. '), slice.lastIndexOf('요. '))
  return (lastStop > NEWS_BODY_MAX_CHARS * 0.6 ? slice.slice(0, lastStop + 1) : slice).trim()
}

export function extractArticleBodyText(html: string): string | undefined {
  if (!html) return undefined
  const ld = jsonLdBody(html)
  if (ld) {
    const text = htmlToText(ld)
    if (text.length >= NEWS_BODY_MIN_CHARS) return capBody(text)
  }
  const cleaned = String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const seen = new Set<string>()
  const paras: string[] = []
  for (const m of cleaned.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = htmlToText(m[1])
    if (text.length < NEWS_PARAGRAPH_MIN_CHARS) continue
    if (isBoilerplateParagraph(text)) continue
    if (seen.has(text)) continue
    seen.add(text)
    paras.push(text)
  }
  const joined = paras.join('\n')
  if (joined.length >= NEWS_BODY_MIN_CHARS) return capBody(joined)
  const og = metaDescription(html, 'property', 'og:description') || metaDescription(html, 'name', 'description')
  if (og && og.length >= NEWS_OG_DESC_MIN_CHARS) return capBody(og)
  return undefined
}

export async function fetchArticleBodyText(
  url: string,
  fetchFn: FetchFn = fetch as FetchFn,
  timeoutMs: number = NEWS_BODY_FETCH_TIMEOUT_MS
): Promise<string | undefined> {
  if (!/^https?:\/\//i.test(String(url || ''))) return undefined
  try {
    const res = await withTimeout(
      fetchFn(url, {
        headers: ARTICLE_FETCH_HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      }),
      timeoutMs,
      `news body fetch timeout: ${String(url).slice(0, 80)}`
    )
    if (!res.ok) return undefined
    const html = await res.text()
    return extractArticleBodyText(html.slice(0, NEWS_HTML_MAX_CHARS))
  } catch {
    return undefined
  }
}

async function enrichCluster(
  members: NewsEnrichCandidate[],
  fetchFn: FetchFn,
  timeoutMs: number,
  stats: { bodyOk: number; bodyFailed: number }
): Promise<EnrichedClusterItem | null> {
  let representative: NewsEnrichCandidate | undefined
  let bodyText: string | undefined
  for (const member of members) {
    const body = await fetchArticleBodyText(member.url, fetchFn, timeoutMs)
    if (body) {
      stats.bodyOk++
      representative = member
      bodyText = body
      break
    }
    stats.bodyFailed++
  }
  let groundedBy: 'body' | 'highlights'
  let highlights: string[] | undefined
  if (!representative) {
    const withHighlights = members.find(
      (m) => Array.isArray(m.highlights) && m.highlights.length > 0
    )
    if (!withHighlights) return null
    representative = withHighlights
    highlights = (withHighlights.highlights as string[]).slice(0, 2)
    groundedBy = 'highlights'
  } else {
    groundedBy = 'body'
  }
  const publisher = resolvePublisher(representative)
  const crossRefs: Array<{ publisher: string; title: string; url: string }> = []
  const seenPublishers = new Set<string>([publisher])
  for (const m of members) {
    if (m === representative) continue
    const p = resolvePublisher(m)
    if (seenPublishers.has(p)) continue
    seenPublishers.add(p)
    crossRefs.push({ publisher: p, title: m.title, url: m.url })
    if (crossRefs.length >= 3) break
  }
  return {
    title: representative.title,
    url: representative.url,
    publisher,
    publishedDate: representative.publishedDate,
    publishedKst: formatPublishedKst(representative.publishedDate),
    ...(bodyText ? { bodyText } : {}),
    ...(highlights ? { highlights } : {}),
    groundedBy,
    crossRefs,
  }
}

export async function enrichNewsItems(
  candidates: NewsEnrichCandidate[],
  opts: EnrichNewsItemsOpts
): Promise<EnrichNewsItemsResult> {
  const fetchFn = (opts.fetchFn ?? fetch) as FetchFn
  const timeoutMs = opts.perFetchTimeoutMs ?? NEWS_BODY_FETCH_TIMEOUT_MS
  const concurrency = Math.max(1, opts.concurrency ?? NEWS_BODY_FETCH_CONCURRENCY)
  const requested = Math.max(1, opts.requestedCount)
  const clusters = clusterNewsItems(candidates)
  const stats = { bodyOk: 0, bodyFailed: 0 }
  const byIndex = new Map<number, EnrichedClusterItem>()
  let grounded = 0
  let processedClusters = 0
  for (let start = 0; start < clusters.length && grounded < requested; start += concurrency) {
    const batch = clusters.slice(start, start + concurrency)
    const results = await Promise.all(
      batch.map((c) => enrichCluster(c.members, fetchFn, timeoutMs, stats))
    )
    processedClusters += batch.length
    results.forEach((r, i) => {
      if (r) {
        byIndex.set(start + i, r)
        grounded++
      }
    })
  }
  const items = [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .slice(0, requested)
  const result: EnrichNewsItemsResult = {
    items,
    candidateCount: candidates.length,
    clusterCount: clusters.length,
    // 처리했지만 근거가 없어 제외한 묶음 수 (요청 수 도달로 시작조차 안 한
    // 묶음은 세지 않는다).
    droppedUngrounded: processedClusters - byIndex.size,
    bodyOk: stats.bodyOk,
    bodyFailed: stats.bodyFailed,
  }
  console.log(
    '[news-enrich]',
    JSON.stringify({
      candidates: result.candidateCount,
      clusters: result.clusterCount,
      grounded: items.length,
      requested,
      droppedUngrounded: result.droppedUngrounded,
      bodyOk: result.bodyOk,
      bodyFailed: result.bodyFailed,
    })
  )
  return result
}
