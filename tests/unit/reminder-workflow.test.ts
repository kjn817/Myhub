/// <reference types="jest" />
/**
 * src/services/reminder-workflow.ts + src/scheduled.ts 플래그 위임 테스트
 * - 실제 SQLite(better-sqlite3 기반 local-d1)에 0014·0018·0050 마이그레이션을
 *   적용하고, 실제 VAPID 암호화 경로 + fetch 모킹으로 종단 검증한다.
 * - sendPush deps 주입으로 평문 페이로드(본문·태그)도 검증한다.
 */
import * as fs from 'fs'
import * as path from 'path'
import { handleScheduled } from '../../src/scheduled'
import {
  isWorkflowReminderEnabled,
  fmtTimeKST,
  buildScheduleReminderWorkflow,
  runReminderTick,
} from '../../src/services/reminder-workflow'
import { runWorkflow } from '../../src/services/workflow'
import { _resetVapidCache } from '../../src/services/push'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createLocalD1 } = require('../helpers/local-d1.cjs')

const SQL_0014 = fs.readFileSync(path.join(__dirname, '../../migrations/0014_schedules.sql'), 'utf8')
const SQL_0018 = fs.readFileSync(path.join(__dirname, '../../migrations/0018_push.sql'), 'utf8')
const SQL_0050 = fs.readFileSync(path.join(__dirname, '../../migrations/0050_workflow_runs.sql'), 'utf8')

const origFetch = global.fetch

function makeDb(withWorkflowTables = true): any {
  const d1 = createLocalD1()
  d1.exec(SQL_0014)
  d1.exec(SQL_0018)
  if (withWorkflowTables) d1.exec(SQL_0050)
  return d1
}

/** KST wall-clock 문자열 ('YYYY-MM-DDTHH:mm'). offset분 후의 일정을 만든다. */
function kstWallClock(offsetMinutes: number): string {
  return new Date(Date.now() + (9 * 60 + offsetMinutes) * 60000).toISOString().slice(0, 16)
}

function b64urlEncodeBytes(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function makeVapidEnv() {
  const kp = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
  )) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey
  return { VAPID_PRIVATE_KEY: JSON.stringify(jwk), VAPID_SUBJECT: 'mailto:test@test.com' }
}

async function makeSubscription(endpoint = 'https://push.example.com/sub/123') {
  const kp = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  )) as CryptoKeyPair
  const pubRaw = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer)
  const auth = crypto.getRandomValues(new Uint8Array(16))
  return { endpoint, p256dh: b64urlEncodeBytes(pubRaw), auth: b64urlEncodeBytes(auth) }
}

function insertSchedule(db: any, over: any = {}): number {
  const row = {
    title: '주간 회의',
    location: '회의실 A',
    start_at: kstWallClock(10),
    status: 'active',
    ...over,
  }
  const info = db._db.prepare(
    'INSERT INTO schedules (title, location, start_at, status) VALUES (?, ?, ?, ?)'
  ).run(row.title, row.location, row.start_at, row.status)
  return Number(info.lastInsertRowid)
}

function insertSub(db: any, sub: any): void {
  db._db.prepare(
    'INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)'
  ).run(sub.endpoint, sub.p256dh, sub.auth)
}

function countRows(db: any, sql: string): number {
  return (db._db.prepare(sql).get() as any)?.n ?? 0
}

function queryAll(db: any, sql: string): any[] {
  return db._db.prepare(sql).all()
}

function fetchMock(): jest.Mock {
  return global.fetch as unknown as jest.Mock
}

beforeEach(() => {
  _resetVapidCache()
  ;(global as any).fetch = jest.fn()
})

afterEach(() => {
  global.fetch = origFetch
  jest.clearAllMocks()
})

describe('플래그·포맷 헬퍼', () => {
  test("WORKFLOW_REMINDER_ENABLED='true'일 때만 켜진다", () => {
    expect(isWorkflowReminderEnabled({} as any)).toBe(false)
    expect(isWorkflowReminderEnabled({ WORKFLOW_REMINDER_ENABLED: 'false' } as any)).toBe(false)
    expect(isWorkflowReminderEnabled({ WORKFLOW_REMINDER_ENABLED: 'true' } as any)).toBe(true)
  })

  test('fmtTimeKST', () => {
    expect(fmtTimeKST('2026-10-25T15:30')).toBe('15:30')
    expect(fmtTimeKST('abc')).toBe('')
  })
})

describe('runReminderTick (워크플로 경로)', () => {
  test('정상 발송: reminders sent + 실행 기록 1건 + 단계 4건', async () => {
    const db = makeDb()
    const vapid = await makeVapidEnv()
    const sub = await makeSubscription()
    const id = insertSchedule(db)
    insertSub(db, sub)
    fetchMock().mockResolvedValue({ ok: true, status: 201 })
    const env = { DB: db, ...vapid } as any

    const r = await runReminderTick(env)
    expect(r).toEqual({ checked: 1, sent: 1, failed: 0 })
    expect(fetchMock()).toHaveBeenCalledTimes(1)
    expect(fetchMock().mock.calls[0][0]).toBe(sub.endpoint)

    const reminder = queryAll(db, 'SELECT * FROM reminders')[0]
    expect(reminder.schedule_id).toBe(id)
    expect(reminder.status).toBe('sent')
    expect(reminder.dedupe_key).toBe(`push:${id}:${reminder.remind_at}`)

    const runs = queryAll(db, 'SELECT * FROM workflow_runs')
    expect(runs).toHaveLength(1)
    expect(runs[0].workflow_id).toBe('schedule-reminder')
    expect(runs[0].status).toBe('completed')
    expect(runs[0].trigger_type).toBe('cron')
    const steps = queryAll(db, 'SELECT node_id, status FROM workflow_run_steps ORDER BY id')
    expect(steps).toEqual([
      { node_id: 'claim', status: 'completed' },
      { node_id: 'compose', status: 'completed' },
      { node_id: 'send-push', status: 'completed' },
      { node_id: 'record', status: 'completed' },
    ])
  })

  test('본문·태그 형식 (평문 페이로드 캡처)', async () => {
    const db = makeDb()
    const vapid = await makeVapidEnv()
    const startAt = '2026-10-18T15:30'
    const id = insertSchedule(db, { start_at: kstWallClock(10) })
    // start_at을 고정값으로 바꿔 태그를 확정한다 (due 윈도우 밖이어도
    // runWorkflow 직접 호출이라 무관)
    db._db.prepare('UPDATE schedules SET start_at = ? WHERE id = ?').run(startAt, id)
    insertSub(db, { endpoint: 'https://push.example.com/x', p256dh: 'k', auth: 'a' })
    const sent: any[] = []
    const sendPush = jest.fn(async (_e: any, _s: any, p: any) => {
      sent.push(p)
      return { ok: true, status: 201, gone: false }
    })
    const env = { DB: db, ...vapid } as any
    const res = await runWorkflow(buildScheduleReminderWorkflow({ sendPush }), {
      env,
      input: { scheduleId: id, title: '주간 회의', startAt, location: '회의실 A' },
      idempotencyKey: `push:${id}:${startAt}`,
    })
    expect(res.status).toBe('completed')
    expect(sent).toHaveLength(1)
    expect(sent[0].title).toBe('일정 알림')
    expect(sent[0].body).toBe('15:30 주간 회의 · 회의실 A')
    expect(sent[0].tag).toBe(`push:${id}:${startAt}`)
    expect(sent[0].url).toBe('/schedule.html')
  })

  test('start_at이 짧으면 시간 prefix 없이 본문을 만든다', async () => {
    const db = makeDb()
    const vapid = await makeVapidEnv()
    const sent: any[] = []
    // claim 노드의 INSERT는 schedules 행을 참조한다 (FK) — 일정 행을 먼저 만든다
    db._db.prepare(
      "INSERT INTO schedules (id, title, location, start_at, status) VALUES (7, '주간 회의', '', 'abc', 'active')"
    ).run()
    insertSub(db, { endpoint: 'https://push.example.com/x', p256dh: 'k', auth: 'a' })
    const sendPush = jest.fn(async (_e: any, _s: any, p: any) => {
      sent.push(p)
      return { ok: true, status: 201, gone: false }
    })
    const env = { DB: db, ...vapid } as any
    await runWorkflow(buildScheduleReminderWorkflow({ sendPush }), {
      env,
      input: { scheduleId: 7, title: '주간 회의', startAt: 'abc', location: null },
      idempotencyKey: 'push:7:abc',
    })
    expect(sent[0].body).toBe('주간 회의')
  })

  test('같은 틱 2회 → 2회째는 duplicate로 재발송 없음', async () => {
    const db = makeDb()
    const vapid = await makeVapidEnv()
    const sub = await makeSubscription()
    insertSchedule(db)
    insertSub(db, sub)
    fetchMock().mockResolvedValue({ ok: true, status: 201 })
    const env = { DB: db, ...vapid } as any

    expect(await runReminderTick(env)).toEqual({ checked: 1, sent: 1, failed: 0 })
    expect(await runReminderTick(env)).toEqual({ checked: 1, sent: 0, failed: 0 })
    expect(fetchMock()).toHaveBeenCalledTimes(1)
    expect(countRows(db, 'SELECT COUNT(*) n FROM workflow_runs')).toBe(1)
    expect(countRows(db, 'SELECT COUNT(*) n FROM reminders')).toBe(1)
  })

  test('이미 선점된 일정 → 발송 없이 건너뜀 (claim=false)', async () => {
    const db = makeDb()
    const vapid = await makeVapidEnv()
    const sub = await makeSubscription()
    const startAt = kstWallClock(10)
    const id = insertSchedule(db, { start_at: startAt })
    insertSub(db, sub)
    db._db.prepare(
      "INSERT INTO reminders (schedule_id, remind_at, status, dedupe_key) VALUES (?, ?, 'pending', ?)"
    ).run(id, startAt, `push:${id}:${startAt}`)
    fetchMock().mockResolvedValue({ ok: true, status: 201 })
    const env = { DB: db, ...vapid } as any

    const r = await runReminderTick(env)
    expect(r).toEqual({ checked: 1, sent: 0, failed: 0 })
    expect(fetchMock()).not.toHaveBeenCalled()
    const steps = queryAll(db, 'SELECT node_id, status FROM workflow_run_steps ORDER BY id')
    expect(steps).toEqual([
      { node_id: 'claim', status: 'completed' },
      { node_id: 'compose', status: 'skipped' },
      { node_id: 'send-push', status: 'skipped' },
      { node_id: 'record', status: 'skipped' },
    ])
  })

  test('발송 실패(500) → 3회 재시도 후 reminders failed, failed=1', async () => {
    const db = makeDb()
    const vapid = await makeVapidEnv()
    const sub = await makeSubscription()
    insertSchedule(db)
    insertSub(db, sub)
    fetchMock().mockResolvedValue({ ok: false, status: 500, text: async () => 'err' })
    const delays: number[] = []
    const env = { DB: db, ...vapid } as any

    const r = await runReminderTick(env, { sleep: async (ms) => {
      delays.push(ms)
    } })
    expect(r).toEqual({ checked: 1, sent: 0, failed: 1 })
    expect(fetchMock()).toHaveBeenCalledTimes(3)
    expect(delays).toEqual([1000, 2000])
    expect(queryAll(db, 'SELECT status FROM reminders')[0].status).toBe('failed')
    expect(queryAll(db, 'SELECT status FROM workflow_runs')[0].status).toBe('completed')
  })

  test('만료 구독(410) → 구독 삭제 + failed=1', async () => {
    const db = makeDb()
    const vapid = await makeVapidEnv()
    const sub = await makeSubscription('https://push.example.com/dead')
    insertSchedule(db)
    insertSub(db, sub)
    fetchMock().mockResolvedValue({ ok: false, status: 410, text: async () => '' })
    const env = { DB: db, ...vapid } as any

    const r = await runReminderTick(env)
    expect(r).toEqual({ checked: 1, sent: 0, failed: 1 })
    expect(countRows(db, 'SELECT COUNT(*) n FROM push_subscriptions')).toBe(0)
    expect(queryAll(db, 'SELECT status FROM reminders')[0].status).toBe('failed')
    // 만료만으로 전원 실패 → 재시도하지 않는다 (fetch 1회)
    expect(fetchMock()).toHaveBeenCalledTimes(1)
  })

  test('일부 성공 → sent=1, reminders sent', async () => {
    const db = makeDb()
    const vapid = await makeVapidEnv()
    const sub1 = await makeSubscription('https://push.example.com/a')
    const sub2 = await makeSubscription('https://push.example.com/b')
    insertSchedule(db)
    insertSub(db, sub1)
    insertSub(db, sub2)
    fetchMock()
      .mockResolvedValueOnce({ ok: true, status: 201 })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'err' })
    const env = { DB: db, ...vapid } as any

    const r = await runReminderTick(env)
    expect(r).toEqual({ checked: 1, sent: 1, failed: 0 })
    expect(queryAll(db, 'SELECT status FROM reminders')[0].status).toBe('sent')
  })

  test('fetch 예외 2회 후 성공 → 재시도 [1000, 2000], sent=1', async () => {
    const db = makeDb()
    const vapid = await makeVapidEnv()
    const sub = await makeSubscription()
    insertSchedule(db)
    insertSub(db, sub)
    fetchMock()
      .mockRejectedValueOnce(new Error('net down'))
      .mockRejectedValueOnce(new Error('net down'))
      .mockResolvedValue({ ok: true, status: 201 })
    const delays: number[] = []
    const env = { DB: db, ...vapid } as any

    const r = await runReminderTick(env, { sleep: async (ms) => {
      delays.push(ms)
    } })
    expect(r).toEqual({ checked: 1, sent: 1, failed: 0 })
    expect(delays).toEqual([1000, 2000])
    expect(fetchMock()).toHaveBeenCalledTimes(3)
    const step = queryAll(db, "SELECT status, attempt FROM workflow_run_steps WHERE node_id='send-push'")[0]
    expect(step).toEqual({ status: 'completed', attempt: 3 })
  })

  test('fetch 예외 지속 → 재시도 소진 후 record가 failed로 마무리', async () => {
    const db = makeDb()
    const vapid = await makeVapidEnv()
    const sub = await makeSubscription()
    insertSchedule(db)
    insertSub(db, sub)
    fetchMock().mockRejectedValue(new Error('net down'))
    const delays: number[] = []
    const env = { DB: db, ...vapid } as any

    const r = await runReminderTick(env, { sleep: async (ms) => {
      delays.push(ms)
    } })
    expect(r).toEqual({ checked: 1, sent: 0, failed: 1 })
    expect(delays).toEqual([1000, 2000])
    expect(fetchMock()).toHaveBeenCalledTimes(3)
    expect(queryAll(db, 'SELECT status FROM reminders')[0].status).toBe('failed')
    // continueOnError: 워크플로 자체는 완료로 기록되고, 실패는 단계에 남는다
    expect(queryAll(db, 'SELECT status FROM workflow_runs')[0].status).toBe('completed')
    const steps = queryAll(db, 'SELECT node_id, status, attempt FROM workflow_run_steps ORDER BY id')
    expect(steps).toEqual([
      { node_id: 'claim', status: 'completed', attempt: 1 },
      { node_id: 'compose', status: 'completed', attempt: 1 },
      { node_id: 'send-push', status: 'failed', attempt: 3 },
      { node_id: 'record', status: 'completed', attempt: 1 },
    ])
  })

  test('구독 없음 → 발송 없이 종료, 워크플로 실행 없음', async () => {
    const db = makeDb()
    const vapid = await makeVapidEnv()
    insertSchedule(db)
    fetchMock().mockResolvedValue({ ok: true, status: 201 })
    const env = { DB: db, ...vapid } as any

    const r = await runReminderTick(env)
    expect(r).toEqual({ checked: 1, sent: 0, failed: 0 })
    expect(fetchMock()).not.toHaveBeenCalled()
    expect(countRows(db, 'SELECT COUNT(*) n FROM workflow_runs')).toBe(0)
  })

  test('30분 밖 일정은 due가 아니다', async () => {
    const db = makeDb()
    const vapid = await makeVapidEnv()
    const sub = await makeSubscription()
    insertSchedule(db, { start_at: kstWallClock(60) })
    insertSub(db, sub)
    fetchMock().mockResolvedValue({ ok: true, status: 201 })
    const env = { DB: db, ...vapid } as any

    const r = await runReminderTick(env)
    expect(r).toEqual({ checked: 0, sent: 0, failed: 0 })
    expect(fetchMock()).not.toHaveBeenCalled()
  })

  test('VAPID 미설정 → 즉시 0 반환', async () => {
    const db = makeDb()
    insertSchedule(db)
    const env = { DB: db } as any
    const r = await runReminderTick(env)
    expect(r).toEqual({ checked: 0, sent: 0, failed: 0 })
  })

  test('0050 미적용 DB에서도 알림은 동작한다 (기록 best-effort)', async () => {
    const db = makeDb(false)
    const vapid = await makeVapidEnv()
    const sub = await makeSubscription()
    insertSchedule(db)
    insertSub(db, sub)
    fetchMock().mockResolvedValue({ ok: true, status: 201 })
    const env = { DB: db, ...vapid } as any

    const r = await runReminderTick(env)
    expect(r).toEqual({ checked: 1, sent: 1, failed: 0 })
    expect(queryAll(db, 'SELECT status FROM reminders')[0].status).toBe('sent')
  })
})

describe('handleScheduled 플래그 위임', () => {
  test('플래그 ON → 워크플로 경로 (실행 기록 남음)', async () => {
    const db = makeDb()
    const vapid = await makeVapidEnv()
    const sub = await makeSubscription()
    insertSchedule(db)
    insertSub(db, sub)
    fetchMock().mockResolvedValue({ ok: true, status: 201 })
    const env = { DB: db, ...vapid, WORKFLOW_REMINDER_ENABLED: 'true' } as any

    const r = await handleScheduled(env)
    expect(r).toEqual({ checked: 1, sent: 1, failed: 0 })
    expect(countRows(db, 'SELECT COUNT(*) n FROM workflow_runs')).toBe(1)
  })

  test('플래그 OFF → 기존 경로 (실행 기록 없음)', async () => {
    const db = makeDb()
    const vapid = await makeVapidEnv()
    const sub = await makeSubscription()
    insertSchedule(db)
    insertSub(db, sub)
    fetchMock().mockResolvedValue({ ok: true, status: 201 })
    const env = { DB: db, ...vapid } as any

    const r = await handleScheduled(env)
    expect(r).toEqual({ checked: 1, sent: 1, failed: 0 })
    expect(countRows(db, 'SELECT COUNT(*) n FROM workflow_runs')).toBe(0)
    expect(queryAll(db, 'SELECT status FROM reminders')[0].status).toBe('sent')
  })
})
