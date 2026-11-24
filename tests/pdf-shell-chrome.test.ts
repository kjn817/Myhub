/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
// 모듈 스코프 선언: import/export가 없어 두 테스트 파일이 전역
// 스코프를 공유해 동명 선언이 TS2451 충돌을 냈다.
export {};
/**
 * PDF 셸 크롬 통합 (2026-11-22, 사용자 결정: 메뉴 줄 정리).
 *
 * 창에는 제목 줄+탭 줄만 남기고 엔진 모드바 행은 통째로 없앤다
 * (chrome=nomodebar,noabsorb). 모드 탭(모든 도구·편집·변환·전자 서명)
 * 과 전통 메뉴(파일·편집·보기·서명·창·도움말)는 셸 JN 상단바로,
 * 검색(도구 및 명령 찾기)·정보(문서 속성)·저장·인쇄는 제목 줄 빠른
 * 실행으로 옮긴다.
 *
 * 검증 성질:
 * - office-tabs tabsToShell 계약: 플래그가 켜지면 셸에 모드 탭(kind
 *   'tab')과 구분선까지 게시하고, 셸이 채택하면 로컬 탭 행에서 모드
 *   탭도 그리지 않는다 (이중 표시 방지). 플래그가 꺼지면 종전대로
 *   메뉴만 게시한다.
 * - office-tabs 빠른 실행: info·palette가 허용 동작이다 (setQuick
 *   게시·onQuick 디스패치 모두).
 * - PDF 호스트: 편집기 준비 후 모드 탭+메뉴를 게시하고(tabsToShell),
 *   모드 상태가 오면 activeId가 따라가며, 메뉴 상태가 오면 메뉴 탭+
 *   구분선이 붙는다. 상단바 선택은 sendMode로, 메뉴 요청·실행은
 *   provideMenuItems·sendMenuCommand으로, 빠른 실행은 엔진 메뉴
 *   명령(file.save·print.dialog·file.properties·view.palette)으로 간다.
 * - Finder(minimalChrome 아님)는 chrome 벗긴 URL을 쓰지 않고
 *   메뉴·모드를 게시하지 않는다.
 *
 * 카나리아: tabsToShell 게시 범위를 메뉴만으로 되돌리면 상단바 게시
 * 테스트가 실패하고, publishModeTabs의 MODE_TABS 연결을 빼면 모드 탭
 * 테스트가 실패하며, onQuick의 info·palette 분기를 빼면 빠른 실행
 * 테스트가 실패한다.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../public/js/common/constants.js')
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../public/js/finder-codec.js')
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../public/js/finder-pdf-ops.js')
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../public/js/finder-viewer.js')

const scWin: any = (globalThis as any).window
const scDoc: any = (globalThis as any).document

const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms))

// ---------- office-tabs tabsToShell 계약 ----------

describe('office-tabs tabsToShell 계약 (2026-11-22)', () => {
  function loadTabs(): any {
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../public/js/office-tabs.js')
  }

  function fakeWin() {
    const posts: any[] = []
    let handler: any = null
    const win: any = {
      location: { origin: 'http://localhost' },
      parent: {
        postMessage: (msg: any) => {
          posts.push(msg)
        },
      },
      addEventListener: (type: string, fn: any) => {
        if (type === 'message') handler = fn
      },
      frameElement: null,
    }
    return {
      win,
      posts,
      send: (data: any) =>
        handler && handler({ origin: 'http://localhost', data }),
    }
  }

  function mountTabs(api: any, f: any) {
    const rootEl = scDoc.createElement('div')
    scDoc.body.appendChild(rootEl)
    api.mount({ doc: scDoc, win: f.win, appKey: 'pdf', rootEl })
    return rootEl
  }

  const TABS = [
    { id: 'menu:file', label: '파일', kind: 'menu' },
    { id: 'sep:menus-modes', label: '', kind: 'separator' },
    { id: 'all', label: '모든 도구', kind: 'tab' },
    { id: 'edit', label: '편집', kind: 'tab' },
  ]

  beforeEach(() => {
    scDoc.body.innerHTML = ''
  })

  test('tabsToShell이면 셸에 메뉴·구분선·모드 탭을 모두 게시한다', () => {
    const api = loadTabs()
    const f = fakeWin()
    mountTabs(api, f)
    api.setState('pdf', {
      tabs: TABS,
      activeId: 'edit',
      tabsToShell: true,
      menuShell: true,
      menuLocal: true,
    })
    const posted = f.posts.filter((p: any) => p.type === 'myhub:office-tabs')
    expect(posted.length).toBeGreaterThan(0)
    const last = posted[posted.length - 1]
    expect(last.tabs.map((t: any) => t.id)).toEqual([
      'menu:file',
      'sep:menus-modes',
      'all',
      'edit',
    ])
    expect(last.activeId).toBe('edit')
  })

  test('tabsToShell이 없으면 셸에 메뉴만 게시한다 (종전 동작)', () => {
    const api = loadTabs()
    const f = fakeWin()
    mountTabs(api, f)
    api.setState('pdf', {
      tabs: TABS,
      activeId: 'edit',
      menuShell: true,
      menuLocal: true,
    })
    const posted = f.posts.filter((p: any) => p.type === 'myhub:office-tabs')
    const last = posted[posted.length - 1]
    expect(last.tabs.map((t: any) => t.id)).toEqual(['menu:file'])
  })

  test('셸이 채택하면 로컬 탭 행에서 모드 탭도 사라진다', () => {
    const api = loadTabs()
    const f = fakeWin()
    const rootEl = mountTabs(api, f)
    api.setState('pdf', {
      tabs: TABS,
      activeId: 'edit',
      tabsToShell: true,
      menuShell: true,
      menuLocal: true,
    })
    // 채택 전에는 모드 탭이 로컬 행에 그려진다.
    expect(rootEl.querySelector('[data-tab-id="edit"]')).not.toBeNull()
    f.send({ type: 'myhub:office-tabs-adopt', app: 'pdf' })
    // 채택 후에는 모드 탭·메뉴·구분선이 모두 사라져 행이 숨겨진다.
    expect(rootEl.querySelector('[data-tab-id="edit"]')).toBeNull()
    expect(rootEl.querySelector('[data-tab-id="menu:file"]')).toBeNull()
    expect(rootEl.hidden).toBe(true)
  })

  test('tabsToShell 없이 채택하면 모드 탭은 로컬 행에 남는다', () => {
    const api = loadTabs()
    const f = fakeWin()
    const rootEl = mountTabs(api, f)
    api.setState('pdf', {
      tabs: TABS,
      activeId: 'edit',
      menuShell: true,
      menuLocal: true,
    })
    f.send({ type: 'myhub:office-tabs-adopt', app: 'pdf' })
    expect(rootEl.querySelector('[data-tab-id="edit"]')).not.toBeNull()
    expect(rootEl.querySelector('[data-tab-id="menu:file"]')).toBeNull()
  })

  test('info·palette는 허용된 빠른 실행 동작이다', () => {
    const api = loadTabs()
    const f = fakeWin()
    mountTabs(api, f)
    const seen: string[] = []
    api.onQuick('pdf', (action: string) => {
      seen.push(action)
      return true
    })
    api.setQuick('pdf', { info: true, palette: true })
    const posted = f.posts.filter((p: any) => p.type === 'myhub:office-quick')
    const last = posted[posted.length - 1]
    expect(last.quick).toEqual({ info: true, palette: true })
    f.send({ type: 'myhub:office-quick-action', action: 'info' })
    f.send({ type: 'myhub:office-quick-action', action: 'palette' })
    expect(seen).toEqual(['info', 'palette'])
  })
})

// ---------- PDF 호스트 게시·실행 ----------

// 가짜 PdfCraft 브리지 — 모듈 로드 전에 window에 올려야 한다
// (finder-format-pdf.js가 로드 때 읽는다).
let craftOpts: any = null
const sendMode = jest.fn(() => true)
const sendMenuCommand = jest.fn(() => true)
const craftOpen = jest.fn(() => true)
const createHost = jest.fn((opts: any) => {
  craftOpts = opts
  return {
    frame: scDoc.createElement('div'),
    destroy: jest.fn(),
    open: craftOpen,
    sendMode,
    sendMenuCommand,
  }
})
scWin.MyHubFinderPdfCraft = {
  createHost,
  APP_URL_HOSTED:
    '/vendor/pdfcraft/index.html?host=parent&chrome=nomodebar,noabsorb',
}
const fontsLoad = jest.fn()
scWin.MyHubFonts = { load: fontsLoad }

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfFormat = require('../public/js/finder-format-pdf.js')

describe('PDF 호스트 메뉴·모드 게시 (2026-11-22)', () => {
  let bodyEl: any
  let current = true
  let folded = false
  let cmdHandler: any = null
  let quickHandler: any = null
  const setState = jest.fn()
  const setQuick = jest.fn()
  const provideMenuItems = jest.fn()

  function installTabsFake() {
    scWin.MyHubOfficeTabs = {
      setState,
      setQuick,
      provideMenuItems,
      onCommand: (_app: string, fn: any) => {
        cmdHandler = fn
      },
      onQuick: (_app: string, fn: any) => {
        quickHandler = fn
      },
    }
  }

  function makeCtx(minimalChrome = true) {
    bodyEl = scDoc.createElement('div')
    scDoc.body.appendChild(bodyEl)
    return {
      doc: scDoc,
      body: bodyEl,
      file: { fileId: 5, name: '문서.pdf' },
      minimalChrome,
      chromeFold: null,
      saveBtn: scDoc.createElement('button'),
      clearBody: () => {
        bodyEl.innerHTML = ''
      },
      contentUrl: () => '/api/drive/files/5/content',
      fetchContent: jest.fn(() => Promise.resolve(new ArrayBuffer(0))),
      fetchRaw: jest.fn(() => Promise.resolve({ ok: true })),
      isCurrent: () => current,
      isFolded: () => folded,
      setNote: jest.fn(),
      setStatus: jest.fn(),
      markDirty: jest.fn(),
      setSaveHandler: jest.fn(),
      onFoldChange: jest.fn(),
      requestOpen: jest.fn(),
      putContent: jest.fn(() => Promise.resolve(true)),
      saveAsContent: jest.fn(() => Promise.resolve(true)),
      showMessage: jest.fn(),
    }
  }

  beforeEach(() => {
    scDoc.body.innerHTML = ''
    current = true
    folded = false
    craftOpts = null
    cmdHandler = null
    quickHandler = null
    jest.clearAllMocks()
    installTabsFake()
  })

  afterEach(() => {
    current = false
  })

  async function mountReady() {
    const ctx = makeCtx(true)
    await pdfFormat.handlePdf(ctx)
    expect(createHost).toHaveBeenCalledTimes(1)
    expect(craftOpts.url).toContain('chrome=nomodebar,noabsorb')
    craftOpts.onReady()
    await flush(10)
    return ctx
  }

  function lastState() {
    const calls = setState.mock.calls
    return calls[calls.length - 1][1]
  }

  test('편집기 준비 후 모드 탭을 상단바에 게시한다 (tabsToShell)', async () => {
    await mountReady()
    const st = lastState()
    expect(st.tabs.map((t: any) => t.id)).toEqual([
      'all',
      'edit',
      'convert',
      'sign',
    ])
    expect(st.tabsToShell).toBe(true)
    expect(st.activeId).toBeNull()
    // 제목 줄 빠른 실행: 인쇄·저장·정보·검색이 모두 켜진다.
    expect(setQuick).toHaveBeenCalledWith('pdf', {
      print: true,
      save: true,
      info: true,
      palette: true,
    })
  })

  test('모드 상태가 오면 activeId가 따라간다', async () => {
    await mountReady()
    craftOpts.onModeState('edit')
    expect(lastState().activeId).toBe('edit')
    craftOpts.onModeState('sign')
    expect(lastState().activeId).toBe('sign')
  })

  test('메뉴 상태가 오면 메뉴 탭+구분선이 모드 탭 앞에 붙는다', async () => {
    await mountReady()
    craftOpts.onMenusState([
      { id: 'file', label: '파일', items: [] },
      { id: 'view', label: '보기', items: [] },
    ])
    const st = lastState()
    expect(st.tabs.map((t: any) => t.id)).toEqual([
      'menu:file',
      'menu:view',
      'sep:menus-modes',
      'all',
      'edit',
      'convert',
      'sign',
    ])
    expect(st.menuShell).toBe(true)
    expect(st.menuLocal).toBe(true)
  })

  test('상단바 모드 탭 선택은 sendMode로 간다 (메뉴·구분선은 제외)', async () => {
    await mountReady()
    expect(typeof cmdHandler).toBe('function')
    cmdHandler({ type: 'select', id: 'convert' })
    expect(sendMode).toHaveBeenCalledWith('convert')
    cmdHandler({ type: 'select', id: 'menu:file' })
    cmdHandler({ type: 'select', id: 'sep:menus-modes' })
    expect(sendMode).toHaveBeenCalledTimes(1)
  })

  test('메뉴 요청·실행은 엔진 메뉴 명령 채널을 탄다', async () => {
    await mountReady()
    craftOpts.onMenusState([
      {
        id: 'file',
        label: '파일',
        items: [
          { command: 'file.save', label: '저장' },
          { separator: true },
          {
            label: '내보내기',
            items: [{ command: 'file.export', label: '이미지로' }],
          },
        ],
      },
    ])
    cmdHandler({ type: 'menu-request', id: 'menu:file', seq: 7 })
    expect(provideMenuItems).toHaveBeenCalledWith(
      'pdf',
      'menu:file',
      [
        { label: '저장', disabled: false, path: [0], command: 'file.save' },
        { separator: true, path: [1] },
        {
          label: '내보내기',
          disabled: false,
          path: [2],
          children: [
            {
              label: '이미지로',
              disabled: false,
              path: [2, 0],
              command: 'file.export',
            },
          ],
        },
      ],
      7,
    )
    cmdHandler({ type: 'menu-exec', id: 'menu:file', path: [0] })
    expect(sendMenuCommand).toHaveBeenCalledWith('file.save', undefined)
    cmdHandler({ type: 'menu-exec', id: 'menu:file', path: [2, 0] })
    expect(sendMenuCommand).toHaveBeenCalledWith('file.export', undefined)
  })

  test('제목 줄 빠른 실행은 엔진 메뉴 명령으로 간다', async () => {
    await mountReady()
    expect(typeof quickHandler).toBe('function')
    expect(quickHandler('save')).toBe(true)
    expect(sendMenuCommand).toHaveBeenCalledWith('file.save')
    expect(quickHandler('print')).toBe(true)
    expect(sendMenuCommand).toHaveBeenCalledWith('print.dialog')
    expect(quickHandler('info')).toBe(true)
    expect(sendMenuCommand).toHaveBeenCalledWith('file.properties')
    expect(quickHandler('palette')).toBe(true)
    expect(sendMenuCommand).toHaveBeenCalledWith('view.palette')
    expect(quickHandler('undo')).toBe(false)
  })

  test('Finder는 벗긴 URL을 쓰지 않고 게시하지 않는다', async () => {
    const ctx = makeCtx(false)
    await pdfFormat.handlePdf(ctx)
    expect(createHost).toHaveBeenCalledTimes(1)
    expect(craftOpts.url).toBeUndefined()
    craftOpts.onReady()
    await flush(10)
    expect(setState).not.toHaveBeenCalled()
    expect(setQuick).not.toHaveBeenCalled()
  })

  test('정보·팔레트 빠른 실행 후 엔진 캔버스까지 포커스가 간다 (2026-11-25)', async () => {
    // 포커스가 셸 버튼에 남아 있으면 Escape이 엔진에 안 닿아 대화상자가
    // 닫히지 않는다 — 대화상자·팔레트를 여는 명령 뒤에는 엔진 캔버스까지
    // 포커스를 옮겨야 한다. iframe만 포커스하면 엔진 문서의 activeElement가
    // body라 키가 엔진에 안 닿는다 (실브라우저 실측). 저장·인쇄는 팝업을
    // 안 열므로 옮기지 않는다.
    await mountReady()
    const host = createHost.mock.results[0].value
    const focusSpy = jest.spyOn(host.frame, 'focus')
    const canvasFocus = jest.fn()
    Object.defineProperty(host.frame, 'contentDocument', {
      value: { querySelector: () => ({ focus: canvasFocus }) },
      configurable: true,
    })
    expect(quickHandler('info')).toBe(true)
    expect(focusSpy).toHaveBeenCalledTimes(1)
    expect(canvasFocus).toHaveBeenCalledTimes(1)
    expect(quickHandler('palette')).toBe(true)
    expect(focusSpy).toHaveBeenCalledTimes(2)
    expect(canvasFocus).toHaveBeenCalledTimes(2)
    expect(quickHandler('save')).toBe(true)
    expect(quickHandler('print')).toBe(true)
    expect(focusSpy).toHaveBeenCalledTimes(2)
    expect(canvasFocus).toHaveBeenCalledTimes(2)
  })

  test('craft 표면에서는 Finder 저장 버튼이 숨고 뷰어로 돌아오면 다시 보인다 (2026-11-25)', async () => {
    // 엔진에 저장 요청 채널이 없어 craft 표면의 Finder 저장 버튼은 안내만
    // 하고 저장을 못 한다 — craft 표면일 때는 숨기는 임시 조치다.
    const ctx = makeCtx(true)
    await pdfFormat.handlePdf(ctx)
    expect(ctx.saveBtn.hidden).toBe(false)
    craftOpts.onReady()
    await flush(10)
    expect(ctx.saveBtn.hidden).toBe(true)
    craftOpts.onFallback('timeout')
    await flush(10)
    expect(ctx.saveBtn.hidden).toBe(false)
  })
})
