/// <reference types="jest" />
/**
 * pptx-builder.ts 커버리지 보강
 * (기존 tests/pptx-export.test.ts는 빈 덱·계열 길이 불일치·기본 emptyText만
 * 다루고, 빈 카테고리 throw와 subtitle/meta/커스텀 emptyText 선택 요소는 미검증)
 * - ZIP은 store(무압축)라 전체 바이트를 디코딩하면 슬라이드 XML 텍스트를
 *   직접 확인할 수 있다 (파서 없이 존재 여부 판정).
 */
import { buildPptx, type PptxDeck } from '../../src/services/pptx-builder'

function zipText(deck: PptxDeck): string {
  return new TextDecoder().decode(buildPptx(deck))
}

describe('pptx-builder — 차트 입력 검증', () => {
  test('빈 카테고리는 차트 파트 생성 전에 거부한다', () => {
    expect(() =>
      buildPptx({
        title: 'x',
        slides: [{ kind: 'chart', title: 'c', categories: [], series: [{ name: 's', values: [] }] }],
      }),
    ).toThrow('차트 카테고리가 비어 있습니다')
  })

  test('계열이 없어도 카테고리가 비어 있으면 카테고리 오류가 먼저 난다', () => {
    expect(() =>
      buildPptx({
        title: 'x',
        slides: [{ kind: 'chart', title: 'c', categories: [], series: [] }],
      }),
    ).toThrow('차트 카테고리가 비어 있습니다')
  })
})

describe('pptx-builder — 표지 선택 요소 (subtitle/meta)', () => {
  test('subtitle·meta가 있으면 표지 XML에 들어가고, 없으면 들어가지 않는다', () => {
    const withBoth = zipText({
      title: '덱',
      slides: [{ kind: 'title', title: '표지제목고유', subtitle: '부제목고유문구', meta: '메타고유문구' }],
    })
    expect(withBoth).toContain('표지제목고유')
    expect(withBoth).toContain('부제목고유문구')
    expect(withBoth).toContain('메타고유문구')

    const bare = zipText({
      title: '덱',
      slides: [{ kind: 'title', title: '표지제목고유' }],
    })
    expect(bare).toContain('표지제목고유')
    expect(bare).not.toContain('부제목고유문구')
    expect(bare).not.toContain('메타고유문구')
  })

  test('subtitle만 있으면 meta 도형은 생기지 않는다', () => {
    const text = zipText({
      title: '덱',
      slides: [{ kind: 'title', title: '표지제목고유', subtitle: '부제목고유문구' }],
    })
    expect(text).toContain('부제목고유문구')
    expect(text).not.toContain('메타고유문구')
  })
})

describe('pptx-builder — 목록 슬라이드 emptyText', () => {
  test('항목이 없고 emptyText를 주면 그 문구가 표시된다', () => {
    const text = zipText({
      title: '덱',
      slides: [{ kind: 'bullets', title: '목록제목고유', bullets: [], emptyText: '커스텀없음문구' }],
    })
    expect(text).toContain('커스텀없음문구')
    expect(text).not.toContain('항목이 없습니다')
  })

  test('항목이 없고 emptyText를 안 주면 기본 문구가 표시된다', () => {
    const text = zipText({
      title: '덱',
      slides: [{ kind: 'bullets', title: '목록제목고유', bullets: [] }],
    })
    expect(text).toContain('항목이 없습니다')
  })

  test('항목이 있으면 emptyText는 표시되지 않는다', () => {
    const text = zipText({
      title: '덱',
      slides: [{ kind: 'bullets', title: '목록제목고유', bullets: ['첫번째항목고유'], emptyText: '커스텀없음문구' }],
    })
    expect(text).toContain('첫번째항목고유')
    expect(text).not.toContain('커스텀없음문구')
  })
})
