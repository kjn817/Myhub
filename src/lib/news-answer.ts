/**
 * 뉴스 답변 체인 — 본문까지 확인한 기사만으로 답을 만드는 재료·프롬프트·후처리.
 * 발행 매체 판정, 요청 개수 파싱, 동일 사안 클러스터링, 시의성 고지를 담당한다.
 */

import { kstTodayStr, newsWindow } from './news-summary'
import { KST_TIME_ZONE } from './kst'

export const NEWS_BODY_MAX_CHARS = 1200
export const NEWS_BODY_MIN_CHARS = 120
export const NEWS_CONTEXT_MAX_CHARS = 20000
export const NEWS_CHAIN_OVERFETCH = 3
export const NEWS_MAX_REQUEST = 10

const OUTLET_DOMAIN_NAMES: Record<string, string> = {
  'yna.co.kr': '연합뉴스',
  'hankyung.com': '한국경제',
  'mk.co.kr': '매일경제',
  'chosun.com': '조선일보',
  'donga.com': '동아일보',
  'joongang.co.kr': '중앙일보',
  'hani.co.kr': '한겨레',
  'khan.co.kr': '경향신문',
  'seoul.co.kr': '서울신문',
  'segye.com': '세계일보',
  'munhwa.com': '문화일보',
  'kukinews.com': '쿠키뉴스',
  'newsis.com': '뉴시스',
  'news1.kr': '뉴스1',
  'ytn.co.kr': 'YTN',
  'sbs.co.kr': 'SBS',
  'kbs.co.kr': 'KBS',
  'imbc.com': 'MBC',
  'jtbc.co.kr': 'JTBC',
  'tvchosun.com': 'TV조선',
  'channela.com': '채널A',
  'edaily.co.kr': '이데일리',
  'mt.co.kr': '머니투데이',
  'fnnews.com': '파이낸셜뉴스',
  'heraldcorp.com': '헤럴드경제',
  'asiae.co.kr': '아시아경제',
  'etnews.com': '전자신문',
  'zdnet.co.kr': 'ZD넷코리아',
  'bbc.com': 'BBC',
  'cnn.com': 'CNN',
  'reuters.com': '로이터',
  'apnews.com': 'AP',
}

/** 본문 확인까지 끝난 뉴스 항목 (교차 보도 포함). */
export interface EnrichedNewsItem {
  title: string
  url: string
  publisher: string
  publishedDate?: string
  publishedKst?: string
  bodyText?: string
  highlights?: string[]
  crossRefs: { publisher: string }[]
}

/** URL 호스트에서 언론사명을 판정한다 (서브도메인부터 접미 일치를 시도). */
export function publisherFromUrl(rawUrl: string): string {
  let host = ''
  try {
    host = new URL(String(rawUrl || '')).hostname.toLowerCase()
  } catch {
    return '출처 미상'
  }
  if (!host) return '출처 미상'
  const labels = host.split('.')
  for (let i = 0; i + 1 < labels.length; i++) {
    const cand = labels.slice(i).join('.')
    if (OUTLET_DOMAIN_NAMES[cand]) return OUTLET_DOMAIN_NAMES[cand]
  }
  return host.replace(/^www\./, '')
}

/** 명시된 발행처가 있으면 그것을, 없으면 URL에서 판정한다. */
export function resolvePublisher(item: { publisher?: unknown; url: string }): string {
  const explicit = item.publisher
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  return publisherFromUrl(item.url)
}

const KO_COUNT_WORDS: Record<string, number> = {
  한: 1,
  하나: 1,
  두: 2,
  둘: 2,
  세: 3,
  셋: 3,
  네: 4,
  넷: 4,
  다섯: 5,
  여섯: 6,
  일곱: 7,
  여덟: 8,
  아홉: 9,
  열: 10,
}
const KO_COUNT_RE = Object.keys(KO_COUNT_WORDS).sort((a, b) => b.length - a.length).join('|')

/** "3개", "세 건", "하나만" 같은 명시 개수 요청을 파싱한다. 없으면 null. */
export function parseExplicitNewsCount(userText: string): number | null {
  const t = String(userText || '')
  const m = t.match(/(\d{1,2})\s*(?:개|건)/)
  if (m) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n >= 1) return Math.min(n, NEWS_MAX_REQUEST)
  }
  const ko = t.match(new RegExp(`(${KO_COUNT_RE})\\s*(?:개|건)`))
  if (ko) return Math.min(KO_COUNT_WORDS[ko[1]], NEWS_MAX_REQUEST)
  if (/(?:하나)(?:만|를|을)(?![가-힣])/.test(t) || /하나만/.test(t)) return 1
  return null
}

/** "두 문장으로" 같은 문장 수 제한 요청을 파싱한다. 없으면 null. */
export function parseRequestedSentenceLimit(userText: string): number | null {
  const t = String(userText || '')
  const digit = t.match(/(\d{1,2})\s*문장/)
  if (digit) {
    const n = Number(digit[1])
    if (Number.isFinite(n) && n >= 1) return Math.min(n, NEWS_MAX_REQUEST)
  }
  const ko = t.match(new RegExp(`(${KO_COUNT_RE})\\s*문장`))
  if (ko) return Math.min(KO_COUNT_WORDS[ko[1]], NEWS_MAX_REQUEST)
  return null
}

/** 최종 요청 개수: 명시 개수 > (1문장 요청이면 1) > 기본값. */
export function parseRequestedNewsCount(userText: string, fallback = 5): number {
  const explicit = parseExplicitNewsCount(userText)
  if (explicit !== null) return explicit
  if (parseRequestedSentenceLimit(userText) === 1) return 1
  return fallback
}

/** 체인이 목표로 할 수집 개수 (중복·탈락을 감안해 여유분 추가, 상한 적용). */
export function newsChainTargetCount(requested: number): number {
  return Math.min(Math.max(1, requested) + NEWS_CHAIN_OVERFETCH, NEWS_MAX_REQUEST)
}

const TITLE_STOPWORDS = new Set([
  '속보',
  '단독',
  '종합',
  '뉴스',
  '오늘',
  '주요',
  '관련',
  '영상',
  '포토',
  '전문',
  '인터뷰',
  '기획',
  '분석',
  '라이브',
  '현장',
  '다시보기',
])

function stripTokenTail(token: string): string {
  let t = token
  if (t.length >= 3 && /\d/.test(t) && t.endsWith('원')) t = t.slice(0, -1)
  if (t.length >= 4 && t.endsWith('였다')) t = t.slice(0, -2)
  if (t.length >= 4 && /(에서|으로|까지|부터)$/.test(t)) t = t.slice(0, -2)
  else if (t.length >= 3 && /[도은는이가을를의에로와과만]$/.test(t)) t = t.slice(0, -1)
  return t
}

function titleTokens(title: string): Set<string> {
  const cleaned = String(title || '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/["“”'‘’「」『』()<>·•|/\\_-]/g, ' ')
  const toks = cleaned
    .split(/[^a-z0-9가-힣]+/)
    .filter((t) => t.length >= 2 && !TITLE_STOPWORDS.has(t))
    .map(stripTokenTail)
    .filter((t) => t.length >= 2)
  return new Set(toks)
}

function titleBigrams(title: string): Set<string> {
  const flat = String(title || '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[^a-z0-9가-힣]+/g, '')
  const out = new Set<string>()
  for (let i = 0; i + 1 < flat.length; i++) out.add(flat.slice(i, i + 2))
  return out
}

function jaccard(a: Set<string>, b: Set<string>): { inter: number; value: number } {
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return { inter, value: union === 0 ? 0 : inter / union }
}

const SAME_STORY_JACCARD = 0.34
const SAME_STORY_CONTAINMENT = 0.65
const SAME_STORY_BIGRAM_JACCARD = 0.3

/** 제목 유사도로 같은 사안인지 판정한다 (토큰 자카드/포함률, 실패 시 바이그램). */
export function isSameStory(titleA: string, titleB: string): boolean {
  const a = titleTokens(titleA)
  const b = titleTokens(titleB)
  if (a.size > 0 && b.size > 0) {
    const { inter, value } = jaccard(a, b)
    if (inter > 0) {
      if (value >= SAME_STORY_JACCARD) return true
      if (inter / Math.min(a.size, b.size) >= SAME_STORY_CONTAINMENT) return true
    }
  }
  const ba = titleBigrams(titleA)
  const bb = titleBigrams(titleB)
  if (ba.size < 4 || bb.size < 4) return false
  return jaccard(ba, bb).value >= SAME_STORY_BIGRAM_JACCARD
}

/** 같은 사안끼리 묶는다 (대표 기사는 각 클러스터의 첫 항목). */
export function clusterNewsItems<T extends { title: string }>(items: T[]): { members: T[] }[] {
  const clusters: { members: T[] }[] = []
  for (const item of items) {
    const found = clusters.find((c) => isSameStory(c.members[0].title, item.title))
    if (found) found.members.push(item)
    else clusters.push({ members: [item] })
  }
  return clusters
}

/** ISO 시각을 'M월 D일 오전/오후 H시 MM분' KST 표기로 바꾼다. 실패하면 undefined. */
export function formatPublishedKst(iso: string | undefined): string | undefined {
  if (!iso) return undefined
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return undefined
  try {
    const parts = new Intl.DateTimeFormat('ko-KR', {
      timeZone: KST_TIME_ZONE,
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).formatToParts(new Date(t))
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
    const minute = get('minute').padStart(2, '0')
    return `${get('month')} ${get('day')}일 ${get('dayPeriod')} ${get('hour')}시 ${minute}분`
  } catch {
    return undefined
  }
}

/** 본문 확인 결과를 모델 입력용 컨텍스트 문자열로 조립한다. */
export function formatEnrichedNewsContext(items: EnrichedNewsItem[]): string {
  return items
    .map((r, i) => {
      const lines = [`${i + 1}. 제목: ${r.title || '제목 없음'}`]
      lines.push(`   언론사: ${r.publisher}${r.publishedKst ? ` / 발행: ${r.publishedKst}` : ''}`)
      lines.push(`   URL: ${r.url}`)
      if (r.bodyText) {
        lines.push(`   본문 발췌: ${r.bodyText}`)
      } else if (r.highlights && r.highlights.length > 0) {
        lines.push(`   기사 발췌(본문 직접 확인 실패 — 검색 스니펫): ${r.highlights.join(' ')}`)
      }
      if (r.crossRefs.length > 0) {
        const names = r.crossRefs.map((c) => c.publisher).join(', ')
        lines.push(
          `   같은 사안 보도: ${names} — 이 사안은 대표 기사 포함 ${r.crossRefs.length + 1}개 언론사가 보도했다`,
        )
      } else {
        lines.push('   같은 사안 보도: 없음 — 현재 확인된 범위에서는 이 언론사 단독 보도다')
      }
      return lines.join('\n')
    })
    .join('\n')
}

/** 본문 확인 자료 기반의 뉴스 답변 프롬프트. */
export function buildNewsAnswerPrompt(opts: {
  query: string
  searchContext: string
  requested?: number
  found?: number
  today?: Date
  sentenceLimit?: number | null
}): string {
  const { query, searchContext, today } = opts
  const todayStr = kstTodayStr(today ?? new Date())
  const sentenceInstruction =
    opts.sentenceLimit != null
      ? `사용자가 ${opts.sentenceLimit}문장으로 답하라고 했다. 각 항목의 내용 요약은 ${opts.sentenceLimit}문장을 넘기지 마.\n`
      : ''
  return (
    `위 자료는 오늘 뉴스를 실제로 열어 본문까지 확인한 결과다. 자료:
${searchContext}

오늘 날짜는 ${todayStr}이다. "오늘 뉴스"는 이 날짜를 기준으로 한 최신 뉴스를 뜻한다.

` +
    sentenceInstruction +
    `[SEARCH: ${query}] 부분을 아래 형식으로 대체해:

자료의 사안을 번호 목록으로 정리한다. 항목마다 아래 네 가지를 모두 포함해:
1) 제목 (자료의 제목 그대로)
2) 언론사 · 발행 시각 (자료에 표기된 그대로)
3) 내용 요약 2~3문장 — 무슨 일이 있었는지, 본문 발췌에 실제로 있는 사실만으로 쓴다. 제목만 보고 내용을 추측하거나 자료에 없는 배경·수치·인용을 지어내지 않는다.
4) 교차 확인 한 줄 — 자료의 "같은 사안 보도"를 근거로: 다른 언론사도 보도했으면 그 언론사 이름과 함께 그 사실을, 단독 보도면 "단독 보도"라고 쓴다. 발췌들 사이에 수치나 주장이 다르면 그 차이를 적는다. 자료에 없는 언론사를 언급하지 않는다.
각 항목 끝에 반드시 해당 사안 대표 기사의 URL을 [출처](URL) 형태로 단다. URL은 자료에 있는 것만 쓰고, 교차 확인 줄에는 다른 언론사의 URL을 달지 않는다 (언론사 이름만 쓴다).
자료에 있는 사안 수만큼만 항목을 만든다 — 사안을 쪼개거나 없는 사안을 만들지 않는다. 최신 발행부터 쓴다. 불필요한 서론 없이 바로 목록부터 시작해.`
  )
}

const NEWS_ITEM_START_RE = /^\s*\d+[.)]\s/
const NEWS_MEMO_MARKER_RE = /\[MEMO_CREATE\][\s\S]*?\[\/MEMO_CREATE\]/

/** 답변의 번호 항목을 maxItems개로 자른다 ([MEMO_CREATE] 마커는 보존). */
export function limitNewsAnswerItems(text: string, maxItems: number): string {
  if (!text || maxItems < 1) return text
  const markerMatch = text.match(NEWS_MEMO_MARKER_RE)
  let body = text
  let tail = ''
  if (markerMatch && markerMatch.index !== undefined) {
    body = text.slice(0, markerMatch.index)
    tail = text.slice(markerMatch.index)
  }
  const lines = body.split('\n')
  const starts: number[] = []
  lines.forEach((line, i) => {
    if (NEWS_ITEM_START_RE.test(line)) starts.push(i)
  })
  if (starts.length <= maxItems) return text
  const kept = lines.slice(0, starts[maxItems])
  return kept.join('\n').replace(/\s+$/, '') + (tail ? `\n${tail}` : '')
}

/** 뉴스 윈도우(어제~오늘) 밖이거나 날짜를 알 수 없는 항목을 찾는다. */
export function findStaleNewsItems<T extends { publishedDate?: string }>(items: T[], now: Date = new Date()): T[] {
  const { startDate, endDate } = newsWindow(now)
  const start = Date.parse(`${startDate}T00:00:00+09:00`)
  const end = Date.parse(`${endDate}T23:59:59.999+09:00`)
  if (Number.isNaN(start) || Number.isNaN(end)) return [...items]
  return items.filter((it) => {
    if (!it.publishedDate) return true
    const t = Date.parse(it.publishedDate)
    return Number.isNaN(t) || t < start || t > end
  })
}

export function newsTimelinessNotice(staleCount: number, totalCount: number): string {
  return `※ 시의성 주의: 아래 ${totalCount}건 중 ${staleCount}건은 오늘·어제 날짜가 확인되지 않았습니다. 해당 항목은 오래된 기사일 수 있어 "오늘 뉴스"로 단정할 수 없습니다.`
}

/** 오래된 항목이 섞여 있으면 답변 앞에 시의성 주의를 붙인다 (중복 방지 포함). */
export function withNewsTimelinessNotice<T extends { publishedDate?: string }>(
  text: string,
  items: T[],
  now: Date = new Date(),
): string {
  if (!text || items.length === 0) return text
  const stale = findStaleNewsItems(items, now)
  if (stale.length === 0) return text
  if (text.includes('시의성 주의')) return text
  return `${newsTimelinessNotice(stale.length, items.length)}\n\n${text}`
}

export function newsShortfallNotice(requested: number, found: number): string {
  return `${requested}개를 요청하셨는데, 오늘·어제 날짜가 확인되고 본문까지 읽을 수 있었던 기사는 ${found}개였어요. 본문을 확인하지 못한 기사는 제목만으로 요약하지 않고 뺐습니다.`
}

export function noReadableNewsText(): string {
  return '오늘·어제 날짜의 뉴스는 찾았지만, 기사 본문을 열어 내용을 확인할 수 없어서 제목만으로 요약하지 않았어요. 잠시 뒤에 다시 시도해 주세요.'
}
