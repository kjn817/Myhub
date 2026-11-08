import { Hono } from 'hono'
import type { Env } from '../../types'
import { buildTodayBriefing } from './service'

// 오늘 브리핑 모듈: 오늘 일정 + 미완료 할일 요약
// 인증은 전역 미들웨어(verifySession)에서 처리됨
// 홈 화면 위젯 + AI 비서(캘리)가 사용
// 조회 로직은 service.ts(buildTodayBriefing)가 소유한다 — MCP 도구
// (briefing.generate)와 같은 함수를 쓴다.

export const briefingApp = new Hono<{ Bindings: Env }>()

// 오늘 브리핑
// GET /api/briefing/today
briefingApp.get('/today', async (c) => {
  const briefing = await buildTodayBriefing(c.env.DB)
  return c.json(briefing)
})
