/// <reference types="jest" />
/**
 * 뉴스 출처 결정적 검증 (2026-10-26 FAIL 수정)
 * - validateItemSources: Exa 결과에 없는 URL 제거, 중복 URL을 미사용 URL로 교체,
 *   빠진 항목은 순서대로 보강 (모델이 임의 URL을 만들어내지 못하게 후처리에서 강제)
 * - normalizeSourceUrl / dedupeSources / filterFreshSources (30일 신선도)
 * Exa 실호출 없음 — 전부 fixture/mock.
 */
import {
  validateItemSources,
  normalizeSourceUrl,
  dedupeSources,
  filterFreshSources,
  type SearchSource,
} from '../../src/lib/news-summary'

const SOURCES: SearchSource[] = [
  { title: '태풍 참피 제주 강풍', url: 'https://www.edaily.co.kr/news/1', publishedDate: '2026-10-26T00:00:00Z' },
  { title: '흑해 상선 공격', url: 'https://www.hankookilbo.com/news/2', publishedDate: '2026-10-25T12:00:00Z' },
  { title: '원주 DB 3연승', url: 'https://sports.news.com/3', publishedDate: '2026-10-24T09:00:00Z' },
]

const NOW = new Date('2026-10-26T12:00:00Z')

describe('normalizeSourceUrl', () => {
  it('말단 슬래시·fragment를 제거하고 호스트를 소문자로 한다', () => {
    expect(normalizeSourceUrl('https://Example.COM/news/1/')).toBe('https://example.com/news/1')
    expect(normalizeSourceUrl('https://www.yna.co.kr/sitemap/articles/2025/08/20-2.htm#top')).toBe(
      'https://www.yna.co.kr/sitemap/articles/2025/08/20-2.htm',
    )
  })
})

describe('dedupeSources', () => {
  it('정규화 기준 중복 URL을 제거한다 (첫 등장 유지)', () => {
    const srcs: SearchSource[] = [
      { title: 'a', url: 'https://example.com/1' },
      { title: 'a2', url: 'https://example.com/1/' },
      { title: 'b', url: 'https://example.com/2' },
    ]
    expect(dedupeSources(srcs).map((s) => s.title)).toEqual(['a', 'b'])
  })
})

describe('filterFreshSources', () => {
  it('30일 이상 오래된 출처를 제외한다 (날짜 없음은 유지)', () => {
    const srcs: SearchSource[] = [
      { title: '최신', url: 'https://example.com/fresh', publishedDate: '2026-10-26T00:00:00Z' },
      { title: '오래됨', url: 'https://www.yna.co.kr/sitemap/articles/2025/08/20-2.htm', publishedDate: '2025-08-22T00:00:00Z' },
      { title: '날짜없음', url: 'https://example.com/nodate' },
    ]
    const out = filterFreshSources(srcs, 30, NOW)
    expect(out.map((s) => s.title)).toEqual(['최신', '날짜없음'])
  })

  it('전부 오래됐으면 원본을 그대로 둔다 (결과를 통째로 비우지 않음)', () => {
    const srcs: SearchSource[] = [
      { title: '옛날1', url: 'https://example.com/old1', publishedDate: '2025-08-22T00:00:00Z' },
      { title: '옛날2', url: 'https://example.com/old2', publishedDate: '2025-01-01T00:00:00Z' },
    ]
    expect(filterFreshSources(srcs, 30, NOW)).toEqual(srcs)
  })

  it('정확히 30일 전은 유지, 31일 전은 제외한다', () => {
    const srcs: SearchSource[] = [
      { title: '30일', url: 'https://example.com/30', publishedDate: '2026-09-26T12:00:00Z' },
      { title: '31일', url: 'https://example.com/31', publishedDate: '2026-09-25T11:59:59Z' },
    ]
    expect(filterFreshSources(srcs, 30, NOW).map((s) => s.title)).toEqual(['30일'])
  })

  it('strict=true면 전부 오래됐을 때 빈 목록을 반환한다 (뉴스 질의 fail-open 제거, 2026-10-26 재실측)', () => {
    const srcs: SearchSource[] = [
      { title: '옛날1', url: 'https://example.com/old1', publishedDate: '2025-08-22T00:00:00Z' },
      { title: '옛날2', url: 'https://example.com/old2', publishedDate: '2025-01-01T00:00:00Z' },
    ]
    expect(filterFreshSources(srcs, 30, NOW, true)).toEqual([])
  })

  it('strict=true여도 신선한 출처가 있으면 그것만 남긴다 (날짜 없음은 버림 — 2026-10-26 조사)', () => {
    const srcs: SearchSource[] = [
      { title: '최신', url: 'https://example.com/fresh', publishedDate: '2026-10-26T00:00:00Z' },
      { title: '오래됨', url: 'https://example.com/old', publishedDate: '2025-01-19T00:00:00Z' },
      { title: '날짜없음', url: 'https://example.com/nodate' },
    ]
    expect(filterFreshSources(srcs, 30, NOW, true).map((s) => s.title)).toEqual(['최신'])
  })

  it('strict 기본값(false)은 기존 fail-open 동작을 유지한다', () => {
    const srcs: SearchSource[] = [
      { title: '옛날', url: 'https://example.com/old', publishedDate: '2025-01-19T00:00:00Z' },
    ]
    expect(filterFreshSources(srcs, 30, NOW)).toEqual(srcs)
    expect(filterFreshSources(srcs, 30, NOW, false)).toEqual(srcs)
  })
})

describe('validateItemSources', () => {
  it('Exa 결과에 없는 URL(지어낸 URL)은 해당 항목의 올바른 URL로 교체한다', () => {
    const text = [
      '1. 태풍 참피 — [출처](https://invented.example.com/fake)',
      '2. 흑해 상선 공격 — [출처](https://www.hankookilbo.com/news/2)',
      '3. 원주 DB 3연승 — [출처](https://sports.news.com/3)',
    ].join('\n')
    const out = validateItemSources(text, SOURCES)
    expect(out).not.toContain('invented.example.com')
    expect(out).toContain('1. 태풍 참피 — [출처](https://www.edaily.co.kr/news/1)')
    expect(out).toContain('2. 흑해 상선 공격 — [출처](https://www.hankookilbo.com/news/2)')
    expect(out).toContain('3. 원주 DB 3연승 — [출처](https://sports.news.com/3)')
  })

  it('동일 URL이 여러 항목에 있으면 첫 항목만 유지하고 나머지는 미사용 URL로 교체한다', () => {
    const text = [
      '1. 태풍 참피 — [출처](https://www.yna.co.kr/sitemap/articles/2025/08/20-2.htm)',
      '2. 흑해 상선 공격 — [출처](https://www.yna.co.kr/sitemap/articles/2025/08/20-2.htm)',
      '3. 원주 DB 3연승 — [출처](https://www.yna.co.kr/sitemap/articles/2025/08/20-2.htm)',
    ].join('\n')
    const out = validateItemSources(text, SOURCES)
    // 2025-08-22 sitemap URL은 Exa 목록에 없으므로 전부 교체된다
    expect(out).not.toContain('yna.co.kr')
    const urls = [...out.matchAll(/\[출처\]\(([^)]+)\)/g)].map((m) => m[1])
    expect(urls).toHaveLength(3)
    expect(new Set(urls).size).toBe(3)
    expect(urls).toEqual([
      'https://www.edaily.co.kr/news/1',
      'https://www.hankookilbo.com/news/2',
      'https://sports.news.com/3',
    ])
  })

  it('유효한 URL이 중복되면 두 번째 항목부터 미사용 URL로 교체한다', () => {
    const text = [
      '1. 태풍 참피 — [출처](https://www.edaily.co.kr/news/1)',
      '2. 흑해 상선 공격 — [출처](https://www.edaily.co.kr/news/1)',
      '3. 원주 DB 3연승 — [출처](https://sports.news.com/3)',
    ].join('\n')
    const out = validateItemSources(text, SOURCES)
    expect(out).toContain('1. 태풍 참피 — [출처](https://www.edaily.co.kr/news/1)')
    expect(out).toContain('2. 흑해 상선 공격 — [출처](https://www.hankookilbo.com/news/2)')
    expect(out.match(/edaily/g)?.length).toBe(1)
  })

  it('URL이 없는 항목에는 순서대로 출처를 붙인다', () => {
    const text = ['1. 태풍 참피', '2. 흑해 상선 공격', '3. 원주 DB 3연승'].join('\n')
    const out = validateItemSources(text, SOURCES)
    expect(out).toContain('1. 태풍 참피 — [출처](https://www.edaily.co.kr/news/1)')
    expect(out).toContain('2. 흑해 상선 공격 — [출처](https://www.hankookilbo.com/news/2)')
    expect(out).toContain('3. 원주 DB 3연승 — [출처](https://sports.news.com/3)')
  })

  it('bare URL 형태의 지어낸 URL도 교체한다', () => {
    const text = [
      '1. 태풍 참피 https://fake.example.com/news',
      '2. 흑해 상선 공격 — [출처](https://www.hankookilbo.com/news/2)',
      '3. 원주 DB 3연승 — [출처](https://sports.news.com/3)',
    ].join('\n')
    const out = validateItemSources(text, SOURCES)
    expect(out).not.toContain('fake.example.com')
    expect(out).toContain('1. 태풍 참피 — [출처](https://www.edaily.co.kr/news/1)')
  })

  it('오래된 출처는 검증 풀에서 제외되고 그 URL은 교체된다', () => {
    const srcs: SearchSource[] = [
      { title: '최신1', url: 'https://example.com/fresh1', publishedDate: '2026-10-26T00:00:00Z' },
      { title: '최신2', url: 'https://example.com/fresh2', publishedDate: '2026-10-26T00:00:00Z' },
      { title: '오래됨', url: 'https://www.yna.co.kr/sitemap/articles/2025/08/20-2.htm', publishedDate: '2025-08-22T00:00:00Z' },
    ]
    const text = [
      '1. 뉴스 하나 — [출처](https://www.yna.co.kr/sitemap/articles/2025/08/20-2.htm)',
      '2. 뉴스 둘 — [출처](https://example.com/fresh1)',
    ].join('\n')
    // 오래된 출처는 풀에서 빠지므로 2개 항목 ↔ 2개 신선한 출처로 검증된다.
    // 1번의 오래된 URL은 교체되고, 2번은 1번이 쓴 fresh1과 겹치므로 fresh2로 교체된다.
    const out = validateItemSources(text, srcs, { now: NOW })
    expect(out).not.toContain('yna.co.kr')
    expect(out).toContain('1. 뉴스 하나 — [출처](https://example.com/fresh1)')
    expect(out).toContain('2. 뉴스 둘 — [출처](https://example.com/fresh2)')
  })

  it('항목 수와 출처 수가 다르면 오인 연결을 막기 위해 원문을 그대로 둔다', () => {
    const text = '1. 태풍 참피\n2. 흑해 상선 공격\n3. 원주 DB 3연승\n4. 추가 뉴스'
    expect(validateItemSources(text, SOURCES)).toBe(text)
  })

  it('번호 목록이 없거나 출처가 없으면 원문을 그대로 둔다', () => {
    expect(validateItemSources('오늘 뉴스를 요약해 드릴게요.', SOURCES)).toBe('오늘 뉴스를 요약해 드릴게요.')
    expect(validateItemSources('1. 태풍 참피', [])).toBe('1. 태풍 참피')
    expect(validateItemSources('', SOURCES)).toBe('')
  })

  it('[MEMO_CREATE] 마커는 건드리지 않는다', () => {
    const text = [
      '1. 태풍 참피 — [출처](https://invented.example.com/fake)',
      '2. 흑해 상선 공격',
      '[MEMO_CREATE]{"title": "오늘 주요 뉴스", "text": "1. 태풍 참피\\n2. 흑해 상선 공격"}[/MEMO_CREATE]',
    ].join('\n')
    const out = validateItemSources(text, SOURCES.slice(0, 2))
    expect(out).toContain('1. 태풍 참피 — [출처](https://www.edaily.co.kr/news/1)')
    expect(out).toContain('[MEMO_CREATE]{"title": "오늘 주요 뉴스", "text": "1. 태풍 참피\\n2. 흑해 상선 공격"}[/MEMO_CREATE]')
    expect(out).not.toContain('invented.example.com')
  })
})
