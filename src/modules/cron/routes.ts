import { Hono } from 'hono'
import type { Env } from '../../types'
import {
  createCronJob,
} from '../../services/cron-jobs'
import { describeNlCron, parseNlCron } from '../../services/nl-cron'

// 반복 자동화(cron) 관리 API — 대시보드·채팅 외 관리 경로
// 인증은 전역 미들웨어(verifySession)에서 처리됨
// - POST /api/cron {nl_text} — 자연어로 생성 (파싱 실패 시 400)
// 목록·활성화·삭제·건강 상태 HTTP 엔드포인트는 D3 결정(2026-11-14)으로 삭제 —
// cron 관리는 채팅 마커(cron-tools 서비스) 경유.

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
