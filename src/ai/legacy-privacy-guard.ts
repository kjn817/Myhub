/**
 * Phase 3D-P: 레거시 경로 개인정보 전송 가드
 *
 * 원칙:
 * 1. 민감도는 서버가 결정 (사용자/LLM이 낮출 수 없음)
 * 2. Phase 2 ModelRouter의 Provider 정책을 재사용
 * 3. 최초 선택 + 후속 호출 직전 모두 검사
 * 4. 오버라이드/Fallback으로 우회 불가
 * 5. 허용 Provider 없음 → 안전하게 종료 (조용한 우회 금지)
 * 6. ai.prompt_v2 플래그와 무관하게 적용
 */

import {
  ModelRouter,
  resolveSensitivity,
  type SensitivityLevel,
} from './model-router'
import type { ProviderId } from '../services/ai'

export type { SensitivityLevel }

/** 비서별 최소 민감도 (서버 정책) */
const PERSONA_MIN_SENSITIVITY: Record<string, SensitivityLevel> = {
  keeper: 'personal', // 에코: 개인 기록 → 최소 personal
  scheduler: 'personal', // 캘리: 일정/할일 → 최소 personal
  concierge: 'general',
  builder: 'general',
}

export function getPersonaMinSensitivity(personaId: string): SensitivityLevel {
  // 프로토타입 오염 방지: hasOwnProperty로 직접 키 확인
  if (Object.prototype.hasOwnProperty.call(PERSONA_MIN_SENSITIVITY, personaId)) {
    return PERSONA_MIN_SENSITIVITY[personaId]
  }
  return 'general'
}

/** 민감도 순위 (비교용) */
export function rankSensitivity(s: SensitivityLevel): number {
  return s === 'general' ? 0 : s === 'personal' ? 1 : 2
}

/** 두 민감도 중 더 높은 것 반환 */
export function maxSensitivityLevel(a: SensitivityLevel, b: SensitivityLevel): SensitivityLevel {
  return rankSensitivity(a) >= rankSensitivity(b) ? a : b
}

export interface PolicyLike {
  sensitivity?: string
  personaId?: string
  capability?: string
  privacy?: string
}

/**
 * S0.2 (수정): 정책에서 최종 민감도 결정 — 보호 수준의 최댓값
 * - explicit, personaId 하한, capability 추론 중 가장 높은 것을 선택
 * - sensitivity='general'을 명시해도 keeper/scheduler의 personal을 덮어쓸 수 없음
 * - 모두 general이면 undefined (기존 동작 유지)
 */
export function resolvePolicySensitivity(policy: PolicyLike): SensitivityLevel | undefined {
  const valid = (s: string | undefined): SensitivityLevel | undefined =>
    s === 'general' || s === 'personal' || s === 'restricted' ? s : undefined
  const explicit = valid(policy.sensitivity) || 'general'
  const personaMin = policy.personaId ? getPersonaMinSensitivity(policy.personaId) : 'general'
  const capabilityMin: SensitivityLevel =
    policy.capability === 'summarize' || policy.capability === 'schedule' ? 'personal' : 'general'
  // 세 신호 중 가장 높은 보호 수준
  const result = maxSensitivityLevel(maxSensitivityLevel(explicit, personaMin), capabilityMin)
  return result !== 'general' ? result : undefined
}

/**
 * 레거시 마커 도구 (서버 정책)
 * - routes.ts의 마커 후처리와 일치
 * - 비서별 역할에 따라 제한 (서버 측 정의, 클라이언트 조작 불가)
 * - 민감도 판정용 (메모 도구 → personal)
 */
const LEGACY_MARKER_TOOLS: Record<string, string[]> = {
  concierge: [
    'MEMO_SEARCH', 'MEMO_GET', 'MEMO_CREATE', 'MEMO_UPDATE', 'MEMO_DELETE',
    'SCHEDULE_CREATE', 'SCHEDULE_LIST', 'SCHEDULE_UPDATE', 'SCHEDULE_DELETE',
    'TODO_ADD', 'TODO_LIST', 'TODO_DONE', 'TODO_UPDATE', 'TODO_DELETE',
    'CRON_CREATE', 'CRON_LIST', 'CRON_DELETE', 'CRON_TOGGLE',
    'SEARCH', 'IMG', 'GITHUB',
    'GMAIL_SEARCH', 'GMAIL_GET', 'GCAL_LIST', 'GCAL_CREATE',
  ],
  keeper: ['MEMO_SEARCH', 'MEMO_GET', 'MEMO_CREATE', 'MEMO_UPDATE', 'MEMO_DELETE', 'SEARCH', 'CRON_CREATE', 'CRON_LIST', 'CRON_DELETE', 'CRON_TOGGLE'],
  builder: ['SEARCH', 'GITHUB', 'IMG', 'ARTIFACT_CREATE', 'ARTIFACT_DELETE', 'ARTIFACT_FROM_GITHUB'],
  scheduler: [
    'SCHEDULE_CREATE', 'SCHEDULE_LIST', 'SCHEDULE_UPDATE', 'SCHEDULE_DELETE',
    'TODO_ADD', 'TODO_LIST', 'TODO_DONE', 'TODO_UPDATE', 'TODO_DELETE',
    'CRON_CREATE', 'CRON_LIST', 'CRON_DELETE', 'CRON_TOGGLE',
    'SEARCH',
    'GMAIL_SEARCH', 'GMAIL_GET', 'GCAL_LIST', 'GCAL_CREATE',
  ],
}

export function getLegacyMarkerTools(personaId: string): string[] {
  return LEGACY_MARKER_TOOLS[personaId] || LEGACY_MARKER_TOOLS.concierge
}

export interface SensitivityDecision {
  sensitivity: SensitivityLevel
  reason: string
}

/**
 * 요청의 최종 민감도 결정 (서버 측)
 *
 * - 비서별 최소 민감도를 하한으로 적용
 * - 메모 도구 사용 시 personal 이상 (resolveSensitivity가 처리)
 * - 대화 이력의 민감도가 높으면 유지
 */
export function resolveRequestSensitivity(
  personaId: string,
  userText: string,
  availableTools?: string[],
  historySensitivity?: SensitivityLevel
): SensitivityDecision {
  const minSensitivity = getPersonaMinSensitivity(personaId)
  // 레거시 마커 도구를 FC 도구명으로 매핑 (민감도 판정용)
  // MEMO_SEARCH/MEMO_GET → search_memo (개인 데이터 접근)
  const normalizedTools = (availableTools || []).map((t) =>
    t === 'MEMO_SEARCH' || t === 'MEMO_GET' ? 'search_memo' : t
  )
  const resolved = resolveSensitivity({
    text: userText,
    availableTools: normalizedTools,
    historySensitivity,
    minSensitivity,
  })
  return { sensitivity: resolved.sensitivity, reason: resolved.reason }
}

/** 개인정보 보호로 차단됨 */
export class PrivacyBlockedError extends Error {
  constructor(
    message: string,
    public readonly sensitivity: SensitivityLevel,
    public readonly reason: string
  ) {
    super(message)
    this.name = 'PrivacyBlockedError'
  }
}

/**
 * Provider가 민감도 정책을 통과하는지 확인
 */
export function checkProviderAllowed(
  provider: string,
  sensitivity: SensitivityLevel
): { allowed: boolean; reason: string } {
  const router = new ModelRouter()
  return router.canUseProvider(provider as ProviderId, sensitivity)
}

/**
 * S0.1: 데이터 전송 정책만 확인 (운영 상태 제외)
 * - privacy='private' + workers-ai 같은 명시적 내부 처리 선택에 사용
 * - 외부 전송 여부와 릴레이 보안만 판단
 */
export function checkDataPolicy(
  provider: string,
  sensitivity: SensitivityLevel
): { allowed: boolean; reason: string } {
  const router = new ModelRouter()
  return router.canUseProvider(provider as ProviderId, sensitivity, true)
}

/**
 * 민감도에 허용된 Provider만 남기고 필터링
 * 허용 가능한 Provider가 없으면 PrivacyBlockedError
 */
export function filterAllowedProviders<T extends { provider: string }>(
  models: T[],
  sensitivity: SensitivityLevel
): T[] {
  const allowed = models.filter(
    (m) => checkProviderAllowed(m.provider, sensitivity).allowed
  )
  if (allowed.length === 0 && models.length > 0) {
    throw new PrivacyBlockedError(
      '개인정보 보호 정책에 따라 이 요청을 처리할 수 있는 AI 모델이 없습니다.',
      sensitivity,
      'no-allowed-provider'
    )
  }
  return allowed
}
