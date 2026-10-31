/**
 * MCP 읽기 도구 5개 테스트 (Jest + 실제 SQLite + 실제 마이그레이션).
 *
 * mock이 아니라 better-sqlite3 인메모리 DB에 마이그레이션 전수를 적용하고
 * FTS5·trigram·트리거가 실제로 인덱싱한 상태에서 executor를 부른다.
 * 잠금 제외는 응답 전문 대조 + id 대조로 단언한다.
 *
 * 카나리아 (이 파일이 잡아야 하는 회귀):
 * - `src/services/ai-access.ts` LIKE 단계의 `is_locked = 0 AND
 *   sensitivity <= 1` 필터를 빼면 '잠긴메모고유문구' 테스트가 실패해야 한다.
 * - FTS/trigram 인덱스 자체가 잠긴 메모를 제외하므로, MCP trigram 단계의
 *   필터만 빼서는 새지 않는다 (인덱스가 1차 방어선 — 별도 확인).
 */
import {
  MCP_TOOLS,
  MemoSearchDefinition,
  MemoSearchInputSchema,
  ScheduleListInputSchema,
  TodoListInputSchema,
  MemorySearchInputSchema,
  executeMemoSearch,
  executeScheduleList,
  executeTodoList,
  executeMemorySearch,
} from '../src/modules/mcp/tools'
import { createTestDb, lastId, type TestDb } from './mcp-d1'

const CTX = { userId: 'user@myhub.local', requestId: 'test', approvedWrites: false } as any

function seedBase(t: TestDb) {
  const { db } = t
  const memo = db.prepare('INSERT INTO memos (text, is_locked, sensitivity) VALUES (?, ?, ?)')
  memo.run('서울 여행 계획 메모', 0, 0) // 1
  memo.run('김치찌개 레시피와 장보기 목록', 0, 0) // 2
  memo.run('잠긴메모고유문구 알파베타감마', 1, 0) // 3 잠김
  memo.run('민감메모고유문구 델타엡실론', 0, 2) // 4 민감도 2
  memo.run('테니스 동호회 모임 안내', 0, 0) // 5

  const sched = db.prepare(
    'INSERT INTO schedules (title, description, location, start_at, end_at, status) VALUES (?, ?, ?, ?, ?, ?)',
  )
  sched.run('팀 회의', '주간 sync', '회의실 A', '2026-10-28T10:00', '2026-10-28T11:00', 'active') // 1
  sched.run('치과 예약', '', '치과', '2026-10-29T14:00', '2026-10-29T15:00', 'active') // 2
  sched.run('취소된 약속', '', '', '2026-10-28T15:00', null, 'cancelled') // 3
  sched.run('지난주 회의', '', '', '2026-10-20T10:00', null, 'active') // 4 범위 밖

  const todo = db.prepare(
    'INSERT INTO todos (title, description, due_at, priority, status) VALUES (?, ?, ?, ?, ?)',
  )
  todo.run('우유 사기', '저지방 1L', '2026-10-29T00:00', 1, 'pending') // 1
  todo.run('보고서 제출', '', null, 2, 'done') // 2
  todo.run('운동하기', '30분 달리기', null, 0, 'pending') // 3

  // 장기 기억 v2 플래그 ON
  db.prepare(
    "INSERT INTO ai_settings (key, value, updated_at) VALUES ('memory.v2_enabled', 'true', datetime('now'))",
  ).run()
  const mem = db.prepare(
    "INSERT INTO ai_memory_v2 (content, category, allow_ai_use, allow_provider_send, is_active) VALUES (?, ?, ?, ?, ?)",
  )
  mem.run('사용자는 테니스를 좋아한다', 'general', 1, 1, 1) // 1 활성·동의
  const activeId = lastId(db)
  mem.run('사용자는 수영을 좋아한다', 'general', 1, 1, 0) // 2 대체됨
  db.prepare('UPDATE ai_memory_v2 SET superseded_by = ? WHERE id = ?').run(activeId, lastId(db))
  mem.run('사용자는 테니스를 비밀리에 좋아한다', 'general', 0, 1, 1) // 3 동의 없음
}

describe('MCP 도구 등록부', () => {
  it('도구는 정확히 5개, 전부 읽기 전용, 쓰기 도구 없음', () => {
    expect(MCP_TOOLS.map((t) => t.definition.name).sort()).toEqual([
      'briefing.generate',
      'memo.search',
      'memory.search',
      'schedule.list',
      'todo.list',
    ])
    for (const t of MCP_TOOLS) {
      expect(t.definition.mode).toBe('read')
    }
    expect(MCP_TOOLS.some((t) => t.definition.mode === 'write')).toBe(false)
  })

  it('ToolDefinition.parameters가 Zod 스키마에서 나온 JSON Schema와 일치', () => {
    // memo.search: query 필수(1–120자), limit 기본 5(1–10)
    const p = MemoSearchDefinition.parameters as any
    expect(p.properties.query).toMatchObject({ type: 'string', minLength: 1, maxLength: 120 })
    expect(p.properties.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 10, default: 5 })
    // 주의: zod v4 toJSONSchema는 .default()가 있는 필드도 required에 넣는다.
    // MCP 런타임 검증은 Zod 스키마 자체로 하므로 limit 생략 호출은 기본값 5로
    // 동작한다 (런타임 테스트에서 실증). 이 required 목록은 P&E 레지스트리용
    // JSON Schema의 실제 동작 그대로를 단언한다.
    expect(p.required).toEqual(['query', 'limit'])
    expect(p.additionalProperties).toBe(false)
  })
})

describe('memo.search (실제 FTS·trigram)', () => {
  let t: TestDb
  beforeAll(() => {
    t = createTestDb()
    seedBase(t)
  })

  it('일반 검색: 잠기지 않은 메모만 반환, excerpt 200자 상한', async () => {
    const r = await executeMemoSearch({ query: '서울', limit: 5 }, CTX, { DB: t.d1 } as any)
    expect(r.matches.map((m) => m.id)).toEqual([1])
    expect(r.matches[0].title).toBe('서울 여행 계획 메모')
    expect(r.matches[0].excerpt.length).toBeLessThanOrEqual(200)
  })

  it('잠긴 메모만 매칭되는 질의는 빈 결과 — 내용·id 모두 절대 안 나온다', async () => {
    const r = await executeMemoSearch({ query: '잠긴메모고유문구', limit: 5 }, CTX, { DB: t.d1 } as any)
    expect(r.matches).toEqual([])
    expect(JSON.stringify(r)).not.toContain('잠긴메모고유문구')
    expect(JSON.stringify(r)).not.toContain('알파베타감마')
  })

  it('민감도 2 메모만 매칭되는 질의는 빈 결과', async () => {
    const r = await executeMemoSearch({ query: '민감메모고유문구', limit: 5 }, CTX, { DB: t.d1 } as any)
    expect(r.matches).toEqual([])
    expect(JSON.stringify(r)).not.toContain('민감메모고유문구')
    expect(JSON.stringify(r)).not.toContain('델타엡실론')
  })

  it('광범위 질의에도 잠긴·민감 메모는 섞이지 않는다', async () => {
    const r = await executeMemoSearch({ query: '메모', limit: 10 }, CTX, { DB: t.d1 } as any)
    const ids = r.matches.map((m) => m.id)
    expect(ids).not.toContain(3)
    expect(ids).not.toContain(4)
    expect(JSON.stringify(r)).not.toContain('잠긴메모고유문구')
    expect(JSON.stringify(r)).not.toContain('민감메모고유문구')
  })

  it('trigram 부분 검색: 공백을 가로지르는 부분 문자열도 찾는다', async () => {
    // '여행계'는 FTS 토큰·LIKE 어느 쪽으로도 안 잡히고 trigram만 잡는다
    const r = await executeMemoSearch({ query: '여행계', limit: 5 }, CTX, { DB: t.d1 } as any)
    expect(r.matches.map((m) => m.id)).toEqual([1])
  })

  it('입력 스키마: 빈 질의·121자·limit 범위 밖·미지 키를 거부', () => {
    expect(MemoSearchInputSchema.safeParse({ query: '' }).success).toBe(false)
    expect(MemoSearchInputSchema.safeParse({ query: 'x'.repeat(121) }).success).toBe(false)
    expect(MemoSearchInputSchema.safeParse({ query: '서울', limit: 0 }).success).toBe(false)
    expect(MemoSearchInputSchema.safeParse({ query: '서울', limit: 11 }).success).toBe(false)
    expect(MemoSearchInputSchema.safeParse({ query: '서울', extra: 1 }).success).toBe(false)
    expect(MemoSearchInputSchema.safeParse({ query: '서울' }).success).toBe(true)
    expect(MemoSearchInputSchema.parse({ query: '서울' }).limit).toBe(5)
  })
})

describe('schedule.list / todo.list (실제 DB)', () => {
  let t: TestDb
  beforeAll(() => {
    t = createTestDb()
    seedBase(t)
  })

  it('schedule.list: 날짜 범위·상태 필터가 실제 행에 적용된다', async () => {
    const r = await executeScheduleList(
      { from: '2026-10-28', to: '2026-10-29', limit: 50 },
      CTX,
      { DB: t.d1 } as any,
    )
    // status를 안 주면 취소된 일정도 목록에 나온다 (GET /api/schedule/list와 동일).
    // 범위(10-28~10-29) 안에 1·2·3이 있고, 범위 밖 4는 제외된다.
    expect(r.schedules.map((s) => s.id).sort()).toEqual([1, 2, 3])
    expect(r.schedules.find((s) => s.id === 1)!.title).toBe('팀 회의')
    // 범위 밖 일정은 제외
    expect(r.schedules.map((s) => s.id)).not.toContain(4)
    // description 200자 상한
    for (const s of r.schedules) expect(s.description.length).toBeLessThanOrEqual(200)
  })

  it('schedule.list: status=cancelled면 취소된 것만', async () => {
    const r = await executeScheduleList(
      { from: '2026-10-28', to: '2026-10-29', status: 'cancelled', limit: 50 },
      CTX,
      { DB: t.d1 } as any,
    )
    expect(r.schedules.map((s) => s.id)).toEqual([3])
  })

  it('todo.list: pending/done/all이 실제 행을 가른다', async () => {
    const pending = await executeTodoList({ status: 'pending', limit: 50 }, CTX, { DB: t.d1 } as any)
    expect(pending.todos.map((x) => x.id).sort()).toEqual([1, 3])
    const done = await executeTodoList({ status: 'done', limit: 50 }, CTX, { DB: t.d1 } as any)
    expect(done.todos.map((x) => x.id)).toEqual([2])
    const all = await executeTodoList({ status: 'all', limit: 50 }, CTX, { DB: t.d1 } as any)
    expect(all.todos.map((x) => x.id).sort()).toEqual([1, 2, 3])
    expect(all.todos.find((x) => x.id === 1)!.description).toBe('저지방 1L')
  })

  it('입력 스키마: 날짜 형식·status enum·limit 범위를 검증', () => {
    expect(ScheduleListInputSchema.safeParse({ from: '2026/10/28' }).success).toBe(false)
    expect(ScheduleListInputSchema.safeParse({ status: 'bogus' }).success).toBe(false)
    expect(ScheduleListInputSchema.safeParse({ limit: 101 }).success).toBe(false)
    expect(TodoListInputSchema.safeParse({ status: 'bogus' }).success).toBe(false)
    expect(TodoListInputSchema.parse({}).status).toBe('pending')
  })
})

describe('memory.search (v2 플래그·동의 게이트·인용 잠금)', () => {
  let t: TestDb
  beforeAll(() => {
    t = createTestDb()
    seedBase(t)
  })

  it('동의한 활성 기억이 반환되고 citable=true', async () => {
    const r = await executeMemorySearch({ query: '테니스를', limit: 5 }, CTX, { DB: t.d1 } as any)
    const active = r.memories.find((m) => m.content.includes('테니스를 좋아한다'))
    expect(active).toBeDefined()
    expect(active!.citable).toBe(true)
    expect(active!.superseded).toBe(false)
    expect(active!.content.length).toBeLessThanOrEqual(1000)
  })

  it('동의 없는 기억은 FTS에 있어도 반환되지 않는다', async () => {
    const r = await executeMemorySearch({ query: '테니스를', limit: 5 }, CTX, { DB: t.d1 } as any)
    expect(JSON.stringify(r)).not.toContain('비밀리에')
    expect(r.memories.every((m) => !m.content.includes('비밀리에'))).toBe(true)
  })

  it('대체된 기억은 superseded=true·citable=false로 표시된다', async () => {
    const r = await executeMemorySearch({ query: '수영을', limit: 5 }, CTX, { DB: t.d1 } as any)
    const sup = r.memories.find((m) => m.content.includes('수영을 좋아한다'))
    expect(sup).toBeDefined()
    expect(sup!.superseded).toBe(true)
    expect(sup!.citable).toBe(false)
    expect(sup!.superseded_by).toBe(1)
  })

  it('v2 플래그 OFF면 빈 결과 (게이트가 동작한다)', async () => {
    const off = createTestDb()
    seedBase(off)
    off.db.prepare("UPDATE ai_settings SET value = 'false' WHERE key = 'memory.v2_enabled'").run()
    const r = await executeMemorySearch({ query: '테니스를', limit: 5 }, CTX, { DB: off.d1 } as any)
    expect(r.memories).toEqual([])
  })

  it('입력 스키마: 1자 질의·121자·limit 6을 거부', () => {
    expect(MemorySearchInputSchema.safeParse({ query: '테' }).success).toBe(false)
    expect(MemorySearchInputSchema.safeParse({ query: 'x'.repeat(121) }).success).toBe(false)
    expect(MemorySearchInputSchema.safeParse({ query: '테니스', limit: 6 }).success).toBe(false)
  })
})
