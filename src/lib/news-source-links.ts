/**
 * 뉴스 출처 링크 검증 — 모델 응답의 항목별 출처가 실제 검색 결과와 1:1로 묶이게 강제한다.
 * 공용 선택 코어(pickFirstValidReference)는 citation-lock에서 가져온다 (메모리 인용 검증과 공유).
 */

import { pickFirstValidReference } from './citation-lock'
import {
  kstTodayStr,
  normalizeSourceUrl,
  dedupeSources,
  filterFreshSources,
  SOURCE_MAX_AGE_DAYS,
  type SearchSource,
} from './news-core'

export interface SourceLink {
  title: string
  url: string
}

export const NEWS_CATEGORY_GUIDE = `뉴스를 정리할 때는 아래 카테고리 체계를 따를 것:
- 사건·사고 및 법조계: 범죄, 사고, 수사, 재판, 판결
- 국제: 전쟁, 분쟁, 군사 충돌, 테러, 외교, 해외 정치
- 날씨 및 재해: 비·눈·태풍·폭염·한파 같은 기상, 지진, 홍수, 산불 등 자연재해만 해당
- 정치: 국내 정치, 선거, 정부 정책
- 경제: 시장, 기업, 물가, 고용
- 사회: 교육, 보건, 복지, 일상
- 스포츠: 경기 결과, 선수, 대회
- 기술·과학: IT, 연구, 우주
- 문화·연예: 영화, 음악, 공연
분류 규칙:
- 전쟁·분쟁·군사 충돌·테러는 국제(또는 사건·사고)에 넣고, 절대 날씨 및 재해에 넣지 말 것.
- 날씨 및 재해에는 실제 기상·자연재해만 넣을 것. 사고·사건은 넣지 말 것.
- 애매한 항목은 가장 가까운 상위 범주를 쓰고, 없는 카테고리를 새로 만들지 말 것.
- 검색 결과에 없는 주제의 카테고리는 만들지 말 것.`

export const NEWS_ITEM_FORMAT_INSTRUCTION = `각 뉴스를 번호 목록으로 정리하고, 각 항목은 "N. 헤드라인: 한 줄 요약 — [출처](URL)" 형식으로 작성해. 각 항목 끝에 반드시 해당 번호 검색 결과의 URL을 [출처](URL) 형태로 달 것. URL을 지어내지 말고 주어진 검색 결과 목록의 URL만 사용할 것. 각 항목마다 서로 다른 URL을 하나씩만 달 것 — 같은 URL을 두 항목에 달지 말 것. 날짜가 표시된 결과는 최신 것부터 쓰고, ${SOURCE_MAX_AGE_DAYS}일 이상 지난 결과는 인용하지 말 것. 출처가 없는 항목을 만들지 말 것. 불필요한 서론 없이 바로 목록부터 시작해.`

const ITEM_START_RE = /^\s*\d+[.)]\s/
const MEMO_MARKER_RE = /\[MEMO_CREATE\][\s\S]*?\[\/MEMO_CREATE\]/
const MD_LINK_RE = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g
const BARE_URL_RE = /https?:\/\/[^\s)>\]]+/g

/** 검색 후속 프롬프트: 검색 결과를 항목별 출처 형식으로 답하게 지시한다. */
export function buildSearchFollowUpPrompt(opts: {
  query: string
  searchContext: string
  today?: Date
  maxItems?: number
  sentenceLimit?: number
  canCreateMemo?: boolean
}): string {
  const { query, searchContext, today } = opts
  const todayStr = kstTodayStr(today ?? new Date())
  const shapeInstruction =
    (opts.maxItems != null ? `사용자가 ${opts.maxItems}건만 요청했다. 항목은 ${opts.maxItems}개를 넘기지 마. ` : '') +
    (opts.sentenceLimit != null ? `각 항목의 요약은 ${opts.sentenceLimit}문장으로 써. ` : '')
  return (
    `위 웹검색 결과를 바탕으로 답변을 완성해줘. 검색 결과:
${searchContext}

오늘 날짜는 ${todayStr}이다. "오늘 뉴스"는 이 날짜를 기준으로 한 최신 뉴스를 뜻한다.

[SEARCH: ${query}] 부분을 아래 형식으로 대체해:

` +
    shapeInstruction +
    NEWS_ITEM_FORMAT_INSTRUCTION +
    ` 검색 결과 개수만큼만 항목을 만들 것 — 결과를 초과해 항목을 늘리지 말 것.

${NEWS_CATEGORY_GUIDE}` +
    (opts.canCreateMemo
      ? `

중요: 원본 사용자 요청에 "메모작성" 또는 "메모 작성"이 포함되어 있으면, 요약 뒤에 반드시 [MEMO_CREATE]{"title": "오늘 주요 뉴스", "text": "요약내용"}[/MEMO_CREATE] 마커를 출력해서 메모를 생성해.`
      : ``)
  )
}

/** 블록 안의 모든 URL을 뽑는다 (마크다운 링크 우선, 나머지는 bare URL). */
export function extractUrlsFromText(block: string): string[] {
  const urls: string[] = []
  for (const m of block.matchAll(MD_LINK_RE)) urls.push(m[1])
  const withoutLinks = block.replace(MD_LINK_RE, ' ')
  for (const m of withoutLinks.matchAll(BARE_URL_RE)) urls.push(m[0])
  return urls
}

/** 최종 텍스트에 실제로 등장하는 URL의 출처만 남겨 병합한다. */
export function mergeSearchSources(
  existing: SourceLink[] | undefined,
  replacements: SourceLink[],
  finalText: string,
): SourceLink[] {
  const textUrls = new Set(extractUrlsFromText(finalText).map((u) => normalizeSourceUrl(u)))
  const out: SourceLink[] = []
  const seen = new Set<string>()
  const push = (s: SourceLink) => {
    const key = normalizeSourceUrl(s.url || '')
    if (!key || seen.has(key) || !textUrls.has(key)) return
    seen.add(key)
    out.push({ title: s.title || s.url, url: s.url })
  }
  for (const s of existing || []) push(s)
  for (const s of replacements) push(s)
  return out
}

/** 블록 안의 모든 URL을 제거한다. */
function stripUrls(block: string): string {
  // 출처 표기(" — [출처](URL)")는 라벨까지 통째로 제거한다
  let out = block.replace(/\s*—\s*\[[^\]]*\]\(https?:\/\/[^)\s]+\)/g, '')
  // 나머지 마크다운 링크는 링크 텍스트만 남긴다
  out = out.replace(/\[([^\]]*)\]\(https?:\/\/[^)\s]+\)/g, '$1')
  // bare URL 제거
  out = out.replace(BARE_URL_RE, '')
  // URL 제거로 생긴 빈 " — " 꼬리나 이중 공백을 정리한다
  out = out.replace(/[ \t]+—[ \t]*$/gm, '')
  out = out.replace(/[ \t]{2,}/g, ' ')
  return out
}

/**
 * 항목별 출처 결정적 검증: 모델 응답의 각 번호 항목이 Exa 결과 URL만,
 * 항목마다 서로 다른 URL을 하나씩 갖도록 강제한다.
 *
 * 규칙:
 * - Exa 결과에 없는 URL(지어낸 URL)은 제거한다.
 * - 같은 URL이 여러 항목에 있으면 첫 항목만 유지하고 나머지는 미사용 Exa URL로 교체한다.
 * - URL이 없는 항목에는 미사용 Exa URL을 순서대로 붙인다.
 * - 미사용 URL이 모자라면 해당 항목은 출처 없이 둔다 (URL을 지어내지 않는다).
 * - 항목 수와 출처 수가 다르면 오인 연결을 막기 위해 원문을 그대로 둔다.
 * - [MEMO_CREATE] 마커는 건드리지 않는다.
 */
export function validateItemSources(
  text: string,
  sources: SearchSource[],
  opts?: { maxAgeDays?: number; now?: Date },
): string {
  const pool = filterFreshSources(
    dedupeSources(sources),
    opts?.maxAgeDays ?? SOURCE_MAX_AGE_DAYS,
    opts?.now ?? new Date(),
  )
  if (!text || pool.length === 0) return text
  const markerMatch = text.match(MEMO_MARKER_RE)
  let body = text
  let tail = ''
  if (markerMatch && markerMatch.index !== undefined) {
    body = text.slice(0, markerMatch.index)
    tail = text.slice(markerMatch.index)
  }
  const lines = body.split('\n')
  const starts: number[] = []
  lines.forEach((line, i) => {
    if (ITEM_START_RE.test(line)) starts.push(i)
  })
  if (starts.length === 0 || starts.length !== pool.length) return text
  const allowed = new Map<string, string>()
  for (const s of pool) allowed.set(normalizeSourceUrl(s.url), s.url)
  const used = new Set<string>()
  const out = [...lines]
  starts.forEach((startIdx, k) => {
    const endIdx = k + 1 < starts.length ? starts[k + 1] - 1 : lines.length - 1
    const block = lines.slice(startIdx, endIdx + 1).join('\n')
    // 블록 안의 유효한(Exa 목록에 있고 미사용인) URL 중 첫 번째를 유지
    const candidates = extractUrlsFromText(block)
    const keptKey = pickFirstValidReference(
      candidates.map((u) => normalizeSourceUrl(u)),
      (norm) => allowed.has(norm),
      used,
    )
    let kept: string | null = null
    if (keptKey) {
      kept = allowed.get(keptKey)!
      used.add(keptKey)
    }
    if (!kept) {
      // 순서대로 미사용 URL을 하나 할당 (없으면 URL을 지우고 출처 없이 둔다)
      const next = pool.find((s) => !used.has(normalizeSourceUrl(s.url)))
      if (!next) {
        const cleaned = stripUrls(block)
        const cleanedLines = cleaned.split('\n')
        for (let i = 0; i < cleanedLines.length; i++) {
          out[startIdx + i] = cleanedLines[i]
        }
        return
      }
      kept = next.url
      used.add(normalizeSourceUrl(next.url))
    }
    const cleaned = stripUrls(block)
    const cleanedLines = cleaned.split('\n')
    // 말단 빈 줄을 제외한 블록 마지막 줄에 출처를 붙인다
    let lastIdx = cleanedLines.length - 1
    while (lastIdx > 0 && cleanedLines[lastIdx].trim() === '') lastIdx--
    cleanedLines[lastIdx] = `${cleanedLines[lastIdx].replace(/[ \t]+$/, '')} — [출처](${kept})`
    for (let i = 0; i < cleanedLines.length; i++) {
      out[startIdx + i] = cleanedLines[i]
    }
  })
  return out.join('\n') + tail
}
