/// <reference types="jest" />
/**
 * 대화 목록 페이지네이션 파라미터 정규화 (src/lib/conversation-list.ts).
 * 검증 성질: 기본값 50, 상한 100, 하한 1, offset 음수·비숫자는 0/기본값으로
 * 떨어져 어떤 입력에도 쿼리가 계약 범위 밖으로 나가지 않는다.
 */
import {
  parseConversationListParams,
  CONVERSATION_LIST_DEFAULT_LIMIT,
  CONVERSATION_LIST_MAX_LIMIT,
} from '../src/lib/conversation-list'

describe('parseConversationListParams', () => {
  test('파라미터 없음 → 기본 50건, offset 0', () => {
    expect(parseConversationListParams(undefined, undefined)).toEqual({ limit: 50, offset: 0 })
    expect(parseConversationListParams(null, null)).toEqual({ limit: 50, offset: 0 })
    expect(CONVERSATION_LIST_DEFAULT_LIMIT).toBe(50)
  })

  test('정상 값은 그대로 통과', () => {
    expect(parseConversationListParams('10', '30')).toEqual({ limit: 10, offset: 30 })
    expect(parseConversationListParams('100', '0')).toEqual({ limit: 100, offset: 0 })
  })

  test('limit 상한 100으로 클램프 (전량 반환 재발 방지)', () => {
    expect(parseConversationListParams('101', '0').limit).toBe(CONVERSATION_LIST_MAX_LIMIT)
    expect(parseConversationListParams('99999', '0').limit).toBe(100)
  })

  test('limit 하한 1, 소수는 내림', () => {
    expect(parseConversationListParams('0', '0').limit).toBe(1)
    expect(parseConversationListParams('10.9', '5.7')).toEqual({ limit: 10, offset: 5 })
  })

  test('비숫자·음수 → 기본값/0', () => {
    expect(parseConversationListParams('abc', '-5')).toEqual({ limit: 50, offset: 0 })
    expect(parseConversationListParams('', '')).toEqual({ limit: 50, offset: 0 })
  })
})
