/// <reference types="jest" />
/**
 * src/services/decrypt-health-handler.ts — 주간 점검 스케줄 게이트 성질 테스트.
 *
 * 핸들러 자체의 로직(실행 창 판정·중복 실행 방지·결과 기록 문구·예외 시
 * 실패 기록)만 검증한다. 의존 모듈은 경계에서 mock한다 — 각 모듈의 내부
 * 동작은 자체 테스트가 담당한다.
 * 카나리아: 실행 창 조건에서 요일 검사를 빼거나 already_ran 비교를 지우면
 * 실패한다.
 */
jest.mock('../../src/services/memory-consolidation', () => ({ kstParts: jest.fn() }))
jest.mock('../../src/services/cron-health', () => ({ recordCronRun: jest.fn(async () => {}) }))
jest.mock('../../src/services/decrypt-health', () => ({
  getLastDecryptHealthDate: jest.fn(async () => null),
  markDecryptHealthRun: jest.fn(async () => {}),
  recordDecryptHealth: jest.fn(async () => {}),
  runDecryptHealthCheck: jest.fn(),
}))
jest.mock('../../src/modules/backup/status', () => ({
  recordBackupFreshnessCheck: jest.fn(async () => ({ exists: true, stale: false, ageDays: 3 })),
}))

import { handleDecryptHealth } from '../../src/services/decrypt-health-handler'
import { kstParts } from '../../src/services/memory-consolidation'
import { recordCronRun } from '../../src/services/cron-health'
import {
  getLastDecryptHealthDate,
  runDecryptHealthCheck,
  type DecryptHealthEnv,
  type DecryptHealthReport,
} from '../../src/services/decrypt-health'
import { recordBackupFreshnessCheck } from '../../src/modules/backup/status'

const mockKst = kstParts as jest.Mock
const mockRecord = recordCronRun as unknown as jest.Mock
const mockLast = getLastDecryptHealthDate as unknown as jest.Mock
const mockRun = runDecryptHealthCheck as unknown as jest.Mock
const mockBackup = recordBackupFreshnessCheck as unknown as jest.Mock

const ENV = { DB: {} } as unknown as DecryptHealthEnv
const NOW = new Date('2026-11-07T19:00:00.000Z')
// 2026-11-08은 일요일(UTC 요일 0) — 실행 창: 일요일 KST 04시
const WINDOW = { date: '2026-11-08', hour: 4 }

const REPORT: DecryptHealthReport = {
  at: NOW.toISOString(),
  ok: true,
  memoText: { total: 4, ok: 4, failed: 0 },
  memoBlock: { total: 3, ok: 3, failed: 0 },
  googleAccess: { total: 2, ok: 2, failed: 0 },
  googleRefresh: { total: 1, ok: 1, failed: 0 },
  lockedFiles: { total: 7, checked: false },
  totalChecked: 10,
  totalFailed: 0,
}

beforeEach(() => {
  jest.clearAllMocks()
  mockLast.mockResolvedValue(null)
  mockRun.mockResolvedValue(REPORT)
  mockBackup.mockResolvedValue({ exists: true, stale: false, ageDays: 3 })
})

function lastRecordOutcome() {
  const calls = mockRecord.mock.calls
  return calls[calls.length - 1]?.[2] as { status: string; detail: string; counts: unknown }
}

describe('handleDecryptHealth — 실행 창 게이트', () => {
  test('창이 아니면(시각) skipped로 기록하고 실행하지 않는다', async () => {
    mockKst.mockReturnValue({ date: '2026-11-08', hour: 5 })
    await expect(handleDecryptHealth(ENV, NOW)).resolves.toEqual({ ran: false, reason: 'not_health_window' })
    expect(mockRun).not.toHaveBeenCalled()
    expect(lastRecordOutcome()).toMatchObject({ status: 'skipped', detail: 'not_health_window' })
  })

  test('창이 아니면(요일) 동일하게 건너뛴다', async () => {
    mockKst.mockReturnValue({ date: '2026-11-09', hour: 4 }) // 월요일
    await expect(handleDecryptHealth(ENV, NOW)).resolves.toEqual({ ran: false, reason: 'not_health_window' })
    expect(mockRun).not.toHaveBeenCalled()
  })

  test('오늘 이미 실행했으면 다시 실행하지 않는다', async () => {
    mockKst.mockReturnValue(WINDOW)
    mockLast.mockResolvedValue('2026-11-08')
    await expect(handleDecryptHealth(ENV, NOW)).resolves.toEqual({ ran: false, reason: 'already_ran_today' })
    expect(mockRun).not.toHaveBeenCalled()
    expect(lastRecordOutcome()).toMatchObject({ status: 'skipped', detail: 'already_ran_today' })
  })
})

describe('handleDecryptHealth — 실행과 기록', () => {
  test('정상 실행: 보고서 수치와 백업 상태가 detail에 기록된다', async () => {
    mockKst.mockReturnValue(WINDOW)
    await expect(handleDecryptHealth(ENV, NOW)).resolves.toEqual({ ran: true, failed: 0 })
    const outcome = lastRecordOutcome()
    expect(outcome.status).toBe('ok')
    expect(outcome.detail).toContain('checked=10 failed=0')
    expect(outcome.detail).toContain('memo_text=0/4')
    expect(outcome.detail).toContain('google=0/3')
    expect(outcome.detail).toContain('locked_files_counted=7(unchecked)')
    expect(outcome.detail).toContain('backup_exists=true backup_stale=false backup_age_days=3')
    expect(outcome.counts).toEqual({ checked: 10, delivered: 0, failed: 0, skipped: 0 })
  })

  test('복호화 실패가 있으면 status=failed로 기록하고 실패 수를 반환한다', async () => {
    mockKst.mockReturnValue(WINDOW)
    mockRun.mockResolvedValue({ ...REPORT, ok: false, totalFailed: 2 })
    await expect(handleDecryptHealth(ENV, NOW)).resolves.toEqual({ ran: true, failed: 2 })
    expect(lastRecordOutcome().status).toBe('failed')
  })

  test('백업 신선도 기록이 실패해도 점검 자체는 성공으로 남고 오류가 detail에 붙는다', async () => {
    mockKst.mockReturnValue(WINDOW)
    mockBackup.mockRejectedValue(new Error('bk fail'))
    await expect(handleDecryptHealth(ENV, NOW)).resolves.toEqual({ ran: true, failed: 0 })
    expect(lastRecordOutcome().detail).toContain('backup_freshness_error=bk fail')
  })

  test('백업 ageDays가 null이면 none으로 기록된다', async () => {
    mockKst.mockReturnValue(WINDOW)
    mockBackup.mockResolvedValue({ exists: false, stale: true, ageDays: null })
    await handleDecryptHealth(ENV, NOW)
    expect(lastRecordOutcome().detail).toContain('backup_age_days=none')
  })

  test('점검 자체가 throw하면 failed로 기록하고 error를 반환한다', async () => {
    mockKst.mockReturnValue(WINDOW)
    mockRun.mockRejectedValue(new Error('db exploded'))
    await expect(handleDecryptHealth(ENV, NOW)).resolves.toEqual({ ran: false, reason: 'error' })
    const outcome = lastRecordOutcome()
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toBe('exception: db exploded')
  })
})
