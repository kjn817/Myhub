/// <reference types="jest" />
/**
 * recurrence.ts 커버리지 테스트
 * - RRULE 파싱 (parseRRule)
 * - 일정展開 (expandRecurrence)
 * - 단건 래핑 (singleOccurrence)
 *
 * NOTE: shiftKey의 `if (!p) return key`와 matchesRule의 `default: return false`는
 * public API 경로에서 도달 불가한 방어 코드 (parseRRule이 freq를 3종으로 제한하고
 * toExpanded 호출 전 start_at이 검증됨). 소스 수정 없이 도달 불가.
 * NOTE: 가드 `guard < 2200`의 false 분기도 hardStop(1098일)이 먼저 발동하므로
 * 도달 불가. 달성: statements 97.29% / branches 94.87% / functions 100% / lines 98.87%
 * (미커버 127행 = default return false 방어 코드)
 */
import {
  parseRRule,
  expandRecurrence,
  singleOccurrence,
  isValidCalendarDate,
  validateRRule,
  type ScheduleLike,
} from '../../src/services/recurrence'

function sched(over: Partial<ScheduleLike> = {}): ScheduleLike {
  return {
    id: 1,
    title: '회의',
    description: 'desc',
    location: 'loc',
    start_at: '2026-10-17T09:00',
    end_at: '2026-10-17T10:00',
    timezone: 'Asia/Seoul',
    recurrence_rule: null,
    status: 'active',
    created_at: '2026-10-17',
    updated_at: '2026-10-17',
    ...over,
  }
}

describe('parseRRule', () => {
  test('null/undefined/빈문자열 → null', () => {
    expect(parseRRule(null)).toBeNull()
    expect(parseRRule(undefined)).toBeNull()
    expect(parseRRule('')).toBeNull()
  })

  test('비문자열 입력 → null', () => {
    expect(parseRRule(123 as any)).toBeNull()
  })

  test('기본 DAILY', () => {
    expect(parseRRule('FREQ=DAILY')).toEqual({
      freq: 'DAILY', byday: null, count: null, until: null,
    })
  })

  test('소문자/공백 허용', () => {
    const r = parseRRule('freq=weekly; byday=mo,fr')
    expect(r?.freq).toBe('WEEKLY')
    expect(r?.byday).toEqual([1, 5])
  })

  test('지원하지 않는 FREQ → null', () => {
    expect(parseRRule('FREQ=HOURLY')).toBeNull()
    expect(parseRRule('RRULE:FREQ=DAILY')).toBeNull()
  })

  test('BYDAY 중복 제거/정렬', () => {
    const r = parseRRule('FREQ=WEEKLY;BYDAY=FR,MO,FR')
    expect(r?.byday).toEqual([1, 5])
  })

  test('BYDAY 전부 무효 → null', () => {
    const r = parseRRule('FREQ=WEEKLY;BYDAY=XX,YY')
    expect(r?.byday).toBeNull()
  })

  test('BYDAY 부분 무효 → 유효한 것만', () => {
    const r = parseRRule('FREQ=WEEKLY;BYDAY=MO,XX')
    expect(r?.byday).toEqual([1])
  })

  test('COUNT 유효', () => {
    expect(parseRRule('FREQ=DAILY;COUNT=5')?.count).toBe(5)
  })

  test('COUNT 무효 (0/음수/문자) → null', () => {
    expect(parseRRule('FREQ=DAILY;COUNT=0')?.count).toBeNull()
    expect(parseRRule('FREQ=DAILY;COUNT=-3')?.count).toBeNull()
    expect(parseRRule('FREQ=DAILY;COUNT=abc')?.count).toBeNull()
  })

  test('COUNT 소수 → parseInt', () => {
    expect(parseRRule('FREQ=DAILY;COUNT=3x')?.count).toBe(3)
  })

  test('UNTIL 날짜 형식', () => {
    expect(parseRRule('FREQ=DAILY;UNTIL=20261020')?.until).toBe('2026-10-20')
  })

  test('UNTIL datetime 형식 (T/Z 포함)', () => {
    expect(parseRRule('FREQ=DAILY;UNTIL=20261020T235959Z')?.until).toBe('2026-10-20')
  })

  test('UNTIL 숫자 8자리 미만 → null', () => {
    expect(parseRRule('FREQ=DAILY;UNTIL=abc')?.until).toBeNull()
    expect(parseRRule('FREQ=DAILY;UNTIL=2026102')?.until).toBeNull()
  })

  test('UNTIL 존재하지 않는 날짜 → null (결함 3 수정)', () => {
    // 구 코드는 형식만 검사해 '2026-13-40'을 until로 저장했고,
    // expandRecurrence 문자열 비교상 영원히 도달하지 않아 조용히 무시됐다.
    expect(parseRRule('FREQ=DAILY;UNTIL=20261340')?.until).toBeNull() // 13월
    expect(parseRRule('FREQ=DAILY;UNTIL=20260230')?.until).toBeNull() // 2월 30일
    expect(parseRRule('FREQ=DAILY;UNTIL=20230229')?.until).toBeNull() // 평년 2월 29일
    expect(parseRRule('FREQ=DAILY;UNTIL=20260431')?.until).toBeNull() // 4월 31일
    expect(parseRRule('FREQ=DAILY;UNTIL=20260010')?.until).toBeNull() // 0월
    expect(parseRRule('FREQ=DAILY;UNTIL=20261000')?.until).toBeNull() // 0일
  })

  test('UNTIL 윤년 2월 29일 → 유효', () => {
    expect(parseRRule('FREQ=DAILY;UNTIL=20240229')?.until).toBe('2024-02-29')
    expect(parseRRule('FREQ=DAILY;UNTIL=20280229')?.until).toBe('2028-02-29')
  })

  test('= 없는 세그먼트 무시', () => {
    const r = parseRRule('FREQ;FREQ=DAILY')
    expect(r?.freq).toBe('DAILY')
  })
})

describe('isValidCalendarDate', () => {
  test('유효 날짜', () => {
    expect(isValidCalendarDate('2026-10-20')).toBe(true)
    expect(isValidCalendarDate('2024-02-29')).toBe(true) // 윤년
    expect(isValidCalendarDate('2026-12-31')).toBe(true)
  })
  test('존재하지 않는 날짜', () => {
    expect(isValidCalendarDate('2026-13-40')).toBe(false)
    expect(isValidCalendarDate('2026-02-30')).toBe(false)
    expect(isValidCalendarDate('2023-02-29')).toBe(false) // 평년
    expect(isValidCalendarDate('2026-04-31')).toBe(false)
    expect(isValidCalendarDate('2026-00-10')).toBe(false)
    expect(isValidCalendarDate('2026-10-00')).toBe(false)
  })
  test('형식 오류', () => {
    expect(isValidCalendarDate('2026-1-1')).toBe(false)
    expect(isValidCalendarDate('20261020')).toBe(false)
    expect(isValidCalendarDate('')).toBe(false)
  })
})

describe('validateRRule', () => {
  test('빈 값 = 반복 없음 → 유효', () => {
    expect(validateRRule(null)).toBeNull()
    expect(validateRRule(undefined)).toBeNull()
    expect(validateRRule('')).toBeNull()
    expect(validateRRule('   ')).toBeNull()
  })
  test('유효한 RRULE → null', () => {
    expect(validateRRule('FREQ=DAILY;COUNT=3')).toBeNull()
    expect(validateRRule('FREQ=WEEKLY;UNTIL=20261020')).toBeNull()
    expect(validateRRule('FREQ=DAILY;UNTIL=20240229')).toBeNull()
  })
  test('파싱 불가 → recurrence_rule_invalid', () => {
    expect(validateRRule('FREQ=HOURLY')).toBe('recurrence_rule_invalid')
    expect(validateRRule('FREQ')).toBe('recurrence_rule_invalid')
    expect(validateRRule('garbage')).toBe('recurrence_rule_invalid')
  })
  test('UNTIL 무효 날짜 → recurrence_until_invalid', () => {
    expect(validateRRule('FREQ=DAILY;UNTIL=20261340')).toBe('recurrence_until_invalid')
    expect(validateRRule('FREQ=DAILY;UNTIL=20260230')).toBe('recurrence_until_invalid')
    expect(validateRRule('FREQ=DAILY;UNTIL=20230229')).toBe('recurrence_until_invalid')
    expect(validateRRule('FREQ=DAILY;UNTIL=abc')).toBe('recurrence_until_invalid')
  })
})

describe('singleOccurrence', () => {
  test('단건 래핑', () => {
    const s = sched({ start_at: '2026-10-17T09:00' })
    const o = singleOccurrence(s)
    expect(o.is_recurring).toBe(false)
    expect(o.original_id).toBe(1)
    expect(o.occurrence_date).toBe('2026-10-17')
    expect(o.start_at).toBe('2026-10-17T09:00')
  })

  test('end_at 다음날로 shift', () => {
    const s = sched({ start_at: '2026-10-17T09:00', end_at: '2026-10-18T10:30' })
    const o = singleOccurrence(s)
    expect(o.end_at).toBe('2026-10-18T10:30')
  })

  test('end_at 없음 → null 유지', () => {
    const s = sched({ end_at: null })
    const o = singleOccurrence(s)
    expect(o.end_at).toBeNull()
  })

  test('end_at 날짜만 있는 경우', () => {
    const s = sched({ start_at: '2026-10-17', end_at: '2026-10-19' })
    const o = singleOccurrence(s)
    expect(o.end_at).toBe('2026-10-19')
  })

  test('start_at 무효 → end shift 스킵', () => {
    const s = sched({ start_at: 'garbage', end_at: '2026-10-18T10:00' })
    const o = singleOccurrence(s)
    expect(o.end_at).toBe('2026-10-18T10:00')
    expect(o.occurrence_date).toBe('garbage')
  })
})

describe('expandRecurrence - fail-soft', () => {
  test('반복 규칙 없음 → 단건', () => {
    const out = expandRecurrence(sched(), '2026-10-01', '2026-10-31')
    expect(out).toHaveLength(1)
    expect(out[0].is_recurring).toBe(false)
  })

  test('start_at 무효 → 단건', () => {
    const out = expandRecurrence(sched({ start_at: 'garbage' }), '2026-10-01', '2026-10-31')
    expect(out).toHaveLength(1)
  })

  test('start_at 월 13 → 단건 (parseDatePart 월 범위)', () => {
    const out = expandRecurrence(sched({ start_at: '2026-13-01' }), '2026-10-01', '2026-12-31')
    expect(out).toHaveLength(1)
  })

  test('start_at 일 32 → 단건 (parseDatePart 일 범위)', () => {
    const out = expandRecurrence(sched({ start_at: '2026-10-32' }), '2026-10-01', '2026-12-31')
    expect(out).toHaveLength(1)
  })

  test('fromDate 무효 → 단건', () => {
    const out = expandRecurrence(sched({ recurrence_rule: 'FREQ=DAILY' }), 'abc', '2026-10-31')
    expect(out).toHaveLength(1)
  })

  test('fromDate > toDate → 단건', () => {
    const out = expandRecurrence(sched({ recurrence_rule: 'FREQ=DAILY' }), '2026-11-01', '2026-10-31')
    expect(out).toHaveLength(1)
  })

  test('RRULE 파싱 실패 → 단건', () => {
    const out = expandRecurrence(sched({ recurrence_rule: 'FREQ=HOURLY' }), '2026-10-01', '2026-10-31')
    expect(out).toHaveLength(1)
  })
})

describe('expandRecurrence - DAILY', () => {
  test('COUNT=3', () => {
    const s = sched({ start_at: '2026-10-17T09:00', recurrence_rule: 'FREQ=DAILY;COUNT=3' })
    const out = expandRecurrence(s, '2026-10-01', '2026-12-31')
    expect(out).toHaveLength(3)
    expect(out.map((o) => o.occurrence_date)).toEqual(['2026-10-17', '2026-10-18', '2026-10-19'])
    expect(out[0].is_recurring).toBe(true)
    expect(out[0].original_id).toBe(1)
  })

  test('범위 이전 발생은 제외 (fromDate 필터)', () => {
    const s = sched({ start_at: '2026-10-17T09:00', recurrence_rule: 'FREQ=DAILY;COUNT=5' })
    const out = expandRecurrence(s, '2026-10-19', '2026-10-31')
    expect(out.map((o) => o.occurrence_date)).toEqual(['2026-10-19', '2026-10-20', '2026-10-21'])
  })

  test('UNTIL inclusive', () => {
    const s = sched({ start_at: '2026-10-17T09:00', recurrence_rule: 'FREQ=DAILY;UNTIL=20261019' })
    const out = expandRecurrence(s, '2026-10-01', '2026-12-31')
    expect(out.map((o) => o.occurrence_date)).toEqual(['2026-10-17', '2026-10-18', '2026-10-19'])
  })

  test('toDate 이후 중단', () => {
    const s = sched({ start_at: '2026-10-17T09:00', recurrence_rule: 'FREQ=DAILY' })
    const out = expandRecurrence(s, '2026-10-17', '2026-10-18')
    expect(out).toHaveLength(2)
  })

  test('시간 부분 유지', () => {
    const s = sched({ start_at: '2026-10-17T09:30:00', recurrence_rule: 'FREQ=DAILY;COUNT=1' })
    const out = expandRecurrence(s, '2026-10-17', '2026-10-17')
    expect(out[0].start_at).toBe('2026-10-17T09:30:00')
  })

  test('end_at 오프셋 shift', () => {
    const s = sched({
      start_at: '2026-10-17T09:00',
      end_at: '2026-10-18T10:30',
      recurrence_rule: 'FREQ=DAILY;COUNT=2',
    })
    const out = expandRecurrence(s, '2026-10-17', '2026-10-18')
    expect(out[1].start_at).toBe('2026-10-18T09:00')
    expect(out[1].end_at).toBe('2026-10-19T10:30')
  })

  test('안전 상한 (3년 hardStop) — 광범위 조회 시 중단', () => {
    const s = sched({ start_at: '2026-10-17T09:00', recurrence_rule: 'FREQ=DAILY' })
    const out = expandRecurrence(s, '2026-10-17', '2035-01-01')
    // 3*366일 = 1098일 상한으로 중단 (가드보다 먼저)
    expect(out.length).toBeLessThanOrEqual(1099)
    expect(out.length).toBeGreaterThan(1000)
  })
})

describe('expandRecurrence - WEEKLY', () => {
  // 2026-10-19 = 월요일 (10-17 토요일 기준)
  test('BYDAY=MO,WE,FR', () => {
    const s = sched({ start_at: '2026-10-19T09:00', recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR' })
    const out = expandRecurrence(s, '2026-10-19', '2026-10-31')
    expect(out.map((o) => o.occurrence_date)).toEqual([
      '2026-10-19', '2026-10-21', '2026-10-23', '2026-10-26', '2026-10-28', '2026-10-30',
    ])
  })

  test('BYDAY 없음 → 시작 요일만', () => {
    const s = sched({ start_at: '2026-10-19T09:00', recurrence_rule: 'FREQ=WEEKLY;COUNT=2' })
    const out = expandRecurrence(s, '2026-10-01', '2026-12-31')
    expect(out.map((o) => o.occurrence_date)).toEqual(['2026-10-19', '2026-10-26'])
  })

  test('COUNT는 범위 밖 발생도 소진', () => {
    const s = sched({ start_at: '2026-10-19T09:00', recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=2' })
    const out = expandRecurrence(s, '2026-10-26', '2026-12-31')
    expect(out.map((o) => o.occurrence_date)).toEqual(['2026-10-26'])
  })
})

describe('expandRecurrence - MONTHLY', () => {
  test('1/31 → 2월 스킵, 3/31 재개', () => {
    const s = sched({ start_at: '2026-01-31T09:00', recurrence_rule: 'FREQ=MONTHLY' })
    const out = expandRecurrence(s, '2026-01-01', '2026-04-30')
    expect(out.map((o) => o.occurrence_date)).toEqual(['2026-01-31', '2026-03-31'])
  })

  test('같은 날짜 매월', () => {
    const s = sched({ start_at: '2026-10-15T09:00', recurrence_rule: 'FREQ=MONTHLY;COUNT=3' })
    const out = expandRecurrence(s, '2026-10-01', '2027-02-01')
    expect(out.map((o) => o.occurrence_date)).toEqual(['2026-10-15', '2026-11-15', '2026-12-15'])
  })
})
