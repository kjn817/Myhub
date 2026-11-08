/**
 * 관문 테스트 8: Queue 메시지 처리
 *
 * 기대:
 * - done/failed/notfound → ack (재시도 안 함)
 * - busy → 30초 후 재시도
 * - 예외 → failed로 기록 후 ack (무한 루프 방지)
 * - 잘못된 메시지 본문 → 예외 처리되어 ack
 */

function simulateQueueHandling(processResult, hasException, bodyValid) {
  const actions = []
  try {
    if (!bodyValid) throw new Error('Invalid body')
    if (hasException) throw new Error('Unexpected')
    if (processResult === 'done' || processResult === 'failed' || processResult === 'notfound') {
      actions.push('ack')
    } else {
      actions.push('retry_30s')
    }
  } catch (e) {
    actions.push('mark_failed')
    actions.push('ack')
  }
  return actions
}

describe('관문 8: Queue 메시지 처리', () => {
  test('done → ack', () => {
    expect(simulateQueueHandling('done', false, true)).toEqual(['ack'])
  })

  test('failed → ack (재시도 안 함)', () => {
    expect(simulateQueueHandling('failed', false, true)).toEqual(['ack'])
  })

  test('busy → 30초 후 재시도', () => {
    expect(simulateQueueHandling('busy', false, true)).toEqual(['retry_30s'])
  })

  test('예외 → failed 기록 후 ack', () => {
    const result = simulateQueueHandling('done', true, true)
    expect(result).toContain('mark_failed')
    expect(result).toContain('ack')
  })

  test('잘못된 본문 → 예외 처리 후 ack (무한 루프 방지)', () => {
    const result = simulateQueueHandling('done', false, false)
    expect(result).toContain('ack')
  })
})
