/// <reference types="jest" />
/**
 * P1 폰트 재푸시 — fonts.whenLoaded() 계약 테스트 (2026-11-15)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - whenReady(50)는 로딩이 끝나기 전에 빈 결과로 먼저 resolve한다
 *   (타임아웃 경로 — 이것이 P1의 원인이다).
 * - whenLoaded()는 로딩이 실제로 끝날 때까지 기다렸다가, 페이스와
 *   함께 resolve한다.
 * - whenLoaded()를 여러 번 불러도 진행 중인 load() Promise를 공유한다
 *   (fetch가 한 번만 나간다).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../public/js/common/constants.js') // fonts.js의 선행 상수 (5-9)
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../public/js/common/http-json.js') // jsonOrThrow 공용 본문
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fonts = require('../../public/js/fonts.js')

function sleepMs(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

class FakeFace {
  family: string
  constructor(family: string, _buf: unknown, _opts: unknown) {
    this.family = family
  }
  load() {
    return Promise.resolve(this)
  }
}

describe('P1 fonts.whenLoaded', () => {
  test('whenReady는 타임아웃에 빈 결과로 먼저 resolve하고, whenLoaded는 실제 로딩 완료를 기다린다', async () => {
    let releaseList: (() => void) | null = null
    const listGate = new Promise<void>((res) => {
      releaseList = res
    })
    const seen: string[] = []
    const g = globalThis as any
    const origFetch = g.fetch
    const origFontFace = g.FontFace
    const origDocument = g.document
    g.fetch = async (url: string) => {
      seen.push(url)
      if (url === '/api/drive/list') {
        await listGate
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, folders: [{ id: 7, name: '폰트' }] }),
        }
      }
      if (url === '/api/drive/list?folder=7') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, files: [{ id: 1, filename: 'MyFont.ttf' }] }),
        }
      }
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2]).buffer }
    }
    g.FontFace = FakeFace
    g.document = { fonts: { add: jest.fn() } }
    try {
      // load()를 시작한다 — 폴더 목록 fetch가 게이트에 막혀 있다.
      const loadP = fonts.load()
      // whenReady(50)는 50ms에 빈 결과로 resolve해야 한다 (로딩 미완료).
      const ready = await fonts.whenReady(50)
      expect(ready).toBeNull()
      expect(fonts.faces()).toEqual([])
      // whenLoaded는 아직 resolve되지 않아야 한다.
      let loadedResolved = false
      const loadedP = fonts.whenLoaded()
      void loadedP.then(() => {
        loadedResolved = true
      })
      await sleepMs(80)
      expect(loadedResolved).toBe(false)
      // 게이트를 열면 로딩이 끝나고 whenLoaded가 페이스와 함께 resolve한다.
      releaseList!()
      const result = await loadedP
      expect(result.faces).toHaveLength(1)
      expect(result.faces[0].family).toBe('MyFont')
      expect(fonts.faces()).toHaveLength(1)
      expect(fonts.families()).toEqual(['MyFont'])
      await loadP
    } finally {
      g.fetch = origFetch
      g.FontFace = origFontFace
      g.document = origDocument
    }
  })

  test('whenLoaded는 진행 중인 load와 같은 Promise를 공유한다', async () => {
    // 이전 테스트의 load()가 캐시돼 있으므로 reload로 초기화한다.
    const g = globalThis as any
    const origFetch = g.fetch
    const origFontFace = g.FontFace
    const origDocument = g.document
    let fetchCount = 0
    g.fetch = async (url: string) => {
      fetchCount += 1
      if (url === '/api/drive/list') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, folders: [{ id: 7, name: '폰트' }] }),
        }
      }
      if (url === '/api/drive/list?folder=7') {
        return { ok: true, status: 200, json: async () => ({ ok: true, files: [] }) }
      }
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([]).buffer }
    }
    g.FontFace = FakeFace
    g.document = { fonts: { add: jest.fn() } }
    try {
      const p1 = fonts.reload()
      const p2 = fonts.whenLoaded()
      const p3 = fonts.whenLoaded()
      expect(p2).toBe(p1)
      expect(p3).toBe(p1)
      await p1
      // 폴더 목록·파일 목록 각 1회씩 — whenLoaded가 새 load를 시작하지 않았다.
      expect(fetchCount).toBe(2)
    } finally {
      g.fetch = origFetch
      g.FontFace = origFontFace
      g.document = origDocument
    }
  })
})
