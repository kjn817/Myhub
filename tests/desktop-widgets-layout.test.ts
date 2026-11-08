/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 데스크톱 위젯 기본 배치·겹침 해소 검증 (2026-11-08 운영 시각 점검 결함).
 *
 * 검증 성질:
 * 1. 저장 상태가 없을 때 세 위젯의 기본 사각형은 서로 겹치지 않고,
 *    아이콘 격자 첫 셀(Finder, 14/12·96×108)과도 겹치지 않는다.
 *    (구 기본값은 세 위젯 모두 (16,16)이라 서로 쌓이고 Finder를 덮었다 —
 *    이 성질이 깨지면 이 테스트가 실패해야 한다.)
 * 2. 구 기본값처럼 같은 좌표가 저장돼 있어도 렌더 확정 단계에서 겹침이
 *    해소되고, 겹치지 않는 저장값은 그대로 존중된다 (사용자 상태 보존).
 * 3. 렌더된 카드는 저장된 크기가 있을 때만 높이가 고정되고, 기본 상태에서는
 *    높이를 고정하지 않는다 (고정 160px가 내용보다 커 카드 하단에 빈 공간이
 *    생기던 문제).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const widgets = require('../public/js/desktop/widgets.js')

const ORDER = ['today', 'storage', 'system']
const VIEWPORT = { w: 1920, h: 1000 }
// desktop-icons.js 격자 계약: ORIGIN 14/12, CELL 96×108 — 첫 셀은 Finder.
const FINDER_CELL = { x: 14, y: 12, w: 96, h: 108 }

function overlaps(a: any, b: any): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function expectNoPairwiseOverlap(rects: Record<string, any>) {
  for (let i = 0; i < ORDER.length; i++) {
    for (let j = i + 1; j < ORDER.length; j++) {
      expect(overlaps(rects[ORDER[i]], rects[ORDER[j]])).toBe(false)
    }
  }
}

describe('위젯 기본 배치 — 아이콘 열과 겹치지 않는 우측 스택', () => {
  test('기본 사각형은 서로 겹치지 않는다', () => {
    const rects = widgets.resolveWidgetRects(ORDER, { pos: {}, sizes: {} }, VIEWPORT)
    expectNoPairwiseOverlap(rects)
  })

  test('기본 사각형은 Finder 셀을 덮지 않는다', () => {
    const rects = widgets.resolveWidgetRects(ORDER, { pos: {}, sizes: {} }, VIEWPORT)
    for (const id of ORDER) {
      expect(overlaps(rects[id], FINDER_CELL)).toBe(false)
    }
  })

  test('기본 위치는 순서대로 아래로 쌓인다 (today < storage < system)', () => {
    const p0 = widgets.defaultWidgetPos(0, VIEWPORT)
    const p1 = widgets.defaultWidgetPos(1, VIEWPORT)
    const p2 = widgets.defaultWidgetPos(2, VIEWPORT)
    expect(p0.y).toBeLessThan(p1.y)
    expect(p1.y).toBeLessThan(p2.y)
    expect(p0.x).toBe(p1.x)
    expect(p1.x).toBe(p2.x)
    // 우측 정렬: 위젯 오른쪽 끝이 화면 안에 들어간다
    expect(p0.x + widgets.DEFAULT_W).toBeLessThanOrEqual(VIEWPORT.w)
    expect(p0.x).toBeGreaterThan(FINDER_CELL.x + FINDER_CELL.w)
  })
})

describe('위젯 겹침 해소 — 저장 상태 보존과 방어', () => {
  test('같은 좌표가 저장돼 있어도 렌더 사각형은 겹치지 않는다', () => {
    const layout = {
      pos: { today: { x: 16, y: 16 }, storage: { x: 16, y: 16 }, system: { x: 16, y: 16 } },
      sizes: {},
    }
    const rects = widgets.resolveWidgetRects(ORDER, layout, VIEWPORT)
    expectNoPairwiseOverlap(rects)
    // 첫 위젯의 저장 좌표는 그대로 존중된다 (임의 초기화 금지)
    expect(rects.today).toMatchObject({ x: 16, y: 16 })
  })

  test('겹치지 않는 저장 위치·크기는 그대로 쓰인다', () => {
    const layout = {
      pos: { today: { x: 500, y: 40 }, storage: { x: 900, y: 40 }, system: { x: 500, y: 400 } },
      sizes: { today: { w: 260, h: 120 } },
    }
    const rects = widgets.resolveWidgetRects(ORDER, layout, VIEWPORT)
    expect(rects.today).toEqual({ x: 500, y: 40, w: 260, h: 120 })
    expect(rects.storage).toMatchObject({ x: 900, y: 40 })
    expect(rects.system).toMatchObject({ x: 500, y: 400 })
  })
})

describe('위젯 렌더 — 카드 배치와 높이', () => {
  function makeStorage(initial: Record<string, string>) {
    const map = new Map(Object.entries(initial))
    return {
      getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
      setItem: (k: string, v: string) => { map.set(k, v) },
    }
  }

  function renderWith(storage: any) {
    const doc = (globalThis as any).document
    const layer = doc.createElement('div')
    doc.body.appendChild(layer)
    const api = widgets.createWidgets({
      layer,
      storage,
      fetchFn: () => Promise.resolve({ ok: false, json: () => Promise.resolve(null) }),
    })
    api.render()
    return layer
  }

  test('빈 저장 상태: 세 카드가 서로 다른 위치에 렌더되고 높이는 고정되지 않는다', () => {
    const layer = renderWith(makeStorage({}))
    const cards = Array.from(layer.querySelectorAll('.dt-widget')) as any[]
    expect(cards.map((c) => c.dataset.widget)).toEqual(ORDER)
    const positions = cards.map((c) => c.style.left + '/' + c.style.top)
    expect(new Set(positions).size).toBe(3)
    for (const c of cards) {
      expect(c.style.width).toBe(widgets.DEFAULT_W + 'px')
      expect(c.style.height).toBe('')
    }
  })

  test('저장된 크기가 있으면 그 높이가 적용된다', () => {
    const layout = JSON.stringify({ pos: {}, sizes: { system: { w: 340, h: 210 } } })
    const layer = renderWith(makeStorage({ [widgets.LAYOUT_KEY]: layout }))
    const system = layer.querySelector('.dt-widget-system') as any
    expect(system.style.width).toBe('340px')
    expect(system.style.height).toBe('210px')
    const today = layer.querySelector('.dt-widget-today') as any
    expect(today.style.height).toBe('')
  })

  test('같은 좌표가 저장돼 있어도 렌더된 카드 위치는 서로 달라진다', () => {
    const layout = JSON.stringify({
      pos: { today: { x: 16, y: 16 }, storage: { x: 16, y: 16 }, system: { x: 16, y: 16 } },
      sizes: {},
    })
    const layer = renderWith(makeStorage({ [widgets.LAYOUT_KEY]: layout }))
    const cards = Array.from(layer.querySelectorAll('.dt-widget')) as any[]
    const positions = cards.map((c) => c.style.left + '/' + c.style.top)
    expect(new Set(positions).size).toBe(3)
    expect(cards[0].style.left).toBe('16px')
    expect(cards[0].style.top).toBe('16px')
  })
})
