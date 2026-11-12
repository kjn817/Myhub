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

function loadModule(fetchFn: any, saveData = false): any {
  const sandbox: any = {
    window: {},
    navigator: { connection: { saveData } },
    fetch: fetchFn,
    console,
  }
  sandbox.window.navigator = sandbox.navigator
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
