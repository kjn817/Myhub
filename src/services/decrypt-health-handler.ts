import { recordBackupFreshnessCheck } from '../modules/backup/status'
import { recordCronRun } from './cron-health'
import {
  getLastDecryptHealthDate,
  markDecryptHealthRun,
  recordDecryptHealth,
  runDecryptHealthCheck,
  type DecryptHealthEnv,
} from './decrypt-health'
import { PRUNE_HOUR_KST, PRUNE_WEEKDAY_KST } from './log-prune'
import { kstParts } from './memory-consolidation'

function errMsg(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 200)
}

export async function handleDecryptHealth(
  env: DecryptHealthEnv,
  now: Date = new Date(),
): Promise<{ ran: boolean; reason?: string; failed?: number }> {
  try {
    const kst = kstParts(now)
    const weekday = new Date(`${kst.date}T00:00:00Z`).getUTCDay()
    if (weekday !== PRUNE_WEEKDAY_KST || kst.hour !== PRUNE_HOUR_KST) {
      await recordCronRun(env, 'decrypt-health', {
        status: 'skipped',
        detail: 'not_health_window',
        counts: { checked: 0, delivered: 0, failed: 0, skipped: 0 },
        at: now,
      })
      return { ran: false, reason: 'not_health_window' }
    }
    const lastRun = await getLastDecryptHealthDate(env)
    if (lastRun === kst.date) {
      await recordCronRun(env, 'decrypt-health', {
        status: 'skipped',
        detail: 'already_ran_today',
        counts: { checked: 0, delivered: 0, failed: 0, skipped: 0 },
        at: now,
      })
      return { ran: false, reason: 'already_ran_today' }
    }
    const report = await runDecryptHealthCheck(env, now)
    await recordDecryptHealth(env, report)
    await markDecryptHealthRun(env, kst.date)
    let backupDetail = ''
    try {
      const check = await recordBackupFreshnessCheck(env as any, now)
      backupDetail = ` backup_exists=${check.exists} backup_stale=${check.stale} backup_age_days=${check.ageDays ?? 'none'}`
    } catch (e) {
      backupDetail = ` backup_freshness_error=${errMsg(e)}`
    }
    await recordCronRun(env, 'decrypt-health', {
      status: report.ok ? 'ok' : 'failed',
      detail:
        `checked=${report.totalChecked} failed=${report.totalFailed} memo_text=${report.memoText.failed}/${report.memoText.total} memo_block=${report.memoBlock.failed}/${report.memoBlock.total} google=${report.googleAccess.failed + report.googleRefresh.failed}/${report.googleAccess.total + report.googleRefresh.total} locked_files_counted=${report.lockedFiles.total}(unchecked)` +
        backupDetail,
      counts: { checked: report.totalChecked, delivered: 0, failed: report.totalFailed, skipped: 0 },
      at: now,
    })
    return { ran: true, failed: report.totalFailed }
  } catch (e) {
    await recordCronRun(env, 'decrypt-health', {
      status: 'failed',
      detail: `exception: ${errMsg(e)}`,
      counts: { checked: 0, delivered: 0, failed: 0, skipped: 0 },
      at: now,
    })
    return { ran: false, reason: 'error' }
  }
}
