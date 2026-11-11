/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 바탕화면 아이콘 격자 배치 검증 — 운영 desktop-icons.js의 실제 계약 기준.
 *
 * 검증 성질:
 * - 기본 배치는 행 우선(왼쪽 위부터 가로로 채움)이 정본이다
 *   (2026-11-03 사용자 계약: 격자 스냅·왼쪽 위·행 우선).
 * - 격자보다 항목이 많으면 첫 열에 균등 간격으로 압축 배치해
 *   화면 밖으로 넘치지 않는다.
 * - 저장된 배치(v8 positions)는 그대로 존중하되 영역 안으로 clamp되고,
 *   구 형식(cells)·구 버전의 겹친 배치는 nearestFreeCell로 풀어
 *   중복 셀이 생기지 않는다.
 * - snapXY/xyToCell/cellToXY는 서로 일관된 격자 스냅을 제공한다.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const icons = require('../public/js/desktop/desktop-icons.js')

const IDS = ['finder', 'browser', 'memo', 'schedule', 'todo', 'chat', 'studio', 'excel', 'hangul', 'powerpoint', 'pdf']
const ITEMS = IDS.map((id) => ({ id }))
const AREA = { w: 1920, h: 866 } // 1920×1000 - 상단바/독 존 근사

class MemoryStorage {
  store: Record<string, string> = {}
  getItem(k: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null
  }
  setItem(k: string, v: string): void {
    this.store[k] = String(v)
  }
}

describe('gridDims / clampCell', () => {
  test('gridDims는 셀 크기로 나눈 몫(최소 1)이다', () => {
    expect(icons.gridDims(1920, 866)).toEqual({ cols: 20, rows: 8 })
    expect(icons.gridDims(100, 100)).toEqual({ cols: 1, rows: 1 })
    expect(icons.gridDims(0, 0)).toEqual({ cols: 1, rows: 1 })
  })

  test('clampCell은 격자 범위 안으로 자른다', () => {
    const dims = { cols: 3, rows: 2 }
    expect(icons.clampCell({ col: -1, row: 9 }, dims)).toEqual({ col: 0, row: 1 })
    expect(icons.clampCell({ col: 2, row: 1 }, dims)).toEqual({ col: 2, row: 1 })
  })
})

describe('기본 배치 — 행 우선 (loadLayout, 저장 없음)', () => {
  test('기본 앱 11개가 첫 행에 왼쪽부터 순서대로 놓인다', () => {
    const pos = icons.loadLayout(new MemoryStorage(), ITEMS, AREA)
    // cellToXY: x = col*96 + (96-60)/2 = col*96 + 18, y = row*108 + 10
    expect(pos.finder).toEqual({ x: 18, y: 10 })
    expect(pos.browser).toEqual({ x: 114, y: 10 })
    expect(pos.pdf).toEqual({ x: 10 * 96 + 18, y: 10 })
  })

  test('모든 아이콘이 영역 안에 있고 겹치지 않는다', () => {
    const pos = icons.loadLayout(new MemoryStorage(), ITEMS, AREA)
    const keys = Object.values(pos).map((p: any) => p.x + ',' + p.y)
    expect(new Set(keys).size).toBe(IDS.length)
    for (const id of IDS) {
      expect(pos[id].x).toBeGreaterThanOrEqual(0)
      expect(pos[id].y).toBeGreaterThanOrEqual(0)
      expect(pos[id].y + icons.CELL_H).toBeLessThanOrEqual(AREA.h + icons.CELL_H)
    }
  })

  test('격자 용량을 넘는 항목은 첫 열에 균등 압축돼 영역을 벗어나지 않는다', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: 'm' + i }))
    const small = { w: 200, h: 240 } // cols=2, rows=2 → 용량 4 < 30
    const pos = icons.loadLayout(new MemoryStorage(), many, small)
    const ys = many.map((m) => pos[m.id].y)
    expect(Math.max(...ys)).toBeLessThanOrEqual(small.h - (icons.TILE + 26))
    expect(new Set(ys).size).toBe(many.length) // 전부 다른 y (균등 분할)
    for (const m of many) expect(pos[m.id].x).toBe(18)
  })
})

describe('저장 배치 존중과 이주', () => {
  test('v8 positions는 그대로 쓰이고 영역 밖 값은 clamp된다', () => {
    const storage = new MemoryStorage()
    storage.setItem(icons.PREF_KEY, JSON.stringify({
      version: 8,
      present: ['finder', 'memo'],
      positions: { finder: { x: 500, y: 300 }, memo: { x: 99999, y: -5 } },
    }))
    const pos = icons.loadLayout(storage, ITEMS, AREA)
    expect(pos.finder).toEqual({ x: 500, y: 300 })
    expect(pos.memo.x).toBeLessThanOrEqual(AREA.w - icons.TILE)
    expect(pos.memo.y).toBe(0)
  })

  test('구 cells 형식은 좌표로 변환된다', () => {
    const storage = new MemoryStorage()
    storage.setItem(icons.PREF_KEY, JSON.stringify({
      version: 7,
      cells: { finder: { col: 2, row: 3 } },
    }))
    const pos = icons.loadLayout(storage, [{ id: 'finder' }], AREA)
    expect(pos.finder).toEqual({ x: 2 * 96 + 18, y: 3 * 108 + 10 })
  })

  test('구 버전의 겹친 배치는 빈 셀로 풀려 중복이 없어진다', () => {
    const storage = new MemoryStorage()
    storage.setItem(icons.PREF_KEY, JSON.stringify({
      version: 7,
      positions: { finder: { x: 18, y: 10 }, memo: { x: 18, y: 10 }, todo: { x: 18, y: 10 } },
    }))
    const pos = icons.loadLayout(storage, [{ id: 'finder' }, { id: 'memo' }, { id: 'todo' }], AREA)
    const keys = ['finder', 'memo', 'todo'].map((id) => pos[id].x + ',' + pos[id].y)
    expect(new Set(keys).size).toBe(3)
  })

  test('saveLayout → loadLayout 왕복이 배치를 보존한다', () => {
    const storage = new MemoryStorage()
    const before = icons.loadLayout(new MemoryStorage(), ITEMS, AREA)
    icons.saveLayout(storage, before)
    const after = icons.loadLayout(storage, ITEMS, AREA)
    expect(after).toEqual(before)
    const saved = JSON.parse(storage.getItem(icons.PREF_KEY) as string)
    expect(saved.version).toBe(8)
  })
})

describe('nearestFreeCell / 스냅', () => {
  test('원하는 셀이 비어 있으면 그대로, 차 있으면 인접 빈 셀을 찾는다', () => {
    const dims = { cols: 4, rows: 4 }
    const occupied = new Set(['0,0', '1,0', '0,1'])
    expect(icons.nearestFreeCell({ col: 2, row: 2 }, occupied, dims)).toEqual({ col: 2, row: 2 })
    const found = icons.nearestFreeCell({ col: 0, row: 0 }, occupied, dims)
    expect(found).not.toBeNull()
    expect(occupied.has(found.col + ',' + found.row)).toBe(false)
  })

  test('격자가 가득 차면 null이다', () => {
    const dims = { cols: 1, rows: 1 }
    expect(icons.nearestFreeCell({ col: 0, row: 0 }, new Set(['0,0']), dims)).toBeNull()
  })

  test('cellToXY와 xyToCell은 왕복이 일관되고 snapXY는 격자에 붙는다', () => {
    const dims = icons.gridDims(AREA.w, AREA.h)
    const xy = icons.cellToXY({ col: 3, row: 2 }, AREA.w)
    expect(icons.xyToCell(xy.x, xy.y, AREA.w, dims)).toEqual({ col: 3, row: 2 })
    const snapped = icons.snapXY({ x: xy.x + 20, y: xy.y + 30 }, AREA.w, AREA.h)
    expect(snapped).toEqual(xy)
  })
})

// 모듈 스코프 고정: 다른 테스트 파일의 동명 전역(AREA 등)과 한 프로그램으로
// 컴파일될 때 TS2451 재선언 오류가 나는 것을 막는다 (2026-11-10 표면 게이트에서 발견).
export {}
