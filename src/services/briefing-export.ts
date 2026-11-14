// 아침 브리핑·주간 보고서 → PPTX 덱 조립 (D1 조회 + 덱 데이터 생성)
//
// 보안 경계: 메모는 잠금 해제(is_locked=0) + Restricted 제외(sensitivity<2)만
// 내보낸다. 잠긴 메모는 모든 외부 전송 경로에서 제외된다는 원칙이 PPTX
// 내보내기에도 그대로 적용된다 (브리핑 라우트·통합 검색과 동일 필터).
// 날짜 기준은 Asia/Seoul (브리핑 라우트와 동일).

import type { PptxDeck, PptxSlide } from './pptx-builder'
import { kstDateStr } from '../lib/kst'

export { kstDateStr }

interface ScheduleRow {
  id: number
  title: string
  start_at: string
  end_at: string | null
  location: string
}

interface TodoRow {
  id: number
  title: string
  due_at: string | null
  priority: number
  status: string
}

interface MemoRow {
  id: number
  text: string
  created_at: string
}

// ---- 날짜 (Asia/Seoul, 공용 코어 src/lib/kst.ts) ----

/** YYYY-MM-DD에 일수를 더한다 (UTC 기준 연산으로 DST 영향 없음). */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + days))
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(next.getUTCDate()).padStart(2, '0')
  return `${next.getUTCFullYear()}-${mm}-${dd}`
}

/** YYYY-MM-DD의 요일 (0=일 … 6=토). */
function dayOfWeek(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** 해당 날짜가 속한 주의 월요일 (YYYY-MM-DD). */
export function weekMonday(dateStr: string): string {
  const offset = (dayOfWeek(dateStr) + 6) % 7 // 월요일=0
  return addDays(dateStr, -offset)
}

/** 'YYYY-MM-DD' → 'M/D' 표시. */
function shortDate(dateStr: string): string {
  const [, m, d] = dateStr.split('-').map(Number)
  return `${m}/${d}`
}

/** ISO 시작 시각에서 'HH:MM'을 뽑는다 (형식이 다르면 원문 반환). */
function hhmm(iso: string): string {
  const m = iso.match(/T(\d{2}:\d{2})/)
  return m ? m[1] : iso
}

const PRIORITY_LABEL: Record<number, string> = { 2: '높음', 1: '보통', 0: '낮음' }

function priorityLabel(p: number): string {
  return PRIORITY_LABEL[p] ?? '보통'
}

/** 메모 본문을 한 줄 요약으로 자른다 (최대 120자). */
function memoOneLine(text: string, maxLen = 120): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > maxLen ? one.slice(0, maxLen) + '…' : one
}

// ---- 아침 브리핑 ----

export interface MorningBriefingData {
  date: string
  schedules: ScheduleRow[]
  todos: TodoRow[]
  memos: MemoRow[]
}

/** D1에서 아침 브리핑 재료를 조회한다. */
export async function fetchMorningBriefing(db: D1Database, now: Date = new Date()): Promise<MorningBriefingData> {
  const date = kstDateStr(now)
  const start = `${date}T00:00:00`
  const end = `${addDays(date, 1)}T00:00:00`

  const { results: schedules } = await db
    .prepare(
      `SELECT id, title, start_at, end_at, location FROM schedules
       WHERE start_at >= ? AND start_at < ? AND status = 'active'
       ORDER BY start_at ASC`,
    )
    .bind(start, end)
    .all<ScheduleRow>()

  const { results: todos } = await db
    .prepare(
      `SELECT id, title, due_at, priority, status FROM todos
       WHERE status = 'pending'
       ORDER BY priority DESC, due_at ASC NULLS LAST, id DESC
       LIMIT 10`,
    )
    .all<TodoRow>()

  const { results: memos } = await db
    .prepare(
      `SELECT id, substr(text, 1, 200) as text, created_at FROM memos
       WHERE is_locked = 0 AND sensitivity < 2
       ORDER BY id DESC
       LIMIT 5`,
    )
    .all<MemoRow>()

  return { date, schedules: schedules ?? [], todos: todos ?? [], memos: memos ?? [] }
}

/** 조회된 재료로 아침 브리핑 덱을 만든다 (DB 의존성 없음 — 단위 테스트용). */
export function morningBriefingDeck(data: MorningBriefingData): PptxDeck {
  const slides: PptxSlide[] = [
    {
      kind: 'title',
      title: '아침 브리핑',
      subtitle: `${data.date} · 오늘 일정 ${data.schedules.length}건 · 할 일 ${data.todos.length}건`,
      meta: 'MyHub',
    },
    {
      kind: 'bullets',
      title: '오늘 일정',
      bullets: data.schedules.map(
        (s) => `${hhmm(s.start_at)}  ${s.title}${s.location ? ` (${s.location})` : ''}`,
      ),
      emptyText: '오늘 일정이 없습니다',
    },
    {
      kind: 'bullets',
      title: '할 일',
      bullets: data.todos.map(
        (t) => `[${priorityLabel(t.priority)}] ${t.title}${t.due_at ? ` (~${shortDate(t.due_at.slice(0, 10))})` : ''}`,
      ),
      emptyText: '미완료 할 일이 없습니다',
    },
    {
      kind: 'bullets',
      title: '메모',
      bullets: data.memos.map((m) => memoOneLine(m.text)),
      emptyText: '표시할 메모가 없습니다',
    },
  ]

  // 차트: 미완료 할 일 우선순위 분포 (할 일이 있을 때만)
  if (data.todos.length > 0) {
    const counts = [2, 1, 0].map((p) => data.todos.filter((t) => t.priority === p).length)
    slides.push({
      kind: 'chart',
      title: '할 일 우선순위 분포',
      categories: ['높음', '보통', '낮음'],
      series: [{ name: '미완료 할 일', values: counts }],
    })
  }

  return { title: `아침 브리핑 ${data.date}`, slides }
}

/** D1 → 아침 브리핑 덱 (라우트에서 사용). */
export async function buildMorningBriefingDeck(db: D1Database, now: Date = new Date()): Promise<PptxDeck> {
  return morningBriefingDeck(await fetchMorningBriefing(db, now))
}

// ---- 주간 보고서 ----

export interface WeeklyReportData {
  weekStart: string // 월요일 YYYY-MM-DD
  weekEnd: string // 일요일 YYYY-MM-DD
  schedules: ScheduleRow[]
  todosDone: number
  todosPending: number
  memos: MemoRow[]
}

/** D1에서 주간 보고서 재료를 조회한다. */
export async function fetchWeeklyReport(db: D1Database, now: Date = new Date()): Promise<WeeklyReportData> {
  const weekStart = weekMonday(kstDateStr(now))
  const weekEnd = addDays(weekStart, 6)
  const start = `${weekStart}T00:00:00`
  const end = `${addDays(weekEnd, 1)}T00:00:00`

  const { results: schedules } = await db
    .prepare(
      `SELECT id, title, start_at, end_at, location FROM schedules
       WHERE start_at >= ? AND start_at < ? AND status = 'active'
       ORDER BY start_at ASC`,
    )
    .bind(start, end)
    .all<ScheduleRow>()

  const doneRow = await db
    .prepare(`SELECT COUNT(*) as n FROM todos WHERE status = 'done'`)
    .first<{ n: number }>()
  const pendingRow = await db
    .prepare(`SELECT COUNT(*) as n FROM todos WHERE status = 'pending'`)
    .first<{ n: number }>()

  // created_at은 SQLite CURRENT_TIMESTAMP 형식('YYYY-MM-DD HH:MM:SS', 공백 구분)
  // 이라 'T' 구분자 범위와 문자열 비교하면 경계 날짜가 어긋난다 — 날짜 부분만 비교.
  const { results: memos } = await db
    .prepare(
      `SELECT id, substr(text, 1, 200) as text, created_at FROM memos
       WHERE is_locked = 0 AND sensitivity < 2
         AND substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) <= ?
       ORDER BY id DESC
       LIMIT 10`,
    )
    .bind(weekStart, weekEnd)
    .all<MemoRow>()

  return {
    weekStart,
    weekEnd,
    schedules: schedules ?? [],
    todosDone: doneRow?.n ?? 0,
    todosPending: pendingRow?.n ?? 0,
    memos: memos ?? [],
  }
}

/** 조회된 재료로 주간 보고서 덱을 만든다 (DB 의존성 없음 — 단위 테스트용). */
export function weeklyReportDeck(data: WeeklyReportData): PptxDeck {
  const weekLabel = `${shortDate(data.weekStart)} ~ ${shortDate(data.weekEnd)}`
  const dayNames = ['월', '화', '수', '목', '금', '토', '일']

  // 요일별 일정 목록
  const byDay: string[][] = Array.from({ length: 7 }, () => [])
  for (const s of data.schedules) {
    const day = s.start_at.slice(0, 10)
    const idx = Math.max(0, Math.min(6, Math.round((Date.parse(day + 'T00:00:00Z') - Date.parse(data.weekStart + 'T00:00:00Z')) / 86400000)))
    byDay[idx].push(`${hhmm(s.start_at)}  ${s.title}`)
  }
  const scheduleBullets: string[] = []
  byDay.forEach((items, i) => {
    if (items.length === 0) return
    scheduleBullets.push(`[${dayNames[i]} ${shortDate(addDays(data.weekStart, i))}]`)
    scheduleBullets.push(...items.map((x) => `  ${x}`))
  })

  const slides: PptxSlide[] = [
    {
      kind: 'title',
      title: '주간 보고서',
      subtitle: `${weekLabel} · 일정 ${data.schedules.length}건 · 할 일 완료 ${data.todosDone}건 / 미완료 ${data.todosPending}건`,
      meta: 'MyHub',
    },
    {
      kind: 'bullets',
      title: `주간 일정 (${weekLabel})`,
      bullets: scheduleBullets,
      emptyText: '이번 주 일정이 없습니다',
    },
    {
      kind: 'bullets',
      title: '할 일 현황',
      // todos에는 완료 시각 컬럼이 없어 주간 범위를 잴 수 없다 — 현재 기준 전체 건수임을 명시.
      bullets: [
        `완료: ${data.todosDone}건 (현재 기준)`,
        `미완료: ${data.todosPending}건 (현재 기준)`,
        data.todosDone + data.todosPending > 0
          ? `완료율: ${Math.round((data.todosDone / (data.todosDone + data.todosPending)) * 100)}%`
          : '등록된 할 일이 없습니다',
      ],
    },
    {
      kind: 'bullets',
      title: '이번 주 메모',
      bullets: data.memos.map((m) => memoOneLine(m.text)),
      emptyText: '이번 주에 작성된 메모가 없습니다',
    },
  ]

  // 차트: 요일별 일정 수 (일정이 있을 때만)
  if (data.schedules.length > 0) {
    slides.push({
      kind: 'chart',
      title: '요일별 일정 수',
      categories: dayNames,
      series: [{ name: '일정', values: byDay.map((x) => x.length) }],
    })
  }

  return { title: `주간 보고서 ${weekLabel}`, slides }
}

/** D1 → 주간 보고서 덱 (라우트에서 사용). */
export async function buildWeeklyReportDeck(db: D1Database, now: Date = new Date()): Promise<PptxDeck> {
  return weeklyReportDeck(await fetchWeeklyReport(db, now))
}
