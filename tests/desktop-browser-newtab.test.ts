/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 셸 새 탭 버튼 — 포커스 경합 수정 (2026-11-20, 브라우저 3단계).
 *
 * 배경: 새 탭 버튼이 newtab 액션을 보낸 직후 주소창에 포커스하면,
 * 아직 이전 탭 상태라 포커스 핸들러가 이전 URL을 채우고 select()한다.
 * 새 탭 상태가 와도 "입력 중이면 값을 건드리지 않는다" 가드가 막아
 * 이전 탭 URL이 선택된 채로 남았다 — 보고된 증상과 정확히 일치한다.
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - 새 탭 버튼 클릭 직후에는 포커스하지 않는다 (상태 도착 전).
 * - 새 탭 상태(url 없음)가 도착하면 주소창이 비어 있고 포커스된다.
 * - 새 탭이 아닌 상태(url 있음)가 먼저 오면 포커스하지 않고 플래그가
 *   소멸한다 — 뒤늦게 새 탭 상태가 와도 포커스하지 않는다.
 * - 2초가 지난 뒤 도착한 새 탭 상태에는 포커스하지 않는다
 *   (그 사이 사용자가 다른 곳을 눌렀을 수 있다).
 *
 * 로딩 패턴은 tests/desktop-browser-nav.test.ts와 동일하다 (실제
 * windows.js + state.js + 공용 전역, 스텁 아님).
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

const VIEWPORT = { w: 1280, h: 800 }

function getWin(): any {
  return (globalThis as any).window
}
function getDoc(): any {
  return (globalThis as any).document
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

class MemoryStorage {
  store: Record<string, string> = {}
  getItem(k: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null
  }
  setItem(k: string, v: string): void {
    this.store[k] = String(v)
  }
}

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

function makeManager(storage: MemoryStorage): any {
  const { root, taskbar } = setupShell()
  const stateApi = loadStateApi()
  loadDesktopGlobals()
  const windowsApi = loadWindowsApi()
  const doc = getDoc()
  return windowsApi.createManager({
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
}

function postNav(win: any, frame: any, nav: any): void {
  const ev = new win.MessageEvent('message', {
    data: { type: 'myhub:browser-nav', ...nav },
    origin: win.location.origin,
    source: frame.contentWindow,
  })
  win.dispatchEvent(ev)
}

/** 브라우저 창을 열고 네이버 내비 상태를 한 번 게시한다. */
function setupNav() {
  const storage = new MemoryStorage()
  const m = makeManager(storage)
  const doc = getDoc()
  const win = getWin()
  m.openModule('browser')
  const el = doc.querySelector('.dt-window[data-id="browser"]')
  const frame = el.querySelector('iframe.dt-frame')
  const box = el.querySelector('.myhub-win-bnav')
  frame.contentWindow.postMessage = jest.fn()
  postNav(win, frame, {
    url: 'https://www.naver.com',
    title: 'naver.com',
    fav: 'N',
    canBack: false,
    canFwd: true,
    loading: false,
  })
  return { doc, win, el, frame, box }
}

const NEW_TAB_NAV = {
  url: '',
  title: '',
  fav: '',
  canBack: false,
  canFwd: false,
  loading: false,
}

describe('셸 새 탭 버튼 — 포커스 경합', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('새 탭 버튼 클릭 직후에는 포커스하지 않는다', () => {
    const { doc, box } = setupNav()
    const input = box.querySelector('.myhub-bnav-input') as any
    expect(input.value).toBe('naver.com')
    ;(box.querySelector('.myhub-bnav-new') as any).click()
    // 아직 이전 탭 상태라 포커스하면 이전 URL이 채워진다 — 상태 도착
    // 전까지 포커스하지 않는다.
    expect(doc.activeElement).not.toBe(input)
    expect(input.value).toBe('naver.com')
  })

  test('새 탭 상태가 도착하면 주소창이 비어 있고 포커스된다', () => {
    const { doc, win, frame, box } = setupNav()
    const input = box.querySelector('.myhub-bnav-input') as any
    ;(box.querySelector('.myhub-bnav-new') as any).click()
    postNav(win, frame, NEW_TAB_NAV)
    expect(input.value).toBe('')
    expect(doc.activeElement).toBe(input)
  })

  test('새 탭이 아닌 상태가 먼저 오면 포커스하지 않고 플래그가 소멸한다', () => {
    const { doc, win, frame, box } = setupNav()
    const input = box.querySelector('.myhub-bnav-input') as any
    ;(box.querySelector('.myhub-bnav-new') as any).click()
    // 새 탭이 아니라 기존 탭 상태가 먼저 도착하면 포커스하지 않는다.
    postNav(win, frame, {
      url: 'https://www.google.com',
      title: 'google.com',
      fav: 'G',
      canBack: true,
      canFwd: false,
      loading: false,
    })
    expect(doc.activeElement).not.toBe(input)
    expect(input.value).toBe('google.com')
    // 플래그는 소멸했으므로, 뒤늦게 새 탭 상태가 와도 포커스하지 않는다.
    postNav(win, frame, NEW_TAB_NAV)
    expect(doc.activeElement).not.toBe(input)
    expect(input.value).toBe('')
  })

  test('2초가 지난 뒤 도착한 새 탭 상태에는 포커스하지 않는다', () => {
    const { doc, win, frame, box } = setupNav()
    const input = box.querySelector('.myhub-bnav-input') as any
    let now = 1_000_000
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    ;(box.querySelector('.myhub-bnav-new') as any).click()
    now += 2500
    postNav(win, frame, NEW_TAB_NAV)
    expect(input.value).toBe('')
    expect(doc.activeElement).not.toBe(input)
  })
})

/**
 * 셸 빈 탭 포커스 요청 (2026-11-20 QA 결함: 새 탭 직후 키 입력이
 * 주소창에 안 들어감).
 *
 * 배경: browser.js가 새 탭 생성·빈 탭 전환 때 명시적으로
 * myhub:browser-nav-focus를 보낸다. 위 플래그 방식은 연속 빈 탭의
 * 서명 중복이나 메뉴 경로에서는 안 먹혔기 때문이다.
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - 포커스 요청이 오면 주소창에 포커스된다 (현재 상태와 무관하게 —
 *   빈 탭 여부는 발신 측이 보장한다).
 * - 발신 창이 셸 창 iframe이 아니면 포커스하지 않는다.
 * - 출처가 다르면 포커스하지 않는다.
 */
describe('셸 빈 탭 포커스 요청', () => {
  function postFocus(win: any, source: any, origin?: string): void {
    const ev = new win.MessageEvent('message', {
      data: { type: 'myhub:browser-nav-focus' },
      origin: origin ?? win.location.origin,
      source,
    })
    win.dispatchEvent(ev)
  }

  test('포커스 요청이 오면 주소창에 포커스된다', () => {
    const { doc, win, frame, box } = setupNav()
    const input = box.querySelector('.myhub-bnav-input') as any
    expect(doc.activeElement).not.toBe(input)
    postFocus(win, frame.contentWindow)
    expect(doc.activeElement).toBe(input)
    // 포커스 핸들러가 현재 상태로 값을 채운다 (네이버 상태 저장 중).
    expect(input.value).toBe('https://www.naver.com')
  })

  test('발신 창이 셸 창 iframe이 아니면 포커스하지 않는다', () => {
    const { doc, win, box } = setupNav()
    const input = box.querySelector('.myhub-bnav-input') as any
    postFocus(win, win)
    expect(doc.activeElement).not.toBe(input)
  })

  test('출처가 다르면 포커스하지 않는다', () => {
    const { doc, win, frame, box } = setupNav()
    const input = box.querySelector('.myhub-bnav-input') as any
    postFocus(win, frame.contentWindow, 'https://evil.test')
    expect(doc.activeElement).not.toBe(input)
  })
})
