/// <reference types="jest" />

import {
  getPersonaMinSensitivity,
  rankSensitivity,
  maxSensitivityLevel,
  resolvePolicySensitivity,
  getLegacyMarkerTools,
  resolveRequestSensitivity,
  checkProviderAllowed,
  checkDataPolicy,
  filterAllowedProviders,
  PrivacyBlockedError,
} from '../../src/ai/legacy-privacy-guard'

describe('getPersonaMinSensitivity', () => {
  test('keeper는 personal', () => {
    expect(getPersonaMinSensitivity('keeper')).toBe('personal')
  })
  test('scheduler는 personal', () => {
    expect(getPersonaMinSensitivity('scheduler')).toBe('personal')
  })
  test('concierge는 general', () => {
    expect(getPersonaMinSensitivity('concierge')).toBe('general')
  })
  test('builder는 general', () => {
    expect(getPersonaMinSensitivity('builder')).toBe('general')
  })
  test('알 수 없는 비서는 general', () => {
    expect(getPersonaMinSensitivity('unknown')).toBe('general')
    // 프로토타입 오염 방지: '__proto__'도 'general' 반환 (2026-10-17 수정됨)
    expect(getPersonaMinSensitivity('__proto__')).toBe('general')
  })
})

describe('rankSensitivity', () => {
  test('general=0, personal=1, restricted=2', () => {
    expect(rankSensitivity('general')).toBe(0)
    expect(rankSensitivity('personal')).toBe(1)
    expect(rankSensitivity('restricted')).toBe(2)
  })
})

describe('maxSensitivityLevel', () => {
  test('더 높은 것을 반환', () => {
    expect(maxSensitivityLevel('general', 'personal')).toBe('personal')
    expect(maxSensitivityLevel('personal', 'general')).toBe('personal')
    expect(maxSensitivityLevel('personal', 'restricted')).toBe('restricted')
    expect(maxSensitivityLevel('general', 'general')).toBe('general')
  })
})

describe('resolvePolicySensitivity', () => {
  test('모두 general이면 undefined', () => {
    expect(resolvePolicySensitivity({})).toBeUndefined()
    expect(resolvePolicySensitivity({ sensitivity: 'general' })).toBeUndefined()
  })

  test('명시적 personal 유지', () => {
    expect(resolvePolicySensitivity({ sensitivity: 'personal' })).toBe('personal')
  })

  test('keeper는 personal 하한 (general 명시해도 덮어쓰기 불가)', () => {
    expect(
      resolvePolicySensitivity({ personaId: 'keeper', sensitivity: 'general' })
    ).toBe('personal')
  })

  test('scheduler는 personal 하한', () => {
    expect(resolvePolicySensitivity({ personaId: 'scheduler' })).toBe('personal')
  })

  test('summarize capability는 personal', () => {
    expect(resolvePolicySensitivity({ capability: 'summarize' })).toBe('personal')
    expect(resolvePolicySensitivity({ capability: 'schedule' })).toBe('personal')
  })

  test('잘못된 sensitivity는 무시', () => {
    expect(resolvePolicySensitivity({ sensitivity: 'invalid' })).toBeUndefined()
    expect(resolvePolicySensitivity({ sensitivity: '' })).toBeUndefined()
  })

  test('restricted가 가장 높음', () => {
    expect(
      resolvePolicySensitivity({ sensitivity: 'restricted', personaId: 'keeper' })
    ).toBe('restricted')
  })
})

describe('getLegacyMarkerTools', () => {
  test('각 비서별 도구 목록', () => {
    expect(getLegacyMarkerTools('keeper')).toContain('MEMO_SEARCH')
    expect(getLegacyMarkerTools('builder')).toContain('GITHUB')
    expect(getLegacyMarkerTools('scheduler')).toContain('SCHEDULE_CREATE')
    expect(getLegacyMarkerTools('concierge')).toContain('TODO_ADD')
  })
  test('알 수 없는 비서는 concierge 기본값', () => {
    expect(getLegacyMarkerTools('unknown')).toEqual(getLegacyMarkerTools('concierge'))
  })
})

describe('resolveRequestSensitivity', () => {
  test('keeper는 최소 personal', () => {
    const r = resolveRequestSensitivity('keeper', 'hello')
    expect(r.sensitivity).toBe('personal')
    expect(r.reason).toBeDefined()
  })

  test('concierge 일반 텍스트는 general', () => {
    const r = resolveRequestSensitivity('concierge', 'hello world')
    expect(['general', 'personal']).toContain(r.sensitivity)
  })

  test('메모 도구 사용 시 personal', () => {
    const r = resolveRequestSensitivity('concierge', 'find memo', ['MEMO_SEARCH'])
    expect(r.sensitivity).toBe('personal')
  })

  test('MEMO_GET도 search_memo로 매핑', () => {
    const r = resolveRequestSensitivity('concierge', 'get memo', ['MEMO_GET'])
    expect(r.sensitivity).toBe('personal')
  })

  test('historySensitivity 유지', () => {
    const r = resolveRequestSensitivity('concierge', 'hi', [], 'personal')
    expect(r.sensitivity).toBe('personal')
  })
})

describe('checkProviderAllowed', () => {
  test('general은 gemini 허용', () => {
    const r = checkProviderAllowed('gemini', 'general')
    expect(r.allowed).toBe(true)
  })

  test('결과에 reason 포함', () => {
    const r = checkProviderAllowed('gemini', 'general')
    expect(r.reason).toBeDefined()
  })
})

describe('checkDataPolicy', () => {
  test('데이터 정책 확인', () => {
    const r = checkDataPolicy('gemini', 'general')
    expect(typeof r.allowed).toBe('boolean')
    expect(r.reason).toBeDefined()
  })
})

describe('filterAllowedProviders', () => {
  test('허용된 것만 필터링', () => {
    const models = [{ provider: 'gemini', model: 'a' }]
    const result = filterAllowedProviders(models, 'general')
    expect(result).toHaveLength(1)
  })

  test('허용 가능한 것이 없으면 PrivacyBlockedError', () => {
    const models = [{ provider: 'invalid-provider-xyz', model: 'a' }]
    expect(() => filterAllowedProviders(models, 'restricted')).toThrow(PrivacyBlockedError)
  })

  test('빈 배열은 에러 없이 반환', () => {
    expect(filterAllowedProviders([], 'restricted')).toEqual([])
  })
})

describe('PrivacyBlockedError', () => {
  test('sensitivity와 reason 저장', () => {
    const e = new PrivacyBlockedError('msg', 'personal', 'test-reason')
    expect(e.message).toBe('msg')
    expect(e.sensitivity).toBe('personal')
    expect(e.reason).toBe('test-reason')
    expect(e.name).toBe('PrivacyBlockedError')
  })
})
