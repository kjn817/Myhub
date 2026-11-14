/// <reference types="jest" />
/**
 * F-L11 menu-items 공용 코어 단위 테스트 (5-5)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - null·비객체·label 없는 노드는 건너뛰고, separator는 {separator:true}로 낸다.
 * - shortcut은 비어 있지 않은 문자열일 때만, checked는 boolean일 때만 복사한다.
 * - children은 재귀하고, path가 있으면 onSelect 클로저를 단다 (path 복사본).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { mapMenuItems } = require('../../public/js/common/menu-items.js')

describe('menu-items mapMenuItems', () => {
  test('기본 매핑: label·disabled·shortcut·checked', () => {
    const out = mapMenuItems(
      [
        { label: '저장', shortcut: 'Ctrl+S', checked: true },
        { label: '닫기', disabled: true, shortcut: '', checked: 'yes' as any },
      ],
      () => {},
    )
    expect(out).toEqual([
      { label: '저장', disabled: false, shortcut: 'Ctrl+S', checked: true },
      { label: '닫기', disabled: true },
    ])
  })

  test('separator와 무효 노드를 처리한다', () => {
    const out = mapMenuItems(
      [null, { separator: true }, { label: '' }, 'x' as any, { label: 'ok' }],
      () => {},
    )
    expect(out).toEqual([{ separator: true }, { label: 'ok', disabled: false }])
  })

  test('children은 재귀하고 path는 onSelect 클로저가 된다', () => {
    const seen: any[] = []
    const nodes = [
      {
        label: '파일',
        children: [{ label: '새로 만들기', path: ['file', 'new'] }],
      },
      { label: '인쇄', path: ['file', 'print'] },
    ]
    const out = mapMenuItems(nodes, (p: any) => seen.push(p))
    expect(out[0].children).toHaveLength(1)
    expect(typeof out[0].children[0].onSelect).toBe('function')
    expect(typeof out[1].onSelect).toBe('function')
    out[0].children[0].onSelect()
    out[1].onSelect()
    expect(seen).toEqual([
      ['file', 'new'],
      ['file', 'print'],
    ])
    // path는 복사본이라 원본을 바꿔도 콜백 인자가 안 바뀐다
    nodes[1].path.push('mutated')
    out[1].onSelect()
    expect(seen[2]).toEqual(['file', 'print'])
  })

  test('배열이 아니면 빈 배열을 낸다', () => {
    expect(mapMenuItems(null, () => {})).toEqual([])
    expect(mapMenuItems(undefined, () => {})).toEqual([])
  })
})
