/**
 * Phase 2A — 모델 라우팅 정책 및 Fallback 안전성 판단
 *
 * 목표: 요청의 성격, 개인정보 민감도, Provider 가용성, 무료 사용량을 고려해
 * 안전하게 모델을 선택하는 공통 Router.
 *
 * - 기존 운영 채팅의 selectModel()은 변경하지 않음 (레거시 경로 유지)
 * - 이 Router는 Function Calling 경로에서만 사용
 * - 기존 MODELS 설정을 재사용하고, 모델 ID를 하드코딩하지 않음
 * - 실제 Fallback 실행은 Phase 2B에서 구현 (여기서는 판단 인터페이스만)
 */

import type { ProviderId } from '../services/ai'

// ---------------------------------------------------------------------------
// 타입 정의
// ---------------------------------------------------------------------------

/** 요청 민감도 수준 */
export type SensitivityLevel = 'general' | 'personal' | 'restricted'

/** Provider 상태 */
export type ProviderStatus = 'verified' | 'unavailable' | 'unverified' | 'disabled'

/** Provider별 데이터 전송 정책 */
export interface ProviderPolicy {
  provider: ProviderId
  status: ProviderStatus
  /** 민감도별 외부 전송 허용 여부 */
  allowGeneral: boolean
  allowPersonal: boolean
  allowRestricted: boolean
  /** 릴레이 경유 여부 */
  viaRelay: boolean
  /** 릴레이 보안 검증 완료 여부 */
  relaySecurityVerified: boolean
}

/** 라우팅 요청 */
export interface RouteRequest {
  /** 사용자 요청 텍스트 (민감도 분류용) */
  text: string
  /** 명시적 민감도 (없으면 자동 분류) */
  sensitivity?: SensitivityLevel
  /** 작업 유형 */
  capability: string
  /** 제외할 Provider */
  excludeProviders?: Set<ProviderId>
  /** 제외할 모델 ID */
  excludeModels?: Set<string>
  /** 세션 컨텍스트 (민감도 정교화용) */
  sensitivityContext?: Omit<SensitivityContext, 'text'>
}

/** 라우팅 결정 */
export interface RouteDecision {
  provider: ProviderId
  model: string
  /** 선택 이유 (개인정보 없이 기록) */
  reason: string
}

/** Fallback 판단 요청 */
export interface FallbackRequest {
  /** 실패한 Provider */
  failedProvider: ProviderId
  /** 실패한 모델 */
  failedModel: string
  /** 오류 코드 (예: 'RATE_LIMITED', 'AUTH_ERROR', 'TIMEOUT') */
  errorCode: string
  /** HTTP 상태 코드 */
  httpStatus?: number
  /** 이미 도구가 실행되었는지 */
  toolsExecuted: boolean
  /** 쓰기 작업이 수행되었는지 (불확실한 상태) */
  writeUncertain: boolean
  /** 요청 민감도 */
  sensitivity: SensitivityLevel
  /** 이미 시도한 Provider/모델 */
  triedProviders: Set<ProviderId>
  /** Fallback 시도 횟수 */
  fallbackCount: number
}

/** Fallback 판단 결과 */
export interface FallbackDecision {
  allowed: boolean
  candidate?: { provider: ProviderId; model: string }
  /** 판단 이유 (개인정보 없이 기록) */
  reason: string
}

// ---------------------------------------------------------------------------
// Provider 정책 (초기값)
// ---------------------------------------------------------------------------

/**
 * Provider별 정책 초기값
 * - Groq, Gemini: Phase 1G-S 스테이징 검증 성공 → verified
 * - Workers AI: 미검증 → unverified (선택되지 않음)
 *
 * 주의: verified는 기술적 동작 확인일 뿐, 민감도별 전송 권한과 별개
 */
function getDefaultPolicies(): Map<ProviderId, ProviderPolicy> {
  const policies = new Map<ProviderId, ProviderPolicy>()

  policies.set('groq', {
    provider: 'groq',
    status: 'verified',
    allowGeneral: true,
    allowPersonal: true,
    // Groq는 외부 API이므로 인증정보 등 제한 정보는 전송 금지
    allowRestricted: false,
    viaRelay: false,
    relaySecurityVerified: true, // 릴레이 미사용
  })

  policies.set('gemini', {
    provider: 'gemini',
    status: 'verified',
    allowGeneral: true,
    // 2026-10-13 모델별 조건 확인: 직접 호출은 릴레이를 거치지 않으므로 personal 허용.
    // 릴레이 경유 시에는 callGemini에서 personal 이상을 별도 차단 (릴레이 보안 미검증)
    allowPersonal: true,
    allowRestricted: false,
    viaRelay: true,
    relaySecurityVerified: false, // 아직 미확인
  })

  policies.set('nvidia', {
    provider: 'nvidia',
    status: 'verified', // 2026-10-13: 키 3개 실측 성공 (사용자 PC PowerShell)
    allowGeneral: true,
    allowPersonal: true,
    allowRestricted: false,
    viaRelay: false,
    relaySecurityVerified: true, // 릴레이 미사용
  })

  policies.set('workers-ai', {
    provider: 'workers-ai',
    status: 'verified', // 2026-10-13: 운영 실측으로 검증 (에코 활성화)
    // Cloudflare 내부 처리이지만 로컬이 아님 — restricted는 별도 승인 없이 차단
    allowGeneral: true,
    allowPersonal: true,
    allowRestricted: false,
    viaRelay: false,
    relaySecurityVerified: true,
  })

  return policies
}

// ---------------------------------------------------------------------------
// 민감도 분류
// ---------------------------------------------------------------------------

/** 제한 정보 패턴 (API 키, 비밀번호, 카드번호 등) */
const RESTRICTED_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,           // OpenAI 스타일 API 키
  /AIza[a-zA-Z0-9_-]{20,}/,        // Google API 키
  /xox[bap]-[a-zA-Z0-9-]+/,        // Slack 토큰
  /ghp_[a-zA-Z0-9]{20,}/,          // GitHub 토큰
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/, // 카드번호 패턴
  /비밀번호|패스워드|password\s*[:=]/i,
  /api[_-]?key\s*[:=]/i,
  /secret\s*[:=]/i,
]

/** 개인 정보 관련 키워드 */
const PERSONAL_KEYWORDS = [
  '메모', '기억', '일정', '스케줄', '할일', '할 일', '약속',
  '다이어리', '일기', '개인', '프라이빗', '비밀',
]

/**
 * 세션 컨텍스트 (민감도 분류용)
 * GPT Phase 2B 지침: 키워드만이 아닌 세션 전체 컨텍스트 고려
 */
export interface SensitivityContext {
  /** 현재 사용자 입력 */
  text: string
  /** 이전 대화 이력의 최고 민감도 (없으면 undefined) */
  historySensitivity?: SensitivityLevel
  /** 이번 요청에서 활성화 가능한 도구 이름 목록 */
  availableTools?: string[]
  /** 서버 정책상 최소 민감도 (예: 특정 비서는 항상 personal 이상) */
  minSensitivity?: SensitivityLevel
}

/**
 * 민감도 등급 비교 (높을수록 제한적)
 */
function sensitivityRank(s: SensitivityLevel): number {
  return s === 'general' ? 0 : s === 'personal' ? 1 : 2
}

function maxSensitivity(...levels: (SensitivityLevel | undefined)[]): SensitivityLevel {
  let result: SensitivityLevel = 'general'
  for (const l of levels) {
    if (l && sensitivityRank(l) > sensitivityRank(result)) {
      result = l
    }
  }
  return result
}

/**
 * 요청 텍스트의 민감도를 분류 (기본, 키워드/패턴 기반)
 * - 모델이 민감도를 낮춰 권한을 획득할 수 없도록 규칙 기반 분류
 * - 이것은 보조 신호이며, 최종 결정은 resolveSensitivity()가 수행
 */
export function classifySensitivity(text: string): SensitivityLevel {
  // 1. 제한 패턴 검사 (최우선)
  for (const pattern of RESTRICTED_PATTERNS) {
    if (pattern.test(text)) {
      return 'restricted'
    }
  }

  // 2. 개인 키워드 검사
  const lowerText = text.toLowerCase()
  for (const keyword of PERSONAL_KEYWORDS) {
    if (lowerText.includes(keyword)) {
      return 'personal'
    }
  }

  // 3. 기본값
  return 'general'
}

/**
 * 최종 민감도 결정 (서버 정책 기반)
 *
 * GPT Phase 2B 지침:
 * - 사용자 메시지의 키워드만으로 최종 결정하지 않음
 * - search_memo가 활성화된 세션은 최소 personal
 * - 대화 이력의 민감도가 높으면 낮추지 않음
 * - 서버 정책의 최소 민감도를 하한으로 적용
 *
 * @returns 최종 민감도와 판단 근거
 */
export function resolveSensitivity(ctx: SensitivityContext): {
  sensitivity: SensitivityLevel
  reason: string
} {
  const textLevel = classifySensitivity(ctx.text)
  const reasons: string[] = [`text:${textLevel}`]

  // 도구 기반 상향: search_memo 등 개인 데이터 접근 도구가 있으면 최소 personal
  let toolLevel: SensitivityLevel | undefined
  const personalTools = ['search_memo']
  if (ctx.availableTools?.some((t) => personalTools.includes(t))) {
    toolLevel = 'personal'
    reasons.push('tool:search_memo→personal')
  }

  const final = maxSensitivity(textLevel, toolLevel, ctx.historySensitivity, ctx.minSensitivity)

  if (ctx.historySensitivity && sensitivityRank(ctx.historySensitivity) > sensitivityRank(textLevel)) {
    reasons.push(`history:${ctx.historySensitivity}`)
  }
  if (ctx.minSensitivity && sensitivityRank(ctx.minSensitivity) > sensitivityRank(textLevel)) {
    reasons.push(`policy-min:${ctx.minSensitivity}`)
  }

  return { sensitivity: final, reason: reasons.join(',') }
}

// ---------------------------------------------------------------------------
// FC용 검증 모델 레지스트리 (Phase 2B)
// ---------------------------------------------------------------------------

/**
 * Function Calling 경로에서 실제 검증된 Provider-모델 매핑
 *
 * Phase 1G-S 스테이징 검증 결과 (2026-10-10):
 * - Groq: openai/gpt-oss-120b 성공
 * - Gemini: gemini-3.5-flash-lite 성공 (릴레이 경유)
 * - Workers AI: 실패 (원인 미확인)
 *
 * 주의: 기존 운영 MODELS 배열은 변경하지 않음.
 * FC 경로에서만 이 매핑을 사용.
 */
export interface VerifiedModel {
  provider: ProviderId
  model: string
  /** 검증일 */
  verifiedAt: string
  /** 검증 방법 */
  verifiedVia: 'staging-e2e' | 'staging-mock'
  /** 비고 */
  note?: string
}

export const FC_VERIFIED_MODELS: VerifiedModel[] = [
  {
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    verifiedAt: '2026-10-10',
    verifiedVia: 'staging-e2e',
    note: 'Phase 1G-S 실제 2회 FC 성공',
  },
  {
    provider: 'gemini',
    model: 'gemini-3.5-flash-lite',
    verifiedAt: '2026-10-10',
    verifiedVia: 'staging-e2e',
    note: 'Phase 1G-S 릴레이 경유 실제 FC 성공',
  },
]

/**
 * 검증된 모델인지 확인
 */
export function isVerifiedModel(provider: ProviderId, model: string): boolean {
  return FC_VERIFIED_MODELS.some((m) => m.provider === provider && m.model === model)
}

/**
 * Provider의 검증된 모델 목록 조회
 */
export function getVerifiedModels(provider: ProviderId): VerifiedModel[] {
  return FC_VERIFIED_MODELS.filter((m) => m.provider === provider)
}

// ---------------------------------------------------------------------------
// Model Router
// ---------------------------------------------------------------------------

export class ModelRouter {
  private policies: Map<ProviderId, ProviderPolicy>

  constructor(policies?: Map<ProviderId, ProviderPolicy>) {
    this.policies = policies || getDefaultPolicies()
  }

  /** Provider 정책 조회 */
  getPolicy(provider: ProviderId): ProviderPolicy | undefined {
    return this.policies.get(provider)
  }

  /** Provider 정책 업데이트 (테스트 및 운영 조정용) */
  setPolicy(provider: ProviderId, policy: Partial<ProviderPolicy>): void {
    const existing = this.policies.get(provider)
    if (existing) {
      this.policies.set(provider, { ...existing, ...policy })
    }
  }

  /**
   * 민감도에 대해 Provider 사용 가능 여부 판단
   * @param skipStatusCheck true이면 운영 상태 검사를 생략 (데이터 정책만 확인)
   *   - privacy='private'처럼 관리자가 명시적으로 내부 처리를 선택한 경우에 사용
   */
  canUseProvider(provider: ProviderId, sensitivity: SensitivityLevel, skipStatusCheck = false): { allowed: boolean; reason: string } {
    const policy = this.policies.get(provider)
    if (!policy) {
      return { allowed: false, reason: `unknown-provider:${provider}` }
    }

    // 상태 검사 (skipStatusCheck이면 생략)
    if (!skipStatusCheck) {
      if (policy.status === 'disabled') {
        return { allowed: false, reason: `provider-disabled:${provider}` }
      }
      if (policy.status === 'unavailable') {
        return { allowed: false, reason: `provider-unavailable:${provider}` }
      }
      if (policy.status === 'unverified') {
        return { allowed: false, reason: `provider-unverified:${provider}` }
      }
    }

    // 민감도별 전송 허용 검사
    if (sensitivity === 'restricted' && !policy.allowRestricted) {
      return { allowed: false, reason: `restricted-not-allowed:${provider}` }
    }
    if (sensitivity === 'personal' && !policy.allowPersonal) {
      return { allowed: false, reason: `personal-not-allowed:${provider}` }
    }
    if (sensitivity === 'general' && !policy.allowGeneral) {
      return { allowed: false, reason: `general-not-allowed:${provider}` }
    }

    // 릴레이 보안 검사 (2026-10-13 변경): 선제 차단에서 호출 시점 검사로 이동
    // - 기존: viaRelay=true면 personal 이상을 무조건 차단 (직접 호출도 막힘)
    // - 변경: 직접 호출은 릴레이를 거치지 않으므로 허용. 실제 릴레이 사용 시점에
    //   callGemini에서 personal/restricted를 차단 (정밀한 enforcement)
    // - 주의: FC 경로(GeminiAdapter)는 릴레이 전용이므로 재활성화 시 별도 검토 필요

    return { allowed: true, reason: `ok:${provider}` }
  }

  /**
   * 요청에 적합한 모델 선택
   * - 기존 MODELS 설정을 재사용 (하드코딩 금지)
   * - 민감도와 Provider 정책을 우선 적용
   * - 세션 컨텍스트가 있으면 resolveSensitivity로 최종 민감도 결정
   */
  route(request: RouteRequest): RouteDecision | null {
    // 민감도 결정: 명시적 값 > 세션 컨텍스트 기반 > 텍스트 키워드
    let sensitivity: SensitivityLevel
    let sensitivityReason: string
    if (request.sensitivity) {
      sensitivity = request.sensitivity
      sensitivityReason = 'explicit'
    } else if (request.sensitivityContext) {
      const resolved = resolveSensitivity({ text: request.text, ...request.sensitivityContext })
      sensitivity = resolved.sensitivity
      sensitivityReason = resolved.reason
    } else {
      sensitivity = classifySensitivity(request.text)
      sensitivityReason = `text:${sensitivity}`
    }

    const excludeProviders = request.excludeProviders || new Set<ProviderId>()
    const excludeModels = request.excludeModels || new Set<string>()

    // 후보 모델 필터링
    // Phase 2B: FC 검증된 모델만 선택 (MODELS 배열이 아닌 FC_VERIFIED_MODELS 사용)
    // 기존 MODELS는 레거시 경로용으로 유지
    const candidates = FC_VERIFIED_MODELS.filter((m) => {
      // 제외 목록
      if (excludeProviders.has(m.provider)) return false
      if (excludeModels.has(m.model)) return false
      // Provider 정책 검사
      const check = this.canUseProvider(m.provider, sensitivity)
      if (!check.allowed) return false
      return true
    })

    if (candidates.length === 0) {
      return null // 안전하게 사용할 수 있는 Provider 없음 → 실행 제한
    }

    // 우선순위: Groq (속도) > Gemini (릴레이)
    // 주의: 기존 selectModel의 gemini 편향(+20)은 적용하지 않음
    // 에코의 메모 요청이 Gemini로 편향되는 문제 방지
    const rank = (m: VerifiedModel): number => {
      let score = 0
      // 검증된 Provider 우선 (모두 verified이므로 동점)
      const policy = this.policies.get(m.provider)
      if (policy?.status === 'verified') score += 10
      // Groq 우선 (직접 호출, 릴레이 불필요)
      if (m.provider === 'groq') score += 5
      // 릴레이 미경유 우선
      if (!policy?.viaRelay) score += 3
      return score
    }

    candidates.sort((a, b) => rank(b) - rank(a))
    const selected = candidates[0]

    return {
      provider: selected.provider,
      model: selected.model,
      reason: `sensitivity:${sensitivity}(${sensitivityReason}),policy-ok:${selected.provider}`,
    }
  }

  /**
   * Fallback 허용 여부 판단 (Phase 2A: 판단만, 실행은 2B)
   */
  decideFallback(request: FallbackRequest): FallbackDecision {
    // 1. Fallback 횟수 제한 (최대 1회)
    if (request.fallbackCount >= 1) {
      return {
        allowed: false,
        reason: 'fallback-limit-exceeded',
      }
    }

    // 2. 도구 실행 이후 자동 재실행 금지
    if (request.toolsExecuted) {
      return {
        allowed: false,
        reason: 'tools-already-executed',
      }
    }

    // 3. 쓰기 불확실 시 자동 재실행 금지
    if (request.writeUncertain) {
      return {
        allowed: false,
        reason: 'write-uncertain',
      }
    }

    // 4. 인증 오류(401/403)는 재시도 금지
    if (request.errorCode === 'AUTH_ERROR' || request.httpStatus === 401 || request.httpStatus === 403) {
      return {
        allowed: false,
        reason: 'auth-error-no-retry',
      }
    }

    // 5. 후보 Provider 탐색 (실패한 Provider 제외)
    const excludeProviders = new Set<ProviderId>([...request.triedProviders, request.failedProvider])
    const candidate = this.route({
      text: '', // 민감도는 명시적으로 전달
      sensitivity: request.sensitivity,
      capability: 'fallback',
      excludeProviders,
    })

    if (!candidate) {
      return {
        allowed: false,
        reason: 'no-fallback-candidate',
      }
    }

    return {
      allowed: true,
      candidate,
      reason: `fallback-to:${candidate.provider}`,
    }
  }
}
