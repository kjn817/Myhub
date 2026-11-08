// 설정 조회/저장(D1 ai_settings) + 모델 선택 (정책 중심 + 사용자 오버라이드)
// src/services/ai.ts에서 순수 이동 (트랙 D, 2026-10-31) — 동작 변경 없음.
import { MODELS } from './ai-models'
import type { ModelDef, TaskPolicy } from './ai-types'
import { dataUseRank } from './provider-allocation'
import {
  checkProviderAllowed,
  checkDataPolicy,
  resolvePolicySensitivity,
  PrivacyBlockedError,
} from '../ai/legacy-privacy-guard'

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  try {
    const r = await db.prepare('SELECT value FROM ai_settings WHERE key = ?').bind(key).first<{ value: string }>()
    return r?.value ?? null
  } catch {
    return null
  }
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO ai_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')")
    .bind(key, value)
    .run()
}

// Gemini 명시적 폴백 체인 — 2026-10-13 실측 기준 살아있는 lite 모델만
// (3.8/3.7/3.5/3.6-flash는 무료 티어 전멸로 체인에서 제외, 3.7은 어차피 3.8로 라우팅)
const GEMINI_CHAIN = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']

export function isModelSelectableForPolicy(m: ModelDef, policy: TaskPolicy): boolean {
  if (m.status === 'active') return true
  if (m.status === 'evaluation') return policy.providerPin === m.provider
  return false
}

export async function selectModel(db: D1Database, policy: TaskPolicy, exclude: Set<string> = new Set(), execContext?: { providerCallAttempted: boolean; lastProviderError: any }): Promise<ModelDef> {
  // GPT 94차: 진입 시점 진단
  console.error('selectModel_enter', {
    persona: (policy as any).personaId,
    providerPin: policy.providerPin,
    capability: policy.capability,
    privacy: policy.privacy,
    sensitivity: (policy as any).sensitivity,
  })
  // Phase 3D-P S0.1/S0.2: 민감도 결정 (fail-closed)
  // - policy.sensitivity > personaId 하한 > capability 추론 순
  // - privacy='private'이면 workers-ai 전용이지만 데이터 정책 검사는 수행
  const isPrivate = policy.privacy === 'private'
  const sensitivity = resolvePolicySensitivity(policy)
  // Phase 3D-P: Provider 정책을 확인하는 헬퍼
  // - 운영 상태(verified/unverified)는 민감도와 무관하게 항상 검사 (2026-10-13 버그 수정)
  // - private이면 데이터 정책만 확인 (운영 상태 제외, 관리자의 명시적 선택)
  const isProviderAllowed = (provider: string): boolean => {
    if (isPrivate) {
      if (!sensitivity) return true
      return checkDataPolicy(provider, sensitivity).allowed
    }
    // 운영 상태는 항상 검사: 'general'로 조회하면 상태 검사만 수행됨
    // (모든 provider가 general을 허용하므로 민감도 검사는 통과)
    if (!checkProviderAllowed(provider, 'general').allowed) return false
    // 민감도가 있을 때만 데이터 정책 검사
    if (!sensitivity) return true
    return checkProviderAllowed(provider, sensitivity).allowed
  }

  // builder(nova)는 Gemini 고정 (2026-10-15: NVIDIA 코딩 모델 전멸로 nvidia → gemini 변경)
  if ((policy as any).personaId === 'builder' || policy.capability === 'code') {
    const codeOverride = await getSetting(db, 'model.code')
    const modelId = codeOverride || 'gemini-3.5-flash-lite'
    const m = MODELS.find((x) => x.id === modelId && x.provider === 'gemini')
    if (m && isModelSelectableForPolicy(m, policy) && !exclude.has(m.id) && (!policy.providerPin || policy.providerPin === m.provider) && !(isPrivate && m.provider !== 'workers-ai') && isProviderAllowed(m.provider)) {
      console.error('selectModel_builder_direct', { modelId: m.id, provider: m.provider })
      return m
    }
    console.error('selectModel_builder_fallthrough', { modelId, excluded: exclude.has(modelId) })
  }

  // 비서별 전용 프로바이더 고정 (2026-10-13, 사용자 확정 매핑)
  // - 고정되면 체인·오버라이드·후보 모두 해당 provider 내에서만 선택
  // - 프로바이더 간 폴백 없음 (루미=gemini, 에코=workers-ai, 노바=gemini, 캘리=groq)
  //   유일한 예외는 aiChat의 뉴런 소진 degraded 재시도(Workers AI → Gemini lite 1회)
  const scopedModels = policy.providerPin
    ? MODELS.filter((m) => m.provider === policy.providerPin)
    : MODELS

  // 명시적 Gemini 체인: 체인 내 모델이 실패했으면 다음 체인 모델 우선
  // 단, 이미 2개 이상의 Gemini 모델이 실패했으면 체인 중단 (무한 루프 방지)
  const geminiFailed = [...exclude].filter((id) => id.startsWith('gemini-')).length
  if (geminiFailed < 2) {
    for (const failedId of exclude) {
      const chainIdx = GEMINI_CHAIN.indexOf(failedId)
      if (chainIdx >= 0 && chainIdx + 1 < GEMINI_CHAIN.length) {
        const nextId = GEMINI_CHAIN[chainIdx + 1]
        if (!exclude.has(nextId)) {
          const m = scopedModels.find((x) => x.id === nextId && x.status === 'active')
          // Phase 3D-P: 체인도 민감도 정책 우회 불가
          if (m && isProviderAllowed(m.provider)) {
            if (!(policy.privacy === 'private' && m.provider !== 'workers-ai')) return m
          }
        }
      }
    }
  }
  // 사용자 오버라이드: model.<capability> (고정 프로바이더 내 모델만 유효)
  const override = await getSetting(db, `model.${policy.capability}`)
  if (override && !exclude.has(override)) {
    const m = scopedModels.find((x) => x.id === override && isModelSelectableForPolicy(x, policy))
    // Phase 3D-P: 오버라이드도 민감도 정책 우회 불가
    if (m && isProviderAllowed(m.provider)) {
      // privacy=private인데 외부 모델이면 무시
      if (!(policy.privacy === 'private' && m.provider !== 'workers-ai')) return m
    } else if (!m) {
      const known = MODELS.find((x) => x.id === override)
      console.warn('selectModel_override_not_applied', {
        persona: policy.personaId,
        capability: policy.capability,
        override,
        providerPin: policy.providerPin ?? null,
        reason: !known ? 'unknown-model' : known.provider !== policy.providerPin ? 'outside-pin-scope' : 'not-selectable',
      })
    }
  }
  // privacy=private → Workers AI만
  const rejectionReasons: string[] = []
  const candidates = scopedModels.filter((m) => {
    if (!isModelSelectableForPolicy(m, policy)) { rejectionReasons.push(m.status === 'evaluation' ? `${m.id}:status=evaluation-not-pinned` : `${m.id}:status=${m.status}`); return false }
    if (exclude.has(m.id)) { rejectionReasons.push(`${m.id}:excluded`); return false }
    if (policy.privacy === 'private' && m.provider !== 'workers-ai') { rejectionReasons.push(`${m.id}:private-policy`); return false }
    // Phase 3D-P: 민감도 정책으로 Provider 필터링
    if (!isProviderAllowed(m.provider)) { rejectionReasons.push(`${m.id}:provider-not-allowed:${m.provider}`); return false }
    return true
  })
  if (candidates.length === 0) {
    // GPT 94차: 모델 선택 진단 로그
    console.error('selectModel_no_candidates', {
      persona: policy.personaId,
      providerPin: policy.providerPin,
      capability: policy.capability,
      requestedModel: override,
      candidateCount: scopedModels.length,
      eligibleCount: candidates.length,
      rejectionReasons: rejectionReasons.slice(0, 10),
      sensitivity,
    })
    // Phase 3D-P: 민감도 때문에 선택할 모델이 없으면 안전하게 종료 (조용한 우회 금지)
    if (sensitivity) {
      // 오류 분류: 실제 Provider 호출 여부에 따라 구분
      // - 호출 시도 없음 + 후보 없음 → 개인정보 정책 차단 (403)
      // - 호출 시도 있음 + 모두 실패 → Provider 장애 (502)
      const wasCallAttempted = execContext?.providerCallAttempted ?? exclude.size > 0
      if (!wasCallAttempted) {
        throw new PrivacyBlockedError(
          '개인정보 보호 정책에 따라 이 요청을 처리할 수 있는 AI 모델이 없습니다.',
          sensitivity,
          'no-allowed-provider'
        )
      } else {
        // Provider 실패로 인한 후보 소진 → 개인정보 차단으로 오인하지 않음
        // 마지막 Provider 오류 정보를 보존
        const lastErr = execContext?.lastProviderError
        const err = new Error('All allowed providers failed') as any
        err.code = 502
        err.reason = 'provider-exhausted'
        err.excludedModels = [...exclude]
        if (lastErr) {
          err.lastProviderError = {
            code: lastErr.code,
            errorType: lastErr.errorType,
            errorCode: lastErr.errorCode,
          }
        }
        throw err
      }
    }
    throw new Error('no active model for policy')
  }

  // latency=interactive → groq 우선, quality 매칭
  const rank = (m: ModelDef): number => {
    let s = 0
    if (sensitivity) s += (2 - dataUseRank(m.provider)) * 1000
    if (policy.latency === 'interactive' && m.provider === 'groq') s += 10
    if (policy.quality === 'high' && m.quality === 'high') s += 5
    if (policy.quality === 'fast' && m.quality === 'fast') s += 5
    if (policy.quality === 'balanced' && m.quality === 'balanced') s += 5
    // 한국어 작업 및 실시간 정보는 gemini 우선 (Google Search 내장)
    // Groq의 interactive 보너스(+10)를 능가하도록 +20
    if (policy.capability === 'summarize' || policy.capability === 'translate' || policy.capability === 'chat') {
      if (m.provider === 'gemini') s += 20
    }
    // 웹검색 필요시 gemini-2.5-flash 우선 (무료 티어에서 Search 지원 유일)
    if (policy.useSearch && m.id === 'gemini-2.5-flash') s += 50
    return s
  }
  candidates.sort((a, b) => rank(b) - rank(a))
  return candidates[0]
}
