// AI 서비스 공용 타입 (ChatMessage·TaskPolicy·AIResult·UsageRecord·ModelDef)
// src/services/ai.ts에서 순수 이동 (트랙 D, 2026-10-31) — 동작 변경 없음.
// 잎(leaf) 모듈: 런타임 import는 없고 ProviderId 타입만 참조한다.
// ai.ts가 re-export하므로 기존 import 경로(services/ai)는 그대로 유효하다.
import type { ProviderId } from './provider-registry'
import type { ApprovalRequestSummary } from './approval-flow'
import type { LedgerExecutionLike } from './tool-ledger'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** OpenAI 형식 tool_calls (assistant 메시지용) */
  tool_calls?: any[]
  /** tool 역할 메시지의 호출 ID */
  tool_call_id?: string
}

export interface TaskPolicy {
  capability: string // 'summarize' | 'search' | 'translate' | 'chat' | 'code' | 'build' ...
  privacy: 'private' | 'external-ok' // private이면 Workers AI만
  latency: 'interactive' | 'background'
  quality: 'fast' | 'balanced' | 'high'
  maxInputChars?: number
  useSearch?: boolean // Google Search grounding 사용 (gemini-2.5-flash만 지원)
  model?: string // 사용자가 선택한 특정 모델 (선택사항)
  /**
   * Phase 3D-P: 개인정보 민감도 (서버가 결정)
   * - 설정되면 ModelRouter 정책으로 Provider 필터링
   * - 미설정 시 기존 동작 유지 (하위 호환)
   */
  sensitivity?: 'general' | 'personal' | 'restricted'
  /** 민감도 판정 사유 (resolveRequestSensitivity의 reason — 로깅·귀속용) */
  sensitivityReason?: string
  /**
   * Phase 3D-PV-S S0.2: 비서 ID (민감도 하한 적용용)
   * - capability가 변경되어도 personaId 기준으로 최소 민감도 유지
   */
  personaId?: string
  /**
   * 비서별 전용 프로바이더 고정 (2026-10-13)
   * - 설정되면 해당 provider의 모델만 후보가 됨 (프로바이더 간 폴백 없음)
   * - 루미=gemini, 에코=workers-ai, 노바=gemini, 캘리=groq
   *   (2026-10-30: 에코 nvidia → workers-ai — NVIDIA 운영 경로 제외.
   *    단 하나의 예외: Workers AI 뉴런 소진 시 Gemini lite degraded 재시도
   *    1회 — aiChat의 workers_ai_quota_degraded 경로 참조)
   */
  providerPin?: ProviderId
  /**
   * NVIDIA 가드 (트랙 1): 호출자가 메모 검색 결과 등 메모 데이터를
   * 메시지에 주입했음을 명시한다. assistant-call의 memoDataMessage가
   * 대표 경로이며, aiChat 진입부 분류의 구조적 신호로 쓰인다.
   */
  memoDataInjected?: boolean
  /**
   * NVIDIA 가드 (트랙 1): 호출자가 장기 기억(개인 사실)을 시스템
   * 프롬프트에 주입했음을 명시한다. 메모 본문은 아니지만 NVIDIA Trial
   * §4.3의 개인정보에 해당하므로 fail-closed로 같은 제외 대상이다.
   */
  memoryContextInjected?: boolean
  /**
   * 이 턴의 스킬·도구 결정을 위한 원본 사용자 텍스트.
   * 내부 후속 호출([SEARCH:] 등)이 합성 메시지를 마지막 user 메시지로
   * 넘겨도 턴의 도구 집합이 바뀌지 않게 한다 — aiChat의 가드 분류와
   * FC 스킬 로드는 모두 이 텍스트(없으면 마지막 user 텍스트)를 입력으로
   * 쓴다. assistant-call이 턴 시작 시 마지막 실제 사용자 메시지로 설정한다.
   */
  skillText?: string
  /**
   * 실행 출처 (Talorys ③-A, ai/types의 ExecutionOrigin과 동일 어휘).
   * FC 루프의 쓰기 도구 판정에만 쓴다: 'interactive'가 아닌 실행
   * (미지정 포함, fail-closed)에서는 FC 쓰기 도구를 디스패치하지 않는다.
   * 대화형 진입점(assistant-call)은 호출자 옵션을 그대로 전파하고,
   * 예약 요약(news-briefing)은 'scheduled'를 명시한다.
   */
  origin?: import('../ai/types').ExecutionOrigin
}

export interface AIResult {
  text: string
  provider: ProviderId
  model: string
  latencyMs: number
  inputTokens?: number
  outputTokens?: number
  neurons?: number
  sources?: { title: string; url: string }[] // 웹검색 출처
  /** 검색·작성 파이프라인 표기 (assistant-call 후속 검색 경로 등에서 설정) */
  pipeline?: string
  /** 폴백 발생 내역 (진단용 — 형태는 발생 지점별로 다름) */
  fallbacks?: unknown
  /** 도구 실행으로 데이터가 변경됐는지 (위젯 새로고침용) */
  dataChanged?: boolean
  /** UI 액션 (메모 열기/닫기 등) */
  uiActions?: Array<{ uiAction: string; memoId?: number | null }>
  /** 도구 실행 결과 (FC 경로·마커 경로가 메타데이터로 싣는다) */
  toolResults?: Array<{ success: boolean; toolName: string; error?: string; candidates?: any[]; data?: any }>
  /** 실행 원장 기록 (검증되지 않은 성공 주장 교정용) */
  ledgerExecutions?: LedgerExecutionLike[]
  /** 대기 중인 승인 요청 (프론트 승인 카드용) */
  approvalRequests?: ApprovalRequestSummary[]
  /** 생성된 이미지 목록 */
  images?: Array<{ url: string; prompt: string }>
}

/**
 * 실행 경로 귀속 어휘 (0065 컬럼 — 고정, 임의 값 금지).
 * - marker: E1 마커 경로가 처리한 턴의 호출 (useFC 게이트가 꺼진 시도)
 * - builtin-fc: E2 운영 내장 FC 루프 (aiChat의 useFC 게이트가 켜진 시도)
 * - registry-fc: E3 파일럿 Registry FC (run-logger 전용 — ai.ts는 쓰지 않음)
 * - degraded: 1차 경로 실패 후 degraded 재시도·대체 경로가 서빙한 호출
 *   (현재 유일한 발생 지점: 뉴런 소진 시 Gemini lite degraded 재시도)
 */
export type UsageEngine = 'marker' | 'builtin-fc' | 'registry-fc' | 'degraded'

/**
 * 귀속 불가 센티넬 (ai_usage의 engine·persona 컬럼용).
 * 판정 불가·맥락 부재를 NULL(=미기록·레거시)과 구분하기 위해 저장한다.
 */
export const UNATTRIBUTED = 'unattributed'

export interface UsageRecord {
  provider: ProviderId
  model: string
  capability: string
  latencyMs: number
  inputTokens?: number
  outputTokens?: number
  /** Workers AI 뉴런 소비량 (0064 컬럼 — 뉴런 예산 관측용) */
  neurons?: number
  outcome: 'success' | 'rate_limited' | 'failed'
  at: number
  /** 실행 경로 귀속 (0065 컬럼) — 호출이 속한 실제 분기에서 판정해 전파 */
  engine?: UsageEngine
  /** 비서 귀속 (0065 컬럼) — 실제 personaId. 비서 맥락이 없으면 미지정(NULL) */
  persona?: string
  /** 실행 런 귀속 (K-03) — ai_runs.run_id. 런이 없는 직접 호출이면 미지정 */
  runId?: string
  /** 런 내 호출 순번 (K-03) — aiChat의 시도 인덱스 */
  callIndex?: number
  /** OTEL 스팬 (0057) — 없으면 logUsage가 이 호출을 루트로 삼는다 */
  traceId?: string
  spanId?: string
  parentSpanId?: string | null
  promptVersion?: string
}

export interface ModelDef {
  id: string
  provider: ProviderId
  quality: 'fast' | 'balanced' | 'high'
  status: 'active' | 'degraded' | 'unavailable' | 'deprecated' | 'evaluation'
}
