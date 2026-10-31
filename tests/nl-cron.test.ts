/**
 * 자연어 cron 파서 테스트 (Octop 트랙 4-3, zero-LLM 결정적 파싱)
 * 기준일: 2026-10-25(일) — KST 기준.
 */
import {
  parseNlCron,
  nextRunAfter,
  describeNlCron,
  formatKoTime,
  isMorningBriefingRequest,
  type NlCronSchedule,
} from '../src/services/nl-cron'

/** "2026-10-25T07:00:00+09:00" 같은 KST 시각을 Date로 */
function kst(isoLocal: string): Date {
  return new Date(`${isoLocal}+09:00`)
}

describe('parseNlCron', () => {
  test.each([
    [
      '매일 아침 8시에 브리핑해줘',
      { action: 'morning-briefing', kind: 'daily', hour: 8, minute: 0, cronKst: '0 8 * * *' },
    ],
    [
      '매일 저녁 7시 30분에 알려줘',
      { action: 'schedule-reminder', kind: 'daily', hour: 19, minute: 30, cronKst: '30 19 * * *' },
    ],
    [
      '매일 오후 3시에 브리핑해줘',
      { action: 'morning-briefing', kind: 'daily', hour: 15, minute: 0, cronKst: '0 15 * * *' },
    ],
    [
      '매일 오전 12시에 브리핑해줘',
      { action: 'morning-briefing', kind: 'daily', hour: 0, minute: 0, cronKst: '0 0 * * *' },
    ],
    [
      '매일 오후 12시에 브리핑해줘',
      { action: 'morning-briefing', kind: 'daily', hour: 12, minute: 0, cronKst: '0 12 * * *' },
    ],
    [
      '매일 아침에 브리핑해줘',
      { action: 'morning-briefing', kind: 'daily', hour: 8, minute: 0, cronKst: '0 8 * * *' },
    ],
    [
      '매일 저녁에 브리핑해줘',
      { action: 'morning-briefing', kind: 'daily', hour: 19, minute: 0, cronKst: '0 19 * * *' },
    ],
    [
      '평일 아침 8시에 브리핑해줘',
      { action: 'morning-briefing', kind: 'weekly', hour: 8, minute: 0, cronKst: '0 8 * * 1,2,3,4,5' },
    ],
    [
      '주말 오전 10시에 브리핑해줘',
      { action: 'morning-briefing', kind: 'weekly', hour: 10, minute: 0, cronKst: '0 10 * * 0,6' },
    ],
    [
      '매주 월요일 오전 9시에 브리핑해줘',
      { action: 'morning-briefing', kind: 'weekly', hour: 9, minute: 0, cronKst: '0 9 * * 1' },
    ],
    [
      '매주 월, 수, 금 오후 6시에 알려줘',
      { action: 'schedule-reminder', kind: 'weekly', hour: 18, minute: 0, cronKst: '0 18 * * 1,3,5' },
    ],
    [
      '매월 1일 오전 9시에 브리핑해줘',
      { action: 'morning-briefing', kind: 'monthly', hour: 9, minute: 0, cronKst: '0 9 1 * *' },
    ],
    [
      '30분마다 알려줘',
      { action: 'schedule-reminder', kind: 'interval', hour: 0, minute: 0, cronKst: '*/30 * * * *' },
    ],
    [
      '2시간마다 알려줘',
      { action: 'schedule-reminder', kind: 'interval', hour: 0, minute: 0, cronKst: '0 */2 * * *' },
    ],
    [
      '아침 8시 반에 브리핑해줘',
      { action: 'morning-briefing', kind: 'daily', hour: 8, minute: 30, cronKst: '30 8 * * *' },
    ],
    [
      '매일 밤 11시에 알려줘',
      { action: 'schedule-reminder', kind: 'daily', hour: 23, minute: 0, cronKst: '0 23 * * *' },
    ],
    [
      '매일 아침 8시에 뉴스 요약해서 푸시해줘',
      { action: 'news-summary', kind: 'daily', hour: 8, minute: 0, cronKst: '0 8 * * *' },
    ],
    [
      '매일 저녁 7시에 뉴스 알려줘',
      { action: 'news-summary', kind: 'daily', hour: 19, minute: 0, cronKst: '0 19 * * *' },
    ],
    [
      '평일 아침 8시에 뉴스 요약해줘',
      { action: 'news-summary', kind: 'weekly', hour: 8, minute: 0, cronKst: '0 8 * * 1,2,3,4,5' },
    ],
    [
      '매주 월요일 오전 9시에 뉴스 요약해줘',
      { action: 'news-summary', kind: 'weekly', hour: 9, minute: 0, cronKst: '0 9 * * 1' },
    ],
  ])('%s', (input, expected) => {
    const parsed = parseNlCron(input)
    expect(parsed).not.toBeNull()
    expect(parsed!.action).toBe(expected.action)
    expect(parsed!.schedule.kind).toBe(expected.kind)
    expect(parsed!.schedule.hour).toBe(expected.hour)
    expect(parsed!.schedule.minute).toBe(expected.minute)
    expect(parsed!.schedule.cronKst).toBe(expected.cronKst)
    expect(parsed!.schedule.timezone).toBe('Asia/Seoul')
    expect(parsed!.original).toBe(input)
  })

  test('매주 요일 추출이 일반 단어의 요일 문자를 오인하지 않음 ("수영"의 수)', () => {
    const parsed = parseNlCron('매주 화요일에 수영하고 아침 8시에 알려줘')
    expect(parsed).not.toBeNull()
    expect(parsed!.schedule.kind).toBe('weekly')
    expect(parsed!.schedule.daysOfWeek).toEqual([2])
  })

  test('파싱 실패 시 null (추측 금지)', () => {
    expect(parseNlCron('안녕하세요')).toBeNull()
    expect(parseNlCron('브리핑해줘')).toBeNull() // 시간 표현 없음
    expect(parseNlCron('매일 25시에 브리핑해줘')).toBeNull() // 범위 밖 시
    expect(parseNlCron('매일 8시 70분에 브리핑해줘')).toBeNull() // 범위 밖 분
    expect(parseNlCron('매주 브리핑해줘')).toBeNull() // 요일 없음
    expect(parseNlCron('')).toBeNull()
    expect(parseNlCron('   ')).toBeNull()
    expect(parseNlCron('0분마다 알려줘')).toBeNull()
    expect(parseNlCron('100분마다 알려줘')).toBeNull()
  })
})

describe('nextRunAfter', () => {
  const daily8 = parseNlCron('매일 아침 8시에 브리핑해줘')!.schedule
  const monday9 = parseNlCron('매주 월요일 오전 9시에 브리핑해줘')!.schedule
  const monthly1 = parseNlCron('매월 1일 오전 9시에 브리핑해줘')!.schedule
  const every30 = parseNlCron('30분마다 알려줘')!.schedule
  const every2h = parseNlCron('2시간마다 알려줘')!.schedule

  test('매일 8시 — 당일 아직 안 지났으면 당일', () => {
    const next = nextRunAfter(daily8, kst('2026-10-25T07:00:00'))
    expect(next?.toISOString()).toBe('2026-10-24T23:00:00.000Z') // 10/25 08:00 KST
  })

  test('매일 8시 — 당일 지났으면 다음 날', () => {
    const next = nextRunAfter(daily8, kst('2026-10-25T09:00:00'))
    expect(next?.toISOString()).toBe('2026-10-25T23:00:00.000Z') // 10/26 08:00 KST
  })

  test('매주 월요일 9시 — 일요일 기준 다음 날 월요일', () => {
    const next = nextRunAfter(monday9, kst('2026-10-25T07:00:00')) // 10/25는 일요일
    expect(next?.toISOString()).toBe('2026-10-26T00:00:00.000Z') // 10/26 09:00 KST
  })

  test('매월 1일 9시 — 10/25 기준 11/1', () => {
    const next = nextRunAfter(monthly1, kst('2026-10-25T07:00:00'))
    expect(next?.toISOString()).toBe('2026-11-01T00:00:00.000Z') // 11/1 09:00 KST
  })

  test('30분마다 — 08:07 기준 08:30', () => {
    const next = nextRunAfter(every30, kst('2026-10-25T08:07:00'))
    expect(next?.toISOString()).toBe('2026-10-24T23:30:00.000Z') // 10/25 08:30 KST
  })

  test('2시간마다 — 08:07 기준 10:00', () => {
    const next = nextRunAfter(every2h, kst('2026-10-25T08:07:00'))
    expect(next?.toISOString()).toBe('2026-10-25T01:00:00.000Z') // 10/25 10:00 KST
  })

  test('잘못된 입력이면 null', () => {
    expect(nextRunAfter(daily8, new Date('invalid'))).toBeNull()
  })
})

describe('describeNlCron / formatKoTime / isMorningBriefingRequest', () => {
  test('확인 문장', () => {
    expect(describeNlCron(parseNlCron('매일 아침 8시에 브리핑해줘')!)).toBe(
      '매일 오전 8시에 아침 브리핑을 보내드릴게요.',
    )
    expect(describeNlCron(parseNlCron('평일 아침 8시에 브리핑해줘')!)).toBe(
      '평일 오전 8시에 아침 브리핑을 보내드릴게요.',
    )
    expect(describeNlCron(parseNlCron('매주 월, 수, 금 오후 6시에 알려줘')!)).toBe(
      '매주 월·수·금요일 오후 6시에 일정 알림을 보내드릴게요.',
    )
    expect(describeNlCron(parseNlCron('30분마다 알려줘')!)).toBe(
      '30분마다 일정 알림을 보내드릴게요.',
    )
    expect(describeNlCron(parseNlCron('매일 아침 8시에 뉴스 요약해서 푸시해줘')!)).toBe(
      '매일 오전 8시에 뉴스 요약을 보내드릴게요.',
    )
  })

  test('12시간제 표기', () => {
    expect(formatKoTime(0, 0)).toBe('오전 12시')
    expect(formatKoTime(8, 0)).toBe('오전 8시')
    expect(formatKoTime(12, 0)).toBe('오후 12시')
    expect(formatKoTime(19, 30)).toBe('오후 7시 30분')
  })

  test('아침 브리핑 요청 판별', () => {
    expect(isMorningBriefingRequest('매일 아침 8시에 브리핑해줘')).toBe(true)
    expect(isMorningBriefingRequest('매일 아침 8시에 알려줘')).toBe(false)
    expect(isMorningBriefingRequest('안녕하세요')).toBe(false)
  })
})
