/// <reference types="jest" />
/**
 * src/scheduled.ts 단위 테스트 (Cron 스케줄 핸들러)
 * - services/push 를 jest.mock 으로 대체 (isPushConfigured / sendPushNotification)
 * - Mock D1: prepare/bind/all/run 큐 기반
 */
import { handleScheduled } from '../../src/scheduled'
import { isPushConfigured, sendPushNotification } from '../../src/services/push'

jest.mock('../../src/services/push', () => ({
  isPushConfigured: jest.fn(),
  sendPushNotification: jest.fn(),
}))

const mockIsPushConfigured = isPushConfigured as jest.Mock
const mockSendPush = sendPushNotification as jest.Mock

class MockDb {
  allQueue: any[] = []
  runQueue: any[] = []
  prepares: string[] = []
  binds: any[][] = []

  prepare(sql: string) {
    this.prepares.push(sql)
    const db = this
    const stmt = {
      bind(...params: any[]) {
        db.binds.push(params)
        return stmt
      },
      all: async () => {
        const v = db.allQueue.shift()
        if (v instanceof Error) throw v
        return v ?? { results: [] }
      },
      first: async () => null,
      run: async () => {
        const v = db.runQueue.shift()
        if (v instanceof Error) throw v
        return v ?? { meta: { changes: 1 } }
      },
    }
    return stmt
  }
}

const dueSchedule = (over: any = {}) => ({
  id: 7,
  title: '주간 회의',
  start_at: '2026-10-18T15:30',
  location: '회의실 A',
  ...over,
})
const sub = (over: any = {}) => ({ endpoint: 'https://push/x', p256dh: 'k', auth: 'a', ...over })

beforeEach(() => {
  jest.clearAllMocks()
})

function envWith(db: MockDb): any {
  return { DB: db }
}

describe('handleScheduled', () => {
  test('푸시 미설정 시 즉시 0을 반환한다', async () => {
    mockIsPushConfigured.mockReturnValue(false)
    const db = new MockDb()
    const r = await handleScheduled(envWith(db))
    expect(r).toEqual({ checked: 0, sent: 0, failed: 0 })
    expect(db.prepares).toHaveLength(0)
  })

  test('일정 조회 쿼리 실패 시 조용히 0을 반환한다', async () => {
    mockIsPushConfigured.mockReturnValue(true)
    const db = new MockDb()
    db.allQueue.push(new Error('no such table'))
    const r = await handleScheduled(envWith(db))
    expect(r).toEqual({ checked: 0, sent: 0, failed: 0 })
  })

  test('30분 내 일정이 없으면 checked=0으로 종료한다', async () => {
    mockIsPushConfigured.mockReturnValue(true)
    const db = new MockDb()
    db.allQueue.push({ results: [] })
    const r = await handleScheduled(envWith(db))
    expect(r).toEqual({ checked: 0, sent: 0, failed: 0 })
    expect(mockSendPush).not.toHaveBeenCalled()
  })

  test('구독 조회 실패 시 checked만 설정하고 종료한다', async () => {
    mockIsPushConfigured.mockReturnValue(true)
    const db = new MockDb()
    db.allQueue.push({ results: [dueSchedule()] })
    db.allQueue.push(new Error('db down'))
    const r = await handleScheduled(envWith(db))
    expect(r).toEqual({ checked: 1, sent: 0, failed: 0 })
  })

  test('구독이 없으면 발송 없이 종료한다', async () => {
    mockIsPushConfigured.mockReturnValue(true)
    const db = new MockDb()
    db.allQueue.push({ results: [dueSchedule()] })
    db.allQueue.push({ results: [] })
    const r = await handleScheduled(envWith(db))
    expect(r).toEqual({ checked: 1, sent: 0, failed: 0 })
    expect(mockSendPush).not.toHaveBeenCalled()
  })

  test('정상 발송: dedupe 선점 → 푸시 → reminders sent 업데이트', async () => {
    mockIsPushConfigured.mockReturnValue(true)
    mockSendPush.mockResolvedValue({ ok: true })
    const db = new MockDb()
    db.allQueue.push({ results: [dueSchedule()] })
    db.allQueue.push({ results: [sub()] })
    db.runQueue.push({ meta: { changes: 1 } }) // INSERT OR IGNORE 선점 성공
    db.runQueue.push({ meta: { changes: 1 } }) // UPDATE reminders
    const r = await handleScheduled(envWith(db))
    expect(r).toEqual({ checked: 1, sent: 1, failed: 0 })
    expect(mockSendPush).toHaveBeenCalledTimes(1)
    const payload = mockSendPush.mock.calls[0][2]
    expect(payload.title).toBe('일정 알림')
    expect(payload.body).toBe('15:30 주간 회의 · 회의실 A')
    expect(payload.tag).toBe('push:7:2026-10-18T15:30')
    // UPDATE가 sent 상태로 호출됐는지
    const updateBind = db.binds[db.binds.length - 1]
    expect(updateBind[0]).toBe('sent')
    expect(updateBind[1]).toBe('push:7:2026-10-18T15:30')
  })

  test('이미 선점된 일정(dedupe changes=0)은 건너뛴다', async () => {
    mockIsPushConfigured.mockReturnValue(true)
    const db = new MockDb()
    db.allQueue.push({ results: [dueSchedule(), dueSchedule({ id: 8 })] })
    db.allQueue.push({ results: [sub()] })
    db.runQueue.push({ meta: { changes: 0 } }) // 첫 일정: 이미 처리됨
    db.runQueue.push({ meta: { changes: 1 } }) // 두 번째 일정: 선점
    db.runQueue.push({ meta: { changes: 1 } }) // UPDATE
    mockSendPush.mockResolvedValue({ ok: true })
    const r = await handleScheduled(envWith(db))
    expect(r).toEqual({ checked: 2, sent: 1, failed: 0 })
    expect(mockSendPush).toHaveBeenCalledTimes(1)
  })

  test('INSERT 실패 시 해당 일정을 건너뛴다 (continue 분기)', async () => {
    mockIsPushConfigured.mockReturnValue(true)
    const db = new MockDb()
    db.allQueue.push({ results: [dueSchedule()] })
    db.allQueue.push({ results: [sub()] })
    db.runQueue.push(new Error('insert fail'))
    const r = await handleScheduled(envWith(db))
    expect(r).toEqual({ checked: 1, sent: 0, failed: 0 })
    expect(mockSendPush).not.toHaveBeenCalled()
  })

  test('발송 실패 시 failed 카운트 + reminders failed 업데이트', async () => {
    mockIsPushConfigured.mockReturnValue(true)
    mockSendPush.mockResolvedValue({ ok: false, gone: false })
    const db = new MockDb()
    db.allQueue.push({ results: [dueSchedule()] })
    db.allQueue.push({ results: [sub()] })
    db.runQueue.push({ meta: { changes: 1 } })
    db.runQueue.push({ meta: { changes: 1 } })
    const r = await handleScheduled(envWith(db))
    expect(r).toEqual({ checked: 1, sent: 0, failed: 1 })
    const updateBind = db.binds[db.binds.length - 1]
    expect(updateBind[0]).toBe('failed')
  })

  test('만료된 구독(410 gone)은 push_subscriptions에서 삭제한다', async () => {
    mockIsPushConfigured.mockReturnValue(true)
    mockSendPush.mockResolvedValue({ ok: false, gone: true })
    const db = new MockDb()
    db.allQueue.push({ results: [dueSchedule()] })
    db.allQueue.push({ results: [sub({ endpoint: 'https://push/dead' })] })
    db.runQueue.push({ meta: { changes: 1 } }) // INSERT 선점
    db.runQueue.push({ meta: { changes: 1 } }) // DELETE 만료 구독
    db.runQueue.push({ meta: { changes: 1 } }) // UPDATE reminders
    const r = await handleScheduled(envWith(db))
    expect(r).toEqual({ checked: 1, sent: 0, failed: 1 })
    const deleteSql = db.prepares.find((s) => s.includes('DELETE FROM push_subscriptions'))
    expect(deleteSql).toBeDefined()
    const deleteBind = db.binds.find((b) => b[0] === 'https://push/dead')
    expect(deleteBind).toBeDefined()
  })

  test('만료 구독 DELETE 실패는 무시한다 (.catch 분기)', async () => {
    mockIsPushConfigured.mockReturnValue(true)
    mockSendPush.mockResolvedValue({ ok: false, gone: true })
    const db = new MockDb()
    db.allQueue.push({ results: [dueSchedule()] })
    db.allQueue.push({ results: [sub({ endpoint: 'https://push/dead' })] })
    db.runQueue.push({ meta: { changes: 1 } }) // INSERT 선점
    db.runQueue.push(new Error('delete fail')) // DELETE 실패 → .catch(() => {})
    db.runQueue.push({ meta: { changes: 1 } }) // UPDATE reminders
    const r = await handleScheduled(envWith(db))
    expect(r).toEqual({ checked: 1, sent: 0, failed: 1 })
  })

  test('일부 성공 시 sent 상태로 업데이트한다 (혼합 결과)', async () => {
    mockIsPushConfigured.mockReturnValue(true)
    mockSendPush
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, gone: false })
    const db = new MockDb()
    db.allQueue.push({ results: [dueSchedule()] })
    db.allQueue.push({ results: [sub(), sub({ endpoint: 'https://push/y' })] })
    db.runQueue.push({ meta: { changes: 1 } })
    db.runQueue.push({ meta: { changes: 1 } })
    const r = await handleScheduled(envWith(db))
    expect(r).toEqual({ checked: 1, sent: 1, failed: 0 })
    const updateBind = db.binds[db.binds.length - 1]
    expect(updateBind[0]).toBe('sent')
  })

  test('start_at이 짧으면 시간 prefix 없이 body를 만든다 (fmtTimeKST || "" 분기)', async () => {
    mockIsPushConfigured.mockReturnValue(true)
    mockSendPush.mockResolvedValue({ ok: true })
    const db = new MockDb()
    db.allQueue.push({ results: [dueSchedule({ start_at: 'abc', location: null })] })
    db.allQueue.push({ results: [sub()] })
    db.runQueue.push({ meta: { changes: 1 } })
    db.runQueue.push({ meta: { changes: 1 } })
    const r = await handleScheduled(envWith(db))
    expect(r.sent).toBe(1)
    const payload = mockSendPush.mock.calls[0][2]
    expect(payload.body).toBe('주간 회의')
  })

  test('reminders UPDATE 실패는 무시한다 (.catch 분기)', async () => {
    mockIsPushConfigured.mockReturnValue(true)
    mockSendPush.mockResolvedValue({ ok: true })
    const db = new MockDb()
    db.allQueue.push({ results: [dueSchedule()] })
    db.allQueue.push({ results: [sub()] })
    db.runQueue.push({ meta: { changes: 1 } })
    db.runQueue.push(new Error('update fail'))
    const r = await handleScheduled(envWith(db))
    expect(r).toEqual({ checked: 1, sent: 1, failed: 0 })
  })

  test('윈도우는 KST 문자열 범위 바인딩이다 (P-3: datetime() BETWEEN 대체)', async () => {
    mockIsPushConfigured.mockReturnValue(true)
    const db = new MockDb()
    db.allQueue.push({ results: [] })
    const before = Date.now()
    await handleScheduled(envWith(db))
    const sql = db.prepares[0]
    expect(sql).toContain('start_at >= ? AND start_at <= ?')
    expect(sql).not.toContain('datetime(')
    const [winStart, winEnd] = db.binds[0]
    expect(winStart).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
    expect(winEnd).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
    // 두 경계는 정확히 30분 차이 (호출 전후 Date.now() 오차 ±1초 허용)
    const span = Date.parse(winEnd + 'Z') - Date.parse(winStart + 'Z')
    expect(span).toBe(30 * 60 * 1000)
    // 하한은 KST 현재 시각 (UTC now + 9시간, ±2초 허용)
    const kstNow = before + 9 * 60 * 60 * 1000
    expect(Math.abs(Date.parse(winStart + 'Z') - kstNow)).toBeLessThanOrEqual(2000)
  })

  test('results가 null이면 빈 배열로 처리한다 (|| [] 분기)', async () => {
    mockIsPushConfigured.mockReturnValue(true)
    const db = new MockDb()
    db.allQueue.push({ results: null })
    const r = await handleScheduled(envWith(db))
    expect(r).toEqual({ checked: 0, sent: 0, failed: 0 })
  })

  test('구독 results가 null이면 빈 배열로 처리한다 (|| [] 분기)', async () => {
    mockIsPushConfigured.mockReturnValue(true)
    const db = new MockDb()
    db.allQueue.push({ results: [dueSchedule()] })
    db.allQueue.push({ results: null })
    const r = await handleScheduled(envWith(db))
    expect(r).toEqual({ checked: 1, sent: 0, failed: 0 })
  })

  test('INSERT meta가 없으면 미선점으로 처리한다 (?? 0 분기)', async () => {
    mockIsPushConfigured.mockReturnValue(true)
    const db = new MockDb()
    db.allQueue.push({ results: [dueSchedule()] })
    db.allQueue.push({ results: [sub()] })
    db.runQueue.push({}) // meta 없음 → changes ?? 0 → 0 → claimed false
    const r = await handleScheduled(envWith(db))
    expect(r).toEqual({ checked: 1, sent: 0, failed: 0 })
    expect(mockSendPush).not.toHaveBeenCalled()
  })
})
