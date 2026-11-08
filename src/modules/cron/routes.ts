import { Hono } from 'hono'
import type { Env } from '../../types'
import {
  createCronJob,
  listCronJobs,
  setCronJobEnabled,
  deleteCronJob,
} from '../../services/cron-jobs'
import { describeNlCron, parseNlCron } from '../../services/nl-cron'
import { getCronHealth, readCronHealthStore } from '../../services/cron-health'

// 반복 자동화(cron) 관리 API — 대시보드·채팅 외 관리 경로
// 인증은 전역 미들웨어(verifySession)에서 처리됨
// - GET /api/cron — 목록
// - POST /api/cron {nl_text} — 자연어로 생성 (파싱 실패 시 400)
// - PATCH /api/cron/:id {enabled} — 활성화/비활성화
// - DELETE /api/cron/:id — 삭제

export const cronApp = new Hono<{ Bindings: Env }>()

function toPublic(job: {
  id: number
  action: string
  nlText: string
  cronKst: string
  timezone: string
  nextRunAt: string | null
  enabled: number
  createdAt: string
  updatedAt: string
}) {
  const parsed = parseNlCron(job.nlText)
  return {
    id: job.id,
    action: job.action,
    nl_text: job.nlText,
    cron_kst: job.cronKst,
    timezone: job.timezone,
    next_run_at: job.nextRunAt,
    enabled: job.enabled === 1,
    description: parsed ? describeNlCron(parsed) : job.nlText,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
  }
}

function parseId(c: { req: { param: (name: string) => string } }): number | null {
  const id = Number(c.req.param('id'))
  return Number.isInteger(id) && id > 0 ? id : null
}

// 크론 건강 상태 (스케줄러 기록 기반)
cronApp.get('/health', async (c) => {
  try {
    const health = await getCronHealth(c.env)
    return c.json({ ok: true, ...health })
  } catch {
    return c.json({ ok: false, error: 'db_error' }, 500)
  }
})

cronApp.get('/', async (c) => {
  try {
    const jobs = await listCronJobs(c.env.DB)
    const store = await readCronHealthStore(c.env.DB)
    return c.json({
      ok: true,
      jobs: jobs.map((job) => ({
        ...toPublic(job),
        last_run: store.jobs[String(job.id)] ?? null,
      })),
    })
  } catch {
    return c.json({ ok: false, error: 'db_error' }, 500)
  }
})

cronApp.post('/', async (c) => {
  const json = await c.req.json().catch(() => null)
  const nlText = typeof json?.nl_text === 'string' ? json.nl_text.trim() : ''
  if (!nlText || nlText.length > 500) {
    return c.json({ ok: false, error: 'invalid_nl_text' }, 400)
  }
  try {
    const job = await createCronJob(c.env.DB, nlText)
    if (!job) {
      return c.json({ ok: false, error: 'parse_failed', message: '시간 표현을 이해하지 못했습니다.' }, 400)
    }
    return c.json({ ok: true, job: toPublic(job) })
  } catch {
    return c.json({ ok: false, error: 'db_error' }, 500)
  }
})

cronApp.patch('/:id', async (c) => {
  const id = parseId(c)
  if (id === null) return c.json({ ok: false, error: 'invalid_id' }, 400)
  const json = await c.req.json().catch(() => null)
  if (typeof json?.enabled !== 'boolean') {
    return c.json({ ok: false, error: 'invalid_enabled' }, 400)
  }
  try {
    const job = await setCronJobEnabled(c.env.DB, id, json.enabled)
    if (!job) return c.json({ ok: false, error: 'not_found' }, 404)
    return c.json({ ok: true, job: toPublic(job) })
  } catch {
    return c.json({ ok: false, error: 'db_error' }, 500)
  }
})

cronApp.delete('/:id', async (c) => {
  const id = parseId(c)
  if (id === null) return c.json({ ok: false, error: 'invalid_id' }, 400)
  try {
    const ok = await deleteCronJob(c.env.DB, id)
    if (!ok) return c.json({ ok: false, error: 'not_found' }, 404)
    return c.json({ ok: true, id })
  } catch {
    return c.json({ ok: false, error: 'db_error' }, 500)
  }
})
