/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 미션 컨트롤 — 실제 macOS 형태 회귀 (2026-11-10 개선)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - 오버레이를 열면 카드가 아니라 화면 맨 위 스페이스 바가 렌더된다:
 *   이름 라벨 나열 + 보고 있는 스페이스만 is-current(알약) + 우상단
 *   원형 + 버튼(aria-label '데스크톱 추가'). 구 카드 방식
 *   (.dt-mission-card/.dt-mission-stage)이 돌아오면 실패한다.
 * - #dt-mission에 is-open이 실제로 걸린다 (구 방식은 CSS display:none을
 *   풀 클래스가 없어 바가 화면에 뜰 수 없었다).
 * - 라벨 클릭 → 그 데스크톱으로 전환되고 오버레이가 닫힌다.
 * - + 버튼 클릭 → 데스크톱이 실제로 추가되고 오버레이는 열린 채
 *   라벨이 늘어난다.
 * - 창이 있는 스페이스에서는 실제 창이 스프레드(dt-mission-win +
 *   transform)되고 캡션이 붙는다. 빈 스페이스에서는 빈 상태 문구가
 *   실제 문구로 렌더된다 (전사 소실로 ''가 되면 실패한다).
 * - Esc로 닫힌다.
 * - CSS 계약: 바 60px·라벨 14px·알약 배경·+ 원형(border-radius 50%).
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const NAV_JS = read('public/nav.js')
const STATE_JS = read('public/js/desktop/state.js')
const TILES_JS = read('public/js/desktop/tiles.js')
const MENU_JS = read('public/js/desktop/menu.js')
const MENUBAR_JS = read('public/js/desktop/menubar.js')
const DOCK_JS = read('public/js/desktop/dock.js')
const WINDOWS_JS = read('public/js/desktop/windows.js')
const DESKTOP_CSS = read('public/css/desktop.css')

const VIEWPORT = { w: 1280, h: 800 }
const getWin = (): any => (globalThis as any).window
const getDoc = (): any => (globalThis as any).document

class MemoryStorage {
  store: Record<string, string> = {}
  getItem(k: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null
  }
  setItem(k: string, v: string): void {
    this.store[k] = String(v)
  }
}

function loadAll() {
  const win = getWin()
  const doc = getDoc()
  new Function('window', 'document', 'setInterval', NAV_JS)(win, doc, () => 0)
  new Function('window', 'document', STATE_JS)(win, doc)
  new Function('window', 'document', TILES_JS)(win, doc)
  new Function('window', 'document', MENU_JS)(win, doc)
  new Function('window', 'document', MENUBAR_JS)(win, doc)
  new Function('window', 'document', DOCK_JS)(win, doc)
  new Function('window', 'document', WINDOWS_JS)(win, doc)
  return win
}

function setupShell() {
  const doc = getDoc()
  doc.body.innerHTML = `
<header class="g-nav">
  <a href="/" class="brand-logo" aria-label="MyHub 홈"><img src="/icon-192.png" alt="JN"></a>
  <button type="button" id="dt-active-title" class="dt-active-title">데스크톱</button>
  <div id="dt-app-actions"></div>
  <div id="dt-office-tabs"></div>
  <div class="spacer"></div>
  <div id="dt-bar-assistant"></div>
  <span class="ver" id="clock"></span>
</header>
<main id="dt-surface">
  <div id="dt-wallpaper"></div>
  <div id="dt-wp-caption"></div>
  <div id="dt-icons"></div>
  <div id="dt-widgets"></div>
  <div id="dt-root"></div>
</main>
<div id="dt-mission"></div>
<nav id="dt-dock"></nav>`
}

function makeManager() {
  const win = loadAll()
  setupShell()
  const doc = getDoc()
  const storage = new MemoryStorage()
  const stateApi = win.MyHubDesktopState
  return win.MyHubDesktopWindows.createManager({
    root: doc.getElementById('dt-root'),
    taskbar: doc.getElementById('dt-dock'),
    stateApi,
    storage,
    getViewport: () => ({ ...VIEWPORT }),
    state: stateApi.load(storage, { ...VIEWPORT }),
    activeTitleEl: doc.getElementById('dt-active-title'),
    appActionsEl: doc.getElementById('dt-app-actions'),
    officeTabsEl: doc.getElementById('dt-office-tabs'),
    missionEl: doc.getElementById('dt-mission'),
    navApi: win.MyHubNav || null,
    wallpaperEl: doc.getElementById('dt-wallpaper'),
    menuApi: win.MyHubDesktopMenu || null,
  })
}

function click(el: any) {
  el.dispatchEvent(new (getWin().MouseEvent)('click', { bubbles: true, cancelable: true }))
}
function missionEl(): any {
  return getDoc().getElementById('dt-mission')
}
function labels(): any[] {
  return Array.from(getDoc().querySelectorAll('.dt-mission-label'))
}
function labelTexts(): string[] {
  return labels().map((n: any) => n.textContent.trim())
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('미션 컨트롤 — 스페이스 바 렌더', () => {
  test('열면 카드가 아니라 이름 라벨 바가 뜨고 is-open이 걸린다', () => {
    const m = makeManager()
    m.toggleMission()
    expect(m.isMissionOpen()).toBe(true)
    expect(missionEl().classList.contains('is-open')).toBe(true)
    expect(getDoc().querySelector('.dt-mission-bar')).not.toBeNull()
    expect(getDoc().querySelector('.dt-mission-card')).toBeNull()
    expect(getDoc().querySelector('.dt-mission-stage')).toBeNull()
    expect(labelTexts()).toEqual(['데스크톱 1'])
    expect(labels()[0].classList.contains('is-current')).toBe(true)
    const add = getDoc().querySelector('.dt-mission-add')
    expect(add).not.toBeNull()
    expect(add.getAttribute('aria-label')).toBe('데스크톱 추가')
  })

  test('딤 레이어는 바탕화면 표면 안에 있어 창 레이어를 덮지 않는다', () => {
    // #dt-surface는 fixed 스태킹 컨텍스트라 body에 둔 딤 레이어가
    // 창(#dt-root)까지 덮어 미리보기가 블러에 가려지고 클릭이
    // 가로막힌다. 표면 안(z1)이 정본 레이어링이다.
    const m = makeManager()
    m.toggleMission()
    const bg = getDoc().querySelector('.dt-mission-bg')
    expect(bg).not.toBeNull()
    expect(bg.parentElement.id).toBe('dt-surface')
    expect(bg.hidden).toBe(false)
  })

  test('스페이스가 3개면 라벨 3개가 순서대로 나열된다', async () => {
    const m = makeManager()
    m.addSpace()
    m.addSpace()
    m.toggleMission()
    expect(labelTexts()).toEqual(['데스크톱 1', '데스크톱 2', '데스크톱 3'])
    m.toggleMission()
    await wait(350)
    expect(missionEl().classList.contains('is-open')).toBe(false)
  })
})

describe('미션 컨트롤 — 전환과 추가', () => {
  test('라벨 클릭 → 그 데스크톱으로 전환되고 오버레이가 닫힌다', () => {
    const m = makeManager()
    m.addSpace() // 기존 계약: 추가하면 새 스페이스로 전환된다
    const spaces = m.getState().spaces.slice()
    m.switchSpace(spaces[0])
    expect(m.getState().activeSpace).toBe(spaces[0])
    m.toggleMission()
    click(labels()[1])
    expect(m.getState().activeSpace).toBe(spaces[1])
    expect(m.isMissionOpen()).toBe(false)
  })

  test('+ 버튼 → 데스크톱이 추가되고 오버레이는 열린 채 라벨이 늘어난다', () => {
    const m = makeManager()
    m.toggleMission()
    click(getDoc().querySelector('.dt-mission-add'))
    expect(m.getState().spaces.length).toBe(2)
    expect(m.isMissionOpen()).toBe(true)
    expect(labelTexts()).toEqual(['데스크톱 1', '데스크톱 2'])
  })

  test('Esc로 닫힌다', async () => {
    const m = makeManager()
    m.toggleMission()
    expect(m.isMissionOpen()).toBe(true)
    getDoc().dispatchEvent(
      new (getWin().KeyboardEvent)('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    expect(m.isMissionOpen()).toBe(false)
    await wait(350)
    expect(missionEl().classList.contains('is-open')).toBe(false)
  })
})

describe('미션 컨트롤 — 창 스프레드와 빈 상태', () => {
  test('창이 있으면 실제 창이 스프레드되고 캡션이 붙는다', () => {
    const m = makeManager()
    m.openModule('memo')
    m.toggleMission()
    const win = getDoc().querySelector('.dt-window')
    expect(win).not.toBeNull()
    expect(win.classList.contains('dt-mission-win')).toBe(true)
    expect(win.style.transform).toContain('translate')
    const cap = getDoc().querySelector('.dt-mission-caption')
    expect(cap).not.toBeNull()
    expect(cap.textContent).toBe('메모')
    expect(getDoc().querySelector('.dt-mission-empty')).toBeNull()
  })

  test('빈 스페이스에서는 빈 상태 문구가 실제 문구로 렌더된다', () => {
    const m = makeManager()
    m.addSpace()
    const spaces = m.getState().spaces.slice()
    m.switchSpace(spaces[1])
    m.toggleMission()
    const empty = getDoc().querySelector('.dt-mission-empty')
    expect(empty).not.toBeNull()
    expect(empty.textContent).toBe('이 데스크톱에는 열린 창이 없어요')
  })
})

describe('미션 컨트롤 — CSS 계약 (실제 맥 실측값)', () => {
  test('스페이스 바 60px·라벨 14px·알약 배경·+ 원형이다', () => {
    const bar = DESKTOP_CSS.match(/\.dt-mission-bar\s*\{([^}]*)\}/)
    expect(bar).not.toBeNull()
    expect((bar as RegExpMatchArray)[1]).toContain('height: 60px')
    const label = DESKTOP_CSS.match(/\.dt-mission-label\s*\{([^}]*)\}/)
    expect(label).not.toBeNull()
    expect((label as RegExpMatchArray)[1]).toContain('font-size: 14px')
    expect((label as RegExpMatchArray)[1]).toContain('border-radius: 999px')
    const current = DESKTOP_CSS.match(/\.dt-mission-label\.is-current\s*\{([^}]*)\}/)
    expect(current).not.toBeNull()
    expect((current as RegExpMatchArray)[1]).toContain('background:')
    const add = DESKTOP_CSS.match(/\.dt-mission-add\s*\{([^}]*)\}/)
    expect(add).not.toBeNull()
    expect((add as RegExpMatchArray)[1]).toContain('border-radius: 50%')
    expect((add as RegExpMatchArray)[1]).toContain('width: 28px')
  })

  test('스프레드 transform 원점과 iframe 포인터 차단이 CSS에 있다', () => {
    // transform 수식은 좌상단 원점 기준 — 중앙 원점이면 캡션·격자와
    // 어긋난다. iframe이 포인터를 삼키면 창 클릭·드래그가 시작되지 않는다.
    expect(DESKTOP_CSS).toMatch(/\.dt-window\.dt-mission-win[^{]*\{[^}]*transform-origin:\s*0 0/)
    expect(DESKTOP_CSS).toMatch(/\.dt-mission-mode \.dt-window iframe\s*\{[^}]*pointer-events:\s*none/)
    const bg = DESKTOP_CSS.match(/\.dt-mission-bg\s*\{([^}]*)\}/)
    expect(bg).not.toBeNull()
    expect((bg as RegExpMatchArray)[1]).toContain('z-index: 1')
  })

  test('미션 컨테이너는 포인터를 통과시키고 바만 받는다', () => {
    // 전면 컨테이너가 누르기를 삼키면 창 클릭·드래그가 시작되지 않는다.
    const shell = DESKTOP_CSS.match(/#dt-mission\s*\{([^}]*)\}/)
    expect(shell).not.toBeNull()
    expect((shell as RegExpMatchArray)[1]).toContain('pointer-events: none')
    const bar = DESKTOP_CSS.match(/\.dt-mission-bar\s*\{([^}]*)\}/)
    expect(bar).not.toBeNull()
    expect((bar as RegExpMatchArray)[1]).toContain('pointer-events: auto')
  })

  test('구 카드 방식은 현행 UI가 아니다 (JS가 카드 마크업을 만들지 않는다)', () => {
    // 운영본 CSS에는 원본 카드 규칙(.dt-mission-card 등)이 잔존하나
    // 그것은 미사용 원본 텍스트다 — 현행 판정은 마크업 방출 쪽이다:
    // 어떤 JS도 카드 클래스를 만들지 않고, Mac 방식 바가 현행이다.
    for (const src of [WINDOWS_JS, MENUBAR_JS, STATE_JS]) {
      expect(src).not.toContain('dt-mission-card')
      expect(src).not.toContain('dt-mission-stage')
      expect(src).not.toContain('dt-mission-winrect')
      expect(src).not.toContain('dt-mission-spaces')
    }
    expect(DESKTOP_CSS).toContain('.dt-mission-bar')
    expect(DESKTOP_CSS).toContain('.dt-mission-label')
  })
})
