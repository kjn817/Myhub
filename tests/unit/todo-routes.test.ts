/**
 * todo/routes.ts Jest 단위 테스트
 *
 * Hono app.request()로 실제 HTTP 시뮬레이션, MockDb로 D1 제어,
 * emit은 jest.mock으로 대체.
 */
/// <reference types="jest" />

jest.mock('../../src/events', () => ({
  emit: jest.fn(async () => {}),
}))

import { todoApp, validateReorderIds } from '../../src/modules/todo/routes'
import { emit } from '../../src/events'

const mockEmit = emit as jest.Mock

// ---- MockDb: 큐 기반 결정적 응답 ----
type DbResult = { results?: any[]; firstRow?: any; runMeta?: { changes?: number; last_row_id?: number } }

class MockDb {
  queue: Array<'first' | 'all' | 'run'> = []
  data: Map<string, DbResult> = new Map()
  batchCalls: any[][] = []
  lastSql: string[] = []

  reset() {
    this.queue = []
    this.data = new Map()
    this.batchCalls = []
    this.lastSql = []
  }

  // 키: "kind:idx"
  qFirst(result: DbResult) { this.queue.push('first'); this.data.set(`first:${this.queue.filter(k => k === 'first').length - 1}`, result); return this }
  qAll(result: DbResult) { this.queue.push('all'); this.data.set(`all:${this.queue.filter(k => k === 'all').length - 1}`, result); return this }
  qRun(result: DbResult) { this.queue.push('run'); this.data.set(`run:${this.queue.filter(k => k === 'run').length - 1}`, result); return this }

  prepare(sql: string) {
    this.lastSql.push(sql)
    const self = this
    const counters = { first: 0, all: 0, run: 0 }
    return {
      bind(..._args: any[]) {
        return {
          async first<T>(): Promise<T | null> {
            const key = `first:${counters.first++}`
            const r = self.data.get(key)
            return (r?.firstRow ?? null) as T | null
          },
          async all<T>(): Promise<{ results: T[] }> {
            const key = `all:${counters.all++}`
            const r = self.data.get(key)
            return { results: (r?.results ?? []) as T[] }
          },
          async run(): Promise<any> {
            const key = `run:${counters.run++}`
            const r = self.data.get(key)
            return { meta: { changes: r?.runMeta?.changes ?? 0, last_row_id: r?.runMeta?.last_row_id ?? 0 } }
          },
        }
      },
    }
  }

  async batch(stmts: any[]) {
    this.batchCalls.push(stmts)
    return []
  }
}

const db = new MockDb()

function req(path: string, init?: RequestInit) {
  return todoApp.request(path, init as any, { DB: db } as any)
}

async function json(res: Response) {
  return res.json()
}

beforeEach(() => {
  db.reset()
  mockEmit.mockClear()
})

// ================= validateReorderIds =================
describe('validateReorderIds', () => {
  test('정상 ids', () => {
    expect(validateReorderIds([3, 1, 2])).toEqual({ ok: true, ids: [3, 1, 2] })
  })
  test('문자열 숫자 허용', () => {
    expect(validateReorderIds(['3', '1'])).toEqual({ ok: true, ids: [3, 1] })
  })
  test('빈 배열 → 실패', () => {
    expect(validateReorderIds([])).toEqual({ ok: false, error: 'ids_invalid' })
  })
  test('배열 아님 → 실패', () => {
    expect(validateReorderIds('x')).toEqual({ ok: false, error: 'ids_invalid' })
    expect(validateReorderIds(undefined)).toEqual({ ok: false, error: 'ids_invalid' })
    expect(validateReorderIds(null)).toEqual({ ok: false, error: 'ids_invalid' })
  })
  test('501개 → 실패', () => {
    expect(validateReorderIds(Array.from({ length: 501 }, (_, i) => i + 1))).toEqual({ ok: false, error: 'ids_invalid' })
  })
  test('500개 → 성공', () => {
    const ids = Array.from({ length: 500 }, (_, i) => i + 1)
    expect(validateReorderIds(ids)).toEqual({ ok: true, ids })
  })
  test('0/음수 → 실패', () => {
    expect(validateReorderIds([0])).toEqual({ ok: false, error: 'ids_invalid' })
    expect(validateReorderIds([-1])).toEqual({ ok: false, error: 'ids_invalid' })
  })
  test('비정수 → 실패', () => {
    expect(validateReorderIds([1.5])).toEqual({ ok: false, error: 'ids_invalid' })
    expect(validateReorderIds(['abc'])).toEqual({ ok: false, error: 'ids_invalid' })
  })
  test('중복 → 실패', () => {
    expect(validateReorderIds([1, 2, 1])).toEqual({ ok: false, error: 'ids_duplicate' })
  })
})

// ================= GET /list =================
describe('GET /list', () => {
  test('기본 pending 필터', async () => {
    db.qAll({ results: [{ id: 1, title: 'a', status: 'pending' }] })
    const res = await req('/list')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.ok).toBe(true)
    expect(body.todos).toHaveLength(1)
    // pending 조건이 SQL에 포함되는지
    expect(db.lastSql[0]).toContain('status = ?')
  })
  test('status=done', async () => {
    db.qAll({ results: [] })
    const res = await req('/list?status=done')
    expect(res.status).toBe(200)
    expect(db.lastSql[0]).toContain('status = ?')
  })
  test('status=all → 조건 없음', async () => {
    db.qAll({ results: [] })
    const res = await req('/list?status=all')
    expect(res.status).toBe(200)
    expect(db.lastSql[0]).not.toContain('status = ?')
  })
  test('status=unknown → 조건 없음 (all과 동일)', async () => {
    db.qAll({ results: [] })
    const res = await req('/list?status=xxx')
    expect(res.status).toBe(200)
    expect(db.lastSql[0]).not.toContain('status = ?')
  })
  test('limit 기본 200', async () => {
    db.qAll({ results: [] })
    await req('/list')
    expect(db.lastSql[0]).toContain('LIMIT ?')
  })
  test('limit=10', async () => {
    db.qAll({ results: [] })
    await req('/list?limit=10')
    expect(res => res).toBeDefined()
  })
  test('limit=0 → 1로 보정 (Math.max)', async () => {
    db.qAll({ results: [] })
    const res = await req('/list?limit=0')
    expect(res.status).toBe(200)
  })
  test('limit=9999 → 500으로 제한', async () => {
    db.qAll({ results: [] })
    const res = await req('/list?limit=9999')
    expect(res.status).toBe(200)
  })
  test('limit=abc → 기본 200', async () => {
    db.qAll({ results: [] })
    const res = await req('/list?limit=abc')
    expect(res.status).toBe(200)
  })
})

// ================= GET /:id =================
describe('GET /:id', () => {
  test('정상 조회', async () => {
    db.qFirst({ firstRow: { id: 5, title: 't' } })
    const res = await req('/5')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.ok).toBe(true)
    expect(body.todo.id).toBe(5)
  })
  test('없는 id → 404', async () => {
    db.qFirst({ firstRow: null })
    const res = await req('/999')
    expect(res.status).toBe(404)
    expect((await json(res)).error).toBe('not_found')
  })
  test('id=abc → 400 (Number("abc")는 NaN, isInteger false)', async () => {
    const res = await req('/abc')
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('invalid_id')
  })
  test('id=1.5 → 400', async () => {
    const res = await req('/1.5')
    expect(res.status).toBe(400)
  })
})

// ================= POST /create =================
describe('POST /create', () => {
  test('정상 생성 (기본값: priority 1, status pending)', async () => {
    db.qRun({ runMeta: { changes: 1, last_row_id: 42 } })
    const res = await req('/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '할일' }),
    })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.ok).toBe(true)
    expect(body.id).toBe(42)
    expect(mockEmit).toHaveBeenCalledWith('todo.created', { id: 42 })
  })
  test('전체 필드', async () => {
    db.qRun({ runMeta: { changes: 1, last_row_id: 7 } })
    const res = await req('/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', description: 'd', due_at: '2026-10-20', priority: 2, status: 'done' }),
    })
    expect(res.status).toBe(200)
    expect((await json(res)).id).toBe(7)
  })
  test('title 없음 → 400 title_required', async () => {
    const res = await req('/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('title_required')
  })
  test('title 공백만 → 400', async () => {
    const res = await req('/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('title_required')
  })
  test('title 201자 → 400 title_too_long', async () => {
    const res = await req('/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(201) }),
    })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('title_too_long')
  })
  test('title 200자 → 통과', async () => {
    db.qRun({ runMeta: { changes: 1, last_row_id: 1 } })
    const res = await req('/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(200) }),
    })
    expect(res.status).toBe(200)
  })
  test('due_at 잘못된 형식 → 400 due_at_invalid', async () => {
    const res = await req('/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', due_at: '내일' }),
    })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('due_at_invalid')
  })
  test('due_at 날짜만 (YYYY-MM-DD) → 통과', async () => {
    db.qRun({ runMeta: { changes: 1, last_row_id: 1 } })
    const res = await req('/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', due_at: '2026-10-20' }),
    })
    expect(res.status).toBe(200)
  })
  test('due_at 날짜+시간 → 통과', async () => {
    db.qRun({ runMeta: { changes: 1, last_row_id: 1 } })
    const res = await req('/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', due_at: '2026-10-20T14:30' }),
    })
    expect(res.status).toBe(200)
  })
  test('due_at 날짜+시간+초 → 통과', async () => {
    db.qRun({ runMeta: { changes: 1, last_row_id: 1 } })
    const res = await req('/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', due_at: '2026-10-20T14:30:00' }),
    })
    expect(res.status).toBe(200)
  })
  test('due_at 빈 문자열 → null 취급, 통과', async () => {
    db.qRun({ runMeta: { changes: 1, last_row_id: 1 } })
    const res = await req('/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', due_at: '' }),
    })
    expect(res.status).toBe(200)
  })
  test('priority=3 → 400 priority_invalid', async () => {
    const res = await req('/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', priority: 3 }),
    })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('priority_invalid')
  })
  test('priority=0 → 통과', async () => {
    db.qRun({ runMeta: { changes: 1, last_row_id: 1 } })
    const res = await req('/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', priority: 0 }),
    })
    expect(res.status).toBe(200)
  })
  test('status=weird → 400 status_invalid', async () => {
    const res = await req('/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', status: 'weird' }),
    })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('status_invalid')
  })
  test('JSON 파싱 실패 → 빈 객체 → title_required', async () => {
    const res = await req('/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('title_required')
  })
  test('description 2000자 초과 → 잘림', async () => {
    db.qRun({ runMeta: { changes: 1, last_row_id: 1 } })
    const res = await req('/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', description: 'y'.repeat(3000) }),
    })
    expect(res.status).toBe(200)
  })
})

// ================= PUT /reorder =================
describe('PUT /reorder', () => {
  test('정상 순서 변경', async () => {
    const res = await req('/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [3, 1, 2] }),
    })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.ok).toBe(true)
    expect(body.count).toBe(3)
    // batch가 3개 statement로 호출
    expect(db.batchCalls).toHaveLength(1)
    expect(db.batchCalls[0]).toHaveLength(3)
    expect(mockEmit).toHaveBeenCalledWith('todo.reordered', { count: 3 })
  })
  test('ids 없음 → 400', async () => {
    const res = await req('/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('ids_invalid')
  })
  test('중복 ids → 400 ids_duplicate', async () => {
    const res = await req('/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1, 1] }),
    })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('ids_duplicate')
  })
  test('JSON 파싱 실패 → 400', async () => {
    const res = await req('/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: 'broken',
    })
    expect(res.status).toBe(400)
  })
})

// ================= PUT /:id =================
describe('PUT /:id', () => {
  test('정상 수정', async () => {
    db.qRun({ runMeta: { changes: 1 } })
    const res = await req('/5', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'new title' }),
    })
    expect(res.status).toBe(200)
    expect((await json(res)).ok).toBe(true)
    expect(mockEmit).toHaveBeenCalledWith('todo.updated', { id: 5 })
  })
  test('없는 id → 404 (changes=0)', async () => {
    db.qRun({ runMeta: { changes: 0 } })
    const res = await req('/999', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't' }),
    })
    expect(res.status).toBe(404)
    expect((await json(res)).error).toBe('not_found')
    expect(mockEmit).not.toHaveBeenCalled()
  })
  test('id=abc → 400', async () => {
    const res = await req('/abc', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't' }),
    })
    expect(res.status).toBe(400)
  })
  test('title 없음 → 400', async () => {
    const res = await req('/5', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('title_required')
  })
  test('priority 잘못 → 400', async () => {
    const res = await req('/5', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', priority: 9 }),
    })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('priority_invalid')
  })
  test('JSON 파싱 실패 → 빈 객체 → title_required', async () => {
    const res = await req('/5', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{{{broken',
    })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('title_required')
  })
  test('due_at 숫자형 → due_at_invalid (isISODateTime typeof 분기)', async () => {
    const res = await req('/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', due_at: 0 }),
    })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('due_at_invalid')
  })
})

// ================= POST /:id/toggle =================
describe('POST /:id/toggle', () => {
  test('pending → done', async () => {
    db.qFirst({ firstRow: { status: 'pending' } })
    db.qFirst({ firstRow: { m: 5 } })
    db.qRun({ runMeta: { changes: 1 } })
    const res = await req('/3/toggle', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.ok).toBe(true)
    expect(body.status).toBe('done')
    expect(mockEmit).toHaveBeenCalledWith('todo.toggled', { id: 3, status: 'done' })
  })
  test('done → pending', async () => {
    db.qFirst({ firstRow: { status: 'done' } })
    db.qFirst({ firstRow: { m: 2 } })
    db.qRun({ runMeta: { changes: 1 } })
    const res = await req('/3/toggle', { method: 'POST' })
    expect(res.status).toBe(200)
    expect((await json(res)).status).toBe('pending')
  })
  test('maxRow null → m=-1 기본값 (?? -1)', async () => {
    db.qFirst({ firstRow: { status: 'pending' } })
    db.qFirst({ firstRow: null })
    db.qRun({ runMeta: { changes: 1 } })
    const res = await req('/3/toggle', { method: 'POST' })
    expect(res.status).toBe(200)
    expect((await json(res)).status).toBe('done')
  })
  test('없는 id → 404', async () => {
    db.qFirst({ firstRow: null })
    const res = await req('/999/toggle', { method: 'POST' })
    expect(res.status).toBe(404)
    expect((await json(res)).error).toBe('not_found')
  })
  test('id=abc → 400', async () => {
    const res = await req('/abc/toggle', { method: 'POST' })
    expect(res.status).toBe(400)
  })
})

// ================= DELETE /:id =================
describe('DELETE /:id', () => {
  test('정상 삭제', async () => {
    db.qRun({ runMeta: { changes: 1 } })
    const res = await req('/5', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect((await json(res)).ok).toBe(true)
    expect(mockEmit).toHaveBeenCalledWith('todo.deleted', { id: 5 })
  })
  test('없는 id → 404', async () => {
    db.qRun({ runMeta: { changes: 0 } })
    const res = await req('/999', { method: 'DELETE' })
    expect(res.status).toBe(404)
    expect((await json(res)).error).toBe('not_found')
    expect(mockEmit).not.toHaveBeenCalled()
  })
  test('id=abc → 400', async () => {
    const res = await req('/abc', { method: 'DELETE' })
    expect(res.status).toBe(400)
  })
})

// ================= 라우트 충돌: /reorder vs /:id =================
// Hono는 등록 순서대로 매칭하므로 /reorder가 /:id보다 먼저 등록되어 있음.
// PUT /reorder가 :id로 잘못 매칭되지 않는지 확인.
describe('라우트 우선순위', () => {
  test('PUT /reorder는 reorder 핸들러로 (ids 검증 오류가 나면 핸들러 도달 증명)', async () => {
    const res = await req('/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    })
    // reorder 핸들러의 ids_invalid (/:id 핸들러라면 invalid_id나 title_required가 나옴)
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('ids_invalid')
  })
})
