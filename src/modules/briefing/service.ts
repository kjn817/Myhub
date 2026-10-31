/**
 * 오늘 브리핑 조회 — HTTP 라우트(GET /api/briefing/today)와 MCP 도구
 * (briefing.generate)가 같은 함수를 쓴다. 두 경로의 내용이 달라지면
 * 안 되므로 조회 로직의 유일한 소유자는 이 파일이다.
 *
 * 보안 경계 (라우트와 동일 — MCP 경로도 이 필터를 그대로 탄다):
 * - 메모: is_locked=0, sensitivity<2 (잠금·Restricted 제외)
 * - 기억: allow_ai_use=1 (AI 사용 동의만)
 */

export interface BriefingScheduleRow {
  id: number
  title: string
  start_at: string
  end_at: string | null
  location: string
}

export interface BriefingTodoRow {
  id: number
  title: string
  due_at: string | null
  priority: number
}

export interface BriefingMemoRow {
  id: number
  text: string
}

export interface BriefingMemoryRow {
  id: number
  content: string
}

export interface TodayBriefing {
  ok: true
  date: string
  timezone: string
  schedules: BriefingScheduleRow[]
  todos: BriefingTodoRow[]
  memos: BriefingMemoRow[]
  memories: BriefingMemoryRow[]
  counts: { schedules: number; todos: number; memos: number; memories: number }
}

// 오늘 날짜 (Asia/Seoul 기준, YYYY-MM-DD)
// 서버 UTC와 한국 시간의 날짜 경계를 정확히 처리
export function todayStr(timezone: string = 'Asia/Seoul'): string {
  const now = new Date()
  // Intl을 사용해 지정 시간대의 날짜 계산
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)

  const y = parts.find((p) => p.type === 'year')?.value ?? ''
  const m = parts.find((p) => p.type === 'month')?.value ?? ''
  const d = parts.find((p) => p.type === 'day')?.value ?? ''
  return `${y}-${m}-${d}`
}

// 날짜 하루 범위 (ISO, 시간대 고려)
// DB의 start_at은 ISO 문자열로 저장됨을 가정
export function dayRange(date: string): { start: string; end: string } {
  const [y, m, d] = date.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  const ny = next.getUTCFullYear()
  const nm = String(next.getUTCMonth() + 1).padStart(2, '0')
  const nd = String(next.getUTCDate()).padStart(2, '0')
  const tomorrow = `${ny}-${nm}-${nd}`

  return {
    start: `${date}T00:00:00`,
    end: `${tomorrow}T00:00:00`,
  }
}

/**
 * 오늘(또는 지정 날짜) 브리핑을 만든다.
 * @param db D1 바인딩
 * @param date YYYY-MM-DD (없으면 오늘, Asia/Seoul 기준)
 */
export async function buildTodayBriefing(db: D1Database, date?: string): Promise<TodayBriefing> {
  const timezone = 'Asia/Seoul'
  const day = date ?? todayStr(timezone)
  const range = dayRange(day)

  // 오늘 일정 (active만, 시작 시간순)
  // 시간대 경계를 정확히 처리: 오늘 00:00 포함, 내일 00:00 제외
  const { results: schedules } = await db
    .prepare(
      `SELECT id, title, start_at, end_at, location
       FROM schedules
       WHERE start_at >= ? AND start_at < ? AND status = 'active'
       ORDER BY start_at ASC`,
    )
    .bind(range.start, range.end)
    .all<BriefingScheduleRow>()

  // 미완료 할일 (우선순위 높은 순, 최대 10개)
  const { results: todos } = await db
    .prepare(
      `SELECT id, title, due_at, priority
       FROM todos
       WHERE status = 'pending'
       ORDER BY priority DESC, due_at ASC NULLS LAST, id DESC
       LIMIT 10`,
    )
    .all<BriefingTodoRow>()

  // 중요 메모 (개인정보 보호 필터 적용)
  // - is_locked=0 (잠금 해제)
  // - sensitivity<2 (Restricted 제외)
  const { results: memos } = await db
    .prepare(
      `SELECT id, substr(text, 1, 200) as text
       FROM memos
       WHERE is_locked = 0 AND sensitivity < 2
       ORDER BY id DESC
       LIMIT 5`,
    )
    .all<BriefingMemoRow>()

  // AI 기억 (동의 필터 적용)
  // - allow_ai_use=1 (AI 사용 동의)
  // - 기본 거부 정책: NULL이나 0은 제외
  let memories: BriefingMemoryRow[] = []
  try {
    const memResult = await db
      .prepare(
        `SELECT id, substr(content, 1, 200) as content
         FROM ai_memory_v2
         WHERE allow_ai_use = 1
         ORDER BY id DESC
         LIMIT 5`,
      )
      .all<BriefingMemoryRow>()
    memories = memResult.results ?? []
  } catch {
    // ai_memory_v2 테이블이 없으면 빈 배열
    memories = []
  }

  return {
    ok: true,
    date: day,
    timezone,
    schedules: schedules ?? [],
    todos: todos ?? [],
    memos: memos ?? [],
    memories,
    counts: {
      schedules: schedules?.length ?? 0,
      todos: todos?.length ?? 0,
      memos: memos?.length ?? 0,
      memories: memories.length,
    },
  }
}
