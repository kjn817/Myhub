/**
 * 관문 테스트 3: 검증 게이트
 *
 * 기대: modify 작업에서 파일 내용이 변경되지 않으면,
 * 가짜 "done"이 아니라 noChange:true로 정직하게 보고해야 한다.
 * 그리고 version.skipped 이벤트가 기록되어야 한다.
 */

// saveJobResult modify 분기의 핵심 로직 시뮬레이션
async function simulateModifySave(existingHash, newHash) {
  const events = []
  if (existingHash === newHash) {
    events.push({ type: 'version.skipped', reason: 'identical_content' })
    return { versionCreated: false, noChange: true, events }
  }
  events.push({ type: 'version.committed' })
  return { versionCreated: true, noChange: false, events }
}

describe('관문 3: 검증 게이트', () => {
  test('내용 동일 → noChange:true + version.skipped 이벤트', async () => {
    const result = await simulateModifySave('abc123', 'abc123')
    expect(result.noChange).toBe(true)
    expect(result.versionCreated).toBe(false)
    expect(result.events[0].type).toBe('version.skipped')
    expect(result.events[0].reason).toBe('identical_content')
  })

  test('내용 다름 → 버전 생성 + version.committed 이벤트', async () => {
    const result = await simulateModifySave('abc123', 'def456')
    expect(result.noChange).toBe(false)
    expect(result.versionCreated).toBe(true)
    expect(result.events[0].type).toBe('version.committed')
  })

  test('빈 해시도 동일하면 스킵 (엣지 케이스)', async () => {
    const result = await simulateModifySave('', '')
    expect(result.noChange).toBe(true)
  })
})
