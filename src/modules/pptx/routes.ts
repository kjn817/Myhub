import { Hono } from 'hono'
import type { Env } from '../../types'
import { buildPptx } from '../../services/pptx-builder'
import { buildMorningBriefingDeck, buildWeeklyReportDeck, kstDateStr } from '../../services/briefing-export'

// PPTX 내보내기 모듈: 아침 브리핑·주간 보고서를 네이티브 PowerPoint 덱으로 내보낸다.
// 인증은 전역 미들웨어(verifySession)가 /api/* 전체에 적용하므로 별도 검사 없음.
// 잠긴 메모는 서비스 계층에서 조회 단계부터 제외된다.

export const pptxApp = new Hono<{ Bindings: Env }>()

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

function pptxResponse(bytes: Uint8Array, filename: string): Response {
  const headers = new Headers()
  headers.set('Content-Type', PPTX_MIME)
  headers.set('Content-Disposition', `attachment; filename="${filename}"`)
  headers.set('Content-Length', String(bytes.length))
  return new Response(bytes as BodyInit, { status: 200, headers })
}

// 아침 브리핑 PPTX
// GET /api/pptx/briefing
pptxApp.get('/briefing', async (c) => {
  const deck = await buildMorningBriefingDeck(c.env.DB)
  const bytes = buildPptx(deck)
  return pptxResponse(bytes, `morning-briefing-${kstDateStr()}.pptx`)
})

// 주간 보고서 PPTX
// GET /api/pptx/weekly
pptxApp.get('/weekly', async (c) => {
  const deck = await buildWeeklyReportDeck(c.env.DB)
  const bytes = buildPptx(deck)
  return pptxResponse(bytes, `weekly-report-${kstDateStr()}.pptx`)
})
