/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 바탕화면 아이콘 열 우선 흐름 배치 검증 (2026-11-08 운영 실측 결함).
 *
 * 검증 성질: 기본 앱 11개가 한 열에 순서대로 쌓이면 1920×1000에서
 * 9개만 닿고 PowerPoint·PDF가 화면 아래로 넘어갔다. maxRows(닿는 행
 * 수)를 주면 셀이 없는 항목은 열이 차는 지점에서 다음 열로 흘러야
 * 하고, maxRows가 없으면 구 계약(첫 열 순서 배치)이 유지돼야 한다.
 * 구 코드(migrateItems가 opts를 무시)는 이 테스트를 실패한다 — 카나리아.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const icons = require('../public/js/desktop/desktop-icons.js')

const MAX_ROWS = 8 // 1920×1000 실측: 레이어 966 - 독 존 100 → 8행

function cellOf(items: any[], id: string) {
  const it = items.find((x) => x.id === id)
  return it ? it.cell : null
}

describe('migrateItems — maxRows 열 우선 흐름', () => {
  test('기본 앱 11개가 8행에서 다음 열로 흐른다', () => {
    const items = icons.migrateItems(null, { maxRows: MAX_ROWS })
    expect(items).toHaveLength(11)
    // 첫 열: finder..excel (인덱스 0..7)
    expect(cellOf(items, 'finder')).toEqual({ c: 0, r: 0 })
    expect(cellOf(items, 'excel')).toEqual({ c: 0, r: 7 })
    // 둘째 열: hangul·powerpoint·pdf
    expect(cellOf(items, 'hangul')).toEqual({ c: 1, r: 0 })
    expect(cellOf(items, 'powerpoint')).toEqual({ c: 1, r: 1 })
    expect(cellOf(items, 'pdf')).toEqual({ c: 1, r: 2 })
  })

  test('모든 기본 아이콘이 닿는 행 안에 있다 (r < maxRows)', () => {
    const items = icons.migrateItems(null, { maxRows: MAX_ROWS })
    for (const it of items) {
      expect(it.cell.r).toBeLessThan(MAX_ROWS)
    }
    // 셀 중복이 없어야 한다
    const keys = items.map((it: any) => it.cell.c + ',' + it.cell.r)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('maxRows가 없으면 구 계약(첫 열 순서 배치)이 유지된다', () => {
    const items = icons.migrateItems(null)
    expect(cellOf(items, 'pdf')).toEqual({ c: 0, r: 10 })
  })

  test('명시 셀은 maxRows가 있어도 그대로 존중된다', () => {
    const raw = {
      version: 8,
      items: [
        { kind: 'app', id: 'finder', cell: { c: 2, r: 3 } },
        { kind: 'app', id: 'memo', cell: { c: 0, r: 0 } },
      ],
    }
    const items = icons.migrateItems(raw, { maxRows: MAX_ROWS })
    expect(cellOf(items, 'finder')).toEqual({ c: 2, r: 3 })
    expect(cellOf(items, 'memo')).toEqual({ c: 0, r: 0 })
  })
})

describe('indexCell / firstFlowFreeCell', () => {
  test('indexCell은 열 우선 흐름 좌표를 만든다', () => {
    expect(icons.indexCell(0, MAX_ROWS)).toEqual({ c: 0, r: 0 })
    expect(icons.indexCell(7, MAX_ROWS)).toEqual({ c: 0, r: 7 })
    expect(icons.indexCell(8, MAX_ROWS)).toEqual({ c: 1, r: 0 })
    expect(icons.indexCell(10, MAX_ROWS)).toEqual({ c: 1, r: 2 })
    expect(icons.indexCell(10, 0)).toEqual({ c: 0, r: 10 })
  })

  test('firstFlowFreeCell은 열 우선으로 첫 빈 셀을 찾고 범위 밖으로 나가지 않는다', () => {
    const occupied: Record<string, boolean> = { '0,0': true, '0,1': true, '1,0': true }
    expect(icons.firstFlowFreeCell(occupied, MAX_ROWS)).toEqual({ c: 0, r: 2 })
    const colFull: Record<string, boolean> = {}
    for (let r = 0; r < MAX_ROWS; r++) colFull['0,' + r] = true
    expect(icons.firstFlowFreeCell(colFull, MAX_ROWS)).toEqual({ c: 1, r: 0 })
  })
})
