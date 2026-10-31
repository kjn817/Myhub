// mem0 패턴 이식 — zero-LLM 사실·엔티티 추출 (결정적 규칙, 0046)
//
// fact-graph.ts의 순수 헬퍼만 분리한 파일 (500줄 규칙).
// - extractFacts: buildMemoryPage의 extractCoreFact(첫 문장)와 일관된 결정적 규칙.
// - extractEntities: 인용·날짜·시간·약어 휴리스틱만 사용 (NER/임베딩 없음).
// - 외부 의존성: memory-service의 normalizeForDuplicate / stripKoreanParticle만 사용.

import { normalizeForDuplicate, stripKoreanParticle } from './memory-service'

export const MAX_FACTS_PER_CAPTURE = 5
const MAX_ENTITIES_PER_FACT = 10

const DATE_TIME_RE =
  /\d{4}-\d{2}-\d{2}|\d{1,2}월\s*\d{1,2}일|\d{1,2}시(\s*\d{1,2}분)?/g
const QUOTED_RE = /["“”]([^"\n“”]{2,50})["“”]/g
const ACRONYM_RE = /\b[A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/g

/** 문장 분할 — 종결 부호(. ! ? … 。) 또는 줄바꿈 기준, 종결 부호 유지. */
export function splitSentences(text: string): string[] {
  const matches = (text || '').match(/[^.!?…。\n]+[.!?…。]?/g)
  return (matches || []).map((s) => s.trim()).filter((s) => s.length > 0)
}

/** 문장이 사실 후보인지 판정: 길이·질문·URL·기호 비율. */
export function isFactSentence(sentence: string): boolean {
  const s = (sentence || '').trim()
  if (s.length < 5 || s.length > 200) return false
  if (s.endsWith('?')) return false // 질문은 사실이 아님
  if (/^https?:\/\//i.test(s)) return false
  if (s.includes('[LOCKED_BLOCK]')) return false // 잠긴 블록 자리표시자는 사실이 아님
  const alnum = s.replace(/[^\p{L}\p{N}]/gu, '').length
  if (alnum / s.length < 0.5) return false // 기호 위주 문장 제외
  return true
}

/** 사실 문장 점수: 날짜·시간 +2, 숫자 +1, 인용 +1, 적정 길이 +1. */
export function scoreFactSentence(sentence: string): number {
  let score = 0
  if (DATE_TIME_RE.test(sentence)) score += 2
  DATE_TIME_RE.lastIndex = 0
  if (/\d/.test(sentence)) score += 1
  if (QUOTED_RE.test(sentence)) score += 1
  QUOTED_RE.lastIndex = 0
  if (sentence.length >= 10 && sentence.length <= 120) score += 1
  return score
}

/**
 * zero-LLM 사실 추출: 문장 분할 → 사실 후보 필터 → 중복 제거 → 점수순 정렬.
 * extractCoreFact(첫 문장)와 일관된 결정적 규칙이다.
 */
export function extractFacts(text: string, maxFacts: number = MAX_FACTS_PER_CAPTURE): string[] {
  const cap = Math.min(Math.max(maxFacts || MAX_FACTS_PER_CAPTURE, 1), 10)
  const seen = new Set<string>()
  const scored: Array<{ fact: string; score: number; pos: number }> = []
  splitSentences(text).forEach((sentence, pos) => {
    if (!isFactSentence(sentence)) return
    const norm = normalizeForDuplicate(sentence)
    if (!norm || seen.has(norm)) return
    seen.add(norm)
    scored.push({ fact: sentence, score: scoreFactSentence(sentence), pos })
  })
  scored.sort((a, b) => b.score - a.score || a.pos - b.pos)
  return scored.slice(0, cap).map((s) => s.fact)
}

/**
 * 엔티티 이름 정규화 (식별자 — Graphiti 엔티티 해소 1단계, 0056):
 * 소문자 + 문자/숫자만 + 끝 조사 제거. "아내는/아내가/아내를"이 같은
 * normalized("아내")로 모여 memory_entities UNIQUE에 1행만 남는다.
 * - 공백은 normalizeForDuplicate가 먼저 제거한다 ("10월 25일" → "10월25일").
 * - '일'은 조사가 아니라 날짜 단위라 stripKoreanParticle 대상이 아니다
 *   ("10월25일" 유지). 1글자 어간은 원본 유지 (stripKoreanParticle 가드).
 * - KNOWN LIMITATION: 이름 자체가 조사와 같은 글자로 끝나는 경우 과도 제거
 *   된다 ("보라돌이" → "보라돌"). 같은 입력은 항상 같은 normalized가 되어
 *   해소 일관성은 유지되지만, "보라돌"이라는 다른 엔티티와 충돌할 수 있다.
 *   결정적 규칙의 한계로, 다음 단계는 보호 이름 목록 또는 LLM 해소다
 *   (memora는 임베딩 유사도 + LLM 검증으로 이 문제를 피한다 — 비교 메모 참조).
 * - 기존 행의 normalized는 바꾸지 않는다 (백필 없음 — 재연결 시부터 적용).
 */
export function normalizeEntityName(name: string): string {
  const base = normalizeForDuplicate(name)
  if (!base) return ''
  return stripKoreanParticle(base)
}

/**
 * zero-LLM 엔티티 추출 (결정적 휴리스틱만):
 * - 큰따옴표 구간 ("...", “...”)
 * - 날짜·시간 토큰 (2026-10-25, 10월 25일, 10시 30분)
 * - 약어·고유명사형 토큰 (대문자 포함, 첫 글자 대문자인 일반 단어 제외 — "MyHub", "D1", "API")
 */
export function extractEntities(text: string, maxEntities: number = MAX_ENTITIES_PER_FACT): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const push = (name: string) => {
    const display = (name || '').trim()
    if (display.length < 2 || display.length > 200) return
    const norm = normalizeEntityName(display)
    if (!norm || seen.has(norm)) return
    seen.add(norm)
    found.push(display)
  }
  const quoted = (text || '').matchAll(QUOTED_RE)
  for (const m of quoted) push(m[1])
  const dates = (text || '').match(DATE_TIME_RE)
  for (const d of dates || []) push(d.replace(/\s+/g, ''))
  const tokens = (text || '').match(ACRONYM_RE)
  for (const t of tokens || []) {
    // 첫 글자만 대문자인 일반 단어("The") 제외: 대문자가 2개 이상이거나
    // 첫 글자 이후에 대문자가 있거나 숫자를 포함해야 한다
    const rest = t.slice(1)
    if (/[A-Z]/.test(rest) || /\d/.test(t) || /^[A-Z]{2,}$/.test(t)) push(t)
  }
  return found.slice(0, Math.min(Math.max(maxEntities, 1), 20))
}
