/// <reference types="jest" />
/**
 * F-L12 state.js 윈도우 복원 검증 루프 통합 테스트 (5-5)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - restoreWindows는 같은 module이 두 번 오면 첫 항목만 복원한다
 *   (seen 중복 제거).
 * - 모르는 module·유한하지 않은 숫자 필드는 건너뛰고, 복원할 게
 *   없으면 같은 state 객체를 그대로 반환한다.
 * - parse와 restoreWindows가 같은 항목에 대해 같은 창 객체를 낸다
 *   (공용 restoredWinFromItem의 동등성).
 * - restoredWinFromItem 정의는 1개, 호출처는 restoreWindows·parse
 *   2곳이다.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const S = require('../../public/js/desktop/state.js')
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const VP = { w: 1440, h: 900 }

const item = {
  id: 'memo',
  module: 'memo',
  x: 40,
  y: 32,
  w: 880,
  h: 620,
  z: 3,
  minimized: false,
  space: 1,
  mode: 'full',
  prev: null,
}

describe('F-L12 restoreWindows', () => {
  test('같은 module이 두 번 오면 첫 항목만 복원한다', () => {
    const out = S.restoreWindows(S.emptyState(), [item, { ...item, x: 100 }], VP)
    expect(out.windows).toHaveLength(1)
    expect(out.windows[0].x).toBe(40)
  })

  test('모르는 module·비유한 숫자는 건너뛰고, 없으면 같은 객체를 반환한다', () => {
    const state = S.emptyState()
    const bad = [
      { ...item, module: 'unknown-module' },
      { ...item, module: 'schedule', w: NaN },
    ]
    expect(S.restoreWindows(state, bad, VP)).toBe(state)
  })

  test('이미 열린 module은 복원하지 않는다', () => {
    const opened = S.restoreWindows(S.emptyState(), [item], VP)
    expect(S.restoreWindows(opened, [item], VP)).toBe(opened)
  })

  test('parse와 restoreWindows가 같은 창 객체를 낸다', () => {
    const viaParse = S.parse(JSON.stringify({ version: 1, windows: [item] }), VP)
      .windows[0]
    const viaRestore = S.restoreWindows(S.emptyState(), [item], VP).windows[0]
    expect(viaParse).toEqual(viaRestore)
    expect(viaParse.mode).toBe('full')
    expect(viaParse.space).toBe(1)
  })
})

describe('F-L12 구조', () => {
  test('restoredWinFromItem 정의 1개·호출 2곳', () => {
    const src = read('public/js/desktop/state.js')
    expect(src.match(/function restoredWinFromItem\(item, seen, spaces, viewport\)/g))
      .toHaveLength(1)
    expect(
      src.match(/= restoredWinFromItem\(item, seen, (state\.spaces|spaces), viewport\)/g),
    ).toHaveLength(2)
  })
})
