import { Hono } from 'hono'
import type { Env } from '../../types'
import { emit } from '../../events'
import { expandRecurrence, singleOccurrence, validateRRule, type ExpandedSchedule } from '../../services/recurrence'
import { nextDayKey } from '../../lib/kst-date'
import { KST_TIME_ZONE } from '../../lib/kst'
import { normalizeScheduleDateTime } from '../../lib/datetime-format'
import { pushScheduleDetailed, removeScheduleDetailed } from '../../services/schedule-google-sync'

/** 구글 동기화 상태를 클라이언트 표기용으로 축약한다 (skipped → off). */
export function googleStateForClient(state: string): 'synced' | 'failed' | 'off' {
  if (state === 'failed') return 'failed'
  if (state === 'skipped') return 'off'
  return 'synced'
}

export function googlePayloadForClient(r: { state: string; reason?: string }): { state: string; reason?: string } {
  const state = googleStateForClient(r.state)
  return r.reason ? { state, reason: r.reason } : { state }
}

// 반복 일정 원본 조회 상한 (§6 #7): 전개 전 원본 행 수 자체를 제한한다.
// 최종 반환은 아래 limit(≤500)으로 자르지만, 원본 조회가 무제한이면
// 반복 일정이 늘수록 D1 반환량이 무제한 증가한다.
const RECURRING_FETCH_LIMIT = 1000

// 스케줄(일정) 모듈: 일정 CRUD + 리마인더
// 인증은 전역 미들웨어(verifySession)에서 처리됨

export const scheduleApp = new Hono<{ Bindings: Env }>()

interface ScheduleRow {
  id: number
  title: string
  description: string
  location: string
  start_at: string
  end_at: string | null
  timezone: string
  recurrence_rule: string | null
  status: string
  created_at: string
  updated_at: string
}

interface ScheduleInput {
  title?: string
  description?: string
  location?: string
  start_at?: string
  end_at?: string | null
  timezone?: string
  recurrence_rule?: string | null
  status?: string
}

function isISODateTime(s: unknown): s is string {
  if (typeof s !== 'string' || !s) return false
  // YYYY-MM-DDTHH:mm 또는 YYYY-MM-DDTHH:mm:ss (날짜만도 허용, 오프셋 접미사 허용)
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)
}

function normalizeInput(json: ScheduleInput): { ok: true; data: Required<Omit<ScheduleInput, 'end_at' | 'recurrence_rule'>> & { end_at: string | null; recurrence_rule: string | null } } | { ok: false; error: string } {
  const title = (json.title ?? '').trim()
  if (!title) return { ok: false, error: 'title_required' }
  if (title.length > 200) return { ok: false, error: 'title_too_long' }
  if (!isISODateTime(json.start_at)) return { ok: false, error: 'start_at_invalid' }
  if (json.end_at != null && json.end_at !== '' && !isISODateTime(json.end_at)) {
    return { ok: false, error: 'end_at_invalid' }
  }
  if (json.end_at && json.start_at && json.end_at < json.start_at) {
    return { ok: false, error: 'end_before_start' }
  }
  const status = json.status ?? 'active'
  if (!['active', 'cancelled', 'done'].includes(status)) return { ok: false, error: 'status_invalid' }
  // 무효한 RRULE(특히 존재하지 않는 UNTIL 날짜)은 저장 전에 거부한다.
  // 저장만 되고 expandRecurrence 문자열 비교상 영원히 도달하지 않아
  // 조용히 무시되는 결함을 막는다.
  const recurrenceError = validateRRule(json.recurrence_rule)
  if (recurrenceError) return { ok: false, error: recurrenceError }
  return {
    ok: true,
    data: {
      title,
      description: (json.description ?? '').trim().slice(0, 2000),
      location: (json.location ?? '').trim().slice(0, 200),
      // M-11: 쓰기 경로에서 오프셋 명시 ISO로 정규화해 저장한다
      // (정본 로직은 lib/datetime-format.ts — 기존 행은 migrations/0075)
      start_at: normalizeScheduleDateTime(json.start_at) as string,
      end_at: json.end_at ? (normalizeScheduleDateTime(json.end_at) as string) : null,
      timezone: (json.timezone ?? KST_TIME_ZONE).slice(0, 50),
      recurrence_rule: json.recurrence_rule ? String(json.recurrence_rule).slice(0, 200) : null,
      status,
    },
  }
}

// 일정 목록 (날짜 범위 필터: from/to = YYYY-MM-DD)
// GET /api/schedule/list?from=2026-10-01&to=2026-10-31&status=active
// 반복 일정(recurrence_rule)은 조회 기간 내 발생 건으로展開되어 반환됨.
// 각 항목은 is_recurring / original_id / occurrence_date 필드를 포함.
// MCP 도구(schedule.list)가 같은 조회 로직을 재사용한다.
export interface ListSchedulesOptions {
  from?: string
  to?: string
  status?: string
  limit?: number
}

export async function listSchedules(
  db: D1Database,
  opts: ListSchedulesOptions
): Promise<ExpandedSchedule[]> {
  const from = opts.from || ''
  const to = opts.to || ''
  const status = opts.status || ''
  const limit = Math.min(Math.max(opts.limit || 100, 1), 500)
  const dateRe = /^\d{4}-\d{2}-\d{2}$/
  const hasStatus = ['active', 'cancelled', 'done'].includes(status)

  const COLS = `id, title, description, location, start_at, end_at, timezone, recurrence_rule, status, created_at, updated_at`

  // 1) 단건 일정: 기존 날짜 필터 그대로 적용
  // P-3: substr(start_at, 1, 10) 조건은 idx_schedules_start를 무력화한다.
  // start_at은 'YYYY-MM-DDTHH:mm' 문자열이라 문자열 범위 비교로 대체한다.
  // - from: 날짜 >= from ⟺ start_at >= 'fromT00:00'
  // - to: 날짜 <= to ⟺ start_at < 'to+1일T00:00' (to 당일 23:59까지 포함)
  const conds: string[] = [`(recurrence_rule IS NULL OR recurrence_rule = '')`]
  const params: unknown[] = []
  if (dateRe.test(from)) {
    conds.push('start_at >= ?')
    params.push(`${from}T00:00`)
  }
  if (dateRe.test(to)) {
    conds.push('start_at < ?')
    params.push(`${nextDayKey(to)}T00:00`)
  }
  if (hasStatus) {
    conds.push('status = ?')
    params.push(status)
  }
  const { results: singles } = await db.prepare(
    `SELECT ${COLS} FROM schedules WHERE ${conds.join(' AND ')} ORDER BY start_at ASC LIMIT ?`
  )
    .bind(...params, limit)
    .all<ScheduleRow>()

  // 2) 반복 일정: 시작일이 범위 끝 이전인 것을 가져와 기간 내 발생으로展開
  //    (start_at이 from보다 이전이어도 발생 건이 범위에 들어갈 수 있음)
  const todayKey = new Date().toISOString().slice(0, 10)
  const effFrom = dateRe.test(from) ? from : todayKey
  let effTo: string
  if (dateRe.test(to)) {
    effTo = to
  } else {
    const d = new Date(effFrom + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + 90)
    effTo = d.toISOString().slice(0, 10)
  }
  const rConds = [`recurrence_rule IS NOT NULL`, `recurrence_rule != ''`, `start_at < ?`]
  const rParams: unknown[] = [`${nextDayKey(effTo)}T00:00`]
  if (hasStatus) {
    rConds.push('status = ?')
    rParams.push(status)
  }
  const { results: recurring } = await db.prepare(
    `SELECT ${COLS} FROM schedules WHERE ${rConds.join(' AND ')} ORDER BY start_at ASC LIMIT ?`
  )
    .bind(...rParams, RECURRING_FETCH_LIMIT)
    .all<ScheduleRow>()

  const expanded: ExpandedSchedule[] = [
    ...singles.map((r) => singleOccurrence(r)),
    ...recurring.flatMap((r) => expandRecurrence(r, effFrom, effTo)),
  ]
  expanded.sort((a, b) => (a.start_at < b.start_at ? -1 : a.start_at > b.start_at ? 1 : 0))
  return expanded.slice(0, limit)
}

scheduleApp.get('/list', async (c) => {
  const from = c.req.query('from')?.trim() || ''
  const to = c.req.query('to')?.trim() || ''
  const status = c.req.query('status')?.trim() || ''
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 500)
  const schedules = await listSchedules(c.env.DB, { from, to, status, limit })
  return c.json({ ok: true, schedules })
})

// 일정 단건 조회
scheduleApp.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'invalid_id' }, 400)
  const row = await c.env.DB.prepare(
    'SELECT id, title, description, location, start_at, end_at, timezone, recurrence_rule, status, created_at, updated_at FROM schedules WHERE id = ?'
  )
    .bind(id)
    .first<ScheduleRow>()
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json({ ok: true, schedule: row })
})

// 일정 생성
scheduleApp.post('/create', async (c) => {
  const json = await c.req.json<ScheduleInput>().catch((): ScheduleInput => ({}))
  const v = normalizeInput(json)
  if (!v.ok) return c.json({ error: v.error }, 400)
  const d = v.data
  const r = await c.env.DB.prepare(
    `INSERT INTO schedules (title, description, location, start_at, end_at, timezone, recurrence_rule, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(d.title, d.description, d.location, d.start_at, d.end_at, d.timezone, d.recurrence_rule, d.status)
    .run()
  const newId = Number(r.meta.last_row_id)
  await emit('schedule.created', { id: newId })
  // 구글 쓰기-스루: 저장 직후 구글에도 등록하고 상태를 응답에 실어 보낸다
  const pushed = await pushScheduleDetailed(fetch, c.env, {
    id: newId,
    title: d.title,
    description: d.description,
    location: d.location,
    start_at: d.start_at,
    end_at: d.end_at,
    recurrence_rule: d.recurrence_rule,
    google_event_id: null,
  })
  return c.json({ ok: true, id: newId, google: googlePayloadForClient(pushed) })
})

// 일정 수정
scheduleApp.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'invalid_id' }, 400)
  const json = await c.req.json<ScheduleInput>().catch((): ScheduleInput => ({}))
  const v = normalizeInput(json)
  if (!v.ok) return c.json({ error: v.error }, 400)
  const d = v.data
  const prev = await c.env.DB.prepare('SELECT google_event_id FROM schedules WHERE id = ?').bind(id).first<{ google_event_id: string | null }>()
  const r = await c.env.DB.prepare(
    `UPDATE schedules SET title = ?, description = ?, location = ?, start_at = ?, end_at = ?,
     timezone = ?, recurrence_rule = ?, status = ?, updated_at = datetime('now') WHERE id = ?`
  )
    .bind(d.title, d.description, d.location, d.start_at, d.end_at, d.timezone, d.recurrence_rule, d.status, id)
    .run()
  if (r.meta.changes === 0) return c.json({ error: 'not_found' }, 404)
  await emit('schedule.updated', { id })
  const pushed = await pushScheduleDetailed(fetch, c.env, {
    id,
    title: d.title,
    description: d.description,
    location: d.location,
    start_at: d.start_at,
    end_at: d.end_at,
    recurrence_rule: d.recurrence_rule,
    google_event_id: prev?.google_event_id ?? null,
  })
  return c.json({ ok: true, google: googlePayloadForClient(pushed) })
})

// 일정 삭제 (리마인더도 함께 삭제)
// 구글에 등록된 일정은 구글 삭제가 먼저 성공해야 로컬을 지운다 —
// 실패하면 로컬을 유지하고 deletePending으로 알린다.
scheduleApp.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'invalid_id' }, 400)
  const prev = await c.env.DB.prepare('SELECT google_event_id FROM schedules WHERE id = ?').bind(id).first<{ google_event_id: string | null }>()
  if (!prev) return c.json({ error: 'not_found' }, 404)
  const googleEventId = prev.google_event_id ?? null
  if (googleEventId) {
    const removed = await removeScheduleDetailed(fetch, c.env, { id, google_event_id: googleEventId })
    if (removed.state !== 'deleted') {
      return c.json({
        ok: true,
        localDeleted: false,
        google: { ...googlePayloadForClient(removed), deletePending: true },
      })
    }
  }
  await c.env.DB.prepare('DELETE FROM reminders WHERE schedule_id = ?').bind(id).run()
  const r = await c.env.DB.prepare('DELETE FROM schedules WHERE id = ?').bind(id).run()
  if (r.meta.changes === 0) return c.json({ error: 'not_found' }, 404)
  await emit('schedule.deleted', { id })
  return c.json({
    ok: true,
    localDeleted: true,
    google: { state: googleEventId ? 'synced' : 'off' },
  })
})

// 리마인더 등록 (일정별)
// POST /api/schedule/:id/reminders { remind_at, dedupe_key? }
scheduleApp.post('/:id/reminders', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'invalid_id' }, 400)
  const json = await c.req.json<{ remind_at?: string; dedupe_key?: string }>().catch(() => ({} as { remind_at?: string; dedupe_key?: string }))
  if (!isISODateTime(json.remind_at)) return c.json({ error: 'remind_at_invalid' }, 400)
  const dedupe = (json.dedupe_key ?? `sched:${id}:${json.remind_at}`).slice(0, 200)
  try {
    const r = await c.env.DB.prepare(
      'INSERT INTO reminders (schedule_id, remind_at, dedupe_key) VALUES (?, ?, ?)'
    )
      .bind(id, json.remind_at, dedupe)
      .run()
    return c.json({ ok: true, id: Number(r.meta.last_row_id) })
  } catch {
    return c.json({ error: 'duplicate' }, 409)
  }
})
