/**
 * 텍스트 길이 상한 공용 상수 (S5-4, 5-9).
 *
 * 8000이라는 값이 여러 곳에 흩어져 있었으나 의미가 둘로 갈린다:
 * - MAX_USER_TEXT_LENGTH: 마지막 사용자 메시지 길이 검증 (초과 시 거부).
 * - MAX_TRUNCATED_USER_TEXT_CHARS: 저장·전송 전 사용자 텍스트 자르기
 *   (초과분을 버리고 앞부분만 유지).
 * 값은 같지만 정책이 독립적이라 이름을 나눈다 — 한쪽 상한을 바꿀 때
 * 다른 쪽이 따라 바뀌면 안 된다.
 */

/** 마지막 사용자 메시지 길이 상한 (자) — 초과 시 'too long' 거부. */
export const MAX_USER_TEXT_LENGTH = 8000

/** 저장·전송용 사용자 텍스트 자르기 상한 (자) — 초과분은 버린다. */
export const MAX_TRUNCATED_USER_TEXT_CHARS = 8000
