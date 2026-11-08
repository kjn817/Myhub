/**
 * Cron 스케줄 핸들러 — 5분마다 실행 (deploy_full.py metadata triggers)
 *
 * 원칙 (Talorys ③-A): 예약 경로는 도구를 제공받지 않으며, AI가 필요하면 persona 없는 capability 호출만 쓴다.
 *
 * - 30분 이내 시작하는 활성 일정을 찾아 Web Push 발송
 * - reminders.dedupe_key 로 중복 발송 방지 (INSERT OR IGNORE 선점)
 * - 만료된 구독(404/410)은 push_subscriptions 에서 삭제
 * - 모든 핸들러는 실행 결과를 cron-health에 기록한다 (recordCronRun) —
 *   "조용한 실패"를 관측 가능하게 만드는 것이 목적이다.
 *
 * 주의: schedules.start_at 은 'YYYY-MM-DDTHH:mm' 형태의 KST wall-clock 문자열로 저장됨.
 * D1의 datetime('now')는 UTC이므로, 예전에는 비교 시 '-9 hours' 로 KST→UTC 보정했으나
 * 컬럼 위 함수라 인덱스가 무력화됐다. 지금은 JS에서 KST 윈도우 문자열을 미리 계산해
 * start_at 범위 조건으로 비교한다 (kstWallClockWindow, src/lib/kst-date.ts).
 * (schedules.timezone 컬럼은 현재 항상 Asia/Seoul 로만 사용됨)
 */

import type { Env } from './types'
import { sendPushNotification, isPushConfigured, type PushSubscription } from './services/push'
import { runDueCronJobs, type CronJob } from './services/cron-jobs'
import { recordCronRun, countPushSubscriptions } from './services/cron-health'
import { isWorkflowReminderEnabled, runReminderTick, fmtTimeKST } from './services/reminder-workflow'
import {
  CONSOLIDATION_HOUR_KST,
  getLastConsolidationDate,
  kstParts,
  markConsolidationRun,
  runSleepConsolidation,
  type ConsolidationStats,
} from './services/memory-consolidation'
import { syncGoogleNow, recordGoogleSyncLog, type SyncResult } from './services/google-sync'
import {
  PRUNE_WEEKDAY_KST,
  PRUNE_HOUR_KST,
  runLogPrune,
  getLastPruneDate,
  markPruneRun,
} from './services/log-prune'
import { cleanupApprovalRequests } from './services/approval-flow'
import { kstWallClockWindow } from './lib/kst-date'

export { handleDecryptHealth } from './services/decrypt-health-handler'

const WINDOW_MINUTES = 30

function errMsg(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 200)
}

interface DueSchedule {
  id: number
  title: string
  start_at: string
  location: string | null
}


export async function handleScheduled(env: Env): Promise<{ checked: number; sent: number; failed: number }> {
  const result = { checked: 0, sent: 0, failed: 0 }
  if (!isPushConfigured(env)) {
    await recordCronRun(env, 'schedule-push', {
      status: 'not_configured',
      detail: 'push_not_configured: VAPID 미설정',
      counts: { checked: 0, delivered: 0, failed: 0, skipped: 0 },
    })
    return result
  }

  // 워크플로 엔진 이식 경로 (플래그 기본 꺼짐 — 기존 경로는 그대로 유지).
  // 활성화: WORKFLOW_REMINDER_ENABLED=true (운영은 0050 적용 후 승인 단계에서).
  if (isWorkflowReminderEnabled(env)) {
    const r = await runReminderTick(env)
    let subscriptions: number | null = null
    if (r.checked > 0 && r.sent === 0 && r.failed === 0) {
      subscriptions = await countPushSubscriptions(env.DB)
    }
    const status = r.failed > 0 ? (r.sent > 0 ? 'partial' : 'failed') : subscriptions === 0 ? 'no_recipient' : 'ok'
    await recordCronRun(env, 'schedule-push', {
      status,
      detail: status === 'no_recipient'
        ? 'push_subscriptions=0: 전달 대상 없음 (workflow 경로)'
        : `workflow 경로 checked=${r.checked} sent=${r.sent} failed=${r.failed}`,
      counts: { checked: r.checked, delivered: r.sent, failed: r.failed, skipped: 0 },
      subscriptions,
    })
    return r
  }

  let due: DueSchedule[] = []
  try {
    // P-3: datetime(start_at, '-9 hours') BETWEEN ... 은 idx_schedules_start를
    // 무력화해 매 5분 전수 스캔한다. KST 윈도우를 문자열 범위로 미리 계산해
    // start_at 범위 조건으로 변경. start_at은 KST wall-clock 문자열이라
    // 초 단위 경계까지 기존 BETWEEN과 동일하다 (kst-date.ts 참조).
    const [winStart, winEnd] = kstWallClockWindow(WINDOW_MINUTES)
    const r = await env.DB.prepare(
      `SELECT id, title, start_at, location
       FROM schedules
       WHERE status = 'active'
         AND start_at >= ? AND start_at <= ?
       ORDER BY start_at ASC
       LIMIT 50`
    ).bind(winStart, winEnd).all<DueSchedule>()
    due = r.results || []
  } catch (e) {
    await recordCronRun(env, 'schedule-push', {
      status: 'failed',
      detail: `schedule_query_error: ${errMsg(e)}`,
      counts: { checked: 0, delivered: 0, failed: 0, skipped: 0 },
    })
    return result
  }
  result.checked = due.length
  if (due.length === 0) {
    await recordCronRun(env, 'schedule-push', {
      status: 'ok',
      detail: 'due 일정 없음',
      counts: { checked: 0, delivered: 0, failed: 0, skipped: 0 },
    })
    return result
  }

  let subs: PushSubscription[] = []
  try {
    const r = await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions').all<PushSubscription>()
    subs = r.results || []
  } catch (e) {
    await recordCronRun(env, 'schedule-push', {
      status: 'failed',
      detail: `subscription_query_error: ${errMsg(e)}`,
      counts: { checked: due.length, delivered: 0, failed: 0, skipped: 0 },
    })
    return result
  }
  if (subs.length === 0) {
    await recordCronRun(env, 'schedule-push', {
      status: 'no_recipient',
      detail: 'push_subscriptions=0: 전달 대상 없음 — 일정 앱에서 알림 재등록 필요',
      counts: { checked: due.length, delivered: 0, failed: 0, skipped: due.length },
      subscriptions: 0,
    })
    return result
  }

  for (const s of due) {
    const dedupeKey = `push:${s.id}:${s.start_at}`
    // 선점: 이미 처리 중/완료된 일정은 건너뜀
    let claimed = false
    try {
      const ins = await env.DB.prepare(
        `INSERT OR IGNORE INTO reminders (schedule_id, remind_at, status, dedupe_key)
         VALUES (?, ?, 'pending', ?)`
      ).bind(s.id, s.start_at, dedupeKey).run()
      claimed = (ins.meta?.changes ?? 0) > 0
    } catch {
      continue
    }
    if (!claimed) continue

    const time = fmtTimeKST(s.start_at)
    const body = `${time ? time + ' ' : ''}${s.title}${s.location ? ' · ' + s.location : ''}`
    let okCount = 0
    let failCount = 0
    for (const sub of subs) {
      const r = await sendPushNotification(
        env, sub,
        { title: '일정 알림', body, url: '/schedule.html', tag: dedupeKey },
        3600
      )
      if (r.ok) {
        okCount++
      } else {
        failCount++
        if (r.gone) {
          // 만료된 구독 정리
          await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
            .bind(sub.endpoint).run().catch(() => {})
        }
      }
    }

    const status = failCount === 0 ? 'sent' : okCount === 0 ? 'failed' : 'sent'
    if (okCount > 0) result.sent++
    if (okCount === 0) result.failed++
    await env.DB.prepare(
      `UPDATE reminders SET status = ?, sent_at = datetime('now') WHERE dedupe_key = ?`
    ).bind(status, dedupeKey).run().catch(() => {})
  }

  await recordCronRun(env, 'schedule-push', {
    status: result.failed > 0 ? (result.sent > 0 ? 'partial' : 'failed') : 'ok',
    detail: `checked=${result.checked} sent=${result.sent} failed=${result.failed}`,
    counts: {
      checked: result.checked,
      delivered: result.sent,
      failed: result.failed,
      skipped: 0,
    },
    subscriptions: subs.length,
  })
  return result
}

/**
 * 자연어 cron 작업 실행 (아침 브리핑 등, Octop 패턴 이식 — 마이그레이션 0047)
 *
 * handleScheduled와는 별개 엔트리로 둔다. 두 핸들러는 각자 자신의 쿼리만
 * 발행하므로, 한쪽의 변경이 다른 쪽의 동작·테스트를 깨지 않는다.
 * index.ts의 scheduled 핸들러가 두 함수를 순서대로 호출한다.
 * - due 판정은 KST wall-clock 기준 (runDueCronJobs가 수행).
 * - 전달 수단은 Web Push. 구독이 없으면 전달할 곳이 없으므로
 *   조용히 건너뛴다 (다음 틱에 재시도하지 않음 — 선점은 유지됨).
 * - 어떤 오류도 호출자를 깨지 않는다 (fail-soft).
 * - 전달 콜백은 작업별 시도/전달/실패 집계를 반환하고, 전체 실행은
 *   cron-health에 기록한다.
 */
export async function handleCronJobs(
  env: Env,
): Promise<{ checked: number; delivered: number; failed: number; skipped: number }> {
  if (!isPushConfigured(env)) {
    await recordCronRun(env, 'cron-jobs', {
      status: 'not_configured',
      detail: 'push_not_configured: VAPID 미설정',
      counts: { checked: 0, delivered: 0, failed: 0, skipped: 0 },
    })
    return { checked: 0, delivered: 0, failed: 0, skipped: 0 }
  }
  try {
    let cachedSubs: PushSubscription[] | null = null
    let subsRequested = false
    let subsKnown: number | null = null
    const totals = { attempted: 0, delivered: 0, failed: 0 }
    let noRecipientJobs = 0
    const getSubs = async (): Promise<PushSubscription[]> => {
      if (cachedSubs) return cachedSubs
      subsRequested = true
      try {
        const r = await env.DB.prepare(
          'SELECT endpoint, p256dh, auth FROM push_subscriptions',
        ).all<PushSubscription>()
        cachedSubs = r.results || []
        subsKnown = cachedSubs.length
      } catch {
        cachedSubs = []
      }
      return cachedSubs
    }
    const result = await runDueCronJobs(
      env,
      async (job: CronJob, text: string) => {
        const subs = await getSubs()
        if (subs.length === 0) {
          noRecipientJobs++
          return { attempted: 0, delivered: 0, failed: 0 }
        }
        let ok = 0
        let fail = 0
        for (const sub of subs) {
          const r = await sendPushNotification(
            env,
            sub,
            {
              title: job.action === 'morning-briefing' ? '아침 브리핑' : 'MyHub 알림',
              body: text,
              url: '/',
              tag: `cron:${job.id}`,
            },
            3600
          )
          totals.attempted++
          if (r.ok) {
            ok++
            totals.delivered++
          } else {
            fail++
            totals.failed++
          }
        }
        return { attempted: subs.length, delivered: ok, failed: fail }
      }
    )
    const subscriptions = subsRequested ? subsKnown : await countPushSubscriptions(env.DB)
    const status = result.failed > 0
      ? (totals.delivered > 0 ? 'partial' : 'failed')
      : noRecipientJobs > 0
        ? (totals.delivered > 0 ? 'partial' : 'no_recipient')
        : 'ok'
    await recordCronRun(env, 'cron-jobs', {
      status,
      detail: status === 'no_recipient'
        ? `push_subscriptions=0: 전달 대상 없음 (작업 ${noRecipientJobs}건)`
        : `checked=${result.checked} delivered=${totals.delivered} failed=${result.failed} skipped=${result.skipped}`,
      counts: {
        checked: result.checked,
        delivered: totals.delivered,
        failed: result.failed,
        skipped: result.skipped,
      },
      subscriptions,
    })
    return result
  } catch (e) {
    await recordCronRun(env, 'cron-jobs', {
      status: 'failed',
      detail: `handler_error: ${errMsg(e)}`,
      counts: { checked: 0, delivered: 0, failed: 0, skipped: 0 },
    })
    return { checked: 0, delivered: 0, failed: 0, skipped: 0 }
  }
}

/**
 * Google 동기화 (진짜 비서 3단계 g트랙) — Cron pull, 30분에 1회.
 *
 * handleScheduled/handleCronJobs와 별개 엔트리로 둔다.
 * - 미연동이면 아무것도 하지 않는다 (not_connected).
 * - 30분 간격은 google-sync 내부의 KV 마커가 제어한다.
 * - 어떤 오류도 호출자를 깨지 않는다 (fail-soft).
 * - 결과는 cron-health에 기록하고, 예외 시에는 google 동기화 로그에도 남긴다.
 */
export async function handleGoogleSync(env: Env): Promise<SyncResult> {
  try {
    const r = await syncGoogleNow(fetch, env)
    await recordCronRun(env, 'google-sync', {
      status: r.ran ? 'ok' : (r.reason === 'not_connected' || r.reason === 'too_soon') ? 'skipped' : 'failed',
      detail: r.ran
        ? `calendar=${r.calendarCount ?? 0} unread=${r.unreadCount ?? 0}`
        : `reason=${r.reason ?? 'unknown'}`,
      counts: { checked: 0, delivered: 0, failed: 0, skipped: 0 },
    })
    return r
  } catch (e) {
    try {
      await recordGoogleSyncLog(env, 'token_refresh', 'failed', 'reason=exception source=scheduled')
    } catch {}
    await recordCronRun(env, 'google-sync', {
      status: 'failed',
      detail: `exception: ${errMsg(e)}`,
      counts: { checked: 0, delivered: 0, failed: 0, skipped: 0 },
    })
    return { ran: false, reason: 'error' }
  }
}

/**
 * 수면 통합 (진짜 비서 2단계 d트랙) — 매일 03:00 KST에 1회 실행.
 *
 * handleScheduled/handleCronJobs와 별개 엔트리로 둔다. Web Push 설정과 무관하게
 * 동작한다 (통합은 전달 수단이 필요 없는 백그라운드 정리 작업).
 * - Cron은 5분마다 틱하므로 03:00~03:59 사이의 첫 틱에서 실행한다.
 * - 하루 1회 중복 실행 방지: ai_settings의 memory.last_consolidation_date
 *   마커가 오늘(KST)이면 건너뛴다. 마커는 성공한 실행 뒤에만 기록한다.
 * - 어떤 오류도 호출자를 깨지 않는다 (fail-soft).
 * - 모든 분기는 cron-health에 기록한다.
 */
export async function handleSleepConsolidation(
  env: Env,
  now: Date = new Date(),
): Promise<{ ran: boolean; reason?: string; stats?: ConsolidationStats }> {
  try {
    const kst = kstParts(now)
    if (kst.hour !== CONSOLIDATION_HOUR_KST) {
      await recordCronRun(env, 'sleep-consolidation', {
        status: 'skipped',
        detail: 'not_sleep_window',
        counts: { checked: 0, delivered: 0, failed: 0, skipped: 0 },
      })
      return { ran: false, reason: 'not_sleep_window' }
    }
    const lastRun = await getLastConsolidationDate(env)
    if (lastRun === kst.date) {
      await recordCronRun(env, 'sleep-consolidation', {
        status: 'skipped',
        detail: 'already_ran_today',
        counts: { checked: 0, delivered: 0, failed: 0, skipped: 0 },
      })
      return { ran: false, reason: 'already_ran_today' }
    }
    const stats = await runSleepConsolidation(env, { now })
    if (!stats.ok) {
      await recordCronRun(env, 'sleep-consolidation', {
        status: 'failed',
        detail: `run_failed: ${(stats as any)?.error ?? (stats as any)?.reason ?? 'consolidation_failed'}`,
        counts: { checked: 0, delivered: 0, failed: 0, skipped: 0 },
      })
      return { ran: false, reason: 'run_failed', stats }
    }
    if (stats.ran) {
      await markConsolidationRun(env, kst.date)
    }
    await recordCronRun(env, 'sleep-consolidation', {
      status: stats.ran ? 'ok' : 'skipped',
      detail: stats.ran
        ? `merged=${(stats as any).merged ?? 0} summarized=${(stats as any).summarized ?? 0} skipped=${(stats as any).skipped ?? 0}`
        : `not_ran: ${(stats as any)?.reason ?? ''}`,
      counts: { checked: 0, delivered: 0, failed: 0, skipped: 0 },
    })
    return { ran: stats.ran, stats }
  } catch (e) {
    await recordCronRun(env, 'sleep-consolidation', {
      status: 'failed',
      detail: `exception: ${errMsg(e)}`,
      counts: { checked: 0, delivered: 0, failed: 0, skipped: 0 },
    })
    return { ran: false, reason: 'error' }
  }
}

/**
 * 로그 정리 (log-prune) — 주 1회, 일요일 04:00 KST 창에서만 실행.
 *
 * - 윈도우·당일 실행 마커로 중복 실행을 막는다 (수면 통합과 같은 패턴).
 * - 오래된 로그 테이블 prune + 만료된 승인 요청 정리를 수행한다.
 * - 부분 오류가 있으면 마커를 기록하지 않고 failed로 남긴다 (다음 창에서 재시도).
 * - 어떤 오류도 호출자를 깨지 않는다 (fail-soft). 모든 분기는 cron-health에 기록한다.
 */
interface LogPruneStats {
  ran: boolean
  tables: { table: string; deleted: number; capped: boolean }[]
  rateLimitsDeleted: number
  totalDeleted: number
}

export async function handleLogPrune(
  env: Env,
  now: Date = new Date(),
): Promise<LogPruneStats & { reason?: string }> {
  const empty: LogPruneStats = { ran: false, tables: [], rateLimitsDeleted: 0, totalDeleted: 0 }
  try {
    const kst = kstParts(now)
    const weekday = new Date(`${kst.date}T00:00:00Z`).getUTCDay()
    if (weekday !== PRUNE_WEEKDAY_KST || kst.hour !== PRUNE_HOUR_KST) {
      await recordCronRun(env, 'log-prune', {
        status: 'skipped',
        detail: 'not_prune_window',
        counts: { checked: 0, delivered: 0, failed: 0, skipped: 0 },
        at: now,
      })
      return { ...empty, reason: 'not_prune_window' }
    }
    const lastRun = await getLastPruneDate(env)
    if (lastRun === kst.date) {
      await recordCronRun(env, 'log-prune', {
        status: 'skipped',
        detail: 'already_ran_today',
        counts: { checked: 0, delivered: 0, failed: 0, skipped: 0 },
        at: now,
      })
      return { ...empty, reason: 'already_ran_today' }
    }
    const r = await runLogPrune(env, now)
    const errors: { table: string; deleted: number; capped: boolean; error: string }[] =
      r.tables.filter((t) => t.error) as { table: string; deleted: number; capped: boolean; error: string }[]
    if (r.rateLimitsError) {
      errors.push({ table: 'rate_limits', deleted: 0, capped: false, error: r.rateLimitsError })
    }
    let cleanup: Awaited<ReturnType<typeof cleanupApprovalRequests>> | null = null
    try {
      cleanup = await cleanupApprovalRequests(env.DB, env, now)
    } catch (e) {
      errors.push({ table: 'tool_approval_requests', deleted: 0, capped: false, error: errMsg(e) })
    }
    const stats: LogPruneStats = {
      ran: true,
      tables: r.tables.map(({ table, deleted, capped }) => ({ table, deleted, capped })),
      rateLimitsDeleted: r.rateLimitsDeleted,
      totalDeleted: r.totalDeleted,
    }
    if (errors.length > 0) {
      await recordCronRun(env, 'log-prune', {
        status: 'failed',
        detail: `prune_partial_error: ${errors.map((t) => `${t.table}: ${t.error}`).join('; ').slice(0, 240)}`,
        counts: { checked: r.tables.length, delivered: 0, failed: errors.length, skipped: 0 },
        at: now,
      })
      return { ...stats, reason: 'partial_error' }
    }
    await markPruneRun(env, kst.date)
    const capped = r.tables.filter((t) => t.capped).map((t) => t.table)
    await recordCronRun(env, 'log-prune', {
      status: 'ok',
      detail: `deleted=${r.totalDeleted} rate_limits=${r.rateLimitsDeleted}` +
        (cleanup ? (cleanup.skipped ? ' approval_cleanup=skipped' : ` approval_cleanup=expired:${cleanup.expired} deleted:${cleanup.deleted}`) : '') +
        (capped.length ? ` capped=${capped.join(',')}` : ''),
      counts: { checked: r.tables.length, delivered: 0, failed: 0, skipped: 0 },
      at: now,
    })
    return stats
  } catch (e) {
    await recordCronRun(env, 'log-prune', {
      status: 'failed',
      detail: `exception: ${errMsg(e)}`,
      counts: { checked: 0, delivered: 0, failed: 0, skipped: 0 },
      at: now,
    })
    return { ...empty, reason: 'error' }
  }
}
