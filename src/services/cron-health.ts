import type { Env } from '../types'
import { isPushConfigured } from './push'

export const CRON_HEALTH_KEY = 'cron.health.v1'
export const HISTORY_LIMIT = 10
export const DETAIL_LIMIT = 300

export const CRON_HANDLERS: string[] = [
  'schedule-push',
  'cron-jobs',
  'sleep-consolidation',
  'google-sync',
  'log-prune',
  // M-01 (2026-11-06): 복호화 건강 점검 — 실패 시에만 failed로 드러난다
  'decrypt-health',
]

export const HANDLER_LABELS: Record<string, string> = {
  'schedule-push': '일정 알림',
  'cron-jobs': '자연어 크론',
  'sleep-consolidation': '수면 통합',
  'google-sync': 'Google 동기화',
  'log-prune': '로그 정리(prune)',
  'decrypt-health': '복호화 건강 점검',
}

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS

export const DEAD_MAN_THRESHOLDS: Record<string, { runSilenceMs: number; successGapMs: number }> = {
  // 5분 틱 핸들러: 30분 = 6틱 연속 무기록이면 트리거 사망 의심.
  'schedule-push': { runSilenceMs: 30 * 60 * 1000, successGapMs: 26 * HOUR_MS },
  'cron-jobs': { runSilenceMs: 30 * 60 * 1000, successGapMs: 26 * HOUR_MS },
  'google-sync': { runSilenceMs: 30 * 60 * 1000, successGapMs: 26 * HOUR_MS },
  // 매일 03:00 1회: 실행 기록은 매 틱 남으므로 침묵 기준은 같고,
  // 성공 기아는 하루를 통째로 놓친 뒤(50시간)부터 본다.
  'sleep-consolidation': { runSilenceMs: 30 * 60 * 1000, successGapMs: 50 * HOUR_MS },
  // 주 1회: 실행 기록은 매 틱 남고, 성공 기아는 한 주를 놓친 뒤(8일)부터.
  'log-prune': { runSilenceMs: 30 * 60 * 1000, successGapMs: 8 * DAY_MS },
  // 주 1회 (prune와 같은 일요일 04시 창): 기준은 log-prune와 같다.
  'decrypt-health': { runSilenceMs: 30 * 60 * 1000, successGapMs: 8 * DAY_MS },
}

export interface CronHealthCounts {
  checked: number
  delivered: number
  failed: number
  skipped: number
}

export const ZERO_COUNTS: CronHealthCounts = { checked: 0, delivered: 0, failed: 0, skipped: 0 }

export interface CronHealthHistoryEntry extends CronHealthCounts {
  at: string
  status: string
  detail: string
}

export interface CronHandlerHealth {
  handler: string
  status: string
  detail: string
  counts: CronHealthCounts
  subscriptions: number | null
  consecutiveFailures: number
  lastRunAt: string | null
  lastOkAt: string | null
  lastFailureAt: string | null
  history: CronHealthHistoryEntry[]
}

export interface CronJobHealth {
  jobId: number
  status: string
  detail: string
  attempted: number
  delivered: number
  failed: number
  consecutiveFailures: number
  lastRunAt: string
  lastOkAt: string | null
}

export interface CronHealthStore {
  version: 1
  handlers: Record<string, CronHandlerHealth>
  jobs: Record<string, CronJobHealth>
}

export interface CronRunOutcome {
  status: string
  detail?: string
  counts?: Partial<CronHealthCounts>
  subscriptions?: number | null
  at?: Date
}

export interface CronJobRunOutcome {
  status: string
  detail?: string
  attempted?: number
  delivered?: number
  failed?: number
  at?: Date
}

export interface DeadManSignal {
  handler: string
  kind: 'run_silence' | 'success_starvation'
  detail: string
}

export interface CronHealthReport {
  healthy: boolean
  generatedAt: string
  push: { configured: boolean; subscriptions: number | null }
  handlers: CronHandlerHealth[]
  jobs: CronJobHealth[]
  alerts: string[]
  deadMan: DeadManSignal[]
}

export function deadManSignalsFor(h: CronHandlerHealth, now: Date): DeadManSignal[] {
  const t = DEAD_MAN_THRESHOLDS[h.handler]
  if (!t || !h.lastRunAt) return []
  const out: DeadManSignal[] = []
  const label = cronHandlerLabel(h.handler)
  const sinceRun = now.getTime() - Date.parse(h.lastRunAt)
  if (Number.isFinite(sinceRun) && sinceRun > t.runSilenceMs) {
    out.push({
      handler: h.handler,
      kind: 'run_silence',
      detail: `${label}: 마지막 실행 기록이 ${Math.round(sinceRun / 60000)}분 전입니다 — 크론 트리거·스케줄러가 멈춘 것일 수 있습니다 (dead-man).`,
    })
  }
  if (isFailureStatus(h.status)) {
    const basis = h.lastOkAt ?? h.history[0]?.at ?? null
    if (basis) {
      const sinceOk = now.getTime() - Date.parse(basis)
      if (Number.isFinite(sinceOk) && sinceOk > t.successGapMs) {
        out.push({
          handler: h.handler,
          kind: 'success_starvation',
          detail: `${label}: ${Math.round(sinceOk / HOUR_MS)}시간째 성공이 없습니다 — 작업은 돌고 있지만 계속 실패 중입니다 (dead-man).`,
        })
      }
    }
  }
  return out
}

export function cronHandlerLabel(name: string): string {
  return HANDLER_LABELS[name] || name
}

function emptyStore(): CronHealthStore {
  return { version: 1, handlers: {}, jobs: {} }
}

export function isFailureStatus(status: string): boolean {
  return status === 'failed' || status === 'partial' || status === 'no_recipient'
}

function nextConsecutive(prev: number | undefined, status: string): number {
  if (isFailureStatus(status)) return (prev ?? 0) + 1
  if (status === 'ok') return 0
  return prev ?? 0
}

async function readStore(db: D1Database): Promise<CronHealthStore> {
  try {
    const row = await db
      .prepare('SELECT value FROM ai_settings WHERE key = ?')
      .bind(CRON_HEALTH_KEY)
      .first<{ value: string }>()
    if (!row?.value) return emptyStore()
    const parsed = JSON.parse(row.value)
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.handlers !== 'object' ||
      parsed.handlers === null ||
      typeof parsed.jobs !== 'object' ||
      parsed.jobs === null
    ) {
      return emptyStore()
    }
    return { version: 1, handlers: parsed.handlers, jobs: parsed.jobs }
  } catch {
    return emptyStore()
  }
}

async function writeStore(db: D1Database, store: CronHealthStore): Promise<void> {
  await db.prepare(
    "INSERT OR REPLACE INTO ai_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  ).bind(CRON_HEALTH_KEY, JSON.stringify(store)).run()
}

export async function readCronHealthStore(db: D1Database): Promise<CronHealthStore> {
  return readStore(db)
}

export async function recordCronRun(env: { DB: D1Database }, handler: string, outcome: CronRunOutcome): Promise<void> {
  try {
    const at = (outcome.at ?? new Date()).toISOString()
    const store = await readStore(env.DB)
    const prev = store.handlers[handler]
    const counts: CronHealthCounts = { ...ZERO_COUNTS, ...(outcome.counts || {}) }
    const detail = (outcome.detail || '').slice(0, DETAIL_LIMIT)
    const entry: CronHealthHistoryEntry = { at, status: outcome.status, detail, ...counts }
    const history = prev?.history ? [...prev.history] : []
    const last = history[history.length - 1]
    if (
      !last ||
      last.status !== entry.status ||
      last.detail !== entry.detail ||
      last.checked !== entry.checked ||
      last.delivered !== entry.delivered ||
      last.failed !== entry.failed ||
      last.skipped !== entry.skipped
    ) {
      history.push(entry)
      while (history.length > HISTORY_LIMIT) history.shift()
    }
    store.handlers[handler] = {
      handler,
      status: outcome.status,
      detail,
      counts,
      subscriptions: outcome.subscriptions !== undefined ? outcome.subscriptions : prev?.subscriptions ?? null,
      consecutiveFailures: nextConsecutive(prev?.consecutiveFailures, outcome.status),
      lastRunAt: at,
      lastOkAt: outcome.status === 'ok' ? at : prev?.lastOkAt ?? null,
      lastFailureAt: isFailureStatus(outcome.status) ? at : prev?.lastFailureAt ?? null,
      history,
    }
    await writeStore(env.DB, store)
  } catch {
  }
}

export async function recordCronJobRun(env: { DB: D1Database }, jobId: number, outcome: CronJobRunOutcome): Promise<void> {
  try {
    const at = (outcome.at ?? new Date()).toISOString()
    const store = await readStore(env.DB)
    const key = String(jobId)
    const prev = store.jobs[key]
    store.jobs[key] = {
      jobId,
      status: outcome.status,
      detail: (outcome.detail || '').slice(0, DETAIL_LIMIT),
      attempted: outcome.attempted ?? prev?.attempted ?? 0,
      delivered: outcome.delivered ?? prev?.delivered ?? 0,
      failed: outcome.failed ?? prev?.failed ?? 0,
      consecutiveFailures: nextConsecutive(prev?.consecutiveFailures, outcome.status),
      lastRunAt: at,
      lastOkAt: outcome.status === 'ok' ? at : prev?.lastOkAt ?? null,
    }
    await writeStore(env.DB, store)
  } catch {
  }
}

export async function countPushSubscriptions(db: D1Database): Promise<number | null> {
  try {
    const row = await db
      .prepare('SELECT COUNT(*) AS n FROM push_subscriptions')
      .bind()
      .first<{ n: number }>()
    return typeof row?.n === 'number' ? row.n : null
  } catch {
    return null
  }
}

function neverRunHandler(handler: string): CronHandlerHealth {
  return {
    handler,
    status: 'never_run',
    detail: '아직 실행 기록이 없습니다',
    counts: { ...ZERO_COUNTS },
    subscriptions: null,
    consecutiveFailures: 0,
    lastRunAt: null,
    lastOkAt: null,
    lastFailureAt: null,
    history: [],
  }
}

export async function getCronHealth(env: Env, now: Date = new Date()): Promise<CronHealthReport> {
  const store = await readStore(env.DB)
  const subscriptions = await countPushSubscriptions(env.DB)
  const pushConfigured = isPushConfigured(env)
  const handlers = CRON_HANDLERS.map(
    (name) => store.handlers[name] ?? neverRunHandler(name)
  )
  const jobs = Object.values(store.jobs).sort((a, b) => a.jobId - b.jobId)
  const alerts: string[] = []
  if (pushConfigured && subscriptions === 0) {
    alerts.push(
      'Push 구독이 0건이라 일정 알림·크론 알림을 보낼 곳이 없습니다. 일정 앱에서 알림을 다시 켜서 구독을 재등록해 주세요.',
    )
  }
  for (const h of handlers) {
    const label = cronHandlerLabel(h.handler)
    if (h.status === 'failed') {
      alerts.push(`${label} 마지막 실행이 실패했습니다${h.detail ? `: ${h.detail}` : ''}`)
    } else if (h.status === 'no_recipient') {
      alerts.push(`${label}: 전달 대상(Push 구독)이 없어 마지막 실행이 전달 없이 끝났습니다.`)
    }
    if (h.consecutiveFailures >= 3) {
      alerts.push(`${label}이(가) ${h.consecutiveFailures}회 연속으로 실패/미전달 상태입니다.`)
    }
  }
  for (const j of jobs) {
    if (j.consecutiveFailures >= 3) {
      alerts.push(
        `크론 작업 #${j.jobId}이(가) ${j.consecutiveFailures}회 연속 실패 중입니다${j.detail ? `: ${j.detail}` : ''}`,
      )
    }
  }
  const deadMan: DeadManSignal[] = []
  for (const h of handlers) {
    for (const s of deadManSignalsFor(h, now)) {
      deadMan.push(s)
      alerts.push(s.detail)
    }
  }
  return {
    healthy: alerts.length === 0,
    generatedAt: now.toISOString(),
    push: { configured: pushConfigured, subscriptions },
    handlers,
    jobs,
    alerts,
    deadMan,
  }
}
