/**
 * Phase 3B: 비서 ID 레지스트리
 *
 * 내부 personaId와 표시 이름의 권위 있는 매핑.
 * Phase 3A에서 발견된 불일치 (concierge 주석 오류) 방지.
 */

export interface PersonaInfo {
  /** 내부 ID (API, DB, 로그에서 사용) */
  id: string
  /** 표시 이름 (사용자에게 보여지는 이름) */
  displayName: string
  /** 영어 코드명 */
  codeName: string
  /** 설명 */
  description: string
}

export const PERSONA_REGISTRY: Record<string, PersonaInfo> = {
  concierge: {
    id: 'concierge',
    displayName: '루미',
    codeName: 'Lumi',
    description: '일상 대화 비서',
  },
  keeper: {
    id: 'keeper',
    displayName: '에코',
    codeName: 'Echo',
    description: '개인 기록 비서',
  },
  builder: {
    id: 'builder',
    displayName: '노바',
    codeName: 'Nova',
    description: '개발 및 코딩 비서',
  },
  scheduler: {
    id: 'scheduler',
    displayName: '캘리',
    codeName: 'Cali',
    description: '일정 및 할 일 비서',
  },
}

export function getPersonaInfo(personaId: string): PersonaInfo | null {
  return Object.prototype.hasOwnProperty.call(PERSONA_REGISTRY, personaId)
    ? PERSONA_REGISTRY[personaId]
    : null
}

export function getDisplayName(personaId: string): string {
  return Object.prototype.hasOwnProperty.call(PERSONA_REGISTRY, personaId)
    ? PERSONA_REGISTRY[personaId].displayName
    : personaId
}

export function isValidPersonaId(personaId: string): boolean {
  return Object.prototype.hasOwnProperty.call(PERSONA_REGISTRY, personaId)
}
