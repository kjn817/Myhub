/// <reference types="jest" />
/**
 * src/scheduled.ts 성질 테스트 (3차 배치 — 잔여 상태 분기).
 * core-scheduled-cov와 겹치지 않는 영역: 워크플로 경로의 상태 산출
 * (no_recipient/partial/failed), cron-jobs의 subscriptions 폴백과 상태 조합,
 * google-sync의 reason별 상태, 수면 통합 detail의 ?? 폴백,
 * 그리고 handleLogPrune 전체(창 판정·중복 방지·부분 오류 시 마커 미기록).
 * 카나리아: 부분 오류에서 markPruneRun을 부르게 바꾸면 마커 단언이,
 * 워크플로 상태식을 바꾸면 cron-health 기록 단언이 실패한다.
 */
import {
  handleScheduled,
  handleCronJobs,
  handleGoogleSync,
  handleSleepConsolidation,
  handleLogPrune,
} from '../../src/scheduled'
import { isPushConfigured, sendPushNotification } from '../../src/services/push'
import { isWorkflowReminderEnabled, runReminderTick } from '../../src/services/reminder-workflow'
import { runDueCronJobs } from '../../src/services/cron-jobs'
import { syncGoogleNow, recordGoogleSyncLog } from '../../src/services/google-sync'
import { kstParts, getLastConsolidationDate, runSleepConsolidation, markConsolidationRun } from '../../src/services/memory-consolidation'
import { runLogPrune, getLastPruneDate, markPruneRun } from '../../src/services/log-prune'
import { cleanupApprovalRequests } from '../../src/services/approval-flow'

jest.mock('../../src/services/push', () => ({
  isPushConfigured: jest.fn(),
  sendPushNotification: jest.fn(),
}))
jest.mock('../../src/services/reminder-workflow', () => ({
  isWorkflowReminderEnabled: jest.fn(),
  runReminderTick: jest.fn(),
  fmtTimeKST: (startAt: string) => startAt.slice(11, 16) || '',
}))
jest.mock('../../src/services/cron-jobs', () => ({ runDueCronJobs: jest.fn() }))
jest.mock('../../src/services/google-sync', () => ({
  syncGoogleNow: jest.fn(),
  recordGoogleSyncLog: jest.fn(),
}))
jest.mock('../../src/services/memory-consolidation', () => ({
  CONSOLIDATION_HOUR_KST: 3,
  kstParts: jest.fn(),
  getLastConsolidationDate: jest.fn(),
  markConsolidationRun: jest.fn(),
  runSleepConsolidation: jest.fn(),
}))
jest.mock('../../src/services/log-prune', () => ({
  PRUNE_WEEKDAY_KST: 0,
  PRUNE_HOUR_KST: 4,
  runLogPrune: jest.fn(),
  getLastPruneDate: jest.fn(),
  markPruneRun: jest.fn(),
}))
jest.mock('../../src/services/approval-flow', () => ({ cleanupApprovalRequests: jest.fn() }))

const mockIsPushConfigured = isPushConfigured as jest.Mock
const mockSendPush = sendPushNotification as jest.Mock
const mockIsWorkflow = isWorkflowReminderEnabled as jest.Mock
const mockRunReminderTick = runReminderTick as jest.Mock
const mockRunDueCronJobs = runDueCronJobs as jest.Mock
const mockSyncGoogleNow = syncGoogleNow as jest.Mock
const mockRecordGoogleLog = recordGoogleSyncLog as jest.Mock
const mockKstParts = kstParts as jest.Mock
const mockGetLastConsolidation = getLastConsolidationDate as jest.Mock
const mockRunSleep = runSleepConsolidation as jest.Mock
const mockMarkConsolidation = markConsolidationRun as jest.Mock
const mockRunLogPrune = runLogPrune as jest.Mock
const mockGetLastPrune = getLastPruneDate as jest.Mock
const mockMarkPrune = markPruneRun as jest.Mock
const mockCleanup = cleanupApprovalRequests as jest.Mock

class MockDb {
  allQueue: any[] = []
  prepares: string[] = []
  binds: any[][] = []
  subCount: number | null = 0

  prepare(sql: string) {
    this.prepares.push(sql)
    const db = this
    const stmt: any = {
      bind(...params: any[]) {
        db.binds.push(params)
        return stmt
      },
      all: async () => {
        const v = db.allQueue.shift()
        if (v instanceof Error) throw v
        return v ?? { results: [] }
      },
      first: async () => {
        if (sql.includes('COUNT(*)') && sql.includes('push_subscriptions')) {
          return db.subCount === null ? null : { n: db.subCount }
        }
        return null
      },
      run: async () => ({ meta: { changes: 1 } }),
    }
    return stmt
  }
}

/** recordCronRun이 ai_settings에 쓴 store JSON에서 handler 상태를 꺼낸다 */
function recordedStatus(db: MockDb, handler: string): { status: string; detail: string } {
  for (let i = db.binds.length - 1; i >= 0; i--) {
    const args = db.binds[i]
    if (typeof args[1] === 'string' && args[1].includes(handler)) {
      const store = JSON.parse(args[1])
      const h = store.handlers[handler]
      if (h) return { status: h.status, detail: h.detail }
    }
  }
  throw new Error(`no cron record for ${handler}`)
}

const envWith = (db: MockDb): any => ({ DB: db })
const SUNDAY_4AM = { date: '2026-10-25', hour: 4 } // 2026-10-25는 일요일

beforeEach(() => {
  jest.clearAllMocks()
  mockIsPushConfigured.mockReturnValue(true)
  mockIsWorkflow.mockReturnValue(false)
  mockKstParts.mockReturnValue(SUNDAY_4AM)
  mockGetLastPrune.mockResolvedValue(null)
  mockRunLogPrune.mockResolvedValue({
    tables: [{ table: 'ai_usage', deleted: 5, capped: false }],
    rateLimitsDeleted: 2,
    totalDeleted: 7,
  })
  mockCleanup.mockResolvedValue({ skipped: false, expired: 1, deleted: 2 })
  mockGetLastConsolidation.mockResolvedValue(null)
})

describe('handleScheduled 워크플로 경로 — 상태 산출', () => {
  beforeEach(() => mockIsWorkflow.mockReturnValue(true))

  test('checked>0·발송 0·실패 0 + 구독 0이면 no_recipient로 기록한다', async () => {
    mockRunReminderTick.mockResolvedValue({ checked: 2, sent: 0, failed: 0 })
    const db = new MockDb()
    db.subCount = 0
    const r = await handleScheduled(envWith(db))
    expect(r).toEqual({ checked: 2, sent: 0, failed: 0 })
    const rec = recordedStatus(db, 'schedule-push')
    expect(rec.status).toBe('no_recipient')
    expect(rec.detail).toContain('전달 대상 없음 (workflow 경로)')
  })

  test('checked>0·발송 0·실패 0이라도 구독이 있으면 ok다', async () => {
    mockRunReminderTick.mockResolvedValue({ checked: 2, sent: 0, failed: 0 })
    const db = new MockDb()
    db.subCount = 3
    await handleScheduled(envWith(db))
    expect(recordedStatus(db, 'schedule-push').status).toBe('ok')
  })

  test('실패가 있고 일부 성공했으면 partial, 전부 실패면 failed (구독 조회 없음)', async () => {
    mockRunReminderTick.mockResolvedValueOnce({ checked: 2, sent: 1, failed: 1 })
    const db1 = new MockDb()
    await handleScheduled(envWith(db1))
    expect(recordedStatus(db1, 'schedule-push').status).toBe('partial')
    expect(db1.prepares.some((s) => s.includes('COUNT(*)'))).toBe(false)

    mockRunReminderTick.mockResolvedValueOnce({ checked: 2, sent: 0, failed: 2 })
    const db2 = new MockDb()
    await handleScheduled(envWith(db2))
    expect(recordedStatus(db2, 'schedule-push').status).toBe('failed')
  })

  test('checked=0이면 구독을 조회하지 않고 ok로 기록한다', async () => {
    mockRunReminderTick.mockResolvedValue({ checked: 0, sent: 0, failed: 0 })
    const db = new MockDb()
    await handleScheduled(envWith(db))
    expect(recordedStatus(db, 'schedule-push').status).toBe('ok')
    expect(db.prepares.some((s) => s.includes('COUNT(*)'))).toBe(false)
  })
})

describe('handleCronJobs — subscriptions 폴백과 상태 조합', () => {
  test('전달 콜백이 한 번도 불리지 않으면 countPushSubscriptions로 구독 수를 센다', async () => {
    mockRunDueCronJobs.mockResolvedValue({ checked: 0, delivered: 0, failed: 0, skipped: 0 })
    const db = new MockDb()
    db.subCount = 2
    const r = await handleCronJobs(envWith(db))
    expect(r).toEqual({ checked: 0, delivered: 0, failed: 0, skipped: 0 })
    expect(db.prepares.some((s) => s.includes('COUNT(*)'))).toBe(true)
    expect(recordedStatus(db, 'cron-jobs').status).toBe('ok')
  })

  test('작업 실패가 있고 일부 전달됐으면 partial, 전달 0이면 failed', async () => {
    const db1 = new MockDb()
    db1.allQueue.push({ results: [{ endpoint: 'https://push/a', p256dh: 'k', auth: 'a' }] })
    mockSendPush.mockResolvedValue({ ok: true })
    mockRunDueCronJobs.mockImplementationOnce(async (_e: any, deliver: any) => {
      await deliver({ id: 1, action: 'news-summary' }, '요약')
      return { checked: 1, delivered: 1, failed: 1, skipped: 0 }
    })
    await handleCronJobs(envWith(db1))
    expect(recordedStatus(db1, 'cron-jobs').status).toBe('partial')

    const db2 = new MockDb()
    db2.allQueue.push({ results: [{ endpoint: 'https://push/a', p256dh: 'k', auth: 'a' }] })
    mockSendPush.mockResolvedValue({ ok: false })
    mockRunDueCronJobs.mockImplementationOnce(async (_e: any, deliver: any) => {
      await deliver({ id: 1, action: 'news-summary' }, '요약')
      return { checked: 1, delivered: 0, failed: 1, skipped: 0 }
    })
    await handleCronJobs(envWith(db2))
    expect(recordedStatus(db2, 'cron-jobs').status).toBe('failed')
  })

  test('구독이 없어 전달할 수 없는 작업만 있으면 no_recipient다', async () => {
    const db = new MockDb()
    db.allQueue.push({ results: [] })
    mockRunDueCronJobs.mockImplementationOnce(async (_e: any, deliver: any) => {
      await deliver({ id: 3, action: 'morning-briefing' }, '브리핑')
      return { checked: 1, delivered: 0, failed: 0, skipped: 0 }
    })
    await handleCronJobs(envWith(db))
    const rec = recordedStatus(db, 'cron-jobs')
    expect(rec.status).toBe('no_recipient')
    expect(rec.detail).toContain('작업 1건')
    expect(mockSendPush).not.toHaveBeenCalled()
  })
})

describe('handleGoogleSync — reason별 상태 매핑', () => {
  test.each([
    ['not_connected', 'skipped'],
    ['too_soon', 'skipped'],
    ['token_expired', 'failed'],
  ])('ran=false reason=%s이면 %s로 기록한다', async (reason, expected) => {
    mockSyncGoogleNow.mockResolvedValue({ ran: false, reason })
    const db = new MockDb()
    const r = await handleGoogleSync(envWith(db))
    expect(r).toEqual({ ran: false, reason })
    const rec = recordedStatus(db, 'google-sync')
    expect(rec.status).toBe(expected)
    expect(rec.detail).toBe(`reason=${reason}`)
  })

  test('ran=true인데 건수가 없으면 0으로 기록한다', async () => {
    mockSyncGoogleNow.mockResolvedValue({ ran: true })
    const db = new MockDb()
    await handleGoogleSync(envWith(db))
    const rec = recordedStatus(db, 'google-sync')
    expect(rec.status).toBe('ok')
    expect(rec.detail).toBe('calendar=0 unread=0')
  })

  test('동기화 로그 기록까지 실패해도 fail-soft로 error를 반환한다', async () => {
    mockSyncGoogleNow.mockRejectedValue(new Error('sync down'))
    mockRecordGoogleLog.mockRejectedValue(new Error('log down'))
    const db = new MockDb()
    const r = await handleGoogleSync(envWith(db))
    expect(r).toEqual({ ran: false, reason: 'error' })
    expect(recordedStatus(db, 'google-sync').status).toBe('failed')
  })
})

describe('handleSleepConsolidation — detail 폴백', () => {
  beforeEach(() => mockKstParts.mockReturnValue({ date: '2026-10-26', hour: 3 }))

  test('run_failed에서 error가 없으면 reason을, 둘 다 없으면 기본 문구를 쓴다', async () => {
    mockRunSleep.mockResolvedValueOnce({ ok: false, ran: false, reason: 'v2_off' })
    const db1 = new MockDb()
    const r1 = await handleSleepConsolidation(envWith(db1), new Date())
    expect(r1.reason).toBe('run_failed')
    expect(recordedStatus(db1, 'sleep-consolidation').detail).toBe('run_failed: v2_off')

    mockRunSleep.mockResolvedValueOnce({ ok: false, ran: false })
    const db2 = new MockDb()
    await handleSleepConsolidation(envWith(db2), new Date())
    expect(recordedStatus(db2, 'sleep-consolidation').detail).toBe('run_failed: consolidation_failed')
  })

  test('성공 통계의 결측 필드는 0으로, 미실행 사유 결측은 빈 문자열로 기록한다', async () => {
    mockRunSleep.mockResolvedValueOnce({ ok: true, ran: true })
    const db1 = new MockDb()
    await handleSleepConsolidation(envWith(db1), new Date())
    expect(recordedStatus(db1, 'sleep-consolidation').detail).toBe('merged=0 summarized=0 skipped=0')
    expect(mockMarkConsolidation).toHaveBeenCalled()

    mockRunSleep.mockResolvedValueOnce({ ok: true, ran: false })
    const db2 = new MockDb()
    await handleSleepConsolidation(envWith(db2), new Date())
    expect(recordedStatus(db2, 'sleep-consolidation').detail).toBe('not_ran: ')
  })
})

describe('handleLogPrune — 창·중복·부분 오류·성공 기록', () => {
  test('요일이 다르면 창 밖 — runLogPrune을 부르지 않는다', async () => {
    mockKstParts.mockReturnValue({ date: '2026-10-26', hour: 4 }) // 월요일
    const r = await handleLogPrune(envWith(new MockDb()), new Date())
    expect(r.reason).toBe('not_prune_window')
    expect(r.ran).toBe(false)
    expect(mockRunLogPrune).not.toHaveBeenCalled()
  })

  test('일요일이라도 시각이 다르면 창 밖이다', async () => {
    mockKstParts.mockReturnValue({ date: '2026-10-25', hour: 5 })
    const r = await handleLogPrune(envWith(new MockDb()), new Date())
    expect(r.reason).toBe('not_prune_window')
    expect(mockRunLogPrune).not.toHaveBeenCalled()
  })

  test('오늘 이미 실행했으면 already_ran_today로 건너뛴다', async () => {
    mockGetLastPrune.mockResolvedValue('2026-10-25')
    const r = await handleLogPrune(envWith(new MockDb()), new Date())
    expect(r.reason).toBe('already_ran_today')
    expect(mockRunLogPrune).not.toHaveBeenCalled()
    expect(mockMarkPrune).not.toHaveBeenCalled()
  })

  test('성공: 마커를 기록하고 capped·승인 정리 상세를 남긴다', async () => {
    mockRunLogPrune.mockResolvedValue({
      tables: [
        { table: 'ai_usage', deleted: 5, capped: true },
        { table: 'cron_runs', deleted: 2, capped: false },
      ],
      rateLimitsDeleted: 3,
      totalDeleted: 10,
    })
    const db = new MockDb()
    const env = envWith(db)
    const r = await handleLogPrune(env, new Date())
    expect(r).toEqual({
      ran: true,
      tables: [
        { table: 'ai_usage', deleted: 5, capped: true },
        { table: 'cron_runs', deleted: 2, capped: false },
      ],
      rateLimitsDeleted: 3,
      totalDeleted: 10,
    })
    expect(mockMarkPrune).toHaveBeenCalledWith(env, '2026-10-25')
    const rec = recordedStatus(db, 'log-prune')
    expect(rec.status).toBe('ok')
    expect(rec.detail).toContain('approval_cleanup=expired:1 deleted:2')
    expect(rec.detail).toContain('capped=ai_usage')
  })

  test('성공: 승인 정리가 skipped면 그 사실을 기록하고 capped가 없으면 언급하지 않는다', async () => {
    mockCleanup.mockResolvedValue({ skipped: true, expired: 0, deleted: 0 })
    const db = new MockDb()
    await handleLogPrune(envWith(db), new Date())
    const rec = recordedStatus(db, 'log-prune')
    expect(rec.detail).toContain('approval_cleanup=skipped')
    expect(rec.detail).not.toContain('capped=')
  })

  test('테이블 오류가 있으면 partial_error — 마커를 기록하지 않아 다음 창에서 재시도된다', async () => {
    mockRunLogPrune.mockResolvedValue({
      tables: [{ table: 'ai_usage', deleted: 0, capped: false, error: 'no such table' }],
      rateLimitsDeleted: 0,
      totalDeleted: 0,
    })
    const db = new MockDb()
    const r = await handleLogPrune(envWith(db), new Date())
    expect(r.reason).toBe('partial_error')
    expect(mockMarkPrune).not.toHaveBeenCalled()
    const rec = recordedStatus(db, 'log-prune')
    expect(rec.status).toBe('failed')
    expect(rec.detail).toContain('ai_usage: no such table')
  })

  test('rate_limits 오류와 승인 정리 예외도 partial_error로 합쳐진다', async () => {
    mockRunLogPrune.mockResolvedValue({
      tables: [],
      rateLimitsDeleted: 0,
      totalDeleted: 0,
      rateLimitsError: 'rl down',
    })
    mockCleanup.mockRejectedValue(new Error('cleanup down'))
    const r = await handleLogPrune(envWith(new MockDb()), new Date())
    expect(r.reason).toBe('partial_error')
    expect(mockMarkPrune).not.toHaveBeenCalled()
  })

  test('runLogPrune 자체가 던지면 fail-soft로 error를 반환한다', async () => {
    mockRunLogPrune.mockRejectedValue(new Error('prune down'))
    const r = await handleLogPrune(envWith(new MockDb()), new Date())
    expect(r).toEqual({ ran: false, tables: [], rateLimitsDeleted: 0, totalDeleted: 0, reason: 'error' })
  })

  test('now를 생략하면 현재 시각으로 창을 판정한다', async () => {
    const r = await handleLogPrune(envWith(new MockDb()))
    expect(mockKstParts).toHaveBeenCalledTimes(1)
    expect(mockKstParts.mock.calls[0][0]).toBeInstanceOf(Date)
    expect(r.ran).toBe(true)
  })
})
