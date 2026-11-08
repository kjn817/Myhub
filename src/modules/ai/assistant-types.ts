// (routes.ts 분리, 2026-10-29 — 동작 변경 없는 순수 구조 분리로 이동된 코드)
// 단일 비서 호출의 입출력 타입과 입력 오류
import { aiChat, PERSONAS, MODELS, getSetting, setSetting, buildSystemPrompt, type TaskPolicy, type ProviderId } from '../../services/ai'
import {
  ToolApprovalRequestStore,
  buildApprovalRequestText,
  describeMaskedToolAction,
  isPossibleApprovalReply,
  resolveApprovalReply,
  APPROVAL_TIMEOUT_MS,
  type ApprovalRequestSummary,
} from '../../services/approval-flow'

// ---------------------------------------------------------------------------
// 단일 비서 호출 헬퍼 — /chat과 /orchestrate가 공유
// 메시지 정규화 → 기억 로드 → aiChat → [SEARCH:] 2차 호출 → 도구 마커 처리
// D1 저장은 하지 않음 (호출자가 담당)
// ---------------------------------------------------------------------------

export interface RawChatMessage {
  role: string
  content: string
  personaId?: string
}

export interface AssistantCallResult {
  text: string
  provider?: string
  model?: string
  sources?: { title: string; url: string }[]
  pipeline?: string
  fallbacks?: unknown
  /** 정규화된 마지막 사용자 메시지 (기록용) */
  lastUserContent?: string
  /** 도구 마커로 데이터가 변경되었는지 */
  dataChanged?: boolean
  /** UI 액션 (메모 열기/닫기 등) */
  uiActions?: Array<{ uiAction: string; memoId?: number | null }>
  /** 도구 실행 결과 (후보 버튼 UI용) */
  toolResults?: Array<{ success: boolean; toolName: string; error?: string; candidates?: any[]; data?: any }>
  /** 대기 중인 승인 요청 (사용자가 승인/거부로 답해야 실행됨) */
  approvalRequests?: ApprovalRequestSummary[]
  /** 실제 적용된 프롬프트 버전 (D5: 미적용 시 'legacy') */
  promptVersion?: string
  /** 생성된 이미지 목록 */
  images?: Array<{ url: string; prompt: string }>
}

export class AssistantInputError extends Error {
  constructor(
    public code: 'unknown_persona' | 'empty' | 'too_long',
    message: string,
  ) {
    super(message)
    this.name = 'AssistantInputError'
  }
}
