/**
 * 대화 목록 (GET /api/ai/conversations) 페이지네이션·미리보기 계약.
 *
 * 배경 (docs/desktop-performance-baseline-20261031.md): 대화 316건 기준
 * 목록 응답 134,020B가 데스크톱 초기 API의 91%였다. 원인은 ① 페이지네이션
 * 없이 전량 반환, ② last_msg에 마지막 메시지 전문(평균 199자, 최대 5,095자)이
 * 실리는데 유일한 소비처(chat.js 목록 미리보기)는 40자만 표시하는 것이었다.
 *
 * 계약:
 * - 기본 limit=50, 상한 100. offset 기본 0.
 * - last_msg는 서버에서 미리보기 길이(40자)로 절단한다.
 * - 응답에 hasMore/nextOffset을 실어 이어보기로 전체에 도달할 수 있다.
 */

export const CONVERSATION_LIST_DEFAULT_LIMIT = 50
export const CONVERSATION_LIST_MAX_LIMIT = 100
export const CONVERSATION_PREVIEW_CHARS = 40

export interface ConversationListParams {
  limit: number
  offset: number
}

function parseNonNegativeInt(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return Math.floor(n)
}

/** limit/offset 쿼리를 계약 범위로 정규화한다. 잘못된 값은 기본값으로 떨어진다. */
export function parseConversationListParams(
  limitRaw?: string | null,
  offsetRaw?: string | null,
): ConversationListParams {
  const limitParsed = parseNonNegativeInt(limitRaw)
  const limit =
    limitParsed === null
      ? CONVERSATION_LIST_DEFAULT_LIMIT
      : Math.min(Math.max(limitParsed, 1), CONVERSATION_LIST_MAX_LIMIT)
  const offsetParsed = parseNonNegativeInt(offsetRaw)
  const offset = offsetParsed === null ? 0 : Math.max(offsetParsed, 0)
  return { limit, offset }
}
