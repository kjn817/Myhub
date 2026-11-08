/// <reference types="jest" />
/**
 * src/services/schedule-google-sync.ts — 쓰기-스루 전 경로 성질 테스트 (C3).
 *
 * 실제 SQLite(local-d1 + 0014·0054·0068·0071 실마이그레이션)와 주입된
 * fake fetch(Google Calendar 경계)로 고정하는 성질:
 * - 생성/갱신/복구(마커 조회·409 결정적 id) 경로가 DB의 google_event_id와
 *   google_sync_status를 실제 결과대로 전이시키고, 실패는 failed + 사유로
 *   남는다 (조용한 실패 금지 — 기존 파일이 게이트 닫힘만 다룬 것의 확장).
 * - 시각 정규화: 날짜만/분까지의 입력은 +09:00 RFC3339로, 반복 규칙은
 *   RRULE: 접두로 캘린더 본문에 실린다.
 * - 프라이버시: L3 비밀(예: API 키)이 든 제목은 토큰화된 형태로만
 *   Google로 나가고 privacyRedacted로 보고된다.
 * - 백필: pending/failed/delete_pending 행을 종류별로 처리해 건수를
 *   정직하게 세고, 스키마가 옛 형태면 폴백 쿼리로도 동작한다.
 * 실 Google API는 호출하지 않는다. 카나리아: 상태 전이나 409 복구를
 * 깨면 해당 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  pushScheduleDetailed,
  removeScheduleDetailed,
  backfillUnsyncedSchedules,
  getScheduleSyncCounts,
  type ScheduleSyncRow,
} from '../../src/services/schedule-google-sync'
import { saveGoogleTokens } from '../../src/services/google-tokens'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createLocalD1 } = require('../helpers/local-d1.cjs')

const ROOT = path.join(__dirname, '..', '..')
const mig = (n: string) => fs.readFileSync(path.join(ROOT, 'migrations', n), 'utf8')
const KEY = 'test-c3-encryption-key'
const WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events'

function makeDb(withStatus = true) {
  const db = createLocalD1()
  db.exec(mig('0014_schedules.sql'))
  db.exec(mig('0054_google_integrations.sql'))
  db.exec(mig('0068_schedule_google_event.sql'))
  if (withStatus) db.exec(mig('0071_schedule_google_sync_status.sql'))
  return db
}

interface CalReply { status: number; body?: unknown }
interface Behavior {
  patch?: (eventId: string, body: any) => CalReply
  del?: (eventId: string) => CalReply
  list?: () => CalReply
  getOne?: (eventId: string) => CalReply
  post?: (body: any) => CalReply
  token?: () => CalReply
}
let behavior: Behavior = {}
let calls: Array<{ method: string; url: string; body?: any; auth?: string }> = []

function calFetch(): typeof fetch {
  calls = []
  return (async (url: unknown, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body && init.body.startsWith('{') ? JSON.parse(init.body) : undefined
    calls.push({ method, url: u, body, auth: init?.headers?.Authorization })
    const reply = (r: CalReply) => new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status })
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      return reply(behavior.token?.() ?? { status: 200, body: { access_token: 'at-refreshed', expires_in: 3600 } })
    }
    const eventsBase = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
    if (u === eventsBase && method === 'POST') {
      return reply(behavior.post?.(body) ?? { status: 200, body: { id: body?.id ?? 'srv-generated' } })
    }
    if (u.startsWith(eventsBase + '?') && method === 'GET') {
      return reply(behavior.list?.() ?? { status: 200, body: { items: [] } })
    }
    if (u.startsWith(eventsBase + '/')) {
      const eventId = decodeURIComponent(u.slice(eventsBase.length + 1))
      if (method === 'PATCH') return reply(behavior.patch?.(eventId, body) ?? { status: 200, body: { id: eventId } })
      if (method === 'DELETE') return reply(behavior.del?.(eventId) ?? { status: 204 })
      if (method === 'GET') return reply(behavior.getOne?.(eventId) ?? { status: 404, body: { error: { message: 'not found' } } })
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
}

beforeEach(() => { behavior = {} })

async function makeEnv(db: any, opts: { scope?: string; expiresIn?: number; write?: string } = {}) {
  const env: any = {
    DB: db,
    MEMO_ENCRYPTION_KEY: KEY,
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'csec',
    GOOGLE_WRITE_ENABLED: opts.write ?? 'true',
  }
  await saveGoogleTokens(env, {
    email: 'u@example.com',
    accessToken: 'at-valid',
    refreshToken: 'rt-1',
    scope: opts.scope ?? WRITE_SCOPE,
    expiresIn: opts.expiresIn ?? 3600,
  })
  return env
}

async function seedSchedule(db: any, fields: Partial<ScheduleSyncRow> & { start_at: string }): Promise<number> {
  const r = await db.prepare(
    'INSERT INTO schedules (title, description, location, start_at, end_at, recurrence_rule, google_event_id, google_sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    fields.title ?? '일정', fields.description ?? null, fields.location ?? null,
    fields.start_at, fields.end_at ?? null, fields.recurrence_rule ?? null,
    fields.google_event_id ?? null, fields.google_sync_status ?? 'pending',
  ).run()
  return Number(r.meta.last_row_id)
}

function rowOf(id: number, fields: Partial<ScheduleSyncRow> = {}): ScheduleSyncRow {
  return { id, title: '일정', start_at: '2026-11-09T10:00:00+09:00', end_at: null, google_event_id: null, ...fields }
}

async function schedRow(db: any, id: number) {
  return db.prepare('SELECT * FROM schedules WHERE id = ?').bind(id).first()
}
async function syncLogs(db: any) {
  const { results } = await db.prepare('SELECT status, detail FROM google_sync_log ORDER BY id').all()
  return results as Array<{ status: string; detail: string }>
}

describe('pushScheduleDetailed — 생성 경로', () => {
  test('신규: 마커 조회가 비면 결정적 id로 생성하고 DB에 링크·synced가 남는다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    const id = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00' })
    const r = await pushScheduleDetailed(calFetch(), env, rowOf(id))
    expect(r).toEqual({ state: 'created' })
    const row = await schedRow(db, id)
    expect(row.google_event_id).toBe(`mh${String(id).padStart(5, '0')}`)
    expect(row.google_sync_status).toBe('synced')
    expect(row.google_sync_last_error).toBeNull()
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.body.extendedProperties.private.myhub_schedule_id).toBe(String(id))
    expect(post.auth).toBe('Bearer at-valid')
    const logs = await syncLogs(db)
    expect(logs.at(-1)).toMatchObject({ status: 'ok' })
    expect(logs.at(-1)!.detail).toContain('op=create')
  })

  test('시각 정규화와 반복 규칙이 생성 본문에 정확히 실린다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    const fetchFn = calFetch()
    const id1 = await seedSchedule(db, { start_at: '2026-11-10' })
    await pushScheduleDetailed(fetchFn, env, rowOf(id1, { start_at: '2026-11-10', end_at: null }))
    let post = calls.filter((c) => c.method === 'POST').at(-1)!
    expect(post.body.start.dateTime).toBe('2026-11-10T00:00:00+09:00')
    expect(post.body.end.dateTime).toBe('2026-11-10T00:00:00+09:00')

    const id2 = await seedSchedule(db, { start_at: '2026-11-11T09:30' })
    await pushScheduleDetailed(fetchFn, env, rowOf(id2, {
      start_at: '2026-11-11T09:30', end_at: '2026-11-11T10:30:00Z', recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
    }))
    post = calls.filter((c) => c.method === 'POST').at(-1)!
    expect(post.body.start.dateTime).toBe('2026-11-11T09:30:00+09:00')
    expect(post.body.end.dateTime).toBe('2026-11-11T10:30:00Z')
    expect(post.body.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO'])
  })

  test('L3 비밀이 든 제목은 토큰화되어 나가고 privacyRedacted로 보고된다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    const secret = 'sk-liveabcdefgh12345678'
    const id = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00', title: `배포 점검 ${secret}` })
    const r = await pushScheduleDetailed(calFetch(), env, rowOf(id, { title: `배포 점검 ${secret}` }))
    expect(r).toEqual({ state: 'created', privacyRedacted: ['title'] })
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.body.summary).not.toContain(secret)
    expect(post.body.summary).toContain('배포 점검')
    const logs = await syncLogs(db)
    expect(logs.at(-1)!.detail).toContain('privacy=l3_redacted:title')
  })

  test('생성 실패(409 아님)는 failed로 남고 DB 상태가 failed가 된다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    behavior.post = () => ({ status: 400, body: { error: { message: 'bad request' } } })
    const id = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00' })
    const r = await pushScheduleDetailed(calFetch(), env, rowOf(id))
    expect(r).toEqual({ state: 'failed', reason: 'api_error' })
    const row = await schedRow(db, id)
    expect(row.google_sync_status).toBe('failed')
    expect(row.google_sync_last_error).toContain('google_api_error:400')
    const logs = await syncLogs(db)
    expect(logs.at(-1)).toMatchObject({ status: 'failed' })
  })

  test('마커 조회 자체가 실패하면 생성으로 진행하지 않고 failed', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    behavior.list = () => ({ status: 500, body: {} })
    const id = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00' })
    const r = await pushScheduleDetailed(calFetch(), env, rowOf(id))
    expect(r).toEqual({ state: 'failed', reason: 'api_error' })
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })
})

describe('pushScheduleDetailed — 갱신과 복구', () => {
  test('기존 이벤트 갱신 성공: updated, 상태 synced', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    const id = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00', google_event_id: 'evt-9', google_sync_status: 'failed' })
    const r = await pushScheduleDetailed(calFetch(), env, rowOf(id, { google_event_id: 'evt-9' }))
    expect(r).toEqual({ state: 'updated' })
    expect(calls.map((c) => c.method)).toEqual(['PATCH'])
    expect((await schedRow(db, id)).google_sync_status).toBe('synced')
  })

  test('갱신이 404면 마커 복구 경로로 새로 생성해 링크를 교체한다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    behavior.patch = () => ({ status: 404, body: { error: { message: 'gone' } } })
    const id = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00', google_event_id: 'evt-gone' })
    const r = await pushScheduleDetailed(calFetch(), env, rowOf(id, { google_event_id: 'evt-gone' }))
    expect(r).toEqual({ state: 'created' })
    const row = await schedRow(db, id)
    expect(row.google_event_id).toBe(`mh${String(id).padStart(5, '0')}`)
  })

  test('갱신이 500이면 복구로 새지 않고 failed', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    behavior.patch = () => ({ status: 500, body: {} })
    const id = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00', google_event_id: 'evt-9' })
    const r = await pushScheduleDetailed(calFetch(), env, rowOf(id, { google_event_id: 'evt-9' }))
    expect(r).toEqual({ state: 'failed', reason: 'api_error' })
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    expect((await schedRow(db, id)).google_sync_status).toBe('failed')
  })

  test('마커로 기존 이벤트를 찾으면 그 이벤트를 갱신하고 링크한다 (op=recover)', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    const id = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00' })
    behavior.list = () => ({
      status: 200,
      body: { items: [
        { id: 'cancelled-one', status: 'cancelled', extendedProperties: { private: { myhub_schedule_id: String(id) } } },
        { id: 'found-1', status: 'confirmed', extendedProperties: { private: { myhub_schedule_id: String(id) } } },
      ] },
    })
    const r = await pushScheduleDetailed(calFetch(), env, rowOf(id))
    expect(r).toEqual({ state: 'created' })
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.url).toContain('/found-1')
    expect((await schedRow(db, id)).google_event_id).toBe('found-1')
    const logs = await syncLogs(db)
    expect(logs.at(-1)!.detail).toContain('op=recover')
  })

  test('409 충돌: 결정적 id의 기존 이벤트가 살아 있으면 갱신해 복구한다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    const id = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00' })
    const detId = `mh${String(id).padStart(5, '0')}`
    behavior.post = () => ({ status: 409, body: { error: { message: 'duplicate' } } })
    behavior.getOne = (eventId) => ({ status: 200, body: { id: eventId, status: 'confirmed' } })
    const r = await pushScheduleDetailed(calFetch(), env, rowOf(id))
    expect(r).toEqual({ state: 'created' })
    expect((await schedRow(db, id)).google_event_id).toBe(detId)
    expect(calls.some((c) => c.method === 'PATCH' && c.url.includes(detId))).toBe(true)
  })

  test('409 충돌: 기존 이벤트가 없으면 비결정적 id로 재시도해 생성한다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    const id = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00' })
    let postCount = 0
    behavior.post = (body) => {
      postCount += 1
      if (postCount === 1) return { status: 409, body: { error: { message: 'duplicate' } } }
      expect(body.id).toBeUndefined()
      return { status: 200, body: { id: 'srv-retry-1' } }
    }
    behavior.getOne = () => ({ status: 404, body: { error: { message: 'none' } } })
    const r = await pushScheduleDetailed(calFetch(), env, rowOf(id))
    expect(r).toEqual({ state: 'created' })
    expect((await schedRow(db, id)).google_event_id).toBe('srv-retry-1')
  })

  test('마커로 찾은 이벤트의 갱신이 500이면 복구 실패로 끝난다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    const id = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00' })
    behavior.list = () => ({
      status: 200,
      body: { items: [{ id: 'found-1', status: 'confirmed', extendedProperties: { private: { myhub_schedule_id: String(id) } } }] },
    })
    behavior.patch = () => ({ status: 500, body: {} })
    const r = await pushScheduleDetailed(calFetch(), env, rowOf(id))
    expect(r).toEqual({ state: 'failed', reason: 'api_error' })
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    expect((await schedRow(db, id)).google_sync_status).toBe('failed')
  })

  test('마커로 찾은 이벤트가 사라졌으면(404) 새로 생성한다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    const id = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00' })
    behavior.list = () => ({
      status: 200,
      body: { items: [{ id: 'ghost', status: 'confirmed', extendedProperties: { private: { myhub_schedule_id: String(id) } } }] },
    })
    behavior.patch = () => ({ status: 404, body: { error: { message: 'gone' } } })
    const r = await pushScheduleDetailed(calFetch(), env, rowOf(id))
    expect(r).toEqual({ state: 'created' })
    expect((await schedRow(db, id)).google_event_id).toBe(`mh${String(id).padStart(5, '0')}`)
  })

  test('409 복구 대상의 갱신이 500이면 재시도 생성으로 새지 않고 failed', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    const id = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00' })
    behavior.post = () => ({ status: 409, body: { error: { message: 'duplicate' } } })
    behavior.getOne = (eventId) => ({ status: 200, body: { id: eventId, status: 'confirmed' } })
    behavior.patch = () => ({ status: 500, body: {} })
    const r = await pushScheduleDetailed(calFetch(), env, rowOf(id))
    expect(r).toEqual({ state: 'failed', reason: 'api_error' })
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })

  test('409 충돌 후 재시도 생성까지 실패하면 failed로 끝난다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    const id = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00' })
    let postCount = 0
    behavior.post = () => {
      postCount += 1
      return postCount === 1
        ? { status: 409, body: { error: { message: 'duplicate' } } }
        : { status: 500, body: {} }
    }
    behavior.getOne = () => ({ status: 404, body: { error: { message: 'none' } } })
    const r = await pushScheduleDetailed(calFetch(), env, rowOf(id))
    expect(r).toEqual({ state: 'failed', reason: 'api_error' })
    expect((await schedRow(db, id)).google_sync_status).toBe('failed')
  })

  test('DB 링크 기록이 끝내 실패하면 exception으로 정직하게 실패한다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    const id = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00' })
    const brokenDb = {
      ...db,
      prepare: (sql: string) => {
        if (sql.includes('SET google_event_id')) throw new Error('db gone')
        return db.prepare(sql)
      },
    }
    const r = await pushScheduleDetailed(calFetch(), { ...env, DB: brokenDb }, rowOf(id))
    expect(r).toEqual({ state: 'failed', reason: 'exception' })
  })
})

describe('쓰기 게이트 — 토큰 상태', () => {
  test('쓰기 스코프가 없으면 scope_missing이고 캘린더를 호출하지 않는다', async () => {
    const db = makeDb()
    const env = await makeEnv(db, { scope: 'https://www.googleapis.com/auth/calendar.readonly' })
    const fetchFn = calFetch()
    const id = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00', google_event_id: 'evt-1' })
    const r = await pushScheduleDetailed(fetchFn, env, rowOf(id, { google_event_id: 'evt-1' }))
    expect(r).toEqual({ state: 'skipped', reason: 'scope_missing' })
    expect(calls).toHaveLength(0)
    // 이미 링크된 일정은 pending으로 되돌려 다음 기회에 재시도하게 한다
    expect((await schedRow(db, id)).google_sync_status).toBe('pending')
  })

  test('만료된 토큰은 refresh로 교환해 새 토큰으로 호출한다', async () => {
    const db = makeDb()
    const env = await makeEnv(db, { expiresIn: -100 })
    const id = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00' })
    const r = await pushScheduleDetailed(calFetch(), env, rowOf(id))
    expect(r).toEqual({ state: 'created' })
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/calendars/'))!
    expect(post.auth).toBe('Bearer at-refreshed')
    expect(calls.some((c) => c.url.startsWith('https://oauth2.googleapis.com/token'))).toBe(true)
  })

  test('refresh가 invalid_grant면 revoked로 전이하고 연동 상태도 revoked가 된다', async () => {
    const db = makeDb()
    const env = await makeEnv(db, { expiresIn: -100 })
    behavior.token = () => ({ status: 400, body: { error: 'invalid_grant' } })
    const id = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00' })
    const r = await pushScheduleDetailed(calFetch(), env, rowOf(id))
    expect(r).toEqual({ state: 'skipped', reason: 'revoked' })
    const integ = await db.prepare('SELECT status FROM google_integrations WHERE provider = ?').bind('google').first()
    expect(integ.status).toBe('revoked')
  })
})

describe('removeScheduleDetailed — 삭제 전이', () => {
  test('삭제 성공과 404는 deleted, 500은 failed + delete_pending', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    const fetchFn = calFetch()
    const id = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00', google_event_id: 'evt-1' })
    await expect(removeScheduleDetailed(fetchFn, env, { id, google_event_id: 'evt-1' })).resolves.toEqual({ state: 'deleted' })
    behavior.del = () => ({ status: 404, body: { error: { message: 'gone' } } })
    await expect(removeScheduleDetailed(fetchFn, env, { id, google_event_id: 'evt-1' })).resolves.toEqual({ state: 'deleted' })
    behavior.del = () => ({ status: 500, body: {} })
    await expect(removeScheduleDetailed(fetchFn, env, { id, google_event_id: 'evt-1' })).resolves.toEqual({ state: 'failed', reason: 'api_error' })
    expect((await schedRow(db, id)).google_sync_status).toBe('delete_pending')
  })
})

describe('backfillUnsyncedSchedules — 일괄 회복', () => {
  test('pending/failed/delete_pending을 종류별로 처리하고 건수를 센다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    const fetchFn = calFetch()
    const p = await seedSchedule(db, { start_at: '2026-11-09T09:00:00+09:00', google_sync_status: 'pending' })
    const f = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00', google_event_id: 'evt-f', google_sync_status: 'failed' })
    const d = await seedSchedule(db, { start_at: '2026-11-09T11:00:00+09:00', google_event_id: 'evt-d', google_sync_status: 'delete_pending' })
    await db.prepare('INSERT INTO reminders (schedule_id, remind_at) VALUES (?, ?)').bind(d, '2026-11-09T10:30:00').run()
    await seedSchedule(db, { start_at: '2026-11-09T12:00:00+09:00', google_event_id: 'evt-ok', google_sync_status: 'synced' })

    const r = await backfillUnsyncedSchedules(fetchFn, env)
    expect(r).toMatchObject({ ran: true, scanned: 3, created: 1, updated: 1, deleted: 1, failed: 0, skipped: 0 })
    expect(await schedRow(db, d)).toBeNull()
    const rem = await db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE schedule_id = ?').bind(d).first()
    expect(rem.n).toBe(0)
    expect((await schedRow(db, p)).google_sync_status).toBe('synced')
    expect((await schedRow(db, f)).google_sync_status).toBe('synced')
    const logs = await syncLogs(db)
    expect(logs.at(-1)!.detail).toContain('op=backfill scanned=3 created=1 updated=1 deleted=1')
  })

  test('delete_pending인데 구글 이벤트가 없는 행은 skipped로 센다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00', google_event_id: null, google_sync_status: 'delete_pending' })
    const r = await backfillUnsyncedSchedules(calFetch(), env)
    expect(r).toMatchObject({ scanned: 1, deleted: 0, skipped: 1, failed: 0 })
  })

  test('limit은 1..100으로 clamp된다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    for (let i = 0; i < 3; i++) await seedSchedule(db, { start_at: `2026-11-09T0${i}:00:00+09:00` })
    const r = await backfillUnsyncedSchedules(calFetch(), env, { limit: 0 })
    expect(r.scanned).toBe(1)
    expect(r.created).toBe(1)
  })

  test('옛 스키마(상태 컬럼 없음)에서는 폴백 쿼리로도 백필이 동작한다', async () => {
    const db = makeDb(false)
    const env = await makeEnv(db)
    const r0 = await db.prepare('INSERT INTO schedules (title, start_at, google_event_id) VALUES (?, ?, ?)').bind('구일정', '2026-11-09T10:00:00+09:00', null).run()
    void r0
    const r = await backfillUnsyncedSchedules(calFetch(), env)
    expect(r.ran).toBe(true)
    expect(r.scanned).toBe(1)
    expect(r.created).toBe(1)
  })

  test('schedules 테이블 자체가 없으면 query_failed로 돌아온다', async () => {
    const db = createLocalD1()
    db.exec(mig('0054_google_integrations.sql'))
    const env = await makeEnv(db)
    const r = await backfillUnsyncedSchedules(calFetch(), env)
    expect(r).toMatchObject({ ran: false, reason: 'query_failed', scanned: 0 })
  })
})

describe('예외 경계 — 토큰 저장소가 깨진 경우', () => {
  function brokenTokenDb(db: any) {
    return {
      ...db,
      prepare: (sql: string) => {
        if (sql.includes('google_integrations')) throw new Error('token store gone')
        return db.prepare(sql)
      },
    }
  }

  test('remove는 게이트 내부 예외를 failed/exception으로 변환한다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    const id = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00', google_event_id: 'evt-1' })
    const r = await removeScheduleDetailed(calFetch(), { ...env, DB: brokenTokenDb(db) }, { id, google_event_id: 'evt-1' })
    expect(r).toEqual({ state: 'failed', reason: 'exception' })
  })

  test('backfill은 게이트 예외를 refresh_failed 사유로 보고한다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    const r = await backfillUnsyncedSchedules(calFetch(), { ...env, DB: brokenTokenDb(db) })
    expect(r).toMatchObject({ ran: false, reason: 'refresh_failed' })
  })

  test('delete_pending 행의 로컬 삭제가 실패하면 deleted가 아니라 failed로 센다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    const id = await seedSchedule(db, { start_at: '2026-11-09T10:00:00+09:00', google_event_id: 'evt-d', google_sync_status: 'delete_pending' })
    const wrapped = {
      ...db,
      prepare: (sql: string) => {
        if (sql.startsWith('DELETE FROM schedules')) throw new Error('locked')
        return db.prepare(sql)
      },
    }
    const r = await backfillUnsyncedSchedules(calFetch(), { ...env, DB: wrapped })
    expect(r).toMatchObject({ scanned: 1, deleted: 0, failed: 1 })
    expect(await schedRow(db, id)).not.toBeNull()
  })
})

describe('getScheduleSyncCounts', () => {
  test('상태별 건수와 미동기화 합계를 정확히 센다', async () => {
    const db = makeDb()
    await seedSchedule(db, { start_at: '2026-11-09T01:00:00+09:00', google_sync_status: 'pending' })
    await seedSchedule(db, { start_at: '2026-11-09T02:00:00+09:00', google_sync_status: 'pending' })
    await seedSchedule(db, { start_at: '2026-11-09T03:00:00+09:00', google_sync_status: 'failed' })
    await seedSchedule(db, { start_at: '2026-11-09T04:00:00+09:00', google_sync_status: 'delete_pending' })
    await seedSchedule(db, { start_at: '2026-11-09T05:00:00+09:00', google_sync_status: 'synced' })
    const counts = await getScheduleSyncCounts({ DB: db } as never)
    expect(counts).toEqual({ pending: 2, failed: 1, deletePending: 1, unsynced: 4 })
  })

  test('조회가 실패하면 null이다', async () => {
    const db = createLocalD1()
    const counts = await getScheduleSyncCounts({ DB: db } as never)
    expect(counts).toBeNull()
  })
})
