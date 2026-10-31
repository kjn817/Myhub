/**
 * Cron 스케줄 핸들러 — 5분마다 실행 (deploy_full.py metadata triggers)
 *
 * 원칙 (Talorys ③-A): 예약 경로는 도구를 제공받지 않으며, AI가 필요하면 persona 없는 capability 호출만 쓴다.
 *
 * - 30분 이내 시작하는 활성 일정을 찾아 Web Push 발송
 * - reminders.dedupe_key 로 중복 발송 방지 (INSERT OR IGNORE 선점)
 * - 만료된 구독(404/410)은 push_subscriptions 에서 삭제
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
import { isWorkflowReminderEnabled, runReminderTick, fmtTimeKST } from './services/reminder-workflow'
import {
  CONSOLIDATION_HOUR_KST,
  getLastConsolidationDate,
  kstParts,
  markConsolidationRun,
  runSleepConsolidation,
  type ConsolidationStats,
} from './services/memory-consolidation'
import { syncGoogleNow, type SyncResult } from './services/google-sync'
import { kstWallClockWindow } from './lib/kst-date'

const WINDOW_MINUTES = 30

interface DueSchedule {
  id: number
  title: string
  start_at: string
  location: string | null
}

export async function handleScheduled(env: Env): Promise<{ checked: number; sent: number; failed: number }> {
  const result = { checked: 0, sent: 0, failed: 0 }
  if (!isPushConfigured(env)) return result

  // 워크플로 엔진 이식 경로 (플래그 기본 꺼짐 — 기존 경로는 그대로 유지).
  // 활성화: WORKFLOW_REMINDER_ENABLED=true (운영은 0050 적용 후 승인 단계에서).
  if (isWorkflowReminderEnabled(env)) {
    return runReminderTick(env)
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
  } catch {
    return result // 테이블 없음 등 — 조용히 종료
  }
  result.checked = due.length
  if (due.length === 0) return result

  let subs: PushSubscription[] = []
  try {
    const r = await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions').all<PushSubscription>()
    subs = r.results || []
  } catch {
    return result
  }
  if (subs.length === 0) return result

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
 */
export async function handleCronJobs(
  env: Env,
): Promise<{ checked: number; delivered: number; failed: number; skipped: number }> {
  if (!isPushConfigured(env)) return { checked: 0, delivered: 0, failed: 0, skipped: 0 }
  try {
    let cachedSubs: PushSubscription[] | null = null
    const getSubs = async (): Promise<PushSubscription[]> => {
      if (cachedSubs) return cachedSubs
      try {
        const r = await env.DB.prepare(
          'SELECT endpoint, p256dh, auth FROM push_subscriptions',
        ).all<PushSubscription>()
        cachedSubs = r.results || []
      } catch {
        cachedSubs = []
      }
      return cachedSubs
    }
    return await runDueCronJobs(env, async (job: CronJob, text: string) => {
      const subs = await getSubs()
      for (const sub of subs) {
        await sendPushNotification(
          env,
          sub,
          {
            title: job.action === 'morning-briefing' ? '아침 브리핑' : 'MyHub 알림',
            body: text,
            url: '/',
            tag: `cron:${job.id}`,
          },
          3600,
        )
      }
    })
  } catch {
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
 */
export async function handleGoogleSync(env: Env): Promise<SyncResult> {
  try {
    return await syncGoogleNow(fetch, env as any)
  } catch {
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
 */
export async function handleSleepConsolidation(
  env: Env,
  now: Date = new Date(),
): Promise<{ ran: boolean; reason?: string; stats?: ConsolidationStats }> {
  try {
    const kst = kstParts(now)
    if (kst.hour !== CONSOLIDATION_HOUR_KST) {
      return { ran: false, reason: 'not_sleep_window' }
    }
    const lastRun = await getLastConsolidationDate(env)
    if (lastRun === kst.date) {
      return { ran: false, reason: 'already_ran_today' }
    }
    const stats = await runSleepConsolidation(env, { now })
    if (!stats.ok) {
      return { ran: false, reason: 'run_failed', stats }
    }
    if (stats.ran) {
      await markConsolidationRun(env, kst.date)
    }
    return { ran: stats.ran, stats }
  } catch {
    return { ran: false, reason: 'error' }
  }
}
