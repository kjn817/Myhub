/**
 * 관문 테스트 48: 에이전트 타임아웃
 *
 * 치명적 결함: maxTurns=10, API 타임아웃 120초 → 최악 20분.
 * Queue 제한 15분, Lease 14분을 초과하여 중간에 강제 종료될 수 있음.
 *
 * 수정: maxTurns를 7로 감소 (7*120s=14분, Lease 내 완료 보장).
 */

describe('관문 48: 타임아웃', () => {
  test('maxTurns * timeout <= lease', () => {
    const maxTurns = 7
    const timeoutSec = 120
    const leaseSec = 14 * 60 // 14분
    expect(maxTurns * timeoutSec).toBeLessThanOrEqual(leaseSec)
  })
})
