/**
 * 일정 날짜/시간 문자열 정규화 — 저장 형식 'YYYY-MM-DDTHH:mm:ss+09:00'으로 통일한다.
 * - 시간대가 없으면 KST wall-clock으로 간주해 +09:00을 붙인다.
 * - 'Z'면 KST로 변환한다. 그 외 오프셋은 콜론 표기로 정규화만 한다.
 */

const SCHEDULE_OFFSET = '+09:00'

export function normalizeScheduleDateTime(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const s = value.trim()
  const m = s.match(
    /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?$/
  )
  if (!m) return value
  const [, date, hh, mm, ss, zone] = m
  const time = `${hh ?? '00'}:${mm ?? '00'}:${ss ?? '00'}`
  if (!zone) return `${date}T${time}${SCHEDULE_OFFSET}`
  if (zone === 'Z') {
    const ms = Date.parse(`${date}T${time}Z`)
    if (!Number.isFinite(ms)) return value
    const kst = new Date(ms + 9 * 60 * 60 * 1000)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${kst.getUTCFullYear()}-${p(kst.getUTCMonth() + 1)}-${p(kst.getUTCDate())}T${p(kst.getUTCHours())}:${p(kst.getUTCMinutes())}:${p(kst.getUTCSeconds())}${SCHEDULE_OFFSET}`
  }
  const z = zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone
  return `${date}T${time}${z}`
}
