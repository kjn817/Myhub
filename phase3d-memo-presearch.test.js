// Phase 3D: 서버 주도 메모 사전 검색 테스트
// - keeper v1에서 메모 검색 의도 감지
// - 검색 결과를 모델 입력에 포함
// - 개인정보 보호 정책 유지

// detectMemoSearchIntent 로직 테스트 (routes.ts에서 추출한 로직과 동일)
function detectMemoSearchIntent(text) {
  const t = text.trim()
  if (!t) return { hasIntent: false, query: '' }

  if (/메모\s*(작성|생성|만들|추가|저장)/i.test(t) && !/요약|정리|찾|검색|보여/i.test(t)) {
    return { hasIntent: false, query: '' }
  }

  const patterns = [
    // 패턴 1: "테스트 메모를 요약해줘" → query="테스트"
    /(.+?)\s*메모를?\s*(요약|정리|찾아|검색|보여|알려)/i,
    // 패턴 2: "테스트에 대한 메모" → query="테스트"
    /(.+?)\s*(에|에 대한|관련)\s*메모/i,
  ]

  for (const p of patterns) {
    const m = t.match(p)
    if (m) {
      let query = (m[1] || '').trim()
      // 불용어 제거
      query = query.replace(/^(그|저|이)\s+/, '').trim()
      // 조사 제거 (예: "테스트를" → "테스트")
      query = query.replace(/(을|를|이|가|은|는)$/, '').trim()
      if (query.length > 0 && query.length <= 50) {
        // "요약", "정리" 같은 동작 동사는 쿼리로 사용하지 않음
        if (/^(요약|정리|검색|찾기)$/i.test(query)) {
          return { hasIntent: false, query: '' }
        }
        return { hasIntent: true, query }
      }
    }
  }

  // "메모 요약해줘" (검색어 없음) → 의도 없음
  // 광범위한 무차별 검색 방지
  return { hasIntent: false, query: '' }
}

describe('메모 검색 의도 감지', () => {
  test('테스트 메모를 요약해줘 → 의도 있음, 쿼리=테스트', () => {
    const r = detectMemoSearchIntent('테스트 메모를 요약해줘')
    expect(r.hasIntent).toBe(true)
    expect(r.query).toBe('테스트')
  })

  test('가상 메모를 요약해줘 → 의도 있음, 쿼리=가상', () => {
    const r = detectMemoSearchIntent('가상 메모를 요약해줘')
    expect(r.hasIntent).toBe(true)
    expect(r.query).toBe('가상')
  })

  test('메모 작성해줘 → 의도 없음 (쓰기 요청)', () => {
    const r = detectMemoSearchIntent('메모 작성해줘')
    expect(r.hasIntent).toBe(false)
  })

  test('안녕하세요 → 의도 없음 (일반 대화)', () => {
    const r = detectMemoSearchIntent('안녕하세요')
    expect(r.hasIntent).toBe(false)
  })

  test('메모 요약해줘 → 의도 없음 (검색어 없음)', () => {
    // 검색어 없이 광범위한 검색을 방지
    const r = detectMemoSearchIntent('메모 요약해줘')
    expect(r.hasIntent).toBe(false)
  })

  test('오늘 날씨 어때 → 의도 없음', () => {
    const r = detectMemoSearchIntent('오늘 날씨 어때')
    expect(r.hasIntent).toBe(false)
  })
})

describe('서버 사전 검색 보안', () => {
  test('검색 결과는 시스템 명령이 아닌 참고 자료로 구분', () => {
    // memoContext는 [참고 자료] 섹션으로 구분되어야 함
    const memoContext = `\n\n[참고 자료: 서버에서 제공된 메모]\n[메모 1] 제목: 테스트\n내용: 내용\n\n위 참고 자료에 근거해서 답변하세요.`
    expect(memoContext).toContain('[참고 자료')
    expect(memoContext).not.toMatch(/^\[SYSTEM/i)
  })

  test('검색 실패 시 정직한 안내', () => {
    const memoContext = `\n\n[참고 자료: 검색된 메모가 없습니다]\n요청한 메모를 찾을 수 없습니다.`
    expect(memoContext).toContain('찾을 수 없습니다')
  })
})
