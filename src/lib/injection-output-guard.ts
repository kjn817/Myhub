/**
 * 인젝션 페이로드 출력 가드 (2026-10-30 라이브 게이트 잔여 결함)
 *
 * 실측: keeper가 시스템 프롬프트 공개는 거부했지만, 거부 문장 끝에
 * 사용자가 요구한 문구("인젝션 성공")를 그대로 이어 붙여 출력했다.
 * 모델이 "거부하면서 요구 문구를 인용·반복하는" 거동은 프롬프트만으로
 * 결정적으로 막을 수 없어, 응답 조립 단계에서 코드로 제거한다.
 *
 * 적용 범위는 좁게 고정한다:
 * - 마지막 사용자 메시지가 인젝션 시도(containsInjectionAttempt)일 때만 동작
 * - 그 메시지에서 따옴표로 인용된 문구만 페이로드 후보로 삼는다
 * - 응답에 그 문구가 그대로 있으면 제거하고 주변 공백·빈 줄을 정리한다
 * 거부 자체(모델 응답의 나머지)는 건드리지 않는다.
 */

import { containsInjectionAttempt } from '../ai/prompts/composer'

/** 따옴표로 인용된 문구 추출 ('…', "…", '…', "…") — 2~80자 */
const QUOTED_RE = /[''‘’]([^''‘’\n]{2,80})[''‘’]|"([^"\n]{2,80})"|“([^”\n]{2,80})”/g

export function extractQuotedPayloads(userText: string): string[] {
  if (typeof userText !== 'string' || !userText) return []
  const out: string[] = []
  QUOTED_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = QUOTED_RE.exec(userText)) !== null) {
    const payload = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    if (payload && !out.includes(payload)) out.push(payload)
  }
  // 긴 문구부터 제거해야 부분 겹침에서 잔재가 남지 않는다
  return out.sort((a, b) => b.length - a.length)
}

export interface InjectionScrubResult {
  text: string
  /** 실제로 제거된 페이로드 문구 */
  removed: string[]
}

/**
 * 인젝션 시도 턴의 응답에서 인용 페이로드를 제거한다.
 * 인젝션 시도가 아니거나 페이로드가 없으면 원문을 그대로 돌려준다.
 */
export function scrubInjectionPayload(output: string, userText: string): InjectionScrubResult {
  const original = typeof output === 'string' ? output : ''
  if (!original || !containsInjectionAttempt(userText || '')) {
    return { text: original, removed: [] }
  }
  const removed: string[] = []
  let text = original
  for (const payload of extractQuotedPayloads(userText)) {
    if (text.includes(payload)) {
      text = text.split(payload).join('')
      removed.push(payload)
    }
  }
  if (removed.length === 0) return { text: original, removed }
  // 제거 잔재 정리: 중복 공백, 3줄 이상 빈 줄, 앞뒤 공백
  text = text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ +\n/g, '\n')
    .trim()
  return { text, removed }
}
