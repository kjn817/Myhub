/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * GridCraft 부팅 게이트 프리패치 (2026-11-15 부팅 강건화).
 *
 * 배경: 카페 속도에서는 18MB 엔진이 45초 로드 타임아웃 안에 도착하지
 * 않아 Excel이 열리지 않았다. 이제 createBridge는 iframe src를 붙이기
 * 전에 엔진 자산을 프리패치로 받아 캐시를 데우고, 45초 타임아웃은 src를
 * 붙인 시점부터 돈다. 프리패치가 전부 실패하면 에러 배너에 '다시 시도'
 * 버튼을 단다.
 *
 * 검증 성질:
 * - 프리패치가 끝나기 전에는 frame.src가 비어 있고, 완료 후에 붙는다.
 *   진행이 로딩 상태줄(.sheet-gc-loading-status)에 MB 단위로 표시된다.
 * - 프리패치 3회 실패 시 에러 배너 + '다시 시도' 버튼이 뜨고, 버튼을
 *   누르면 프리패치부터 다시 돌아 성공하면 src가 붙는다.
 * - 모듈 prefetchForBoot: shell 스캔으로 JS·WASM을 받고, 멈춘 파일이
 *   남으면 reject한다.
 *
 * 카나리아: runBootPrefetch에서 src 설정을 빼면 첫 테스트가 실패하고,
 * 재시도 버튼 핸들러를 빼면 두 번째 테스트가 실패한다.
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
const BRIDGE_JS = fs.readFileSync(path.join(ROOT, 'public/js/sheet-gridcraft.js'), 'utf-8');

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

function loadGrid(loadCore = false) {
  const win = getWin();
  const doc = getDoc();
  doc.body.innerHTML = '<div id="sheet-host"></div>';
  new Function('window', 'document', HTTP_JSON_JS)(win, doc);
  new Function('window', 'document', CONSTANTS_JS)(win, doc);
  if (loadCore) new Function('window', 'document', CORE_JS)(win, doc);
  new Function('window', 'document', FONTS_JS)(win, doc);
  new Function('window', 'document', BRIDGE_JS)(win, doc);
  return { win, doc, api: win.MyHubSheetGridcraft };
}

function makeBridge(api: any, doc: any, win: any, extra: any = {}) {
  const fetchFn = jest.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(8),
  }));
  const bridge: any = api.createBridge({
    document: doc,
    window: win,
    root: doc.getElementById('sheet-host'),
    postToParent: () => {},
    fonts: win.MyHubFonts || null,
    fetchFn,
    bootMaxAttempts: 3,
    bootRetryDelayMs: 5,
    ...extra,
  });
  return { bridge, fetchFn };
}

function loadingStatus(doc: any) {
  return doc.querySelector('.sheet-gc-loading-status')?.textContent || '';
}

describe('gridcraft 부팅 게이트 프리패치', () => {
  test('프리패치가 끝나기 전에는 src가 비어 있고 완료 후에 붙으며 진행이 표시된다', async () => {
    const { win, doc, api } = loadGrid();
    let resolvePrefetch: any;
    const seenStatus: string[] = [];
    const prefetchForBoot = jest.fn(
      (opts: any) =>
        new Promise((resolve) => {
          resolvePrefetch = () => {
            opts.onProgress({ receivedBytes: 2 * 1048576, filesDone: 1, filesTotal: 2 });
            seenStatus.push(loadingStatus(doc));
            resolve({ done: [], failed: [], stalled: [], receivedBytes: 2 * 1048576 });
          };
        }),
    );
    const { bridge } = makeBridge(api, doc, win, { prefetchForBoot });
    try {
      await flush(20);
      expect(prefetchForBoot).toHaveBeenCalledTimes(1);
      expect(bridge.frame.getAttribute('src')).toBeNull();
      resolvePrefetch();
      const attached = await waitFor(() => !!bridge.frame.getAttribute('src'));
      expect(attached).toBe(true);
      expect(bridge.frame.getAttribute('src')).toContain('/vendor/gridcraft/');
      expect(seenStatus[0]).toContain('시트 엔진 받는 중');
      expect(seenStatus[0]).toContain('2.0MB');
    } finally {
      bridge.destroy();
    }
  });

  test('프리패치 3회 실패 시 에러 배너+다시 시도 버튼이 뜨고 클릭하면 다시 돈다', async () => {
    const { win, doc, api } = loadGrid();
    let calls = 0;
    const prefetchForBoot = jest.fn(() => {
      calls += 1;
      if (calls <= 3) return Promise.reject(new Error('stall'));
      return Promise.resolve({ done: [], failed: [], stalled: [], receivedBytes: 0 });
    });
    const { bridge } = makeBridge(api, doc, win, { prefetchForBoot });
    try {
      const shown = await waitFor(() => !!doc.querySelector('.myhub-sheet-boot-retry'));
      expect(shown).toBe(true);
      expect(prefetchForBoot).toHaveBeenCalledTimes(3);
      expect(bridge.frame.getAttribute('src')).toBeNull();
      const btn = doc.querySelector('.myhub-sheet-boot-retry') as any;
      btn.click();
      const attached = await waitFor(() => !!bridge.frame.getAttribute('src'));
      expect(attached).toBe(true);
      expect(prefetchForBoot).toHaveBeenCalledTimes(4);
    } finally {
      bridge.destroy();
    }
  });
});

describe('gridcraft 모듈 prefetchForBoot', () => {
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

  const SHELL_HTML =
    '<link rel="modulepreload" href="./gridcraft-web-abc.js">' +
    '<link rel="preload" href="./gridcraft-web-abc_bg.wasm" as="fetch" type="application/wasm">';

  test('shell 스캔으로 JS·WASM을 받는다', async () => {
    const { win, api } = loadGrid(true);
    const log: string[] = [];
    const fetchFn = jest.fn(async (url: string) => {
      log.push(String(url));
      if (String(url).includes('index.html')) return textStreamRes(SHELL_HTML);
      return binaryRes(100);
    });
    const r = await api.prefetchForBoot({ fetchFn, win });
    expect(r.stalled).toEqual([]);
    expect(log.some((u) => u.includes('gridcraft-web-abc.js'))).toBe(true);
    expect(log.some((u) => u.includes('gridcraft-web-abc_bg.wasm'))).toBe(true);
  });

  test('wasm이 멈추면 reject한다', async () => {
    const { win, api } = loadGrid(true);
    const fetchFn = jest.fn(async (url: string) => {
      if (String(url).includes('index.html')) return textStreamRes(SHELL_HTML);
      if (String(url).endsWith('.wasm')) return binaryRes(100, true);
      return binaryRes(100);
    });
    await expect(
      api.prefetchForBoot({ fetchFn, win, stallTimeoutMs: 50, maxAttempts: 2, retryDelayMs: 5 }),
    ).rejects.toThrow('멈춤');
  });
});
