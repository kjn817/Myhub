/**
 * 자연어 cron 작업 저장소 + 실행기 — Octop 자연어 cron 패턴의 실행 계층
 *
 * - createCronJob: 자연어("매일 아침 8시에 브리핑해줘")를 파싱해
 *   user_cron_jobs(마이그레이션 0047)에 저장한다. 파싱 실패 시 저장하지 않는다.
 * - listCronJobs / setCronJobEnabled / deleteCronJob: 채팅·REST API용 관리
 *   (목록 조회·활성화/비활성화·삭제).
 * - runDueCronJobs: 5분 틱 scheduled 핸들러에서 호출한다. due인 작업을
 *   KST wall-clock으로 판정하고, 아침 브리핑은 generateMorningSummary로,
 *   뉴스 요약은 generateNewsSummary(Exa + 요약 모델)로 내용을 만들어
 *   deliver 콜백(실전: Web Push)으로 전달한다.
 * - 중복 실행 방지: next_run_at을 다음 실행 시각으로 원자적 선점
 *   (UPDATE ... WHERE next_run_at = ? — changes==0이면 다른 틱이 선점).
 * - 전달 실패 시 next_run_at을 복원해 다음 틱에 재시도한다.
 * - 어떤 오류도 호출자를 깨지 않는다 (fail-soft — 기존 리마인더 흐름과 동일).
 */

import { describeNlCron, nextRunAfter, parseNlCron, type NlCronParse } from './nl-cron'
import { generateMorningSummary } from './proactive'
import { generateNewsSummary, type NewsSummarizeFn } from './news-briefing'

export interface CronJob {
  id: number
  action: string
  nlText: string
  cronKst: string
  timezone: string
  nextRunAt: string | null
  enabled: number
  createdAt: string
  updatedAt: string
}

interface CronJobRow {
  id: number
  action: string
  nl_text: string
  cron_kst: string
  timezone: string
  next_run_at: string | null
  enabled: number
  created_at: string
  updated_at: string
}

function toCronJob(row: CronJobRow): CronJob {
  return {
    id: row.id,
    action: row.action,
    nlText: row.nl_text,
    cronKst: row.cron_kst,
    timezone: row.timezone,
    nextRunAt: row.next_run_at,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * 자연어 cron 작업 생성. 파싱 실패 시 null을 반환하고 저장하지 않는다.
 * next_run_at은 파싱된 스케줄의 다음 실행 시각(UTC instant ISO)으로 계산한다.
 */
export async function createCronJob(
  db: D1Database,
  nlText: string,
  now: Date = new Date(),
): Promise<CronJob | null> {
  const parsed = parseNlCron(nlText)
  if (!parsed) return null
  const next = nextRunAfter(parsed.schedule, now)
  const nextRunAt = next ? next.toISOString() : null
  const result = await db
    .prepare(
      `INSERT INTO user_cron_jobs (action, nl_text, cron_kst, timezone, next_run_at, enabled)
       VALUES (?, ?, ?, 'Asia/Seoul', ?, 1)`
    )
    .bind(parsed.action, nlText, parsed.schedule.cronKst, nextRunAt)
    .run()
  const id = (result.meta as { last_row_id?: number } | undefined)?.last_row_id
  if (typeof id !== 'number') throw new Error('cron job insert failed')
  const row = await db
    .prepare(`SELECT * FROM user_cron_jobs WHERE id = ?`)
    .bind(id)
    .first<CronJobRow>()
  if (!row) throw new Error('cron job insert failed')
  return toCronJob(row)
}

/** 전체 작업 목록 (최신 순) — 채팅 조회·REST API 공용 */
export async function listCronJobs(db: D1Database): Promise<CronJob[]> {
  const { results } = await db
    .prepare(`SELECT * FROM user_cron_jobs ORDER BY created_at DESC, id DESC`)
    .bind()
    .all<CronJobRow>()
  return (results || []).map(toCronJob)
}

/** 작업 1건 조회 */
export async function getCronJob(db: D1Database, id: number): Promise<CronJob | null> {
  const row = await db
    .prepare(`SELECT * FROM user_cron_jobs WHERE id = ?`)
    .bind(id)
    .first<CronJobRow>()
  return row ? toCronJob(row) : null
}

/** 작업 활성화/비활성화. 없는 id면 null. */
export async function setCronJobEnabled(
  db: D1Database,
  id: number,
  enabled: boolean,
): Promise<CronJob | null> {
  const result = await db
    .prepare(
      `UPDATE user_cron_jobs SET enabled = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .bind(enabled ? 1 : 0, id)
    .run()
  if (((result.meta as { changes?: number } | undefined)?.changes ?? 0) === 0) return null
  return getCronJob(db, id)
}

/** 작업 삭제. 삭제된 행이 있으면 true. */
export async function deleteCronJob(db: D1Database, id: number): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM user_cron_jobs WHERE id = ?`)
    .bind(id)
    .run()
  return ((result.meta as { changes?: number } | undefined)?.changes ?? 0) > 0
}

/** due인 작업 목록 (enabled=1, next_run_at <= now) */
export async function listDueCronJobs(db: D1Database, now: Date): Promise<CronJob[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM user_cron_jobs
       WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at ASC LIMIT 50`
    )
    .bind(now.toISOString())
    .all<CronJobRow>()
  return (results || []).map(toCronJob)
}

async function advanceNextRun(
  db: D1Database,
  job: CronJob,
  nextRunAt: string | null,
  expectedOld: string | null,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE user_cron_jobs SET next_run_at = ?, updated_at = datetime('now')
       WHERE id = ? AND next_run_at = ?`
    )
    .bind(nextRunAt, job.id, expectedOld)
    .run()
  return ((result.meta as { changes?: number } | undefined)?.changes ?? 0) > 0
}

export interface CronRunResult {
  checked: number
  delivered: number
  failed: number
  skipped: number
}

export interface CronRunOptions {
  /** 뉴스 요약기 주입 (미지정 시 기본 aiChat 요약기; 테스트용) */
  newsSummarize?: NewsSummarizeFn
}

/**
 * due 작업을 실행한다.
 * - deliver(job, text): 실제 전달 수단 (실전: 모든 push 구독에 발송).
 * - 아침 브리핑/일정 알림은 오늘 일정 요약문을, 뉴스 요약은 Exa 기반 뉴스
 *   요약문을, 그 외는 확인 문장을 전달한다.
 * - 뉴스 검색·모델 일시 실패는 예외로 던져져 아래 catch에서 next_run_at을
 *   복원해 다음 틱에 재시도한다 (키 미설정은 사유 문장 반환이라 재시도 없음).
 */
export async function runDueCronJobs(
  env: { DB: D1Database },
  deliver: (job: CronJob, text: string) => Promise<void>,
  now: Date = new Date(),
  opts: CronRunOptions = {},
): Promise<CronRunResult> {
  const result: CronRunResult = { checked: 0, delivered: 0, failed: 0, skipped: 0 }
  let due: CronJob[]
  try {
    due = await listDueCronJobs(env.DB, now)
  } catch {
    return result // 테이블 없음 등 — 조용히 종료
  }
  result.checked = due.length

  for (const job of due) {
    let parsed: NlCronParse | null
    try {
      parsed = parseNlCron(job.nlText)
    } catch {
      result.skipped++
      continue
    }
    if (!parsed) {
      result.skipped++
      continue
    }
    const next = nextRunAfter(parsed.schedule, now)
    if (!next) {
      // 다음 실행 시각을 계산할 수 없으면 선점하지 않고 건너뜀
      // (next_run_at을 NULL로 덮어 작업을 조용히 비활성화하지 않음)
      result.skipped++
      continue
    }
    const nextRunAt = next.toISOString()

    // 원자적 선점: 다른 틱이 이미 선점했으면 건너뜀
    let claimed = false
    try {
      claimed = await advanceNextRun(env.DB, job, nextRunAt, job.nextRunAt)
    } catch {
      result.failed++
      continue
    }
    if (!claimed) {
      result.skipped++
      continue
    }

    try {
      const text =
        parsed.action === 'generic'
          ? describeNlCron(parsed)
          : parsed.action === 'news-summary'
            ? await generateNewsSummary(env as { EXA_API_KEY?: string } & Record<string, any>, {
                summarize: opts.newsSummarize,
              })
            : await generateMorningSummary(env)
      await deliver(job, text)
      result.delivered++
    } catch {
      // 전달 실패: 다음 틱 재시도를 위해 next_run_at 복원
      try {
        await advanceNextRun(env.DB, { ...job, nextRunAt }, job.nextRunAt, nextRunAt)
      } catch {
        // 복원 실패 시에도 다음 틱의 선점은 nextRunAt 기준으로 동작
      }
      result.failed++
    }
  }

  return result
}
