import { Hono } from 'hono'
import type { Env } from '../../types'
import { emit } from '../../events'

// 할일(Todo) 모듈: 간단한 체크리스트 CRUD
// 인증은 전역 미들웨어(verifySession)에서 처리됨

export const todoApp = new Hono<{ Bindings: Env }>()

interface TodoRow {
  id: number
  title: string
  description: string
  due_at: string | null
  priority: number
  status: string
  sort_order: number
  created_at: string
  updated_at: string
}

interface TodoInput {
  title?: string
  description?: string
  due_at?: string | null
  priority?: number
  status?: string
}

function isISODateTime(s: unknown): s is string {
  if (typeof s !== 'string' || !s) return false
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(s)
}

function normalizeInput(json: TodoInput): { ok: true; data: { title: string; description: string; due_at: string | null; priority: number; status: string } } | { ok: false; error: string } {
  const title = (json.title ?? '').trim()
  if (!title) return { ok: false, error: 'title_required' }
  if (title.length > 200) return { ok: false, error: 'title_too_long' }
  if (json.due_at != null && json.due_at !== '' && !isISODateTime(json.due_at)) {
    return { ok: false, error: 'due_at_invalid' }
  }
  const priority = json.priority ?? 1
  if (![0, 1, 2].includes(priority)) return { ok: false, error: 'priority_invalid' }
  const status = json.status ?? 'pending'
  if (!['pending', 'done'].includes(status)) return { ok: false, error: 'status_invalid' }
  return {
    ok: true,
    data: {
      title,
      description: (json.description ?? '').trim().slice(0, 2000),
      due_at: json.due_at || null,
      priority,
      status,
    },
  }
}

// reorder 입력 검증 (테스트 가능하도록 export)
export function validateReorderIds(input: unknown): { ok: true; ids: number[] } | { ok: false; error: string } {
  if (!Array.isArray(input) || input.length === 0 || input.length > 500) {
    return { ok: false, error: 'ids_invalid' }
  }
  const ids: number[] = []
  for (const v of input) {
    const n = Number(v)
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: 'ids_invalid' }
    ids.push(n)
  }
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'ids_duplicate' }
  return { ok: true, ids }
}

// 할일 목록 (status 필터: pending / done / all)
// 수동 정렬(sort_order) 우선, 동점 시 최신(id DESC)
// GET /api/todo/list?status=pending
// MCP 도구(todo.list)가 같은 조회 로직을 재사용한다.
export interface ListTodosOptions {
  status?: string
  limit?: number
}

export async function listTodos(
  db: D1Database,
  opts: ListTodosOptions
): Promise<TodoRow[]> {
  const status = opts.status || 'pending'
  const limit = Math.min(Math.max(opts.limit || 200, 1), 500)

  const conds: string[] = []
  const params: unknown[] = []
  if (['pending', 'done'].includes(status)) {
    conds.push('status = ?')
    params.push(status)
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''

  const { results } = await db.prepare(
    `SELECT id, title, description, due_at, priority, status, sort_order, created_at, updated_at
     FROM todos ${where} ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, sort_order ASC, id DESC LIMIT ?`
  )
    .bind(...params, limit)
    .all<TodoRow>()
  return results
}

todoApp.get('/list', async (c) => {
  const status = c.req.query('status')?.trim() || 'pending'
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 200, 1), 500)
  const todos = await listTodos(c.env.DB, { status, limit })
  return c.json({ ok: true, todos })
})

// 할일 단건 조회
todoApp.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'invalid_id' }, 400)
  const row = await c.env.DB.prepare(
    'SELECT id, title, description, due_at, priority, status, sort_order, created_at, updated_at FROM todos WHERE id = ?'
  )
    .bind(id)
    .first<TodoRow>()
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json({ ok: true, todo: row })
})

// 할일 생성 — 새 항목은 해당 상태 목록의 맨 위에 배치 (sort_order = MIN - 1)
todoApp.post('/create', async (c) => {
  const json = await c.req.json<TodoInput>().catch((): TodoInput => ({}))
  const v = normalizeInput(json)
  if (!v.ok) return c.json({ error: v.error }, 400)
  const d = v.data
  const r = await c.env.DB.prepare(
    `INSERT INTO todos (title, description, due_at, priority, status, sort_order)
     VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MIN(sort_order), 1) - 1 FROM todos WHERE status = ?))`
  )
    .bind(d.title, d.description, d.due_at, d.priority, d.status, d.status)
    .run()
  const newId = Number(r.meta.last_row_id)
  await emit('todo.created', { id: newId })
  return c.json({ ok: true, id: newId })
})

// 순서 변경 (드래그 정렬) — body: { ids: [3, 1, 2] } 순서대로 sort_order = 0, 1, 2 ...
// PUT /api/todo/reorder
todoApp.put('/reorder', async (c) => {
  const json = await c.req.json<{ ids?: unknown }>().catch((): { ids?: unknown } => ({}))
  const v = validateReorderIds(json.ids)
  if (!v.ok) return c.json({ error: v.error }, 400)
  const stmts = v.ids.map((id, i) =>
    c.env.DB.prepare('UPDATE todos SET sort_order = ?, updated_at = datetime(\'now\') WHERE id = ?').bind(i, id)
  )
  await c.env.DB.batch(stmts)
  await emit('todo.reordered', { count: v.ids.length })
  return c.json({ ok: true, count: v.ids.length })
})

// 할일 수정 (제목/설명/마감일/우선순위/상태)
todoApp.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'invalid_id' }, 400)
  const json = await c.req.json<TodoInput>().catch((): TodoInput => ({}))
  const v = normalizeInput(json)
  if (!v.ok) return c.json({ error: v.error }, 400)
  const d = v.data
  const r = await c.env.DB.prepare(
    `UPDATE todos SET title = ?, description = ?, due_at = ?, priority = ?,
     status = ?, updated_at = datetime('now') WHERE id = ?`
  )
    .bind(d.title, d.description, d.due_at, d.priority, d.status, id)
    .run()
  if (r.meta.changes === 0) return c.json({ error: 'not_found' }, 404)
  await emit('todo.updated', { id })
  return c.json({ ok: true })
})

// 완료 토글 (빠른 체크용) — 상태가 바뀌면 새 상태 목록의 맨 뒤에 배치
todoApp.post('/:id/toggle', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'invalid_id' }, 400)
  const row = await c.env.DB.prepare('SELECT status FROM todos WHERE id = ?')
    .bind(id)
    .first<{ status: string }>()
  if (!row) return c.json({ error: 'not_found' }, 404)
  const newStatus = row.status === 'done' ? 'pending' : 'done'
  const maxRow = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM todos WHERE status = ?')
    .bind(newStatus)
    .first<{ m: number }>()
  await c.env.DB.prepare(
    `UPDATE todos SET status = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?`
  )
    .bind(newStatus, (maxRow?.m ?? -1) + 1, id)
    .run()
  await emit('todo.toggled', { id, status: newStatus })
  return c.json({ ok: true, status: newStatus })
})

// 할일 삭제
todoApp.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'invalid_id' }, 400)
  const r = await c.env.DB.prepare('DELETE FROM todos WHERE id = ?').bind(id).run()
  if (r.meta.changes === 0) return c.json({ error: 'not_found' }, 404)
  await emit('todo.deleted', { id })
  return c.json({ ok: true })
})
