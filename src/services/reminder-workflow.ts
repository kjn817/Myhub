/**
 * 일정 알림 워크플로 — Cron(5분) + Web Push 경로를 워크플로 엔진 위에 얹은 이식
 *
 * 기존 경로(src/scheduled.ts handleScheduled)는 그대로 유지한다. 이 파일의
 * 경로는 WORKFLOW_REMINDER_ENABLED=true 일 때만 handleScheduled가 위임한다.
 *
 * 워크플로 `schedule-reminder` (트리거: cron 5분마다):
 *   1. claim     — reminders INSERT OR IGNORE 선점 (dedupe, 1차 중복 방지)
 *   2. compose   — 알림 제목/본문 작성 (기존 fmtTimeKST·본문 형식과 동일)
 *   3. send-push — 구독자 전원 발송. 만료 구독(404/410) 삭제.
 *                  발송 API는 태그(dedupe_key)로 브라우저 단위 중복 제거를
 *                  하므로 노드 재시도 시 이미 받은 사용자에게 중복 발송되지
 *                  않는다. 예외는 continueOnError로 넘기고 record가 failed 처리.
 *   4. record    — reminders 상태(sent/failed) 업데이트
 *
 * 노드 간 `when: claimed` 조건이 n8n의 IF 분기 역할을 한다.
 * 멱등성은 두 겹이다: ① reminders 선점 (기존) ② workflow_runs
 * idempotencyKey `push:<scheduleId>:<startAt>` (엔진, 마이그레이션 0050).
 */

import type { Env } from '../types'
import { sendPushNotification, isPushConfigured, type PushSubscription, type PushPayload, type SendResult } from './push'
import { runWorkflow, type WorkflowDefinition } from './workflow'

export const REMINDER_WORKFLOW_ID = 'schedule-reminder'
export const REMINDER_WORKFLOW_CRON = '*/5 * * * *'

const WINDOW_MINUTES = 30

/** 워크플로 경로 활성화 플래그 (기본 꺼짐 — 운영 적용·활성화는 승인 단계) */
export function isWorkflowReminderEnabled(env: Env): boolean {
  return env.WORKFLOW_REMINDER_ENABLED === 'true'
}

export interface ReminderWorkflowDeps {
  /** 테스트 주입용 발송 함수 (기본: 실제 sendPushNotification) */
  sendPush?: (env: Env, sub: PushSubscription, payload: PushPayload, ttlSeconds?: number) => Promise<SendResult>
  /** 테스트 주입용 sleep (기본: setTimeout 기반 실제 대기) */
  sleep?: (ms: number) => Promise<void>
}

interface DueSchedule {
  id: number
  title: string
  start_at: string
  location: string | null
}

/** 'YYYY-MM-DDTHH:mm' → 'HH:mm' (기존 scheduled.ts fmtTimeKST와 동일) */
export function fmtTimeKST(startAt: string): string {
  const t = startAt.slice(11, 16)
  return t || ''
}

async function findDueSchedules(db: D1Database): Promise<DueSchedule[]> {
  // schedules.start_at은 KST wall-clock 문자열. D1 datetime('now')는 UTC이므로
  // '-9 hours'로 KST→UTC 보정한다 (기존 handleScheduled와 동일 조건).
  const r = await db
    .prepare(
      `SELECT id, title, start_at, location
       FROM schedules
       WHERE status = 'active'
         AND datetime(start_at, '-9 hours') BETWEEN datetime('now') AND datetime('now', ?)
       ORDER BY start_at ASC
       LIMIT 50`
    )
    .bind(`+${WINDOW_MINUTES} minutes`)
    .all<DueSchedule>()
  return r.results || []
}

export function buildScheduleReminderWorkflow(
  deps: ReminderWorkflowDeps = {}
): WorkflowDefinition {
  const sendPush = deps.sendPush ?? sendPushNotification
  return {
    id: REMINDER_WORKFLOW_ID,
    name: '일정 알림 (Cron 5분)',
    version: 1,
    trigger: { type: 'cron', cron: REMINDER_WORKFLOW_CRON },
    retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000, multiplier: 2 },
    nodes: [
      {
        id: 'claim',
        name: 'reminders 선점 (dedupe)',
        requires: ['scheduleId', 'startAt'],
        produces: ['claimed', 'dedupeKey'],
        run: async ({ env: e, state }) => {
          const dedupeKey = `push:${state.scheduleId}:${state.startAt}`
          let claimed = false
          try {
            const ins = await e.DB.prepare(
              `INSERT OR IGNORE INTO reminders (schedule_id, remind_at, status, dedupe_key)
               VALUES (?, ?, 'pending', ?)`
            ).bind(state.scheduleId, state.startAt, dedupeKey).run()
            claimed = (ins.meta?.changes ?? 0) > 0
          } catch {
            claimed = false // INSERT 실패 시 해당 일정 건너뜀 (기존 동작)
          }
          return { claimed, dedupeKey }
        },
      },
      {
        id: 'compose',
        name: '알림 본문 작성',
        requires: ['scheduleId', 'title', 'startAt', 'claimed', 'dedupeKey'],
        produces: ['body', 'tag'],
        when: (s) => s.claimed === true,
        run: async ({ state }) => {
          const time = fmtTimeKST(String(state.startAt))
          const body = `${time ? time + ' ' : ''}${state.title}${state.location ? ' · ' + state.location : ''}`
          return { body, tag: String(state.dedupeKey) }
        },
      },
      {
        id: 'send-push',
        name: 'Web Push 발송',
        requires: ['body', 'tag', 'claimed'],
        produces: ['sentCount', 'failCount'],
        when: (s) => s.claimed === true,
        // 발송 예외는 재시도 후에도 실패하면 record 노드가 failed로 마무리한다.
        // (n8n의 Continue On Fail — 중단되면 reminders가 pending으로 남는다)
        continueOnError: true,
        run: async ({ env: e, state }) => {
          const subs = (
            await e.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions').all<PushSubscription>()
          ).results || []
          let okCount = 0
          let failCount = 0
          let goneCount = 0
          for (const sub of subs) {
            const r = await sendPush(
              e, sub,
              { title: '일정 알림', body: String(state.body), url: '/schedule.html', tag: String(state.tag) },
              3600
            )
            if (r.ok) {
              okCount++
            } else {
              failCount++
              if (r.gone) {
                goneCount++
                // 만료된 구독 정리 (실패해도 무시 — 기존 동작)
                await e.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
                  .bind(sub.endpoint).run().catch(() => {})
              }
            }
          }
          // 전원 실패인데 만료(gone)가 아닌 실패가 있으면 던져서 엔진이 재시도한다.
          // 재시도 시 이미 받은 사용자에게 중복 발송되지 않는다: 푸시 태그(dedupe_key)
          // 가 같으면 브라우저가 알림을 교체한다. 만료만으로 전원 실패한 경우는
          // 재시도해도 소용없으므로(구독이 이미 삭제됨) 던지지 않는다.
          if (okCount === 0 && failCount - goneCount > 0) {
            throw new Error('push_send_failed')
          }
          return { sentCount: okCount, failCount }
        },
      },
      {
        id: 'record',
        name: 'reminders 상태 기록',
        requires: ['claimed', 'dedupeKey'],
        produces: ['reminderStatus'],
        when: (s) => s.claimed === true,
        run: async ({ env: e, state }) => {
          const sentCount = Number(state.sentCount ?? 0)
          const failCount = Number(state.failCount ?? 0)
          const sendError = typeof state['send-pushError'] === 'string'
          // 기존 판정과 동일: 전원 실패 시 failed, 그 외 sent (혼합도 sent).
          // 단, 발송 노드 자체가 예외로 죽은 경우(sentCount/failCount 없음)도 failed.
          const status = sendError || (failCount > 0 && sentCount === 0) ? 'failed' : 'sent'
          await e.DB.prepare(
            `UPDATE reminders SET status = ?, sent_at = datetime('now') WHERE dedupe_key = ?`
          ).bind(status, String(state.dedupeKey)).run().catch(() => {})
          return { reminderStatus: status }
        },
      },
    ],
  }
}

/**
 * 워크플로 경로의 Cron 틱 — handleScheduled와 같은 {checked, sent, failed} 반환.
 * - due 조회 실패 / 구독 없음 시 기존과 동일하게 조용히 종료한다.
 * - 멱등성 duplicate(재실행 방지됨)나 미선점 일정은 카운트하지 않는다
 *   (기존 경로의 "이미 처리됨 → 건너뜀"과 동일).
 */
export async function runReminderTick(
  env: Env, deps: ReminderWorkflowDeps = {}
): Promise<{ checked: number; sent: number; failed: number }> {
  const result = { checked: 0, sent: 0, failed: 0 }
  if (!isPushConfigured(env)) return result

  let due: DueSchedule[] = []
  try {
    due = await findDueSchedules(env.DB)
  } catch {
    return result // 테이블 없음 등 — 조용히 종료 (기존 동작)
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
    let res
    try {
      res = await runWorkflow(buildScheduleReminderWorkflow(deps), {
        env,
        input: {
          scheduleId: s.id,
          title: s.title,
          startAt: s.start_at,
          location: s.location ?? null,
        },
        idempotencyKey: `push:${s.id}:${s.start_at}`,
        sleep: deps.sleep,
      })
    } catch {
      continue // 한 일정의 워크플로 예외가 나머지 일정을 막지 않는다
    }
    if (res.status !== 'completed') continue
    if (res.output.claimed !== true) continue
    const sentCount = Number(res.output.sentCount ?? 0)
    if (sentCount > 0) result.sent++
    else result.failed++
  }

  return result
}
