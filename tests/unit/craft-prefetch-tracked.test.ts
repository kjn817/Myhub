/// <reference types="jest" />
/**
 * public/js/craft-prefetch-core.js — 진행 추적 프리패치 확장 단위 테스트
 * (2026-11-15 부팅 강건화).
 *
 * 고정하는 성질:
 * - fetchWithProgress: 스트림 바이트를 세어 onProgress로 보고하고,
 *   collectBody면 본문을 모아 돌려준다. 바이트가 stallTimeoutMs 동안
 *   안 오면 중단하고 재시도하며, 재시도 후 성공하면 그 결과를 쓴다.
 *   HTTP 오류(404 등)는 재시도하지 않고 즉시 reject한다.
 * - fetchSequentialTracked: URL을 순서대로 받으며, HTTP 오류는 failed에,
 *   재시도 후에도 멈춘 것은 stalled에 담고 나머지를 계속 받는다.
 *   누적 바이트를 onProgress로 보고한다.
 * - extractAssetRefs: HTML src/href와 JS 문자열 안의 상대 경로에서
 *   .js/.wasm/.css를 뽑고, 외부 출처는 제외하며, 쿼리·해시를 떼고
 *   중복을 제거한다.
 * 카나리아: stall 타이머를 무효화하면 '멈춘 뒤 재시도 성공' 테스트가
 * 타임아웃으로 실패하고, HTTP 오류 분기를 빼면 '404 재시도 없음'
 * 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..', '..')
const CORE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'craft-prefetch-core.js'), 'utf-8')

function loadCore(): any {
  const win: any = {}
  const moduleObj: any = { exports: {} }
  const fn = new Function('window', 'document', 'navigator', 'setTimeout', 'module', CORE_SRC)
  fn(win, undefined, undefined, setTimeout, moduleObj)
  return win.MyHubCraftPrefetchCore || moduleObj.exports
}

function streamRes(chunks: Uint8Array[], opts: { total?: number; stallAfter?: number } = {}): any {
  let i = 0
  return {
    ok: true,
    status: 200,
    headers: {
      get: (k: string) =>
        k === 'content-length' && opts.total !== undefined ? String(opts.total) : null,
    },
    body: {
      getReader: () => ({
        read: async () => {
          if (opts.stallAfter !== undefined && i === opts.stallAfter) {
            return new Promise(() => {}) // 영영 pending — 스톨 재현
          }
          if (i >= chunks.length) return { done: true, value: undefined }
          return { done: false, value: chunks[i++] }
        },
      }),
    },
  }
}

function textStreamRes(text: string): any {
  const bytes = new TextEncoder().encode(text)
  const half = Math.ceil(bytes.length / 2)
  return streamRes([bytes.slice(0, half), bytes.slice(half)], { total: bytes.length })
}

function bytes(n: number): Uint8Array {
  return new Uint8Array(n)
}

describe('fetchWithProgress', () => {
  test('바이트를 세어 onProgress로 보고하고 collectBody면 본문을 모은다', async () => {
    const core = loadCore()
    const progress: any[] = []
    const fetchFn = jest.fn(async () => streamRes([bytes(3), bytes(5)], { total: 8 }))
    const r = await core.fetchWithProgress(fetchFn, 'https://x.test/a.js', {
      collectBody: true,
      onProgress: (p: any) => progress.push(p),
    })
    expect(r.receivedBytes).toBe(8)
    expect(r.totalBytes).toBe(8)
    expect(r.body).toBeInstanceOf(Uint8Array)
    expect(r.body.length).toBe(8)
    expect(progress.length).toBeGreaterThanOrEqual(3) // 시작(0) + 청크 2개
    expect(progress[0].receivedBytes).toBe(0)
    expect(progress[progress.length - 1].receivedBytes).toBe(8)
  })

  test('멈춘 뒤 재시도하면 성공하고, 진행은 시도 번호와 함께 보고된다', async () => {
    const core = loadCore()
    const progress: any[] = []
    let calls = 0
    const fetchFn = jest.fn(async () => {
      calls += 1
      if (calls === 1) return streamRes([bytes(2)], { total: 4, stallAfter: 1 })
      return streamRes([bytes(4)], { total: 4 })
    })
    const r = await core.fetchWithProgress(fetchFn, 'https://x.test/b.wasm', {
      stallTimeoutMs: 50,
      maxAttempts: 3,
      retryDelayMs: 5,
      onProgress: (p: any) => progress.push(p),
    })
    expect(r.receivedBytes).toBe(4)
    expect(calls).toBe(2)
    expect(progress.some((p) => p.attempt === 2)).toBe(true)
  })

  test('HTTP 404는 재시도하지 않고 즉시 reject한다', async () => {
    const core = loadCore()
    const fetchFn = jest.fn(async () => ({ ok: false, status: 404, body: null }))
    await expect(
      core.fetchWithProgress(fetchFn, 'https://x.test/missing.js', {
        stallTimeoutMs: 50,
        maxAttempts: 3,
        retryDelayMs: 5,
      }),
    ).rejects.toThrow('http 404')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  test('재시도를 다 써도 멈추면 reject한다', async () => {
    const core = loadCore()
    const fetchFn = jest.fn(async () => streamRes([], { stallAfter: 0 }))
    await expect(
      core.fetchWithProgress(fetchFn, 'https://x.test/stuck.wasm', {
        stallTimeoutMs: 50,
        maxAttempts: 2,
        retryDelayMs: 5,
      }),
    ).rejects.toThrow('stall timeout')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})

describe('fetchSequentialTracked', () => {
  test('성공·HTTP 오류·스톨을 분류하고 나머지를 계속 받는다', async () => {
    const core = loadCore()
    const progress: any[] = []
    const fetchFn = jest.fn(async (url: string) => {
      if (url.endsWith('ok.js')) return streamRes([bytes(10)], { total: 10 })
      if (url.endsWith('missing.js')) return { ok: false, status: 404, body: null }
      return streamRes([], { stallAfter: 0 })
    })
    const r = await core.fetchSequentialTracked(
      fetchFn,
      ['https://x.test/ok.js', 'https://x.test/missing.js', 'https://x.test/stuck.wasm'],
      {
        stallTimeoutMs: 50,
        maxAttempts: 2,
        retryDelayMs: 5,
        onProgress: (p: any) => progress.push(p),
      },
    )
    expect(r.done).toEqual(['https://x.test/ok.js'])
    expect(r.failed).toEqual(['https://x.test/missing.js'])
    expect(r.stalled).toEqual(['https://x.test/stuck.wasm'])
    expect(r.receivedBytes).toBe(10)
    expect(progress.some((p) => p.filesTotal === 3)).toBe(true)
    expect(progress.some((p) => p.receivedBytes === 10)).toBe(true)
  })
})

describe('extractAssetRefs', () => {
  test('HTML src/href와 JS 문자열 경로를 뽑고 외부·중복·쿼리를 정리한다', () => {
    const core = loadCore()
    const base = 'https://myhub.test/rhwp-studio/index.html'
    const text =
      '<script src="/rhwp-studio/assets/index-abc.js"></script>' +
      '<link href="/rhwp-studio/assets/index-abc.css?v=1" rel="stylesheet">' +
      '<script src="/rhwp-studio/assets/index-abc.js"></script>' +
      'import("./canvaskit-renderer-xyz.js")' +
      '"/rhwp-studio/assets/canvaskit-abc.wasm#frag"' +
      '"https://cdn.example.com/evil.js"' +
      '"./logo.ico"'
    const refs = core.extractAssetRefs(text, base)
    expect(refs).toEqual([
      'https://myhub.test/rhwp-studio/assets/index-abc.js',
      'https://myhub.test/rhwp-studio/assets/index-abc.css',
      'https://myhub.test/rhwp-studio/canvaskit-renderer-xyz.js',
      'https://myhub.test/rhwp-studio/assets/canvaskit-abc.wasm',
    ])
  })

  test('JS 안의 절대 경로와 ./ 상대 경로를 실제 번들 형태로 뽑는다', () => {
    const core = loadCore()
    // 실제 번들 형태: new URL(`/rhwp-studio/assets/rhwp_bg-*.wasm`, ...)
    // + import(`./canvaskit-renderer-*.js`) — 둘 다 잡혀야 한다.
    const refs = core.extractAssetRefs(
      'e=new URL(`/rhwp-studio/assets/rhwp_bg-abc.wasm`,import.meta.url)' +
        'await import(`./canvaskit-renderer-xyz.js`)',
      'https://myhub.test/rhwp-studio/assets/index-abc.js',
    )
    expect(refs).toEqual([
      'https://myhub.test/rhwp-studio/assets/rhwp_bg-abc.wasm',
      'https://myhub.test/rhwp-studio/assets/canvaskit-renderer-xyz.js',
    ])
  })
})

describe('fetchWithProgress textStreamRes sanity', () => {
  test('텍스트 스트림을 collectBody로 모아 디코드할 수 있다', async () => {
    const core = loadCore()
    const fetchFn = jest.fn(async () => textStreamRes('hello world'))
    const r = await core.fetchWithProgress(fetchFn, 'https://x.test/t.html', {
      collectBody: true,
    })
    expect(new TextDecoder().decode(r.body)).toBe('hello world')
  })
})
