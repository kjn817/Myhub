/// <reference types="jest" />
import { normalizeSearchMarkers, extractSearchQuery } from '../../src/lib/search-marker'
import { composeSystemPrompt } from '../../src/ai/prompts/composer'

describe('persona-v1 프롬프트의 웹검색 지시 (합성 결과 기준)', () => {
  test('루미 합성 프롬프트에 [SEARCH: ] 지시가 포함된다', () => {
    const p = composeSystemPrompt({ personaId: 'concierge' })
    expect(p).toContain('[SEARCH: 검색어]')
  })

  test('에코 합성 프롬프트에 [SEARCH: ] 지시와 거부 금지 문구가 포함된다', () => {
    const p = composeSystemPrompt({ personaId: 'keeper' })
    expect(p).toContain('[SEARCH: 검색어]')
    expect(p).toContain('거부하지 마라')
  })

  test('캘리 합성 프롬프트에 [SEARCH: ] 지시가 포함된다', () => {
    const p = composeSystemPrompt({ personaId: 'scheduler' })
    expect(p).toContain('[SEARCH: 검색어]')
  })

  test('노바 합성 프롬프트에도 [SEARCH: ] 지시가 있다 (기존 유지 확인)', () => {
    const p = composeSystemPrompt({ personaId: 'builder' })
    expect(p).toContain('[SEARCH:')
  })
})

describe('normalizeSearchMarkers', () => {
  test('평문 블록형 [SEARCH]...[/SEARCH]을 표준형으로 변환 (2026-10-21 루미 실측 케이스)', () => {
    expect(normalizeSearchMarkers('[SEARCH]오늘 아침 주요 뉴스[/SEARCH]'))
      .toBe('[SEARCH: 오늘 아침 주요 뉴스]')
  })

  test('문장 속 블록형도 변환한다', () => {
    expect(normalizeSearchMarkers('검색해볼게요. [SEARCH]내일 날씨[/SEARCH]'))
      .toBe('검색해볼게요. [SEARCH: 내일 날씨]')
  })

  test('JSON 블록형 [SEARCH]{"query"}[/SEARCH] 변환', () => {
    expect(normalizeSearchMarkers('[SEARCH]{"query": "오늘 뉴스"}[/SEARCH]'))
      .toBe('[SEARCH: 오늘 뉴스]')
  })

  test('JSON 블록형 [WEB_SEARCH]{"query"}[/WEB_SEARCH] 변환 (기존 대응 유지)', () => {
    expect(normalizeSearchMarkers('[WEB_SEARCH]{"query": "오늘 뉴스"}[/WEB_SEARCH]'))
      .toBe('[SEARCH: 오늘 뉴스]')
  })

  test('JSON 블록형 공백 제로도 변환한다 (감사 §4 #4 — \\s* 뮤턴트)', () => {
    // 콜론·쉼표·중괄호 앞뒤 공백이 전혀 없어도 JSON 블록 정규식이 매칭돼야 한다
    expect(normalizeSearchMarkers('[SEARCH]{"query":"오늘 뉴스"}[/SEARCH]'))
      .toBe('[SEARCH: 오늘 뉴스]')
    expect(normalizeSearchMarkers('[WEB_SEARCH]{"query":"오늘 뉴스"}[/WEB_SEARCH]'))
      .toBe('[SEARCH: 오늘 뉴스]')
    expect(normalizeSearchMarkers('[SEARCH]{"query" :"오늘 뉴스" }[/SEARCH]'))
      .toBe('[SEARCH: 오늘 뉴스]')
  })

  test('JSON 블록형 query 값 앞뒤 공백은 trim한다 (감사 §4 #8 — trim 뮤턴트)', () => {
    expect(normalizeSearchMarkers('[SEARCH]{"query": "  오늘 뉴스  "}[/SEARCH]'))
      .toBe('[SEARCH: 오늘 뉴스]')
    expect(normalizeSearchMarkers('[SEARCH]{"query":"\t오늘 뉴스\n"}[/SEARCH]'))
      .toBe('[SEARCH: 오늘 뉴스]')
    // 평문 블록형도 앞뒤 공백을 제거한다
    expect(normalizeSearchMarkers('[SEARCH]  오늘 뉴스  [/SEARCH]')).toBe('[SEARCH: 오늘 뉴스]')
  })

  test('표준형 [SEARCH: ]는 그대로 둔다', () => {
    expect(normalizeSearchMarkers('[SEARCH: 오늘 뉴스]')).toBe('[SEARCH: 오늘 뉴스]')
  })

  test('여러 마커를 모두 변환한다', () => {
    expect(normalizeSearchMarkers('[SEARCH]뉴스[/SEARCH] 그리고 [SEARCH]날씨[/SEARCH]'))
      .toBe('[SEARCH: 뉴스] 그리고 [SEARCH: 날씨]')
  })

  test('다른 도구 마커는 건드리지 않는다', () => {
    const t = '[MEMO_SEARCH]{"query": "뉴스"}[/MEMO_SEARCH] [TODO_ADD]{"title": "x"}[/TODO_ADD]'
    expect(normalizeSearchMarkers(t)).toBe(t)
  })

  test('빈 쿼리는 변환하지 않는다', () => {
    expect(normalizeSearchMarkers('[SEARCH]  [/SEARCH]')).toBe('[SEARCH]  [/SEARCH]')
  })

  test('쿼리에 대괄호가 있으면 변환하지 않는다 (깨진 마커 방지)', () => {
    const t = '[SEARCH]뉴스 [속보][/SEARCH]'
    expect(normalizeSearchMarkers(t)).toBe(t)
  })

  test('닫는 태그가 없는 불완전 마커는 변환하지 않는다', () => {
    expect(normalizeSearchMarkers('[SEARCH]오늘 뉴스')).toBe('[SEARCH]오늘 뉴스')
  })

  test('JSON처럼 보이지만 깨진 평문 블록은 변환하지 않는다 (Stryker 기준선: startsWith 뮤턴트 대응)', () => {
    // `}`가 없어 JSON 단계가 실패하고, 평문 단계는 startsWith('{')로 원형 유지해야 한다.
    // endsWith('{')로 바뀌면 `[SEARCH: {"query": "오늘 뉴스"]`로 잘못 변환된다.
    expect(normalizeSearchMarkers('[SEARCH]{"query": "오늘 뉴스"[/SEARCH]'))
      .toBe('[SEARCH]{"query": "오늘 뉴스"[/SEARCH]')
  })

  test('일반 텍스트는 그대로 둔다', () => {
    expect(normalizeSearchMarkers('오늘 뉴스 정리해줘')).toBe('오늘 뉴스 정리해줘')
    expect(normalizeSearchMarkers('')).toBe('')
  })
})

describe('extractSearchQuery', () => {
  test('표준형에서 쿼리 추출', () => {
    expect(extractSearchQuery('[SEARCH: 오늘 뉴스]')).toBe('오늘 뉴스')
  })

  test('블록형도 정규화 후 추출', () => {
    expect(extractSearchQuery('[SEARCH]오늘 뉴스[/SEARCH]')).toBe('오늘 뉴스')
  })

  test('마커 없으면 null', () => {
    expect(extractSearchQuery('안녕')).toBeNull()
  })

  test('콜론 뒤 공백이 없어도 추출하고 앞뒤 공백을 제거한다 (Stryker 기준선: \\s*·trim 뮤턴트 대응)', () => {
    expect(extractSearchQuery('[SEARCH:오늘 뉴스]')).toBe('오늘 뉴스')
    expect(extractSearchQuery('[SEARCH: 오늘 뉴스 ]')).toBe('오늘 뉴스')
    expect(extractSearchQuery('[SEARCH:   ]')).toBeNull()
  })
})
