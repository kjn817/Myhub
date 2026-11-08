/**
 * Phase 2B — Retry-After 파싱 및 백오프 정책
 *
 * 429 응답의 Retry-After 헤더를 안전하게 파싱하고,
 * 백오프 결정을 내림.
 *
 * 지원 형식:
 * - 정수/숫자 초 (예: "120", "1.5")
 * - HTTP 날짜 (예: "Wed, 21 Oct 2015 07:28:00 GMT")
 *
 * 안전 처리:
 * - 파싱 불가 → null
 * - 음수 → 0으로 처리
 * - 비정상적으로 긴 값(>1시간) → 상한 적용
 */

export interface RetryDecision {
  /** 재시도 가능 여부 */
  canRetry: boolean
  /** 대기 시간 (ms), 즉시 재시도 불가시 0 */
  waitMs: number
  /** 재시도 가능 시점 (Unix ms), 알 수 없으면 undefined */
  retryAt?: number
  /** 판단 이유 */
  reason: string
}

/** 최대 대기 시간 (1시간) */
const MAX_WAIT_MS = 60 * 60 * 1000

/** 짧은 지연 임계값 (30초) - 이 이하는 대기 검토 */
const SHORT_DELAY_THRESHOLD_MS = 30 * 1000

/**
 * Retry-After 헤더 값 파싱
 * @returns 대기 시간 (ms), 파싱 불가시 null
 */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value || typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  // 1. 숫자 형식 (초 단위)
  const numeric = Number(trimmed)
  if (!isNaN(numeric) && isFinite(numeric)) {
    // 음수는 0으로
    const seconds = Math.max(0, numeric)
    const ms = Math.floor(seconds * 1000)
    // 상한 적용
    return Math.min(ms, MAX_WAIT_MS)
  }

  // 2. HTTP 날짜 형식
  const dateMs = Date.parse(trimmed)
  if (!isNaN(dateMs)) {
    const now = Date.now()
    const diff = dateMs - now
    // 과거 시간이면 0
    if (diff <= 0) {
      return 0
    }
    // 상한 적용
    return Math.min(diff, MAX_WAIT_MS)
  }

  // 파싱 불가
  return null
}

/**
 * 429 응답에 대한 재시도 결정
 *
 * @param retryAfterHeader Retry-After 헤더 값
 * @param abortSignal 취소 신호 (취소 우선)
 * @param elapsedMs 이미 경과한 시간
 * @param maxTotalMs 전체 요청 제한 시간
 */
export function decideRetry(
  retryAfterHeader: string | null | undefined,
  options: {
    abortSignal?: AbortSignal
    elapsedMs?: number
    maxTotalMs?: number
  } = {}
): RetryDecision {
  // 취소 우선
  if (options.abortSignal?.aborted) {
    return {
      canRetry: false,
      waitMs: 0,
      reason: 'cancelled',
    }
  }

  const waitMs = parseRetryAfter(retryAfterHeader)

  // 파싱 불가 → 재시도 불가 (무작정 대기하지 않음)
  if (waitMs === null) {
    return {
      canRetry: false,
      waitMs: 0,
      reason: 'retry-after-unparseable',
    }
  }

  // 전체 시간 한도 체크
  const elapsed = options.elapsedMs || 0
  const maxTotal = options.maxTotalMs || 60000 // 기본 60초
  const remaining = maxTotal - elapsed

  if (waitMs > remaining) {
    // 대기 시간이 남은 시간을 초과 → 종료하고 재시도 시점 표시
    return {
      canRetry: false,
      waitMs: 0,
      retryAt: Date.now() + waitMs,
      reason: 'wait-exceeds-budget',
    }
  }

  // 짧은 지연 → 대기 가능
  if (waitMs <= SHORT_DELAY_THRESHOLD_MS) {
    return {
      canRetry: true,
      waitMs,
      retryAt: Date.now() + waitMs,
      reason: 'short-delay',
    }
  }

  // 긴 지연 → 종료하고 재시도 시점 표시
  return {
    canRetry: false,
    waitMs: 0,
    retryAt: Date.now() + waitMs,
    reason: 'long-delay-terminate',
  }
}
