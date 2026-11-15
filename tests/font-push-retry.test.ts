/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * P1 폰트 재푸시 — Excel·PPT 엔진 (2026-11-15)
 *
 * 배경: pushFonts()/driveFaces()가 fonts.whenReady(4000)으로 4초만
 * 기다리는데 load()가 5~12초 걸리면 1차 푸시에 사용자 폰트가 안 닿고,
 * 재시도가 없어 그 세션에서는 영영 누락됐다 (폰트 풀 10종만 푸시됨).
 * 이제 1차 푸시 뒤에 whenLoaded()로 로딩 완료를 기다렸다가, 새로
 * 생긴 페이스만 한 번 더 푸시한다.
 *
 * 검증 성질:
 * - 덱/그리드: 1차 푸시는 풀 폰트만 담고, whenLoaded 뒤에는 사용자
 *   폰트만 담은 두 번째 푸시가 온다 (풀 중복 없음).
 * - 1차 푸시에 이미 다 닿았으면 두 번째 푸시는 없다.
 *
 * 카나리아: pushFonts에서 whenLoaded 체인을 빼면 첫 두 테스트의
 * 두 번째 post 단언이 실패한다.
 */
import * as fs from 'fs';
import * as path from 'path';
import { TextDecoder, TextEncoder } from 'util';

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
const DECK_JS = fs.readFileSync(path.join(ROOT, 'public/js/finder-deckcraft.js'), 'utf-8');
const GRID_JS = fs.readFileSync(path.join(ROOT, 'public/js/sheet-gridcraft.js'), 'utf-8');

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

function okFetch() {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(8),
  }));
}

// 폰트 가짜: whenReady는 즉시 resolve(타임아웃된 것처럼), faces는
// 테스트가 제어하는 목록, whenLoaded는 테스트가 여는 deferred.
function fakeFonts() {
  let currentFaces: any[] = [];
  let resolveLoaded: any;
  const loadedP = new Promise((res) => {
    resolveLoaded = res;
  });
  const fonts = {
    POOL_FACES: [{ url: '/fonts/pool.woff2', family: 'PoolFont', weight: 400, style: 'normal' }],
    whenReady: jest.fn(async () => null),
    faces: () => currentFaces.slice(),
    whenLoaded: () => loadedP,
    loadPoolBytes: async () => [
      { family: 'PoolFont', weight: 400, style: 'normal', u8: new Uint8Array([1]) },
    ],
  };
  return {
    fonts,
    setFaces: (faces: any[]) => {
      currentFaces = faces;
    },
    resolveLoaded: () => resolveLoaded({ faces: currentFaces }),
  };
}

const USER_FACE = { family: 'MyFont', weight: 400, style: 'normal', fileId: 42 };

describe('P1 덱 폰트 재푸시', () => {
  test('1차 푸시는 풀만, whenLoaded 뒤에는 사용자 폰트만 다시 푸시한다', async () => {
    const win = getWin();
    const doc = getDoc();
    doc.body.innerHTML = '<div id="host-parent"></div>';
    new Function('window', 'document', HTTP_JSON_JS)(win, doc);
    new Function('window', 'document', CONSTANTS_JS)(win, doc);
    new Function('window', 'document', FONTS_JS)(win, doc);
    new Function('window', 'document', DECK_JS)(win, doc);
    const api = win.MyHubFinderDeckCraft;
    const { fonts, setFaces, resolveLoaded } = fakeFonts();
    const posts: any[] = [];
    const host: any = api.createHost({
      doc,
      win,
      parentEl: doc.getElementById('host-parent'),
      fetchFn: okFetch(),
      fonts,
      readyTimeoutMs: 60000,
      bootMaxAttempts: 3,
      bootRetryDelayMs: 5,
      onFallback: jest.fn(),
      prefetchForBoot: async () => ({ done: [], failed: [], stalled: [], receivedBytes: 0 }),
    });
    try {
      // src가 붙은 뒤에야 contentWindow가 고정된다 (nudge 테스트와 같은 함정).
      const attached = await waitFor(() => !!host.frame.getAttribute('src'));
      expect(attached).toBe(true);
      const cw = host.frame.contentWindow;
      cw.postMessage = jest.fn((msg: any) => posts.push(msg));
      const fromEngine = (data: any) => {
        const ev = new win.MessageEvent('message', {
          data,
          origin: win.location.origin,
          source: cw,
        });
        win.dispatchEvent(ev);
      };
      fromEngine({ type: 'deckcraft:ready' });
      // 1차 푸시: 풀 폰트만.
      const first = await waitFor(() => posts.some((m) => m && m.type === 'deckcraft:fonts'));
      expect(first).toBe(true);
      expect(posts.filter((m) => m.type === 'deckcraft:fonts')).toHaveLength(1);
      const firstFonts = posts[0].fonts.map((f: any) => f.family);
      expect(firstFonts).toEqual(['PoolFont']);
      // 로딩이 늦게 끝나 사용자 폰트가 생긴다.
      setFaces([USER_FACE]);
      resolveLoaded();
      const second = await waitFor(
        () => posts.filter((m) => m.type === 'deckcraft:fonts').length === 2,
      );
      expect(second).toBe(true);
      const secondFonts = posts[1].fonts.map((f: any) => f.family);
      expect(secondFonts).toEqual(['MyFont']);
    } finally {
      host.destroy();
    }
  });

  test('1차 푸시에 이미 다 닿았으면 두 번째 푸시는 없다', async () => {
    const win = getWin();
    const doc = getDoc();
    doc.body.innerHTML = '<div id="host-parent"></div>';
    new Function('window', 'document', HTTP_JSON_JS)(win, doc);
    new Function('window', 'document', CONSTANTS_JS)(win, doc);
    new Function('window', 'document', FONTS_JS)(win, doc);
    new Function('window', 'document', DECK_JS)(win, doc);
    const api = win.MyHubFinderDeckCraft;
    const { fonts, setFaces, resolveLoaded } = fakeFonts();
    setFaces([USER_FACE]);
    const posts: any[] = [];
    const host: any = api.createHost({
      doc,
      win,
      parentEl: doc.getElementById('host-parent'),
      fetchFn: okFetch(),
      fonts,
      readyTimeoutMs: 60000,
      bootMaxAttempts: 3,
      bootRetryDelayMs: 5,
      onFallback: jest.fn(),
      prefetchForBoot: async () => ({ done: [], failed: [], stalled: [], receivedBytes: 0 }),
    });
    try {
      const attached = await waitFor(() => !!host.frame.getAttribute('src'));
      expect(attached).toBe(true);
      const cw = host.frame.contentWindow;
      cw.postMessage = jest.fn((msg: any) => posts.push(msg));
      const fromEngine = (data: any) => {
        const ev = new win.MessageEvent('message', {
          data,
          origin: win.location.origin,
          source: cw,
        });
        win.dispatchEvent(ev);
      };
      fromEngine({ type: 'deckcraft:ready' });
      const first = await waitFor(() => posts.some((m) => m && m.type === 'deckcraft:fonts'));
      expect(first).toBe(true);
      expect(posts[0].fonts.map((f: any) => f.family).sort()).toEqual(['MyFont', 'PoolFont']);
      resolveLoaded();
      await flush(150);
      expect(posts.filter((m) => m.type === 'deckcraft:fonts')).toHaveLength(1);
    } finally {
      host.destroy();
    }
  });
});

describe('P1 그리드 폰트 재푸시', () => {
  test('1차 푸시는 풀만, whenLoaded 뒤에는 사용자 폰트만 다시 푸시한다', async () => {
    const win = getWin();
    const doc = getDoc();
    doc.body.innerHTML = '<div id="sheet-host"></div>';
    new Function('window', 'document', HTTP_JSON_JS)(win, doc);
    new Function('window', 'document', CONSTANTS_JS)(win, doc);
    new Function('window', 'document', FONTS_JS)(win, doc);
    new Function('window', 'document', GRID_JS)(win, doc);
    const api = win.MyHubSheetGridcraft;
    const { fonts, setFaces, resolveLoaded } = fakeFonts();
    const posts: any[] = [];
    const bridge: any = api.createBridge({
      document: doc,
      window: win,
      root: doc.getElementById('sheet-host'),
      postToParent: () => {},
      fonts,
      fetchFn: okFetch(),
      bootMaxAttempts: 3,
      bootRetryDelayMs: 5,
      prefetchForBoot: async () => ({ done: [], failed: [], stalled: [], receivedBytes: 0 }),
    });
    try {
      const attached = await waitFor(() => !!bridge.frame.getAttribute('src'));
      expect(attached).toBe(true);
      const cw = bridge.frame.contentWindow;
      cw.postMessage = jest.fn((msg: any) => posts.push(msg));
      const fromEngine = (data: any) => {
        const ev = new win.MessageEvent('message', {
          data,
          origin: win.location.origin,
          source: cw,
        });
        win.dispatchEvent(ev);
      };
      fromEngine({ type: 'gridcraft:ready' });
      const first = await waitFor(() => posts.some((m) => m && m.type === 'gridcraft:fonts'));
      expect(first).toBe(true);
      expect(posts.filter((m) => m.type === 'gridcraft:fonts')).toHaveLength(1);
      expect(posts[0].fonts.map((f: any) => f.family)).toEqual(['PoolFont']);
      setFaces([USER_FACE]);
      resolveLoaded();
      const second = await waitFor(
        () => posts.filter((m) => m.type === 'gridcraft:fonts').length === 2,
      );
      expect(second).toBe(true);
      expect(posts[1].fonts.map((f: any) => f.family)).toEqual(['MyFont']);
    } finally {
      bridge.destroy();
    }
  });
});
