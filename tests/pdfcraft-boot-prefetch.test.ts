/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * PdfCraft 부팅 게이트 프리패치 (2026-11-15 부팅 강건화).
 *
 * 배경: 카페에서 PDF가 45초 ready 워치독에 걸려 메뉴 없는 뷰어로
 * 폴백했다 — 47MB를 45초 안에 못 받으면 단발 폴백으로 끝났다.
 * 1dc37bf가 한글·PPT·엑셀에 적용한 패턴을 PDF에도 적용한다:
 * createHost는 iframe src를 붙이기 전에 엔진 자산을 프리패치로 받아
 * 캐시를 데우고, 워치독은 src를 붙인 시점부터 돈다. 프리패치가
 * 실패하면 재시도하고 전부 실패할 때만 폴백('prefetch-failed')으로 간다.
 *
 * 2차 원인 (2026-11-15 실측): 게이트가 받아도 23MB 조각은 HTTP 캐시에
 * 안 남아(동일 문서 재-fetch도 transferSize 전문) 로더가 47MB를 다시
 * 받아 45초 워치독이 또 터졌다. 그래서 게이트는 조각 바이트를 모아
 * Blob URL로 엔진에 넘기고(쿼리 wasmPart0/wasmPart1), CacheStorage에
 * 저장해 다음 부팅은 네트워크를 안 탄다.
 *
 * 검증 성질:
 * - 프리패치가 끝나기 전에는 frame.src가 비어 있고, 완료 후에 붙는다.
 * - 프리패치 3회 실패 시 onFallback('prefetch-failed')이 불리고 src가
 *   안 붙는다 (단발 폴백이 아니라 재시도 후 최종 실패 시에만).
 * - 2번째 프리패치 시도에서 성공하면 src가 붙고 폴백이 안 불린다.
 * - onBootProgress가 진행(바이트·시도)을 보고한다.
 * - 워치독은 src를 붙인 시점부터 돈다: 프리패치가 readyTimeoutMs보다
 *   오래 걸려도 폴백이 안 터지고, src 부착 뒤에 ready가 없으면 그때
 *   터진다 (핵심 회귀 — 구 코드는 createHost 시점부터 45초를 셌다).
 * - destroy() 도중 프리패치가 끝나도 src가 안 붙고 폴백이 안 불린다.
 * - 모듈 prefetchForBoot: 매니페스트를 읽어 진입 에셋(js·wasmParts·
 *   loader·snippets)을 받고, 단일 wasm(47MB)은 받지 않는다.
 * - wasm 파트가 멈추면 reject한다.
 * - 게이트가 모은 파트 바이트는 Blob URL로 바꿔 src 쿼리
 *   (wasmPart0/wasmPart1)로 넘긴다 — 로더가 네트워크에서 다시
 *   받지 않게 한다.
 * - ready·destroy 때 Blob URL을 해제한다; 생성 실패 시 쿼리 없이
 *   부팅한다 (로더가 네트워크에서 받으므로 느리지만 동작한다).
 * - 모듈 prefetchForBoot는 파트 바이트를 partBytes로 돌려주고
 *   CacheStorage에 저장해, 두 번째 부팅은 파트를 네트워크로 안 받는다.
 * - CacheStorage 조회가 실패하면 네트워크로 폴백하고, 오래된 버전의
 *   파트는 캐시에서 치운다.
 * - 같은 파트를 동시에 받는 호출은 네트워크를 한 번만 탄다
 *   (인플라이트 공유 — 백그라운드 프리패치와 게이트가 겹치는 경우).
 *
 * 카나리아: runBootPrefetch에서 src 설정을 빼면 첫 테스트가 실패하고,
 * 워치독을 createHost 시점으로 되돌리면 다섯 번째 테스트가 실패하며,
 * manifestAssetUrls 옵션에 wasm을 넣으면 단일 wasm 테스트가 실패한다.
 * Blob URL 쿼리 생성을 빼면 핸드오프 테스트가, CacheStorage 저장을
 * 빼면 두 번째 부팅 테스트가, 인플라이트 공유를 빼면 동시 호출
 * 테스트가 실패한다.
 */
import * as fs from 'fs';
import * as path from 'path';
import { TextDecoder, TextEncoder } from 'util';

// jsdom 환경에는 TextEncoder/TextDecoder 전역이 없다 — 모듈 코드의
// new TextDecoder()와 테스트의 텍스트 스트림 가짜가 쓴다.
if (typeof (globalThis as any).TextEncoder === 'undefined') {
  (globalThis as any).TextEncoder = TextEncoder;
}
if (typeof (globalThis as any).TextDecoder === 'undefined') {
  (globalThis as any).TextDecoder = TextDecoder;
}

const ROOT = path.resolve(__dirname, '..');
const CORE_JS = fs.readFileSync(path.join(ROOT, 'public/js/craft-prefetch-core.js'), 'utf-8');
const BRIDGE_JS = fs.readFileSync(path.join(ROOT, 'public/js/finder-pdfcraft.js'), 'utf-8');

const getWin = (): any => (globalThis as any).window;
const getDoc = (): any => (globalThis as any).document;

function flush(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn: () => boolean, timeoutMs = 3000, stepMs = 20) {
  const start = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await flush(stepMs);
  }
}

function loadPdf(loadCore = false) {
  const win = getWin();
  const doc = getDoc();
  doc.body.innerHTML = '<div id="host-parent"></div>';
  if (loadCore) new Function('window', 'document', CORE_JS)(win, doc);
  new Function('window', 'document', BRIDGE_JS)(win, doc);
  return { win, doc, api: win.MyHubFinderPdfCraft };
}

function makeHost(api: any, doc: any, win: any, extra: any = {}) {
  const onFallback = jest.fn();
  const onBootProgress = jest.fn();
  const fetchFn = jest.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(8),
  }));
  const host: any = api.createHost({
    doc,
    win,
    parentEl: doc.getElementById('host-parent'),
    fetchFn,
    readyTimeoutMs: 45000,
    bootMaxAttempts: 3,
    bootRetryDelayMs: 5,
    onFallback,
    onBootProgress,
    ...extra,
  });
  return { host, onFallback, onBootProgress, fetchFn };
}

describe('pdfcraft 호스트 URL', () => {
  test('APP_URL_HOSTED는 chrome 벗김 없이 APP_URL과 같다 (2026-11-21 공식 레이아웃 결정)', () => {
    const { api } = loadPdf();
    // 오피스도 Finder와 같은 전체 레이아웃을 쓴다 — 모드 탭·메뉴 바·
    // 모든 도구 사이드바를 엔진이 직접 그린다. chrome 플래그를 다시
    // 붙이면 오피스 PDF가 벗겨진 화면으로 돌아간다.
    expect(api.APP_URL_HOSTED).toBe(api.APP_URL);
    expect(api.APP_URL_HOSTED).not.toContain('chrome=');
    expect(api.APP_URL_HOSTED).toContain('host=parent');
  });
});

describe('pdfcraft 부팅 게이트 프리패치', () => {
  test('프리패치가 끝나기 전에는 src가 비어 있고 완료 후에 붙는다', async () => {
    const { win, doc, api } = loadPdf();
    let resolvePrefetch: any;
    const prefetchForBoot = jest.fn(
      () =>
        new Promise((resolve) => {
          resolvePrefetch = resolve;
        }),
    );
    const { host } = makeHost(api, doc, win, { prefetchForBoot });
    try {
      await flush(20);
      expect(prefetchForBoot).toHaveBeenCalledTimes(1);
      expect(host.frame.getAttribute('src')).toBeNull();
      resolvePrefetch({ done: [], failed: [], stalled: [], receivedBytes: 0 });
      const attached = await waitFor(() => !!host.frame.getAttribute('src'));
      expect(attached).toBe(true);
      expect(host.frame.getAttribute('src')).toContain('/vendor/pdfcraft/');
    } finally {
      host.destroy();
    }
  });

  test('프리패치 3회 실패 시에만 폴백이 불리고 src가 안 붙는다', async () => {
    const { win, doc, api } = loadPdf();
    const prefetchForBoot = jest.fn(() => Promise.reject(new Error('stall')));
    const { host, onFallback } = makeHost(api, doc, win, { prefetchForBoot });
    try {
      const fired = await waitFor(() => onFallback.mock.calls.length > 0);
      expect(fired).toBe(true);
      expect(onFallback).toHaveBeenCalledWith('prefetch-failed');
      expect(prefetchForBoot).toHaveBeenCalledTimes(3);
      expect(host.frame.getAttribute('src')).toBeNull();
    } finally {
      host.destroy();
    }
  });

  test('2번째 프리패치 시도에서 성공하면 src가 붙고 폴백이 안 불린다', async () => {
    const { win, doc, api } = loadPdf();
    const prefetchForBoot = jest
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error('stall')))
      .mockImplementationOnce(() =>
        Promise.resolve({ done: [], failed: [], stalled: [], receivedBytes: 0 }),
      );
    const { host, onFallback } = makeHost(api, doc, win, { prefetchForBoot });
    try {
      const attached = await waitFor(() => !!host.frame.getAttribute('src'));
      expect(attached).toBe(true);
      expect(prefetchForBoot).toHaveBeenCalledTimes(2);
      expect(onFallback).not.toHaveBeenCalled();
    } finally {
      host.destroy();
    }
  });

  test('onBootProgress가 진행(바이트·시도)을 보고한다', async () => {
    const { win, doc, api } = loadPdf();
    const prefetchForBoot = jest.fn((opts: any) => {
      opts.onProgress({
        receivedBytes: 3 * 1048576,
        filesDone: 1,
        filesTotal: 4,
        currentUrl: 'https://x.test/a.wasm.part0',
        attempt: 1,
      });
      return Promise.resolve({ done: [], failed: [], stalled: [], receivedBytes: 3 * 1048576 });
    });
    const { host, onBootProgress } = makeHost(api, doc, win, { prefetchForBoot });
    try {
      const attached = await waitFor(() => !!host.frame.getAttribute('src'));
      expect(attached).toBe(true);
      expect(onBootProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          receivedBytes: 3 * 1048576,
          filesDone: 1,
          filesTotal: 4,
          attempt: 1,
          maxAttempts: 3,
        }),
      );
    } finally {
      host.destroy();
    }
  });

  test('워치독은 src를 붙인 시점부터 돈다 (프리패치 시간은 안 센다)', async () => {
    const { win, doc, api } = loadPdf();
    // ready 타임아웃 60ms보다 프리패치가 3배 오래 걸려도 폴백이
    // 안 터져야 한다 — 구 코드는 여기서 'timeout'으로 폴백했다.
    const prefetchForBoot = jest.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ done: [], failed: [], stalled: [], receivedBytes: 0 }),
            180,
          ),
        ),
    );
    const { host, onFallback } = makeHost(api, doc, win, {
      prefetchForBoot,
      readyTimeoutMs: 60,
    });
    try {
      await flush(120);
      expect(onFallback).not.toHaveBeenCalled();
      expect(host.frame.getAttribute('src')).toBeNull();
      const attached = await waitFor(() => !!host.frame.getAttribute('src'));
      expect(attached).toBe(true);
      // src 부착 뒤 ready가 오지 않으면 워치독이 터진다.
      const fired = await waitFor(() => onFallback.mock.calls.length > 0);
      expect(fired).toBe(true);
      expect(onFallback).toHaveBeenCalledWith('timeout');
    } finally {
      host.destroy();
    }
  });

  test('destroy() 도중 프리패치가 끝나도 src가 안 붙고 폴백이 안 불린다', async () => {
    const { win, doc, api } = loadPdf();
    let resolvePrefetch: any;
    const prefetchForBoot = jest.fn(
      () =>
        new Promise((resolve) => {
          resolvePrefetch = resolve;
        }),
    );
    const { host, onFallback } = makeHost(api, doc, win, { prefetchForBoot });
    await flush(20);
    host.destroy();
    resolvePrefetch({ done: [], failed: [], stalled: [], receivedBytes: 0 });
    await flush(30);
    expect(host.frame.getAttribute('src')).toBeNull();
    expect(onFallback).not.toHaveBeenCalled();
  });

  test('게이트가 모은 파트 바이트를 Blob URL로 src 쿼리에 넘긴다', async () => {
    const { win, doc, api } = loadPdf();
    const createObjectURL = jest
      .fn()
      .mockReturnValueOnce('blob:part0')
      .mockReturnValueOnce('blob:part1');
    const prefetchForBoot = jest.fn(() =>
      Promise.resolve({
        done: [],
        failed: [],
        stalled: [],
        receivedBytes: 0,
        partBytes: [new Uint8Array([1, 2]), new Uint8Array([3, 4])],
      }),
    );
    const { host } = makeHost(api, doc, win, { prefetchForBoot, createObjectURL });
    try {
      const attached = await waitFor(() => !!host.frame.getAttribute('src'));
      expect(attached).toBe(true);
      const src = host.frame.getAttribute('src');
      expect(src).toContain('wasmPart0=blob%3Apart0');
      expect(src).toContain('wasmPart1=blob%3Apart1');
      expect(createObjectURL).toHaveBeenCalledTimes(2);
    } finally {
      host.destroy();
    }
  });

  test('ready가 오면 Blob URL을 해제한다', async () => {
    const { win, doc, api } = loadPdf();
    const createObjectURL = jest
      .fn()
      .mockReturnValueOnce('blob:part0')
      .mockReturnValueOnce('blob:part1');
    const revokeObjectURL = jest.fn();
    const prefetchForBoot = jest.fn(() =>
      Promise.resolve({
        done: [],
        failed: [],
        stalled: [],
        receivedBytes: 0,
        partBytes: [new Uint8Array([1]), new Uint8Array([2])],
      }),
    );
    const { host } = makeHost(api, doc, win, { prefetchForBoot, createObjectURL, revokeObjectURL });
    try {
      const attached = await waitFor(() => !!host.frame.getAttribute('src'));
      expect(attached).toBe(true);
      expect(revokeObjectURL).not.toHaveBeenCalled();
      win.dispatchEvent(
        new win.MessageEvent('message', {
          data: { type: 'pdfcraft:ready', version: '0.21.1' },
          origin: win.location.origin,
        }),
      );
      await flush(10);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:part0');
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:part1');
    } finally {
      host.destroy();
    }
  });

  test('destroy하면 Blob URL을 해제한다', async () => {
    const { win, doc, api } = loadPdf();
    const createObjectURL = jest
      .fn()
      .mockReturnValueOnce('blob:part0')
      .mockReturnValueOnce('blob:part1');
    const revokeObjectURL = jest.fn();
    const prefetchForBoot = jest.fn(() =>
      Promise.resolve({
        done: [],
        failed: [],
        stalled: [],
        receivedBytes: 0,
        partBytes: [new Uint8Array([1]), new Uint8Array([2])],
      }),
    );
    const { host } = makeHost(api, doc, win, { prefetchForBoot, createObjectURL, revokeObjectURL });
    const attached = await waitFor(() => !!host.frame.getAttribute('src'));
    expect(attached).toBe(true);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    host.destroy();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:part0');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:part1');
  });

  test('Blob URL 생성이 실패하면 쿼리 없이 부팅한다', async () => {
    const { win, doc, api } = loadPdf();
    const createObjectURL = jest.fn(() => {
      throw new Error('no blob');
    });
    const prefetchForBoot = jest.fn(() =>
      Promise.resolve({
        done: [],
        failed: [],
        stalled: [],
        receivedBytes: 0,
        partBytes: [new Uint8Array([1]), new Uint8Array([2])],
      }),
    );
    const { host, onFallback } = makeHost(api, doc, win, { prefetchForBoot, createObjectURL });
    try {
      const attached = await waitFor(() => !!host.frame.getAttribute('src'));
      expect(attached).toBe(true);
      const src = host.frame.getAttribute('src');
      expect(src).toContain('/vendor/pdfcraft/');
      expect(src).not.toContain('wasmPart');
      expect(onFallback).not.toHaveBeenCalled();
    } finally {
      host.destroy();
    }
  });
});

describe('pdfcraft 모듈 prefetchForBoot', () => {
  function textStreamRes(text: string): any {
    const bytes = new TextEncoder().encode(text);
    let i = 0;
    const chunks = [bytes.slice(0, Math.ceil(bytes.length / 2)), bytes.slice(Math.ceil(bytes.length / 2))];
    return {
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k === 'content-length' ? String(bytes.length) : null) },
      body: {
        getReader: () => ({
          read: async () => {
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[i++] };
          },
        }),
      },
    };
  }
  function binaryRes(size: number, stall = false): any {
    return {
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k === 'content-length' ? String(size) : null) },
      body: {
        getReader: () => ({
          read: async () => {
            if (stall) return new Promise(() => {});
            return { done: true, value: undefined };
          },
        }),
      },
    };
  }
  // 실제 바이트를 두 청크로 내는 응답 — partBytes 내용 검증용.
  function chunkedRes(bytes: Uint8Array): any {
    const half = Math.ceil(bytes.length / 2);
    const chunks = [bytes.slice(0, half), bytes.slice(half)];
    let i = 0;
    return {
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k === 'content-length' ? String(bytes.length) : null) },
      body: {
        getReader: () => ({
          read: async () => {
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[i++] };
          },
        }),
      },
    };
  }
  // jsdom에는 Response 전역이 없어 storePart가 건너뛰므로, CacheStorage
  // 테스트에서는 이 가짜를 전역에 설치한다 (실제 Response와 같은
  // 생성자·arrayBuffer 계약).
  class FakeResponse {
    private body: Uint8Array;
    constructor(body?: any) {
      this.body = body instanceof Uint8Array ? body : new Uint8Array(body || 0);
    }
    async arrayBuffer(): Promise<ArrayBuffer> {
      const b = this.body;
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    }
  }
  function installFakeResponse() {
    const prev = (globalThis as any).Response;
    (globalThis as any).Response = FakeResponse;
    return () => {
      if (prev === undefined) delete (globalThis as any).Response;
      else (globalThis as any).Response = prev;
    };
  }
  // CacheStorage 가짜: 이름별 Map 저장소 + 호출 카운터.
  function makeFakeCaches(): any {
    const stores = new Map<string, Map<string, any>>();
    const calls = { open: 0, match: 0, put: 0, keys: 0, delete: 0 };
    return {
      calls,
      open: async (name: string) => {
        calls.open += 1;
        if (!stores.has(name)) stores.set(name, new Map());
        const store = stores.get(name)!;
        return {
          match: async (url: string) => {
            calls.match += 1;
            return store.get(url);
          },
          put: async (url: string, res: any) => {
            calls.put += 1;
            store.set(url, res);
          },
          keys: async () => {
            calls.keys += 1;
            return [...store.keys()].map((u) => ({ url: u }));
          },
          delete: async (req: any) => {
            calls.delete += 1;
            const u = typeof req === 'string' ? req : req.url;
            return store.delete(u);
          },
        };
      },
    };
  }

  test('매니페스트를 읽어 진입 에셋을 받고 단일 wasm은 받지 않는다', async () => {
    const { win, api } = loadPdf(true);
    const log: string[] = [];
    const manifest = {
      js: 'pdfcraft-web-abc.js',
      wasm: 'pdfcraft-web-abc_bg.wasm',
      wasmParts: ['pdfcraft-web-abc_bg.wasm.part0', 'pdfcraft-web-abc_bg.wasm.part1'],
      files: ['loader.js', 'snippets/eframe-1/inline0.js', 'index.html'],
    };
    const fetchFn = jest.fn(async (url: string) => {
      log.push(String(url));
      if (String(url).includes('manifest.json')) return textStreamRes(JSON.stringify(manifest));
      return binaryRes(100);
    });
    const r = await api.prefetchForBoot({ fetchFn, win });
    expect(r.stalled).toEqual([]);
    expect(log.some((u) => u.includes('pdfcraft-web-abc.js'))).toBe(true);
    expect(log.some((u) => u.includes('pdfcraft-web-abc_bg.wasm.part0'))).toBe(true);
    expect(log.some((u) => u.includes('pdfcraft-web-abc_bg.wasm.part1'))).toBe(true);
    expect(log.some((u) => u.includes('loader.js'))).toBe(true);
    expect(log.some((u) => u.includes('snippets/eframe-1/inline0.js'))).toBe(true);
    // 단일 wasm(47MB)까지 받으면 47MB를 더 받는 회귀다 — 파트 URL은
    // 단일 wasm명을 접두사로 포함하므로 정확히 끝나는 URL로만 판정한다.
    expect(log.some((u) => u.endsWith('/pdfcraft-web-abc_bg.wasm'))).toBe(false);
  });

  test('wasm 파트가 멈추면 reject한다', async () => {
    const { win, api } = loadPdf(true);
    const manifest = {
      js: 'pdfcraft-web-abc.js',
      wasm: 'pdfcraft-web-abc_bg.wasm',
      wasmParts: ['pdfcraft-web-abc_bg.wasm.part0', 'pdfcraft-web-abc_bg.wasm.part1'],
    };
    const fetchFn = jest.fn(async (url: string) => {
      if (String(url).includes('manifest.json')) return textStreamRes(JSON.stringify(manifest));
      if (String(url).endsWith('.wasm.part0')) return binaryRes(100, true);
      return binaryRes(100);
    });
    await expect(
      api.prefetchForBoot({ fetchFn, win, stallTimeoutMs: 50, maxAttempts: 2, retryDelayMs: 5 }),
    ).rejects.toThrow('멈춤');
  });

  test('파트 바이트를 모아 partBytes로 돌려주고 done은 매니페스트 순서다', async () => {
    const { win, api } = loadPdf(true);
    const manifest = {
      js: 'pdfcraft-web-abc.js',
      wasm: 'pdfcraft-web-abc_bg.wasm',
      wasmParts: ['pdfcraft-web-abc_bg.wasm.part0', 'pdfcraft-web-abc_bg.wasm.part1'],
      files: ['loader.js', 'snippets/eframe-1/inline0.js'],
    };
    const part0 = new Uint8Array([1, 2, 3, 4]);
    const part1 = new Uint8Array([5, 6, 7]);
    const fetchFn = jest.fn(async (url: string) => {
      if (String(url).includes('manifest.json')) return textStreamRes(JSON.stringify(manifest));
      if (String(url).endsWith('.wasm.part0')) return chunkedRes(part0);
      if (String(url).endsWith('.wasm.part1')) return chunkedRes(part1);
      return binaryRes(100);
    });
    const r = await api.prefetchForBoot({ fetchFn, win });
    expect(r.stalled).toEqual([]);
    expect(r.partBytes).toHaveLength(2);
    expect(Array.from(r.partBytes[0])).toEqual([1, 2, 3, 4]);
    expect(Array.from(r.partBytes[1])).toEqual([5, 6, 7]);
    expect(r.receivedBytes).toBe(7);
    expect(r.done).toEqual([
      '/vendor/pdfcraft/pdfcraft-web-abc.js',
      '/vendor/pdfcraft/pdfcraft-web-abc_bg.wasm.part0',
      '/vendor/pdfcraft/pdfcraft-web-abc_bg.wasm.part1',
      '/vendor/pdfcraft/loader.js',
      '/vendor/pdfcraft/snippets/eframe-1/inline0.js',
    ]);
  });

  test('두 번째 부팅은 CacheStorage에서 파트를 읽어 네트워크를 안 탄다', async () => {
    const { win, api } = loadPdf(true);
    const restore = installFakeResponse();
    try {
      const caches = makeFakeCaches();
      const manifest = {
        js: 'pdfcraft-web-abc.js',
        wasm: 'pdfcraft-web-abc_bg.wasm',
        wasmParts: ['pdfcraft-web-abc_bg.wasm.part0', 'pdfcraft-web-abc_bg.wasm.part1'],
      };
      let partFetches = 0;
      const fetchFn = jest.fn(async (url: string) => {
        if (String(url).includes('manifest.json')) return textStreamRes(JSON.stringify(manifest));
        if (String(url).endsWith('.wasm.part0')) {
          partFetches += 1;
          return chunkedRes(new Uint8Array([1, 2, 3, 4]));
        }
        if (String(url).endsWith('.wasm.part1')) {
          partFetches += 1;
          return chunkedRes(new Uint8Array([5, 6, 7]));
        }
        return binaryRes(100);
      });
      const r1 = await api.prefetchForBoot({ fetchFn, win, caches });
      expect(partFetches).toBe(2);
      expect(r1.partBytes).toHaveLength(2);
      expect(caches.calls.put).toBe(2);
      partFetches = 0;
      const r2 = await api.prefetchForBoot({ fetchFn, win, caches });
      expect(partFetches).toBe(0);
      expect(r2.partBytes).toHaveLength(2);
      expect(Array.from(r2.partBytes[0])).toEqual([1, 2, 3, 4]);
      expect(Array.from(r2.partBytes[1])).toEqual([5, 6, 7]);
    } finally {
      restore();
    }
  });

  test('CacheStorage 조회가 실패하면 네트워크로 폴백한다', async () => {
    const { win, api } = loadPdf(true);
    const caches = { open: async () => { throw new Error('cache blocked'); } };
    const manifest = {
      js: 'pdfcraft-web-abc.js',
      wasm: 'pdfcraft-web-abc_bg.wasm',
      wasmParts: ['pdfcraft-web-abc_bg.wasm.part0', 'pdfcraft-web-abc_bg.wasm.part1'],
    };
    const fetchFn = jest.fn(async (url: string) => {
      if (String(url).includes('manifest.json')) return textStreamRes(JSON.stringify(manifest));
      if (String(url).endsWith('.wasm.part0')) return chunkedRes(new Uint8Array([1, 2, 3, 4]));
      if (String(url).endsWith('.wasm.part1')) return chunkedRes(new Uint8Array([5, 6, 7]));
      return binaryRes(100);
    });
    const r = await api.prefetchForBoot({ fetchFn, win, caches });
    expect(r.partBytes).toHaveLength(2);
    expect(Array.from(r.partBytes[0])).toEqual([1, 2, 3, 4]);
  });

  test('오래된 버전의 파트는 CacheStorage에서 치운다', async () => {
    const { win, api } = loadPdf(true);
    const restore = installFakeResponse();
    try {
      const caches = makeFakeCaches();
      const oldUrl = new URL(
        '/vendor/pdfcraft/pdfcraft-web-old_bg.wasm.part0',
        win.location.href,
      ).href;
      const store = await caches.open('myhub-pdfcraft-parts');
      await store.put(oldUrl, new FakeResponse(new Uint8Array([9])));
      const manifest = {
        js: 'pdfcraft-web-abc.js',
        wasm: 'pdfcraft-web-abc_bg.wasm',
        wasmParts: ['pdfcraft-web-abc_bg.wasm.part0', 'pdfcraft-web-abc_bg.wasm.part1'],
      };
      const fetchFn = jest.fn(async (url: string) => {
        if (String(url).includes('manifest.json')) return textStreamRes(JSON.stringify(manifest));
        if (String(url).endsWith('.wasm.part0')) return chunkedRes(new Uint8Array([1]));
        if (String(url).endsWith('.wasm.part1')) return chunkedRes(new Uint8Array([2]));
        return binaryRes(100);
      });
      const r = await api.prefetchForBoot({ fetchFn, win, caches });
      expect(r.partBytes).toHaveLength(2);
      const keys = await (await caches.open('myhub-pdfcraft-parts')).keys();
      const urls = keys.map((k: any) => k.url);
      expect(urls).not.toContain(oldUrl);
      expect(urls.some((u: string) => u.endsWith('.wasm.part0'))).toBe(true);
      expect(urls.some((u: string) => u.endsWith('.wasm.part1'))).toBe(true);
    } finally {
      restore();
    }
  });

  test('같은 파트를 동시에 받는 호출은 네트워크를 한 번만 탄다', async () => {
    const { win, api } = loadPdf(true);
    const manifest = {
      js: 'pdfcraft-web-abc.js',
      wasm: 'pdfcraft-web-abc_bg.wasm',
      wasmParts: ['pdfcraft-web-abc_bg.wasm.part0', 'pdfcraft-web-abc_bg.wasm.part1'],
    };
    let partCalls = 0;
    const fetchFn = jest.fn(async (url: string) => {
      if (String(url).includes('manifest.json')) return textStreamRes(JSON.stringify(manifest));
      if (String(url).endsWith('.wasm.part0') || String(url).endsWith('.wasm.part1')) {
        partCalls += 1;
        // 두 호출이 겹치게 파트 fetch를 30ms 붙잡는다.
        await flush(30);
        return chunkedRes(new Uint8Array([1]));
      }
      return binaryRes(100);
    });
    const p1 = api.prefetchForBoot({ fetchFn, win });
    const p2 = api.prefetchForBoot({ fetchFn, win });
    const [r1, r2] = await Promise.all([p1, p2]);
    // 파트 URL마다 1번씩 — 공유가 없으면 4번이다.
    expect(partCalls).toBe(2);
    expect(r1.partBytes).toHaveLength(2);
    expect(r2.partBytes).toHaveLength(2);
  });
});
