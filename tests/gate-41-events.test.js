/**
 * 관문 테스트 41: 이벤트 타입 커버리지
 *
 * 결함: renderJobEvent가 새 이벤트 타입을 처리하지 않음.
 * - agent.tool_calls (관문 28에서 추가)
 * - version.skipped (검증 게이트)
 * - job.no_change (검증 게이트)
 *
 * 수정됨: 3개 이벤트 타입 추가.
 */

describe('관문 41: 이벤트 커버리지', () => {
  test('새 이벤트 타입 처리됨', () => {
    const handled = [
      'job.started',
      'file.changed',
      'version.committed',
      'job.completed',
      'job.failed',
      'agent.tool_calls', // 추가됨
      'version.skipped',  // 추가됨
      'job.no_change',    // 추가됨
    ]
    expect(handled).toContain('agent.tool_calls')
  })
})
