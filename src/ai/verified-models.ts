/**
 * FC용 검증 모델 레지스트리 (Phase 2B)
 * (모델 라우터에서 분리: FC 경로의 다른 소비자도 같은 레지스트리를 본다.)
 */

import type { ProviderId } from '../services/provider-registry'

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
