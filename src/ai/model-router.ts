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

import type { ProviderId } from '../services/provider-registry'
import {
  classifySensitivity,
  resolveSensitivity,
  type SensitivityLevel,
  type SensitivityContext,
} from './sensitivity'
import { FC_VERIFIED_MODELS, type VerifiedModel } from './verified-models'
import { PROVIDER_DATA_USE, dataUseRank, type ProviderDataUse } from '../services/provider-allocation'

// 민감도·검증 모델은 전용 모듈이 정본이다 (구 import 경로 호환용 재노출).
export {
  classifySensitivity,
  resolveSensitivity,
  sensitivityRank,
  maxSensitivity,
  type SensitivityLevel,
  type SensitivityContext,
} from './sensitivity'
export { FC_VERIFIED_MODELS, isVerifiedModel, type VerifiedModel } from './verified-models'

// ---------------------------------------------------------------------------
// 타입 정의
// ---------------------------------------------------------------------------

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
  /** 데이터 사용 정책 (학습 사용 여부 — provider-allocation이 정본) */
  dataUse: ProviderDataUse
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
    dataUse: PROVIDER_DATA_USE['groq'],
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
    dataUse: PROVIDER_DATA_USE['gemini'],
  })

  policies.set('nvidia', {
    provider: 'nvidia',
    status: 'verified', // 2026-10-13: 키 3개 실측 성공 (사용자 PC PowerShell)
    allowGeneral: true,
    allowPersonal: true,
    allowRestricted: false,
    viaRelay: false,
    relaySecurityVerified: true, // 릴레이 미사용
    dataUse: PROVIDER_DATA_USE['nvidia'],
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
    dataUse: PROVIDER_DATA_USE['workers-ai'],
  })

  return policies
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
      const policy = this.policies.get(m.provider)
      // 민감 요청에서는 데이터 사용 정책(학습 미사용)을 최우선으로 반영
      if (sensitivity !== 'general') {
        const du = policy?.dataUse ?? PROVIDER_DATA_USE[m.provider]
        const r = du === 'no-train' ? 0 : du === 'may-use' ? 1 : dataUseRank(m.provider)
        score += (2 - r) * 100
      }
      // 검증된 Provider 우선 (모두 verified이므로 동점)
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
