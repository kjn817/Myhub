/**
 * src/ai/persona-registry.ts 100% 커버리지 테스트
 */
/// <reference types="jest" />
import { PERSONA_REGISTRY, getPersonaInfo, getDisplayName, isValidPersonaId } from '../../src/ai/persona-registry'

describe('persona-registry.ts — PERSONA_REGISTRY', () => {
  test('4명의 비서가 등록되어 있다', () => {
    expect(Object.keys(PERSONA_REGISTRY)).toHaveLength(4)
  })

  test('concierge는 루미다', () => {
    expect(PERSONA_REGISTRY.concierge).toEqual({
      id: 'concierge',
      displayName: '루미',
      codeName: 'Lumi',
      description: '일상 대화 비서',
    })
  })

  test('keeper는 에코다', () => {
    expect(PERSONA_REGISTRY.keeper).toEqual({
      id: 'keeper',
      displayName: '에코',
      codeName: 'Echo',
      description: '개인 기록 비서',
    })
  })

  test('builder는 노바다', () => {
    expect(PERSONA_REGISTRY.builder).toEqual({
      id: 'builder',
      displayName: '노바',
      codeName: 'Nova',
      description: '개발 및 코딩 비서',
    })
  })

  test('scheduler는 캘리다', () => {
    expect(PERSONA_REGISTRY.scheduler).toEqual({
      id: 'scheduler',
      displayName: '캘리',
      codeName: 'Cali',
      description: '일정 및 할 일 비서',
    })
  })

  test('모든 항목의 id가 키와 일치한다', () => {
    for (const [key, info] of Object.entries(PERSONA_REGISTRY)) {
      expect(info.id).toBe(key)
    }
  })
})

describe('getPersonaInfo', () => {
  test('등록된 비서는 정보를 반환한다', () => {
    expect(getPersonaInfo('concierge')?.displayName).toBe('루미')
    expect(getPersonaInfo('keeper')?.codeName).toBe('Echo')
    expect(getPersonaInfo('builder')?.description).toBe('개발 및 코딩 비서')
    expect(getPersonaInfo('scheduler')?.id).toBe('scheduler')
  })

  test('등록되지 않은 비서는 null을 반환한다', () => {
    expect(getPersonaInfo('unknown')).toBeNull()
    expect(getPersonaInfo('')).toBeNull()
    expect(getPersonaInfo('CONCIERGE')).toBeNull()
  })

  test('__proto__는 null을 반환함 (프로토타입 오염 방지)', () => {
    // 수정됨: hasOwnProperty로 프로토타입 체인 검사 방지
    expect(getPersonaInfo('__proto__')).toBe(null)
    expect(getPersonaInfo('constructor')).toBe(null)
  })
})

describe('getDisplayName', () => {
  test('등록된 비서는 표시 이름을 반환한다', () => {
    expect(getDisplayName('concierge')).toBe('루미')
    expect(getDisplayName('keeper')).toBe('에코')
    expect(getDisplayName('builder')).toBe('노바')
    expect(getDisplayName('scheduler')).toBe('캘리')
  })

  test('등록되지 않은 비서는 ID 그대로 반환한다 (폴백)', () => {
    expect(getDisplayName('unknown')).toBe('unknown')
    expect(getDisplayName('')).toBe('')
  })
})

describe('isValidPersonaId', () => {
  test('등록된 ID는 true', () => {
    expect(isValidPersonaId('concierge')).toBe(true)
    expect(isValidPersonaId('keeper')).toBe(true)
    expect(isValidPersonaId('builder')).toBe(true)
    expect(isValidPersonaId('scheduler')).toBe(true)
  })

  test('등록되지 않은 ID는 false', () => {
    expect(isValidPersonaId('unknown')).toBe(false)
    expect(isValidPersonaId('')).toBe(false)
    expect(isValidPersonaId('CONCIERGE')).toBe(false)
    // 수정됨: hasOwnProperty로 프로토타입 오염 방지
    expect(isValidPersonaId('__proto__')).toBe(false)
    expect(isValidPersonaId('constructor')).toBe(false)
  })
})
