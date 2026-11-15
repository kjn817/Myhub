/// <reference types="jest" />
/**
 * public/js/rhwp-prefetch.js — Rhwp 스튜디오 자산 프리패치 단위 테스트
 * (2026-11-15 부팅 강건화).
 *
 * 고정하는 성질:
 * - discoverTracked: index.html의 src/href에서 JS·CSS를 읽고, JS 본문
 *   안에서 중첩 참조(.wasm·청크 JS)를 2단계까지 따라가 5개 에셋을
 *   찾는다. 발견용으로 받은 JS 본문은 warmed에 들어가 워밍에서 빠진다.
 * - prefetchForBoot: 발견 + 워밍을 진행 보고와 함께 수행하고, 워밍은
 *   이미 받은 JS를 다시 받지 않는다. 멈춘 파일이 남으면 reject한다.
 * - prefetch: 백그라운드용 — 한 번만 돌고(once 플래그) 실패를 삼킨다.
 * 카나리아: 발견 깊이를 1로 줄이면 중첩 wasm 테스트가 실패하고,
 * warmed 제외를 빼면 'JS를 다시 받지 않는다' 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..', '..')
const CORE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'craft-prefetch-core.js'), 'utf-8')
const RHWP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'rhwp-prefetch.js'), 'utf-8')

const SHELL_HTML =
  '<script src="/rhwp-studio/assets/index-abc.js"></script>' +
  '<link href="/rhwp-studio/assets/index-abc.css" rel="stylesheet">' +
  '<script src="/rhwp-studio/theme-init.js"></script>'
const BUNDLE_JS =
  'e=new URL(`/rhwp-studio/assets/rhwp_bg-abc.wasm`,import.meta.url);' +
  'await import(`./canvaskit-renderer-xyz.js`)'
const RENDERER_JS = 'x=`/rhwp-studio/assets/canvaskit-abc.wasm`'
const THEME_JS = '/* theme init, no refs */'

function textStreamRes(text: string): any {
  const bytes = new TextEncoder().encode(text)
  let i = 0
  const chunks = [bytes.slice(0, Math.ceil(bytes.length / 2)), bytes.slice(Math.ceil(bytes.length / 2))]
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k === 'content-length' ? String(bytes.length) : null) },
    body: {
      getReader: () => ({
        read: async () => {
          if (i >= chunks.length) return { done: true, value: undefined }
          return { done: false, value: chunks[i++] }
        },
      }),
    },
  }
}

function binaryRes(size: number, stall = false): any {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k === 'content-length' ? String(size) : null) },
    body: {
      getReader: () => ({
        read: async () => {
          if (stall) return new Promise(() => {})
          return { done: true, value: undefined }
        },
      }),
    },
  }
}

function loadRhwp(): any {
  const win: any = { location: { origin: 'https://myhub.test' } }
  const moduleObj: any = { exports: {} }
  for (const src of [CORE_SRC, RHWP_SRC]) {
    const fn = new Function('window', 'document', 'navigator', 'setTimeout', 'console', 'module', src)
    fn(win, undefined, undefined, setTimeout, console, moduleObj)
  }
  return win.MyHubRhwpPrefetch
}

function fakeFetch(files: Record<string, () => any>, log: string[]) {
  return async (url: string) => {
    log.push(url)
    const key = url.replace(/^https:\/\/myhub\.test/, '')
    const make = files[key]
    if (!make) return { ok: false, status: 404, body: null }
    return make()
  }
}

const BASE_FILES: Record<string, () => any> = {
  '/rhwp-studio/index.html': () => textStreamRes(SHELL_HTML),
  '/rhwp-studio/assets/index-abc.js': () => textStreamRes(BUNDLE_JS),
  '/rhwp-studio/assets/index-abc.css': () => binaryRes(113000),
  '/rhwp-studio/theme-init.js': () => textStreamRes(THEME_JS),
  '/rhwp-studio/assets/rhwp_bg-abc.wasm': () => binaryRes(11800000),
  '/rhwp-studio/assets/canvaskit-renderer-xyz.js': () => textStreamRes(RENDERER_JS),
  '/rhwp-studio/assets/canvaskit-abc.wasm': () => binaryRes(7300000),
}

describe('rhwp discoverTracked', () => {
  test('2단계 발견으로 5개 에셋을 찾고 JS는 warmed에 들어간다', async () => {
    const rhwp = loadRhwp()
    const log: string[] = []
    const fetchFn = fakeFetch(BASE_FILES, log)
    const found = await rhwp.discoverTracked(fetchFn, {})
    expect(found.assets.sort()).toEqual(
      [
        'https://myhub.test/rhwp-studio/assets/index-abc.js',
        'https://myhub.test/rhwp-studio/assets/index-abc.css',
        'https://myhub.test/rhwp-studio/theme-init.js',
        'https://myhub.test/rhwp-studio/assets/rhwp_bg-abc.wasm',
        'https://myhub.test/rhwp-studio/assets/canvaskit-renderer-xyz.js',
        'https://myhub.test/rhwp-studio/assets/canvaskit-abc.wasm',
      ].sort(),
    )
    // 발견용으로 본문을 받은 JS는 warmed — 워밍에서 다시 받지 않는다.
    expect(found.warmed.sort()).toEqual(
      [
        'https://myhub.test/rhwp-studio/assets/index-abc.js',
        'https://myhub.test/rhwp-studio/theme-init.js',
        'https://myhub.test/rhwp-studio/assets/canvaskit-renderer-xyz.js',
      ].sort(),
    )
    expect(found.receivedBytes).toBeGreaterThan(0)
  })
})

describe('rhwp prefetchForBoot', () => {
  test('발견+워밍을 수행하고 이미 받은 JS는 다시 받지 않는다', async () => {
    const rhwp = loadRhwp()
    const log: string[] = []
    const progress: any[] = []
    const fetchFn = fakeFetch(BASE_FILES, log)
    const r = await rhwp.prefetchForBoot({
      fetchFn,
      win: { fetch: fetchFn },
      onProgress: (p: any) => progress.push(p),
    })
    expect(r.stalled).toEqual([])
    expect(r.failed).toEqual([])
    // 워밍 대상은 JS를 뺀 CSS+WASM 3개 — JS는 발견 때 이미 받았다.
    const jsFetches = log.filter((u) => u.endsWith('.js'))
    expect(jsFetches).toHaveLength(3) // 발견 3회, 워밍 재요청 0회
    expect(log.filter((u) => u.endsWith('.wasm'))).toHaveLength(2)
    expect(progress.some((p) => p.phase === 'discover')).toBe(true)
    expect(progress.some((p) => p.phase === 'warm')).toBe(true)
  })

  test('wasm이 멈추면 reject한다', async () => {
    const rhwp = loadRhwp()
    const log: string[] = []
    const files = {
      ...BASE_FILES,
      '/rhwp-studio/assets/rhwp_bg-abc.wasm': () => binaryRes(11800000, true),
    }
    const fetchFn = fakeFetch(files, log)
    await expect(
      rhwp.prefetchForBoot({
        fetchFn,
        win: { fetch: fetchFn },
        stallTimeoutMs: 50,
        maxAttempts: 2,
        retryDelayMs: 5,
      }),
    ).rejects.toThrow('멈춤')
  })
})

describe('rhwp prefetch (백그라운드)', () => {
  test('두 번째 호출은 플래그 때문에 다시 받지 않는다', async () => {
    const rhwp = loadRhwp()
    const log: string[] = []
    const fetchFn = fakeFetch(BASE_FILES, log)
    // 같은 win을 두 번 넘긴다 — 플래그는 win에 붙는다.
    const win = { fetch: fetchFn, location: { origin: 'https://myhub.test' } }
    const first = await rhwp.prefetch({ fetchFn, win })
    expect(first.length).toBeGreaterThan(0)
    const countAfterFirst = log.length
    const second = await rhwp.prefetch({ fetchFn, win })
    expect(second).toEqual([])
    expect(log.length).toBe(countAfterFirst)
  })
})
