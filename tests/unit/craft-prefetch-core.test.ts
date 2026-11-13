/// <reference types="jest" />
/**
 * public/js/craft-prefetch-core.js — 프리패치 5중복 통합 코어 단위 테스트.
 *
 * 고정하는 성질 (F-L1 설계 노트 .scratch/f-l1-prefetch-design.md):
 * - drain: 스트림을 끝까지 비우고, 스트림이 없으면 arrayBuffer로 받고,
 *   본문이 없으면 그냥 끝나며, pump 실패를 삼킨다.
 * - extractAssetPaths: href="./..." 중 .js/.wasm만, 선언 순서 유지,
 *   중복 제거, 아이콘 등 다른 확장은 제외.
 * - manifestAssetUrls: 호출부 옵션대로 js·wasm·wasmParts·snippets/·
 *   loader.js를 순서대로 만든다. 특히 pdfcraft는 단일 wasm을 받지
 *   않는다 (47MB 중복 수신 회귀 방지).
 * - createPrefetch: once 플래그(두 번째 호출은 무동작), fetchFn 없음
 *   → [] (플래그는 세우지 않음), shell/발견 실패 → [], 개별 자산
 *   실패 무시, 순차 fetch·done 목록.
 * - isOfficeSurface: office.html 경로 판정 (정확히 끝날 때만).
 * - scheduleAutoBoot: 오피스 서면·saveData면 예약 안 함, idle /
 *   complete 1500ms / load+1500ms 규칙, fn은 인자 없이 호출.
 * 카나리아: 플래그명을 바꾸면 래퍼 동등성 테스트가, 게이트를 빼면
 * scheduleAutoBoot 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..', '..')
const CORE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'craft-prefetch-core.js'), 'utf-8')

function loadCore(opts: {
  win?: any
  doc?: any
  navigator?: any
  setTimeoutFn?: any
} = {}): any {
  const win = opts.win !== undefined ? opts.win : {}
  const moduleObj: any = { exports: {} }
  const fn = new Function('window', 'document', 'navigator', 'setTimeout', 'module', CORE_SRC)
  fn(win, opts.doc, opts.navigator, opts.setTimeoutFn || setTimeout, moduleObj)
  return win.MyHubCraftPrefetchCore || moduleObj.exports
}

function okRes(): any {
  return { ok: true, status: 200, body: null, arrayBuffer: async () => new ArrayBuffer(0) }
}
function jsonRes(obj: any): any {
  return { ok: true, status: 200, json: async () => obj, body: null, arrayBuffer: async () => new ArrayBuffer(0) }
}

describe('craft-prefetch-core drain', () => {
  test('스트림 본문을 끝까지 비운다', async () => {
    const core = loadCore()
    const chunks = ['a', 'b', 'c']
    let drained = ''
    const res: any = {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            const next = chunks.shift()
            if (next === undefined) return { done: true, value: undefined }
            drained += next
            return { done: false, value: next }
          },
        }),
      },
    }
    await core.drain(res)
    expect(drained).toBe('abc')
  })

  test('스트림이 없으면 arrayBuffer로 받아 버린다', async () => {
    const core = loadCore()
    let buffered = false
    const res: any = {
      ok: true,
      body: null,
      arrayBuffer: async () => {
        buffered = true
        return new ArrayBuffer(8)
      },
    }
    await core.drain(res)
    expect(buffered).toBe(true)
  })

  test('본문이 없어도 그냥 끝난다 (null·무본문·arrayBuffer 없음)', async () => {
    const core = loadCore()
    await expect(core.drain(null)).resolves.toBeUndefined()
    await expect(core.drain(undefined)).resolves.toBeUndefined()
    await expect(core.drain({ ok: true, body: null })).resolves.toBeUndefined()
    await expect(core.drain({ ok: true })).resolves.toBeUndefined()
  })

  test('pump 실패를 삼킨다 (읽기 중 reject돼도 drain은 resolve)', async () => {
    const core = loadCore()
    const res: any = {
      ok: true,
      body: { getReader: () => ({ read: async () => { throw new Error('stream broken') } }) },
    }
    await expect(core.drain(res)).resolves.toBeUndefined()
  })
})

describe('craft-prefetch-core extractAssetPaths', () => {
  test('선언 순서를 유지하고 중복을 제거한다', () => {
    const core = loadCore()
    const html =
      '<link rel="modulepreload" href="./a.js">' +
      '<link rel="preload" href="./b_bg.wasm" as="fetch">' +
      '<link rel="modulepreload" href="./a.js">' +
      '<link rel="modulepreload" href="./snippets/x/inline0.js">'
    expect(core.extractAssetPaths(html)).toEqual([
      'a.js',
      'b_bg.wasm',
      'snippets/x/inline0.js',
    ])
  })

  test('.ico 등 .js/.wasm가 아닌 선언은 제외한다', () => {
    const core = loadCore()
    const html =
      '<link rel="icon" href="./app.ico">' +
      '<link rel="stylesheet" href="./style.css">' +
      '<link rel="preload" href="./data.json" as="fetch">' +
      '<link rel="modulepreload" href="./app.js">'
    expect(core.extractAssetPaths(html)).toEqual(['app.js'])
  })

  test('./로 시작하지 않는 href는 제외하고 빈 입력은 []이다', () => {
    const core = loadCore()
    const html =
      '<link rel="modulepreload" href="/abs/app.js">' +
      '<link rel="modulepreload" href="bare.js">' +
      '<link rel="modulepreload" href="./rel.js">'
    expect(core.extractAssetPaths(html)).toEqual(['rel.js'])
    expect(core.extractAssetPaths('')).toEqual([])
    expect(core.extractAssetPaths(null)).toEqual([])
    expect(core.extractAssetPaths(undefined)).toEqual([])
  })
})

describe('craft-prefetch-core manifestAssetUrls', () => {
  const DECK_MAN = {
    js: 'deckcraft-web-abc.js',
    wasm: 'deckcraft-web-abc_bg.wasm',
    files: ['deckcraft-abc.ico', 'index.html', 'snippets/eframe-1/inline0.js'],
  }
  const PDF_MAN = {
    js: 'pdfcraft-web-abc.js',
    wasm: 'pdfcraft-web-abc_bg.wasm',
    wasmParts: ['pdfcraft-web-abc_bg.wasm.part0', 'pdfcraft-web-abc_bg.wasm.part1'],
    files: ['LICENSE-MIT', 'loader.js', 'snippets/eframe-1/inline0.js'],
  }

  test('deck 옵션: js·wasm·snippets만, wasmParts·loader 제외', () => {
    const core = loadCore()
    expect(
      core.manifestAssetUrls('/vendor/deckcraft/', DECK_MAN, { wasm: true, snippets: true }),
    ).toEqual([
      '/vendor/deckcraft/deckcraft-web-abc.js',
      '/vendor/deckcraft/deckcraft-web-abc_bg.wasm',
      '/vendor/deckcraft/snippets/eframe-1/inline0.js',
    ])
  })

  test('pdf 옵션: js·wasmParts·loader·snippets, 단일 wasm은 받지 않는다', () => {
    const core = loadCore()
    const urls = core.manifestAssetUrls('/vendor/pdfcraft/', PDF_MAN, {
      wasmParts: true,
      snippets: true,
      loader: true,
    })
    expect(urls).toEqual([
      '/vendor/pdfcraft/pdfcraft-web-abc.js',
      '/vendor/pdfcraft/pdfcraft-web-abc_bg.wasm.part0',
      '/vendor/pdfcraft/pdfcraft-web-abc_bg.wasm.part1',
      '/vendor/pdfcraft/loader.js',
      '/vendor/pdfcraft/snippets/eframe-1/inline0.js',
    ])
    // 단일 wasm(47MB)을 받으면 로더가 파트를 이어 붙이는 구조와 중복된다.
    expect(urls).not.toContain('/vendor/pdfcraft/pdfcraft-web-abc_bg.wasm')
  })

  test('office 옵션: js·wasm·wasmParts만, snippets·loader 제외', () => {
    const core = loadCore()
    expect(
      core.manifestAssetUrls('/vendor/pdfcraft/', PDF_MAN, { wasm: true, wasmParts: true }),
    ).toEqual([
      '/vendor/pdfcraft/pdfcraft-web-abc.js',
      '/vendor/pdfcraft/pdfcraft-web-abc_bg.wasm',
      '/vendor/pdfcraft/pdfcraft-web-abc_bg.wasm.part0',
      '/vendor/pdfcraft/pdfcraft-web-abc_bg.wasm.part1',
    ])
  })

  test('manifest가 없으면 []이고 없는 필드는 건너뛴다', () => {
    const core = loadCore()
    expect(core.manifestAssetUrls('/vendor/x/', null, { wasm: true })).toEqual([])
    expect(core.manifestAssetUrls('/vendor/x/', {}, { wasm: true })).toEqual([])
    expect(core.manifestAssetUrls('/vendor/x/', { js: 'a.js' }, {})).toEqual(['/vendor/x/a.js'])
  })
})

describe('craft-prefetch-core fetchSequential', () => {
  test('순서대로 fetch하고 ok인 것만 done에 담는다', async () => {
    const core = loadCore()
    const order: string[] = []
    const fetchFn = async (url: string) => {
      order.push(url)
      if (url.endsWith('bad.wasm')) return { ok: false, status: 404, body: null, arrayBuffer: async () => new ArrayBuffer(0) }
      return okRes()
    }
    const done = await core.fetchSequential(fetchFn, ['/a.js', '/bad.wasm', '/c.wasm'])
    expect(order).toEqual(['/a.js', '/bad.wasm', '/c.wasm'])
    expect(done).toEqual(['/a.js', '/c.wasm'])
  })

  test('개별 fetch 실패는 무시하고 나머지를 계속 받는다', async () => {
    const core = loadCore()
    const fetchFn = async (url: string) => {
      if (url.endsWith('boom.js')) throw new Error('network down')
      return okRes()
    }
    const done = await core.fetchSequential(fetchFn, ['/a.js', '/boom.js', '/c.js'])
    expect(done).toEqual(['/a.js', '/c.js'])
  })

  test('빈 목록은 []이다', async () => {
    const core = loadCore()
    await expect(core.fetchSequential(async () => okRes(), [])).resolves.toEqual([])
  })
})

describe('craft-prefetch-core createPrefetch', () => {
  function shellDiscover(shellUrl: string, html: string) {
    return async (fetchFn: any) => {
      const res = await fetchFn(shellUrl)
      if (!res || !res.ok) throw new Error('shell http ' + (res && res.status))
      const text = await res.text()
      return text === html ? ['/vendor/x/a.js', '/vendor/x/b.wasm'] : []
    }
  }

  test('발견→순차 fetch→done 목록을 돌려준다', async () => {
    const core = loadCore()
    const fetched: string[] = []
    const fetchFn = async (url: string) => {
      fetched.push(url)
      if (url.endsWith('index.html')) {
        return { ok: true, status: 200, text: async () => '<html/>', body: null, arrayBuffer: async () => new ArrayBuffer(0) }
      }
      return okRes()
    }
    const prefetch = core.createPrefetch({
      flag: '__testPrefetched',
      discover: shellDiscover('/vendor/x/index.html', '<html/>'),
    })
    const done = await prefetch({ fetchFn, win: {} })
    expect(fetched).toEqual(['/vendor/x/index.html', '/vendor/x/a.js', '/vendor/x/b.wasm'])
    expect(done).toEqual(['/vendor/x/a.js', '/vendor/x/b.wasm'])
  })

  test('두 번째 호출은 fetch 없이 []이다 (once 플래그)', async () => {
    const core = loadCore()
    let count = 0
    const fetchFn = async (url: string) => {
      count++
      if (url.endsWith('index.html')) {
        return { ok: true, status: 200, text: async () => '<html/>', body: null, arrayBuffer: async () => new ArrayBuffer(0) }
      }
      return okRes()
    }
    const win: any = {}
    const prefetch = core.createPrefetch({
      flag: '__testPrefetched',
      discover: shellDiscover('/vendor/x/index.html', '<html/>'),
    })
    await prefetch({ fetchFn, win })
    expect(win.__testPrefetched).toBe(true)
    const firstCount = count
    await expect(prefetch({ fetchFn, win })).resolves.toEqual([])
    expect(count).toBe(firstCount)
  })

  test('같은 플래그의 다른 prefetch도 건너뛴다 (공유 플래그)', async () => {
    const core = loadCore()
    const fetchFn = async (url: string) => {
      if (url.endsWith('index.html')) {
        return { ok: true, status: 200, text: async () => '<html/>', body: null, arrayBuffer: async () => new ArrayBuffer(0) }
      }
      if (url.endsWith('manifest.json')) return jsonRes({ js: 'm.js' })
      return okRes()
    }
    const win: any = {}
    const a = core.createPrefetch({
      flag: '__sharedFlag',
      discover: shellDiscover('/vendor/x/index.html', '<html/>'),
    })
    const b = core.createPrefetch({
      flag: '__sharedFlag',
      discover: async (f: any) => {
        await f('/vendor/x/manifest.json')
        return ['/vendor/x/m.js']
      },
    })
    await a({ fetchFn, win })
    // b는 manifest를 받지 않고 []이다 — a가 이미 플래그를 세웠다.
    const fetched: string[] = []
    const spyFetch = async (url: string) => {
      fetched.push(url)
      return fetchFn(url)
    }
    await expect(b({ fetchFn: spyFetch, win })).resolves.toEqual([])
    expect(fetched).toEqual([])
  })

  test('fetchFn이 없으면 []이고 플래그를 세우지 않는다', async () => {
    const core = loadCore()
    const win: any = {}
    const prefetch = core.createPrefetch({
      flag: '__testPrefetched',
      discover: async () => ['/vendor/x/a.js'],
    })
    await expect(prefetch({ win })).resolves.toEqual([])
    expect(win.__testPrefetched).toBeUndefined()
    // 나중에 fetchFn이 생기면 다시 시도할 수 있다.
    const done = await prefetch({ fetchFn: async () => okRes(), win })
    expect(done).toEqual(['/vendor/x/a.js'])
  })

  test('shell 실패·발견 실패는 []이다 (예외를 던지지 않는다)', async () => {
    const core = loadCore()
    const failFetch = async () => {
      throw new Error('network down')
    }
    const prefetch = core.createPrefetch({
      flag: '__testPrefetched',
      discover: shellDiscover('/vendor/x/index.html', '<html/>'),
    })
    await expect(prefetch({ fetchFn: failFetch, win: {} })).resolves.toEqual([])
    const badShell = core.createPrefetch({
      flag: '__testPrefetched2',
      discover: async (f: any) => {
        const res = await f('/vendor/x/index.html')
        if (!res.ok) throw new Error('shell http 500')
        return []
      },
    })
    const http500 = async () => ({ ok: false, status: 500, body: null, arrayBuffer: async () => new ArrayBuffer(0) })
    await expect(badShell({ fetchFn: http500, win: {} })).resolves.toEqual([])
  })

  test('win이 없어도 deps.fetchFn만으로 동작한다', async () => {
    // window 전역이 없는 샌드박스 (module.exports로 api를 받는다).
    const moduleObj: any = { exports: {} }
    const fn = new Function('window', 'document', 'navigator', 'setTimeout', 'module', CORE_SRC)
    fn(undefined, undefined, undefined, setTimeout, moduleObj)
    const core = moduleObj.exports
    const prefetch = core.createPrefetch({
      flag: '__testPrefetched',
      discover: async () => ['/vendor/x/a.js'],
    })
    const done = await prefetch({ fetchFn: async () => okRes() })
    expect(done).toEqual(['/vendor/x/a.js'])
  })
})

describe('craft-prefetch-core isOfficeSurface', () => {
  test.each([
    ['/office.html', true],
    ['/foo/office.html', true],
    ['office.html', true],
    ['/finder.html', false],
    ['/desktop.html', false],
    ['/office.htmlx', false],
    ['/office.html/foo', false],
  ])('pathname %s → %s', (pathname, expected) => {
    const core = loadCore({ win: { location: { pathname } } })
    expect(core.isOfficeSurface()).toBe(expected)
  })

  test('location이 없으면 false이다', () => {
    const core = loadCore({ win: {} })
    expect(core.isOfficeSurface()).toBe(false)
  })
})

describe('craft-prefetch-core scheduleAutoBoot', () => {
  test('idle이 있으면 requestIdleCallback(5000ms 타임아웃)으로 예약하고 fn을 인자 없이 부른다', () => {
    let captured: any = null
    const win: any = {
      location: { pathname: '/finder.html' },
      requestIdleCallback: (cb: any, opts: any) => {
        captured = { cb, opts }
      },
    }
    const core = loadCore({ win, doc: {}, navigator: {} })
    const fn = jest.fn()
    core.scheduleAutoBoot(fn)
    expect(captured).not.toBeNull()
    expect(captured.opts).toEqual({ timeout: 5000 })
    expect(fn).not.toHaveBeenCalled()
    // idle 콜백은 deadline 객체를 주지만 fn에는 인자를 넘기지 않는다.
    captured.cb({ didTimeout: false, timeRemaining: () => 10 })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith()
  })

  test('idle이 없고 complete면 1500ms 뒤에 부른다', () => {
    const win: any = { location: { pathname: '/finder.html' } }
    const timeouts: any[] = []
    const setTimeoutFn = (cb: any, ms: number) => {
      timeouts.push({ cb, ms })
      return 1
    }
    const core = loadCore({ win, doc: { readyState: 'complete' }, navigator: {}, setTimeoutFn })
    const fn = jest.fn()
    core.scheduleAutoBoot(fn)
    expect(timeouts).toHaveLength(1)
    expect(timeouts[0].ms).toBe(1500)
    timeouts[0].cb()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('idle이 없고 loading이면 load 뒤 1500ms에 부른다', () => {
    const listeners: Record<string, any> = {}
    const win: any = {
      location: { pathname: '/finder.html' },
      addEventListener: (type: string, cb: any) => {
        listeners[type] = cb
      },
    }
    const timeouts: any[] = []
    const setTimeoutFn = (cb: any, ms: number) => {
      timeouts.push({ cb, ms })
      return 1
    }
    const core = loadCore({ win, doc: { readyState: 'loading' }, navigator: {}, setTimeoutFn })
    const fn = jest.fn()
    core.scheduleAutoBoot(fn)
    expect(listeners.load).toBeDefined()
    expect(timeouts).toHaveLength(0)
    listeners.load()
    expect(timeouts).toHaveLength(1)
    expect(timeouts[0].ms).toBe(1500)
    timeouts[0].cb()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('오피스 서면이면 아무것도 예약하지 않는다', () => {
    const win: any = {
      location: { pathname: '/office.html' },
      requestIdleCallback: jest.fn(),
      addEventListener: jest.fn(),
    }
    const setTimeoutFn = jest.fn()
    const core = loadCore({ win, doc: { readyState: 'complete' }, navigator: {}, setTimeoutFn })
    core.scheduleAutoBoot(jest.fn())
    expect(win.requestIdleCallback).not.toHaveBeenCalled()
    expect(win.addEventListener).not.toHaveBeenCalled()
    expect(setTimeoutFn).not.toHaveBeenCalled()
  })

  test('데이터 절약 모드면 아무것도 예약하지 않는다', () => {
    const win: any = {
      location: { pathname: '/finder.html' },
      requestIdleCallback: jest.fn(),
      addEventListener: jest.fn(),
    }
    const setTimeoutFn = jest.fn()
    const core = loadCore({
      win,
      doc: { readyState: 'complete' },
      navigator: { connection: { saveData: true } },
      setTimeoutFn,
    })
    core.scheduleAutoBoot(jest.fn())
    expect(win.requestIdleCallback).not.toHaveBeenCalled()
    expect(win.addEventListener).not.toHaveBeenCalled()
    expect(setTimeoutFn).not.toHaveBeenCalled()
  })
})
