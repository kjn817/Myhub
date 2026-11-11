/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 데스크톱 위젯 기본 배치·저장 상태 존중 검증 — 운영 원본 widgets.js 기준.
 *
 * 검증 성질 (운영 원본의 실제 계약):
 * 1. 저장 상태가 없으면 세 위젯은 우측 열(레이어 폭 − 132 − 304)에,
 *    첫 아이콘 행 아래(상단 10 + 셀 높이 108 = 118)부터 순서대로
 *    (오늘 → 저장소 → 시스템) 카드 높이 + 간격 12로 쌓이고 서로
 *    겹치지 않으며, 좌상단 Finder 셀을 덮지 않는다. 최초 배치는
 *    v3 포맷 { version: 3, positions, sizes }으로 저장된다.
 * 2. 저장된 위치는 그대로 존중된다 (레이어 안으로의 clamp만).
 *    운영 원본은 겹침을 허용하는 설계다 — 재구축본에 있던
 *    "겹침 해소" 로직은 운영에 없으므로 같은 좌표가 저장돼 있으면
 *    그대로 겹쳐 렌더되는 것이 운영 거동이다.
 * 3. 저장된 크기가 있는 위젯만 style 너비·높이가 고정되고
 *    (읽을 때 너비 220~1200·높이 96~1200으로 clamp), 없으면
 *    style이 비어 CSS 기본값을 따른다.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const widgets = require('../public/js/desktop/widgets.js')

const ORDER = ['today', 'storage', 'system']
const AREA = { w: 1920, h: 1000 }
const POS_KEY = 'myhub.desktop.widgets.v1'
// desktop-icons.js 격자 계약: 첫 셀은 Finder (x 14, y 12, 96×108).
const FINDER_CELL = { x: 14, y: 12, w: 96, h: 108 }
// 운영 상수: 카드 폭 304, 우측 여백 132, 스택 간격 12, 기본 시작 y 118.
const CARD_W = 304
const DEFAULT_X = AREA.w - 132 - CARD_W
const DEFAULT_TOP = 118
const CARD_H = 148 // jsdom 실측 대체값 (getBoundingClientRect 스텁)

function overlaps(a: any, b: any): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function makeStorage(initial: Record<string, string>) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => { map.set(k, v) },
    _map: map,
  }
}

let rectStub: jest.SpyInstance | null = null
beforeEach(() => {
  // jsdom은 레이아웃이 없어 높이가 0이다 — 스택 계산이 읽는 카드
  // 실측 높이만 고정값으로 대체한다 (배치 수학 자체는 운영 코드가 수행).
  rectStub = jest
    .spyOn((globalThis as any).HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: any) {
      const isWidget = this.classList && this.classList.contains('dt-widget')
      return {
        x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0,
        width: isWidget ? CARD_W : 0,
        height: isWidget ? CARD_H : 0,
        toJSON: () => ({}),
      }
    })
})
afterEach(() => {
  rectStub?.mockRestore()
  ;(globalThis as any).document.body.innerHTML = ''
})

function renderWith(storage: any) {
  const doc = (globalThis as any).document
  const layer = doc.createElement('div')
  doc.body.appendChild(layer)
  const api = widgets.createManager({
    container: layer,
    storage,
    getArea: () => AREA,
    fetchFn: () => Promise.resolve({ ok: false, status: 0, json: () => Promise.resolve(null) }),
  })
  const cards: Record<string, any> = {}
  for (const c of Array.from(layer.querySelectorAll('.dt-widget')) as any[]) {
    cards[c.dataset.widgetId] = c
  }
  return { layer, api, cards }
}

function rectOf(card: any) {
  return {
    x: parseInt(card.style.left, 10),
    y: parseInt(card.style.top, 10),
    w: CARD_W,
    h: CARD_H,
  }
}

describe('위젯 기본 배치 — 아이콘 열과 겹치지 않는 우측 스택', () => {
  test('기본 사각형은 서로 겹치지 않는다', () => {
    const { cards } = renderWith(makeStorage({}))
    const rects = ORDER.map((id) => rectOf(cards[id]))
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlaps(rects[i], rects[j])).toBe(false)
      }
    }
  })

  test('기본 사각형은 Finder 셀을 덮지 않는다', () => {
    const { cards } = renderWith(makeStorage({}))
    for (const id of ORDER) {
      expect(overlaps(rectOf(cards[id]), FINDER_CELL)).toBe(false)
    }
  })

  test('기본 위치는 우측 열에 순서대로 아래로 쌓인다 (today < storage < system)', () => {
    const { cards, api } = renderWith(makeStorage({}))
    const pos = api.getPositions()
    expect(pos.today).toEqual({ x: DEFAULT_X, y: DEFAULT_TOP })
    expect(pos.storage).toEqual({ x: DEFAULT_X, y: DEFAULT_TOP + CARD_H + 12 })
    expect(pos.system).toEqual({ x: DEFAULT_X, y: DEFAULT_TOP + (CARD_H + 12) * 2 })
    // 우측 정렬: 위젯 오른쪽 끝이 화면 안에 들어간다
    expect(pos.today.x + CARD_W).toBeLessThanOrEqual(AREA.w)
    expect(pos.today.x).toBeGreaterThan(FINDER_CELL.x + FINDER_CELL.w)
    // 렌더된 카드 style도 같은 좌표다
    expect(cards.today.style.left).toBe(DEFAULT_X + 'px')
    expect(cards.system.style.top).toBe(pos.system.y + 'px')
  })

  test('최초 배치는 v3 포맷으로 저장된다', () => {
    const storage = makeStorage({})
    renderWith(storage)
    const saved = JSON.parse(storage._map.get(POS_KEY) as string)
    expect(saved.version).toBe(3)
    expect(Object.keys(saved.positions).sort()).toEqual([...ORDER].sort())
    expect(saved.sizes).toEqual({})
  })
})

describe('위젯 저장 상태 — 존중과 clamp', () => {
  test('저장된 위치는 그대로 쓰인다 (겹침은 운영 설계상 허용)', () => {
    const layout = JSON.stringify({
      version: 3,
      positions: { today: { x: 16, y: 16 }, storage: { x: 16, y: 16 }, system: { x: 16, y: 16 } },
      sizes: {},
    })
    const { api, cards } = renderWith(makeStorage({ [POS_KEY]: layout }))
    // 재구축본의 겹침 해소와 달리, 운영 원본은 저장 좌표를 손대지 않는다.
    expect(api.getPositions().today).toEqual({ x: 16, y: 16 })
    expect(cards.today.style.left).toBe('16px')
    expect(cards.today.style.top).toBe('16px')
  })

  test('겹치지 않는 저장 위치·크기는 그대로 쓰인다', () => {
    const layout = JSON.stringify({
      version: 3,
      positions: { today: { x: 500, y: 40 }, storage: { x: 900, y: 40 }, system: { x: 500, y: 400 } },
      sizes: { today: { w: 260, h: 120 } },
    })
    const { api, cards } = renderWith(makeStorage({ [POS_KEY]: layout }))
    expect(api.getPositions().today).toEqual({ x: 500, y: 40 })
    expect(api.getPositions().storage).toEqual({ x: 900, y: 40 })
    expect(api.getPositions().system).toEqual({ x: 500, y: 400 })
    expect(api.getSizes().today).toEqual({ w: 260, h: 120 })
    expect(cards.today.style.width).toBe('260px')
    expect(cards.today.style.height).toBe('120px')
  })

  test('레이어 밖 저장 위치는 안쪽으로 clamp된다', () => {
    const layout = JSON.stringify({
      version: 3,
      positions: { today: { x: 99999, y: 40 }, storage: { x: 900, y: 40 }, system: { x: 500, y: 400 } },
      sizes: {},
    })
    const { api } = renderWith(makeStorage({ [POS_KEY]: layout }))
    expect(api.getPositions().today.x).toBe(AREA.w - CARD_W)
    expect(api.getPositions().today.y).toBe(40)
  })
})

describe('위젯 렌더 — 카드 배치와 높이', () => {
  test('빈 저장 상태: 세 카드가 서로 다른 위치에 렌더되고 크기는 고정되지 않는다', () => {
    const { cards } = renderWith(makeStorage({}))
    const rendered = ORDER.map((id) => cards[id])
    expect(rendered.map((c) => c.dataset.widgetId)).toEqual(ORDER)
    const positions = rendered.map((c) => c.style.left + '/' + c.style.top)
    expect(new Set(positions).size).toBe(3)
    for (const c of rendered) {
      // 저장된 크기가 없으면 style은 비어 CSS 기본(304px)을 따른다
      expect(c.style.width).toBe('')
      expect(c.style.height).toBe('')
    }
  })

  test('저장된 크기가 있으면 그 높이가 적용된다', () => {
    const layout = JSON.stringify({
      version: 3,
      positions: { today: { x: 100, y: 100 }, storage: { x: 100, y: 300 }, system: { x: 100, y: 500 } },
      sizes: { system: { w: 340, h: 210 } },
    })
    const { cards } = renderWith(makeStorage({ [POS_KEY]: layout }))
    expect(cards.system.style.width).toBe('340px')
    expect(cards.system.style.height).toBe('210px')
    expect(cards.today.style.height).toBe('')
  })

  test('저장 크기는 최소 220×96으로 clamp된다', () => {
    const layout = JSON.stringify({
      version: 3,
      positions: { today: { x: 100, y: 100 }, storage: { x: 100, y: 300 }, system: { x: 100, y: 500 } },
      sizes: { today: { w: 100, h: 40 } },
    })
    const { api, cards } = renderWith(makeStorage({ [POS_KEY]: layout }))
    expect(api.getSizes().today).toEqual({ w: 220, h: 96 })
    expect(cards.today.style.width).toBe('220px')
    expect(cards.today.style.height).toBe('96px')
  })
})

// 모듈 스코프 고정: 다른 테스트 파일의 동명 전역(AREA 등)과 한 프로그램으로
// 컴파일될 때 TS2451 재선언 오류가 나는 것을 막는다 (2026-11-10 표면 게이트에서 발견).
export {}
