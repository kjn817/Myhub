/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * P1 HWP 재렌더 — 늦은 폰트 로딩 시 렌더된 페이지 다시 그리기 (2026-11-15)
 *
 * 배경: HWP 보기(renderView)는 fontsReady(2500ms)만 기다리는데 load()가
 * 그보다 늦으면 1차 렌더가 대체 폰트 기준으로 측정된다. SVG 글리프는
 * DOM이 갈아끼우지만, 텍스트 위치·줄바꿈은 측정 시점 폰트 기준으로
 * SVG에 박혀 있어 그대로 두면 틀어진다. 이제 로딩이 실제로 끝나면
 * 새로 생긴 폰트가 있는지 보고, 있으면 렌더된 페이지를 다시 그린다.
 *
 * 검증 성질:
 * - whenLoaded 뒤 새 폰트 패밀리가 생기면 렌더된 페이지의
 *   renderPageSvg가 다시 불린다.
 * - 새 폰트가 없으면 다시 그리지 않는다.
 *
 * 카나리아: renderView에서 whenLoaded 체인을 빼면 첫 테스트의
 * renderPageSvg 호출 횟수 단언이 실패한다.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const HWP_JS = fs.readFileSync(path.join(ROOT, 'public/js/finder-format-hwp.js'), 'utf-8');

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

describe('P1 HWP 재렌더', () => {
  test('whenLoaded 뒤 새 폰트가 생기면 렌더된 페이지를 다시 그린다', async () => {
    const win = getWin();
    const doc = getDoc();
    doc.body.innerHTML = '<div id="fvBody"></div>';
    const body = doc.getElementById('fvBody');
    win.MyHubOfficeTabs = {
      onCommand: jest.fn(),
      onQuick: jest.fn(),
      setState: jest.fn(),
      setQuick: jest.fn(),
    };
    win.MyHubFinderViewer = { registerFormat: jest.fn() };
    // 폰트 가짜: whenReady는 즉시, whenLoaded는 테스트가 여는 deferred,
    // families는 테스트가 제어한다.
    let families: string[] = [];
    let resolveLoaded: any;
    const loadedP = new Promise((res) => {
      resolveLoaded = res;
    });
    win.MyHubFonts = {
      whenReady: async () => null,
      whenLoaded: () => loadedP,
      families: () => families.slice(),
    };
    new Function('window', 'document', HWP_JS)(win, doc);
    const api = win.MyHubFinderFormatHwp;
    // rhwp 가짜: 2페이지 문서, renderPageSvg 호출을 센다.
    const renderPageSvg = jest.fn(
      (i: number) =>
        `<svg viewBox="0 0 100 140" xmlns="http://www.w3.org/2000/svg"><text x="10" y="20">page ${i}</text></svg>`,
    );
    class FakeDoc {
      pageCount() {
        return 2;
      }
      renderPageSvg(i: number) {
        return renderPageSvg(i);
      }
    }
    const rhwpMod = { default: async () => {}, HwpDocument: FakeDoc };
    const notes: string[] = [];
    const ctx: any = {
      doc,
      body,
      file: { fileId: 1, name: 'test.hwpx', kind: 'hwpx' },
      chromeFold: false,
      minimalChrome: false,
      studioEmbed: false,
      isCurrent: () => true,
      clearBody: () => {
        body.innerHTML = '';
      },
      fetchContent: async () => new ArrayBuffer(8),
      loadLib: async (name: string) => {
        if (name === 'rhwp') return rhwpMod;
        throw new Error('no lib ' + name);
      },
      setSaveHandler: () => {},
      setNote: (s: string) => {
        notes.push(s);
      },
    };
    const origFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    });
    try {
      const p = api.handleHwp(ctx);
      const rendered = await waitFor(() => body.querySelectorAll('.fv-hwp-page svg').length === 2);
      expect(rendered).toBe(true);
      await p;
      expect(renderPageSvg).toHaveBeenCalledTimes(2);
      // 폰트가 늦게 로딩돼 새 패밀리가 생긴다.
      families = ['MyFont'];
      resolveLoaded({ families });
      const rerendered = await waitFor(() => renderPageSvg.mock.calls.length === 4);
      expect(rerendered).toBe(true);
      // 페이지 0·1이 각각 다시 그려졌다.
      expect(renderPageSvg.mock.calls.map((c: any) => c[0]).sort()).toEqual([0, 0, 1, 1]);
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });

  test('새 폰트가 없으면 다시 그리지 않는다', async () => {
    const win = getWin();
    const doc = getDoc();
    doc.body.innerHTML = '<div id="fvBody"></div>';
    const body = doc.getElementById('fvBody');
    win.MyHubOfficeTabs = {
      onCommand: jest.fn(),
      onQuick: jest.fn(),
      setState: jest.fn(),
      setQuick: jest.fn(),
    };
    win.MyHubFinderViewer = { registerFormat: jest.fn() };
    let families: string[] = ['PoolFont'];
    let resolveLoaded: any;
    const loadedP = new Promise((res) => {
      resolveLoaded = res;
    });
    win.MyHubFonts = {
      whenReady: async () => null,
      whenLoaded: () => loadedP,
      families: () => families.slice(),
    };
    new Function('window', 'document', HWP_JS)(win, doc);
    const api = win.MyHubFinderFormatHwp;
    const renderPageSvg = jest.fn(
      (i: number) =>
        `<svg viewBox="0 0 100 140" xmlns="http://www.w3.org/2000/svg"><text x="10" y="20">page ${i}</text></svg>`,
    );
    class FakeDoc {
      pageCount() {
        return 2;
      }
      renderPageSvg(i: number) {
        return renderPageSvg(i);
      }
    }
    const rhwpMod = { default: async () => {}, HwpDocument: FakeDoc };
    const ctx: any = {
      doc,
      body,
      file: { fileId: 1, name: 'test.hwpx', kind: 'hwpx' },
      chromeFold: false,
      minimalChrome: false,
      studioEmbed: false,
      isCurrent: () => true,
      clearBody: () => {
        body.innerHTML = '';
      },
      fetchContent: async () => new ArrayBuffer(8),
      loadLib: async (name: string) => {
        if (name === 'rhwp') return rhwpMod;
        throw new Error('no lib ' + name);
      },
      setSaveHandler: () => {},
      setNote: () => {},
    };
    const origFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    });
    try {
      const p = api.handleHwp(ctx);
      const rendered = await waitFor(() => body.querySelectorAll('.fv-hwp-page svg').length === 2);
      expect(rendered).toBe(true);
      await p;
      expect(renderPageSvg).toHaveBeenCalledTimes(2);
      // 로딩이 끝나도 새 패밀리가 없다.
      resolveLoaded({ families });
      await flush(150);
      expect(renderPageSvg).toHaveBeenCalledTimes(2);
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });
});
