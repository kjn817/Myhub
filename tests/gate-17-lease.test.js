/**
 * 관문 테스트 17: Job lease 중복 실행 방지
 *
 * 기대:
 * - pending job → claim 성공
 * - 이미 running이고 lease 유효 → claim 실패 (busy)
 * - running이지만 lease 만료 → claim 성공 (stuck job 회수)
 * - done/failed → claim 실패
 */

function canClaim(status, leaseExpires, now) {
  if (status === 'pending') return true
  if (status === 'running') {
    if (!leaseExpires) return true
    return new Date(leaseExpires) < now
  }
  return false // done, failed
}

describe('관문 17: Job lease', () => {
  const now = new Date()

  test('pending → claim 성공', () => {
    expect(canClaim('pending', null, now)).toBe(true)
  })

  test('running + lease 유효 → claim 실패', () => {
    const future = new Date(now.getTime() + 60000).toISOString()
    expect(canClaim('running', future, now)).toBe(false)
  })

  test('running + lease 만료 → claim 성공 (회수)', () => {
    const past = new Date(now.getTime() - 60000).toISOString()
    expect(canClaim('running', past, now)).toBe(true)
  })

  test('done → claim 실패', () => {
    expect(canClaim('done', null, now)).toBe(false)
  })

  test('failed → claim 실패', () => {
    expect(canClaim('failed', null, now)).toBe(false)
  })
})
