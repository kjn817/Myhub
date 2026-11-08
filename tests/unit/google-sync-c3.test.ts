/// <reference types="jest" />
/**
 * src/services/google-sync.ts — 잔여 분기 성질 테스트 (C3).
 *
 * 기존 google-sync.test.ts(FakeD1)가 닿지 못한 경로를 실제 SQLite로 고정:
 * - 캘린더는 성공했지만 메일 조회가 실패하면 api_error로 끝나고 gmail
 *   failed 로그가 남는다 (부분 성공을 성공으로 보고하지 않는다).
 * - 토큰이 revoked면 token_refresh 로그에 reauth_required가 명시된다.
 * - 쓰기가 켜져 있으면 동기화 끝에 백필이 실제로 붙고, 미동기화 일정이
 *   캘린더에 생성되어 결과에 backfill 건수가 실린다.
 * - 로그 기록 자체가 실패해도(recordGoogleSyncLog·getLastSyncLog)
 *   호출자는 예외 없이 fail-soft로 동작한다.
 * 실 Google API는 호출하지 않는다 (주입 fetch가 경계).
 */
import * as fs from 'fs'
import * as path from 'path'
import { syncGoogleNow, getLastSyncLog, recordGoogleSyncLog } from '../../src/services/google-sync'
import { saveGoogleTokens } from '../../src/services/google-tokens'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createLocalD1 } = require('../helpers/local-d1.cjs')

const ROOT = path.join(__dirname, '..', '..')
const mig = (n: string) => fs.readFileSync(path.join(ROOT, 'migrations', n), 'utf8')
const KEY = 'test-c3-sync-key'
const NOW = 1_790_000_000_000

function makeDb() {
  const db = createLocalD1()
  db.exec(mig('0014_schedules.sql'))
  db.exec(mig('0054_google_integrations.sql'))
  db.exec(mig('0068_schedule_google_event.sql'))
  db.exec(mig('0071_schedule_google_sync_status.sql'))
  return db
}

async function makeEnv(db: any, opts: { write?: string; scope?: string } = {}) {
  const env: any = {
    DB: db,
    MEMO_ENCRYPTION_KEY: KEY,
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'csec',
    ...(opts.write !== undefined ? { GOOGLE_WRITE_ENABLED: opts.write } : {}),
  }
  await saveGoogleTokens(env, {
    email: 'u@example.com',
    accessToken: 'at-valid',
    refreshToken: 'rt-1',
    scope: opts.scope ?? 'https://www.googleapis.com/auth/calendar.readonly',
    expiresIn: 3600,
  })
  return env
}

interface Behavior { calendar?: number; gmail?: number }
function syncFetch(behavior: Behavior = {}): typeof fetch {
  return (async (url: unknown) => {
    const u = String(url)
    if (u.includes('/calendar/v3/calendars/primary/events')) {
      const status = behavior.calendar ?? 200
      return new Response(JSON.stringify(status === 200 ? { items: [{ id: 'e1' }] } : {}), { status })
    }
    if (u.includes('/gmail/v1/users/me/messages')) {
      const status = behavior.gmail ?? 200
      return new Response(JSON.stringify(status === 200 ? { messages: [{ id: 'm1' }] } : {}), { status })
    }
    if (u.includes('/calendar/v3/calendars/primary/events') ) return new Response('{}', { status: 200 })
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
}

async function logsOf(db: any, kind: string) {
  const { results } = await db.prepare('SELECT status, detail FROM google_sync_log WHERE kind = ? ORDER BY id').bind(kind).all()
  return results as Array<{ status: string; detail: string }>
}

describe('syncGoogleNow — 부분 실패와 토큰 상태', () => {
  test('메일 조회 실패: 캘린더 성공 후에도 api_error이고 gmail failed 로그가 남는다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    const r = await syncGoogleNow(syncFetch({ gmail: 500 }), env, { now: NOW, force: true })
    expect(r).toEqual({ ran: false, reason: 'api_error' })
    expect(await logsOf(db, 'calendar')).toEqual([{ status: 'ok', detail: expect.stringContaining('events=1') }])
    expect(await logsOf(db, 'gmail')).toEqual([{ status: 'failed', detail: expect.any(String) }])
  })

  test('revoked 토큰: token_refresh failed 로그에 reauth_required=true가 명시된다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    await db.prepare("UPDATE google_integrations SET status = 'revoked' WHERE provider = 'google'").run()
    const r = await syncGoogleNow(syncFetch(), env, { now: NOW, force: true })
    expect(r).toEqual({ ran: false, reason: 'revoked' })
    const logs = await logsOf(db, 'token_refresh')
    expect(logs).toHaveLength(1)
    expect(logs[0].status).toBe('failed')
    expect(logs[0].detail).toContain('reauth_required=true')
  })
})

describe('syncGoogleNow — 쓰기 활성 시 백필 연결', () => {
  test('미동기화 일정이 있으면 백필이 실행되어 생성 건수가 결과에 실린다', async () => {
    const db = makeDb()
    const env = await makeEnv(db, { write: 'true', scope: 'https://www.googleapis.com/auth/calendar.events' })
    await db.prepare('INSERT INTO schedules (title, start_at, google_sync_status) VALUES (?, ?, ?)')
      .bind('백필 대상', '2026-11-09T10:00:00+09:00', 'pending').run()
    // 캘린더 목록 조회(pull)와 마커 조회·생성을 한 fetch가 모두 받는다:
    // pull 목록에는 items가 있고, 마커 조회(privateExtendedProperty)는 비어 있다.
    const fetchFn = (async (url: unknown, init?: { method?: string; body?: string }) => {
      const u = String(url)
      if (u.includes('privateExtendedProperty')) return new Response(JSON.stringify({ items: [] }), { status: 200 })
      if (u.includes('/gmail/v1/')) return new Response(JSON.stringify({ messages: [] }), { status: 200 })
      if (u.includes('/calendar/v3/') && (init?.method ?? 'GET') === 'POST') {
        const body = init?.body ? JSON.parse(init.body) : {}
        return new Response(JSON.stringify({ id: body.id ?? 'srv' }), { status: 200 })
      }
      if (u.includes('/calendar/v3/')) return new Response(JSON.stringify({ items: [{ id: 'e1' }] }), { status: 200 })
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    const r = await syncGoogleNow(fetchFn, env, { now: NOW, force: true })
    expect(r.ran).toBe(true)
    expect(r.backfill).toMatchObject({ scanned: 1, created: 1, failed: 0 })
    const row = await db.prepare('SELECT google_event_id, google_sync_status FROM schedules').first()
    expect(row.google_sync_status).toBe('synced')
    expect(row.google_event_id).toBeTruthy()
  })

  test('쓰기가 꺼져 있으면 백필은 붙지 않는다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    await db.prepare('INSERT INTO schedules (title, start_at, google_sync_status) VALUES (?, ?, ?)')
      .bind('대상', '2026-11-09T10:00:00+09:00', 'pending').run()
    const r = await syncGoogleNow(syncFetch(), env, { now: NOW, force: true })
    expect(r.ran).toBe(true)
    expect(r.backfill).toBeUndefined()
    const row = await db.prepare('SELECT google_event_id FROM schedules').first()
    expect(row.google_event_id).toBeNull()
  })
})

describe('syncGoogleNow — KV 경계 fail-soft', () => {
  test('KV get/put이 던져도 간격 제어를 건너뛰고 동기화는 실행된다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    env.KV = {
      get: async () => { throw new Error('kv down') },
      put: async () => { throw new Error('kv down') },
    }
    const r = await syncGoogleNow(syncFetch(), env, { now: NOW })
    expect(r.ran).toBe(true)
    expect(r.calendarCount).toBe(1)
  })
})

describe('fail-soft 로그 경계', () => {
  test('recordGoogleSyncLog는 DB가 깨져도 던지지 않고, detail은 500자로 잘린다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    await expect(recordGoogleSyncLog(env, 'calendar', 'ok', 'x'.repeat(900))).resolves.toBeUndefined()
    const logs = await logsOf(db, 'calendar')
    expect(logs[0].detail.length).toBe(500)
    const brokenEnv = { DB: { prepare: () => { throw new Error('gone') } } } as never
    await expect(recordGoogleSyncLog(brokenEnv, 'gmail', 'failed', 'd')).resolves.toBeUndefined()
    await expect(getLastSyncLog(brokenEnv)).resolves.toEqual([])
  })

  test('getLastSyncLog는 최신 5건을 최신순으로 돌려준다', async () => {
    const db = makeDb()
    const env = await makeEnv(db)
    for (let i = 0; i < 7; i++) {
      await recordGoogleSyncLog(env, 'calendar', 'ok', `entry-${i}`)
    }
    const last = await getLastSyncLog(env)
    expect(last).toHaveLength(5)
    expect(last[0].detail).toBe('entry-6')
    expect(last[4].detail).toBe('entry-2')
  })
})
