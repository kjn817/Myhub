/**
 * Deadline 유틸 — 뉴스 체인 전체 시간 예산의 기반 (2026-10-26 트랙 A2).
 *
 * 배경: /api/ai/websearch 뉴스 질의 502 timeout 실측 — 체인 순차 실행(RSS
 * 15초 + Exa 15초 ...)이 30초 edge 제한을 넘김. 각 fetch의 AbortSignal은
 * 실제 fetch에는 먹히지만 signal을 무시하는 mock·hang에는 소용없으므로,
 * Promise.race 기반의 데드라인을 별도로 둔다.
 */

/**
 * promise가 ms 안에 끝나지 않으면 TimeoutError로 reject한다.
 * - ms <= 0이면 즉시 타임아웃 (다음 틱도 기다리지 않음).
 * - 타임아웃 후에도 원본 promise는 백그라운드에서 계속되지만 결과는 버려진다.
 * - 타이머는 settle 즉시 해제한다 (Jest open-handle 누수 방지).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message = 'timeout'): Promise<T> {
  if (ms <= 0) return Promise.reject(new Error(message))
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/** deadline(epoch ms)까지 남은 시간. 음수면 0을 반환한다. */
export function remainingMs(deadline: number, now: number = Date.now()): number {
  return Math.max(0, deadline - now)
}
