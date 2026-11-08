/**
 * 민감도 분류 — 요청 텍스트와 세션 컨텍스트로 데이터 민감도를 결정한다.
 * (모델 라우터에서 분리: Privacy 게이트웨이·레거시 가드도 같은 분류를 공유한다.)
 */

/** 요청 민감도 수준 */
export type SensitivityLevel = 'general' | 'personal' | 'restricted'

/** 제한 정보 패턴 (API 키, 비밀번호, 카드번호 등) */
const RESTRICTED_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,           // OpenAI 스타일 API 키
  /AIza[a-zA-Z0-9_-]{20,}/,        // Google API 키
  /xox[bap]-[a-zA-Z0-9-]+/,        // Slack 토큰
  /ghp_[a-zA-Z0-9]{20,}/,          // GitHub 토큰
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/, // 카드번호 패턴
  /비밀번호|패스워드|password\s*[:=]/i,
  /api[_-]?key\s*[:=]/i,
  /secret\s*[:=]/i,
]

/** 개인 정보 관련 키워드 */
const PERSONAL_KEYWORDS = [
  '메모', '기억', '일정', '스케줄', '할일', '할 일', '약속',
  '다이어리', '일기', '개인', '프라이빗', '비밀',
]

/**
 * 세션 컨텍스트 (민감도 분류용)
 * GPT Phase 2B 지침: 키워드만이 아닌 세션 전체 컨텍스트 고려
 */
export interface SensitivityContext {
  /** 현재 사용자 입력 */
  text: string
  /** 이전 대화 이력의 최고 민감도 (없으면 undefined) */
  historySensitivity?: SensitivityLevel
  /** 이번 요청에서 활성화 가능한 도구 이름 목록 */
  availableTools?: string[]
  /** 서버 정책상 최소 민감도 (예: 특정 비서는 항상 personal 이상) */
  minSensitivity?: SensitivityLevel
}

/**
 * 민감도 등급 비교 (높을수록 제한적)
 */
export function sensitivityRank(s: SensitivityLevel): number {
  return s === 'general' ? 0 : s === 'personal' ? 1 : 2
}

export function maxSensitivity(...levels: (SensitivityLevel | undefined)[]): SensitivityLevel {
  let result: SensitivityLevel = 'general'
  for (const l of levels) {
    if (l && sensitivityRank(l) > sensitivityRank(result)) {
      result = l
    }
  }
  return result
}

/**
 * 요청 텍스트의 민감도를 분류 (기본, 키워드/패턴 기반)
 * - 모델이 민감도를 낮춰 권한을 획득할 수 없도록 규칙 기반 분류
 * - 이것은 보조 신호이며, 최종 결정은 resolveSensitivity()가 수행
 */
export function classifySensitivity(text: string): SensitivityLevel {
  // 1. 제한 패턴 검사 (최우선)
  for (const pattern of RESTRICTED_PATTERNS) {
    if (pattern.test(text)) {
      return 'restricted'
    }
  }

  // 2. 개인 키워드 검사
  const lowerText = text.toLowerCase()
  for (const keyword of PERSONAL_KEYWORDS) {
    if (lowerText.includes(keyword)) {
      return 'personal'
    }
  }

  // 3. 기본값
  return 'general'
}

/**
 * 최종 민감도 결정 (서버 정책 기반)
 *
 * GPT Phase 2B 지침:
 * - 사용자 메시지의 키워드만으로 최종 결정하지 않음
 * - search_memo가 활성화된 세션은 최소 personal
 * - 대화 이력의 민감도가 높으면 낮추지 않음
 * - 서버 정책의 최소 민감도를 하한으로 적용
 *
 * @returns 최종 민감도와 판단 근거
 */
export function resolveSensitivity(ctx: SensitivityContext): {
  sensitivity: SensitivityLevel
  reason: string
} {
  const textLevel = classifySensitivity(ctx.text)
  const reasons: string[] = [`text:${textLevel}`]

  // 도구 기반 상향: search_memo 등 개인 데이터 접근 도구가 있으면 최소 personal
  let toolLevel: SensitivityLevel | undefined
  const personalTools = ['search_memo']
  if (ctx.availableTools?.some((t) => personalTools.includes(t))) {
    toolLevel = 'personal'
    reasons.push('tool:search_memo→personal')
  }

  const final = maxSensitivity(textLevel, toolLevel, ctx.historySensitivity, ctx.minSensitivity)

  if (ctx.historySensitivity && sensitivityRank(ctx.historySensitivity) > sensitivityRank(textLevel)) {
    reasons.push(`history:${ctx.historySensitivity}`)
  }
  if (ctx.minSensitivity && sensitivityRank(ctx.minSensitivity) > sensitivityRank(textLevel)) {
    reasons.push(`policy-min:${ctx.minSensitivity}`)
  }

  return { sensitivity: final, reason: reasons.join(',') }
}
