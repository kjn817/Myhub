/**
 * Phase 3B: 서버 시간 컨텍스트
 *
 * 원칙:
 * 1. 현재 시간은 서버에서 생성
 * 2. 모델이 임의로 현재 날짜를 만들지 않음
 * 3. 요청 단위에서 기준 시각 고정
 * 4. Fallback 시에도 최초 기준 시각 유지
 * 5. 잘못된 시간대는 안전하게 처리
 * 6. 사용자 메시지로 변경 불가
 */

export interface ServerTimeContext {
  /** 요청 시점의 ISO 8601 타임스탬프 */
  nowIso: string
  /** IANA 시간대 */
  timezone: string
  /** 현지 날짜 YYYY-MM-DD */
  todayLocal: string
  /** 현지 요일 (0=일요일) */
  weekdayLocal: number
  /** 현지 요일 이름 */
  weekdayName: string
  /** 이번 주 월요일 날짜 YYYY-MM-DD */
  weekStartLocal: string
  /** 요청 시점의 epoch ms (Fallback 시 유지용) */
  epochMs: number
}

const WEEKDAY_NAMES = ['일', '월', '화', '수', '목', '금', '토']

/**
 * IANA 시간대 유효성 검증
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * 서버 시간 컨텍스트 생성
 *
 * @param timezone IANA 시간대 (없으면 Asia/Seoul)
 * @param fixedEpochMs 고정 기준 시각 (Fallback 시 이전 값 유지)
 */
export function createServerTimeContext(
  timezone?: string,
  fixedEpochMs?: number
): ServerTimeContext {
  // 시간대 검증 (잘못된 값은 Asia/Seoul로 폴백)
  const tz = timezone && isValidTimezone(timezone) ? timezone : 'Asia/Seoul'

  const epochMs = fixedEpochMs ?? Date.now()
  const now = new Date(epochMs)

  // 현지 날짜/요일 계산
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const todayLocal = fmt.format(now) // YYYY-MM-DD

  const weekdayFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  })
  // 요일을 숫자로 변환
  const weekdayStr = weekdayFmt.format(now) // Sun, Mon, ...
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  }
  const weekdayLocal = weekdayMap[weekdayStr] ?? 0

  // 이번 주 월요일 계산
  const daysFromMonday = (weekdayLocal + 6) % 7
  const monday = new Date(epochMs - daysFromMonday * 24 * 60 * 60 * 1000)
  const weekStartLocal = fmt.format(monday)

  return {
    nowIso: now.toISOString(),
    timezone: tz,
    todayLocal,
    weekdayLocal,
    weekdayName: WEEKDAY_NAMES[weekdayLocal],
    weekStartLocal,
    epochMs,
  }
}

/**
 * Phase 3A TimeContext로 변환 (프롬프트용)
 */
export function toPromptTimeContext(ctx: ServerTimeContext): {
  nowIso: string
  timezone: string
  todayLocal: string
  weekStart: string
} {
  return {
    nowIso: ctx.nowIso,
    timezone: ctx.timezone,
    todayLocal: ctx.todayLocal,
    weekStart: ctx.weekStartLocal,
  }
}
