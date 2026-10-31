/**
 * RRULE 반복 일정展開 (RFC 5545 부분 구현)
 *
 * 지원:
 *  - FREQ=DAILY | WEEKLY | MONTHLY
 *  - WEEKLY + BYDAY=MO,TU,WE,TH,FR,SA,SU (없으면 시작 요일)
 *  - MONTHLY: 시작일과 같은 날짜 (없는 달은 건너뜀, 예: 1/31 → 2월 스킵)
 *  - COUNT=n, UNTIL=YYYYMMDD (또는 YYYYMMDDTHHMMSS)
 *
 * 미지원/파싱 실패 시 원본 1건만 반환 (표시용 fail-soft).
 * 모든 날짜 연산은 UTC 캘린더 기준 (시간대 오염 방지).
 */

export interface RecurrenceRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY'
  /** JS getDay() 기준 요일 집합 (0=SU … 6=SA). WEEKLY에서만 사용 */
  byday: number[] | null
  count: number | null
  /** YYYY-MM-DD (inclusive) */
  until: string | null
}

/** routes.ts의 ScheduleRow와 구조적으로 호환되는 최소 인터페이스 */
export interface ScheduleLike {
  id: number
  title: string
  description: string
  location: string
  start_at: string
  end_at: string | null
  timezone: string
  recurrence_rule: string | null
  status: string
  created_at: string
  updated_at: string
}

export interface ExpandedSchedule extends ScheduleLike {
  is_recurring: boolean
  original_id: number
  /** YYYY-MM-DD */
  occurrence_date: string
}

const DAY_MS = 86400000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function parseDatePart(s: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return null
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return { y, m: mo, d }
}

function keyOfUTC(ms: number): string {
  const dt = new Date(ms)
  const y = dt.getUTCFullYear()
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const d = String(dt.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function shiftKey(key: string, days: number): string {
  const p = parseDatePart(key)
  if (!p) return key
  return keyOfUTC(Date.UTC(p.y, p.m - 1, p.d) + days * DAY_MS)
}

/** 'YYYY-MM-DD'가 실제 존재하는 날짜인지 검증 (월 1~12·일 유효 범위·윤년). */
export function isValidCalendarDate(dateStr: string): boolean {
  if (!DATE_RE.test(dateStr)) return false
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/** RRULE 문자열 파싱. 실패 시 null */
export function parseRRule(rule: string | null | undefined): RecurrenceRule | null {
  if (!rule || typeof rule !== 'string') return null
  const parts: Record<string, string> = {}
  for (const seg of rule.split(';')) {
    const i = seg.indexOf('=')
    if (i < 0) continue
    parts[seg.slice(0, i).trim().toUpperCase()] = seg.slice(i + 1).trim().toUpperCase()
  }
  const freq = parts['FREQ']
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') return null

  let byday: number[] | null = null
  if (parts['BYDAY']) {
    const map: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }
    const days = parts['BYDAY'].split(',')
      .map((s) => map[s.trim()])
      .filter((n) => n !== undefined)
    if (days.length > 0) {
      const uniq = days.filter((n, i) => days.indexOf(n) === i).sort((a, b) => a - b)
      byday = uniq
    }
  }

  let count: number | null = null
  if (parts['COUNT']) {
    const n = parseInt(parts['COUNT'], 10)
    if (Number.isInteger(n) && n > 0) count = n
  }

  let until: string | null = null
  if (parts['UNTIL']) {
    const digits = parts['UNTIL'].replace(/\D/g, '')
    if (digits.length >= 8) {
      until = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
      if (!isValidCalendarDate(until)) until = null
    }
  }

  return { freq, byday, count, until }
}

/**
 * 저장 전 RRULE 검증. 유효하면 null, 아니면 에러 코드 반환.
 * - 파싱 불가 → 'recurrence_rule_invalid'
 * - UNTIL이 있으나 유효한 날짜가 아님(13월·2월 30일·평년 2월 29일 등) → 'recurrence_until_invalid'
 * (빈 값 = 반복 없음 → 유효)
 */
export function validateRRule(rule: string | null | undefined): string | null {
  if (rule === null || rule === undefined || rule.trim() === '') return null
  const parsed = parseRRule(rule)
  if (!parsed) return 'recurrence_rule_invalid'
  const untilSeg = rule.split(';').find((s) => s.trim().toUpperCase().startsWith('UNTIL='))
  if (untilSeg && parsed.until === null) return 'recurrence_until_invalid'
  return null
}

function matchesRule(dayUTC: number, rule: RecurrenceRule, startUTC: number): boolean {
  const dt = new Date(dayUTC)
  const start = new Date(startUTC)
  switch (rule.freq) {
    case 'DAILY':
      return true
    case 'WEEKLY': {
      const dow = dt.getUTCDay()
      if (rule.byday) return rule.byday.includes(dow)
      return dow === start.getUTCDay()
    }
    case 'MONTHLY':
      // BYDAY(월간 N번째 요일)는 미지원 → 같은 날짜 기준
      return dt.getUTCDate() === start.getUTCDate()
    default:
      return false
  }
}

function toExpanded(s: ScheduleLike, startAt: string, isRecurring: boolean): ExpandedSchedule {
  const occDate = startAt.slice(0, 10)
  let endAt: string | null = s.end_at
  if (s.end_at) {
    const sp = parseDatePart(s.start_at)
    const ep = parseDatePart(s.end_at)
    if (sp && ep) {
      const offDays = Math.round(
        (Date.UTC(ep.y, ep.m - 1, ep.d) - Date.UTC(sp.y, sp.m - 1, sp.d)) / DAY_MS
      )
      const endTime = s.end_at.length > 10 ? s.end_at.slice(10) : ''
      endAt = shiftKey(occDate, Math.max(0, offDays)) + endTime
    }
  }
  return {
    ...s,
    start_at: startAt,
    end_at: endAt,
    is_recurring: isRecurring,
    original_id: s.id,
    occurrence_date: occDate,
  }
}

/**
 * 반복 규칙이 없는 일정을 단일 발생 형태로 감싼다.
 * (list API에서 단건/반복을 동일한 형태로 합치기 위함)
 */
export function singleOccurrence(schedule: ScheduleLike): ExpandedSchedule {
  return toExpanded(schedule, schedule.start_at, false)
}

/**
 * 일정을 [fromDate, toDate](YYYY-MM-DD, inclusive) 범위 내 발생 건으로展開.
 * 반복 규칙이 없거나 파싱 실패/범위 오류 시 원본 1건 반환.
 */
export function expandRecurrence(
  schedule: ScheduleLike,
  fromDate: string,
  toDate: string
): ExpandedSchedule[] {
  const single = (): ExpandedSchedule[] => [toExpanded(schedule, schedule.start_at, false)]

  const sp = parseDatePart(schedule.start_at)
  if (!sp) return single()
  if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate) || fromDate > toDate) return single()

  const rule = parseRRule(schedule.recurrence_rule)
  if (!rule) return single()

  const timePart = schedule.start_at.length > 10 ? schedule.start_at.slice(10) : ''
  const startUTC = Date.UTC(sp.y, sp.m - 1, sp.d)
  const hardStop = startUTC + 3 * 366 * DAY_MS // 안전 상한: 시작일 + 약 3년
  const maxCount = rule.count ?? Infinity

  const out: ExpandedSchedule[] = []
  let produced = 0
  let guard = 0
  for (let cur = startUTC; cur <= hardStop && guard < 2200; cur += DAY_MS, guard++) {
    const key = keyOfUTC(cur)
    if (rule.until && key > rule.until) break
    if (key > toDate) break // 날짜 오름차순이므로 이후도 범위 밖
    if (!matchesRule(cur, rule, startUTC)) continue
    if (produced >= maxCount) break
    produced++
    if (key >= fromDate) {
      out.push(toExpanded(schedule, key + timePart, true))
    }
  }
  return out
}
