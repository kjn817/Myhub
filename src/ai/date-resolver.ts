/**
 * Phase 3B: 상대 날짜·시간 해석
 *
 * 원칙:
 * - 서버 시간 컨텍스트 기준
 * - 모호하면 ambiguous 반환 (임의 확정 금지)
 * - 과거 날짜를 미래로 자동 변경 금지
 */

import type { ServerTimeContext } from './time-context'

export type ResolveStatus = 'resolved' | 'ambiguous' | 'unsupported'

export interface DateResolveResult {
  status: ResolveStatus
  /** 확정된 현지 날짜 YYYY-MM-DD (없으면 null) */
  dateLocal: string | null
  /** 확정된 현지 시각 HH:MM (없으면 null) */
  timeLocal: string | null
  /** 기준 시간대 */
  timezone: string
  /** 정밀도 */
  precision: 'date' | 'minute' | null
  /** 해석 결과 코드 */
  reason: string
  /** 원문에서 해석 대상으로 사용한 표현 */
  sourceExpression: string
}

const WEEKDAY_KO: Record<string, number> = {
  '일요일': 0, '월요일': 1, '화요일': 2, '수요일': 3,
  '목요일': 4, '금요일': 5, '토요일': 6,
  '일': 0, '월': 1, '화': 2, '수': 3, '목': 4, '금': 5, '토': 6,
}

function addDays(dateStr: string, days: number): string {
  // 타임존 독립적 날짜 계산 (YYYY-MM-DD 문자열 연산)
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function getLastDayOfMonth(dateStr: string): string {
  const [y, m] = dateStr.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)) // 다음 달 0일 = 이번 달 말일
  return last.toISOString().slice(0, 10)
}

function getFirstDayOfNextMonth(dateStr: string): string {
  const [y, m] = dateStr.split('-').map(Number)
  const first = new Date(Date.UTC(y, m, 1)) // m은 0-based이므로 다음 달 1일
  return first.toISOString().slice(0, 10)
}

/**
 * 상대 날짜 표현 해석
 */
export function resolveDateExpression(
  text: string,
  ctx: ServerTimeContext
): DateResolveResult {
  const fail = (reason: string, sourceExpression: string): DateResolveResult => ({
    status: 'unsupported',
    dateLocal: null,
    timeLocal: null,
    timezone: ctx.timezone,
    precision: null,
    reason,
    sourceExpression,
  })

  const ambiguous = (reason: string, sourceExpression: string): DateResolveResult => ({
    status: 'ambiguous',
    dateLocal: null,
    timeLocal: null,
    timezone: ctx.timezone,
    precision: null,
    reason,
    sourceExpression,
  })

  const ok = (
    dateLocal: string,
    reason: string,
    sourceExpression: string
  ): DateResolveResult => ({
    status: 'resolved',
    dateLocal,
    timeLocal: null,
    timezone: ctx.timezone,
    precision: 'date',
    reason,
    sourceExpression,
  })

  const t = text.trim()

  // 명시적 YYYY-MM-DD
  const isoMatch = t.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (isoMatch) {
    const d = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`
    // 유효성 검증
    const parsed = new Date(d + 'T00:00:00')
    if (isNaN(parsed.getTime())) {
      return fail('invalid-date', isoMatch[0])
    }
    return ok(d, 'explicit-date', isoMatch[0])
  }

  // 오늘/내일/모레/어제
  if (/오늘/.test(t)) return ok(ctx.todayLocal, 'today', '오늘')
  if (/모레/.test(t)) return ok(addDays(ctx.todayLocal, 2), 'day-after-tomorrow', '모레')
  if (/내일/.test(t)) return ok(addDays(ctx.todayLocal, 1), 'tomorrow', '내일')
  if (/어제/.test(t)) return ok(addDays(ctx.todayLocal, -1), 'yesterday', '어제')
  if (/그제/.test(t)) return ok(addDays(ctx.todayLocal, -2), 'day-before-yesterday', '그제')

  // 이번 주 / 다음 주 / 지난주 + 요일
  for (const [name, weekday] of Object.entries(WEEKDAY_KO)) {
    // 다음 주 월요일
    if (new RegExp(`다음\\s*주\\s*${name}`).test(t)) {
      const daysUntil = (weekday - ctx.weekdayLocal + 7) % 7
      // 다음 주이므로 최소 7일 후
      const target = addDays(ctx.weekStartLocal, 7 + weekday - 1)
      return ok(target, 'next-week-weekday', `다음 주 ${name}`)
    }
    // 지난주 월요일
    if (new RegExp(`지난\\s*주\\s*${name}|저번\\s*주\\s*${name}`).test(t)) {
      const target = addDays(ctx.weekStartLocal, -7 + weekday - 1)
      return ok(target, 'last-week-weekday', `지난주 ${name}`)
    }
    // 이번 주 월요일
    if (new RegExp(`이번\\s*주\\s*${name}`).test(t)) {
      const target = addDays(ctx.weekStartLocal, weekday - 1)
      // 과거라도 그대로 유지 (미래로 자동 변경 금지)
      return ok(target, 'this-week-weekday', `이번 주 ${name}`)
    }
    // 다가오는 금요일 (다음에 오는)
    if (new RegExp(`다가오는\\s*${name}`).test(t)) {
      let daysUntil = (weekday - ctx.weekdayLocal + 7) % 7
      if (daysUntil === 0) daysUntil = 7 // 오늘이면 다음 주
      return ok(addDays(ctx.todayLocal, daysUntil), 'upcoming-weekday', `다가오는 ${name}`)
    }
  }

  // 이번 달 말일
  if (/이번\s*달\s*말일/.test(t)) {
    return ok(getLastDayOfMonth(ctx.todayLocal), 'end-of-month', '이번 달 말일')
  }

  // 다음 달 1일
  if (/다음\s*달\s*1일/.test(t)) {
    return ok(getFirstDayOfNextMonth(ctx.todayLocal), 'first-of-next-month', '다음 달 1일')
  }

  // 모호한 표현
  if (/\d+\s*시/.test(t) && !/오전|오후|자정|정오/.test(t)) {
 return ambiguous('ambiguous-time', t.match(/\d+\s*시/)?.[0] || t)
  }

  return fail('no-date-expression', t.slice(0, 50))
}

/**
 * 시간 표현 해석
 */
export function resolveTimeExpression(
  text: string
): { timeLocal: string | null; status: ResolveStatus; reason: string } {
  const t = text.trim()

  // 오전/오후 HH시 MM분
  const match = t.match(/(오전|오후)\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/)
  if (match) {
    const isPM = match[1] === '오후'
    let hour = parseInt(match[2], 10)
    const minute = match[3] ? parseInt(match[3], 10) : 0

    // 12시 처리
    if (hour === 12) {
      hour = isPM ? 12 : 0
    } else if (isPM) {
      hour += 12
    }

    if (hour > 23 || minute > 59) {
      return { timeLocal: null, status: 'unsupported', reason: 'invalid-time' }
    }

    const timeLocal = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    return { timeLocal, status: 'resolved', reason: 'explicit-time' }
  }

  // 자정/정오
  if (/자정/.test(t)) {
    return { timeLocal: '00:00', status: 'resolved', reason: 'midnight' }
  }
  if (/정오/.test(t)) {
    return { timeLocal: '12:00', status: 'resolved', reason: 'noon' }
  }

  // 오전/오후 없는 "N시" → 모호
  if (/\d+\s*시/.test(t)) {
    return { timeLocal: null, status: 'ambiguous', reason: 'ambiguous-am-pm' }
  }

  return { timeLocal: null, status: 'unsupported', reason: 'no-time-expression' }
}

/**
 * 날짜 + 시간 통합 해석
 */
export function resolveDateTime(
  text: string,
  ctx: ServerTimeContext
): DateResolveResult {
  const dateResult = resolveDateExpression(text, ctx)
  const timeResult = resolveTimeExpression(text)

  if (dateResult.status === 'resolved' && timeResult.status === 'resolved') {
    return {
      ...dateResult,
      timeLocal: timeResult.timeLocal,
      precision: 'minute',
      reason: `${dateResult.reason}+${timeResult.reason}`,
    }
  }

  if (dateResult.status === 'resolved' && timeResult.status === 'unsupported') {
    // 날짜만 있고 시간 없음 → 시간 미지정 (00:00으로 임의 설정 금지)
    return dateResult
  }

  if (dateResult.status === 'ambiguous' || timeResult.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      dateLocal: dateResult.dateLocal,
      timeLocal: timeResult.timeLocal,
      timezone: ctx.timezone,
      precision: null,
      reason: `ambiguous:${dateResult.reason},${timeResult.reason}`,
      sourceExpression: dateResult.sourceExpression,
    }
  }

  return dateResult
}

/**
 * 다중 날짜 표현 해석 (QF2)
 * - 텍스트에서 모든 날짜 표현을 찾아 각각 해석
 * - "다음 주 월요일과 금요일" → [월요일: 2026-10-12, 금요일: 2026-10-16]
 */
export interface MultiDateResult {
  expression: string
  dateLocal: string | null
  status: 'resolved' | 'ambiguous' | 'unsupported'
}

export function resolveMultipleDates(
  text: string,
  ctx: ServerTimeContext
): MultiDateResult[] {
  const results: MultiDateResult[] = []
  // "다음 주 월요일과 금요일"처럼 수식어가 공유되는 경우 처리
  // 먼저 "다음 주" / "이번 주" 같은 수식어 찾기
  const qualifierMatch = text.match(/(다음\s*주|이번\s*주|지난\s*주)/)
  const qualifier = qualifierMatch ? qualifierMatch[1].replace(/\s+/g, ' ') : ''
  
  const pattern = /(다음\s*주\s*[월화수목금토일]요일|이번\s*주\s*[월화수목금토일]요일|지난\s*주\s*[월화수목금토일]요일|[월화수목금토일]요일|오늘|내일|모레|어제)/g
  const matches = [...text.matchAll(pattern)]
  
  const seen = new Set<string>()
  for (const m of matches) {
    let expr = m[0].trim()
    // 수식어가 없는 요일인데 문장에 수식어가 있으면 상속
    // 예: "다음 주 월요일과 금요일" → "금요일"에 "다음 주" 상속
    if (/^[월화수목금토일]요일$/.test(expr) && qualifier && !text.includes(qualifier + ' ' + expr)) {
      // "다음 주"가 이미 다른 요일과 결합되어 있고, 현재 요일은 단독인 경우
      const qualifiedExpr = qualifier + ' ' + expr
      // 원문에 "다음 주 금요일"이 명시적으로 없으면 상속 시도
      if (!text.includes(qualifiedExpr.replace(/\s+/g, '')) && !text.includes(qualifiedExpr)) {
        expr = qualifiedExpr
      }
    }
    if (seen.has(expr)) continue
    seen.add(expr)
    
    const single = resolveDateExpression(expr, ctx)
    results.push({
      expression: m[0].trim(), // 원문 표현 유지
      dateLocal: single.dateLocal,
      status: single.status,
    })
    // 상속된 표현도 시도 (원문이 단독 요일인데 해석 실패한 경우)
    if (single.status !== 'resolved' && /^[월화수목금토일]요일$/.test(m[0].trim()) && qualifier) {
      const qualifiedExpr = qualifier + ' ' + m[0].trim()
      const qualifiedSingle = resolveDateExpression(qualifiedExpr, ctx)
      if (qualifiedSingle.status === 'resolved') {
        // 기존 결과를 상속된 해석으로 교체
        results[results.length - 1] = {
          expression: m[0].trim() + ` (${qualifier} 상속)`,
          dateLocal: qualifiedSingle.dateLocal,
          status: 'resolved',
        }
      }
    }
  }
  
  return results
}
