/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * GridCraft 풀 폰트 조기 fetch 회귀 (2026-11-13 성능 4라운드, 5라운드 개정).
 *
 * 배경: 내장 폰트 풀(10종·11MB)은 pushFonts()가 gcReady 뒤에야
 * loadPoolBytes로 받기 시작해, 엔진 부팅(1.5s)과 직렬로 더해져 한글
 * tofu 구간을 늘렸다. 4라운드에서 createBridge에서 엔진 iframe 기동과
 * 동시에 풀을 받아 두게 했다. 5라운드에서 load 이후로 지연했다: load 전에
 * 받으면 느린 네트워크에서 문서 자체의 로딩을 가로막는다 (실측: Fast 3G에서
 * Excel 로딩 21.7s — 폰트 11MB + WASM 18MB가 1.6Mbps 회선을 포화).
 * load 이후에 시작해도 WASM 부팅보다 먼저 끝나므로 tofu 구간은 그대로
 * 짧다. loadPoolBytes는 fetchFn별 Promise를 캐시하므로 pushFonts의
 * 뒤늦은 호출은 같은 Promise를 재사용한다.
 *
 * 이 테스트가 검증하는 성질:
 * - load 전에는 풀 폰트 fetch가 나가지 않고, load 뒤에 나간다.
 * - load가 이미 끝난 상태면 브릿지 생성 직후 fetch가 나간다.
 * - ready 뒤 pushFonts가 돌아도 풀 폰트를 다시 받지 않는다 (캐시 재사용).
 *
 * 카나리아: sheet-gridcraft.js에서 load 지연을 빼고 즉시 fetch로 되돌리면
 * 첫 테스트가 실패하고, fonts.js의 poolCache를 지우면 세 번째 테스트가
 * 실패한다. 실브라우저 타이밍 검증은 .scratch/perf4/probe-office-fonts.cjs가
 * 담당한다.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const FONTS_JS = fs.readFileSync(path.join(ROOT, 'public/js/fonts.js'), 'utf-8');
const HTTP_JSON_JS = fs.readFileSync(path.join(ROOT, 'public/js/common/http-json.js'), 'utf-8');
const BRIDGE_JS = fs.readFileSync(path.join(ROOT, 'public/js/sheet-gridcraft.js'), 'utf-8');

const getWin = (): any => (globalThis as any).window;
const getDoc = (): any => (globalThis as any).document;

function flush(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

function setupBridge(opts: { loading?: boolean } = {}) {
  const win = getWin();
  const doc = getDoc();
  doc.body.innerHTML = '<div id="sheet-host"></div>';
  // F-L8: http-json 공용 코어를 fonts.js보다 먼저 뜬다 (운영 정적 태그 순서).
  new Function('window', 'document', HTTP_JSON_JS)(win, doc);
  new Function('window', 'document', FONTS_JS)(win, doc);
  new Function('window', 'document', BRIDGE_JS)(win, doc);
  // load 전 상태를 흉내낸다 (jsdom 기본 readyState는 'complete').
  let restoreReadyState: () => void = () => {};
  if (opts.loading) {
    Object.defineProperty(doc, 'readyState', { value: 'loading', configurable: true });
    restoreReadyState = () => {
      delete (doc as any).readyState;
    };
  }
  const api = win.MyHubSheetGridcraft;
  const fetched: string[] = [];
  const fetchFn = jest.fn(async (url: string) => {
    fetched.push(String(url));
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
  });
  const bridge: any = api.createBridge({
    document: doc,
    window: win,
    root: doc.getElementById('sheet-host'),
    postToParent: () => {},
    fonts: win.MyHubFonts || null,
    fetchFn,
  });
  const fromEngine = (data: any) => {
    const ev = new win.MessageEvent('message', {
      data,
      origin: win.location.origin,
      source: bridge.frame.contentWindow,
    });
    win.dispatchEvent(ev);
  };
  const poolFetches = () => fetched.filter((u) => u.startsWith('/fonts/'));
  const fireLoad = () => {
    win.dispatchEvent(new win.Event('load'));
  };
  return { win, bridge, fetchFn, fetched, fromEngine, poolFetches, fireLoad, restoreReadyState };
}

describe('gridcraft pool font prefetch', () => {
  test('load 전에는 풀 폰트 fetch가 나가지 않고, load 뒤에 나간다', async () => {
    const { bridge, poolFetches, fireLoad, restoreReadyState } = setupBridge({ loading: true });
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
      bridge.destroy();
      restoreReadyState();
    }
  });

  test('load가 이미 끝났으면 브릿지 생성 직후 fetch가 나간다', async () => {
    const { bridge, poolFetches } = setupBridge();
    try {
      await flush(10);
      expect(poolFetches().length).toBe(10);
    } finally {
      bridge.destroy();
    }
  });

  test('ready 뒤 pushFonts가 풀 폰트를 다시 받지 않는다', async () => {
    const { bridge, fromEngine, poolFetches } = setupBridge();
    try {
      await flush(10);
      expect(poolFetches().length).toBe(10);
      fromEngine({ type: 'gridcraft:ready' });
      await flush(50);
      // pushFonts가 loadPoolBytes를 다시 불러도 캐시된 Promise를 써서
      // 네트워크 호출이 늘지 않는다.
      expect(poolFetches().length).toBe(10);
    } finally {
      bridge.destroy();
    }
  });
});
