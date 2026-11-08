/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 메모 제목 도출 검증 (2026-11-08 운영 시각 점검 결함 + 번들 계약).
 *
 * 번들 계약 (2026-11-08 사용자 결정으로 원본 복귀): lib/memo-title 공용 모듈은
 * 원본에 없다. 서버 extractMemoTitle은 태그 제거 → 이미지 마커 치환 →
 * 이스케이프 해제 → 첫 줄 60자 절단 → 마크다운 정리의 순서이며 엔티티
 * 디코딩·공백 정규화를 하지 않는다. 통합 검색은 본문 원문을 그대로
 * 잘라(제목 50자·요약 200자) 쓴다 — 태그 원문이 남는 것이 원본 동작이다.
 * 프론트 rowTitle(public/js/memo/list.js)은 번들 범위 밖이라 기존
 * 수정 동작(태그 제거 → 디코딩 → 정규화)을 그대로 검증한다.
 */
import * as fs from 'fs'
import * as path from 'path'
import { extractMemoTitle } from '../src/modules/memo/helpers'
import { unifiedSearch } from '../src/services/unified-search'

// 첫 줄 태그가 60자를 넘는 실제 결함 재현 입력 (태그만 71자)
const LONG_TAG_TEXT =
  '<span style="font-size:1.15em; font-weight:600; color:rgb(51, 51, 51)">주간 회의 정리</span>\n본문 내용입니다'

function loadRowTitle(): (text: string) => string {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'memo', 'list.js'), 'utf-8')
  const factory = new Function(src + '\nreturn { rowTitle };')
  return factory().rowTitle
}

describe('extractMemoTitle (title_hint 도출)', () => {
  test('긴 태그 입력에서 태그 원문이 남지 않는다', () => {
    expect(extractMemoTitle(LONG_TAG_TEXT)).toBe('주간 회의 정리')
  })

  test('엔티티 디코딩·공백 정규화를 하지 않는다 (번들 계약)', () => {
    expect(extractMemoTitle('A &amp;   B\n본문')).toBe('A &amp;   B')
    expect(extractMemoTitle('&lt;span&gt; 표기법\n본문')).toBe('&lt;span&gt; 표기법')
  })

  test('마크다운 정리·이미지 마커는 적용된다', () => {
    expect(extractMemoTitle('# 제목\n본문')).toBe('제목')
    expect(extractMemoTitle('**굵은 제목**\n본문')).toBe('굵은 제목')
    expect(extractMemoTitle('![사진](file:12)\n본문')).toBe('[이미지]')
  })

  test('"본문이 더 있을 때만" 계약 유지', () => {
    expect(extractMemoTitle('한 줄 메모')).toBe('')
    expect(extractMemoTitle('제목\n본문')).toBe('제목')
  })
})

describe('프론트 목록 rowTitle', () => {
  const rowTitle = loadRowTitle()

  test('긴 태그로 시작하는 메모 제목에 태그 원문이 노출되지 않는다', () => {
    const title = rowTitle(LONG_TAG_TEXT)
    expect(title).toBe('주간 회의 정리')
    expect(title).not.toContain('<span')
  })

  test('엔티티 디코딩과 공백 정규화', () => {
    expect(rowTitle('A &amp;   B\n본문')).toBe('A & B')
  })

  test('기존 계약 유지: 빈 메모·마크다운·이미지', () => {
    expect(rowTitle('')).toBe('(빈 메모)')
    expect(rowTitle('# 제목\n본문')).toBe('제목')
    expect(rowTitle('![사진](file:12)\n본문')).toBe('[이미지]')
  })
})

describe('통합 검색 메모 제목', () => {
  function makeDb(rows: any[]) {
    return {
      prepare(sql: string) {
        return {
          bind() { return this },
          async all() {
            if (sql.includes('memos_fts')) return { results: rows }
            return { results: [] }
          },
        }
      },
    }
  }

  test('HTML로 시작하는 메모의 검색 제목·요약은 원문 절단 그대로다 (번들 계약)', async () => {
    const db = makeDb([
      { id: 7, text: LONG_TAG_TEXT, created_at: '2026-11-07', is_locked: 0, sensitivity: 0 },
    ])
    const out = await unifiedSearch(db as any, { query: '회의', types: ['memo'] })
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe(LONG_TAG_TEXT.slice(0, 50))
    expect(out[0].snippet).toBe(LONG_TAG_TEXT.slice(0, 200))
  })
})
