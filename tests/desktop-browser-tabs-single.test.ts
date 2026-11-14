/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 창 바에는 탭 카드가 없다 (2026-11-14 타이틀바 한 줄 통일).
 *
 * 검증 성질:
 * - 내비 상태가 오기 전에는 내비가 숨겨지고 창 제목이 보인다.
 * - 내비 상태가 오면 내비가 나타나고 제목이 숨긴다 — 탭 개수와 무관하게
 *   셸은 탭 카드를 그리지 않는다 (탭 줄은 iframe 안의 .bw-tabstrip이
 *   담당하고, 탭 1개 숨김 규칙도 iframe 쪽에서 돈다).
 * - 내비 상태가 바뀌어도(다른 URL·로딩 전환) 탭 카드는 생기지 않는다.
 *
 * 로딩 패턴은 tests/desktop-browser-tabs-safari.test.ts와 동일하다 (실제
 * windows.js + state.js + 공용 전역, 스텁 아님). CSS는 실제
 * public/css/desktop.css를 읽어 <style>로 주입해 계산 스타일로 단언한다.
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

function injectDesktopCss(): void {
  const style = getDoc().createElement('style')
  style.textContent = DESKTOP_CSS
  getDoc().head.appendChild(style)
}

function postNav(win: any, frame: any, nav: any): void {
  const ev = new win.MessageEvent('message', {
    data: { type: 'myhub:browser-nav', ...nav },
    origin: win.location.origin,
    source: frame.contentWindow,
  })
  win.dispatchEvent(ev)
}

describe('창 바에는 탭 카드가 없다 — 내비만 있다', () => {
  test('게시 전에는 내비 숨김·제목 보임, 게시 후에는 내비 표시·제목 숨김, 어떤 상태에서도 카드 없음', () => {
    const storage = new MemoryStorage()
    const m = makeManager(storage)
    const doc = getDoc()
    const win = getWin()
    injectDesktopCss()

    m.openModule('browser')
    const el = doc.querySelector('.dt-window[data-id="browser"]')
    expect(el).not.toBeNull()
    const frame = el.querySelector('iframe.dt-frame')
    expect(frame).not.toBeNull()
    const box = el.querySelector('.myhub-win-bnav')
    expect(box).not.toBeNull()
    const titleFlow = el.querySelector('.dt-title-flow')
    expect(titleFlow).not.toBeNull()

    const state = () => ({
      cards: el.querySelectorAll('.myhub-btab').length,
      btabsBox: el.querySelectorAll('.myhub-win-btabs').length,
      navHidden: box.hidden,
      navOn: el.classList.contains('dt-win-bnav-on'),
      titleDisplay: win.getComputedStyle(titleFlow).display,
    })

    // (1) 게시 전: 내비 숨김, 제목 보임, 카드 없음.
    let s = state()
    expect(s.cards).toBe(0)
    expect(s.btabsBox).toBe(0)
    expect(s.navHidden).toBe(true)
    expect(s.navOn).toBe(false)
    expect(s.titleDisplay).not.toBe('none')

    // (2) 내비 게시(빈 탭): 내비 나타남, 제목 숨김, 카드 없음.
    postNav(win, frame, {
      url: '',
      title: '새 탭',
      fav: '',
      canBack: false,
      canFwd: false,
      loading: false,
    })
    s = state()
    expect(s.cards).toBe(0)
    expect(s.btabsBox).toBe(0)
    expect(s.navHidden).toBe(false)
    expect(s.navOn).toBe(true)
    expect(s.titleDisplay).toBe('none')

    // (3) 다른 URL로 이동 + 로딩 전환: 여전히 카드 없음, 내비 유지.
    postNav(win, frame, {
      url: 'https://www.naver.com',
      title: 'naver.com',
      fav: 'N',
      canBack: false,
      canFwd: false,
      loading: true,
    })
    s = state()
    expect(s.cards).toBe(0)
    expect(s.navHidden).toBe(false)
    expect(s.navOn).toBe(true)
    postNav(win, frame, {
      url: 'https://www.google.com',
      title: 'google.com',
      fav: 'G',
      canBack: true,
      canFwd: false,
      loading: false,
    })
    s = state()
    expect(s.cards).toBe(0)
    expect(s.navHidden).toBe(false)
    expect(s.titleDisplay).toBe('none')
    // 캡슐에는 새 호스트가 보인다.
    expect((box.querySelector('.myhub-bnav-input') as any).value).toBe('google.com')
  })
})
