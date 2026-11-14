// 모델 레지스트리 (무료 티어 기준, 상태 추적)
// src/services/ai.ts에서 순수 이동 (트랙 D, 2026-10-31) — 동작 변경 없음.
import type { ModelDef } from './ai-types'
import type { ProviderId } from './provider-registry'

export type ModelPairValidationCode =
  | 'MODEL_NOT_REGISTERED'
  | 'MODEL_NOT_ACTIVE'
  | 'MODEL_PROVIDER_MISMATCH'
  | 'MODEL_PROVIDER_AMBIGUOUS'

export type ModelPairValidation =
  | { ok: true; model: ModelDef; provider: ProviderId }
  | { ok: false; code: ModelPairValidationCode; error: string; status?: ModelDef['status'] }

/**
 * 기본 모델 (S5-4, 5-9) — 설정(model.code)이 없을 때의 폴백.
 * 2026-10-13 실측 기준 4키 전부 동작하는 1순위 lite 모델.
 * GEMINI_CHAIN의 1순위와 같은 값이다 (ai-model-selection.ts).
 */
export const DEFAULT_MODEL_ID = 'gemini-3.5-flash-lite'

export const MODELS: ModelDef[] = [
  // Gemini — 2026-10-13 12모델×4키 전수 실측
  // - flash(non-lite): 무료 티어 사실상 전멸 (503/타임아웃) → deprecated
  // - 2.5-flash: 키1만 OK, Search grounding 전용으로 유지 (useSearch 시 +50)
  // - 3.5-flash-lite: 4키 전부 OK (1순위), 3.1-flash-lite: 4키 전부 OK (2순위)
  { id: DEFAULT_MODEL_ID, provider: 'gemini', quality: 'fast', status: 'active' },
  { id: 'gemini-3.1-flash-lite', provider: 'gemini', quality: 'fast', status: 'active' },
  { id: 'gemini-2.5-flash', provider: 'gemini', quality: 'fast', status: 'active' }, // 키1만, grounding 전용
  { id: 'gemini-3.8-flash', provider: 'gemini', quality: 'high', status: 'deprecated' }, // 2026-10-13 실측 전멸
  { id: 'gemini-3.7-flash', provider: 'gemini', quality: 'balanced', status: 'deprecated' }, // 3.8로 자동 라우팅
  { id: 'gemini-3.6-flash', provider: 'gemini', quality: 'balanced', status: 'deprecated' }, // 2026-10-13 실측 전멸
  { id: 'gemini-3.5-flash', provider: 'gemini', quality: 'balanced', status: 'deprecated' }, // 2026-10-13 실측 전멸
  // Groq — 2026-10-08 실측 사용 가능 모델 (캘리 전용)
  // qwen 계열은 function calling 할루시네이션으로 제외 (GitHub 이슈 확인)
  { id: 'openai/gpt-oss-20b', provider: 'groq', quality: 'fast', status: 'active' },
  { id: 'llama-3.3-70b-versatile', provider: 'groq', quality: 'balanced', status: 'deprecated' }, // 2026-08-16 Groq 종료
  { id: 'openai/gpt-oss-120b', provider: 'groq', quality: 'high', status: 'active' },
  // Workers AI — 에코 전용
  // 89차: Qwen3 30B-A3B (주력 후보), Granite Micro (저비용 보조 후보) 추가
  { id: '@cf/meta/llama-3.2-1b-instruct', provider: 'workers-ai', quality: 'fast', status: 'active' },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', provider: 'workers-ai', quality: 'balanced', status: 'active' },
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', provider: 'workers-ai', quality: 'high', status: 'active' },
  { id: '@cf/qwen/qwen3-30b-a3b-fp8', provider: 'workers-ai', quality: 'balanced', status: 'active' },
  { id: '@cf/ibm-granite/granite-4.0-h-micro', provider: 'workers-ai', quality: 'fast', status: 'active' },
  // 2026-10-15: Clef 결정 모델 추가 — 라우터용 (사용자 아이디어)
  // Clef-flash: 9B, 39ms, F1 90.93 — 의도 분류용으로 선택
  { id: '@cf/cloudflare/clef-flash', provider: 'workers-ai', quality: 'fast', status: 'active' },
  { id: '@cf/cloudflare/clef', provider: 'workers-ai', quality: 'high', status: 'active' },
  // NVIDIA (OpenAI 호환 API) — 2026-10-30 운영 경로 완전 제외 후,
  // 2026-11-05 GPT 재판정으로 평가 범위에 한해 조건부 재연결.
  // 근거: NVIDIA API Trial Terms §1.2·§1.4 (평가·시험 전용) + §2.6(a)·§4.3
  // (개인정보 포함 금지) — docs/nvidia-terms-review-20261029.md.
  // 재판정의 핵심: MyHub의 지속 개발·통합 테스트·모델 비교는 Developer
  // Program의 개발·연구·평가 목적에 부합하므로, 비서 후보로 다시 연결해
  // 시험하는 것은 허용 범위로 재판정됐다. 단 개인정보·기밀정보 전송 금지
  // (§2.6(a)·§4.3)는 목적과 무관하게 절대 경계로 유지된다.
  // - nemotron-3-ultra(구 에코 핀)만 status='evaluation': selectModel이
  //   providerPin='nvidia'로 명시 지정된 경우에만 선택한다. 'active'만
  //   보는 설정 저장·잡 생성·GET /models·스튜디오 경로는 계속 차단된다.
  // - 나머지 NVIDIA 모델은 deprecated 유지 (무분별한 재노출 금지).
  // - 메모 컨텍스트 턴은 nvidia-memo-guard가 workers-ai로 우회하고, 호출
  //   직전 assert가 이중으로 막는다 — 평가 상태에서도 가드는 상시 강제다.
  // 주의: 'openai/gpt-oss-20b'는 groq 항목이 별도로 active라 캘리 경로는 무영향.
  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', provider: 'nvidia', quality: 'balanced', status: 'deprecated' },
  { id: 'meta/muse-glimmer-30b', provider: 'nvidia', quality: 'balanced', status: 'deprecated' },
  { id: 'google/diffusiongemma-26b-a4b-it', provider: 'nvidia', quality: 'fast', status: 'deprecated' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', provider: 'nvidia', quality: 'high', status: 'evaluation' },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', provider: 'nvidia', quality: 'balanced', status: 'deprecated' },
  { id: 'nvidia/nemotron-3-super-120b-a12b', provider: 'nvidia', quality: 'high', status: 'deprecated' },
  { id: 'openai/gpt-oss-20b', provider: 'nvidia', quality: 'fast', status: 'deprecated' },
]

export function validateModelProviderPair(
  modelId: string,
  provider?: ProviderId,
  opts?: { allowedProviders?: ProviderId[] },
): ModelPairValidation {
  const candidates = MODELS.filter((m) => m.id === modelId)
  if (candidates.length === 0) {
    return { ok: false, code: 'MODEL_NOT_REGISTERED', error: `MODEL_NOT_REGISTERED: ${modelId}` }
  }
  const active = candidates.filter((m) => m.status === 'active')
  if (active.length === 0) {
    return {
      ok: false,
      code: 'MODEL_NOT_ACTIVE',
      status: candidates[0].status,
      error: `MODEL_NOT_ACTIVE: ${modelId} (status=${candidates[0].status})`,
    }
  }
  let chosen: ModelDef
  if (provider) {
    const matched = active.find((m) => m.provider === provider)
    if (!matched) {
      const canonical = [...new Set(active.map((m) => m.provider))].join('/')
      return {
        ok: false,
        code: 'MODEL_PROVIDER_MISMATCH',
        error: `MODEL_PROVIDER_MISMATCH: ${modelId} is ${canonical}, not ${provider}`,
      }
    }
    chosen = matched
  } else {
    const providers = [...new Set(active.map((m) => m.provider))]
    if (providers.length > 1) {
      return {
        ok: false,
        code: 'MODEL_PROVIDER_AMBIGUOUS',
        error: `MODEL_PROVIDER_AMBIGUOUS: ${modelId} has multiple active providers (${providers.join('/')}) — provider를 명시해야 합니다`,
      }
    }
    chosen = active[0]
  }
  if (opts?.allowedProviders && !opts.allowedProviders.includes(chosen.provider)) {
    return {
      ok: false,
      code: 'MODEL_PROVIDER_MISMATCH',
      error: `MODEL_PROVIDER_MISMATCH: ${modelId} is ${chosen.provider}, expected one of ${opts.allowedProviders.join('/')}`,
    }
  }
  return { ok: true, model: chosen, provider: chosen.provider }
}

export function defaultModelForProvider(provider: ProviderId): ModelDef | null {
  return MODELS.find((m) => m.provider === provider && m.status === 'active') ?? null
}
