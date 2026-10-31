// (routes.ts 분리, 2026-10-29 — 동작 변경 없는 순수 구조 분리로 이동된 코드)
// 도구 마커 처리 컨텍스트: processToolMarkers와 마커 종류별 섹션 헬퍼가
// 공유하는 상태·헬퍼 모음. 섹션 헬퍼는 이 객체를 통해서만 상태를 주고받는다.
import type { ApprovalRequestSummary } from '../../services/approval-flow'

export interface ToolMarkerContext {
  env: any
  text: string
  images: { url: string; prompt: string }[]
  dataChanged: boolean
  toolResults: any[]
  approvalRequests: ApprovalRequestSummary[]
  searchReplacementSources: { title: string; url: string }[]
  authorizeTool: (
    toolName: string,
    args: unknown,
    markerFull: string,
  ) => Promise<{ allowed: boolean; message: string; request?: ApprovalRequestSummary }>
  sanitizeInserted: (data: string) => string
  denyExecution: (toolName: string) => { success: boolean; error: string }
}
