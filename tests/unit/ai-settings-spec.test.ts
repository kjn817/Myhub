/// <reference types="jest" />
/**
 * src/services/ai-settings-spec.ts — 설정 스펙 불변식 + 검증기 성질 테스트.
 *
 * 이 모듈은 ai_settings에 쓸 수 있는 키·값의 "헌법"이다. 고정하는 성질:
 * - 스펙 데이터 자체의 정합성: 키 중복 없음, boolean/enum 키 집합이
 *   겹치지 않음(겹치면 검증 순서 때문에 한쪽이 도달 불가가 된다),
 *   enum 값 목록에 중복·빈 값이 없음.
 * - 스펙과 소비자의 정합성: enum에 적힌 모드 값은 실제 모드 파서가
 *   그대로 받아들이는 값과 일치한다 (clef.router_mode / clef.g6_mode).
 * - 검증기 경계: 경계값(voice.daily_limit 1/10000, 예산 정수, 타임존,
 *   emergency_disable 토큰)은 정확히 그 지점에서 갈린다.
 * - staging-only 키는 운영 환경에서 값을 거부하고, 빈 값(삭제)은 허용한다.
 * 카나리아: voice.daily_limit 상한을 바꾸면 실패한다.
 */
import {
  PERSONA_IDS,
  BOOLEAN_SETTING_KEYS,
  ENUM_SETTING_VALUES,
  ENGINE_V2_SETTING_VALUES,
  STAGING_ONLY_FC_SETTING_KEYS,
  FC_PROVIDER_VALUES,
  BUDGET_SETTING_NOTE,
  validateAiSetting,
} from '../../src/services/ai-settings-spec'
import { PERSONAS } from '../../src/services/ai-personas'
import { parseClefG6Mode } from '../../src/services/clef-g6'

const PROD = { ENVIRONMENT: 'production' }
const STAGING = { ENVIRONMENT: 'staging' }

// ---------------- 스펙 데이터 불변식 ----------------

describe('스펙 데이터 불변식', () => {
  test('PERSONA_IDS는 PERSONAS 순서 그대로, 중복이 없다', () => {
    expect(PERSONA_IDS).toEqual(PERSONAS.map((p) => p.id))
    expect(new Set(PERSONA_IDS).size).toBe(PERSONA_IDS.length)
    expect(PERSONA_IDS.length).toBeGreaterThan(0)
  })

  test('boolean 키 목록에 중복이 없고 키 형식이 일관된다', () => {
    expect(new Set(BOOLEAN_SETTING_KEYS).size).toBe(BOOLEAN_SETTING_KEYS.length)
    for (const k of BOOLEAN_SETTING_KEYS) expect(k).toMatch(/^[a-z][a-z0-9_.]*$/)
  })

  test('boolean 키와 enum 키는 겹치지 않는다 (검증 순서상 한쪽이 죽는 겹침 금지)', () => {
    for (const k of Object.keys(ENUM_SETTING_VALUES)) {
      expect(BOOLEAN_SETTING_KEYS).not.toContain(k)
    }
  })

  test('enum 값 목록: 키마다 2개 이상, 중복·빈 값 없음', () => {
    for (const [k, values] of Object.entries(ENUM_SETTING_VALUES)) {
      expect(values.length).toBeGreaterThanOrEqual(2)
      expect(new Set(values).size).toBe(values.length)
      for (const v of values) expect(v.length).toBeGreaterThan(0)
      void k
    }
  })

  test('enum에 선언된 값은 전부 검증기를 통과한다 (production)', () => {
    for (const [k, values] of Object.entries(ENUM_SETTING_VALUES)) {
      for ( const v of values) {
        expect(validateAiSetting(k, v, PROD)).toEqual({ ok: true, scope: 'production' })
      }
    }
  })

  test('boolean 키는 true/false만 통과하고 다른 값은 전부 거부한다', () => {
    for (const k of BOOLEAN_SETTING_KEYS) {
      expect(validateAiSetting(k, 'true', PROD).ok).toBe(true)
      expect(validateAiSetting(k, 'false', PROD).ok).toBe(true)
      expect(validateAiSetting(k, 'yes', PROD).ok).toBe(false)
      expect(validateAiSetting(k, 'TRUE', PROD).ok).toBe(false)
      expect(validateAiSetting(k, '1', PROD).ok).toBe(false)
    }
  })

  test('모드 enum은 실제 모드 파서와 일치한다 (스펙-소비자 정합성)', () => {
    // clef.g6_mode의 모든 값은 parseClefG6Mode가 그대로 인정해야 한다
    for (const v of ENUM_SETTING_VALUES['clef.g6_mode']) {
      expect(parseClefG6Mode(v)).toBe(v)
    }
    // 두 모드 키의 값 집합은 동일하다
    expect([...ENUM_SETTING_VALUES['clef.g6_mode']].sort()).toEqual([...ENUM_SETTING_VALUES['clef.router_mode']].sort())
    expect(ENUM_SETTING_VALUES['clef.router_mode']).toEqual(['off', 'shadow', 'active'])
  })

  test('staging-only 키는 boolean/enum/model/budget 어느 집합과도 겹치지 않는다', () => {
    for (const k of STAGING_ONLY_FC_SETTING_KEYS) {
      expect(BOOLEAN_SETTING_KEYS).not.toContain(k)
      expect(Object.keys(ENUM_SETTING_VALUES)).not.toContain(k)
      expect(k).not.toMatch(/^model\./)
      expect(k).not.toMatch(/^budget\./)
    }
    expect(new Set(STAGING_ONLY_FC_SETTING_KEYS).size).toBe(STAGING_ONLY_FC_SETTING_KEYS.length)
  })

  test('FC_PROVIDER_VALUES는 중복 없는 비어 있지 않은 목록이고, budget 비고는 문자열이다', () => {
    expect(FC_PROVIDER_VALUES.length).toBeGreaterThan(0)
    expect(new Set(FC_PROVIDER_VALUES).size).toBe(FC_PROVIDER_VALUES.length)
    expect(typeof BUDGET_SETTING_NOTE).toBe('string')
    expect(BUDGET_SETTING_NOTE).toContain('budget.<provider>')
  })
})

// ---------------- 검증기: production 키 ----------------

describe('validateAiSetting — production 키 경계', () => {
  test('알 수 없는 키는 invalid key로 거부한다', () => {
    expect(validateAiSetting('no.such.key', 'x', PROD)).toEqual({ ok: false, error: 'invalid key' })
    expect(validateAiSetting('model.Code', 'x', PROD).ok).toBe(false) // 모델 키는 소문자만
    expect(validateAiSetting('', 'x', PROD).ok).toBe(false)
  })

  test('model.<capability>는 어떤 문자열 값도 허용한다', () => {
    expect(validateAiSetting('model.code', 'gemini-3.5-flash-lite', PROD)).toEqual({ ok: true, scope: 'production' })
    expect(validateAiSetting('model.chat', '', PROD).ok).toBe(true)
  })

  test('budget.<provider>는 빈 값 또는 0 이상의 정수만 허용한다', () => {
    expect(validateAiSetting('budget.gemini', '', PROD).ok).toBe(true)
    expect(validateAiSetting('budget.gemini', '0', PROD).ok).toBe(true)
    expect(validateAiSetting('budget.gemini', '1500', PROD).ok).toBe(true)
    expect(validateAiSetting('budget.gemini', '-5', PROD).ok).toBe(false)
    expect(validateAiSetting('budget.gemini', '1.5', PROD).ok).toBe(false)
    expect(validateAiSetting('budget.gemini', 'abc', PROD).ok).toBe(false)
  })

  test('enum 키는 선언된 값만 허용하고 오류에 후보를 명시한다', () => {
    expect(validateAiSetting('clef.router_mode', 'shadow', PROD).ok).toBe(true)
    expect(validateAiSetting('privacy.korean_mode', 'enforce', PROD).ok).toBe(true)
    const bad = validateAiSetting('clef.router_mode', 'on', PROD)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('off|shadow|active')
    expect(validateAiSetting('ai.marker_mode', 'active', PROD).ok).toBe(false) // marker_mode에는 active가 없다
  })

  test('ai.emergency_disable: all 또는 실재 비서 ID 목록만 허용한다', () => {
    expect(validateAiSetting('ai.emergency_disable', '', PROD).ok).toBe(true)
    expect(validateAiSetting('ai.emergency_disable', 'all', PROD).ok).toBe(true)
    expect(validateAiSetting('ai.emergency_disable', 'concierge, keeper', PROD).ok).toBe(true)
    expect(validateAiSetting('ai.emergency_disable', 'all,concierge', PROD).ok).toBe(true)
    expect(validateAiSetting('ai.emergency_disable', 'nobody', PROD).ok).toBe(false)
    expect(validateAiSetting('ai.emergency_disable', 'concierge,nobody', PROD).ok).toBe(false)
    expect(validateAiSetting('ai.emergency_disable', ',', PROD).ok).toBe(false) // 토큰이 하나도 없으면 거부
  })

  test('ai.engine_v2.<persona>/ai.prompt_v2.<persona>: 실재 비서만, 값 집합이 서로 다르다', () => {
    for (const id of PERSONA_IDS) {
      expect(validateAiSetting(`ai.engine_v2.${id}`, 'fc', PROD).ok).toBe(true)
      expect(validateAiSetting(`ai.engine_v2.${id}`, 'marker', PROD).ok).toBe(true)
      expect(validateAiSetting(`ai.prompt_v2.${id}`, 'true', PROD).ok).toBe(true)
    }
    expect([...ENGINE_V2_SETTING_VALUES].sort()).toEqual(['fc', 'marker'])
    expect(validateAiSetting('ai.engine_v2.concierge', 'true', PROD).ok).toBe(false)
    expect(validateAiSetting('ai.prompt_v2.concierge', 'fc', PROD).ok).toBe(false)
    expect(validateAiSetting('ai.engine_v2.nobody', 'fc', PROD)).toEqual({ ok: false, error: 'unknown persona: nobody' })
    expect(validateAiSetting('ai.prompt_v2.nobody', 'true', PROD).ok).toBe(false)
  })

  test('ai.user_timezone: 유효한 IANA 타임존만 허용한다', () => {
    expect(validateAiSetting('ai.user_timezone', 'Asia/Seoul', PROD).ok).toBe(true)
    expect(validateAiSetting('ai.user_timezone', 'UTC', PROD).ok).toBe(true)
    expect(validateAiSetting('ai.user_timezone', '', PROD).ok).toBe(true)
    expect(validateAiSetting('ai.user_timezone', 'Mars/Olympus', PROD).ok).toBe(false)
  })

  test('voice.daily_limit: 1..10000 경계가 정확하다', () => {
    expect(validateAiSetting('voice.daily_limit', '1', PROD).ok).toBe(true)
    expect(validateAiSetting('voice.daily_limit', '10000', PROD).ok).toBe(true)
    expect(validateAiSetting('voice.daily_limit', '0', PROD).ok).toBe(false)
    expect(validateAiSetting('voice.daily_limit', '10001', PROD).ok).toBe(false)
    expect(validateAiSetting('voice.daily_limit', '-3', PROD).ok).toBe(false)
    expect(validateAiSetting('voice.daily_limit', '1.5', PROD).ok).toBe(false)
    expect(validateAiSetting('voice.daily_limit', '', PROD).ok).toBe(true)
  })
})

// ---------------- 검증기: staging-only 키 ----------------

describe('validateAiSetting — staging-only FC 키', () => {
  test('운영 환경에서는 빈 값(삭제)만 허용하고 실제 값은 거부한다', () => {
    for (const k of STAGING_ONLY_FC_SETTING_KEYS) {
      expect(validateAiSetting(k, '', PROD)).toEqual({ ok: true, scope: 'staging-only' })
    }
    const r = validateAiSetting('ai.engine', 'legacy', PROD)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('staging-only setting')
    // 환경 미지정(undefined)도 운영 취급이다
    expect(validateAiSetting('ai.engine', 'legacy').ok).toBe(false)
  })

  test('staging 환경: ai.engine은 legacy|function_calling만', () => {
    expect(validateAiSetting('ai.engine', 'legacy', STAGING)).toEqual({ ok: true, scope: 'staging-only' })
    expect(validateAiSetting('ai.engine', 'function_calling', STAGING).ok).toBe(true)
    expect(validateAiSetting('ai.engine', 'other', STAGING).ok).toBe(false)
  })

  test('staging 환경: 불리언형 FC 테스트 키는 true|false만', () => {
    for (const k of ['ai.fc_test_approved', 'ai.fc_test_no_tools']) {
      expect(validateAiSetting(k, 'true', STAGING).ok).toBe(true)
      expect(validateAiSetting(k, 'false', STAGING).ok).toBe(true)
      expect(validateAiSetting(k, 'yes', STAGING).ok).toBe(false)
    }
  })

  test('staging 환경: ai.fc_test_mock_error는 <provider>:<3자리 코드> 형식만', () => {
    expect(validateAiSetting('ai.fc_test_mock_error', 'groq:429', STAGING).ok).toBe(true)
    expect(validateAiSetting('ai.fc_test_mock_error', 'gemini:500', STAGING).ok).toBe(true)
    expect(validateAiSetting('ai.fc_test_mock_error', 'groq:42', STAGING).ok).toBe(false)
    expect(validateAiSetting('ai.fc_test_mock_error', 'groq:4290', STAGING).ok).toBe(false)
    expect(validateAiSetting('ai.fc_test_mock_error', 'groq429', STAGING).ok).toBe(false)
    expect(validateAiSetting('ai.fc_test_mock_error', 'groq: 429', STAGING).ok).toBe(false)
  })

  test('staging 환경: ai.fc_provider는 FC_PROVIDER_VALUES와 정확히 일치한다', () => {
    for (const p of FC_PROVIDER_VALUES) {
      expect(validateAiSetting('ai.fc_provider', p, STAGING).ok).toBe(true)
    }
    expect(validateAiSetting('ai.fc_provider', 'openai', STAGING).ok).toBe(false)
  })

  test('staging 환경: ai.fc_model은 공백 없는 200자 이하 단일 ID만', () => {
    expect(validateAiSetting('ai.fc_model', 'openai/gpt-oss-120b', STAGING).ok).toBe(true)
    expect(validateAiSetting('ai.fc_model', 'x'.repeat(200), STAGING).ok).toBe(true)
    expect(validateAiSetting('ai.fc_model', 'x'.repeat(201), STAGING).ok).toBe(false)
    expect(validateAiSetting('ai.fc_model', 'has space', STAGING).ok).toBe(false)
  })
})
