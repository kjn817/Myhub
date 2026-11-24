/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 오피스 PDF 창의 제목 줄 다듬기 (2026-11-21, 사용자 캡처 지적).
 *
 * 문제: PDF 편집기가 뜨고 보니 제목 줄과 탭 줄이 부자연스럽다.
 * 셸 제목 줄(흰색 40px, 가운데 문서명)과 엔진의 자체 문서 탭 줄
 * (회색 #e9e9eb 39px, 같은 문서명을 탭으로 표시)이 겹쳐 흰-회-흰
 * 3단 띠가 되고 문서명이 두 번 보인다. 크롬은 신호등과 탭이 한 줄이고
 * 탭이 곧 제목이라 자연스럽다.
 *
 * 다듬기:
 * - PDF 창의 제목 줄 배경을 엔진 탭 줄과 같은 #e9e9eb로 — 두 줄이
 *   하나의 탭 바 영역으로 읽히고, 흰 선택 탭이 아래 흰 메뉴 줄과
 *   이어진다 (크롬 탭 방식). 다른 오피스 앱은 엔진 탭 줄이 없어
 *   흰 제목 줄이 그대로 맞다.
 * - 편집기가 펼쳐져 있을 때(엔진 탭 줄이 문서명을 표시) 제목 줄의
 *   문서명을 비운다 — 접힌 상태(뷰어, 탭 줄 없음)나 접기 상태를
 *   아직 모를 때는 제목을 표시한다. 저장 안 된 변경 점은 그대로 둔다.
 * - PDF 창에는 접기 버튼을 그리지 않는다 (2026-11-21 사용자 지시):
 *   접으면 이전 엔진(뷰어)이 나와 이상하다 — PDF는 편집기만 쓴다.
 *   접기 상태 자체는 유지한다 (폴백 때 제목 표시 판단에 쓴다).
 *
 * 검증 성질:
 * - desktop.css에 PDF 전용 제목 줄 규칙이 있고 배경이 #e9e9eb이며,
 *   오피스 흰색 규칙보다 명시도가 높아(또는 뒤에 있어) 이긴다.
 * - PDF 창: 문서명 통지 후 접기 상태 모름 → 제목 표시 / 펼침 통지 →
 *   제목 비움 / 접힘 통지 → 제목 복원 / 저장 점은 펼침에도 유지.
 * - Excel 창: 펼침 통지에도 제목이 그대로 표시된다 (PDF 전용).
 *
 * 카나리아: paintDocTitle의 PDF 분기를 빼면 펼침 테스트가 실패하고,
 * CSS 규칙을 빼면 배경 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const STATE_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'state.js'), 'utf-8')
const TILES_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'tiles.js'), 'utf-8')
const MENU_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'menu.js'), 'utf-8')
const DOCK_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'dock.js'), 'utf-8')
const ANIM_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'common', 'anim.js'), 'utf-8')
const MENU_ITEMS_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'common', 'menu-items.js'), 'utf-8')
const CONSTANTS_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'common', 'constants.js'), 'utf-8')
const WINDOWS_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'windows.js'), 'utf-8')
const DESKTOP_CSS = fs.readFileSync(path.join(ROOT, 'public', 'css', 'desktop.css'), 'utf-8')

const VIEWPORT = { w: 1280, h: 800 }

function getWin(): any {
  return (globalThis as any).window
}
function getDoc(): any {
  return (globalThis as any).document
}

class MemoryStorage {
  store: Record<string, string> = {}
  getItem(k: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null
  }
  setItem(k: string, v: string): void {
    this.store[k] = String(v)
  }
}

let manager: any = null

function setupShell() {
  const doc = getDoc()
  doc.body.innerHTML = `
<header class="g-nav">
  <a href="/" class="brand-logo">JN</a>
  <button type="button" id="dt-active-title" class="dt-active-title"></button>
  <div id="dt-app-actions"></div>
  <div id="dt-office-tabs"></div>
  <div class="spacer"></div>
  <div id="dt-bar-assistant"></div>
  <span class="ver" id="clock"></span>
</header>
<div id="dt-wallpaper"></div>
<div id="dt-wp-caption"></div>
<div id="dt-icons"></div>
<div id="dt-widgets"></div>
<main id="dt-root"></main>
<div id="dt-mission"></div>
<nav id="dt-dock"></nav>`
  return { root: doc.getElementById('dt-root'), taskbar: doc.getElementById('dt-dock') }
}

function loadStateApi(): any {
  const loader = new Function('window', 'document', STATE_JS)
  loader(getWin(), getDoc())
  return getWin().MyHubDesktopState
}

function loadDesktopGlobals(): void {
  new Function('window', 'document', CONSTANTS_JS)(getWin(), getDoc())
  new Function('window', 'document', ANIM_JS)(getWin(), getDoc())
  new Function('window', 'document', MENU_ITEMS_JS)(getWin(), getDoc())
  new Function('window', 'document', TILES_JS)(getWin(), getDoc())
  new Function('window', 'document', MENU_JS)(getWin(), getDoc())
  new Function('window', 'document', DOCK_JS)(getWin(), getDoc())
}

function loadWindowsApi(): any {
  const loader = new Function('window', 'document', WINDOWS_JS)
  loader(getWin(), getDoc())
  return getWin().MyHubDesktopWindows
}

function makeManager(storage: MemoryStorage): any {
  const { root, taskbar } = setupShell()
  const stateApi = loadStateApi()
  loadDesktopGlobals()
  const windowsApi = loadWindowsApi()
  const doc = getDoc()
  manager = windowsApi.createManager({
    root,
    taskbar,
    stateApi,
    storage,
    getViewport: () => ({ ...VIEWPORT }),
    state: stateApi.load(storage, { ...VIEWPORT }),
    activeTitleEl: doc.getElementById('dt-active-title'),
    appActionsEl: doc.getElementById('dt-app-actions'),
    officeTabsEl: doc.getElementById('dt-office-tabs'),
    missionEl: doc.getElementById('dt-mission'),
    navApi: getWin().MyHubNav || null,
    wallpaperEl: doc.getElementById('dt-wallpaper'),
    menuApi: getWin().MyHubDesktopMenu || null,
  })
  return manager
}

afterEach(() => {
  manager = null
})

function winEl(id: string): any {
  return getDoc().querySelector(`.dt-window[data-id="${id}"]`)
}

function postToFrame(frame: any, data: any): void {
  const ev = new (getWin().MessageEvent)('message', {
    data,
    origin: getWin().location.origin,
    source: frame.contentWindow,
  } as any)
  getWin().dispatchEvent(ev)
}

function titleText(id: string): string {
  const el = winEl(id).querySelector('.dt-title-text')
  return el ? el.textContent : ''
}

function dotHidden(id: string): boolean {
  const el = winEl(id).querySelector('.dt-title-dot')
  return el ? !!el.hidden : true
}

describe('PDF 제목 줄 — 엔진 탭 줄과 한 면으로 (CSS)', () => {
  test('PDF 전용 제목 줄 규칙이 있고 배경이 엔진 탭 줄과 같은 #e9e9eb이다', () => {
    expect(DESKTOP_CSS).toContain('[data-module="pdf"] .dt-titlebar')
    // 규칙 본문에서 배경 값을 뽑아 확인한다 (문자열 존재만이 아니다).
    const m = DESKTOP_CSS.match(
      /\.dt-window\.dt-win-office\[data-module="pdf"\][^{]*\{[^}]*background:\s*(#[0-9a-fA-F]{6})/,
    )
    expect(m).not.toBeNull()
    expect(m![1].toLowerCase()).toBe('#e9e9eb')
  })

  test('PDF 규칙이 오피스 흰색 규칙보다 뒤에 있어 동점에서도 이긴다', () => {
    const whiteIdx = DESKTOP_CSS.indexOf(
      '.dt-window.dt-win-office.is-active .dt-titlebar',
    )
    const pdfIdx = DESKTOP_CSS.indexOf('[data-module="pdf"] .dt-titlebar')
    expect(whiteIdx).toBeGreaterThanOrEqual(0)
    expect(pdfIdx).toBeGreaterThan(whiteIdx)
  })

  test('다른 오피스 앱의 흰 제목 줄 규칙은 그대로 있다', () => {
    expect(DESKTOP_CSS).toContain(
      '.dt-window.dt-win-office.is-active .dt-titlebar {\n  background: #ffffff;',
    )
  })
})

describe('PDF 제목 줄 — 펼침 때 문서명 중복 제거 (windows.js)', () => {
  test('접기 상태를 모를 때는 제목을 표시한다', () => {
    const m = makeManager(new MemoryStorage())
    m.openModule('pdf')
    const frame = winEl('pdf').querySelector('iframe.dt-frame')
    postToFrame(frame, { type: 'myhub:doc-title', name: '제목 없음.pdf' })
    expect(titleText('pdf')).toBe('제목 없음.pdf')
  })

  test('편집기 펼침 통지가 오면 제목을 비운다 (탭 줄에 이름이 있다)', () => {
    const m = makeManager(new MemoryStorage())
    m.openModule('pdf')
    const frame = winEl('pdf').querySelector('iframe.dt-frame')
    postToFrame(frame, { type: 'myhub:doc-title', name: '제목 없음.pdf' })
    expect(titleText('pdf')).toBe('제목 없음.pdf')
    postToFrame(frame, {
      type: 'myhub:office-fold',
      app: 'pdf',
      available: true,
      folded: false,
    })
    expect(titleText('pdf')).toBe('')
  })

  test('접힘 통지가 오면 제목이 다시 보인다 (뷰어에는 탭 줄이 없다)', () => {
    const m = makeManager(new MemoryStorage())
    m.openModule('pdf')
    const frame = winEl('pdf').querySelector('iframe.dt-frame')
    postToFrame(frame, { type: 'myhub:doc-title', name: '제목 없음.pdf' })
    postToFrame(frame, {
      type: 'myhub:office-fold',
      app: 'pdf',
      available: true,
      folded: false,
    })
    expect(titleText('pdf')).toBe('')
    postToFrame(frame, {
      type: 'myhub:office-fold',
      app: 'pdf',
      available: true,
      folded: true,
    })
    expect(titleText('pdf')).toBe('제목 없음.pdf')
  })

  test('펼침에도 저장 안 된 변경 점은 그대로 보인다', () => {
    const m = makeManager(new MemoryStorage())
    m.openModule('pdf')
    const frame = winEl('pdf').querySelector('iframe.dt-frame')
    postToFrame(frame, { type: 'myhub:doc-title', name: '제목 없음.pdf', dirty: true })
    expect(dotHidden('pdf')).toBe(false)
    postToFrame(frame, {
      type: 'myhub:office-fold',
      app: 'pdf',
      available: true,
      folded: false,
    })
    expect(titleText('pdf')).toBe('')
    expect(dotHidden('pdf')).toBe(false)
  })

  test('Excel 창은 펼침 통지에도 제목이 그대로 표시된다 (PDF 전용)', () => {
    const m = makeManager(new MemoryStorage())
    m.openModule('excel')
    const frame = winEl('excel').querySelector('iframe.dt-frame')
    postToFrame(frame, { type: 'myhub:doc-title', name: '예산.xlsx' })
    postToFrame(frame, {
      type: 'myhub:office-fold',
      app: 'excel',
      available: true,
      folded: false,
    })
    expect(titleText('excel')).toBe('예산.xlsx')
  })
})

describe('PDF 창 — 접기 버튼 없음 (windows.js)', () => {
  function foldButton(id: string): any {
    return winEl(id).querySelector('.myhub-win-fold')
  }
  function quickActions(id: string): string[] {
    return Array.from(
      winEl(id).querySelectorAll('.myhub-win-quick .myhub-oq-btn[data-oq-action]'),
    ).map((b: any) => b.getAttribute('data-oq-action'))
  }

  test('PDF 창은 접기 가능 통지가 와도 접기 버튼을 그리지 않는다', () => {
    const m = makeManager(new MemoryStorage())
    m.openModule('pdf')
    const frame = winEl('pdf').querySelector('iframe.dt-frame')
    postToFrame(frame, {
      type: 'myhub:office-fold',
      app: 'pdf',
      available: true,
      folded: false,
    })
    expect(foldButton('pdf')).toBeNull()
  })

  test('PDF 창은 접기 버튼 없이 저장·인쇄 빠른 실행은 그대로 그린다', () => {
    const m = makeManager(new MemoryStorage())
    m.openModule('pdf')
    const frame = winEl('pdf').querySelector('iframe.dt-frame')
    postToFrame(frame, {
      type: 'myhub:office-fold',
      app: 'pdf',
      available: true,
      folded: false,
    })
    postToFrame(frame, {
      type: 'myhub:office-quick',
      quick: { save: true, print: true },
    })
    expect(foldButton('pdf')).toBeNull()
    expect(quickActions('pdf')).toEqual(['save', 'print'])
  })

  test('Excel 창은 접기 버튼이 그대로 그려진다 (PDF 전용)', () => {
    const m = makeManager(new MemoryStorage())
    m.openModule('excel')
    const frame = winEl('excel').querySelector('iframe.dt-frame')
    postToFrame(frame, {
      type: 'myhub:office-fold',
      app: 'excel',
      available: true,
      folded: false,
    })
    expect(foldButton('excel')).not.toBeNull()
    expect(foldButton('excel').getAttribute('data-fold-state')).toBe('open')
  })
})

describe('PDF 창 — 제목 줄 정보·검색 빠른 실행 (windows.js, 2026-11-22)', () => {
  function quickActions(id: string): string[] {
    return Array.from(
      winEl(id).querySelectorAll('.myhub-win-quick .myhub-oq-btn[data-oq-action]'),
    ).map((b: any) => b.getAttribute('data-oq-action'))
  }

  test('PDF 창은 저장·인쇄·정보·검색 빠른 실행을 순서대로 그린다', () => {
    const m = makeManager(new MemoryStorage())
    m.openModule('pdf')
    const frame = winEl('pdf').querySelector('iframe.dt-frame')
    postToFrame(frame, {
      type: 'myhub:office-quick',
      quick: { save: true, print: true, info: true, palette: true },
    })
    expect(quickActions('pdf')).toEqual(['save', 'print', 'info', 'palette'])
    const infoBtn = winEl('pdf').querySelector('.myhub-oq-btn[data-oq-action="info"]')
    expect(infoBtn.getAttribute('aria-label')).toBe('문서 속성')
    const paletteBtn = winEl('pdf').querySelector('.myhub-oq-btn[data-oq-action="palette"]')
    expect(paletteBtn.getAttribute('aria-label')).toBe('도구 및 명령 찾기')
  })

  test('정보·검색 버튼 클릭은 동작을 모듈 프레임에 보낸다', () => {
    const m = makeManager(new MemoryStorage())
    m.openModule('pdf')
    const frame = winEl('pdf').querySelector('iframe.dt-frame')
    postToFrame(frame, {
      type: 'myhub:office-quick',
      quick: { info: true, palette: true },
    })
    const posts: any[] = []
    const cw: any = frame.contentWindow
    const orig = cw.postMessage
    cw.postMessage = (msg: any) => {
      posts.push(msg)
    }
    try {
      winEl('pdf').querySelector('.myhub-oq-btn[data-oq-action="info"]').click()
      winEl('pdf').querySelector('.myhub-oq-btn[data-oq-action="palette"]').click()
    } finally {
      cw.postMessage = orig
    }
    expect(posts).toContainEqual({ type: 'myhub:office-quick-action', action: 'info' })
    expect(posts).toContainEqual({ type: 'myhub:office-quick-action', action: 'palette' })
  })

  test('빠른 실행이 꺼지면 정보·검색 버튼도 사라진다', () => {
    const m = makeManager(new MemoryStorage())
    m.openModule('pdf')
    const frame = winEl('pdf').querySelector('iframe.dt-frame')
    postToFrame(frame, {
      type: 'myhub:office-quick',
      quick: { info: true, palette: true },
    })
    expect(quickActions('pdf')).toEqual(['info', 'palette'])
    postToFrame(frame, {
      type: 'myhub:office-quick',
      quick: null,
    })
    expect(quickActions('pdf')).toEqual([])
  })
})

describe('PDF 창 — JN 상단바 모드 탭·메뉴 (windows.js, 2026-11-22)', () => {
  function officeTabButtons(): any[] {
    return Array.from(
      getDoc().querySelectorAll('#dt-office-tabs .dt-office-tab'),
    )
  }

  function postTabs(frame: any) {
    postToFrame(frame, {
      type: 'myhub:office-tabs',
      app: 'pdf',
      tabs: [
        { id: 'menu:file', label: '파일', kind: 'menu' },
        { id: 'sep:menus-modes', label: '', kind: 'separator' },
        { id: 'all', label: '모든 도구', kind: 'tab' },
        { id: 'edit', label: '편집', kind: 'tab' },
        { id: 'convert', label: '변환', kind: 'tab' },
        { id: 'sign', label: '전자 서명', kind: 'tab' },
      ],
      activeId: 'edit',
      collapsed: false,
      canCollapse: false,
      menuShell: true,
      menuLocal: true,
    })
  }

  test('상단바에 메뉴·모드 탭이 그려지고 현재 모드가 활성화된다', () => {
    const m = makeManager(new MemoryStorage())
    m.openModule('pdf')
    const frame = winEl('pdf').querySelector('iframe.dt-frame')
    postTabs(frame)
    const labels = officeTabButtons().map((b: any) =>
      b.querySelector('.dt-office-tab-label')?.textContent ?? '',
    )
    expect(labels).toEqual(['파일', '', '모든 도구', '편집', '변환', '전자 서명'])
    const active = officeTabButtons().filter((b: any) =>
      b.classList.contains('is-active'),
    )
    expect(active.length).toBe(1)
    expect(active[0].getAttribute('data-tab')).toBe('edit')
  })

  test('모드 탭 클릭은 select를 모듈에 보낸다', () => {
    const m = makeManager(new MemoryStorage())
    m.openModule('pdf')
    const frame = winEl('pdf').querySelector('iframe.dt-frame')
    postTabs(frame)
    const posts: any[] = []
    const cw: any = frame.contentWindow
    const orig = cw.postMessage
    cw.postMessage = (msg: any) => {
      posts.push(msg)
    }
    try {
      const btn = getDoc().querySelector(
        '#dt-office-tabs .dt-office-tab[data-tab="convert"]',
      )
      btn.click()
    } finally {
      cw.postMessage = orig
    }
    expect(posts).toContainEqual({
      type: 'myhub:office-tabs-select',
      app: 'pdf',
      id: 'convert',
    })
  })
})
