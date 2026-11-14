/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 오피스 엔진 부팅 중 로딩 화면 회귀 (2026-11-13 사용자 지적).
 *
 * 배경: 오피스를 열면 엔진이 뜨기 전에 흰 페이지가 먼저 보였다.
 * Excel은 회색 한 줄짜리 텍스트("시트 편집기를 불러오는 중")만 있는
 * 흰 화면이었고, 한글은 아예 빈 흰 화면이었다. 사용자가 "무슨 페이지가
 * 하나 뜨고 흰색에 글씨 몇 개 있는 페이지 로딩 같은?"이라고 지적한
 * 바로 그 화면이다. PPT·PDF는 리더/뷰어가 먼저 보여 엔진이 준비된
 * 뒤에야 교체되므로 흰 페이지가 없어 대상이 아니다.
 *
 * 수정: 데스크톱 부팅 오버레이(#dt-boot)와 같은 정식 로딩 화면으로
 * 통일했다 — 흰 배경 + 앱 이름 + 파란 스피너 + 상태 문구.
 * - Excel: sheet-gridcraft.js의 .sheet-gc-loading을 구조화
 *   (title "Excel" + spin + status), ready 시 숨김은 기존 유지.
 * - 한글: finder-format-hwp.js openEditor가 .fv-hwp-loading을
 *   컨테이너에 붙이고 loadFile 성공·실패·이탈 시 모두 제거한다.
 *
 * 이 테스트가 검증하는 성질:
 * - Excel: 브릿지 생성 직후 로딩 화면이 보이고, 앱 이름·스피너·
 *   상태 문구가 있다. gridcraft:ready 뒤에는 숨겨진다.
 * - 한글: loadFile이 끝나기 전에는 로딩 화면이 보이고, 성공하면
 *   사라지고, 실패해도 사라진다 (남으면 흰 화면이 영원히 남는다).
 * - JS가 만드는 로딩 클래스명이 CSS에 실제로 존재한다 (이름이
 *   어긋나면 스타일 없이 맨 텍스트만 보이는 원상태로 돌아간다).
 *
 * 카나리아: sheet-gridcraft.js에서 title/spin 생성을 지우면 Excel
 * 테스트가 실패하고, ready 시 hidden 대입을 지우면 두 번째가 실패한다.
 * hwp에서 로딩 생성·제거를 지우면 해당 테스트가 실패하고, CSS에서
 * 클래스명을 바꾸면 드리프트 테스트가 실패한다. 실브라우저 시각 검증은
 * .scratch/perf4/probe-loading-overlap.cjs 후속 실행이 담당한다.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const FONTS_JS = fs.readFileSync(path.join(ROOT, 'public/js/fonts.js'), 'utf-8');
const HTTP_JSON_JS = fs.readFileSync(path.join(ROOT, 'public/js/common/http-json.js'), 'utf-8');
const CONSTANTS_JS = fs.readFileSync(path.join(ROOT, 'public/js/common/constants.js'), 'utf-8');
const SHEET_JS = fs.readFileSync(path.join(ROOT, 'public/js/sheet-gridcraft.js'), 'utf-8');
const HWP_JS = fs.readFileSync(path.join(ROOT, 'public/js/finder-format-hwp.js'), 'utf-8');
const SHEET_CSS = fs.readFileSync(path.join(ROOT, 'public/css/sheet.css'), 'utf-8');
const FINDER_CSS = fs.readFileSync(path.join(ROOT, 'public/css/finder.css'), 'utf-8');

const getWin = (): any => (globalThis as any).window;
const getDoc = (): any => (globalThis as any).document;

function flush(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

function setupSheetBridge() {
  const win = getWin();
  const doc = getDoc();
  doc.body.innerHTML = '<div id="sheet-host"></div>';
  // F-L8: http-json 공용 코어를 fonts.js보다 먼저 뜬다 (운영 정적 태그 순서).
  // 5-9: 공용 상수도 마찬가지.
  new Function('window', 'document', HTTP_JSON_JS)(win, doc);
  new Function('window', 'document', CONSTANTS_JS)(win, doc);
  new Function('window', 'document', FONTS_JS)(win, doc);
  new Function('window', 'document', SHEET_JS)(win, doc);
  const api = win.MyHubSheetGridcraft;
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
  });
  const fromEngine = (data: any) => {
    const ev = new win.MessageEvent('message', {
      data,
      origin: win.location.origin,
      source: bridge.frame.contentWindow,
    });
    win.dispatchEvent(ev);
  };
  return { doc, bridge, fromEngine };
}

describe('Excel 로딩 화면', () => {
  test('브릿지 생성 직후 앱 이름·스피너·상태 문구가 보인다', () => {
    const { doc, bridge } = setupSheetBridge();
    try {
      const loading = doc.querySelector('.sheet-gc-loading') as any;
      expect(loading).not.toBeNull();
      expect(loading.hidden).toBe(false);
      expect(loading.querySelector('.sheet-gc-loading-title')?.textContent).toBe('Excel');
      expect(loading.querySelector('.sheet-gc-loading-spin')).not.toBeNull();
      expect(loading.querySelector('.sheet-gc-loading-status')?.textContent).toBe(
        '시트 편집기를 불러오는 중',
      );
    } finally {
      bridge.destroy();
    }
  });

  test('gridcraft:ready 뒤에 로딩 화면이 숨겨진다', async () => {
    const { doc, bridge, fromEngine } = setupSheetBridge();
    try {
      fromEngine({ type: 'gridcraft:ready' });
      await flush(10);
      const loading = doc.querySelector('.sheet-gc-loading') as any;
      expect(loading.hidden).toBe(true);
    } finally {
      bridge.destroy();
    }
  });
});

describe('한글 로딩 화면', () => {
  function setupHwp() {
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
    // 모듈 IIFE가 window.MyHubFinderViewer 없으면 조기 반환한다.
    win.MyHubFinderViewer = { registerFormat: jest.fn() };
    new Function('window', 'document', HWP_JS)(win, doc);
    const api = win.MyHubFinderFormatHwp;
    let resolveLoad!: () => void;
    let rejectLoad!: (e: any) => void;
    const loadPromise = new Promise<void>((res, rej) => {
      resolveLoad = res;
      rejectLoad = rej;
    });
    const sdk = {
      createEditor: jest.fn(() => ({
        loadFile: jest.fn(() => loadPromise),
        destroy: jest.fn(),
      })),
    };
    const ctx: any = {
      doc,
      body,
      file: { fileId: 0, name: 'test.hwpx', kind: 'hwpx' },
      chromeFold: true,
      minimalChrome: false,
      studioEmbed: false,
      isCurrent: () => true,
      clearBody: () => {
        body.innerHTML = '';
      },
      fetchContent: async () => new ArrayBuffer(8),
      loadLib: async () => sdk,
      setSaveHandler: () => {},
      setNote: () => {},
      onFoldChange: () => {},
      saveBtn: null,
    };
    return { doc, body, api, ctx, sdk, resolveLoad, rejectLoad };
  }

  test('SDK 로드가 끝나기 전에도 로딩 화면이 보인다 (막대→원형 이어받기)', async () => {
    // 2026-11-13: 로딩 화면이 loadLib 뒤에 만들어져서, 다운로드가 끝난 뒤
    // SDK 로드 동안 빈 화면이 보이고 오피스 진행 막대와 원형 로딩이 겹쳤다.
    // 이제 로딩 화면은 openEditor 시작 시점에 먼저 뜬다.
    const { body, api, ctx, sdk, resolveLoad } = setupHwp();
    let resolveLib!: (v: any) => void;
    const libPromise = new Promise((res) => {
      resolveLib = res;
    });
    ctx.loadLib = () => libPromise;
    const p = api.handleHwp(ctx);
    await flush(20);
    // loadLib이 아직 안 끝났는데도 로딩 화면이 있어야 한다.
    expect(body.querySelector('.fv-hwp-loading')).not.toBeNull();
    resolveLib(sdk);
    await flush(20);
    expect(body.querySelector('.fv-hwp-loading')).not.toBeNull();
    resolveLoad();
    await p;
    expect(body.querySelector('.fv-hwp-loading')).toBeNull();
  });

  test('loadFile이 끝나기 전에는 로딩 화면이 보인다', async () => {
    const { body, api, ctx, resolveLoad } = setupHwp();
    const p = api.handleHwp(ctx);
    // loadFile이 끝나지 않은 동안 로딩 화면이 있어야 한다.
    await flush(20);
    const loading = body.querySelector('.fv-hwp-loading') as any;
    expect(loading).not.toBeNull();
    expect(loading.querySelector('.fv-hwp-loading-title')?.textContent).toBe('한글 2020');
    expect(loading.querySelector('.fv-hwp-loading-spin')).not.toBeNull();
    expect(loading.querySelector('.fv-hwp-loading-status')?.textContent).toBe(
      '한글 편집기를 불러오는 중',
    );
    // 테스트 종료 전에 펜딩을 정리한다 (열린 핸들 방지).
    resolveLoad();
    await p;
  });

  test('loadFile 성공 후 로딩 화면이 사라진다', async () => {
    const { body, api, ctx, resolveLoad } = setupHwp();
    const p = api.handleHwp(ctx);
    await flush(20);
    expect(body.querySelector('.fv-hwp-loading')).not.toBeNull();
    resolveLoad();
    await p;
    expect(body.querySelector('.fv-hwp-loading')).toBeNull();
  });

  test('loadFile 실패 후에도 로딩 화면이 남지 않는다', async () => {
    const { body, api, ctx, rejectLoad } = setupHwp();
    const p = api.handleHwp(ctx);
    await flush(20);
    expect(body.querySelector('.fv-hwp-loading')).not.toBeNull();
    rejectLoad(new Error('studio boot failed'));
    await expect(p).rejects.toThrow('studio boot failed');
    expect(body.querySelector('.fv-hwp-loading')).toBeNull();
  });
});

describe('로딩 클래스명 JS↔CSS 드리프트', () => {
  function loadingClasses(js: string): string[] {
    const out = new Set<string>();
    const re = /className = '([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(js)) !== null) {
      if (m[1].includes('loading') || m[1].includes('spin')) out.add(m[1]);
    }
    return [...out];
  }

  test('시트 로딩 클래스가 sheet.css에 존재한다', () => {
    const classes = loadingClasses(SHEET_JS);
    expect(classes.length).toBeGreaterThan(0);
    for (const c of classes) {
      expect(SHEET_CSS).toContain('.' + c);
    }
    // 스피너는 회전 애니메이션이 있어야 한다 (멈춘 원이 아니다).
    expect(SHEET_CSS).toMatch(/\.sheet-gc-loading-spin\s*\{[^}]*animation:/);
  });

  test('한글 로딩 클래스가 finder.css에 존재한다', () => {
    const classes = loadingClasses(HWP_JS);
    expect(classes.length).toBeGreaterThan(0);
    for (const c of classes) {
      expect(FINDER_CSS).toContain('.' + c);
    }
    expect(FINDER_CSS).toMatch(/\.fv-hwp-loading-spin\s*\{[^}]*animation:/);
  });
});
