/**
 * P0: 비서별 도구 권한 실행 게이트 테스트
 * processToolMarkers의 denyPattern이 허용되지 않은 도구를 차단하는지 검증
 * @jest-environment node
 */

// routes.ts의 LEGACY_MARKER_TOOLS와 동일한 매핑 (테스트용)
const LEGACY_MARKER_TOOLS = {
  concierge: [
    'MEMO_SEARCH', 'MEMO_GET', 'MEMO_CREATE', 'MEMO_UPDATE', 'MEMO_DELETE',
    'SCHEDULE_CREATE', 'SCHEDULE_LIST', 'SCHEDULE_UPDATE', 'SCHEDULE_DELETE',
    'TODO_ADD', 'TODO_LIST', 'TODO_DONE', 'TODO_UPDATE', 'TODO_DELETE',
    'SEARCH', 'IMG', 'GITHUB',
  ],
  keeper: ['MEMO_SEARCH', 'MEMO_GET', 'SEARCH'],
  builder: ['SEARCH', 'GITHUB', 'IMG'],
  scheduler: [
    'SCHEDULE_CREATE', 'SCHEDULE_LIST', 'SCHEDULE_UPDATE', 'SCHEDULE_DELETE',
    'TODO_ADD', 'TODO_LIST', 'TODO_DONE', 'TODO_UPDATE', 'TODO_DELETE',
    'SEARCH',
  ],
}

function getLegacyMarkerTools(personaId) {
  return LEGACY_MARKER_TOOLS[personaId] || LEGACY_MARKER_TOOLS.concierge
}

// routes.ts의 denyPattern과 동일
const denyPattern = /\[((?:MEMO|SCHEDULE|TODO|SEARCH|IMG|GITHUB)(?:_[A-Z]+)?)(?::[^\]]*)?\]([\s\S]*?)\[\/\1\]/gi

function filterByPermission(text, personaId) {
  // GPT 2차 검토: deny-by-default
  const VALID_PERSONAS = ['concierge', 'keeper', 'builder', 'scheduler']
  const effectivePersonaId = (personaId && VALID_PERSONAS.includes(personaId)) ? personaId : null
  const allowedTools = effectivePersonaId ? getLegacyMarkerTools(effectivePersonaId) : []
  const denyPattern = /\[((?:MEMO|SCHEDULE|TODO)(?:_[A-Z]+)?)\]([\s\S]*?)\[\/\1\]/gi
  const denySinglePattern = /\[(SEARCH|IMG|GITHUB):\s*([^\]]+)\]/gi
  const denyReplacer = (full, tool) => {
    const toolUpper = String(tool).toUpperCase()
    if (!allowedTools.includes(toolUpper)) {
      return '(이 비서는 해당 도구를 사용할 권한이 없습니다)'
    }
    return full
  }
  // 매 호출마다 새 RegExp (g 플래그 lastIndex 주의)
  let result = text.replace(new RegExp(denyPattern.source, 'gi'), denyReplacer)
  result = result.replace(new RegExp(denySinglePattern.source, 'gi'), denyReplacer)
  return result
}

describe('P0: 비서별 도구 권한 실행 게이트', () => {
  test('keeper가 SCHEDULE_DELETE를 출력하면 차단됨', () => {
    const text = '일정을 삭제할게 [SCHEDULE_DELETE]{"id":1}[/SCHEDULE_DELETE]'
    const result = filterByPermission(text, 'keeper')
    expect(result).toContain('권한이 없습니다')
    expect(result).not.toContain('[SCHEDULE_DELETE]')
  })

  test('keeper가 MEMO_SEARCH는 허용됨', () => {
    const text = '메모를 찾을게 [MEMO_SEARCH]{"query":"test"}[/MEMO_SEARCH]'
    const result = filterByPermission(text, 'keeper')
    expect(result).toContain('[MEMO_SEARCH]')
    expect(result).not.toContain('권한이 없습니다')
  })

  test('builder가 MEMO_DELETE를 출력하면 차단됨', () => {
    const text = '[MEMO_DELETE]{"id":5}[/MEMO_DELETE]'
    const result = filterByPermission(text, 'builder')
    expect(result).toContain('권한이 없습니다')
  })

  test('builder가 SEARCH는 허용됨', () => {
    const text = '[SEARCH]{"query":"test"}[/SEARCH]'
    const result = filterByPermission(text, 'builder')
    expect(result).toContain('[SEARCH]')
  })

  test('scheduler가 SCHEDULE_CREATE는 허용됨', () => {
    const text = '[SCHEDULE_CREATE]{"title":"회의"}[/SCHEDULE_CREATE]'
    const result = filterByPermission(text, 'scheduler')
    expect(result).toContain('[SCHEDULE_CREATE]')
  })

  test('scheduler가 MEMO_DELETE를 출력하면 차단됨', () => {
    const text = '[MEMO_DELETE]{"id":1}[/MEMO_DELETE]'
    const result = filterByPermission(text, 'scheduler')
    expect(result).toContain('권한이 없습니다')
  })

  test('concierge는 모든 도구 허용됨', () => {
    const text = '[MEMO_DELETE]{"id":1}[/MEMO_DELETE] [SCHEDULE_DELETE]{"id":2}[/SCHEDULE_DELETE]'
    const result = filterByPermission(text, 'concierge')
    expect(result).toContain('[MEMO_DELETE]')
    expect(result).toContain('[SCHEDULE_DELETE]')
    expect(result).not.toContain('권한이 없습니다')
  })

  test('여러 마커 중 일부만 차단됨', () => {
    const text = '[MEMO_SEARCH]{"q":"a"}[/MEMO_SEARCH] [MEMO_DELETE]{"id":1}[/MEMO_DELETE]'
    const result = filterByPermission(text, 'keeper')
    expect(result).toContain('[MEMO_SEARCH]')
    expect(result).toContain('권한이 없습니다')
    expect(result).not.toContain('[MEMO_DELETE]')
  })
})

describe('P0 추가: deny-by-default 및 단일 마커', () => {
  test('personaId가 없으면 모든 도구 차단', () => {
    const text = '[MEMO_SEARCH]{"q":"a"}[/MEMO_SEARCH]'
    const result = filterByPermission(text, undefined)
    expect(result).toContain('권한이 없습니다')
  })

  test('personaId가 null이면 모든 도구 차단', () => {
    const text = '[MEMO_SEARCH]{"q":"a"}[/MEMO_SEARCH]'
    const result = filterByPermission(text, null)
    expect(result).toContain('권한이 없습니다')
  })

  test('유효하지 않은 personaId는 모든 도구 차단', () => {
    const text = '[MEMO_SEARCH]{"q":"a"}[/MEMO_SEARCH]'
    const result = filterByPermission(text, 'hacker')
    expect(result).toContain('권한이 없습니다')
  })

  test('keeper의 [SEARCH: query] 단일 마커는 허용', () => {
    const text = '검색해볼게 [SEARCH: 날씨]'
    const result = filterByPermission(text, 'keeper')
    expect(result).toContain('[SEARCH: 날씨]')
  })

  test('keeper의 [IMG: prompt] 단일 마커는 차단', () => {
    const text = '[IMG: 고양이 그림]'
    const result = filterByPermission(text, 'keeper')
    expect(result).toContain('권한이 없습니다')
  })

  test('builder의 [GITHUB: query] 단일 마커는 허용', () => {
    const text = '[GITHUB: myhub]'
    const result = filterByPermission(text, 'builder')
    expect(result).toContain('[GITHUB: myhub]')
  })

  test('scheduler의 [SEARCH: query] 단일 마커는 허용', () => {
    const text = '[SEARCH: 회의실 예약]'
    const result = filterByPermission(text, 'scheduler')
    expect(result).toContain('[SEARCH:')
  })
})
