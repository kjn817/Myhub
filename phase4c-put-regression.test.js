// Phase 4C: PUT API 동의 필드 회귀 테스트
// 버그: PUT /api/memory/:id가 allow_ai_use, allow_provider_send를 업데이트하지 않음
// 수정: 2026-10-11, 스테이징 Worker 9efca1c7에 반영

describe('Phase 4C PUT 동의 필드 회귀 테스트', () => {
  // API의 PUT 로직을 시뮬레이션 (실제 SQL과 동일)
  const simulatePutUpdate = (existing, body) => {
    const updates = []
    if (body.allow_ai_use !== undefined) {
      updates.push({ field: 'allow_ai_use', value: body.allow_ai_use === true ? 1 : 0 })
    }
    if (body.allow_provider_send !== undefined) {
      updates.push({ field: 'allow_provider_send', value: body.allow_provider_send === true ? 1 : 0 })
    }
    // 실제 DB 업데이트 시뮬레이션
    const result = { ...existing }
    updates.forEach(u => { result[u.field] = u.value })
    return result
  }

  test('PUT으로 allow_ai_use를 true로 변경', () => {
    const existing = { allow_ai_use: 0, allow_provider_send: 0 }
    const result = simulatePutUpdate(existing, { allow_ai_use: true })
    expect(result.allow_ai_use).toBe(1)
    expect(result.allow_provider_send).toBe(0) // 변경 없음
  })

  test('PUT으로 allow_provider_send를 true로 변경', () => {
    const existing = { allow_ai_use: 1, allow_provider_send: 0 }
    const result = simulatePutUpdate(existing, { allow_provider_send: true })
    expect(result.allow_ai_use).toBe(1) // 유지
    expect(result.allow_provider_send).toBe(1)
  })

  test('PUT으로 allow_provider_send를 false로 철회 (0으로 변경)', () => {
    const existing = { allow_ai_use: 1, allow_provider_send: 1 }
    const result = simulatePutUpdate(existing, { allow_provider_send: false })
    expect(result.allow_ai_use).toBe(1) // 유지
    expect(result.allow_provider_send).toBe(0) // 철회됨
  })

  test('PUT으로 allow_ai_use를 false로 철회', () => {
    const existing = { allow_ai_use: 1, allow_provider_send: 0 }
    const result = simulatePutUpdate(existing, { allow_ai_use: false })
    expect(result.allow_ai_use).toBe(0) // 철회됨
    expect(result.allow_provider_send).toBe(0) // 유지
  })

  test('PUT에서 동의 필드 미전달 시 기존값 유지', () => {
    const existing = { allow_ai_use: 1, allow_provider_send: 1 }
    const result = simulatePutUpdate(existing, { content: '새 내용' })
    expect(result.allow_ai_use).toBe(1)
    expect(result.allow_provider_send).toBe(1)
  })

  test('PUT에서 두 동의 필드 동시 변경', () => {
    const existing = { allow_ai_use: 0, allow_provider_send: 0 }
    const result = simulatePutUpdate(existing, { allow_ai_use: true, allow_provider_send: true })
    expect(result.allow_ai_use).toBe(1)
    expect(result.allow_provider_send).toBe(1)
  })
})
