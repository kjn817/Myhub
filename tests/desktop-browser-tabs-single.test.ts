/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 창 바 브라우저 탭 — 탭 1개면 카드 숨김 (2026-11-14 실제 맥 사파리 캡처 image-46 대조).
 *
 * 검증 성질:
 * - 게시된 탭이 1개면 창 바에 탭 카드(.myhub-btab)가 없고 창 제목이 다시 보인다
 *   (dt-win-btabs-on 클래스 없음). 새 탭 + 버튼(.myhub-btab-new)은 남는다.
 * - 탭이 2개가 되면 카드가 다시 나타나고 제목이 숨긴다.
 * - 2개에서 1개로 돌아가면 카드가 사라지고 제목이 돌아온다.
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

/** CSS 원문에서 `selector { ... }` 규칙 본문을 뽑는다 (없으면 null). */
function extractRule(css: string, selector: string): string | null {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')
  const m = css.match(re)
  return m ? m[1] : null
}

function postTabs(win: any, frame: any, tabs: any[], activeId: string): void {
  const ev = new win.MessageEvent('message', {
    data: { type: 'myhub:browser-tabs', tabs, activeId },
    origin: win.location.origin,
    source: frame.contentWindow,
  })
  win.dispatchEvent(ev)
}

describe('창 바 브라우저 탭 — 탭 1개면 카드 숨김', () => {
  test('1개 탭 → 카드 없음·제목 보임·+ 남음, 2개 탭 → 카드 나타남·제목 숨김, 다시 1개 → 카드 사라짐', () => {
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
    const box = el.querySelector('.myhub-win-btabs')
    expect(box).not.toBeNull()
    const titleFlow = el.querySelector('.dt-title-flow')
    expect(titleFlow).not.toBeNull()

    const state = () => ({
      cards: box.querySelectorAll('.myhub-btab').length,
      newBtn: box.querySelectorAll('.myhub-btab-new').length,
      tabsOn: el.classList.contains('dt-win-btabs-on'),
      titleDisplay: win.getComputedStyle(titleFlow).display,
    })

    // (1) 탭 1개: 카드 없음, 제목 보임, + 버튼은 남는다.
    postTabs(win, frame, [{ id: 't1', label: 'naver.com', fav: 'N', live: false }], 't1')
    let s = state()
    expect(s.cards).toBe(0)
    expect(s.newBtn).toBe(1)
    expect(s.tabsOn).toBe(false)
    expect(s.titleDisplay).not.toBe('none')

    // (2) 탭 2개: 카드 2개, 제목 숨김, + 버튼 유지.
    postTabs(
      win,
      frame,
      [
        { id: 't1', label: 'naver.com', fav: 'N', live: false },
        { id: 't2', label: '새 탭', fav: '', live: false },
      ],
      't2',
    )
    s = state()
    expect(s.cards).toBe(2)
    expect(s.newBtn).toBe(1)
    expect(s.tabsOn).toBe(true)
    expect(s.titleDisplay).toBe('none')

    // (3) 다시 탭 1개: 카드 사라지고 제목 돌아온다.
    postTabs(win, frame, [{ id: 't1', label: 'naver.com', fav: 'N', live: false }], 't1')
    s = state()
    expect(s.cards).toBe(0)
    expect(s.newBtn).toBe(1)
    expect(s.tabsOn).toBe(false)
    expect(s.titleDisplay).not.toBe('none')

    // + 버튼은 카드 없이도 바 오른쪽 끝에 붙는다 (margin-left: auto).
    // jsdom은 레이아웃을 안 하므로 규칙 원문으로 단언하고, 선택자가
    // 실제 렌더된 + 버튼에 매칭되는지 확인한다.
    const newRule = extractRule(DESKTOP_CSS, '.myhub-btab-new')
    expect(newRule).not.toBeNull()
    expect(newRule).toMatch(/margin-left:\s*auto\s*;/)
    expect(box.querySelector('.myhub-btab-new').matches('.myhub-btab-new')).toBe(true)
  })
})
