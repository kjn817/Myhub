/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * DeckCraft 부팅 게이트 프리패치 (2026-11-15 부팅 강건화).
 *
 * 배경: 카페에서 PPT 로딩이 60초 ready 워치독에 걸려 실패했다 —
 * 22MB를 60초 안에 못 받으면 단발 폴백으로 끝났다. 이제 createHost는
 * iframe src를 붙이기 전에 엔진 자산을 프리패치로 받아 캐시를 데우고,
 * 워치독은 src를 붙인 시점부터 돈다. 프리패치가 실패하면 재시도하고
 * 전부 실패할 때만 폴백('prefetch-failed')으로 간다.
 *
 * 검증 성질:
 * - 프리패치가 끝나기 전에는 frame.src가 비어 있고, 완료 후에 붙는다.
 * - 프리패치 3회 실패 시 onFallback('prefetch-failed')이 불리고 src가
 *   안 붙는다 (단발 폴백이 아니라 재시도 후 최종 실패 시에만).
 * - 2번째 프리패치 시도에서 성공하면 src가 붙고 폴백이 안 불린다.
 * - onBootProgress가 진행(바이트·시도)을 보고한다.
 * - 모듈 prefetchForBoot: 매니페스트를 읽어 진입 에셋을 받고,
 *   멈춘 파일이 남으면 reject한다.
 *
 * 카나리아: runBootPrefetch에서 src 설정을 빼면 첫 테스트가 실패하고,
 * 재시도 루프를 빼면(1회 실패 시 바로 폴백) 두 번째 테스트의
 * prefetch 호출 횟수 단언이 실패한다.
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
const FONTS_JS = fs.readFileSync(path.join(ROOT, 'public/js/fonts.js'), 'utf-8');
const HTTP_JSON_JS = fs.readFileSync(path.join(ROOT, 'public/js/common/http-json.js'), 'utf-8');
const CONSTANTS_JS = fs.readFileSync(path.join(ROOT, 'public/js/common/constants.js'), 'utf-8');
const CORE_JS = fs.readFileSync(path.join(ROOT, 'public/js/craft-prefetch-core.js'), 'utf-8');
const BRIDGE_JS = fs.readFileSync(path.join(ROOT, 'public/js/finder-deckcraft.js'), 'utf-8');

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

function loadDeck(loadCore = false) {
  const win = getWin();
  const doc = getDoc();
  doc.body.innerHTML = '<div id="host-parent"></div>';
  new Function('window', 'document', HTTP_JSON_JS)(win, doc);
  new Function('window', 'document', CONSTANTS_JS)(win, doc);
  if (loadCore) new Function('window', 'document', CORE_JS)(win, doc);
  new Function('window', 'document', FONTS_JS)(win, doc);
  new Function('window', 'document', BRIDGE_JS)(win, doc);
  return { win, doc, api: win.MyHubFinderDeckCraft };
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
    fonts: win.MyHubFonts || null,
    readyTimeoutMs: 60000,
    bootMaxAttempts: 3,
    bootRetryDelayMs: 5,
    onFallback,
    onBootProgress,
    ...extra,
  });
  return { host, onFallback, onBootProgress, fetchFn };
}

describe('deckcraft 부팅 게이트 프리패치', () => {
  test('프리패치가 끝나기 전에는 src가 비어 있고 완료 후에 붙는다', async () => {
    const { win, doc, api } = loadDeck();
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
      expect(host.frame.getAttribute('src')).toContain('/vendor/deckcraft/');
    } finally {
      host.destroy();
    }
  });

  test('프리패치 3회 실패 시에만 폴백이 불리고 src가 안 붙는다', async () => {
    const { win, doc, api } = loadDeck();
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
    const { win, doc, api } = loadDeck();
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
    const { win, doc, api } = loadDeck();
    const prefetchForBoot = jest.fn((opts: any) => {
      opts.onProgress({
        receivedBytes: 3 * 1048576,
        filesDone: 1,
        filesTotal: 4,
        currentUrl: 'https://x.test/a.wasm',
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
});

describe('deckcraft 모듈 prefetchForBoot', () => {
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

  test('매니페스트를 읽어 진입 에셋을 받는다', async () => {
    const { win, api } = loadDeck(true);
    const log: string[] = [];
    const manifest = {
      js: 'deckcraft-web-abc.js',
      wasm: 'deckcraft-web-abc_bg.wasm',
      files: [
        'deckcraft-web-abc.js',
        'deckcraft-web-abc_bg.wasm',
        'index.html',
        'snippets/eframe-1/inline0.js',
      ],
    };
    const fetchFn = jest.fn(async (url: string) => {
      log.push(String(url));
      if (String(url).includes('manifest.json')) return textStreamRes(JSON.stringify(manifest));
      return binaryRes(100);
    });
    const r = await api.prefetchForBoot({ fetchFn, win });
    expect(r.stalled).toEqual([]);
    expect(log.some((u) => u.includes('deckcraft-web-abc.js'))).toBe(true);
    expect(log.some((u) => u.includes('deckcraft-web-abc_bg.wasm'))).toBe(true);
    expect(log.some((u) => u.includes('snippets/eframe-1/inline0.js'))).toBe(true);
  });

  test('wasm이 멈추면 reject한다', async () => {
    const { win, api } = loadDeck(true);
    const manifest = { js: 'deckcraft-web-abc.js', wasm: 'deckcraft-web-abc_bg.wasm' };
    const fetchFn = jest.fn(async (url: string) => {
      if (String(url).includes('manifest.json')) return textStreamRes(JSON.stringify(manifest));
      if (String(url).endsWith('.wasm')) return binaryRes(100, true);
      return binaryRes(100);
    });
    await expect(
      api.prefetchForBoot({ fetchFn, win, stallTimeoutMs: 50, maxAttempts: 2, retryDelayMs: 5 }),
    ).rejects.toThrow('멈춤');
  });
});
