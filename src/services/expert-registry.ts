/**
 * 전문가(Expert) 레지스트리 — Octop 전문가 라이브러리 패턴 이식
 *
 * MyHub 비서 4명의 페르소나·능력·프로바이더·채널·cron 설정을 한곳에서 관리한다.
 * - 단일 진실 원천(Single Source of Truth): 프로바이더 핀은 여기서만 정의하고
 *   routes.ts의 PERSONA_PROVIDER 하드코딩을 대체한다.
 *   (2026-10-15 사용자 확정: 루미=gemini, 에코=nvidia, 노바=gemini, 캘리=groq)
 *   (2026-10-30 변경: NVIDIA Trial 약관 판정으로 에코=nvidia → workers-ai.
 *    NVIDIA는 운영 경로에서 완전 제외 — docs/nvidia-terms-review-20261029.md,
 *    docs/nvidia-replacement-measurement-20261030.md)
 * - 시스템 프롬프트 본문은 ai.ts PERSONAS에 그대로 둔다 (중복 정의 금지).
 *   레지스트리는 설정·메타데이터만 들고, 프롬프트는 참조하지 않는다.
 * - 도구 허용 목록은 기존 getLegacyMarkerTools를 그대로 재사용한다 (중복 금지).
 * - ID는 레거시(concierge/keeper/builder/scheduler)를 정식 키로 쓰고,
 *   신규(lumi/echo/nova/cali)는 persona-id-adapter로 정규화해 받는다.
 */

import { getLegacyMarkerTools } from '../ai/legacy-privacy-guard'
import {
  normalizeLegacyPersonaId,
  type LegacyPersonaId,
  type NewPersonaId,
} from './persona-id-adapter'
import type { ProviderId } from './provider-registry'

export type ExpertCapability = 'chat' | 'summarize' | 'code' | 'schedule'

export type ExpertChannel = 'chat' | 'push' | 'cron'

export interface ExpertConfig {
  /** 정식 키 (레거시 ID) */
  legacyId: LegacyPersonaId
  /** 신규 ID (라우터/Clef 계열) */
  newId: NewPersonaId
  /** 한국어 이름 */
  name: string
  /** 역할 한 줄 설명 */
  role: string
  /** 담당 능력 (라우터 카테고리와 동일) */
  capability: ExpertCapability
  /** 전용 프로바이더 핀 (폴백 없음) */
  provider: ProviderId
  /** 메모 턴 전용 프로바이더 핀 (있으면 메모 턴에서 provider 대신 사용) */
  memoTurnProvider?: ProviderId
  /** 이 전문가가 응답할 수 있는 채널 */
  channels: ExpertChannel[]
  /** 아침 브리핑 소유 여부 (대표 비서만 true) */
  ownsBriefing: boolean
  /** 일정 리마인더 소유 여부 */
  ownsReminders: boolean
}

/**
 * 전문가 4명 — 순서 = 대표 비서 우선.
 * capability/provider는 routes.ts의 PERSONA_POLICY/PERSONA_PROVIDER와
 * 동일한 값이어야 하며, 테스트가 양쪽 일치를 강제한다.
 */
export const EXPERTS: ReadonlyArray<ExpertConfig> = [
  {
    legacyId: 'concierge',
    newId: 'lumi',
    name: '루미',
    role: '대표 비서 — 대화와 요청 분류, 아침 브리핑',
    capability: 'chat',
    provider: 'gemini',
    channels: ['chat', 'push', 'cron'],
    ownsBriefing: true,
    ownsReminders: false,
  },
  {
    legacyId: 'keeper',
    newId: 'echo',
    name: '에코',
    role: '민감 메모 전담 — 요약·태그·검색',
    capability: 'summarize',
    provider: 'nvidia',
    memoTurnProvider: 'workers-ai',
    channels: ['chat'],
    ownsBriefing: false,
    ownsReminders: false,
  },
  {
    legacyId: 'builder',
    newId: 'nova',
    name: '노바',
    role: '코드·AI 스튜디오 전담',
    capability: 'code',
    provider: 'gemini',
    channels: ['chat'],
    ownsBriefing: false,
    ownsReminders: false,
  },
  {
    legacyId: 'scheduler',
    newId: 'cali',
    name: '캘리',
    role: '일정·할 일 전담 — 리마인더',
    capability: 'schedule',
    provider: 'groq',
    channels: ['chat', 'push', 'cron'],
    ownsBriefing: false,
    ownsReminders: true,
  },
]

const BY_LEGACY: ReadonlyMap<LegacyPersonaId, ExpertConfig> = new Map(
  EXPERTS.map((e) => [e.legacyId, e]),
)

/**
 * 레거시/신규 어느 ID로든 전문가 조회. 유효하지 않으면 null.
 * (deny-by-default: 모르는 ID는 절대 기본값으로 승격하지 않음)
 */
export function getExpert(id: unknown): ExpertConfig | null {
  const legacyId = normalizeLegacyPersonaId(id)
  if (!legacyId) return null
  return BY_LEGACY.get(legacyId) ?? null
}

/**
 * 이미 검증된 레거시 ID로 프로바이더 핀을 직접 조회 (정규화 호출 없음).
 * 호출부에서 PERSONAS 대조로 ID가 검증된 경우에 쓴다 — 같은 요청 안에서
 * normalizeLegacyPersonaId를 중복 호출하지 않기 위함.
 */
export function getExpertProviderByLegacyId(legacyId: string): ProviderId | null {
  return BY_LEGACY.get(legacyId as LegacyPersonaId)?.provider ?? null
}

export function overrideProviderForCapability(capability: string): ProviderId | undefined {
  const expert = EXPERTS.find((e) => e.capability === capability)
  if (!expert) return undefined
  return expert.memoTurnProvider ?? expert.provider
}

/**
 * 이미 검증된 레거시 ID로 담당 능력을 직접 조회 (정규화 호출 없음).
 * planTeam처럼 라우터가 이미 검증한 레거시 ID로 단계를 만들 때 쓴다 —
 * 같은 요청 안에서 normalizeLegacyPersonaId를 중복 호출하지 않기 위함
 * (getExpertProviderByLegacyId와 동일 패턴).
 */
export function getExpertCapabilityByLegacyId(legacyId: string): ExpertCapability | null {
  return BY_LEGACY.get(legacyId as LegacyPersonaId)?.capability ?? null
}

/**
 * 비서의 허용 마커 도구 목록.
 * 기존 getLegacyMarkerTools를 그대로 재사용 — 여기서 목록을 재정의하지 않음.
 */
export function getExpertTools(id: unknown): string[] {
  const expert = getExpert(id)
  if (!expert) return []
  return getLegacyMarkerTools(expert.legacyId)
}
