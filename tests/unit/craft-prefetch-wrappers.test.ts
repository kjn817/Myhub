/// <reference types="jest" />
/**
 * 프리패치 래퍼 동등성 테스트 (F-L1 통합, 5-1).
 *
 * 코어 위임으로 바꾼 5개 사이트가 구 동작과 같은 계약을 유지하는지
 * 고정한다:
 * - deck/grid standalone 래퍼: API 모양·SHELL_URL·shell 발견 URL 목록·
 *   once 플래그·module.exports.
 * - 공유 플래그: standalone deck 래퍼와 finder-deckcraft 내장이
 *   __myhubDeckcraftPrefetched를 공유한다 — 한쪽이 데우면 다른 쪽이
 *   manifest/shell을 받지 않는다 (양방향).
 * - finder-pdfcraft: js·wasmParts·loader.js·snippets만 받고 단일
 *   wasm(47MB)은 받지 않는다.
 * - 자동 부팅 게이트: 오피스 서면에서는 래퍼가 예약을 안 하고,
 *   Finder 서면에서는 예약한다.
 * 카나리아: 래퍼의 플래그명을 바꾸면 공유 플래그 테스트가, 게이트를
 * 빼면 자동 부팅 게이트 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..', '..')
const CORE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'craft-prefetch-core.js'), 'utf-8')
const CONSTANTS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'common', 'constants.js'), 'utf-8')
const DECK_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'deckcraft-prefetch.js'), 'utf-8')
const GRID_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'gridcraft-prefetch.js'), 'utf-8')
const FINDER_DECK_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'finder-deckcraft.js'), 'utf-8')
const FINDER_PDF_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'finder-pdfcraft.js'), 'utf-8')

const DECK_SHELL_HTML =
  '<link rel="icon" href="./deckcraft-abc.ico">' +
  '<link rel="modulepreload" href="./deckcraft-web-abc.js">' +
  '<link rel="modulepreload" href="./snippets/eframe-1/inline0.js">' +
  '<link rel="preload" href="./deckcraft-web-abc_bg.wasm" as="fetch" type="application/wasm">'

const GRID_SHELL_HTML =
  '<link rel="icon" href="./gridcraft-abc.ico">' +
  '<link rel="modulepreload" href="./gridcraft-web-abc.js">' +
  '<link rel="preload" href="./gridcraft-web-abc_bg.wasm" as="fetch" type="application/wasm">'

function okRes(): any {
  return { ok: true, status: 200, body: null, arrayBuffer: async () => new ArrayBuffer(0) }
}
function textRes(text: string): any {
  return { ok: true, status: 200, text: async () => text, body: null, arrayBuffer: async () => new ArrayBuffer(0) }
}
function jsonRes(obj: any): any {
  return { ok: true, status: 200, json: async () => obj, body: null, arrayBuffer: async () => new ArrayBuffer(0) }
}

/**
 * 샌드박스에 소스를 순서대로 실행한다. 코어를 먼저 받아야 래퍼가
 * 동작한다 (실제 로드 순서와 같다). document를 주지 않으면 자동
 * 부팅 블록이 건너뛰어진다.
 */
function loadSources(
  sources: string[],
  opts: { win?: any; doc?: any; navigator?: any; setTimeoutFn?: any } = {},
): { win: any; moduleObj: any } {
  const win = opts.win !== undefined ? opts.win : {}
  const moduleObj: any = { exports: {} }
  // 5-9: 공용 상수를 항상 먼저 뜬다 (운영 페이지의 태그 순서와 동일 —
  // finder-deckcraft 등 소비처는 상수 없이는 로드 시점에 실패한다).
  const allSources = [CONSTANTS_SRC, ...sources]
  for (const src of allSources) {
    const fn = new Function('window', 'document', 'navigator', 'setTimeout', 'console', 'module', src)
    fn(win, opts.doc, opts.navigator, opts.setTimeoutFn || setTimeout, console, moduleObj)
  }
  return { win, moduleObj }
}

describe('deckcraft standalone 래퍼 동등성', () => {
  test('API 모양·SHELL_URL·window 전역·module.exports를 유지한다', () => {
    const { win, moduleObj } = loadSources([CORE_SRC, DECK_SRC])
    const api = win.MyHubDeckcraftPrefetch
    expect(api).toBeDefined()
    expect(typeof api.prefetch).toBe('function')
    expect(typeof api.extractAssetPaths).toBe('function')
    expect(api.SHELL_URL).toBe('/vendor/deckcraft/index.html')
    expect(moduleObj.exports).toBe(api)
  })

  test('shell을 읽어 js·snippets·wasm을 순서대로 받고 아이콘은 제외한다', async () => {
    const { win } = loadSources([CORE_SRC, DECK_SRC])
    const fetched: string[] = []
    const fetchFn = async (url: string) => {
      fetched.push(url)
      if (url.endsWith('index.html')) return textRes(DECK_SHELL_HTML)
      return okRes()
    }
    const done = await win.MyHubDeckcraftPrefetch.prefetch({ fetchFn, win })
    expect(fetched).toEqual([
      '/vendor/deckcraft/index.html',
      '/vendor/deckcraft/deckcraft-web-abc.js',
      '/vendor/deckcraft/snippets/eframe-1/inline0.js',
      '/vendor/deckcraft/deckcraft-web-abc_bg.wasm',
    ])
    expect(done).toEqual([
      '/vendor/deckcraft/deckcraft-web-abc.js',
      '/vendor/deckcraft/snippets/eframe-1/inline0.js',
      '/vendor/deckcraft/deckcraft-web-abc_bg.wasm',
    ])
    expect(win.__myhubDeckcraftPrefetched).toBe(true)
  })

  test('두 번째 prefetch는 fetch 없이 []이다', async () => {
    const { win } = loadSources([CORE_SRC, DECK_SRC])
    let count = 0
    const fetchFn = async (url: string) => {
      count++
      if (url.endsWith('index.html')) return textRes(DECK_SHELL_HTML)
      return okRes()
    }
    await win.MyHubDeckcraftPrefetch.prefetch({ fetchFn, win })
    const firstCount = count
    await expect(win.MyHubDeckcraftPrefetch.prefetch({ fetchFn, win })).resolves.toEqual([])
    expect(count).toBe(firstCount)
  })

  test('extractAssetPaths API는 코어와 같은 결과를 낸다', () => {
    const { win } = loadSources([CORE_SRC, DECK_SRC])
    expect(win.MyHubDeckcraftPrefetch.extractAssetPaths(DECK_SHELL_HTML)).toEqual([
      'deckcraft-web-abc.js',
      'snippets/eframe-1/inline0.js',
      'deckcraft-web-abc_bg.wasm',
    ])
  })
})

describe('gridcraft standalone 래퍼 동등성', () => {
  test('API 모양·SHELL_URL·별개 플래그를 유지한다', async () => {
    const { win } = loadSources([CORE_SRC, GRID_SRC])
    const api = win.MyHubGridcraftPrefetch
    expect(api).toBeDefined()
    expect(api.SHELL_URL).toBe('/vendor/gridcraft/index.html')
    const fetched: string[] = []
    const fetchFn = async (url: string) => {
      fetched.push(url)
      if (url.endsWith('index.html')) return textRes(GRID_SHELL_HTML)
      return okRes()
    }
    const done = await api.prefetch({ fetchFn, win })
    expect(fetched).toEqual([
      '/vendor/gridcraft/index.html',
      '/vendor/gridcraft/gridcraft-web-abc.js',
      '/vendor/gridcraft/gridcraft-web-abc_bg.wasm',
    ])
    expect(done).toEqual([
      '/vendor/gridcraft/gridcraft-web-abc.js',
      '/vendor/gridcraft/gridcraft-web-abc_bg.wasm',
    ])
    // grid 플래그는 deck 플래그와 별개다.
    expect(win.__myhubGridcraftPrefetched).toBe(true)
    expect(win.__myhubDeckcraftPrefetched).toBeUndefined()
  })
})

describe('deck 공유 플래그 (standalone 래퍼 ↔ finder 내장)', () => {
  const DECK_MANIFEST = {
    js: 'deckcraft-web-abc.js',
    wasm: 'deckcraft-web-abc_bg.wasm',
    files: ['deckcraft-abc.ico', 'index.html', 'snippets/eframe-1/inline0.js'],
  }

  function manifestFetch(fetched: string[]) {
    return async (url: string) => {
      fetched.push(url)
      if (url.endsWith('index.html')) return textRes(DECK_SHELL_HTML)
      if (url.endsWith('manifest.json')) return jsonRes(DECK_MANIFEST)
      return okRes()
    }
  }

  test('standalone이 먼저 데우면 finder 내장은 manifest를 받지 않는다', async () => {
    const { win } = loadSources([CORE_SRC, DECK_SRC, FINDER_DECK_SRC])
    const fetched: string[] = []
    const fetchFn = manifestFetch(fetched)
    const deckDone = await win.MyHubDeckcraftPrefetch.prefetch({ fetchFn, win })
    expect(deckDone).toHaveLength(3)
    fetched.length = 0
    const finderDone = await win.MyHubFinderDeckCraft.prefetch({ fetchFn, win })
    expect(finderDone).toEqual([])
    expect(fetched).toEqual([])
  })

  test('finder 내장이 먼저 데우면 standalone은 shell을 받지 않는다', async () => {
    const { win } = loadSources([CORE_SRC, DECK_SRC, FINDER_DECK_SRC])
    const fetched: string[] = []
    const fetchFn = manifestFetch(fetched)
    const finderDone = await win.MyHubFinderDeckCraft.prefetch({ fetchFn, win })
    expect(finderDone).toEqual([
      '/vendor/deckcraft/deckcraft-web-abc.js',
      '/vendor/deckcraft/deckcraft-web-abc_bg.wasm',
      '/vendor/deckcraft/snippets/eframe-1/inline0.js',
    ])
    fetched.length = 0
    const deckDone = await win.MyHubDeckcraftPrefetch.prefetch({ fetchFn, win })
    expect(deckDone).toEqual([])
    expect(fetched).toEqual([])
  })
})

describe('finder-pdfcraft 내장 동등성', () => {
  test('js·wasmParts·loader·snippets만 받고 단일 wasm은 받지 않는다', async () => {
    const { win } = loadSources([CORE_SRC, FINDER_PDF_SRC])
    const fetched: string[] = []
    const fetchFn = async (url: string) => {
      fetched.push(url)
      if (url.endsWith('manifest.json')) {
        return jsonRes({
          js: 'pdfcraft-web-abc.js',
          wasm: 'pdfcraft-web-abc_bg.wasm',
          wasmParts: ['pdfcraft-web-abc_bg.wasm.part0', 'pdfcraft-web-abc_bg.wasm.part1'],
          files: ['LICENSE-MIT', 'loader.js', 'snippets/eframe-1/inline0.js'],
        })
      }
      return okRes()
    }
    const done = await win.MyHubFinderPdfCraft.prefetch({ fetchFn, win })
    expect(fetched).toEqual([
      '/vendor/pdfcraft/manifest.json',
      '/vendor/pdfcraft/pdfcraft-web-abc.js',
      '/vendor/pdfcraft/pdfcraft-web-abc_bg.wasm.part0',
      '/vendor/pdfcraft/pdfcraft-web-abc_bg.wasm.part1',
      '/vendor/pdfcraft/loader.js',
      '/vendor/pdfcraft/snippets/eframe-1/inline0.js',
    ])
    expect(done).toEqual(fetched.slice(1))
    expect(win.__myhubPdfcraftPrefetched).toBe(true)
  })

  test('두 번째 prefetch는 fetch 없이 []이다', async () => {
    const { win } = loadSources([CORE_SRC, FINDER_PDF_SRC])
    let count = 0
    const fetchFn = async (url: string) => {
      count++
      if (url.endsWith('manifest.json')) return jsonRes({ js: 'a.js' })
      return okRes()
    }
    await win.MyHubFinderPdfCraft.prefetch({ fetchFn, win })
    const firstCount = count
    await expect(win.MyHubFinderPdfCraft.prefetch({ fetchFn, win })).resolves.toEqual([])
    expect(count).toBe(firstCount)
  })
})

describe('래퍼 자동 부팅 게이트', () => {
  test('오피스 서면에서는 deck 래퍼가 예약을 하지 않는다', () => {
    const timeouts: any[] = []
    const win: any = {
      location: { pathname: '/office.html' },
      requestIdleCallback: jest.fn(),
      addEventListener: jest.fn(),
    }
    loadSources([CORE_SRC, DECK_SRC], {
      win,
      doc: { readyState: 'complete' },
      navigator: {},
      setTimeoutFn: (cb: any, ms: number) => {
        timeouts.push({ cb, ms })
        return 1
      },
    })
    expect(win.requestIdleCallback).not.toHaveBeenCalled()
    expect(win.addEventListener).not.toHaveBeenCalled()
    expect(timeouts).toHaveLength(0)
  })

  test('Finder 서면에서는 deck 래퍼가 1500ms 뒤 부팅을 예약한다', () => {
    const timeouts: any[] = []
    const win: any = { location: { pathname: '/finder.html' } }
    loadSources([CORE_SRC, DECK_SRC], {
      win,
      doc: { readyState: 'complete' },
      navigator: {},
      setTimeoutFn: (cb: any, ms: number) => {
        timeouts.push({ cb, ms })
        return 1
      },
    })
    expect(timeouts).toHaveLength(1)
    expect(timeouts[0].ms).toBe(1500)
  })

  test('오피스 서면에서는 finder-pdfcraft도 예약을 하지 않는다', () => {
    const timeouts: any[] = []
    const win: any = {
      location: { pathname: '/office.html' },
      requestIdleCallback: jest.fn(),
      addEventListener: jest.fn(),
    }
    loadSources([CORE_SRC, FINDER_PDF_SRC], {
      win,
      doc: { readyState: 'complete' },
      navigator: {},
      setTimeoutFn: (cb: any, ms: number) => {
        timeouts.push({ cb, ms })
        return 1
      },
    })
    expect(win.requestIdleCallback).not.toHaveBeenCalled()
    expect(win.addEventListener).not.toHaveBeenCalled()
    expect(timeouts).toHaveLength(0)
  })
})

describe('코어 없이 로드해도 깨지지 않는다', () => {
  test('deck 래퍼 단독 로드 시 prefetch는 []이고 throw하지 않는다', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { win } = loadSources([DECK_SRC])
      expect(win.MyHubDeckcraftPrefetch).toBeDefined()
      await expect(
        win.MyHubDeckcraftPrefetch.prefetch({ fetchFn: async () => okRes(), win }),
      ).resolves.toEqual([])
      expect(win.MyHubDeckcraftPrefetch.extractAssetPaths(DECK_SHELL_HTML)).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })
})
