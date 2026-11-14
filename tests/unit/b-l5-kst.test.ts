/// <reference types="jest" />
/**
 * B-L5 KST 포맷 공용 코어 (5-7) — src/lib/kst.ts + 4개 기존 export의 동등성.
 *
 * 고정하는 성질:
 * - kstDateStr/kstTodayStr/kstDateString 3개는 같은 시각에 같은 'YYYY-MM-DD'를 낸다
 *   (desktop 본문은 en-US였고 나머지는 en-CA — formatToParts 출력은 동일).
 * - KST 자정 경계: UTC 14:59 → 전날, UTC 15:00 → 당일.
 * - kstTodayKoStr은 'YYYY년 M월 D일' (월·일은 0 패딩 없음).
 * - KST_TIME_ZONE은 'Asia/Seoul' — 5-9 중앙화의 중심 상수.
 * 카나리아: 코어의 timeZone을 바꾸거나 en-CA를 다른 포맷으로 바꾸면 실패한다.
 */
import { KST_TIME_ZONE, kstDateParts, kstDateStr, kstDateKoStr } from '../../src/lib/kst'
import { kstTodayStr } from '../../src/lib/news-core'
import { kstDateStr as briefingKstDateStr } from '../../src/services/briefing-export'
import { kstDateString } from '../../src/modules/desktop/service'
import { kstTodayKoStr } from '../../src/lib/news-summary'

describe('kst core', () => {
  test('KST_TIME_ZONE은 Asia/Seoul', () => {
    expect(KST_TIME_ZONE).toBe('Asia/Seoul')
  })

  test('kstDateParts는 연·월·일 2자리 부분을 낸다', () => {
    expect(kstDateParts(new Date('2026-11-14T00:00:00Z'))).toEqual({
      year: '2026',
      month: '11',
      day: '14',
    })
  })

  test('KST 자정 경계: UTC 14:59는 전날, 15:00은 당일', () => {
    expect(kstDateStr(new Date('2026-11-13T14:59:59Z'))).toBe('2026-11-13')
    expect(kstDateStr(new Date('2026-11-13T15:00:00Z'))).toBe('2026-11-14')
  })

  test('kstDateKoStr은 월·일 0 패딩 없는 한국어 표기', () => {
    expect(kstDateKoStr(new Date('2026-01-05T00:00:00Z'))).toBe('2026년 1월 5일')
    expect(kstDateKoStr(new Date('2026-11-14T00:00:00Z'))).toBe('2026년 11월 14일')
  })
})

describe('기존 4개 export의 출력 동등성', () => {
  const probes = [
    new Date('2026-01-01T00:00:00Z'),
    new Date('2026-02-28T15:30:00Z'),
    new Date('2026-06-15T14:59:59Z'),
    new Date('2026-06-15T15:00:00Z'),
    new Date('2026-11-14T08:30:00Z'),
    new Date('2026-12-31T23:59:59Z'),
    new Date('2027-01-01T00:00:00Z'),
  ]

  test.each(probes)('kstTodayStr·briefing kstDateStr·kstDateString이 코어와 동일 — %s', (d) => {
    const expected = kstDateStr(d)
    expect(kstTodayStr(d)).toBe(expected)
    expect(briefingKstDateStr(d)).toBe(expected)
    expect(kstDateString(d)).toBe(expected)
  })

  test.each(probes)('kstTodayKoStr이 kstDateKoStr과 동일 — %s', (d) => {
    expect(kstTodayKoStr(d)).toBe(kstDateKoStr(d))
  })
})
