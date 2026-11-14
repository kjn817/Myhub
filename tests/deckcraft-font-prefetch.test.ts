/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * DeckCraft 풀 폰트 fetch 지연 회귀 (성능 5라운드, 2026-11-13).
 *
 * 배경: 내장 폰트 풀(10종·11MB)을 createHost에서 즉시 받기 시작하면
 * 느린 네트워크에서 문서 자체의 로딩을 가로막는다 (실측: Fast 3G에서
 * PowerPoint 로딩 23.2s — 폰트 11MB + WASM 22MB가 1.6Mbps 회선을 포화).
 * gridcraft와 같은 규칙으로 문서 load 이후에 받기 시작한다. load 이후에
 * 시작해도 엔진 부팅보다 먼저 끝나므로 ready 직후 pushFonts가 기다리지
 * 않는다. loadFallbackFonts는 fetchFn별 캐시를 쓰므로 ready 뒤 pushFonts가
 * 다시 불러도 네트워크 호출이 늘지 않는다.
 *
 * 이 테스트가 검증하는 성질:
 * - load 전에는 풀 폰트 fetch가 나가지 않고, load 뒤에 나간다.
 * - load가 이미 끝난 상태면 호스트 생성 직후 fetch가 나간다.
 *
 * 카나리아: finder-deckcraft.js에서 load 지연을 빼고 즉시 fetch로 되돌리면
 * 첫 테스트가 실패한다.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const FONTS_JS = fs.readFileSync(path.join(ROOT, 'public/js/fonts.js'), 'utf-8');
const HTTP_JSON_JS = fs.readFileSync(path.join(ROOT, 'public/js/common/http-json.js'), 'utf-8');
const CONSTANTS_JS = fs.readFileSync(path.join(ROOT, 'public/js/common/constants.js'), 'utf-8');
const BRIDGE_JS = fs.readFileSync(path.join(ROOT, 'public/js/finder-deckcraft.js'), 'utf-8');

const getWin = (): any => (globalThis as any).window;
const getDoc = (): any => (globalThis as any).document;

function flush(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

function setupHost(opts: { loading?: boolean } = {}) {
  const win = getWin();
  const doc = getDoc();
  doc.body.innerHTML = '<div id="host-parent"></div>';
  // F-L8: http-json 공용 코어를 fonts.js보다 먼저 뜬다 (운영 정적 태그 순서).
  // 5-9: 공용 상수도 마찬가지.
  new Function('window', 'document', HTTP_JSON_JS)(win, doc);
  new Function('window', 'document', CONSTANTS_JS)(win, doc);
  new Function('window', 'document', FONTS_JS)(win, doc);
  new Function('window', 'document', BRIDGE_JS)(win, doc);
  // load 전 상태를 흉내낸다 (jsdom 기본 readyState는 'complete').
  // 스크립트 로드 뒤에 바꿔야 모듈 수준 자동 프리패치 분기가 안 바뀐다.
  let restoreReadyState: () => void = () => {};
  if (opts.loading) {
    Object.defineProperty(doc, 'readyState', { value: 'loading', configurable: true });
    restoreReadyState = () => {
      delete (doc as any).readyState;
    };
  }
  const api = win.MyHubFinderDeckCraft;
  const fetched: string[] = [];
  const fetchFn = jest.fn(async (url: string) => {
    fetched.push(String(url));
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
  });
  const host: any = api.createHost({
    doc,
    win,
    parentEl: doc.getElementById('host-parent'),
    fetchFn,
    fonts: win.MyHubFonts || null,
  });
  const poolFetches = () => fetched.filter((u) => u.startsWith('/fonts/'));
  const fireLoad = () => {
    win.dispatchEvent(new win.Event('load'));
  };
  return { win, host, fetchFn, fetched, poolFetches, fireLoad, restoreReadyState };
}

describe('deckcraft pool font prefetch', () => {
  test('load 전에는 풀 폰트 fetch가 나가지 않고, load 뒤에 나간다', async () => {
    const { host, poolFetches, fireLoad, restoreReadyState } = setupHost({ loading: true });
    try {
      await flush(10);
      expect(poolFetches()).toHaveLength(0);
      fireLoad();
      await flush(10);
      const pool = poolFetches();
      // 풀 10종 전부가 fetch 대상이다.
      expect(pool.length).toBe(10);
      expect(pool).toContain('/fonts/NanumGothic-Regular.ttf');
      expect(pool).toContain('/fonts/Inter-Regular.ttf');
    } finally {
      host.destroy();
      restoreReadyState();
    }
  });

  test('load가 이미 끝났으면 호스트 생성 직후 fetch가 나간다', async () => {
    const { host, poolFetches } = setupHost();
    try {
      await flush(10);
      expect(poolFetches().length).toBe(10);
    } finally {
      host.destroy();
    }
  });
});
