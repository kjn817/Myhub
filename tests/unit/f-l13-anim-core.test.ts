/// <reference types="jest" />
/**
 * F-L13 anim 공용 코어 단위 테스트 (5-5)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - rAF가 없으면 setTimeout 0으로 폴백하고, cancelRaf가 짝을 맞춘다.
 * - copyPositions는 {x, y} 스냅샷을 새 객체로 복사한다 (원본 참조 유출 없음).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const anim = require('../../public/js/common/anim.js')

describe('anim core', () => {
  test('rAF가 없으면 setTimeout으로 폴백한다', async () => {
    const g = globalThis as any
    const savedWindow = g.window
    delete g.window
    try {
      const seen: string[] = []
      anim.raf(() => seen.push('fired'))
      await new Promise((r) => setTimeout(r, 10))
      expect(seen).toEqual(['fired'])
    } finally {
      if (savedWindow !== undefined) g.window = savedWindow
    }
  })

  test('cancelRaf가 예약된 콜백을 취소한다', async () => {
    const g = globalThis as any
    const savedWindow = g.window
    delete g.window
    try {
      const seen: string[] = []
      const id = anim.raf(() => seen.push('fired'))
      anim.cancelRaf(id)
      await new Promise((r) => setTimeout(r, 10))
      expect(seen).toEqual([])
    } finally {
      if (savedWindow !== undefined) g.window = savedWindow
    }
  })

  test('copyPositions는 {x,y}만 새 객체로 복사한다', () => {
    const positions = {
      a: { x: 1, y: 2, extra: 'drop' },
      b: { x: 3, y: 4 },
    } as any
    const out = anim.copyPositions(positions)
    expect(out).toEqual({ a: { x: 1, y: 2 }, b: { x: 3, y: 4 } })
    expect(out.a).not.toBe(positions.a)
    out.a.x = 99
    expect(positions.a.x).toBe(1)
  })
})
