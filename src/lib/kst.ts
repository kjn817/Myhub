/**
 * KST 고정 날짜 포맷 공용 코어 (B-L5, 5-7).
 *
 * news-core·briefing-export·desktop/service·news-summary에 흩어져 있던
 * KST 날짜 포맷 4중복을 한 곳으로 모은다. KST_TIME_ZONE이 'Asia/Seoul'
 * 중앙 상수의 중심이 된다 (5-9).
 *
 * 주의: 이 함수들은 KST 고정이다. 기본 타임존이 설정(ai.user_timezone)으로
 * 바뀌는 경로(prompt-integration.ts)와는 무관하며, 이름을 KST로 명시한다.
 * en-US/en-CA 로케일 차이는 formatToParts(numeric/2-digit) 출력에 영향을
 * 주지 않는다 — tests/unit/b-l5-kst.test.ts가 동등성을 핀한다.
 */

/** KST 타임존 — 'Asia/Seoul' 리터럴의 중앙 상수. */
export const KST_TIME_ZONE = 'Asia/Seoul'

export interface KstDateParts {
  year: string
  month: string
  day: string
}

/** KST 기준 날짜 부분 (연·월·일, 월·일은 2자리). */
export function kstDateParts(now: Date = new Date()): KstDateParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: KST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return { year: get('year'), month: get('month'), day: get('day') }
}

/** KST 기준 날짜 'YYYY-MM-DD'. */
export function kstDateStr(now: Date = new Date()): string {
  const { year, month, day } = kstDateParts(now)
  return `${year}-${month}-${day}`
}

/** KST 기준 날짜 'YYYY년 M월 D일'. */
export function kstDateKoStr(now: Date = new Date()): string {
  const { year, month, day } = kstDateParts(now)
  return `${year}년 ${Number(month)}월 ${Number(day)}일`
}
