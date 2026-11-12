/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 드래그 프레임 — pointermove 핫 패스 회귀 (2026-11-12)
 *
 * 사용자 실화면 지적: 창 타이틀바 드래그와 미션 컨트롤에서 창을 다른
 * 데스크톱으로 드롭할 때 버벅임. 하네스 실측(1440×900, SwiftShader)에서
 * 원인은 두 가지로 갈렸다.
 * - 페인트: backdrop-filter 재계산이 지배적이다. 미션 배경 전폭 블러
 *   14px(미션 드래그)·창 타이틀바 블러 20px(창 드래그)이 프레임의
 *   지배 원인이다 (진단용 프로브로 확인 — 끄면 느린 프레임 80건→0건).
 *   처음에는 "원본과 달리 블러를 끄는 변경은 넣지 않는다"고 했으나,
 *   2026-11-12 사용자가 "버벅임은 없는지, 빠릿빠릿한 게 생명"이라고
 *   직접 제기해 드래그 중에만 블러를 끄는 것으로 결정했다. 정적 외관은
 *   원본과 동일하게 유지된다 (드래그 끝나면 복원).
 * - 메인 스레드: move 이벤트마다 transform 직접 쓰기 + 미션 카드마다
 *   getBoundingClientRect 호출 + 드롭 시 미션 전체 재생성.
 * 이 파일은 메인 스레드 계약과 드래그 중 블러 정지 신호(클래스 토글)를
 * 검증한다 (페인트 효과는 하네스 수치로 별도 확인).
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - 창 이동: pointermove 직후에는 transform이 바뀌지 않고(합쳐진다),
 *   다음 rAF에 마지막 좌표 한 번만 반영된다.
 * - 미션 드래그: move 중에는 레이아웃을 읽지 않는다 — 드래그 시작 시
 *   캐시한 rect로 hot 판정을 하므로, 도중 live rect가 바뀌어도 hot은
 *   캐시를 따른다.
 * - 미션 드롭(다른 데스크톱): 카드 DOM이 재생성되지 않고 winrect만
 *   갱신된다 — 드롭 후 카드 노드 동일성이 유지되고, 이동한 창의
 *   winrect가 목적지 카드에 생기고 출발 카드에서 사라진다.
 * - 드래그 중 블러 정지: 창 드래그 중에는 루트에 dt-dragging이,
 *   미션 카드 드래그 중에는 루트에 dt-mission-dragging이 붙고,
 *   드래그가 끝나면 떨어진다. desktop.css에 두 클래스에 대한
 *   backdrop-filter: none 규칙이 있다.
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
</main>
<div id="dt-root"></div>
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

function missionEl(): any {
  return getDoc().getElementById('dt-mission')
}
function cards(): any[] {
  return Array.from(getDoc().querySelectorAll('.dt-mission-card'))
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
function pointer(target: any, type: string, x: number, y: number) {
  target.dispatchEvent(
    new (getWin().MouseEvent)(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
  )
}
// jsdom은 레이아웃이 없어 getBoundingClientRect가 전부 0을 돌려준다.
// 카드 hit 판정을 시험하려면 요소별로 rect를 스텁해야 한다.
function stubRect(el: any, r: { left: number; right: number; top: number; bottom: number }) {
  const full = { ...r, width: r.right - r.left, height: r.bottom - r.top, x: r.left, y: r.top }
  el.getBoundingClientRect = () => ({ ...full })
  return full
}

describe('창 이동 드래그 — rAF 통합', () => {
  test('move 직후에는 transform이 바뀌지 않고 다음 프레임에 최신 값 한 번만 반영된다', async () => {
    const m = makeManager()
    m.openModule('memo')
    const before = m.getState().windows[0]
    const winEl = getDoc().querySelector('.dt-window')
    const bar = winEl.querySelector('.dt-titlebar')
    expect(bar).not.toBeNull()
    pointer(bar, 'pointerdown', 500, 150)
    pointer(getDoc(), 'pointermove', 520, 160)
    pointer(getDoc(), 'pointermove', 540, 170)
    pointer(getDoc(), 'pointermove', 560, 180)
    // 합쳐지지 않았다면(동기 쓰기) 이 시점에 이미 translate(60px, 30px)이다.
    expect(winEl.style.transform).toBe('')
    await wait(50)
    expect(winEl.style.transform).toBe('translate(60px,30px)')
    pointer(getDoc(), 'pointerup', 560, 180)
    const after = m.getState().windows[0]
    expect(after.x).toBe(before.x + 60)
    expect(after.y).toBe(before.y + 30)
  })
})

describe('드래그 중인 창 — 들어올림 표시', () => {
  test('드래그 시작 시 창에 dt-win-dragging이 붙고 pointerup에서 떨어진다', async () => {
    const m = makeManager()
    m.openModule('memo')
    const winEl = getDoc().querySelector('.dt-window')
    const bar = winEl.querySelector('.dt-titlebar')
    expect(bar).not.toBeNull()
    expect(winEl.classList.contains('dt-win-dragging')).toBe(false)
    pointer(bar, 'pointerdown', 500, 150)
    // 클래스 없으면(수정 전 코드) 드래그 중에도 들어올림 그림자·테두리가
    // 생기지 않아 흰 창이 흰 창 위에 겹칠 때 경계가 묻힌다 (2026-11-12
    // 할 일 창 위 흰 패널 지적 — 하네스 상단 대비 13 → 42/63).
    expect(winEl.classList.contains('dt-win-dragging')).toBe(true)
    pointer(getDoc(), 'pointermove', 520, 160)
    await wait(50)
    expect(winEl.classList.contains('dt-win-dragging')).toBe(true)
    pointer(getDoc(), 'pointerup', 520, 160)
    expect(winEl.classList.contains('dt-win-dragging')).toBe(false)
  })
})

describe('미션 드래그 — 캐시된 rect와 경량 드롭', () => {
  function setupMissionTwoSpaces() {
    const m = makeManager()
    m.openModule('memo')
    m.addSpace()
    const spaces = m.getState().spaces.slice()
    m.switchSpace(spaces[0])
    m.toggleMission()
    expect(m.isMissionOpen()).toBe(true)
    expect(cards().length).toBe(2)
    // 드래그 시작 전 카드 rect 스텁 (jsdom 기본값 0x0을 대체)
    stubRect(cards()[0], { left: 100, right: 300, top: 50, bottom: 170 })
    stubRect(cards()[1], { left: 350, right: 550, top: 50, bottom: 170 })
    const add = getDoc().querySelector('.dt-mission-add')
    stubRect(add, { left: 600, right: 644, top: 80, bottom: 124 })
    return { m, spaces }
  }

  test('move 중에는 레이아웃을 읽지 않고 시작 시 캐시한 rect로 hot 판정을 한다', async () => {
    const { m } = setupMissionTwoSpaces()
    const winEl = getDoc().querySelector('.dt-window.dt-mission-win')
    expect(winEl).not.toBeNull()
    pointer(winEl, 'pointerdown', 400, 400)
    // 드래그 시작 뒤 live rect를 멀리 옮긴다 — live를 읽으면 hot이 안 된다.
    let liveReads = 0
    const moved = { left: 900, right: 1100, top: 50, bottom: 170, width: 200, height: 120, x: 900, y: 50 }
    cards()[1].getBoundingClientRect = () => {
      liveReads++
      return { ...moved }
    }
    pointer(getDoc(), 'pointermove', 420, 380)
    pointer(getDoc(), 'pointermove', 450, 100)
    await wait(50)
    expect(liveReads).toBe(0)
    // (450, 100)은 원래 캐시한 카드 2 안에 있다 — 캐시를 따르면 hot이다.
    expect(cards()[1].classList.contains('is-drop-hot')).toBe(true)
    pointer(getDoc(), 'pointerup', 450, 100)
    expect(m.isMissionOpen()).toBe(true)
  })

  test('다른 데스크톱으로 드롭하면 카드 DOM은 그대로이고 winrect만 갱신된다', async () => {
    const { m, spaces } = setupMissionTwoSpaces()
    const beforeCards = cards()
    const beforeStages = beforeCards.map((c: any) => c.querySelector('.dt-mission-stage'))
    expect(beforeStages[0].querySelectorAll('.dt-mission-winrect').length).toBe(1)
    expect(beforeStages[1].querySelectorAll('.dt-mission-winrect').length).toBe(0)
    const winEl = getDoc().querySelector('.dt-window.dt-mission-win')
    pointer(winEl, 'pointerdown', 400, 400)
    pointer(getDoc(), 'pointermove', 420, 380)
    pointer(getDoc(), 'pointermove', 450, 100)
    await wait(50)
    pointer(getDoc(), 'pointerup', 450, 100)
    // 미션은 열린 채, 창은 데스크톱 2로 이동한다
    expect(m.isMissionOpen()).toBe(true)
    expect(m.getState().windows[0].space).toBe(spaces[1])
    // 전체 재생성(openMission)이면 노드 동일성이 깨진다
    const afterCards = cards()
    expect(afterCards.length).toBe(2)
    expect(afterCards[0]).toBe(beforeCards[0])
    expect(afterCards[1]).toBe(beforeCards[1])
    expect(afterCards[0].querySelector('.dt-mission-stage')).toBe(beforeStages[0])
    expect(afterCards[1].querySelector('.dt-mission-stage')).toBe(beforeStages[1])
    // winrect만 갱신된다: 출발 카드에서 사라지고 목적지 카드에 생긴다
    expect(afterCards[0].querySelectorAll('.dt-mission-winrect').length).toBe(0)
    expect(afterCards[1].querySelectorAll('.dt-mission-winrect').length).toBe(1)
  })
})

describe('드래그 중 블러 정지 — 클래스 신호와 CSS 규칙', () => {
  test('창 드래그 중에는 루트에 dt-dragging이 붙고 끝나면 떨어진다', async () => {
    const m = makeManager()
    m.openModule('memo')
    const root = getDoc().getElementById('dt-root')
    const winEl = getDoc().querySelector('.dt-window')
    const bar = winEl.querySelector('.dt-titlebar')
    expect(root.classList.contains('dt-dragging')).toBe(false)
    pointer(bar, 'pointerdown', 500, 150)
    expect(root.classList.contains('dt-dragging')).toBe(true)
    pointer(getDoc(), 'pointermove', 520, 160)
    await wait(50)
    expect(root.classList.contains('dt-dragging')).toBe(true)
    pointer(getDoc(), 'pointerup', 520, 160)
    expect(root.classList.contains('dt-dragging')).toBe(false)
  })

  test('미션 카드 드래그 중에는 루트에 dt-mission-dragging이 붙고 끝나면 떨어진다', async () => {
    const m = makeManager()
    m.openModule('memo')
    m.addSpace()
    const spaces = m.getState().spaces.slice()
    m.switchSpace(spaces[0])
    m.toggleMission()
    expect(m.isMissionOpen()).toBe(true)
    const root = getDoc().getElementById('dt-root')
    const winEl = getDoc().querySelector('.dt-window.dt-mission-win')
    expect(winEl).not.toBeNull()
    expect(root.classList.contains('dt-mission-dragging')).toBe(false)
    pointer(winEl, 'pointerdown', 400, 400)
    // pointerdown만으로는 아직 안 붙는다 (6px 이상 움직여야 moved).
    expect(root.classList.contains('dt-mission-dragging')).toBe(false)
    pointer(getDoc(), 'pointermove', 420, 380)
    await wait(50)
    expect(root.classList.contains('dt-mission-dragging')).toBe(true)
    pointer(getDoc(), 'pointerup', 420, 380)
    expect(root.classList.contains('dt-mission-dragging')).toBe(false)
  })

  test('desktop.css에 드래그 중 블러 정지 규칙이 있다', () => {
    // 창 드래그: 타이틀바 블러 20px 정지
    expect(DESKTOP_CSS).toContain('.dt-dragging .dt-titlebar')
    // 미션 드래그: 미션 배경 전폭 블러 14px 정지
    expect(DESKTOP_CSS).toContain('.dt-mission-dragging .dt-mission-bg')
    // 위젯 드래그·크기 조절: 위젯 블러 22px(데스크톱 최강) 정지
    expect(DESKTOP_CSS).toContain('.dt-widget.is-dragging')
    expect(DESKTOP_CSS).toContain('.dt-widget.is-resizing')
    // 두 규칙 모두 backdrop-filter를 none으로 한다
    const dragBlock = DESKTOP_CSS.slice(DESKTOP_CSS.indexOf('.dt-dragging .dt-titlebar'))
    expect(dragBlock).toContain('backdrop-filter: none !important')
    const missionBlock = DESKTOP_CSS.slice(DESKTOP_CSS.indexOf('.dt-mission-dragging .dt-mission-bg'))
    expect(missionBlock).toContain('backdrop-filter: none !important')
    const widgetBlock = DESKTOP_CSS.slice(DESKTOP_CSS.indexOf('.dt-widget.is-dragging'))
    expect(widgetBlock).toContain('backdrop-filter: none !important')
  })
})

describe('다른 드래그 경로 — rAF 합치기 (2026-11-12 성능 점검)', () => {
  // 창 이동과 같은 어설픈 코드가 위젯·아이콘·독 드래그에도 있었다:
  // move 이벤트마다 transform을 직접 쓰고 레이아웃을 읽었다.
  // 이 테스트들은 rAF 합치기 패턴이 각 파일에 들어갔는지 확인한다.
  // (동작은 기존 레이아웃·플로우 테스트 29건이 종단 검증한다.)
  const WIDGETS_JS = read('public/js/desktop/widgets.js')
  const ICONS_JS = read('public/js/desktop/desktop-icons.js')
  const DOCK_JS = read('public/js/desktop/dock.js')

  test('위젯 이동·크기 조절은 rAF로 합쳐진다', () => {
    expect(WIDGETS_JS).toContain('applyWidgetFrame')
    expect(WIDGETS_JS).toContain('applyResizeFrame')
    expect(WIDGETS_JS).toContain('wdrag.rafId')
    expect(WIDGETS_JS).toContain('wrz.rafId')
  })

  test('아이콘 이동·영역 선택은 rAF로 합쳐지고 rect를 캐시한다', () => {
    expect(ICONS_JS).toContain('applyIconFrame')
    expect(ICONS_JS).toContain('applyBandFrame')
    expect(ICONS_JS).toContain('trashRect')
    expect(ICONS_JS).toContain('iconRects')
  })

  test('독 밖 드래그는 rAF로 합쳐지고 컨테이너 rect를 캐시한다', () => {
    expect(DOCK_JS).toContain('applyDockDragFrame')
    expect(DOCK_JS).toContain('containerRect')
  })
})
