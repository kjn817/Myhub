/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 창 바 브라우저 내비 — 동작 테스트 (2026-11-14 타이틀바 한 줄 통일).
 *
 * 검증 성질:
 * - 주소 동기화: 포커스 전에는 호스트만 보이고, 포커스하면 전체 URL이
 *   보이며, 입력 중에는 상태 게시가 값을 건드리지 않는다 (타이핑 방해 금지).
 * - 뒤로/앞으로 disabled와 로딩 표시(is-loading)가 상태 게시를 따른다.
 * - 버튼 클릭·주소 Enter가 iframe에 myhub:browser-nav-action 명령을
 *   postMessage로 보낸다 (뒤로·앞으로·새로고침·새 탭·탭 개요·사이드바·이동).
 * - 내비 상태를 받으면 iframe에 myhub:browser-nav-adopt를 보내
 *   iframe 툴바를 숨기게 한다.
 * - 공유 버튼은 현재 URL을 클립보드에 복사한다.
 *
 * 로딩 패턴은 tests/desktop-browser-tabs-safari.test.ts와 동일하다 (실제
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

/** 브라우저 창을 열고 내비 상태를 한 번 게시한 뒤 요소를 돌려준다. */
function setupNav(nav: any) {
  const storage = new MemoryStorage()
  const m = makeManager(storage)
  const doc = getDoc()
  const win = getWin()
  m.openModule('browser')
  const el = doc.querySelector('.dt-window[data-id="browser"]')
  const frame = el.querySelector('iframe.dt-frame')
  const box = el.querySelector('.myhub-win-bnav')
  // iframe으로 나가는 postMessage를 가로챈다 (adopt·명령 단언용).
  const postMessage = jest.fn()
  frame.contentWindow.postMessage = postMessage
  postNav(win, frame, nav)
  return { doc, win, el, frame, box, postMessage }
}

const NAVER = {
  url: 'https://www.naver.com',
  title: 'naver.com',
  fav: 'N',
  canBack: false,
  canFwd: true,
  loading: false,
}

describe('창 바 브라우저 내비 — 동작', () => {
  test('주소는 호스트만 보이고, 포커스하면 전체 URL, 입력 중 상태 게시가 값을 안 건드린다', () => {
    const { doc, win, frame, box } = setupNav(NAVER)
    const input = box.querySelector('.myhub-bnav-input') as any

    // 포커스 전: 호스트만.
    expect(input.value).toBe('naver.com')

    // 포커스: 전체 URL + 선택.
    input.focus()
    expect(doc.activeElement).toBe(input)
    expect(input.value).toBe('https://www.naver.com')

    // 입력 중에 새 상태가 와도 값은 그대로 (타이핑 방해 금지).
    postNav(win, frame, {
      url: 'https://www.google.com',
      title: 'google.com',
      fav: 'G',
      canBack: true,
      canFwd: false,
      loading: false,
    })
    expect(input.value).toBe('https://www.naver.com')

    // blur하면 새 호스트로 바뀐다.
    input.blur()
    expect(input.value).toBe('google.com')
  })

  test('Enter는 navigate 명령을 보내고, Esc는 값을 되돌리고 blur한다', () => {
    const { doc, win, frame, box, postMessage } = setupNav(NAVER)
    const input = box.querySelector('.myhub-bnav-input') as any
    postMessage.mockClear()

    input.focus()
    input.value = 'example.com'
    input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'myhub:browser-nav-action', action: 'navigate', url: 'example.com' },
      win.location.origin,
    )
    // Enter 후에는 blur돼 호스트 표시로 돌아간다.
    expect(doc.activeElement).not.toBe(input)

    // Esc: 편집 중 값을 버리고 호스트로 되돌린다.
    input.focus()
    input.value = '엉뚱한 입력'
    input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(input.value).toBe('naver.com')
    expect(doc.activeElement).not.toBe(input)
  })

  test('버튼 클릭이 iframe에 내비 명령을 보낸다 (뒤로·앞으로·새로고침·새 탭·개요·사이드바)', () => {
    const { win, box, postMessage } = setupNav({
      ...NAVER,
      canBack: true,
      canFwd: true,
    })
    postMessage.mockClear()

    const click = (sel: string) => (box.querySelector(sel) as any).click()
    click('.myhub-bnav-back')
    click('.myhub-bnav-fwd')
    click('.myhub-bnav-reload')
    click('.myhub-bnav-overview')
    click('.myhub-bnav-sidebar')
    click('.myhub-bnav-new')

    const actions = postMessage.mock.calls.map((c: any[]) => c[0].action)
    expect(actions).toEqual(['back', 'forward', 'reload', 'overview', 'sidebar', 'newtab'])
    postMessage.mock.calls.forEach((c: any[]) => {
      expect(c[0].type).toBe('myhub:browser-nav-action')
      expect(c[1]).toBe(win.location.origin)
    })
  })

  test('새 탭 버튼은 주소 입력에 포커스를 준다', () => {
    const { doc, box } = setupNav(NAVER)
    const input = box.querySelector('.myhub-bnav-input') as any
    ;(box.querySelector('.myhub-bnav-new') as any).click()
    expect(doc.activeElement).toBe(input)
  })

  test('내비 상태를 받으면 iframe에 adopt를 보내 툴바 호스팅을 알린다', () => {
    const { postMessage } = setupNav(NAVER)
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'myhub:browser-nav-adopt' },
      expect.anything(),
    )
  })

  test('공유 버튼은 현재 URL을 클립보드에 복사한다', async () => {
    const win = getWin()
    const writeText = jest.fn(() => Promise.resolve())
    Object.defineProperty(win.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    const { box } = setupNav(NAVER)
    ;(box.querySelector('.myhub-bnav-share') as any).click()
    expect(writeText).toHaveBeenCalledWith('https://www.naver.com')
    await Promise.resolve()
  })

  test('로딩 중에는 새로고침 버튼에 is-loading이 붙고, 끝나면 떨어진다', () => {
    const { win, frame, box } = setupNav(NAVER)
    const reload = box.querySelector('.myhub-bnav-reload') as any
    expect(reload.classList.contains('is-loading')).toBe(false)

    postNav(win, frame, { ...NAVER, loading: true })
    expect(reload.classList.contains('is-loading')).toBe(true)

    postNav(win, frame, { ...NAVER, loading: false })
    expect(reload.classList.contains('is-loading')).toBe(false)
  })

  test('뒤로/앞으로 disabled가 상태 게시를 따라 바뀐다', () => {
    const { win, frame, box } = setupNav(NAVER)
    const back = box.querySelector('.myhub-bnav-back') as any
    const fwd = box.querySelector('.myhub-bnav-fwd') as any
    expect(back.disabled).toBe(true)
    expect(fwd.disabled).toBe(false)

    postNav(win, frame, { ...NAVER, canBack: true, canFwd: false })
    expect(back.disabled).toBe(false)
    expect(fwd.disabled).toBe(true)
  })
})
