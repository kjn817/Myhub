/**
 * KST 날짜/시간 변환 — D1 인덱스를 타는 범위 조건용 (perf-audit P-3, 2026-10-28).
 *
 * 배경: `date(컬럼, '+9 hours') = ?`, `substr(start_at, 1, 10) >= ?`,
 * `datetime(start_at, '-9 hours') BETWEEN ...` 같은 컬럼 위 함수 조건은
 * 인덱스(`idx_memos_created_at`, `idx_schedules_start`)를 무력화해 전수 스캔을
 * 유발한다. KST 기준 경계를 JS에서 미리 UTC/문자열 범위로 계산해
 * `컬럼 >= ? AND 컬럼 < ?` 형태의 범위 조건으로 바꾸면 인덱스를 탄다.
 *
 * - memos.created_at: UTC 'YYYY-MM-DD HH:mm:ss' (CURRENT_TIMESTAMP)
 * - schedules.start_at: KST wall-clock 'YYYY-MM-DDTHH:mm' 문자열
 */

export const KST_OFFSET_MS = 9 * 60 * 60 * 1000

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function toUtcDatetime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

/** 'YYYY-MM-DD'가 실제로 존재하는 달력 날짜인지 (2월 31일 같은 값을 걸러낸다). */
function isRealCalendarDate(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/**
 * KST 날짜 'YYYY-MM-DD' → UTC 'YYYY-MM-DD HH:mm:ss' 범위 [start, end).
 * KST 자정(00:00+09:00)은 UTC 전날 15:00이다.
 * 유효하지 않은 날짜면 null을 반환한다 (호출자가 구 조건의 "매치 없음"과
 * 동일하게 처리한다 — SQLite date()는 무효값을 null로 만들어 매치하지 않음).
 */
export function kstDayToUtcRange(date: string): [string, string] | null {
  if (!DATE_RE.test(date)) return null
  if (!isRealCalendarDate(date)) return null
  const startMs = Date.parse(`${date}T00:00:00+09:00`)
  if (Number.isNaN(startMs)) return null
  return [toUtcDatetime(startMs), toUtcDatetime(startMs + 24 * 60 * 60 * 1000)]
}

/** 'YYYY-MM-DD' 다음 날 키. 유효하지 않은 날짜면 ''를 반환한다. */
export function nextDayKey(date: string): string {
  if (!DATE_RE.test(date)) return ''
  if (!isRealCalendarDate(date)) return ''
  const d = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return ''
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * 현재 시각 기준 KST wall-clock 윈도우 [now, now + windowMinutes) —
 * 'YYYY-MM-DDTHH:mm:ss' 문자열 쌍.
 * schedules.start_at은 KST wall-clock 문자열이므로, UTC now에 +9시간을
 * 더한 문자열과 직접 비교하면 기존
 * `datetime(start_at, '-9 hours') BETWEEN datetime('now') AND ...` 와
 * 동일하다 (start_at은 분 정밀도라 초 단위 경계도 그대로 유지됨).
 * nowMs를 받으면 테스트에서 고정 시각으로 검증할 수 있다.
 */
export function kstWallClockWindow(windowMinutes: number, nowMs: number = Date.now()): [string, string] {
  const start = new Date(nowMs + KST_OFFSET_MS).toISOString().slice(0, 19)
  const end = new Date(nowMs + KST_OFFSET_MS + windowMinutes * 60 * 1000).toISOString().slice(0, 19)
  return [start, end]
}
