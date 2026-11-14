/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 창 바 브라우저 탭의 사파리 정렬 테스트 (2026-11-14 실제 맥 사파리 26 캡처 대조).
 *
 * 검증 성질:
 * - 브라우저 앱이 게시한 탭(myhub:browser-tabs 메시지)이 창 바에 렌더링될 때
 *   이름 앞에 파비콘 타일(.myhub-btab-fav)이 붙는다 (글자, 없으면 globe 아이콘).
 * - 탭은 사파리 카드다: 네 모서리 반경 10px, 높이 32px, 파비콘+제목 가운데.
 * - 탭 띠(.myhub-win-btabs)는 바 안에서 세로 가운데 정렬이다.
 *
 * 로딩 패턴은 tests/desktop-ui.test.ts와 동일하다 (실제 windows.js +
 * state.js + 공용 전역, 스텁 아님). CSS는 실제 public/css/desktop.css를
 * 읽어 <style>로 주입해 계산 스타일로 단언한다.
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

describe('창 바 브라우저 탭 — 사파리 카드 정렬', () => {
  test('게시된 탭에 파비콘 타일이 붙고 카드는 네 모서리 10px·높이 32px·가운데 정렬이다', () => {
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

    // 브라우저 앱이 보내는 것과 같은 게시 메시지 (fav 포함).
    const ev = new win.MessageEvent('message', {
      data: {
        type: 'myhub:browser-tabs',
        tabs: [
          { id: 't1', label: 'naver.com', fav: 'N', live: true },
          { id: 't2', label: '새 탭', fav: '', live: false },
        ],
        activeId: 't1',
      },
      origin: win.location.origin,
      source: frame.contentWindow,
    })
    win.dispatchEvent(ev)

    const btabs = box.querySelectorAll('.myhub-btab')
    expect(btabs.length).toBe(2)
    // 파비콘 타일: 글자 탭은 'N', 무URL 탭은 globe 아이콘.
    const fav1 = btabs[0].querySelector('.myhub-btab-fav')
    expect(fav1).not.toBeNull()
    expect(fav1.textContent).toBe('N')
    const fav2 = btabs[1].querySelector('.myhub-btab-fav')
    expect(fav2).not.toBeNull()
    expect(fav2.querySelector('i[data-lucide="globe"]')).not.toBeNull()
    // 파비콘이 이름보다 앞에 온다.
    expect(btabs[0].querySelector('.myhub-btab-main').firstChild).toBe(fav1)

    // border-radius는 jsdom getComputedStyle이 못 읽으므로(빈 값/0 반환)
    // CSS 원문에서 규칙을 뽑아 단언하고, 선택자가 실제 렌더된 탭에
    // 매칭되는지 확인한다 (tests/desktop-drag-perf.test.ts와 같은 방식).
    const btabRule = extractRule(DESKTOP_CSS, '.myhub-btab')
    expect(btabRule).not.toBeNull()
    expect(btabRule).toMatch(/border-radius:\s*10px\s*;/)
    expect(btabRule).not.toMatch(/8px 8px 0 0/)
    expect(btabs[0].matches('.myhub-btab')).toBe(true)

    // 카드 계산 스타일 (실제 desktop.css).
    const cs = win.getComputedStyle(btabs[0])
    expect(cs.height).toBe('32px')
    // 폭 상한 해제는 jsdom이 미설정 max-width를 ''로 돌리므로 규칙 원문으로 단언.
    expect(btabRule).not.toMatch(/max-width/)
    const mainCs = win.getComputedStyle(btabs[0].querySelector('.myhub-btab-main'))
    expect(mainCs.justifyContent).toBe('center')
    const boxCs = win.getComputedStyle(box)
    expect(boxCs.alignItems).toBe('center')
    const favCs = win.getComputedStyle(fav1)
    expect(favCs.width).toBe('18px')
    expect(favCs.height).toBe('18px')
  })
})
