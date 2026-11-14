/// <reference types="jest" />
/**
 * F-L10 폰트 바이트 공용 본문 테스트 (5-5)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - loadFontBytes는 spec 목록을 병렬로 받아 {family, weight, style, u8}
 *   배열을 낸다. 실패한 항목은 null로 남겨 나머지를 막지 않는다.
 * - loadPoolBytes는 POOL_FACES 전체를 loadFontBytes로 받아 null을
 *   걸러내고, 같은 fetchFn이면 같은 Promise를 재사용한다 (캐시).
 * - deckcraft의 loadFallbackFonts는 로컬 fetch 루프가 아니라
 *   fonts.js의 loadFontBytes를 쓰고, 없으면 warn 후 빈 배열이다.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../public/js/common/constants.js') // fonts.js의 선행 상수 (5-9)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fonts = require('../../public/js/fonts.js')
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

function okFetch(body: number[]) {
  return async (_url: string) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new Uint8Array(body).buffer,
  })
}

describe('F-L10 loadFontBytes', () => {
  test('spec 목록을 받아 {family, weight, style, u8} 배열을 낸다', async () => {
    const seen: string[] = []
    const fetchFn = async (url: string) => {
      seen.push(url)
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }
    }
    const specs = [
      { url: '/fonts/a.woff2', family: 'A', weight: 400, style: 'normal' },
      { url: '/fonts/b.woff2', family: 'B', weight: 700, style: 'italic' },
    ]
    const out = await fonts.loadFontBytes(fetchFn, specs, 'test')
    expect(seen).toEqual(['/fonts/a.woff2', '/fonts/b.woff2'])
    expect(out[0]).toEqual({
      family: 'A',
      weight: 400,
      style: 'normal',
      u8: new Uint8Array([1, 2, 3]),
    })
    expect(out[1].family).toBe('B')
    expect(out[1].weight).toBe(700)
  })

  test('실패한 항목은 null로 남고 나머지는 받는다', async () => {
    const fetchFn = async (url: string) => {
      if (url.includes('bad')) return { ok: false, status: 404 }
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([9]).buffer,
      }
    }
    const specs = [
      { url: '/fonts/good.woff2', family: 'G', weight: 400, style: 'normal' },
      { url: '/fonts/bad.woff2', family: 'X', weight: 400, style: 'normal' },
    ]
    const out = await fonts.loadFontBytes(fetchFn, specs, 'test')
    expect(out[0]).not.toBeNull()
    expect(out[1]).toBeNull()
  })

  test('fetch 자체가 던져도 null로 남는다', async () => {
    const fetchFn = async () => {
      throw new Error('network down')
    }
    const out = await fonts.loadFontBytes(
      fetchFn,
      [{ url: '/fonts/a.woff2', family: 'A', weight: 400, style: 'normal' }],
      'test',
    )
    expect(out).toEqual([null])
  })
})

describe('F-L10 loadPoolBytes', () => {
  test('POOL_FACES 전체를 받고 null을 걸러낸다', async () => {
    const seen: string[] = []
    const fetchFn = async (url: string) => {
      seen.push(url)
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      }
    }
    const out = await fonts.loadPoolBytes(fetchFn)
    expect(seen).toHaveLength(fonts.POOL_FACES.length)
    expect(out).toHaveLength(fonts.POOL_FACES.length)
    expect(out.every((f: any) => f && f.u8 instanceof Uint8Array)).toBe(true)
  })

  test('같은 fetchFn이면 같은 Promise를 재사용한다', () => {
    const fetchFn = okFetch([1])
    const p1 = fonts.loadPoolBytes(fetchFn)
    const p2 = fonts.loadPoolBytes(fetchFn)
    expect(p1).toBe(p2)
  })

  test('fetchFn이 아니면 빈 배열이다', async () => {
    await expect(fonts.loadPoolBytes(null)).resolves.toEqual([])
  })
})

describe('F-L10 deckcraft 위임', () => {
  test('loadFallbackFonts는 로컬 fetch 루프가 아니라 공용 본문을 쓴다', () => {
    const src = read('public/js/finder-deckcraft.js')
    expect(src).toMatch(/loader\(fetchFn, list, 'fallback'\)/)
    expect(src).toMatch(/MyHubFonts\.loadFontBytes/)
    // 로컬 본문의 특징이 없다
    expect(src).not.toMatch(/fetchFn\(spec\.url\)/)
    expect(src).not.toMatch(/fallback font http/)
    // 코어 없으면 warn 후 빈 배열 (비치명 열화)
    expect(src).toMatch(/fonts\.js\(loadFontBytes\)가 없어 폴백 폰트를 받지 않습니다/)
  })
})
