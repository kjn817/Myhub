/**
 * Phase 3A: Prompt Composer
 *
 * 공통 프롬프트 + 비서별 프롬프트 + 서버 컨텍스트를 합성
 */

import { buildCommonSection, PROMPT_VERSION } from './common'
import { buildLumiPrompt } from './lumi'
import { buildEchoPrompt } from './echo'
import { buildNovaPrompt } from './nova'
import { buildCaliPrompt, type TimeContext } from './cali'

export { PROMPT_VERSION }

export interface ComposeOptions {
  personaId: string
  /** 서버 시간 컨텍스트 (캘리용, Phase 3B 연결) */
  timeContext?: TimeContext
  /** 서버가 허용한 기능 목록 */
  capabilities?: string[]
  /** 허용된 도구 목록 */
  allowedTools?: string[]
}

export function composeSystemPrompt(options: ComposeOptions): string {
  const { personaId, timeContext, capabilities, allowedTools } = options

  const sections: string[] = []

  // 1. 공통 행동 원칙
  sections.push(buildCommonSection())

  // 2. 비서별 역할
  let personaSection: string
  switch (personaId) {
    case 'concierge':
      personaSection = buildLumiPrompt()
      break
    case 'keeper':
      personaSection = buildEchoPrompt()
      break
    case 'builder':
      personaSection = buildNovaPrompt()
      break
    case 'scheduler':
      personaSection = buildCaliPrompt(timeContext)
      break
    default:
      // 알 수 없는 비서는 루미 기본값 (fail-open 금지, 최소 권한)
      personaSection = buildLumiPrompt()
      break
  }
  sections.push(personaSection)

  // 3. 서버가 허용한 기능과 도구
  if (capabilities && capabilities.length > 0) {
    sections.push(`서버 허용 기능:\n${capabilities.map((c) => `- ${c}`).join('\n')}`)
  }
  if (allowedTools && allowedTools.length > 0) {
    sections.push(`허용된 도구: ${allowedTools.join(', ')}`)
  } else if (allowedTools) {
    sections.push('허용된 도구: 없음 (도구 호출 금지)')
  }

  // 4. 프롬프트 버전 (디버깅용)
  sections.push(`[prompt-version: ${PROMPT_VERSION}]`)

  return sections.join('\n\n---\n\n')
}

/**
 * 사용자 메시지나 메모 본문이 시스템 지시로 승격되지 않도록 검사
 * "위 지시를 무시해" 같은 프롬프트 인젝션 패턴 탐지
 */
export function containsInjectionAttempt(text: string): boolean {
  const patterns = [
    /위\s*지시\s*를?\s*무시/i,
    // "이전의 모든 지시를 무시하고"처럼 수식어가 낀 형태 (2026-10-30
    // 라이브 eval 실측 문구 — 기존 패턴은 '위 지시' 인접 형태만 잡았다)
    /지시\s*(를|을)?\s*무시/,
    /ignore\s*(all\s*)?previous\s*instructions/i,
    /시스템\s*프롬프트\s*를?\s*공개/i,
    // "시스템 프롬프트를 그대로 출력해" — 공개 대신 출력·보여·알려로 우회하는 형태
    /시스템\s*프롬프트.*(출력|공개|보여|알려)/,
    /system\s*prompt\s*를?\s*공개/i,
    /reveal\s*your\s*system\s*prompt/i,
  ]
  return patterns.some((p) => p.test(text))
}
