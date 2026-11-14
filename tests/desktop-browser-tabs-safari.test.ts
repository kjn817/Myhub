/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 창 바 브라우저 내비 — 사파리 한 줄 정렬 (2026-11-14 실제 맥 사파리 26 캡처 대조).
 *
 * 검증 성질 (2026-11-14 타이틀바 한 줄 통일):
 * - 브라우저 앱이 게시한 내비 상태(myhub:browser-nav 메시지)가 창 바에
 *   사파리 순서로 렌더링된다: 사이드바 → 뒤로/앞으로 알약 → 주소 캡슐 →
 *   공유 → 새 탭 → 탭 개요.
 * - 주소 캡슐 왼쪽에 현재 탭 파비콘 타일(.myhub-bnav-fav)이 붙는다
 *   (글자, 없으면 globe 아이콘). 캡슐에는 호스트만 보인다 (포커스
 *   전에는 전체 URL이 아니다 — 사파리와 같은 방식).
 * - 뒤로/앞으로 disabled는 canBack/canFwd를 따른다.
 * - 탭 카드는 셸에 없다 (.myhub-win-btabs·.myhub-btab 없음 — 탭 줄은
 *   iframe 안의 .bw-tabstrip이 담당한다).
 * - 내비가 앉으면 창 제목이 숨긴다 (dt-win-bnav-on).
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

function postNav(win: any, frame: any, nav: any): void {
  const ev = new win.MessageEvent('message', {
    data: { type: 'myhub:browser-nav', ...nav },
    origin: win.location.origin,
    source: frame.contentWindow,
  })
  win.dispatchEvent(ev)
}

describe('창 바 브라우저 내비 — 사파리 한 줄 정렬', () => {
  test('내비 상태가 사파리 순서로 렌더링되고 캡슐에 호스트+파비콘이 보인다', () => {
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
    // 탭 카드 호스팅은 폐지됐다 — 셸에 탭 카드 흔적이 없다.
    expect(el.querySelector('.myhub-win-btabs')).toBeNull()
    expect(el.querySelector('.myhub-btab')).toBeNull()

    // 게시 전에는 내비가 숨겨지고 제목이 보인다.
    expect(box.hidden).toBe(true)
    expect(el.classList.contains('dt-win-bnav-on')).toBe(false)

    // 브라우저 앱이 보내는 것과 같은 내비 상태 게시.
    postNav(win, frame, {
      url: 'https://www.naver.com',
      title: 'naver.com',
      fav: 'N',
      canBack: false,
      canFwd: true,
      loading: false,
    })

    expect(box.hidden).toBe(false)
    expect(el.classList.contains('dt-win-bnav-on')).toBe(true)
    const titleFlow = el.querySelector('.dt-title-flow')
    expect(win.getComputedStyle(titleFlow).display).toBe('none')

    // 순서: 사이드바 → 알약 → 캡슐 → 트레일(공유·새 탭·개요).
    const kids = Array.from(box.children)
    expect(kids.length).toBe(4)
    expect(kids[0].classList.contains('myhub-bnav-sidebar')).toBe(true)
    expect(kids[1].classList.contains('myhub-bnav-navgroup')).toBe(true)
    expect(kids[2].classList.contains('myhub-bnav-url')).toBe(true)
    expect(kids[3].classList.contains('myhub-bnav-trail')).toBe(true)
    const trailKids = Array.from(kids[3].children)
    expect(trailKids.length).toBe(3)
    expect(trailKids[0].classList.contains('myhub-bnav-share')).toBe(true)
    expect(trailKids[1].classList.contains('myhub-bnav-new')).toBe(true)
    expect(trailKids[2].classList.contains('myhub-bnav-overview')).toBe(true)

    // 캡슐: 파비콘 'N' + 호스트 표시 + 새로고침이 캡슐 안.
    const fav = box.querySelector('.myhub-bnav-fav')
    expect(fav).not.toBeNull()
    expect(fav.textContent).toBe('N')
    const input = box.querySelector('.myhub-bnav-input') as any
    expect(input).not.toBeNull()
    expect(input.value).toBe('naver.com')
    const reload = box.querySelector('.myhub-bnav-reload')
    expect(reload).not.toBeNull()
    expect(reload.closest('.myhub-bnav-url')).not.toBeNull()

    // 뒤로 disabled(canBack false), 앞으로 enabled(canFwd true).
    expect((box.querySelector('.myhub-bnav-back') as any).disabled).toBe(true)
    expect((box.querySelector('.myhub-bnav-fwd') as any).disabled).toBe(false)

    // 캡슐 계산 스타일 (실제 desktop.css): 높이 30px, 가운데 정렬 입력.
    const urlCs = win.getComputedStyle(box.querySelector('.myhub-bnav-url'))
    expect(urlCs.height).toBe('30px')
    expect(win.getComputedStyle(input).textAlign).toBe('center')
    // border-radius는 jsdom getComputedStyle이 못 읽으므로(빈 값/0 반환)
    // CSS 원문에서 규칙을 뽑아 단언하고, 선택자가 실제 렌더된 요소에
    // 매칭되는지 확인한다 (tests/desktop-drag-perf.test.ts와 같은 방식).
    const urlRule = extractRule(DESKTOP_CSS, '.myhub-bnav-url')
    expect(urlRule).not.toBeNull()
    expect(urlRule).toMatch(/border-radius:\s*999px\s*;/)
    expect(box.querySelector('.myhub-bnav-url').matches('.myhub-bnav-url')).toBe(true)
    const navgroupRule = extractRule(DESKTOP_CSS, '.myhub-bnav-navgroup')
    expect(navgroupRule).not.toBeNull()
    expect(navgroupRule).toMatch(/border-radius:\s*999px\s*;/)
    const boxCs = win.getComputedStyle(box)
    expect(boxCs.alignItems).toBe('center')
    const favCs = win.getComputedStyle(fav)
    expect(favCs.width).toBe('18px')
    expect(favCs.height).toBe('18px')
  })

  test('빈 탭이면 파비콘은 globe, 입력은 비어 있고 새로고침·공유는 disabled다', () => {
    const storage = new MemoryStorage()
    const m = makeManager(storage)
    const doc = getDoc()
    const win = getWin()
    injectDesktopCss()

    m.openModule('browser')
    const el = doc.querySelector('.dt-window[data-id="browser"]')
    const frame = el.querySelector('iframe.dt-frame')
    const box = el.querySelector('.myhub-win-bnav')

    postNav(win, frame, {
      url: '',
      title: '새 탭',
      fav: '',
      canBack: false,
      canFwd: false,
      loading: false,
    })

    const fav = box.querySelector('.myhub-bnav-fav')
    expect(fav.querySelector('i[data-lucide="globe"]')).not.toBeNull()
    expect((box.querySelector('.myhub-bnav-input') as any).value).toBe('')
    expect((box.querySelector('.myhub-bnav-reload') as any).disabled).toBe(true)
    expect((box.querySelector('.myhub-bnav-share') as any).disabled).toBe(true)
    expect((box.querySelector('.myhub-bnav-back') as any).disabled).toBe(true)
    expect((box.querySelector('.myhub-bnav-fwd') as any).disabled).toBe(true)
  })

  test('옛 탭 채널(myhub:browser-tabs) 메시지는 무시된다', () => {
    const storage = new MemoryStorage()
    const m = makeManager(storage)
    const doc = getDoc()
    const win = getWin()
    injectDesktopCss()

    m.openModule('browser')
    const el = doc.querySelector('.dt-window[data-id="browser"]')
    const frame = el.querySelector('iframe.dt-frame')
    const box = el.querySelector('.myhub-win-bnav')

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

    expect(box.hidden).toBe(true)
    expect(box.hasChildNodes()).toBe(false)
    expect(el.querySelector('.myhub-btab')).toBeNull()
    expect(el.classList.contains('dt-win-bnav-on')).toBe(false)
  })
})
