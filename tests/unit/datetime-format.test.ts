/// <reference types="jest" />
/**
 * src/lib/datetime-format.ts — 일정 날짜/시간 정규화 성질.
 *
 * 핵심 성질: ① 시간대가 없으면 KST wall-clock으로 간주해 +09:00을 붙인다
 * ② 'Z'는 실제 시각을 KST로 환산한다(날짜 경계 넘김 포함) ③ 그 외 오프셋은
 * 변환 없이 콜론 표기만 정규화한다 ④ 정규식·환산이 성립하지 않는 입력은
 * 원본을 그대로 돌려준다(저장 파이프라인이 임의로 값을 만들지 않는다).
 * 카나리아: +9시간 환산을 지우거나 SCHEDULE_OFFSET을 바꾸면 Z 테스트가,
 * trim을 지우면 공백 입력 테스트가 실패한다.
 */
import { normalizeScheduleDateTime } from '../../src/lib/datetime-format'

describe('비문자열·불일치 입력 — 원본 그대로', () => {
  test('문자열이 아닌 값은 동일하게 반환한다', () => {
    expect(normalizeScheduleDateTime(123)).toBe(123)
    expect(normalizeScheduleDateTime(null)).toBe(null)
    expect(normalizeScheduleDateTime(undefined)).toBe(undefined)
    expect(normalizeScheduleDateTime(true)).toBe(true)
    const obj = { start: 'x' }
    expect(normalizeScheduleDateTime(obj)).toBe(obj)
  })

  test('형식이 맞지 않는 문자열은 원본 그대로 (앞뒤 공백 포함)', () => {
    expect(normalizeScheduleDateTime('')).toBe('')
    expect(normalizeScheduleDateTime('내일 3시')).toBe('내일 3시')
    expect(normalizeScheduleDateTime('2026/11/08')).toBe('2026/11/08')
    expect(normalizeScheduleDateTime(' abc ')).toBe(' abc ')
    expect(normalizeScheduleDateTime('2026-11-08 10:30')).toBe('2026-11-08 10:30')
  })
})

describe('시간대 없음 — KST wall-clock으로 간주', () => {
  test('날짜만 있으면 자정으로 채우고 +09:00을 붙인다', () => {
    expect(normalizeScheduleDateTime('2026-11-08')).toBe('2026-11-08T00:00:00+09:00')
  })

  test('초가 없으면 :00으로 채운다', () => {
    expect(normalizeScheduleDateTime('2026-11-08T10:30')).toBe('2026-11-08T10:30:00+09:00')
  })

  test('초까지 있으면 그대로 두고 오프셋만 붙인다', () => {
    expect(normalizeScheduleDateTime('2026-11-08T10:30:45')).toBe('2026-11-08T10:30:45+09:00')
  })

  test('앞뒤 공백은 잘라서 판정한다', () => {
    expect(normalizeScheduleDateTime('  2026-11-08T10:30  ')).toBe('2026-11-08T10:30:00+09:00')
  })
})

describe("'Z' — UTC를 KST로 환산", () => {
  test('같은 날 안에서 +9시간 이동한다', () => {
    expect(normalizeScheduleDateTime('2026-11-08T00:00:00Z')).toBe('2026-11-08T09:00:00+09:00')
  })

  test('초 생략형 Z도 환산한다', () => {
    expect(normalizeScheduleDateTime('2026-11-08T10:30Z')).toBe('2026-11-08T19:30:00+09:00')
  })

  test('자정을 넘기면 날짜가 다음 날로 넘어간다', () => {
    expect(normalizeScheduleDateTime('2026-11-08T16:00:00Z')).toBe('2026-11-09T01:00:00+09:00')
  })

  test('연말을 넘기면 연도가 바뀐다', () => {
    expect(normalizeScheduleDateTime('2026-12-31T15:30:00Z')).toBe('2027-01-01T00:30:00+09:00')
  })

  test('환산할 수 없는 날짜(월 13·시 25)는 원본 그대로 둔다', () => {
    expect(normalizeScheduleDateTime('2026-13-01T00:00:00Z')).toBe('2026-13-01T00:00:00Z')
    expect(normalizeScheduleDateTime('2026-11-08T25:00:00Z')).toBe('2026-11-08T25:00:00Z')
  })
})

describe('숫자 오프셋 — 변환 없이 콜론 표기만 정규화', () => {
  test('콜론이 이미 있으면 그대로 둔다', () => {
    expect(normalizeScheduleDateTime('2026-11-08T10:30:00+09:00')).toBe('2026-11-08T10:30:00+09:00')
  })

  test('콜론이 없으면 넣어준다', () => {
    expect(normalizeScheduleDateTime('2026-11-08T10:30:00+0900')).toBe('2026-11-08T10:30:00+09:00')
  })

  test('음수 오프셋도 값 변환 없이 표기만 정규화한다 (KST로 바꾸지 않음)', () => {
    expect(normalizeScheduleDateTime('2026-11-08T10:30:00-0530')).toBe('2026-11-08T10:30:00-05:30')
  })

  test('오프셋 경로는 범위 검사를 하지 않는다 (문서화된 정규화 전용 동작)', () => {
    expect(normalizeScheduleDateTime('2026-11-08T25:00:00+09:00')).toBe('2026-11-08T25:00:00+09:00')
  })
})
