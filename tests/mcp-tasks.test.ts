/**
 * MCP Tasks 확장 POC 테스트 (Jest + 실제 SQLite + 실제 마이그레이션).
 *
 * mock이 아니라 better-sqlite3 인메모리 DB에 마이그레이션 전수(0061 포함)를
 * 그대로 적용하고, 태스크 스토어·디스패처·briefing.generate executor를
 * 실제 SQL 경로로 검증한다. HTTP 경계(가로채기·SDK 왕복)는 런타임 테스트
 * (tests/runtime/mcp-tasks.test.ts)가 담당한다.
 *
 * 카나리아 (이 파일이 잡아야 하는 회귀):
 * - buildTodayBriefing의 `is_locked = 0 AND sensitivity < 2` 필터를 빼면
 *   '잠긴브리핑고유문구' 태스크 결과 테스트가 실패해야 한다.
 * - 태스크 소유권(email) 검사를 빼면 '남의 태스크 조회' 테스트가 실패해야 한다.
 * - tasks/get의 지연 완료(working -> completed 전이)를 빼면 '폴링하면
 *   완료 결과를 받는다' 테스트가 실패해야 한다.
 * - 가로채기 게이트의 Mcp-Name 검사를 빼면 '게이트' 테스트가 실패해야 한다.
 */
import {
  executeBriefingGenerate,
  BriefingGenerateDefinition,
  BriefingGenerateInputSchema,
} from '../src/modules/mcp/tools'
import {
  TASKS_EXTENSION_ID,
  TASKS_TTL_MS,
  TASKS_POLL_INTERVAL_MS,
  clientDeclaresTasksExtension,
  createTask,
  getTaskRow,
  handleTasksRequest,
  isWellFormedTasksRequest,
} from '../src/modules/mcp/tasks'
import { createTestDb, type TestDb } from './mcp-d1'

const EMAIL = 'tasks-test@myhub.local'
const OTHER_EMAIL = 'other@myhub.local'
const DATE = '2026-10-28'

function seedBase(t: TestDb) {
  const { db } = t
  const memo = db.prepare('INSERT INTO memos (text, is_locked, sensitivity) VALUES (?, ?, ?)')
  memo.run('서울 여행 계획 메모', 0, 0) // 1
  memo.run('잠긴브리핑고유문구 알파베타감마', 1, 0) // 2 잠김
  memo.run('민감브리핑고유문구 델타엡실론', 0, 2) // 3 민감도 2

  const sched = db.prepare(
    'INSERT INTO schedules (title, description, location, start_at, end_at, status) VALUES (?, ?, ?, ?, ?, ?)',
  )
  sched.run('팀 회의', '', '', '2026-10-28T10:00', null, 'active') // 1 오늘
  sched.run('내일 회의', '', '', '2026-10-29T10:00', null, 'active') // 2 내일(범위 밖)

  const todo = db.prepare(
    'INSERT INTO todos (title, description, due_at, priority, status) VALUES (?, ?, ?, ?, ?)',
  )
  todo.run('우유 사기', '', null, 1, 'pending') // 1

  // 브리핑 기억: 동의 1건, 미동의 1건
  db.prepare(
    "INSERT INTO ai_memory_v2 (content, category, allow_ai_use, allow_provider_send, is_active) VALUES (?, ?, ?, ?, ?)",
  ).run('사용자는 아침에 커피를 마신다', 'general', 1, 1, 1)
  db.prepare(
    "INSERT INTO ai_memory_v2 (content, category, allow_ai_use, allow_provider_send, is_active) VALUES (?, ?, ?, ?, ?)",
  ).run('사용자는 비밀리에 야식을 먹는다', 'general', 0, 1, 1)
}

function headers(map: Record<string, string>) {
  return { get: (name: string) => map[name] ?? null }
}

function tasksBody(method: string, taskId: string, extra: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0',
    id: 7,
    method,
    params: {
      taskId,
      ...extra,
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
    },
  }
}

function tasksHeaders(taskId: string, method = 'tasks/get') {
  return headers({
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': method,
    'Mcp-Name': taskId,
  })
}

describe('clientDeclaresTasksExtension', () => {
  it('extensions에 Tasks가 있으면 true', () => {
    expect(
      clientDeclaresTasksExtension({
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {
          extensions: { [TASKS_EXTENSION_ID]: {} },
        },
      }),
    ).toBe(true)
  })

  it('extensions가 없거나 다른 확장만 있으면 false', () => {
    expect(clientDeclaresTasksExtension({})).toBe(false)
    expect(clientDeclaresTasksExtension(undefined)).toBe(false)
    expect(
      clientDeclaresTasksExtension({
        'io.modelcontextprotocol/clientCapabilities': {
          extensions: { 'io.modelcontextprotocol/ui': {} },
        },
      }),
    ).toBe(false)
    expect(
      clientDeclaresTasksExtension({
        'io.modelcontextprotocol/clientCapabilities': {},
      }),
    ).toBe(false)
  })
})

describe('isWellFormedTasksRequest (가로채기 게이트)', () => {
  it('헤더·본문이 모두 맞으면 true', () => {
    expect(isWellFormedTasksRequest('tasks/get', tasksHeaders('task-1'), tasksBody('tasks/get', 'task-1'))).toBe(true)
    expect(
      isWellFormedTasksRequest('tasks/cancel', tasksHeaders('task-1', 'tasks/cancel'), tasksBody('tasks/cancel', 'task-1')),
    ).toBe(true)
  })

  it('Mcp-Name 누락·불일치면 false (SDK로 넘겨 -32020을 받게 한다)', () => {
    const body = tasksBody('tasks/get', 'task-1')
    expect(isWellFormedTasksRequest('tasks/get', headers({}), body)).toBe(false)
    expect(
      isWellFormedTasksRequest(
        'tasks/get',
        headers({ 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tasks/get', 'Mcp-Name': 'task-2' }),
        body,
      ),
    ).toBe(false)
  })

  it('버전 불일치·_meta 누락·tasks 외 메서드는 false', () => {
    const body = tasksBody('tasks/get', 'task-1')
    expect(
      isWellFormedTasksRequest(
        'tasks/get',
        headers({ 'MCP-Protocol-Version': '2025-06-18', 'Mcp-Method': 'tasks/get', 'Mcp-Name': 'task-1' }),
        body,
      ),
    ).toBe(false)
    expect(
      isWellFormedTasksRequest('tasks/get', tasksHeaders('task-1'), {
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/get',
        params: { taskId: 'task-1' },
      }),
    ).toBe(false)
    expect(isWellFormedTasksRequest('tools/list', tasksHeaders('task-1'), body)).toBe(false)
    expect(isWellFormedTasksRequest('tasks/get', tasksHeaders('task-1'), null)).toBe(false)
  })
})

describe('briefing.generate executor', () => {
  it('도구 정의: 읽기 전용, date는 YYYY-MM-DD 선택 사항', () => {
    expect(BriefingGenerateDefinition.name).toBe('briefing.generate')
    expect(BriefingGenerateDefinition.mode).toBe('read')
    expect(BriefingGenerateInputSchema.safeParse({}).success).toBe(true)
    expect(BriefingGenerateInputSchema.safeParse({ date: '2026-10-28' }).success).toBe(true)
    expect(BriefingGenerateInputSchema.safeParse({ date: '10/28' }).success).toBe(false)
  })

  it('확장 선언 시 태스크 핸들을 반환하고 행이 먼저 저장된다', async () => {
    const t = createTestDb()
    seedBase(t)
    const ctx = { userId: EMAIL, requestId: 'r1', approvedWrites: false, mcpTasksExtension: true } as any
    const res = (await executeBriefingGenerate({ date: DATE }, ctx, { DB: t.d1 })) as any
    expect(res.resultType).toBe('task')
    expect(res.status).toBe('working')
    expect(res.taskId).toMatch(/^task-/)
    expect(res.ttlMs).toBe(TASKS_TTL_MS)
    expect(res.pollIntervalMs).toBe(TASKS_POLL_INTERVAL_MS)
    // 핸들 반환 전에 행이 저장돼 있다 (스펙 요구)
    const row = await getTaskRow(t.d1, EMAIL, res.taskId)
    expect(row).not.toBeNull()
    expect(row!.status).toBe('working')
    expect(row!.tool).toBe('briefing.generate')
    expect(JSON.parse(row!.params_json)).toEqual({ date: DATE })
  })

  it('확장 미선언 시 같은 브리핑을 동기 결과로 낸다', async () => {
    const t = createTestDb()
    seedBase(t)
    const ctx = { userId: EMAIL, requestId: 'r1', approvedWrites: false } as any
    const res = (await executeBriefingGenerate({ date: DATE }, ctx, { DB: t.d1 })) as any
    expect(res.resultType).toBeUndefined()
    expect(res.ok).toBe(true)
    expect(res.date).toBe(DATE)
    expect(res.counts).toEqual({ schedules: 1, todos: 1, memos: 1, memories: 1 })
    expect(res.schedules.map((s: any) => s.title)).toEqual(['팀 회의'])
    expect(res.memos.map((m: any) => m.id)).toEqual([1])
    expect(JSON.stringify(res)).not.toContain('잠긴브리핑고유문구')
    expect(JSON.stringify(res)).not.toContain('민감브리핑고유문구')
    expect(JSON.stringify(res)).not.toContain('비밀리에')
  })
})

describe('tasks 디스패처 (tasks/get·update·cancel)', () => {
  async function workingTask(t: TestDb, email = EMAIL) {
    return createTask(t.d1, email, 'briefing.generate', { date: DATE })
  }

  it('폴링하면 완료 결과를 받는다 — 잠긴 메모·미동의 기억이 결과에 없다', async () => {
    const t = createTestDb()
    seedBase(t)
    const handle = await workingTask(t)
    const res = await handleTasksRequest(t.d1, EMAIL, 'tasks/get', { taskId: handle.taskId }, 1)
    expect(res!.error).toBeUndefined()
    expect(res!.result!.resultType).toBe('complete')
    expect(res!.result!.status).toBe('completed')
    expect(res!.result!.taskId).toBe(handle.taskId)
    const callResult = (res!.result as any).result
    expect(callResult.structuredContent.counts).toEqual({ schedules: 1, todos: 1, memos: 1, memories: 1 })
    expect(callResult.structuredContent.schedules[0].title).toBe('팀 회의')
    expect(JSON.parse(callResult.content[0].text)).toEqual(callResult.structuredContent)
    // 카나리아: 잠금 필터가 빠지면 이 단언이 실패한다
    expect(JSON.stringify(res)).not.toContain('잠긴브리핑고유문구')
    expect(JSON.stringify(res)).not.toContain('알파베타감마')
    expect(JSON.stringify(res)).not.toContain('민감브리핑고유문구')
    expect(JSON.stringify(res)).not.toContain('비밀리에')
    // 행도 completed로 전이됐다
    const row = await getTaskRow(t.d1, EMAIL, handle.taskId)
    expect(row!.status).toBe('completed')
    expect(row!.result_json).toContain('팀 회의')
  })

  it('두 번째 폴링은 저장된 결과를 그대로 돌려준다', async () => {
    const t = createTestDb()
    seedBase(t)
    const handle = await workingTask(t)
    const first = await handleTasksRequest(t.d1, EMAIL, 'tasks/get', { taskId: handle.taskId }, 1)
    const second = await handleTasksRequest(t.d1, EMAIL, 'tasks/get', { taskId: handle.taskId }, 2)
    expect(second!.result!.status).toBe('completed')
    expect((second!.result as any).result).toEqual((first!.result as any).result)
    expect(second!.id).toBe(2)
  })

  it('없는 태스크 조회는 -32602 task not found', async () => {
    const t = createTestDb()
    seedBase(t)
    const res = await handleTasksRequest(t.d1, EMAIL, 'tasks/get', { taskId: 'task-nope' }, 1)
    expect(res!.error).toEqual({ code: -32602, message: 'task not found' })
  })

  it('남의 태스크는 조회할 수 없다 (소유권)', async () => {
    const t = createTestDb()
    seedBase(t)
    const handle = await workingTask(t, EMAIL)
    const res = await handleTasksRequest(t.d1, OTHER_EMAIL, 'tasks/get', { taskId: handle.taskId }, 1)
    expect(res!.error).toEqual({ code: -32602, message: 'task not found' })
    // 남의 취소도 안 된다
    const cancel = await handleTasksRequest(t.d1, OTHER_EMAIL, 'tasks/cancel', { taskId: handle.taskId }, 1)
    expect(cancel!.error).toEqual({ code: -32602, message: 'task not found' })
  })

  it('취소한 태스크는 cancelled로 남고 결과 필드가 없다', async () => {
    const t = createTestDb()
    seedBase(t)
    const handle = await workingTask(t)
    const cancel = await handleTasksRequest(t.d1, EMAIL, 'tasks/cancel', { taskId: handle.taskId }, 1)
    expect(cancel!.error).toBeUndefined()
    expect(cancel!.result!.resultType).toBe('complete')
    const after = await handleTasksRequest(t.d1, EMAIL, 'tasks/get', { taskId: handle.taskId }, 2)
    expect(after!.result!.status).toBe('cancelled')
    expect((after!.result as any).result).toBeUndefined()
  })

  it('이미 완료된 태스크 취소도 빈 ack로 답한다 (협력적 취소)', async () => {
    const t = createTestDb()
    seedBase(t)
    const handle = await workingTask(t)
    await handleTasksRequest(t.d1, EMAIL, 'tasks/get', { taskId: handle.taskId }, 1)
    const cancel = await handleTasksRequest(t.d1, EMAIL, 'tasks/cancel', { taskId: handle.taskId }, 2)
    expect(cancel!.error).toBeUndefined()
    expect(cancel!.result!.resultType).toBe('complete')
    const after = await handleTasksRequest(t.d1, EMAIL, 'tasks/get', { taskId: handle.taskId }, 3)
    expect(after!.result!.status).toBe('completed')
  })

  it('tasks/update는 input_required 태스크가 없어 -32602이다', async () => {
    const t = createTestDb()
    seedBase(t)
    const handle = await workingTask(t)
    const res = await handleTasksRequest(
      t.d1,
      EMAIL,
      'tasks/update',
      { taskId: handle.taskId, inputResponses: {} },
      1,
    )
    expect(res!.error).toEqual({ code: -32602, message: 'task is not awaiting input' })
    const missing = await handleTasksRequest(t.d1, EMAIL, 'tasks/update', { taskId: 'task-nope', inputResponses: {} }, 1)
    expect(missing!.error).toEqual({ code: -32602, message: 'task not found' })
  })

  it('만료된 태스크는 expired로 답하고 행을 지운다', async () => {
    const t = createTestDb()
    seedBase(t)
    const old = new Date(Date.now() - (TASKS_TTL_MS + 60_000)).toISOString()
    t.db
      .prepare(
        `INSERT INTO mcp_tasks
           (task_id, email, tool, status, params_json, ttl_ms, poll_interval_ms, created_at, updated_at)
         VALUES (?, ?, 'briefing.generate', 'working', '{}', ?, ?, ?, ?)`,
      )
      .run('task-old', EMAIL, TASKS_TTL_MS, TASKS_POLL_INTERVAL_MS, old, old)
    const res = await handleTasksRequest(t.d1, EMAIL, 'tasks/get', { taskId: 'task-old' }, 1)
    expect(res!.error).toEqual({ code: -32602, message: 'task expired' })
    expect(await getTaskRow(t.d1, EMAIL, 'task-old')).toBeNull()
  })

  it('tasks 외 메서드는 null (호출자가 SDK로 넘긴다)', async () => {
    const t = createTestDb()
    seedBase(t)
    expect(await handleTasksRequest(t.d1, EMAIL, 'tools/list', {}, 1)).toBeNull()
  })
})
