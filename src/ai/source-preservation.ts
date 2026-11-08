/**
 * 원문 보존 및 앵커 검증 모듈 (61차)
 *
 * GPT 60차 권고 v2 설계의 실용적 구현:
 * - 서버가 사용자의 원본 메시지를 보존 (호출 체인을 통해 전달)
 * - 모델은 저장할 텍스트를 재생성하지 않고 "앵커"로 위치만 지정
 * - 서버가 원본에서 앵커를 검색하고 유일성을 검증한 후 원문을 그대로 추출
 * - 저장되는 텍스트는 항상 서버의 보존 원본에서 나오며, 모델 출력이 아님
 *
 * 안전 속성:
 * - 모델의 앵커에 오타가 있으면 검색 실패 → 저장 안 함 (fail-safe)
 * - 앵커가 여러 곳에 매칭되면 모호성 → 저장 안 함, 확인 요청
 * - 앵커가 없어도 저장 안 함
 */

export interface AnchorSearchResult {
  found: boolean
  /** 유일하게 매칭된 경우에만 설정 (서버 원본에서 추출한 텍스트) */
  extractedText?: string
  /** 매칭 횟수 */
  matchCount: number
  /** 실패 사유 */
  reason?: 'NOT_FOUND' | 'MULTIPLE_MATCHES' | 'EMPTY_ANCHOR'
}

/**
 * 원본 메시지에서 앵커 텍스트 검색
 *
 * @param originalText 서버가 보존한 원본 사용자 메시지
 * @param anchorText 모델이 제시한 앵커 텍스트
 * @returns 검색 결과 (유일 매칭 시 원본에서 추출한 텍스트)
 *
 * 중요: 반환되는 extractedText는 서버 원본의 해당 구간이며,
 * 모델이 제시한 anchorText와 다를 수 있음 (공백 등).
 * 저장 시에는 반드시 extractedText를 사용해야 함.
 */
export function searchAnchor(
  originalText: string,
  anchorText: string
): AnchorSearchResult {
  // 앵커 정규화 (앞뒤 공백만 제거, 내용은 그대로)
  const anchor = anchorText.trim()
  if (!anchor) {
    return { found: false, matchCount: 0, reason: 'EMPTY_ANCHOR' }
  }

  // 원본에서 검색 (정확히 일치하는 부분 문자열)
  let count = 0
  let firstIndex = -1
  let searchFrom = 0

  while (true) {
    const idx = originalText.indexOf(anchor, searchFrom)
    if (idx === -1) break
    count++
    if (firstIndex === -1) firstIndex = idx
    searchFrom = idx + 1
    // 2개 이상 찾으면 즉시 중단 (모호성)
    if (count > 1) break
  }

  // 결과 판정
  if (count === 0) {
    return { found: false, matchCount: 0, reason: 'NOT_FOUND' }
  }

  if (count > 1) {
    return { found: false, matchCount: count, reason: 'MULTIPLE_MATCHES' }
  }

  // 유일 매칭: 서버의 원본에서 그대로 추출
  // (모델의 앵커가 아닌 서버 원본의 해당 구간을 반환)
  const extracted = originalText.slice(firstIndex, firstIndex + anchor.length)

  return {
    found: true,
    extractedText: extracted,
    matchCount: 1,
  }
}

/**
 * 사용자 메시지에서 마지막 사용자 메시지 추출
 *
 * @param messages 전체 메시지 배열
 * @returns 마지막 사용자 메시지의 content, 없으면 null
 */
export function getLastUserMessage(
  messages: Array<{ role: string; content: string }>
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return messages[i].content
    }
  }
  return null
}
