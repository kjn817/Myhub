/**
 * 자연어 cron 파서 — Octop 자연어 cron 패턴 이식 (결정적 규칙 기반, zero-LLM)
 *
 * "매일 아침 8시에 브리핑해줘" 같은 한국어 시간 표현을 cron 스케줄로 바꾼다.
 * - LLM을 쓰지 않으므로 같은 입력은 항상 같은 결과를 낸다 (파싱 실패 시 null).
 * - 모든 시각은 KST wall-clock 기준. Cloudflare Cron Trigger는 UTC 전용이라
 *   UTC cron으로 변환하지 않고, 5분 틱 scheduled 핸들러가 KST로 due 판정을 한다
 *   (기존 scheduled.ts의 '-9 hours' 보정과 같은 방식).
 * - 지원: 매일/평일/주말/매주 요일/매월 날짜/ N분·N시간마다, 오전·오후·아침·점심·저녁·밤·새벽.
 */

export type NlCronAction = 'morning-briefing' | 'news-summary' | 'schedule-reminder' | 'generic'

export type NlCronKind = 'daily' | 'weekly' | 'monthly' | 'interval'

export interface NlCronSchedule {
  kind: NlCronKind
  /** KST wall-clock 시 (interval이면 0) */
  hour: number
  /** KST wall-clock 분 */
  minute: number
  /** WEEKLY: JS getDay() 기준 요일 집합 (0=일 … 6=토) */
  daysOfWeek: number[] | null
  /** MONTHLY: 날짜 (1–31) */
  dayOfMonth: number | null
  /** INTERVAL: 간격(분) */
  intervalMinutes: number | null
  timezone: 'Asia/Seoul'
  /** KST 기준 cron 표현식 (분 시 일 월 요일) */
  cronKst: string
}

export interface NlCronParse {
  action: NlCronAction
  schedule: NlCronSchedule
  /** 원문 (저장용) */
  original: string
}

const DAY_NAME: Record<string, number> = {
  '일': 0, '월': 1, '화': 2, '수': 3, '목': 4, '금': 5, '토': 6,
}

/** 시간대 단어만으로 정해지는 기본 시각 (시가 없을 때) */
const PERIOD_DEFAULT_HOUR: Record<string, number> = {
  '새벽': 6, '아침': 8, '점심': 12, '저녁': 19, '밤': 21,
}

const PERIOD_WORDS = ['오전', '오후', '아침', '점심', '저녁', '밤', '새벽'] as const

const HOUR_RE = /(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분|\s*반)?/
const INTERVAL_MIN_RE = /(\d{1,3})\s*분마다/
const INTERVAL_HOUR_RE = /(\d{1,2})\s*시간마다/
const MONTHLY_RE = /매월\s*(\d{1,2})\s*일/

function detectAction(text: string): NlCronAction {
  if (/브리핑/.test(text)) return 'morning-briefing'
  if (/뉴스/.test(text)) return 'news-summary'
  if (/알림|리마인드|리마인더|알려/.test(text)) return 'schedule-reminder'
  return 'generic'
}

/**
 * "오후 3시" → 15시, "오전 12시" → 0시.
 * 13시 이상은 이미 24시간 표기로 보고 변환하지 않는다.
 * 범위를 벗어나면 null.
 */
function convertHour(hour12: number, period: string | null): number | null {
  if (hour12 < 0 || hour12 > 24) return null
  if (hour12 === 0) return 0 // "0시" = 자정
  if (hour12 > 12) {
    if (hour12 > 23) return null
    return hour12 // 13–23시는 24시간 표기
  }
  if (period === '오후' || period === '저녁' || period === '밤' || period === '점심') {
    return hour12 === 12 ? 12 : hour12 + 12
  }
  // 오전/아침/새벽/없음
  if (period === '오전' || period === '아침' || period === '새벽') {
    return hour12 === 12 ? 0 : hour12
  }
  return hour12
}

/** 시 매치 앞쪽에서 가장 가까운 시간대 단어를 찾는다 */
function findPeriodBefore(text: string, hourIndex: number): string | null {
  const before = text.slice(0, hourIndex)
  let found: string | null = null
  let foundAt = -1
  for (const w of PERIOD_WORDS) {
    const at = before.lastIndexOf(w)
    if (at > foundAt) {
      foundAt = at
      found = w
    }
  }
  return found
}

function toCronKst(s: Omit<NlCronSchedule, 'cronKst' | 'timezone'>): string {
  const mm = String(s.minute)
  const hh = String(s.hour)
  switch (s.kind) {
    case 'daily':
      return `${mm} ${hh} * * *`
    case 'weekly':
      return `${mm} ${hh} * * ${(s.daysOfWeek ?? []).join(',')}`
    case 'monthly':
      return `${mm} ${hh} ${s.dayOfMonth} * *`
    case 'interval': {
      const n = s.intervalMinutes ?? 60
      if (n < 60) return `*/${n} * * * *`
      return `0 */${Math.floor(n / 60)} * * *`
    }
  }
}

function build(
  kind: NlCronKind,
  hour: number,
  minute: number,
  daysOfWeek: number[] | null,
  dayOfMonth: number | null,
  intervalMinutes: number | null,
): NlCronSchedule {
  const base = { kind, hour, minute, daysOfWeek, dayOfMonth, intervalMinutes }
  return { ...base, timezone: 'Asia/Seoul', cronKst: toCronKst(base) }
}

/**
 * 한국어 자연어 시간 표현을 파싱한다. 파싱 실패 시 null (추측 금지).
 *
 * 예:
 * - "매일 아침 8시에 브리핑해줘" → daily 08:00, morning-briefing
 * - "평일 아침 8시에 브리핑해줘" → weekly [1..5] 08:00
 * - "매주 월, 수, 금 오후 6시에 알려줘" → weekly [1,3,5] 18:00
 * - "매월 1일 오전 9시에 브리핑해줘" → monthly 1일 09:00
 * - "30분마다 알려줘" → interval 30분
 */
export function parseNlCron(text: string): NlCronParse | null {
  if (typeof text !== 'string') return null
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  const action = detectAction(normalized)

  // 1) 간격 ("30분마다", "2시간마다") — 시각 없음
  const minInterval = INTERVAL_MIN_RE.exec(normalized)
  if (minInterval) {
    const n = Number(minInterval[1])
    if (!Number.isInteger(n) || n < 1 || n > 59) return null
    return {
      action,
      original: text,
      schedule: build('interval', 0, 0, null, null, n),
    }
  }
  const hourInterval = INTERVAL_HOUR_RE.exec(normalized)
  if (hourInterval) {
    const n = Number(hourInterval[1])
    if (!Number.isInteger(n) || n < 1 || n > 23) return null
    return {
      action,
      original: text,
      schedule: build('interval', 0, 0, null, null, n * 60),
    }
  }

  // 2) 시각 ("오후 3시", "8시 30분", "8시 반", 또는 "아침"만)
  let hour: number | null = null
  let minute = 0
  const hourMatch = HOUR_RE.exec(normalized)
  if (hourMatch) {
    const rawHour = Number(hourMatch[1])
    let rawMinute = 0
    if (hourMatch[2] !== undefined) {
      rawMinute = Number(hourMatch[2])
    } else if (/반\s*$/.test(hourMatch[0]) || /\s반$/.test(hourMatch[0])) {
      rawMinute = 30
    }
    if (!Number.isInteger(rawMinute) || rawMinute < 0 || rawMinute > 59) return null
    const period = findPeriodBefore(normalized, hourMatch.index)
    const converted = convertHour(rawHour, period)
    if (converted === null) return null
    hour = converted
    minute = rawMinute
  } else {
    // 시가 없으면 시간대 단어의 기본 시각 사용 ("매일 아침에 브리핑해줘" → 8시)
    let defaultHour: number | null = null
    for (const w of Object.keys(PERIOD_DEFAULT_HOUR)) {
      if (normalized.includes(w)) {
        defaultHour = PERIOD_DEFAULT_HOUR[w]
        break
      }
    }
    if (defaultHour === null) return null // 시간 표현이 전혀 없음
    hour = defaultHour
  }

  // 3) 빈도
  const monthly = MONTHLY_RE.exec(normalized)
  if (monthly) {
    const dom = Number(monthly[1])
    if (!Number.isInteger(dom) || dom < 1 || dom > 31) return null
    return { action, original: text, schedule: build('monthly', hour, minute, null, dom, null) }
  }
  if (/평일/.test(normalized)) {
    return { action, original: text, schedule: build('weekly', hour, minute, [1, 2, 3, 4, 5], null, null) }
  }
  if (/주말/.test(normalized)) {
    return { action, original: text, schedule: build('weekly', hour, minute, [0, 6], null, null) }
  }
  if (/매주/.test(normalized)) {
    // 매주 뒤 ~ 시각 앞 구간에서 요일만 수집.
    // "수영" 같은 일반 단어의 요일 문자(수)를 오인하지 않도록
    // '요일' 접미사가 붙은 형태와 쉼표 목록("월, 수, 금요일")만 인정한다.
    const weekStart = normalized.indexOf('매주')
    const timeAt = hourMatch ? hourMatch.index : normalized.length
    const span = normalized.slice(weekStart, Math.max(weekStart, timeAt))
    const daySet = new Set<number>()
    for (const m of span.matchAll(/([월화수목금토일])요일/g)) {
      daySet.add(DAY_NAME[m[1]])
    }
    const list = /([월화수목금토일](?:\s*[,·、]\s*[월화수목금토일])+)\s*요일/.exec(span)
    if (list) {
      for (const ch of list[1]) {
        if (DAY_NAME[ch] !== undefined) daySet.add(DAY_NAME[ch])
      }
    }
    // 접미사 없는 쉼표 목록 ("매주 월, 수, 금 오후 6시") — 쉼표로 연결된 요일만 인정
    const bareList = /([월화수목금토일](?:\s*[,·、]\s*[월화수목금토일])+)/.exec(span)
    if (bareList) {
      for (const ch of bareList[1]) {
        if (DAY_NAME[ch] !== undefined) daySet.add(DAY_NAME[ch])
      }
    }
    const uniq = [...daySet].sort((a, b) => a - b)
    if (uniq.length === 0) return null
    return { action, original: text, schedule: build('weekly', hour, minute, uniq, null, null) }
  }
  // 매일/빈도 없음 → 매일
  return { action, original: text, schedule: build('daily', hour, minute, null, null, null) }
}

/** KST wall-clock을 UTC instant(ms)로 변환 */
function kstToUtcMs(y: number, m0: number, d: number, hh: number, mm: number): number {
  return Date.UTC(y, m0, d, hh, mm) - 9 * 60 * 60 * 1000
}

/** Date를 KST 날짜·시각 성분으로 분해 */
function kstParts(d: Date): { y: number; m0: number; d: number; hh: number; mm: number } {
  const k = new Date(d.getTime() + 9 * 60 * 60 * 1000)
  return {
    y: k.getUTCFullYear(),
    m0: k.getUTCMonth(),
    d: k.getUTCDate(),
    hh: k.getUTCHours(),
    mm: k.getUTCMinutes(),
  }
}

function matchesDay(
  schedule: NlCronSchedule,
  y: number,
  m0: number,
  d: number,
): boolean {
  if (schedule.kind === 'daily') return true
  if (schedule.kind === 'weekly') {
    const dow = new Date(Date.UTC(y, m0, d)).getUTCDay()
    return (schedule.daysOfWeek ?? []).includes(dow)
  }
  if (schedule.kind === 'monthly') {
    // 없는 날짜(2월 30일 등)는 건너뜀 — Date.UTC 오버플로우 검증
    const probe = new Date(Date.UTC(y, m0, d))
    if (probe.getUTCDate() !== d) return false
    return d === schedule.dayOfMonth
  }
  return false
}

/**
 * 스케줄의 다음 실행 시각 (from 이후, KST wall-clock 기준).
 * 370일까지만 탐색하고 없으면 null.
 */
export function nextRunAfter(schedule: NlCronSchedule, from: Date): Date | null {
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) return null

  if (schedule.kind === 'interval') {
    const n = schedule.intervalMinutes ?? 60
    if (n < 1) return null
    // KST 기준 분 단위 경계로 올림
    const kstMin = Math.floor((from.getTime() + 9 * 60 * 60 * 1000) / 60000)
    let next: number
    if (n < 60) {
      next = (Math.floor(kstMin / n) + 1) * n
    } else {
      const hours = n / 60
      const kstHour = Math.floor(kstMin / 60)
      next = (Math.floor(kstHour / hours) + 1) * hours * 60
    }
    return new Date(next * 60000 - 9 * 60 * 60 * 1000)
  }

  const start = kstParts(from)
  for (let offset = 0; offset <= 370; offset++) {
    const base = Date.UTC(start.y, start.m0, start.d) + offset * 86400000
    const day = new Date(base)
    const y = day.getUTCFullYear()
    const m0 = day.getUTCMonth()
    const d = day.getUTCDate()
    if (!matchesDay(schedule, y, m0, d)) continue
    const candidate = kstToUtcMs(y, m0, d, schedule.hour, schedule.minute)
    if (candidate > from.getTime()) return new Date(candidate)
  }
  return null
}

/** 12시간제 한국어 시각 ("오전 8시", "오후 7시 30분") */
export function formatKoTime(hour: number, minute: number): string {
  const period = hour < 12 ? '오전' : '오후'
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  const minPart = minute > 0 ? ` ${minute}분` : ''
  return `${period} ${h12}시${minPart}`
}

/** 사용자에게 보여줄 확인 문장 */
export function describeNlCron(parse: NlCronParse): string {
  const s = parse.schedule
  const actionText =
    parse.action === 'morning-briefing'
      ? '아침 브리핑'
      : parse.action === 'news-summary'
        ? '뉴스 요약'
        : parse.action === 'schedule-reminder'
          ? '일정 알림'
          : '알림'
  const dowName = ['일', '월', '화', '수', '목', '금', '토']
  let freq: string
  switch (s.kind) {
    case 'daily':
      freq = '매일'
      break
    case 'weekly': {
      const days = (s.daysOfWeek ?? []).map((d) => dowName[d]).join('·')
      const isWeekday =
        s.daysOfWeek?.length === 5 && s.daysOfWeek.every((d) => d >= 1 && d <= 5)
      const isWeekend =
        s.daysOfWeek?.length === 2 && s.daysOfWeek.includes(0) && s.daysOfWeek.includes(6)
      freq = isWeekday ? '평일' : isWeekend ? '주말' : `매주 ${days}요일`
      break
    }
    case 'monthly':
      freq = `매월 ${s.dayOfMonth}일`
      break
    case 'interval': {
      const n = s.intervalMinutes ?? 60
      freq = n < 60 ? `${n}분마다` : `${n / 60}시간마다`
      return `${freq} ${actionText}을 보내드릴게요.`
    }
  }
  return `${freq} ${formatKoTime(s.hour, s.minute)}에 ${actionText}을 보내드릴게요.`
}

/** "아침 브리핑" 요청인지 (파싱 성공 + 브리핑 액션) */
export function isMorningBriefingRequest(text: string): boolean {
  const parsed = parseNlCron(text)
  return parsed !== null && parsed.action === 'morning-briefing'
}
