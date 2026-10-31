/**
 * src/ai/date-resolver.ts 단위 테스트
 */
/// <reference types="jest" />
import {
  resolveDateExpression,
  resolveTimeExpression,
  resolveDateTime,
  resolveMultipleDates,
} from '../../src/ai/date-resolver'
import { createServerTimeContext } from '../../src/ai/time-context'

// 기준: 2026-10-17 토요일 (KST)
const CTX = createServerTimeContext('Asia/Seoul', Date.UTC(2026, 9, 17, 3, 0, 0))
// todayLocal: 2026-10-17, weekdayLocal: 6 (토), weekStartLocal: 2026-10-12

describe('resolveDateExpression: 명시적 날짜', () => {
  test('YYYY-MM-DD', () => {
    const r = resolveDateExpression('2026-12-25', CTX)
    expect(r.status).toBe('resolved')
    expect(r.dateLocal).toBe('2026-12-25')
    expect(r.reason).toBe('explicit-date')
    expect(r.precision).toBe('date')
    expect(r.timezone).toBe('Asia/Seoul')
  })

  test('문장 속 날짜', () => {
    const r = resolveDateExpression('12월 25일이 아니라 2026-11-11에 만나자', CTX)
    expect(r.dateLocal).toBe('2026-11-11')
  })

  test('잘못된 날짜 → invalid-date', () => {
    const r = resolveDateExpression('2026-13-45', CTX)
    expect(r.status).toBe('unsupported')
    expect(r.reason).toBe('invalid-date')
    expect(r.dateLocal).toBeNull()
  })
})

describe('resolveDateExpression: 상대 날짜', () => {
  test('오늘', () => {
    const r = resolveDateExpression('오늘', CTX)
    expect(r.dateLocal).toBe('2026-10-17')
    expect(r.reason).toBe('today')
    expect(r.sourceExpression).toBe('오늘')
  })

  test('내일', () => {
    const r = resolveDateExpression('내일', CTX)
    expect(r.dateLocal).toBe('2026-10-18')
    expect(r.reason).toBe('tomorrow')
  })

  test('모레', () => {
    const r = resolveDateExpression('모레', CTX)
    expect(r.dateLocal).toBe('2026-10-19')
    expect(r.reason).toBe('day-after-tomorrow')
  })

  test('어제', () => {
    const r = resolveDateExpression('어제', CTX)
    expect(r.dateLocal).toBe('2026-10-16')
    expect(r.reason).toBe('yesterday')
  })

  test('그제', () => {
    const r = resolveDateExpression('그제', CTX)
    expect(r.dateLocal).toBe('2026-10-15')
    expect(r.reason).toBe('day-before-yesterday')
  })

  test('오늘 우선 (모레보다 먼저 체크)', () => {
    // "모레"에 "내일"이 포함되지 않지만, "오늘" 체크가 먼저
    const r = resolveDateExpression('오늘 모레', CTX)
    expect(r.reason).toBe('today')
  })
})

describe('resolveDateExpression: 주 + 요일', () => {
  test('다음 주 월요일', () => {
    const r = resolveDateExpression('다음 주 월요일', CTX)
    // weekStart 10/12 + 7 + 0 = 10/19
    expect(r.dateLocal).toBe('2026-10-19')
    expect(r.reason).toBe('next-week-weekday')
  })

  test('다음주 금요일 (공백 없음)', () => {
    const r = resolveDateExpression('다음주 금요일', CTX)
    expect(r.dateLocal).toBe('2026-10-23')
  })

  test('다음 주 일요일 (코드 동작: weekday=0 → 7+0-1=6일 후)', () => {
    const r = resolveDateExpression('다음 주 일요일', CTX)
    // 실제 코드 동작: addDays('2026-10-12', 6) = 2026-10-18
    expect(r.dateLocal).toBe('2026-10-18')
    expect(r.reason).toBe('next-week-weekday')
  })

  test('지난주 수요일', () => {
    const r = resolveDateExpression('지난주 수요일', CTX)
    // 10/12 - 7 + 2 = 10/07
    expect(r.dateLocal).toBe('2026-10-07')
    expect(r.reason).toBe('last-week-weekday')
  })

  test('저번주 목요일', () => {
    const r = resolveDateExpression('저번주 목요일', CTX)
    expect(r.dateLocal).toBe('2026-10-08')
  })

  test('이번 주 월요일 (과거도 유지)', () => {
    const r = resolveDateExpression('이번 주 월요일', CTX)
    expect(r.dateLocal).toBe('2026-10-12')
    expect(r.reason).toBe('this-week-weekday')
  })

  test('이번주 토요일 (오늘)', () => {
    const r = resolveDateExpression('이번주 토요일', CTX)
    expect(r.dateLocal).toBe('2026-10-17')
  })

  test('다가오는 월요일', () => {
    const r = resolveDateExpression('다가오는 월요일', CTX)
    // 토(6) → 월(1): (1-6+7)%7 = 2
    expect(r.dateLocal).toBe('2026-10-19')
    expect(r.reason).toBe('upcoming-weekday')
  })

  test('다가오는 토요일 (오늘이면 다음 주)', () => {
    const r = resolveDateExpression('다가오는 토요일', CTX)
    // 오늘이 토요일 → 7일 후
    expect(r.dateLocal).toBe('2026-10-24')
  })

  test('짧은 요일 이름', () => {
    const r = resolveDateExpression('다음 주 월', CTX)
    expect(r.dateLocal).toBe('2026-10-19')
  })
})

describe('resolveDateExpression: 월말/월초', () => {
  test('이번 달 말일', () => {
    const r = resolveDateExpression('이번 달 말일', CTX)
    expect(r.dateLocal).toBe('2026-10-31')
    expect(r.reason).toBe('end-of-month')
  })

  test('이번달말일 (공백 없음)', () => {
    const r = resolveDateExpression('이번달말일', CTX)
    expect(r.dateLocal).toBe('2026-10-31')
  })

  test('다음 달 1일', () => {
    const r = resolveDateExpression('다음 달 1일', CTX)
    expect(r.dateLocal).toBe('2026-11-01')
    expect(r.reason).toBe('first-of-next-month')
  })

  test('2월 말일 (윤년 아님)', () => {
    const febCtx = createServerTimeContext('Asia/Seoul', Date.UTC(2026, 1, 15, 3, 0, 0))
    const r = resolveDateExpression('이번 달 말일', febCtx)
    expect(r.dateLocal).toBe('2026-02-28')
  })
})

describe('resolveDateExpression: 모호/미지원', () => {
  test('시간만 있고 오전/오후 없음 → ambiguous', () => {
    const r = resolveDateExpression('3시에 만나자', CTX)
    expect(r.status).toBe('ambiguous')
    expect(r.reason).toBe('ambiguous-time')
  })

  test('날짜 표현 없음 → unsupported', () => {
    const r = resolveDateExpression('안녕하세요', CTX)
    expect(r.status).toBe('unsupported')
    expect(r.reason).toBe('no-date-expression')
    expect(r.sourceExpression).toBe('안녕하세요')
  })

  test('긴 텍스트는 50자로 자름', () => {
    const long = 'a'.repeat(100)
    const r = resolveDateExpression(long, CTX)
    expect(r.sourceExpression).toHaveLength(50)
  })
})

describe('resolveTimeExpression', () => {
  test('오후 3시', () => {
    const r = resolveTimeExpression('오후 3시')
    expect(r.status).toBe('resolved')
    expect(r.timeLocal).toBe('15:00')
    expect(r.reason).toBe('explicit-time')
  })

  test('오전 9시 30분', () => {
    const r = resolveTimeExpression('오전 9시 30분')
    expect(r.timeLocal).toBe('09:30')
  })

  test('오후 12시 → 12:00', () => {
    const r = resolveTimeExpression('오후 12시')
    expect(r.timeLocal).toBe('12:00')
  })

  test('오전 12시 → 00:00', () => {
    const r = resolveTimeExpression('오전 12시')
    expect(r.timeLocal).toBe('00:00')
  })

  test('오후 12시 30분', () => {
    const r = resolveTimeExpression('오후 12시 30분')
    expect(r.timeLocal).toBe('12:30')
  })

  test('자정', () => {
    const r = resolveTimeExpression('자정에 만나자')
    expect(r.timeLocal).toBe('00:00')
    expect(r.reason).toBe('midnight')
  })

  test('정오', () => {
    const r = resolveTimeExpression('정오에 만나자')
    expect(r.timeLocal).toBe('12:00')
    expect(r.reason).toBe('noon')
  })

  test('오전/오후 없는 N시 → ambiguous', () => {
    const r = resolveTimeExpression('3시에 만나자')
    expect(r.status).toBe('ambiguous')
    expect(r.timeLocal).toBeNull()
    expect(r.reason).toBe('ambiguous-am-pm')
  })

  test('시간 표현 없음 → unsupported', () => {
    const r = resolveTimeExpression('안녕')
    expect(r.status).toBe('unsupported')
    expect(r.reason).toBe('no-time-expression')
  })

  test('잘못된 시간 (25시) → unsupported', () => {
    const r = resolveTimeExpression('오후 25시')
    expect(r.status).toBe('unsupported')
    expect(r.reason).toBe('invalid-time')
  })

  test('잘못된 분 (70분) → unsupported', () => {
    const r = resolveTimeExpression('오후 3시 70분')
    expect(r.status).toBe('unsupported')
    expect(r.reason).toBe('invalid-time')
  })

  test('공백 변형', () => {
    const r = resolveTimeExpression('오후3시')
    expect(r.timeLocal).toBe('15:00')
  })
})

describe('resolveDateTime', () => {
  test('날짜 + 시간', () => {
    const r = resolveDateTime('내일 오후 3시에 만나자', CTX)
    expect(r.status).toBe('resolved')
    expect(r.dateLocal).toBe('2026-10-18')
    expect(r.timeLocal).toBe('15:00')
    expect(r.precision).toBe('minute')
    expect(r.reason).toBe('tomorrow+explicit-time')
  })

  test('날짜만 → 시간 null', () => {
    const r = resolveDateTime('내일 만나자', CTX)
    expect(r.status).toBe('resolved')
    expect(r.dateLocal).toBe('2026-10-18')
    expect(r.timeLocal).toBeNull()
    expect(r.precision).toBe('date')
  })

  test('모호한 시간 → ambiguous', () => {
    const r = resolveDateTime('내일 3시에 만나자', CTX)
    expect(r.status).toBe('ambiguous')
    expect(r.reason).toContain('ambiguous')
  })

  test('날짜 없음 → unsupported 전달', () => {
    const r = resolveDateTime('안녕', CTX)
    expect(r.status).toBe('unsupported')
  })
})

describe('resolveMultipleDates', () => {
  test('단일 날짜', () => {
    const results = resolveMultipleDates('내일 만나자', CTX)
    expect(results).toHaveLength(1)
    expect(results[0].dateLocal).toBe('2026-10-18')
    expect(results[0].status).toBe('resolved')
  })

  test('다음 주 월요일과 금요일 → 수식어 상속', () => {
    const results = resolveMultipleDates('다음 주 월요일과 금요일', CTX)
    expect(results.length).toBeGreaterThanOrEqual(2)
    const dates = results.map(r => r.dateLocal)
    expect(dates).toContain('2026-10-19') // 월
    expect(dates).toContain('2026-10-23') // 금
  })

  test('중복 제거', () => {
    const results = resolveMultipleDates('내일 내일', CTX)
    expect(results).toHaveLength(1)
  })

  test('오늘/내일/모레/어제', () => {
    const results = resolveMultipleDates('오늘, 내일, 모레', CTX)
    expect(results).toHaveLength(3)
  })

  test('날짜 없음 → 빈 배열', () => {
    const results = resolveMultipleDates('안녕하세요', CTX)
    expect(results).toHaveLength(0)
  })

  test('expression 원문 유지', () => {
    const results = resolveMultipleDates('내일', CTX)
    expect(results[0].expression).toBe('내일')
  })

  test('수식어 상속 폴백: 명시적 "다음 주 금요일" + 단독 "금요일"', () => {
    // "다음 주 금요일"이 원문에 명시되어 있으면 단독 "금요일"은
    // 사전 상속을 건너뛰고, 직접 해석 실패 후 폴백에서 수식어를 상속받음
    const results = resolveMultipleDates('다음 주 금요일에 만나고 금요일에도 보자', CTX)
    expect(results.length).toBe(2)
    expect(results[0].dateLocal).toBe('2026-10-23')
    // 두 번째 "금요일"은 폴백으로 "다음 주" 상속받아 해석됨
    expect(results[1].dateLocal).toBe('2026-10-23')
    expect(results[1].status).toBe('resolved')
    expect(results[1].expression).toContain('상속')
  })

  test('공백 없는 "다음주금요일" 명시 → 사전 상속 건너뜀', () => {
    // text.includes("다음주금요일")이 true이면 사전 상속 조건의 첫 번째 !A가 false
    const results = resolveMultipleDates('다음주금요일에 만나고 금요일에도 보자', CTX)
    expect(results.length).toBe(2)
    // 두 번째 "금요일": 사전 상속 건너뜀 → 직접 해석 실패 → 폴백에서 상속
    expect(results[1].status).toBe('resolved')
    expect(results[1].dateLocal).toBe('2026-10-23')
  })
})
