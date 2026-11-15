/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 한글 편집기 부팅 강건화 (2026-11-15).
 *
 * 배경: 카페에서 한글 첫 로딩이 ~10분 걸렸다 (33MB를 초당 ~55KB).
 * 유튜브는 잘 나와 회선 속도 문제가 아니었다. 원인은 vendor SDK의
 * createEditor가 스튜디오 iframe의 load 이벤트를 시간 제한 없이
 * 기다리는 것 — 다운로드가 멈추거나 기어다니면 부팅 Promise가 영영
 * pending이 되어 스피너만 돌고 에러도 안 떴다. transport(10초/60초)와
 * _waitReady(15초)에는 타임아웃이 있으나 iframe load 대기만 없었다.
 *
 * 수정: finder-format-hwp.js의 openEditor가 부팅 시도(loadLib +
 * createEditor + loadFile)를 시간 제한(30초)과 함께 최대 3회 재시도한다.
 * 각 시도는 자기 상자(iframe 포함)를 갖고, 타임아웃되면 상자를 통째로
 * 제거해 로딩을 중단한다. 3회 모두 실패하면 로딩 화면을 에러 표시로
 * 바꾸고 '다시 시도' 버튼을 보여준다 (vendor 코드는 건드리지 않는다).
 * 로딩 화면에는 단계 문구·시도 횟수·경과 시간이 표시된다.
 *
 * 검증 성질:
 * - createEditor가 영영 pending이면 타임아웃 후 재시도하고, 3회 후에는
 *   에러 표시가 뜬다 (무한 대기가 아니다). 부팅 Promise는 에러 카드가
 *   보이는 상태로 resolve한다 — reject하면 호출부가 보기 폴백으로
 *   화면을 갈아버리고, pending이면 office.js의 부팅 로딩이 영영 안
 *   사라지기 때문이다 (viewer.open settle을 기다린다).
 * - 2번째 시도에서 성공하면 에디터가 뜬다 (저장 버튼 노출·setNote).
 * - 로딩 UI에 단계 문구('편집기 받는 중…' 등)·시도 횟수·경과 시간이
 *   표시된다.
 * - '다시 시도' 버튼을 누르면 부팅이 다시 시작되고, 성공하면 열린다.
 *
 * 카나리아: bootOnce의 타임아웃을 무효화하면 첫 테스트가 실패한다
 * (createEditor 1회 호출 후 에러 표시가 뜨지 않는다).
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

describe('한글 편집기 부팅 강건화', () => {
  function setupHwp() {
    const win = getWin();
    const doc = getDoc();
    doc.body.innerHTML = '<div id="fvBody"></div>';
    const body = doc.getElementById('fvBody');
    win.MyHubOfficeTabs = undefined;
    // 모듈 IIFE가 window.MyHubFinderViewer 없으면 조기 반환한다.
    win.MyHubFinderViewer = { registerFormat: jest.fn() };
    new Function('window', 'document', HWP_JS)(win, doc);
    const api = win.MyHubFinderFormatHwp;
    let current = true;
    const notes: string[] = [];
    const saveBtn = doc.createElement('button');
    saveBtn.hidden = true;
    const ctx: any = {
      doc,
      body,
      file: { fileId: 0, name: 'test.hwp', kind: 'hwp' },
      chromeFold: null,
      minimalChrome: false,
      studioEmbed: false,
      isCurrent: () => current,
      clearBody: () => {
        body.innerHTML = '';
      },
      fetchContent: async () => new ArrayBuffer(8),
      loadLib: async () => sdk,
      setSaveHandler: jest.fn(),
      setNote: (m: string) => notes.push(m),
      setStatus: jest.fn(),
      markDirty: jest.fn(),
      putContent: jest.fn(() => Promise.resolve(true)),
      saveAsContent: jest.fn(() => Promise.resolve(true)),
      onFoldChange: jest.fn(),
      showMessage: jest.fn(),
      saveBtn,
    };
    const sdk = {
      createEditor: jest.fn(),
    };
    return {
      body,
      api,
      ctx,
      sdk,
      notes,
      saveBtn,
      setCurrent: (v: boolean) => {
        current = v;
      },
    };
  }

  function fakeEditor() {
    return {
      loadFile: jest.fn(() => Promise.resolve()),
      destroy: jest.fn(),
      exportHwp: jest.fn(() => Promise.resolve(new Uint8Array(0))),
      exportHwpx: jest.fn(() => Promise.resolve(new Uint8Array(0))),
    };
  }

  function loadingEl(body: any) {
    return body.querySelector('.fv-hwp-loading');
  }
  function statusText(body: any) {
    return loadingEl(body)?.querySelector('.fv-hwp-loading-status')?.textContent || '';
  }
  function detailText(body: any) {
    return loadingEl(body)?.querySelector('.fv-hwp-loading-detail')?.textContent || '';
  }

  test('createEditor가 영영 pending이면 타임아웃 후 재시도하고 3회 후 에러 표시가 뜬다', async () => {
    const { body, api, ctx, sdk } = setupHwp();
    api.internals.bootAttemptTimeoutMs = 60;
    api.internals.bootRetryDelayMs = 10;
    api.internals.bootMaxAttempts = 3;
    api.internals.bootElapsedIntervalMs = 20;
    sdk.createEditor.mockImplementation(() => new Promise(() => {}));
    const p = api.handleHwp(ctx);
    const shown = await waitFor(() => !!body.querySelector('.myhub-hwp-boot-retry'));
    expect(shown).toBe(true);
    // 3번 시도했고, 실패한 시도의 상자(iframe 포함)는 정리됐다.
    expect(sdk.createEditor).toHaveBeenCalledTimes(3);
    expect(body.querySelectorAll('.fv-hwp-editor-attempt').length).toBe(0);
    // 스피너 대신 에러 표시 + 다시 시도 버튼.
    expect(statusText(body)).toBe('편집기를 불러오지 못했습니다');
    expect(detailText(body)).toContain('다시 시도해 주세요');
    const spin = loadingEl(body)?.querySelector('.fv-hwp-loading-spin') as any;
    expect(spin.style.display).toBe('none');
    // 에러 카드가 보이는 상태로 부팅 Promise가 resolve한다 — reject하면
    // 호출부의 보기 폴백이 에러 카드를 갈아버리고, pending이면 office.js의
    // 부팅 로딩이 영영 안 사라진다 (viewer.open settle을 기다린다).
    const settled = await Promise.race([
      p.then(() => 'settled'),
      flush(150).then(() => 'pending'),
    ]);
    expect(settled).toBe('settled');
    // resolve한 뒤에도 에러 카드가 그대로 남아 있다.
    expect(body.querySelector('.myhub-hwp-boot-retry')).not.toBeNull();
    expect(statusText(body)).toBe('편집기를 불러오지 못했습니다');
  });

  test('2번째 시도에서 성공하면 에디터가 뜬다', async () => {
    const { body, api, ctx, sdk, notes, saveBtn } = setupHwp();
    api.internals.bootAttemptTimeoutMs = 60;
    api.internals.bootRetryDelayMs = 10;
    api.internals.bootMaxAttempts = 3;
    const editor = fakeEditor();
    sdk.createEditor
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(() => Promise.resolve(editor));
    const p = api.handleHwp(ctx);
    await p;
    expect(sdk.createEditor).toHaveBeenCalledTimes(2);
    expect(editor.loadFile).toHaveBeenCalledTimes(1);
    // 성공 후속: 저장 버튼 노출·메모·로딩 제거.
    expect(saveBtn.hidden).toBe(false);
    expect(notes).toContain('한글 문서 쪽 편집 중');
    expect(loadingEl(body)).toBeNull();
    // 성공한 시도의 상자는 남는다 (에디터가 그 안에 있다).
    expect(body.querySelectorAll('.fv-hwp-editor-attempt').length).toBe(1);
  });

  test('로딩 UI에 단계 문구와 시도 횟수가 표시된다', async () => {
    const { body, api, ctx, sdk } = setupHwp();
    api.internals.bootAttemptTimeoutMs = 500;
    api.internals.bootRetryDelayMs = 10;
    api.internals.bootMaxAttempts = 3;
    api.internals.bootElapsedIntervalMs = 20;
    let resolveLib!: (v: any) => void;
    const libPromise = new Promise((res) => {
      resolveLib = res;
    });
    ctx.loadLib = () => libPromise;
    sdk.createEditor.mockImplementation(() => new Promise(() => {}));
    const p = api.handleHwp(ctx);
    await flush(20);
    // loadLib 대기 중: 단계 문구 + 시도 1/3 + 경과 시간.
    expect(statusText(body)).toBe('편집기 받는 중…');
    expect(detailText(body)).toContain('시도 1/3');
    expect(detailText(body)).toMatch(/\d+초 경과/);
    resolveLib(sdk);
    await flush(20);
    // createEditor 대기 중: 단계가 바뀐다.
    expect(statusText(body)).toBe('편집기 시작하는 중…');
    // 1차 타임아웃 후 2차 시도: 다시 시도 문구 + 시도 2/3.
    const retried = await waitFor(() => statusText(body).includes('다시 시도 중 (2/3)'));
    expect(retried).toBe(true);
    expect(detailText(body)).toContain('시도 2/3');
    // 테스트 종료 전에 펜딩을 정리한다.
    await waitFor(() => !!body.querySelector('.myhub-hwp-boot-retry'));
    void p;
  });

  test('경과 시간이 초 단위로 오른다', async () => {
    const { body, api, ctx, sdk, setCurrent } = setupHwp();
    api.internals.bootAttemptTimeoutMs = 3000;
    api.internals.bootRetryDelayMs = 10;
    api.internals.bootMaxAttempts = 1;
    api.internals.bootElapsedIntervalMs = 50;
    sdk.createEditor.mockImplementation(() => new Promise(() => {}));
    const p = api.handleHwp(ctx);
    await flush(20);
    expect(detailText(body)).toContain('0초 경과');
    await flush(1100);
    expect(detailText(body)).toContain('1초 경과');
    // 정리: 다른 파일로 이동한 것으로 만들어 부팅을 중단시킨다.
    setCurrent(false);
    await flush(2100);
    await p;
    expect(loadingEl(body)).toBeNull();
  });

  test('다시 시도 버튼을 누르면 부팅이 다시 시작된다', async () => {
    const { body, api, ctx, sdk, notes } = setupHwp();
    api.internals.bootAttemptTimeoutMs = 60;
    api.internals.bootRetryDelayMs = 10;
    api.internals.bootMaxAttempts = 3;
    api.internals.bootElapsedIntervalMs = 20;
    const editor = fakeEditor();
    // 처음 3번은 pending, 버튼 클릭 후 4번째는 성공.
    sdk.createEditor
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(() => Promise.resolve(editor));
    const p = api.handleHwp(ctx);
    const shown = await waitFor(() => !!body.querySelector('.myhub-hwp-boot-retry'));
    expect(shown).toBe(true);
    expect(sdk.createEditor).toHaveBeenCalledTimes(3);
    const btn = body.querySelector('.myhub-hwp-boot-retry') as any;
    btn.click();
    // 다시 시도 버튼은 부팅을 처음부터 다시 돌린다 (에러 카드 표시 시
    // 이미 resolve했으므로 p를 기다리는 게 아니라 에디터 오픈을 기다린다).
    const opened = await waitFor(() => notes.includes('한글 문서 쪽 편집 중'));
    expect(opened).toBe(true);
    expect(sdk.createEditor).toHaveBeenCalledTimes(4);
    expect(loadingEl(body)).toBeNull();
  });

  test('프리패치가 먼저 돌고 진행(MB)이 표시된 뒤 부팅이 진행된다', async () => {
    const { body, api, ctx, sdk, notes } = setupHwp();
    const editor = fakeEditor();
    sdk.createEditor.mockImplementation(() => Promise.resolve(editor));
    const seenStatus: string[] = [];
    const seenDetail: string[] = [];
    ctx.prefetchForBoot = jest.fn((opts: any) => {
      // 프리패치가 도는 동안에는 createEditor가 아직 안 불려야 한다.
      expect(sdk.createEditor).not.toHaveBeenCalled();
      opts.onProgress({ receivedBytes: 5 * 1048576, attempt: 1 });
      // 모듈이 DOM에 쓴 직후 값을 캡처한다 (부팅이 시작되면 덮어쓴다).
      seenStatus.push(statusText(body));
      seenDetail.push(detailText(body));
      return Promise.resolve({ done: [], failed: [], stalled: [], receivedBytes: 5 * 1048576 });
    });
    const p = api.handleHwp(ctx);
    await p;
    expect(ctx.prefetchForBoot).toHaveBeenCalledTimes(1);
    expect(sdk.createEditor).toHaveBeenCalledTimes(1);
    expect(seenStatus).toEqual(['한글 엔진 받는 중… 5.0MB']);
    expect(seenDetail[0]).toContain('5.0MB 받음');
    expect(notes).toContain('한글 문서 쪽 편집 중');
  });

  test('프리패치가 실패하면 에러 카드가 뜨고 다시 시도 버튼이 프리패치부터 다시 돈다', async () => {
    const { body, api, ctx, sdk, notes } = setupHwp();
    const editor = fakeEditor();
    sdk.createEditor.mockImplementation(() => Promise.resolve(editor));
    let prefetchCalls = 0;
    ctx.prefetchForBoot = jest.fn(() => {
      prefetchCalls += 1;
      if (prefetchCalls === 1) return Promise.reject(new Error('stall'));
      return Promise.resolve({ done: [], failed: [], stalled: [], receivedBytes: 0 });
    });
    const p = api.handleHwp(ctx);
    const shown = await waitFor(() => !!body.querySelector('.myhub-hwp-boot-retry'));
    expect(shown).toBe(true);
    expect(prefetchCalls).toBe(1);
    // 프리패치가 실패했으니 부팅은 시작도 안 했다.
    expect(sdk.createEditor).not.toHaveBeenCalled();
    const btn = body.querySelector('.myhub-hwp-boot-retry') as any;
    btn.click();
    // 다시 시도 버튼은 프리패치부터 다시 돌린다 (에러 카드 표시 시 이미
    // resolve했으므로 p를 기다리는 게 아니라 에디터 오픈을 기다린다).
    const opened = await waitFor(() => notes.includes('한글 문서 쪽 편집 중'));
    expect(opened).toBe(true);
    expect(prefetchCalls).toBe(2);
    expect(sdk.createEditor).toHaveBeenCalledTimes(1);
    expect(loadingEl(body)).toBeNull();
  });

  test('프리패치 모듈이 없으면 건너뛰고 기존 부팅으로 간다', async () => {
    const { body, api, ctx, sdk, notes } = setupHwp();
    const win = getWin();
    delete win.MyHubRhwpPrefetch;
    const editor = fakeEditor();
    sdk.createEditor.mockImplementation(() => Promise.resolve(editor));
    const p = api.handleHwp(ctx);
    await p;
    expect(sdk.createEditor).toHaveBeenCalledTimes(1);
    expect(notes).toContain('한글 문서 쪽 편집 중');
    expect(loadingEl(body)).toBeNull();
  });
});
