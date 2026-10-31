/**
 * 웹검색(Exa) 기반 뉴스 요약 품질
 * (2026-10-25: 뉴스 요약 결함 2건 수정)
 *
 * 결함 1 — 출처가 항목별로 안 묶임: 하단 "출처"가 "최신뉴스", "다음뉴스" 같은
 *   포털 이름 나열에 그치고, 각 항목마다 어느 기사에서 온 건지 링크가 없었음.
 *   → 후속 프롬프트에 항목별 [출처](URL) 형식을 강제하고,
 *      모델이 빠뜨린 항목은 attachMissingSources가 순서대로 보강한다.
 * 결함 2 — 카테고리 오분류: 전쟁 소식(흑해 러·우크라이나 상선 공격)이
 *   "날씨 및 재해"로 분류됨.
 *   → 뉴스 요약 프롬프트에 명시적인 카테고리 분류 체계를 넣는다.
 *
 * 순수 함수만 둔다 (Exa 호출 없음 — 테스트는 fixture/mock으로).
 */

import { pickFirstValidReference } from './citation-lock'

export interface SearchSource {
  title: string
  url: string
  /** Exa가 반환한 발행일 (ISO 8601). 없으면 신선도를 알 수 없음. */
  publishedDate?: string
}

/** 출처 신선도 기준: 이 일수보다 오래된 결과는 제외 대상 (기본 30일). */
export const SOURCE_MAX_AGE_DAYS = 30

/**
 * 뉴스 의도 판정: 뉴스 계열 질의면 Exa에 뉴스 카테고리 + 최근 30일 하한을 건다.
 * (2026-10-26 라이브 실측: 하한 없이 검색하면 2025-01-18자 연합뉴스 사이트맵
 *  같은 오래된 페이지가 최상위로 올라옴)
 */
export function isNewsQuery(query: string): boolean {
  return /뉴스|속보|헤드라인|브리핑|breaking/i.test(query || '')
}

/**
 * 뉴스 의도 판정 (마커 질의 + 사용자 원문).
 * 모델이 [SEARCH:] 마커에 주제만 넣고 "뉴스" 키워드를 빼도, 사용자가
 * 뉴스를 물었으면 뉴스 검색으로 취급한다 (2026-10-26 라이브 재실측:
 * 마커 질의만 보면 뉴스 파라미터가 안 걸려 2025년 1~4월 기사가
 * "오늘 뉴스"로 나옴 — 마커 질의 원문은 DB에 저장되지 않아 코드로 검증).
 */
export function resolveNewsIntent(markerQuery: string, userMessage: string): boolean {
  return isNewsQuery(markerQuery) || isNewsQuery(userMessage)
}

/** 뉴스 창: 어제~오늘 (KST 날짜, inclusive). "오늘 뉴스"에는 30일이 과도하다. */
export function newsWindow(now: Date = new Date()): { startDate: string; endDate: string } {
  return {
    startDate: kstTodayStr(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
    endDate: kstTodayStr(now),
  }
}

/** KST 기준 오늘 날짜를 "2026년 10월 26일" 형태로 반환한다. */
export function kstTodayKoStr(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}년 ${Number(get('month'))}월 ${Number(get('day'))}일`
}

/**
 * 뉴스 질의에 오늘 날짜를 문장으로 포함시킨다 (Exa Best Practices: "Put the
 * time window in the query").
 *
 * 2026-10-26 라이브 실측 (tail 로그): 모델이 [SEARCH:] 마커에 "2025년 1월
 * 22일" 같은 잘못된 날짜를 넣으면, 기존 날짜 보존 로직이 그 날짜를 Exa
 * 질의에 그대로 넘겨 결과를 오염시킨다. 그래서 날짜성 토큰은 제거하고
 * 실제 KST 오늘 날짜로 교체한다 (이미 올바른 오늘 날짜면 동일하게 나옴).
 */
export function buildDatedNewsQuery(query: string, now: Date = new Date()): string {
  const q = (query || '').trim()
  if (!q) return q
  return sanitizeNewsQueryDate(q, now)
}

/** 뉴스 질의에서 제거할 날짜성 토큰 패턴 (연-월-일 → 연-월 → 연 → ISO → 월-일 → bare 연도 순). */
const NEWS_QUERY_DATE_PATTERNS: RegExp[] = [
  /\d{4}년\s*\d{1,2}월\s*\d{1,2}일/g,
  /\d{4}년\s*\d{1,2}월/g,
  /\d{4}년/g,
  /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g,
  /\d{1,2}월\s*\d{1,2}일/g,
  /\b(?:19|20)\d{2}\b/g,
]

/**
 * 뉴스 질의 날짜 소독: 질의 안의 날짜성 토큰을 제거하고 실제 KST 오늘 날짜로
 * 교체한다. "어제"/"오늘" 같은 상대 표현은 건드리지 않는다 (오늘 기준 상대
 * 날짜라 질의를 오염시키지 않음). 날짜만 남은 질의는 날짜만 반환한다.
 */
export function sanitizeNewsQueryDate(query: string, now: Date = new Date()): string {
  let q = (query || '').trim()
  for (const re of NEWS_QUERY_DATE_PATTERNS) q = q.replace(re, ' ')
  q = q.replace(/\s+/g, ' ').trim()
  const today = kstTodayKoStr(now)
  return q ? `${today} ${q}` : today
}

function isValidYmd(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false
  // 뉴스 URL 가드용: 1900~2100년 밖은 날짜가 아니라 기사 ID 등이다
  // (예: /articleView/4157/ — 4157을 연도로 오인하면 신선한 기사까지 제외됨)
  if (y < 1900 || y > 2100) return false
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export interface ExtractedUrlDate {
  /** YYYY-MM-DD (연도만이면 YYYY-01-01) */
  date: string
  /** false면 연도만 알아낸 것 (정확한 일자 모름) */
  precise: boolean
}

/**
 * URL 경로에서 날짜를 추출한다 (2026-10-26 라이브 실측 — Exa publishedDate
 * 가짜 대응: 2025-01 BBC·2022년 아시아경제 랭킹 페이지에 2026-10-25/26
 * 날짜가 찍혀 있어 publishedDate만 믿으면 오래된 글이 통과함. URL 경로의
 * 날짜는 발행사가 정한 구조라 Exa 메타데이터보다 믿을 만하다).
 *
 * - 패턴: YYYY/MM/DD(연속 세그먼트), YYYY-MM-DD, YYYYMMDD, YYMMDD,
 *   YYYY년M월D일, YYYY년(연도만).
 * - 여러 날짜가 있으면 경로상 마지막 날짜를 쓴다 (기사 날짜는 보통 말단에
 *   오고, 앞쪽은 랭킹·카테고리 날짜인 경우가 있음 — asiae
 *   /ranking/nationwide/20260622/20250720 → 2025-07-20).
 * - 긴 숫자 ID 안에 끼인 8자리(예: 연합뉴스 AKR20261026011900011)는 날짜가
 *   아니다 — 숫자 경계(앞뒤 비숫자)를 요구해 제외한다.
 * - 6자리 숫자 ID가 우연히 유효한 YYMMDD면 날짜로 오인할 수 있다
 *   (예: /260315/) — 세그먼트 전체 + 달력 검증을 거치지만 잔존 위험이 있어
 *   이 함수는 strict 뉴스 모드의 보조 신호로만 쓴다.
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
    // 디코딩 실패하면 원문 경로 사용
  }
  const segments = path.split('/').filter(Boolean)
  let found: ExtractedUrlDate | null = null
  const consider = (cand: ExtractedUrlDate | null) => {
    if (cand) found = cand
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    // YYYY/MM/DD — 연속 3개 세그먼트 (모양이 맞으면 날짜로 보고, 무효여도
    // 연도만으로 떨어지지 않는다 — /2026/02/30/은 2026년 글이 아니다)
    if (
      /^\d{4}$/.test(seg) &&
      i + 2 < segments.length &&
      /^\d{1,2}$/.test(segments[i + 1]) &&
      /^\d{1,2}$/.test(segments[i + 2])
    ) {
      const y = Number(seg)
      const m = Number(segments[i + 1])
      const d = Number(segments[i + 2])
      if (isValidYmd(y, m, d)) {
        consider({ date: `${y}-${pad2(m)}-${pad2(d)}`, precise: true })
      }
      i += 2
      continue
    }
    // YYYY-MM-DD / YYYY.MM.DD (숫자 경계) — 모양이 맞으면 무효여도 다음 패턴으로 안 떨어진다
    let m = seg.match(/(?<!\d)(\d{4})[-.](\d{1,2})[-.](\d{1,2})(?!\d)/)
    if (m) {
      if (isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]))) {
        consider({ date: `${m[1]}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`, precise: true })
      }
      continue
    }
    // YYYY년M월D일
    m = seg.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/)
    if (m) {
      if (isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]))) {
        consider({ date: `${m[1]}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`, precise: true })
      }
      continue
    }
    // YYYYMMDD (8자리, 숫자 경계)
    m = seg.match(/(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/)
    if (m) {
      if (isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]))) {
        consider({ date: `${m[1]}-${m[2]}-${m[3]}`, precise: true })
      }
      continue
    }
    // YYMMDD (6자리, 숫자 경계 — 20xx년으로 해석)
    m = seg.match(/(?<!\d)(\d{2})(\d{2})(\d{2})(?!\d)/)
    if (m) {
      if (isValidYmd(2000 + Number(m[1]), Number(m[2]), Number(m[3]))) {
        consider({ date: `${2000 + Number(m[1])}-${m[2]}-${m[3]}`, precise: true })
      }
      continue
    }
    // YYYY년 (연도만 — 1900~2100 범위만)
    m = seg.match(/(?<!\d)(\d{4})년(?!\d)/)
    if (m) {
      const y = Number(m[1])
      if (y >= 1900 && y <= 2100) consider({ date: `${m[1]}-01-01`, precise: false })
      continue
    }
    // YYYY (연도만, 세그먼트 전체 — 1900~2100 범위만; /4157/ 같은 기사 ID 제외)
    if (/^\d{4}$/.test(seg)) {
      const y = Number(seg)
      if (y >= 1900 && y <= 2100) consider({ date: `${seg}-01-01`, precise: false })
      continue
    }
  }
  return found
}

/**
 * 발행일이 정확히 자정 UTC인지 판정한다 (2026-10-26 tail 로그 실측: Exa
 * 결과 10건 중 6건이 T00:00:00.000Z — 날짜를 모를 때 자정으로 찍는 것으로
 * 보이며, 그중 2025-01 BBC·2022년 아시아경제 같은 오래된 글이 섞여 있음).
 * 날짜만 있는 문자열("2026-10-26")은 자정이 파서 기본값이라 미상으로 보지
 * 않는다 (일자 자체는 알려진 정보). KST 자정(00:00+09:00)은 UTC 15:00이라
 * 해당하지 않는다.
 */
export function isExactlyMidnightUtc(publishedDate: string | undefined): boolean {
  if (!publishedDate || !publishedDate.includes('T')) return false
  const t = Date.parse(publishedDate)
  if (Number.isNaN(t)) return false
  const d = new Date(t)
  return (
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  )
}

/**
 * 뉴스 하드 필터: 창(어제~오늘 KST) 안의 발행일을 가진 결과만 남긴다.
 * 발행일이 없거나 파싱 불가한 결과는 버린다 (사이트맵·인덱스 페이지 차단 —
 * Exa 결과의 발행일 보유율은 46%에 불과해 날짜 없는 결과를 믿을 수 없음,
 * 2026-10-26 조사).
 *
 * 2026-10-26 라이브 실측 추가 가드:
 * - URL 날짜 가드: URL 경로에 창 밖 날짜가 있으면 publishedDate와 무관하게
 *   제외한다 (Exa publishedDate가 가짜인 경우가 실측됨 — 2025-01 BBC·
 *   2022년 아시아경제에 2026-10-25/26 날짜가 찍혀 있음).
 * - 자정 UTC 규칙 (opts.treatMidnightAsUnknown, Exa 전용): 발행일이 정확히
 *   자정 UTC면 "날짜 미상"으로 취급해 제외한다. 단, URL 날짜가 창 안으로
 *   확증되면 유지한다. 전 소스에 걸지 않는 이유: 네이버·RSS·Tavily는
 *   발행사가 준 실제 시각이라 09:00 KST 정각(= 자정 UTC) 발행이 진짜로
 *   있음 — Exa에서만 가짜 자정이 실측됨.
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
        // 연도만: 창 연도 범위 밖이면 제외 (창 안 연도면 판단 불가라 유지)
        const y = urlDate.date.slice(0, 4)
        if (y < startDate.slice(0, 4) || y > endDate.slice(0, 4)) return false
      }
    }
    if (!s.publishedDate) return false
    const t = Date.parse(s.publishedDate)
    if (Number.isNaN(t)) return false
    if (t < start || t > end) return false
    if (opts?.treatMidnightAsUnknown && isExactlyMidnightUtc(s.publishedDate)) {
      const corroborated =
        !!urlDate && urlDate.precise && urlDate.date >= startDate && urlDate.date <= endDate
      if (!corroborated) return false
    }
    return true
  })
}

/** KST 기준 오늘 날짜 (YYYY-MM-DD). "오늘" 표시는 사용자의 날짜 기준이다. */
export function kstTodayStr(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/**
 * 신선한 뉴스가 없을 때의 결정적 답변 (뉴스 의도 전용).
 * 오래된 기사를 "오늘 뉴스"로 제시하는 대신, 찾지 못했음을 정직하게 말한다.
 * [SEARCH:] 마커를 포함하지 않으므로 원문 노출이 없다.
 */
export function noFreshNewsText(today: Date = new Date()): string {
  return `오늘(${kstTodayStr(today)}) 기준 최신 뉴스를 찾지 못했어요. 오늘·어제 날짜의 기사가 검색되지 않아서, 오래된 뉴스를 오늘 뉴스로 보여주지 않았어요. 다른 키워드로 다시 물어봐 주세요.`
}

/**
 * Exa 뉴스 검색용 추가 파라미터 (뉴스 카테고리 + 1~2일 창 + 한국 지역).
 * (2026-10-26 조사: "오늘 뉴스"에 30일 창은 과도하고 Exa는 의미 랭킹
 *  엔진이라 날짜는 2차 신호 — 창을 어제~오늘으로 좁히고 endPublishedDate로
 *  미래 날짜 오표기도 함께 거른다. startPublishedDate는 여전히 유효.
 *  type 미지정(auto) 유지 — neural/keyword는 현재 타입 표에 없음.)
 */
export function exaNewsParams(now: Date = new Date()): { category: 'news'; startPublishedDate: string; endPublishedDate: string; userLocation: 'KR' } {
  const { startDate, endDate } = newsWindow(now)
  return { category: 'news', startPublishedDate: startDate, endPublishedDate: endDate, userLocation: 'KR' }
}

/**
 * 출처 URL 정규화 (중복·유효성 판정용).
 * - 앞뒤 공백 제거, fragment(#...) 제거, 말단 슬래시 1개 제거.
 * - 호스트는 소문자로 (경로는 대소문자 유지).
 */
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
    // 말단 슬래시를 전부 제거한다 — 1개만 떼면 '//' URL이 정규화 후에도
    // 슬래시를 남겨 멱등성이 깨지고 dedupe가 중복을 못 잡는다
    while (u.endsWith('/')) u = u.slice(0, -1)
  }
  return u
}

/** 정규화 URL 기준 중복 출처 제거 (첫 등장만 유지, 순서 유지). */
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
 * 신선도 필터: 발행일이 알려진 출처 중 기준을 초과한 것은 제외한다.
 * - 발행일이 없거나 파싱 불가한 출처는 판단 불가라 유지한다 (기본 모드).
 * - 전부 제외될 상황이면(신선한 출처가 하나도 없음) 원본을 그대로 둔다.
 *   (과거 주제 검색에서 결과를 통째로 비우지 않기 위함)
 * - strict=true면 fail-open 하지 않고 빈 목록을 반환한다.
 *   (뉴스 질의 전용: 오래된 기사를 "오늘 뉴스"로 제시하지 않기 위함)
 * - strict=true면 발행일 없는 출처도 버린다 (2026-10-26 조사: 날짜 없는
 *   결과 유지가 사이트맵·인덱스 페이지 유입 구멍 — Exa 발행일 보유율 46%).
 */
export function filterFreshSources(
  sources: SearchSource[],
  maxAgeDays: number = SOURCE_MAX_AGE_DAYS,
  now: Date = new Date(),
  strict: boolean = false,
): SearchSource[] {
  if (sources.length === 0) return sources
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000
  const kept = sources.filter((s) => {
    // strict 모드(뉴스 질의): 발행일 없는 출처는 판단 불가라 버린다.
    if (!s.publishedDate) return !strict
    const t = Date.parse(s.publishedDate)
    if (Number.isNaN(t)) return !strict
    return t >= cutoff
  })
  if (kept.length > 0) return kept
  return strict ? [] : sources
}

/**
 * 뉴스 카테고리 분류 체계 (모델 지시용).
 * - 전쟁·분쟁·군사 충돌·테러는 국제(또는 사건·사고)이고 절대 날씨·재해가 아님.
 * - 날씨·재해에는 실제 기상·자연재해만 해당.
 */
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

/**
 * [SEARCH:] 2차 호출용 후속 프롬프트를 만든다.
 * - 각 항목 끝에 해당 번호 검색 결과의 URL을 [출처](URL) 형태로 달 것을 지시한다.
 * - URL을 지어내지 않고 주어진 목록의 URL만 쓰게 한다.
 * - 뉴스 요약 시 카테고리 분류 체계를 따르게 한다.
 * - [MEMO_CREATE] 지시는 기존 동작 그대로 유지한다.
 */
export function buildSearchFollowUpPrompt(opts: { query: string; searchContext: string; today?: Date }): string {
  const { query, searchContext, today } = opts
  const todayStr = kstTodayStr(today ?? new Date())
  return (
    `위 웹검색 결과를 바탕으로 답변을 완성해줘. 검색 결과:\n${searchContext}\n\n` +
    `오늘 날짜는 ${todayStr}이다. "오늘 뉴스"는 이 날짜를 기준으로 한 최신 뉴스를 뜻한다.\n\n` +
    `[SEARCH: ${query}] 부분을 아래 형식으로 대체해:\n\n` +
    `각 뉴스를 번호 목록으로 정리하고, 각 항목은 "N. 헤드라인: 한 줄 요약 — [출처](URL)" 형식으로 작성해. ` +
    `각 항목 끝에 반드시 해당 번호 검색 결과의 URL을 [출처](URL) 형태로 달 것. ` +
    `URL을 지어내지 말고 주어진 검색 결과 목록의 URL만 사용할 것. ` +
    `각 항목마다 서로 다른 URL을 하나씩만 달 것 — 같은 URL을 두 항목에 달지 말 것. ` +
    `검색 결과 개수만큼만 항목을 만들 것 — 결과를 초과해 항목을 늘리지 말 것. ` +
    `날짜가 표시된 결과는 최신 것부터 쓰고, 30일 이상 지난 결과는 인용하지 말 것. ` +
    `출처가 없는 항목을 만들지 말 것. ` +
    `불필요한 서론 없이 바로 목록부터 시작해.\n\n` +
    `${NEWS_CATEGORY_GUIDE}\n\n` +
    `중요: 원본 사용자 요청에 "메모작성" 또는 "메모 작성"이 포함되어 있으면, 요약 뒤에 반드시 [MEMO_CREATE]{"title": "오늘 주요 뉴스", "text": "요약내용"}[/MEMO_CREATE] 마커를 출력해서 메모를 생성해.`
  )
}

const ITEM_START_RE = /^\s*\d+[.)]\s/
const URL_RE = /https?:\/\/\S+/
const MEMO_MARKER_RE = /\[MEMO_CREATE\][\s\S]*?\[\/MEMO_CREATE\]/

/** 텍스트 안의 모든 URL을 추출한다 (마크다운 링크와 bare URL 모두). */
const MD_LINK_RE = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g
const BARE_URL_RE = /https?:\/\/[^\s)>\]]+/g

export function extractUrlsFromText(block: string): string[] {
  const urls: string[] = []
  for (const m of block.matchAll(MD_LINK_RE)) urls.push(m[1])
  const withoutLinks = block.replace(MD_LINK_RE, ' ')
  for (const m of withoutLinks.matchAll(BARE_URL_RE)) urls.push(m[0])
  return urls
}

export interface SourceLink {
  title: string
  url: string
}

/**
 * 최종 응답의 sources를 최종 텍스트에 실제 표시된 링크와 일치시킨다
 * (2026-10-26 실측: [SEARCH:] 2차 검색이 텍스트를 갈아엎으면 sources가
 * 이전 체인 결과로 남는 불일치 — 최종 텍스트 링크는 신선한 연합뉴스인데
 * sources[]는 오래된 것).
 * - 기존 sources 중 최종 텍스트에 URL이 남아 있는 것만 유지
 * - 치환 과정에서 실제 삽입된 항목을 병합 (검색 결과에서만 오므로 지어낸
 *   URL은 들어갈 수 없음)
 * - 정규화 URL 기준 중복 제거 (기존 우선, 순서 유지)
 */
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
 *
 * attachMissingSources(누락만 보강)와 달리, 이미 있는 URL도 검증·교체한다.
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
    // (허용 집합 기준 선택은 citation-lock 공용 코어 — 메모리 인용 검증과 공유)
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

/**
 * 항목별 출처 보강: 번호 목록에서 URL이 없는 항목 끝에
 * 같은 순서의 검색 결과 URL을 [출처](URL) 형태로 붙인다.
 *
 * 안전장치:
 * - 항목 수와 출처 수가 다르면 오인 연결을 막기 위해 원문을 그대로 둔다.
 * - 이미 URL이 있는 항목은 건드리지 않는다.
 * - [MEMO_CREATE] 마커는 건드리지 않는다 (분리 후 원문 그대로 되붙임).
 */
export function attachMissingSources(text: string, sources: SearchSource[]): string {
  if (!text || sources.length === 0) return text
  // [MEMO_CREATE] 마커 분리 (마커 안의 번호 목록까지 건드리지 않기 위함)
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
  // 번호 항목이 없거나 출처 수와 다르면 원문 유지
  if (starts.length === 0 || starts.length !== sources.length) return text
  const out = [...lines]
  starts.forEach((startIdx, k) => {
    const endIdx = k + 1 < starts.length ? starts[k + 1] - 1 : lines.length - 1
    const block = lines.slice(startIdx, endIdx + 1).join('\n')
    if (URL_RE.test(block)) return
    const url = sources[k]?.url
    if (!url) return
    out[endIdx] = `${lines[endIdx]} — [출처](${url})`
  })
  return out.join('\n') + tail
}
