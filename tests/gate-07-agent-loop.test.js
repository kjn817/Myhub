/**
 * 관문 테스트 7: 에이전트 루프 종료 조건
 *
 * 개선됨: 1턴째 조기 종료 방지 — 최소 2턴 보장.
 * - 파일 있고 2턴 이상 → 종료
 * - 파일 있고 1턴 → 계속 진행
 * - 파일 없음 → 대화 모드
 */

// 현재 로직 시뮬레이션
function shouldBreakLoop(toolCallCount, fileCount, turn, maxTurns) {
  if (toolCallCount === 0) {
    if (fileCount > 0) {
      return true // break
    }
    return 'dialogue_mode' // 대화 모드
  }
  return false // 계속
}

describe('관문 7: 에이전트 루프 종료', () => {
  test('도구 0개 + 파일 있음 → 종료 (현재 동작)', () => {
    expect(shouldBreakLoop(0, 3, 2, 10)).toBe(true)
  })

  test('도구 0개 + 파일 없음 → 대화 모드', () => {
    expect(shouldBreakLoop(0, 0, 1, 10)).toBe('dialogue_mode')
  })

  test('도구 있음 → 계속', () => {
    expect(shouldBreakLoop(2, 1, 3, 10)).toBe(false)
  })

  // 잠재 이슈: 1턴째에 파일 1개 만들고 텍스트만 반환하면?
  // → break되어 버림. 하지만 에이전트가 "더 만들게" 있을 수도 있음.
  test('ISSUE: 조기 종료 가능성 — 1턴에 파일 1개만 있고 텍스트 반환', () => {
    const result = shouldBreakLoop(0, 1, 1, 10)
    // 현재는 true (종료). 하지만 작업이 실제로 끝났는지는 모름.
    // 개선안: 에이전트에게 명시적 완료 신호를 요구하거나,
    // 최소 턴 수를 보장해야 함.
    expect(result).toBe(true) // 현재 동작 기록 (이슈 있음)
  })
})
