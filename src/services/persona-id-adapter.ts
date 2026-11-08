// 비서 ID 호환 어댑터 (2026-10-15)
// GPT 권고: 전면 마이그레이션 대신 어댑터 방식으로 단계적 통합
// 기존 orchestrator(concierge/keeper/builder/scheduler) ↔ 신규 라우터(lumi/echo/nova/cali)

import type { PersonaId } from './router';

// 기존 ID 타입
export type LegacyPersonaId = 'concierge' | 'keeper' | 'builder' | 'scheduler';

// 신규 ID 타입
export type NewPersonaId = 'lumi' | 'echo' | 'nova' | 'cali';

// 기존 → 신규 매핑
export const LEGACY_TO_NEW: Record<LegacyPersonaId, PersonaId> = {
  concierge: 'lumi',
  keeper: 'echo',
  builder: 'nova',
  scheduler: 'cali',
} as const;

// 신규 → 기존 매핑
export const NEW_TO_LEGACY: Record<NewPersonaId, LegacyPersonaId> = {
  lumi: 'concierge',
  echo: 'keeper',
  nova: 'builder',
  cali: 'scheduler',
} as const;

const LEGACY_IDS = new Set<string>([
  'concierge',
  'keeper',
  'builder',
  'scheduler',
]);

/**
 * 기존 ID를 신규 ID로 변환
 */
export function legacyToNew(legacyId: string): PersonaId | null {
  if (!Object.prototype.hasOwnProperty.call(LEGACY_TO_NEW, legacyId)) {
    return null;
  }
  return (LEGACY_TO_NEW as Record<string, PersonaId>)[legacyId];
}

/**
 * 신규 ID를 기존 ID로 변환
 */
export function newToLegacy(newId: PersonaId): LegacyPersonaId {
  return NEW_TO_LEGACY[newId as NewPersonaId];
}

/**
 * 유효한 기존 ID인지 확인
 */
export function isValidLegacyPersonaId(id: unknown): id is LegacyPersonaId {
  return (
    id === 'concierge' ||
    id === 'keeper' ||
    id === 'builder' ||
    id === 'scheduler'
  );
}

/**
 * 신규 또는 기존 ID를 기존 ID로 정규화 (GPT 권장)
 * 권한 검사 직전에 사용. 서버가 확정한 비서 ID를 전달해야 함.
 */
export function normalizeLegacyPersonaId(
  value: unknown
): LegacyPersonaId | null {
  if (typeof value !== 'string') {
    return null;
  }

  if (LEGACY_IDS.has(value)) {
    return value as LegacyPersonaId;
  }

  if (Object.prototype.hasOwnProperty.call(NEW_TO_LEGACY, value)) {
    return NEW_TO_LEGACY[value as NewPersonaId];
  }

  return null;
}

// Clef 라우터 결과를 orchestrator 실행 계획으로 변환 (GPT 권장)
// persona:null을 예외가 아닌 정상 분류 결과로 처리
import type { RouteResult } from './router';

export type RoutingOutcome =
  | {
      kind: 'dispatch';
      primary: LegacyPersonaId;
      reason: string;
    }
  | {
      kind: 'reply';
      reason: string;
      message: string;
    };

export function compoundGuidance(message?: string | null): string {
  const text = message ?? '';
  const domains: string[] = [];
  if (/(일정|약속|회의\s*등록|할\s*일|리마인더)/.test(text)) domains.push('일정·할 일');
  if (/(메모|기록|요약|정리|검색)/.test(text)) domains.push('메모·요약');
  if (/(코드|함수|버그|프로그램|개발)/.test(text)) domains.push('코드·개발');
  if (/(메일|전송|발송)/.test(text)) domains.push('메일');
  const uniq = [...new Set(domains)];
  if (uniq.length >= 2) return `${uniq.join('와(과) ')}처럼 서로 다른 작업이 함께 들어 있어요. 먼저 처리할 작업을 하나 골라 주세요.`;
  if (uniq.length === 1) return `${uniq[0]}을(를) 포함해 서로 다른 작업이 함께 들어 있어요. 먼저 처리할 작업을 하나 골라 주세요.`;
  return '서로 다른 작업이 함께 들어 있어요. 먼저 처리할 작업을 하나 골라 주세요.';
}

export function resolveClefRoute(route: RouteResult, opts?: { message?: string }): RoutingOutcome {
  // 복합 요청은 비서에게 직접 위임하지 않는다.
  if (route.reason === 'multiple_actions') {
    return {
      kind: 'reply',
      reason: 'multiple_actions',
      message: compoundGuidance(opts?.message),
    };
  }

  // 낮은 신뢰도는 정상적인 분류 거부다.
  if (!route.persona) {
    return {
      kind: 'reply',
      reason: route.reason,
      message:
        '담당 비서를 명확하게 결정하지 못했습니다. ' +
        '@루미, @에코, @노바, @캘리 중 ' +
        '원하는 비서를 지정해 주세요.',
    };
  }

  const legacyId = normalizeLegacyPersonaId(route.persona);

  if (!legacyId) {
    return {
      kind: 'reply',
      reason: 'invalid_persona',
      message: '비서 연결 정보를 확인할 수 없습니다.',
    };
  }

  return {
    kind: 'dispatch',
    primary: legacyId,
    reason: route.reason,
  };
}
