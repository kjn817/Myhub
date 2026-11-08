/// <reference types="jest" />
/**
 * src/scheduled.ts 커버리지 보강 (그룹 B)
 * - 기존 core-scheduled.test.ts가 다루지 않는 엔트리/분기:
 *   handleScheduled의 워크플로 경로(43행), handleCronJobs(134-166행),
 *   handleGoogleSync(179-182행), handleSleepConsolidation(200-218행)
 * - services/push 외에 reminder-workflow / cron-jobs / google-sync /
 *   memory-consolidation을 jest.mock으로 대체한다 (기존 파일은 push만 mock).
 * - 프로덕션 코드 수정 없음. MockDb는 기존 파일과 같은 큐 기반 패턴.
 */
import {
  handleScheduled,
  handleCronJobs,
  handleGoogleSync,
  handleSleepConsolidation,
} from '../../src/scheduled'
import { isPushConfigured, sendPushNotification } from '../../src/services/push'
import { isWorkflowReminderEnabled, runReminderTick } from '../../src/services/reminder-workflow'
import { runDueCronJobs } from '../../src/services/cron-jobs'
import { syncGoogleNow } from '../../src/services/google-sync'
import {
  CONSOLIDATION_HOUR_KST,
  kstParts,
  getLastConsolidationDate,
  markConsolidationRun,
  runSleepConsolidation,
} from '../../src/services/memory-consolidation'

jest.mock('../../src/services/push', () => ({
  isPushConfigured: jest.fn(),
  sendPushNotification: jest.fn(),
}))

jest.mock('../../src/services/reminder-workflow', () => ({
  isWorkflowReminderEnabled: jest.fn(),
  runReminderTick: jest.fn(),
  // 실제 fmtTimeKST와 동일 ('YYYY-MM-DDTHH:mm' → 'HH:mm', 없으면 '')
  fmtTimeKST: (startAt: string) => startAt.slice(11, 16) || '',
}))

jest.mock('../../src/services/cron-jobs', () => ({
  runDueCronJobs: jest.fn(),
}))

jest.mock('../../src/services/google-sync', () => ({
  syncGoogleNow: jest.fn(),
}))

jest.mock('../../src/services/memory-consolidation', () => ({
  CONSOLIDATION_HOUR_KST: 3,
  kstParts: jest.fn(),
  getLastConsolidationDate: jest.fn(),
  markConsolidationRun: jest.fn(),
  runSleepConsolidation: jest.fn(),
}))

const mockIsPushConfigured = isPushConfigured as jest.Mock
const mockSendPush = sendPushNotification as jest.Mock
const mockIsWorkflowReminderEnabled = isWorkflowReminderEnabled as jest.Mock
const mockRunReminderTick = runReminderTick as jest.Mock
const mockRunDueCronJobs = runDueCronJobs as jest.Mock
const mockSyncGoogleNow = syncGoogleNow as jest.Mock
const mockKstParts = kstParts as jest.Mock
const mockGetLastConsolidationDate = getLastConsolidationDate as jest.Mock
const mockMarkConsolidationRun = markConsolidationRun as jest.Mock
const mockRunSleepConsolidation = runSleepConsolidation as jest.Mock

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

const sub = (over: any = {}) => ({ endpoint: 'https://push/x', p256dh: 'k', auth: 'a', ...over })

function envWith(db: MockDb): any {
  return { DB: db }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockIsPushConfigured.mockReturnValue(true)
  mockIsWorkflowReminderEnabled.mockReturnValue(false)
  mockKstParts.mockReturnValue({ date: '2026-10-26', hour: 3 })
  mockGetLastConsolidationDate.mockResolvedValue(null)
  mockRunSleepConsolidation.mockResolvedValue({
    ok: true, ran: true, merged: 1, contradictions: 0, summarized: 0, skipped: 0,
  })
})

describe('handleScheduled 워크플로 경로', () => {
  test('플래그 ON이면 runReminderTick 결과를 그대로 반환하고 레거시 DB 경로는 타지 않는다', async () => {
    mockIsWorkflowReminderEnabled.mockReturnValue(true)
    mockRunReminderTick.mockResolvedValue({ checked: 2, sent: 1, failed: 0 })
    const db = new MockDb()
    const env = envWith(db)
    const r = await handleScheduled(env)
    expect(r).toEqual({ checked: 2, sent: 1, failed: 0 })
    expect(mockRunReminderTick).toHaveBeenCalledTimes(1)
    expect(mockRunReminderTick).toHaveBeenCalledWith(env)
    // 레거시 경로의 reminders/push 조회는 없고, cron 실행 원장 기록만 남는다
    expect(db.prepares.length).toBeGreaterThan(0)
    expect(db.prepares.every((x: string) => x.includes('ai_settings'))).toBe(true)
    expect(mockSendPush).not.toHaveBeenCalled()
  })

  test('플래그 OFF이면 기존 경로로 진행한다', async () => {
    mockIsWorkflowReminderEnabled.mockReturnValue(false)
    const db = new MockDb()
    db.allQueue.push({ results: [] })
    const r = await handleScheduled(envWith(db))
    expect(r).toEqual({ checked: 0, sent: 0, failed: 0 })
    expect(mockRunReminderTick).not.toHaveBeenCalled()
  })
})

describe('handleCronJobs', () => {
  test('푸시 미설정 시 0을 반환하고 runDueCronJobs를 호출하지 않는다', async () => {
    mockIsPushConfigured.mockReturnValue(false)
    const r = await handleCronJobs(envWith(new MockDb()))
    expect(r).toEqual({ checked: 0, delivered: 0, failed: 0, skipped: 0 })
    expect(mockRunDueCronJobs).not.toHaveBeenCalled()
  })

  test('runDueCronJobs throw 시 fail-soft로 0을 반환한다', async () => {
    mockRunDueCronJobs.mockRejectedValueOnce(new Error('cron down'))
    const r = await handleCronJobs(envWith(new MockDb()))
    expect(r).toEqual({ checked: 0, delivered: 0, failed: 0, skipped: 0 })
  })

  test('due 작업 2건 → 아침 브리핑/일반 제목으로 각 구독에 발송, 구독 조회는 1회(캐시)', async () => {
    const db = new MockDb()
    db.allQueue.push({ results: [sub(), sub({ endpoint: 'https://push/y' })] })
    mockSendPush.mockResolvedValue({ ok: true })
    mockRunDueCronJobs.mockImplementationOnce(async (_env: any, deliver: (job: any, text: string) => Promise<void>) => {
      await deliver({ id: 1, action: 'morning-briefing' }, '오늘 브리핑')
      await deliver({ id: 2, action: 'news-summary' }, '뉴스 요약')
      return { checked: 2, delivered: 2, failed: 0, skipped: 0 }
    })
    const r = await handleCronJobs(envWith(db))
    expect(r).toEqual({ checked: 2, delivered: 2, failed: 0, skipped: 0 })
    expect(mockSendPush).toHaveBeenCalledTimes(4)
    // 첫 작업은 아침 브리핑 제목, 두 번째는 일반 제목
    expect(mockSendPush.mock.calls[0][2]).toEqual(
      expect.objectContaining({ title: '아침 브리핑', body: '오늘 브리핑', url: '/', tag: 'cron:1' }),
    )
    expect(mockSendPush.mock.calls[2][2]).toEqual(
      expect.objectContaining({ title: 'MyHub 알림', body: '뉴스 요약', url: '/', tag: 'cron:2' }),
    )
    // 두 번째 deliver에서도 구독을 다시 조회하지 않음 (캐시)
    expect(db.prepares.filter((s) => s.includes('FROM push_subscriptions'))).toHaveLength(1)
  })

  test('구독 조회 실패 시 발송 없이 조용히 진행한다 (다음 틱 재시도 없음)', async () => {
    const db = new MockDb()
    db.allQueue.push(new Error('db down'))
    mockRunDueCronJobs.mockImplementationOnce(async (_env: any, deliver: (job: any, text: string) => Promise<void>) => {
      await deliver({ id: 1, action: 'morning-briefing' }, '오늘 브리핑')
      await deliver({ id: 2, action: 'morning-briefing' }, '오늘 브리핑 2')
      return { checked: 2, delivered: 0, failed: 0, skipped: 0 }
    })
    const r = await handleCronJobs(envWith(db))
    expect(r).toEqual({ checked: 2, delivered: 0, failed: 0, skipped: 0 })
    expect(mockSendPush).not.toHaveBeenCalled()
    // 실패 후에도 []가 캐시되어 두 번째 deliver에서 재조회하지 않음
    expect(db.prepares.filter((s) => s.includes('FROM push_subscriptions'))).toHaveLength(1)
  })

  test('구독이 없으면 발송 없이 runDueCronJobs 결과를 반환한다', async () => {
    const db = new MockDb()
    db.allQueue.push({ results: [] })
    mockRunDueCronJobs.mockImplementationOnce(async (_env: any, deliver: (job: any, text: string) => Promise<void>) => {
      await deliver({ id: 1, action: 'morning-briefing' }, '오늘 브리핑')
      return { checked: 1, delivered: 0, failed: 0, skipped: 0 }
    })
    const r = await handleCronJobs(envWith(db))
    expect(r).toEqual({ checked: 1, delivered: 0, failed: 0, skipped: 0 })
    expect(mockSendPush).not.toHaveBeenCalled()
  })

  test('구독 results가 null이면 빈 배열로 처리한다', async () => {
    const db = new MockDb()
    db.allQueue.push({ results: null })
    mockRunDueCronJobs.mockImplementationOnce(async (_env: any, deliver: (job: any, text: string) => Promise<void>) => {
      await deliver({ id: 1, action: 'morning-briefing' }, '오늘 브리핑')
      return { checked: 1, delivered: 0, failed: 0, skipped: 0 }
    })
    const r = await handleCronJobs(envWith(db))
    expect(r).toEqual({ checked: 1, delivered: 0, failed: 0, skipped: 0 })
    expect(mockSendPush).not.toHaveBeenCalled()
  })
})

describe('handleGoogleSync', () => {
  test('syncGoogleNow 결과를 그대로 반환한다 (fetch + env 전달)', async () => {
    mockSyncGoogleNow.mockResolvedValue({ ran: true, calendarCount: 2, unreadCount: 3 })
    const env = envWith(new MockDb())
    const r = await handleGoogleSync(env)
    expect(r).toEqual({ ran: true, calendarCount: 2, unreadCount: 3 })
    expect(mockSyncGoogleNow).toHaveBeenCalledTimes(1)
    expect(mockSyncGoogleNow.mock.calls[0][0]).toBe(fetch)
    expect(mockSyncGoogleNow.mock.calls[0][1]).toBe(env)
  })

  test('syncGoogleNow throw 시 { ran:false, reason:"error" }를 반환한다', async () => {
    mockSyncGoogleNow.mockRejectedValueOnce(new Error('google down'))
    const r = await handleGoogleSync(envWith(new MockDb()))
    expect(r).toEqual({ ran: false, reason: 'error' })
  })
})

describe('handleSleepConsolidation', () => {
  test('수면 시간(03시)이 아니면 not_sleep_window로 건너뛴다', async () => {
    mockKstParts.mockReturnValue({ date: '2026-10-26', hour: 10 })
    const r = await handleSleepConsolidation(envWith(new MockDb()), new Date('2026-10-26T01:00:00Z'))
    expect(r).toEqual({ ran: false, reason: 'not_sleep_window' })
    expect(mockGetLastConsolidationDate).not.toHaveBeenCalled()
    expect(mockRunSleepConsolidation).not.toHaveBeenCalled()
  })

  test('오늘 이미 실행했으면 already_ran_today로 건너뛴다', async () => {
    mockKstParts.mockReturnValue({ date: '2026-10-26', hour: 3 })
    mockGetLastConsolidationDate.mockResolvedValue('2026-10-26')
    const r = await handleSleepConsolidation(envWith(new MockDb()), new Date('2026-10-25T18:00:00Z'))
    expect(r).toEqual({ ran: false, reason: 'already_ran_today' })
    expect(mockRunSleepConsolidation).not.toHaveBeenCalled()
    expect(mockMarkConsolidationRun).not.toHaveBeenCalled()
  })

  test('통합 실행 실패(ok:false) → run_failed + stats 반환, 마커 기록 안 함', async () => {
    const stats = { ok: false, ran: false, merged: 0, contradictions: 0, summarized: 0, skipped: 0, error: 'db down' }
    mockRunSleepConsolidation.mockResolvedValueOnce(stats)
    const r = await handleSleepConsolidation(envWith(new MockDb()), new Date('2026-10-25T18:00:00Z'))
    expect(r).toEqual({ ran: false, reason: 'run_failed', stats })
    expect(mockMarkConsolidationRun).not.toHaveBeenCalled()
  })

  test('성공(ran:true) → 마커 기록 후 ran:true + stats 반환', async () => {
    const stats = { ok: true, ran: true, merged: 2, contradictions: 1, summarized: 0, skipped: 0 }
    mockRunSleepConsolidation.mockResolvedValueOnce(stats)
    const env = envWith(new MockDb())
    const now = new Date('2026-10-25T18:00:00Z')
    const r = await handleSleepConsolidation(env, now)
    expect(r).toEqual({ ran: true, stats })
    expect(mockRunSleepConsolidation).toHaveBeenCalledWith(env, { now })
    expect(mockMarkConsolidationRun).toHaveBeenCalledWith(env, '2026-10-26')
  })

  test('성공이지만 ran:false(v2 OFF 등) → 마커 기록 없이 ran:false 반환', async () => {
    const stats = { ok: true, ran: false, merged: 0, contradictions: 0, summarized: 0, skipped: 0, reason: 'v2 disabled' }
    mockRunSleepConsolidation.mockResolvedValueOnce(stats)
    const r = await handleSleepConsolidation(envWith(new MockDb()), new Date('2026-10-25T18:00:00Z'))
    expect(r).toEqual({ ran: false, stats })
    expect(mockMarkConsolidationRun).not.toHaveBeenCalled()
  })

  test('마커 조회 throw 시 fail-soft로 error를 반환한다', async () => {
    mockGetLastConsolidationDate.mockRejectedValueOnce(new Error('db down'))
    const r = await handleSleepConsolidation(envWith(new MockDb()), new Date('2026-10-25T18:00:00Z'))
    expect(r).toEqual({ ran: false, reason: 'error' })
    expect(mockRunSleepConsolidation).not.toHaveBeenCalled()
  })

  test('now 인자 없이 호출하면 현재 시각으로 kstParts를 부른다', async () => {
    mockKstParts.mockReturnValue({ date: '2026-10-26', hour: 10 })
    const r = await handleSleepConsolidation(envWith(new MockDb()))
    expect(r).toEqual({ ran: false, reason: 'not_sleep_window' })
    expect(mockKstParts).toHaveBeenCalledTimes(1)
    expect(mockKstParts.mock.calls[0][0]).toBeInstanceOf(Date)
  })

  test('CONSOLIDATION_HOUR_KST는 3이다', () => {
    expect(CONSOLIDATION_HOUR_KST).toBe(3)
  })
})
