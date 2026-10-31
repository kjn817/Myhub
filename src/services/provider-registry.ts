/**
 * 프로바이더 플러그인 레지스트리 (OpenClaw 패턴 이식 — 트랙 5)
 *
 * "모델은 플러그인": 비서별 프로바이더 핀을 하드코딩된 상수가 아니라
 * 갈아끼울 수 있는 플러그인으로 관리한다.
 * - ProviderPlugin: 식별자(id) + 모델 목록(listModels) + 호출 함수(call)
 * - 기본 핀(루미=gemini, 에코=workers-ai, 노바=gemini, 캘리=groq)은
 *   전문가 레지스트리(EXPERTS)가 단일 원천이다.
 *   (2026-10-30: 에코 nvidia → workers-ai — NVIDIA 운영 경로 제외)
 * - 새 프로바이더 추가 = registerProvider 1회 호출 (aiChat/selectModel 수정 불필요)
 * - 교체 시 registerProvider(plugin, { replace: true }) — 마지막 등록이 승리
 *
 * 의존 방향: 이 모듈은 src/services/ai의 타입만 import(type-only)한다.
 * 런타임에는 ai.ts를 import하지 않으므로 순환 의존이 없다.
 * 실제 플러그인 등록은 src/services/ai.ts 모듈 로드 시 수행된다.
 * 핀 정의는 전문가 레지스트리(expert-registry.ts)가 단일 원천으로 소유하고,
 * 아래 PERSONA_PROVIDER_PIN은 그 파생 뷰이다 (2026-10-25 병합 시 통일).
 * expert-registry의 런타임 의존은 legacy-privacy-guard → model-router
 * (leaf, ai는 type-only)뿐이라 provider-registry → expert-registry
 * 방향에는 순환이 없다.
 */

import type { ChatMessage, ModelDef } from './ai'
import { getExpertProviderByLegacyId } from './expert-registry'

export type ProviderId = 'gemini' | 'groq' | 'workers-ai' | 'nvidia'

export interface ProviderCallInput {
  env: any
  /** API 키 (Workers AI는 바인딩 사용이라 null) */
  key: string | null
  model: string
  messages: ChatMessage[]
  /** Gemini 웹검색 grounding 사용 여부 */
  useSearch?: boolean
  /** 개인정보 민감도 (서버 결정값) */
  sensitivity?: string
  signal?: AbortSignal
  /** Function Calling 도구 정의 (Workers AI keeper 경로) */
  tools?: any[]
}

export interface ProviderCallResult {
  text: string
  inputTokens?: number
  outputTokens?: number
  /** Workers AI 뉴런 소비량 (뉴런 예산 관측용 — 다른 프로바이더는 미제공) */
  neurons?: number
  sources?: { title: string; url: string }[]
  toolCalls?: any[]
  finishReason?: string
}

/**
 * 프로바이더 플러그인 인터페이스
 * - id: ProviderId (레지스트리 키)
 * - displayName: 사람용 이름
 * - listModels: 이 프로바이더가 제공하는 모델 목록 (MODELS에서 필터링)
 * - call: 실제 1회 호출 (키 풀·쿨다운은 호출자(aiChat)가 담당)
 */
export interface ProviderPlugin {
  id: ProviderId
  displayName: string
  listModels(): ModelDef[]
  call(input: ProviderCallInput): Promise<ProviderCallResult>
}

const plugins = new Map<ProviderId, ProviderPlugin>()

export function registerProvider(plugin: ProviderPlugin, opts?: { replace?: boolean }): void {
  if (!plugin || !plugin.id) throw new Error('registerProvider: plugin.id required')
  if (typeof plugin.call !== 'function') throw new Error(`registerProvider: plugin ${plugin.id} has no call()`)
  if (typeof plugin.listModels !== 'function') throw new Error(`registerProvider: plugin ${plugin.id} has no listModels()`)
  if (plugins.has(plugin.id) && !opts?.replace) {
    throw new Error(`registerProvider: provider already registered: ${plugin.id} (use { replace: true } to swap)`)
  }
  plugins.set(plugin.id, plugin)
}

export function getProvider(id: ProviderId): ProviderPlugin | undefined {
  return plugins.get(id)
}

export function isProviderRegistered(id: ProviderId): boolean {
  return plugins.has(id)
}

export function listProviders(): ProviderPlugin[] {
  return [...plugins.values()]
}

/** 해당 프로바이더의 모델 목록 (미등록 시 빈 배열 — fail-open이 아니라 호출부에서 별도 처리) */
export function getProviderModels(id: ProviderId): ModelDef[] {
  return plugins.get(id)?.listModels() ?? []
}

/** 테스트용: 등록 해제 (운영 코드에서 호출 금지) */
export function unregisterProvider(id: ProviderId): boolean {
  return plugins.delete(id)
}

// ---------------------------------------------------------------------------
// 비서별 기본 프로바이더 핀 (2026-10-15 사용자 확정, 2026-10-21 코드 반영)
// - 루미(concierge)=gemini, 에코(keeper)=workers-ai, 노바(builder)=gemini, 캘리(scheduler)=groq
//   (2026-10-30: 에코 nvidia → workers-ai — NVIDIA 운영 경로 제외)
// - src/modules/ai/routes.ts의 PERSONA_PROVIDER를 여기로 이동 (동작 동일)
// ---------------------------------------------------------------------------

// 단일 진실 원천은 전문가 레지스트리(EXPERTS)이다. 아래는 파생 뷰 —
// 두 곳에 같은 매핑을 리터럴로 두지 않는다 (2026-10-25 병합 시 통일).
// EXPERTS에 없는 비서는 getExpertProviderByLegacyId가 null을 돌려주고,
// 그 경우 concierge 핀(gemini)으로 폴백한다.
const PIN_LEGACY_IDS = ['concierge', 'keeper', 'builder', 'scheduler'] as const
export const PERSONA_PROVIDER_PIN: Readonly<Record<string, ProviderId>> = Object.freeze(
  Object.fromEntries(
    PIN_LEGACY_IDS.map((id) => [id, getExpertProviderByLegacyId(id) ?? 'gemini']),
  ) as Record<string, ProviderId>,
)

/** 비서별 프로바이더 핀 조회 — 알 수 없는 비서는 concierge 핀(gemini)으로 폴백 */
export function resolvePersonaProvider(personaId: string): ProviderId {
  return PERSONA_PROVIDER_PIN[personaId] ?? PERSONA_PROVIDER_PIN.concierge
}
