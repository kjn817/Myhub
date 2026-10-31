/**
 * 인용 잠금 (Citation Lock) — 뉴스·메모리 경로 공용 검증 코어
 * (진짜 비서 1단계 c트랙, 2026-10-26)
 *
 * Agent Zero Memory 패턴의 인용 잠금을 MyHub에 맞게 이식한 것 (개념만 참고,
 * 코드 복사 없음):
 * - 검색 시 실제로 연 근거만 인용한다. 허용 집합에 없는 참조는 지어낸 것이다.
 * - 근거가 없으면 단정하지 않고 abstain한다 ("기록에 없습니다").
 *
 * 뉴스 경로(src/lib/news-summary.ts)의 validateItemSources와 메모리 경로가
 * 이 파일의 공용 코어를 공유한다:
 * - checkReferences: 허용 집합 기준 참조 분할 (인용됨/유효/제거/근거없음 판정)
 *   → 메모리 인용 검증(validateMemoryCitations)이 쓴다.
 * - pickFirstValidReference: 허용 집합에서 아직 쓰지 않은 첫 참조 선택
 *   → 뉴스 항목별 URL 할당(validateItemSources)이 쓴다.
 *
 * 순수 함수만 둔다 (DB·모델 호출 없음 — 단위 테스트 대상).
 * 잠긴 메모의 내용은 이 모듈에 들어오지 않는다 (검색 단계에서 이미 제외됨).
 */

import type { MemoryItem } from '../services/memory-service'

// ---------------------------------------------------------------------------
// 공용 코어: 허용 집합 기준 참조 검증
// ---------------------------------------------------------------------------

export interface ReferenceCheck {
  /** 응답에서 발견된 참조 키 전체 */
  cited: string[]
  /** 허용 집합에 속한 참조 */
  valid: string[]
  /** 허용 집합에 없어 제거 대상인 참조 (지어낸 것) */
  removed: string[]
  /** 참조를 시도했으나 유효한 참조가 하나도 없음 → 근거 없는 단정 */
  ungrounded: boolean
}

/**
 * 참조 키 목록을 허용 집합 기준으로 분할한다.
 * - cited: 원본 순서 유지 (중복 포함 — 호출자가 필요하면 dedupe)
 * - valid/removed: 중복 제거, 첫 등장 순서 유지
 * - ungrounded: cited가 1개 이상이고 valid가 0개
 */
export function checkReferences(
  cited: string[],
  allowed: ReadonlySet<string>,
): ReferenceCheck {
  const valid: string[] = []
  const removed: string[] = []
  const seenValid = new Set<string>()
  const seenRemoved = new Set<string>()
  for (const key of cited) {
    if (allowed.has(key)) {
      if (!seenValid.has(key)) {
        seenValid.add(key)
        valid.push(key)
      }
    } else if (!seenRemoved.has(key)) {
      seenRemoved.add(key)
      removed.push(key)
    }
  }
  return {
    cited: [...cited],
    valid,
    removed,
    ungrounded: cited.length > 0 && valid.length === 0,
  }
}

/**
 * 후보 목록에서 허용 집합에 있고 아직 쓰지 않은 첫 참조를 고른다.
 * - 뉴스 경로: 항목 블록 안의 URL 후보 중 Exa 목록에 있고 미사용인 첫 URL.
 * - 허용 여부 판정은 isAllowed 콜백에 위임한다 (URL 정규화·ID 비교 등 각 경로의
 *   키 형식을 호출자가 안다).
 * - 없으면 null (호출자는 참조를 지어내지 않고 출처 없이 둔다).
 */
export function pickFirstValidReference(
  candidates: string[],
  isAllowed: (key: string) => boolean,
  used: ReadonlySet<string>,
): string | null {
  for (const key of candidates) {
    if (!key) continue
    if (isAllowed(key) && !used.has(key)) return key
  }
  return null
}

// ---------------------------------------------------------------------------
// 메모리 인용: [기억 #id] 마커
// ---------------------------------------------------------------------------

/** 메모리 인용 마커: [기억 #12] / [기억 12] (공백 허용). */
export const MEMORY_CITATION_RE = /\[기억\s*#?\s*(\d+)\]/g

/** 응답에서 인용된 기억 ID 전체 (등장 순서, 중복 포함). */
export function extractMemoryCitations(text: string): number[] {
  if (!text) return []
  const ids: number[] = []
  MEMORY_CITATION_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MEMORY_CITATION_RE.exec(text)) !== null) {
    const id = Number(m[1])
    if (Number.isInteger(id) && id > 0) ids.push(id)
  }
  return ids
}

export interface MemoryCitationCheck extends ReferenceCheck {
  /** 지어낸 인용 마커를 제거한 텍스트 (유효한 인용은 유지) */
  text: string
  /** 인용된 기억 ID (숫자) */
  citedIds: number[]
  /** 실제로 주입된 기억 중 인용된 ID */
  validIds: number[]
  /** 주입되지 않았는데 인용된 ID (지어낸 인용) */
  removedIds: number[]
}

/**
 * 메모리 인용 검증: 답변이 인용한 기억이 실제로 검색·주입된 것인지 대조한다.
 * - 허용 집합에 없는 ID의 마커는 텍스트에서 제거한다 (앞뒤 공백 1개까지 정리).
 * - ungrounded: 인용을 시도했으나 유효한 인용이 하나도 없음 → 근거 없는 단정.
 *   호출자(routes)는 이 경우 abstain 응답으로 교체한다.
 * - 인용이 전혀 없는 응답은 여기서 판정하지 않는다 (프롬프트 지시로만 강제 —
 *   일반 대화에서 기억을 배경으로만 쓴 경우까지 abstain하면 오탐이 된다).
 */
export function validateMemoryCitations(
  text: string,
  allowedIds: ReadonlySet<number> | number[],
): MemoryCitationCheck {
  const allowed = new Set([...allowedIds].map((n) => String(n)))
  const citedIds = extractMemoryCitations(text || '')
  const check = checkReferences(citedIds.map(String), allowed)
  let cleaned = text || ''
  if (check.removed.length > 0) {
    const removedSet = new Set(check.removed)
    cleaned = cleaned.replace(MEMORY_CITATION_RE, (match, id: string) => {
      if (removedSet.has(String(Number(id)))) return ''
      return match
    })
    // 마커 제거로 생긴 이중 공백·문장 앞뒤 공백을 정리한다
    cleaned = cleaned.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim()
  }
  return {
    ...check,
    text: cleaned,
    citedIds,
    validIds: check.valid.map(Number),
    removedIds: check.removed.map(Number),
  }
}

/** 인용 가능한 기억 ID만 모은다 (대체된 기억은 사실로 인용 불가 — 제외). */
export function citableMemoryIds(
  memories: Array<Pick<MemoryItem, 'id' | 'superseded'>>,
): number[] {
  return (memories || []).filter((m) => !m.superseded).map((m) => m.id)
}

// ---------------------------------------------------------------------------
// Abstain 응답 (근거 없음 → 단정 금지)
// ---------------------------------------------------------------------------

/** 기억 회상 질문인데 검색된 기억이 없을 때의 응답. */
export const ABSTAIN_NO_MEMORY_TEXT =
  '기록에 없습니다. 저장된 기억 중에 관련 내용이 없어서 단정해서 답할 수 없습니다. 다른 표현으로 물어보시거나, 기억으로 저장해 두면 다음부터 답할 수 있습니다.'

/** 인용을 시도했으나 유효한 근거가 하나도 없을 때의 응답. */
export const ABSTAIN_UNGROUNDED_TEXT =
  '기록에 근거한 답을 찾지 못했습니다. 저장된 기억을 확인했지만 질문에 답할 근거가 없어서 단정하지 않겠습니다.'

/**
 * 기억 회상 의도 판정 (보수적 — 확실한 회상 표현만).
 * - "기억" 동사/명사: 기억해? 기억나? 기억하고 있어? 내 ... 기억해?
 * - "알고 있어?" 계열은 단독으로는 너무 넓어서, 1인칭 소유 표현(내/나의/우리)과
 *   함께 나올 때만 회상으로 본다.
 * - 일반 질문("내일 뭐해?", "이거 뭐야?")은 회상이 아니다 — 오탐 방지용
 *   부정 패턴은 아래 테스트 케이스로 고정한다.
 */
const RECALL_VERB_RE = /기억(하|해|하고|나|에|을|이)?/
const RECALL_KNOW_RE = /(내|나의|우리)\s+\S{1,20}\s*(알고\s*있(어|어요)?|알아)\s*\?/

export function detectMemoryRecallIntent(text: string): boolean {
  const t = (text || '').trim()
  if (!t) return false
  if (RECALL_VERB_RE.test(t)) return true
  if (RECALL_KNOW_RE.test(t)) return true
  return false
}

/** 모델에 주는 인용 지시 (formatMemoryContext 말미에 붙는다). */
export const MEMORY_CITATION_INSTRUCTION =
  `인용 규칙: 위 기억에 근거한 내용은 반드시 [기억 #id] 형태로 인용할 것 (예: [기억 #12]). ` +
  `인용할 기억이 없으면 단정하지 말고 "기록에 없습니다"라고 답할 것. 기억에 없는 내용을 지어내지 말 것. ` +
  `[대체됨] 표시가 있는 기억은 오래된 내용이라 사실로 인용하지 말 것 — 대체한 새 기억을 인용할 것.`
