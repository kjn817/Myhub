import { PERSONAS } from './ai-personas'

export const PERSONA_IDS: string[] = PERSONAS.map((p) => p.id)

export const BOOLEAN_SETTING_KEYS: string[] = [
  'memory.v2_enabled',
  'memory.legacy_enabled',
  'memory.llm_extract_enabled',
  'memory.llm_reflection_enabled',
  'memory.llm_consolidation_enabled',
  'ai.prompt_v2',
]

export const ENUM_SETTING_VALUES: Record<string, string[]> = {
  'clef.router_mode': ['off', 'shadow', 'active'],
  // Privacy 한국어 문맥 층 집행 제어 (S2 카나리) — privacy-korean-mode.ts가
  // 읽는다. 기본 off(행 없음), shadow는 판정 기록만, enforce는 aiChat
  // 출구에서 한국어 구간 토큰화까지 집행한다.
  'privacy.korean_mode': ['off', 'shadow', 'enforce'],
  // G6 (쓰기·복합 확장) 단계 제어 — clef-g6.ts가 읽는다. 기본 off,
  // 활성화는 사전 등록 게이트(G6-README) 통과 후에만 (판정은 코드가 한다).
  'clef.g6_mode': ['off', 'shadow', 'active'],
  'ai.marker_mode': ['off', 'shadow'],
  // R-13/R-14 저장 암호화 전환 스위치 (storage-protection.ts). 기본값은
  // 키 부재와 같은 OFF이며, 활성화는 키 외부 보관 확인 후 별도 단계.
  'storage.protection': ['off', 'encrypted'],
}

export const ENGINE_V2_SETTING_VALUES: string[] = ['fc', 'marker']

export const STAGING_ONLY_FC_SETTING_KEYS: string[] = [
  'ai.engine',
  'ai.fc_test_approved',
  'ai.fc_test_mock_error',
  'ai.fc_test_no_tools',
  'ai.fc_provider',
  'ai.fc_model',
]

export const FC_PROVIDER_VALUES: string[] = ['groq', 'gemini', 'workers-ai']

export const BUDGET_SETTING_NOTE =
  'budget.<provider>는 기록용(미집행) 설정이다 — 초과해도 호출을 차단·경고하지 않으며, 사용률 표시는 참고용이다.'

export type AiSettingValidation =
  | { ok: true; scope: 'production' | 'staging-only' }
  | { ok: false; error: string }

const OK_PROD: AiSettingValidation = { ok: true, scope: 'production' }
const OK_STAGING: AiSettingValidation = { ok: true, scope: 'staging-only' }
const fail = (error: string): AiSettingValidation => ({ ok: false, error })

function isValidTimezone(value: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

function validateStagingOnlyFc(key: string, value: string, environment?: string): AiSettingValidation {
  if (environment !== 'staging') {
    return fail(`staging-only setting: ${key} (운영에서는 읽히지 않음)`)
  }
  switch (key) {
    case 'ai.engine':
      return value === 'legacy' || value === 'function_calling'
        ? OK_STAGING
        : fail('ai.engine must be legacy|function_calling')
    case 'ai.fc_test_approved':
    case 'ai.fc_test_no_tools':
      return value === 'true' || value === 'false' ? OK_STAGING : fail(`${key} must be true|false`)
    case 'ai.fc_test_mock_error':
      return /^[^:\s]+:\d{3}$/.test(value)
        ? OK_STAGING
        : fail('ai.fc_test_mock_error must be <provider>:<3-digit code>')
    case 'ai.fc_provider':
      return FC_PROVIDER_VALUES.includes(value)
        ? OK_STAGING
        : fail(`ai.fc_provider must be one of ${FC_PROVIDER_VALUES.join('|')}`)
    case 'ai.fc_model':
      return value.length <= 200 && !/\s/.test(value)
        ? OK_STAGING
        : fail('ai.fc_model must be a single model id (no whitespace, <=200 chars)')
    default:
      return fail('invalid key')
  }
}

export function validateAiSetting(
  key: string,
  value: string,
  env?: { ENVIRONMENT?: string },
): AiSettingValidation {
  if (STAGING_ONLY_FC_SETTING_KEYS.includes(key)) {
    if (value === '') {
      return { ok: true, scope: 'staging-only' }
    }
    return validateStagingOnlyFc(key, value, env?.ENVIRONMENT)
  }
  if (/^model\.[a-z]+$/.test(key)) return OK_PROD
  if (/^budget\.[a-z-]+$/.test(key)) {
    if (value === '') return OK_PROD
    return /^\d+$/.test(value) ? OK_PROD : fail('budget value must be a non-negative integer (requests/day)')
  }
  if (BOOLEAN_SETTING_KEYS.includes(key)) {
    if (value === '') return OK_PROD
    return value === 'true' || value === 'false' ? OK_PROD : fail(`${key} must be true|false`)
  }
  const enumValues = ENUM_SETTING_VALUES[key]
  if (enumValues) {
    if (value === '') return OK_PROD
    return enumValues.includes(value) ? OK_PROD : fail(`${key} must be one of ${enumValues.join('|')}`)
  }
  if (key === 'ai.emergency_disable') {
    if (value === '') return OK_PROD
    const tokens = value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const valid = tokens.length > 0 && tokens.every((t) => t === 'all' || PERSONA_IDS.includes(t))
    return valid ? OK_PROD : fail(`ai.emergency_disable must be 'all' or persona ids (${PERSONA_IDS.join(',')})`)
  }
  const engineV2 = key.match(/^ai\.engine_v2\.([a-z]+)$/)
  if (engineV2) {
    if (!PERSONA_IDS.includes(engineV2[1])) return fail(`unknown persona: ${engineV2[1]}`)
    if (value === '') return OK_PROD
    return ENGINE_V2_SETTING_VALUES.includes(value)
      ? OK_PROD
      : fail(`ai.engine_v2.<persona> must be one of ${ENGINE_V2_SETTING_VALUES.join('|')}`)
  }
  const promptV2 = key.match(/^ai\.prompt_v2\.([a-z]+)$/)
  if (promptV2) {
    if (!PERSONA_IDS.includes(promptV2[1])) return fail(`unknown persona: ${promptV2[1]}`)
    if (value === '') return OK_PROD
    return value === 'true' || value === 'false' ? OK_PROD : fail(`${key} must be true|false`)
  }
  if (key === 'ai.user_timezone') {
    if (value === '') return OK_PROD
    return isValidTimezone(value) ? OK_PROD : fail('ai.user_timezone must be a valid IANA timezone')
  }
  if (key === 'voice.daily_limit') {
    if (value === '') return OK_PROD
    const n = /^\d+$/.test(value) ? parseInt(value, 10) : NaN
    return Number.isFinite(n) && n >= 1 && n <= 10000
      ? OK_PROD
      : fail('voice.daily_limit must be an integer 1..10000')
  }
  return fail('invalid key')
}
