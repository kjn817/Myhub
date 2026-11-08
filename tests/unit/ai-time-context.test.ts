/**
 * src/ai/time-context.ts 단위 테스트
 */
/// <reference types="jest" />
import {
  isValidTimezone,
  createServerTimeContext,
  toPromptTimeContext,
} from '../../src/ai/time-context'

describe('isValidTimezone', () => {
  test('유효한 시간대 → true', () => {
    expect(isValidTimezone('Asia/Seoul')).toBe(true)
    expect(isValidTimezone('America/New_York')).toBe(true)
    expect(isValidTimezone('UTC')).toBe(true)
    expect(isValidTimezone('Europe/London')).toBe(true)
  })

  test('잘못된 시간대 → false', () => {
    expect(isValidTimezone('Invalid/Zone')).toBe(false)
    expect(isValidTimezone('')).toBe(false)
    expect(isValidTimezone('Mars/Olympus')).toBe(false)
  })
})

describe('createServerTimeContext', () => {
  // 2026-10-17 12:00:00 KST = 2026-10-17 03:00:00 UTC (토요일)
  const SATURDAY_KST = Date.UTC(2026, 9, 17, 3, 0, 0)

  test('기본 시간대 Asia/Seoul', () => {
    const ctx = createServerTimeContext(undefined, SATURDAY_KST)
    expect(ctx.timezone).toBe('Asia/Seoul')
    expect(ctx.todayLocal).toBe('2026-10-17')
    expect(ctx.weekdayLocal).toBe(6) // 토요일
    expect(ctx.weekdayName).toBe('토')
    expect(ctx.epochMs).toBe(SATURDAY_KST)
    expect(ctx.nowIso).toBe(new Date(SATURDAY_KST).toISOString())
  })

  test('잘못된 시간대 → Asia/Seoul 폴백', () => {
    const ctx = createServerTimeContext('Invalid/Zone', SATURDAY_KST)
    expect(ctx.timezone).toBe('Asia/Seoul')
  })

  test('빈 문자열 시간대 → Asia/Seoul 폴백', () => {
    const ctx = createServerTimeContext('', SATURDAY_KST)
    expect(ctx.timezone).toBe('Asia/Seoul')
  })

  test('UTC 시간대', () => {
    const ctx = createServerTimeContext('UTC', SATURDAY_KST)
    expect(ctx.timezone).toBe('UTC')
    expect(ctx.todayLocal).toBe('2026-10-17')
    expect(ctx.weekdayLocal).toBe(6)
  })

  test('미국 시간대 (날짜 경계)', () => {
    // 2026-10-17 03:00 UTC = 2026-10-16 23:00 EDT (금요일)
    const ctx = createServerTimeContext('America/New_York', SATURDAY_KST)
    expect(ctx.todayLocal).toBe('2026-10-16')
    expect(ctx.weekdayLocal).toBe(5) // 금요일
    expect(ctx.weekdayName).toBe('금')
  })

  test('월요일 기준 weekStartLocal', () => {
    // 토요일(10/17)의 이번 주 월요일은 10/12
    const ctx = createServerTimeContext('Asia/Seoul', SATURDAY_KST)
    expect(ctx.weekStartLocal).toBe('2026-10-12')
  })

  test('월요일 당일 → weekStartLocal은 당일', () => {
    // 2026-10-12 월요일 12:00 KST
    const monday = Date.UTC(2026, 9, 12, 3, 0, 0)
    const ctx = createServerTimeContext('Asia/Seoul', monday)
    expect(ctx.weekdayLocal).toBe(1)
    expect(ctx.weekdayName).toBe('월')
    expect(ctx.weekStartLocal).toBe('2026-10-12')
  })

  test('일요일 → weekStartLocal은 6일 전 월요일', () => {
    // 2026-10-18 일요일
    const sunday = Date.UTC(2026, 9, 18, 3, 0, 0)
    const ctx = createServerTimeContext('Asia/Seoul', sunday)
    expect(ctx.weekdayLocal).toBe(0)
    expect(ctx.weekdayName).toBe('일')
    expect(ctx.weekStartLocal).toBe('2026-10-12')
  })

  test('fixedEpochMs 없으면 현재 시간 사용', () => {
    const before = Date.now()
    const ctx = createServerTimeContext('Asia/Seoul')
    const after = Date.now()
    expect(ctx.epochMs).toBeGreaterThanOrEqual(before)
    expect(ctx.epochMs).toBeLessThanOrEqual(after)
  })

  test('요일 이름 매핑 (화/수/목)', () => {
    // 2026-10-13 화요일, 10-14 수요일, 10-15 목요일
    const tue = createServerTimeContext('Asia/Seoul', Date.UTC(2026, 9, 13, 3, 0, 0))
    expect(tue.weekdayName).toBe('화')
    const wed = createServerTimeContext('Asia/Seoul', Date.UTC(2026, 9, 14, 3, 0, 0))
    expect(wed.weekdayName).toBe('수')
    const thu = createServerTimeContext('Asia/Seoul', Date.UTC(2026, 9, 15, 3, 0, 0))
    expect(thu.weekdayName).toBe('목')
  })

  test('nowIso는 ISO 8601 형식', () => {
    const ctx = createServerTimeContext('Asia/Seoul', SATURDAY_KST)
    expect(ctx.nowIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})

describe('toPromptTimeContext', () => {
  test('필요한 4개 필드만 반환', () => {
    const ctx = createServerTimeContext('Asia/Seoul', Date.UTC(2026, 9, 17, 3, 0, 0))
    const prompt = toPromptTimeContext(ctx)
    expect(Object.keys(prompt).sort()).toEqual(['nowIso', 'timezone', 'todayLocal', 'weekStart'])
    expect(prompt.nowIso).toBe(ctx.nowIso)
    expect(prompt.timezone).toBe(ctx.timezone)
    expect(prompt.todayLocal).toBe(ctx.todayLocal)
    expect(prompt.weekStart).toBe(ctx.weekStartLocal)
  })
})
