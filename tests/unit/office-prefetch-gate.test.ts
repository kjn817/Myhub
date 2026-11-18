/// <reference types="jest" />
/**
 * public/js/desktop/office-prefetch.js — 데스크톱 오피스 호버 프리패치 성질 테스트.
 *
 * 고정하는 성질 (2026-11-12 오피스 성능 점검):
 * - prefetch(appId)는 해당 앱의 자산(manifest의 js·wasm 또는 index.html의
 *   preload 링크)을 fetch해 HTTP 캐시를 데운다.
 * - 앱당 1회만 동작한다 (두 번째 호출은 fetch하지 않는다).
 * - 알 수 없는 앱 id·데이터 절약 모드에서는 fetch하지 않는다.
 * - manifest·index fetch 실패는 조용히 무시한다 (예외를 던지지 않는다).
 * 카나리아: 자산 목록 파싱이나 1회 가드를 깨면 해당 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'office-prefetch.js'), 'utf-8')
// office-prefetch.js는 공용 코어(craft-prefetch-core.js) 위에서 돈다 —
// 실제 로드 순서(desktop.html 정적 순서)와 같이 코어를 먼저 받는다.
const CORE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'craft-prefetch-core.js'), 'utf-8')

function loadModule(fetchFn: any, saveData = false): any {
  const sandbox: any = {
    window: {},
    navigator: { connection: { saveData } },
    fetch: fetchFn,
    console,
  }
  sandbox.window.navigator = sandbox.navigator
  const loadCore = new Function('window', 'navigator', 'fetch', 'console', CORE_SRC)
  loadCore(sandbox.window, sandbox.navigator, fetchFn, console)
  const fn = new Function('window', 'navigator', 'fetch', 'console', SRC)
  fn(sandbox.window, sandbox.navigator, fetchFn, console)
  return sandbox.window.MyHubOfficePrefetch
}

function jsonRes(obj: any): any {
  return { ok: true, status: 200, json: async () => obj, body: null, arrayBuffer: async () => new ArrayBuffer(0) }
}
function textRes(text: string): any {
  return { ok: true, status: 200, text: async () => text, body: null, arrayBuffer: async () => new ArrayBuffer(0) }
}
function okRes(): any {
  return { ok: true, status: 200, body: null, arrayBuffer: async () => new ArrayBuffer(0) }
}

describe('office-prefetch', () => {
  test('pdf는 manifest의 js·wasmParts를 전부 fetch한다', async () => {
    const fetched: string[] = []
    const fetchFn = async (url: string) => {
      fetched.push(url)
      if (url.endsWith('manifest.json')) {
        return jsonRes({ js: 'pdfcraft-web-abc.js', wasmParts: ['x_bg.wasm.part0', 'x_bg.wasm.part1'] })
      }
      return okRes()
    }
    const api = loadModule(fetchFn)
    api.prefetch('pdf')
    await new Promise((r) => setTimeout(r, 50))
    expect(fetched).toContain('/vendor/pdfcraft/manifest.json')
    expect(fetched).toContain('/vendor/pdfcraft/pdfcraft-web-abc.js')
    expect(fetched).toContain('/vendor/pdfcraft/x_bg.wasm.part0')
    expect(fetched).toContain('/vendor/pdfcraft/x_bg.wasm.part1')
  })

  test('powerpoint는 manifest의 js·wasm을 fetch한다', async () => {
    const fetched: string[] = []
    const fetchFn = async (url: string) => {
      fetched.push(url)
      if (url.endsWith('manifest.json')) {
        return jsonRes({ js: 'deckcraft-web-abc.js', wasm: 'deckcraft-web-abc_bg.wasm' })
      }
      return okRes()
    }
    const api = loadModule(fetchFn)
    api.prefetch('powerpoint')
    await new Promise((r) => setTimeout(r, 50))
    expect(fetched).toContain('/vendor/deckcraft/deckcraft-web-abc.js')
    expect(fetched).toContain('/vendor/deckcraft/deckcraft-web-abc_bg.wasm')
  })

  test('excel은 index.html의 preload·modulepreload 링크를 fetch한다', async () => {
    const fetched: string[] = []
    const fetchFn = async (url: string) => {
      fetched.push(url)
      if (url.endsWith('index.html')) {
        return textRes(
          '<link rel="modulepreload" href="./gridcraft-web-abc.js">' +
            '<link rel="preload" href="./gridcraft-web-abc_bg.wasm" as="fetch" type="application/wasm">'
        )
      }
      return okRes()
    }
    const api = loadModule(fetchFn)
    api.prefetch('excel')
    await new Promise((r) => setTimeout(r, 50))
    expect(fetched).toContain('/vendor/gridcraft/gridcraft-web-abc.js')
    expect(fetched).toContain('/vendor/gridcraft/gridcraft-web-abc_bg.wasm')
  })

  test('앱당 1회만 동작한다', async () => {
    let count = 0
    const fetchFn = async (url: string) => {
      count++
      if (url.endsWith('manifest.json')) return jsonRes({ js: 'a.js', wasm: 'a.wasm' })
      return okRes()
    }
    const api = loadModule(fetchFn)
    api.prefetch('pdf')
    api.prefetch('pdf')
    api.prefetch('pdf')
    await new Promise((r) => setTimeout(r, 50))
    // manifest 1회 + js 1회 + wasm 1회 = 3회 (두 번째·세 번째 호출은 무동작)
    expect(count).toBe(3)
  })

  test('알 수 없는 앱·데이터 절약 모드에서는 fetch하지 않는다', async () => {
    let count = 0
    const fetchFn = async () => {
      count++
      return okRes()
    }
    const api = loadModule(fetchFn)
    api.prefetch('hangul') // rhwp-studio는 매니페스트·preload이 없어 제외
    api.prefetch('memo')
    api.prefetch('not-an-app')
    await new Promise((r) => setTimeout(r, 20))
    expect(count).toBe(0)

    const api2 = loadModule(fetchFn, true) // saveData
    api2.prefetch('pdf')
    await new Promise((r) => setTimeout(r, 20))
    expect(count).toBe(0)
  })

  test('manifest fetch 실패는 조용히 무시한다', async () => {
    const fetchFn = async () => {
      throw new Error('network down')
    }
    const api = loadModule(fetchFn)
    expect(() => api.prefetch('pdf')).not.toThrow()
    await new Promise((r) => setTimeout(r, 20))
  })
})

/**
 * 합성 mouseenter 게이트 (2026-11-18 미션 종료 회귀).
 * mouseenter는 마우스가 움직여 들어갈 때만 오지 않는다 — 요소가
 * 고정된 마우스 아래에 다시 나타나도 온다. 미션 종료 시 finalize가
 * dt-mission-open을 떼면 아이콘이 마우스 아래에 다시 나타나고, 그
 * 자리에 오피스 아이콘이 있으면 호버 프리패치가 시작돼 drain이 메인
 * 스레드를 90~150ms씩 막았다 (LoAF 실측 — missionClose p95 83.2ms).
 * 진짜 호버의 mouseenter는 mousemove와 같은 디스패치(~0ms)이고,
 * 합성은 마지막 mousemove로부터 최소 280ms 뒤에 온다 — 200ms 안에
 * mousemove가 없으면 프리패치를 건너뛴다.
 * 카나리아: 게이트를 빼면 첫 테스트가, once 플래그를 차단 시점에도
 * 세우면 세 번째 테스트가 실패한다.
 */
function loadModuleWithMouse(fetchFn: any): { api: any; fireMouseMove: () => void } {
  const listeners: Record<string, Array<(e?: any) => void>> = {}
  const sandbox: any = {
    window: {
      addEventListener: (type: string, cb: (e?: any) => void) => {
        ;(listeners[type] = listeners[type] || []).push(cb)
      },
    },
    navigator: { connection: { saveData: false } },
    fetch: fetchFn,
    console,
  }
  sandbox.window.navigator = sandbox.navigator
  const loadCore = new Function('window', 'navigator', 'fetch', 'console', CORE_SRC)
  loadCore(sandbox.window, sandbox.navigator, fetchFn, console)
  const fn = new Function('window', 'navigator', 'fetch', 'console', SRC)
  fn(sandbox.window, sandbox.navigator, fetchFn, console)
  return {
    api: sandbox.window.MyHubOfficePrefetch,
    fireMouseMove: () => (listeners.mousemove || []).forEach((cb) => cb({})),
  }
}

describe('office-prefetch 합성 mouseenter 게이트', () => {
  let nowSpy: any
  let nowValue = 0
  beforeEach(() => {
    nowValue = 1000000
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowValue)
  })
  afterEach(() => {
    nowSpy.mockRestore()
  })

  test('mousemove 없이 200ms가 지난 뒤의 prefetch는 fetch하지 않는다', async () => {
    let count = 0
    const fetchFn = async () => {
      count++
      return okRes()
    }
    const { api } = loadModuleWithMouse(fetchFn)
    // 로드 후 mousemove 없이 1초 경과 — 미션 종료 시 아이콘 재표시와
    // 같은 합성 mouseenter 상황이다.
    nowValue += 1000
    api.prefetch('pdf')
    await new Promise((r) => setTimeout(r, 50))
    expect(count).toBe(0)
  })

  test('mousemove 직후의 prefetch는 fetch한다 (진짜 호버)', async () => {
    const fetched: string[] = []
    const fetchFn = async (url: string) => {
      fetched.push(url)
      if (url.endsWith('manifest.json')) return jsonRes({ js: 'a.js', wasm: 'a.wasm' })
      return okRes()
    }
    const { api, fireMouseMove } = loadModuleWithMouse(fetchFn)
    nowValue += 1000
    fireMouseMove()
    api.prefetch('pdf')
    await new Promise((r) => setTimeout(r, 50))
    expect(fetched).toContain('/vendor/pdfcraft/manifest.json')
  })

  test('차단된 시도는 once 플래그를 소모하지 않는다', async () => {
    let count = 0
    const fetchFn = async (url: string) => {
      count++
      if (url.endsWith('manifest.json')) return jsonRes({ js: 'a.js', wasm: 'a.wasm' })
      return okRes()
    }
    const { api, fireMouseMove } = loadModuleWithMouse(fetchFn)
    nowValue += 1000
    api.prefetch('pdf') // 합성 — 차단돼야 한다
    await new Promise((r) => setTimeout(r, 30))
    expect(count).toBe(0)
    fireMouseMove()
    api.prefetch('pdf') // 진짜 호버 — 이번에는 데워야 한다
    await new Promise((r) => setTimeout(r, 50))
    expect(count).toBeGreaterThan(0)
  })
})
