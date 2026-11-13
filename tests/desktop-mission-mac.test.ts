/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 미션 컨트롤 — 원본(a2702ca4) 카드 스트립 계약 (2026-11-11 복원)
 *
 * 배경: 848e034·d135bbd가 도입한 텍스트 라벨 바(60px)는 원본도 실제
 * macOS도 아닌 오구현으로 판정돼 원본 카드 스트립으로 환원됐다
 * (진단: ~/workspace/desktop-transition-diagnosis-20261111.md).
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - 오버레이를 열면 .dt-mission-spaces 스트립에 스페이스별 카드가
 *   렌더된다: 이름 '데스크톱 N'이 썸네일 위에, 배경화면 썸네일
 *   stage + 창 위치 winrect가 아래에 (macOS 스페이스 바와 같은
 *   배치 — 2026-11-13 사용자 맥 캡처 기준, 이름이 아래던 시절과
 *   다르다). 현재 스페이스 카드는 is-active, 보고 있는 카드는
 *   is-selected. 라벨 바(.dt-mission-bar/.dt-mission-label)가
 *   돌아오면 실패한다.
 * - 표시는 [hidden] 토글이 정본 — is-open 클래스는 JS·CSS 어디에도
 *   없어야 하고, 닫히면 hidden=true로 돌아간다.
 * - 스프레드 기하 시작점은 MISSION_AREA_TOP 176 (바 시절 84가 아니다).
 * - 딤 레이어(.dt-mission-bg)는 #dt-mission 바로 앞에 형제로 삽입되고
 *   (insertBefore), CSS는 fixed·z 58·배경화면 이미지를 직접 칠하며
 *   (--dt-mission-wp 소비) blur(14px) saturate(1.3)를 건다. 애니메이션
 *   동안에는 body.dt-mission-anim 목록이 그 블러를 끈다.
 * - 미션 배경은 상단바 아래에서 시작한다 (top: 상단바 높이) — macOS는
 *   미션 컨트롤에서 메뉴바를 숨기지만 MyHub 상단바는 사라지지 않고
 *   밝은 채로 남아야 한다 (2026-11-13 사용자 지시). 상단바 z 60이
 *   배경 z 58보다 위인 것도 함께 고정한다.
 * - + 버튼은 스트립 우상단 점선 원형(44px, dashed)이며 클릭하면
 *   데스크톱이 추가되고 오버레이는 열린 채 카드가 늘어난다.
 *   (카드 뒤 인라인이던 시절과 다르다 — 2026-11-13 맥 캡처 기준.)
 * - 미션 중에는 바탕화면 아이콘·위젯이 숨겨진다 (body.dt-mission-open).
 * - 카드 클릭 → 그 데스크톱으로 전환되고 오버레이가 닫힌다.
 * - 창이 있는 스페이스에서는 실제 창이 스프레드(dt-mission-win +
 *   transform)되고 캡션이 붙는다. 빈 스페이스에서는 빈 상태 문구가
 *   실제 문구로 렌더된다 (전사 소실로 ''가 되면 실패한다).
 * - Esc로 닫힌다.
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
const SHELL_CSS = read('public/shell.css')

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

function click(el: any) {
  el.dispatchEvent(new (getWin().MouseEvent)('click', { bubbles: true, cancelable: true }))
}
function missionEl(): any {
  return getDoc().getElementById('dt-mission')
}
function cards(): any[] {
  return Array.from(getDoc().querySelectorAll('.dt-mission-card'))
}
function cardNames(): string[] {
  return cards().map((c: any) => c.querySelector('.dt-mission-name').textContent.trim())
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('미션 컨트롤 — 카드 스트립 렌더 (원본 형태)', () => {
  test('열면 카드 스트립이 뜨고 바는 없으며 [hidden] 토글로 열린다', () => {
    const m = makeManager()
    m.toggleMission()
    expect(m.isMissionOpen()).toBe(true)
    expect(missionEl().hidden).toBe(false)
    expect(missionEl().classList.contains('is-open')).toBe(false)
    expect(getDoc().querySelector('.dt-mission-spaces')).not.toBeNull()
    expect(getDoc().querySelector('.dt-mission-bar')).toBeNull()
    expect(getDoc().querySelector('.dt-mission-label')).toBeNull()
    expect(cards().length).toBe(1)
    const card = cards()[0]
    expect(card.querySelector('.dt-mission-stage')).not.toBeNull()
    expect(cardNames()).toEqual(['데스크톱 1'])
    expect(card.classList.contains('is-active')).toBe(true)
    expect(card.classList.contains('is-selected')).toBe(true)
    const add = getDoc().querySelector('.dt-mission-add')
    expect(add).not.toBeNull()
    expect(add.getAttribute('aria-label')).toBe('데스크톱 추가')
    // + 버튼은 스트립의 자식이다 (바 시절처럼 별도 바에 붙지 않는다)
    expect(add.parentElement.classList.contains('dt-mission-spaces')).toBe(true)
  })

  test('카드 썸네일에 실제 창 위치가 winrect로 비례 표시된다', () => {
    const m = makeManager()
    m.openModule('memo')
    const w = m.getState().windows[0]
    m.toggleMission()
    const rect = cards()[0].querySelector('.dt-mission-winrect')
    expect(rect).not.toBeNull()
    expect(rect.style.left).toBe((w.x / VIEWPORT.w) * 100 + '%')
    expect(rect.style.top).toBe((w.y / VIEWPORT.h) * 100 + '%')
    expect(rect.style.width).toBe((w.w / VIEWPORT.w) * 100 + '%')
    expect(rect.style.height).toBe((w.h / VIEWPORT.h) * 100 + '%')
  })

  test('스페이스가 3개면 카드 3개가 순서대로 나열되고 닫으면 hidden으로 돌아간다', async () => {
    const m = makeManager()
    m.addSpace()
    m.addSpace()
    m.toggleMission()
    expect(cardNames()).toEqual(['데스크톱 1', '데스크톱 2', '데스크톱 3'])
    m.toggleMission()
    await wait(350)
    expect(missionEl().hidden).toBe(true)
    expect(missionEl().classList.contains('is-open')).toBe(false)
  })

  test('딤 레이어는 #dt-mission 바로 앞 형제로 삽입된다 (insertBefore)', () => {
    const m = makeManager()
    m.toggleMission()
    const bg = getDoc().querySelector('.dt-mission-bg')
    expect(bg).not.toBeNull()
    expect(bg.parentNode).toBe(missionEl().parentNode)
    expect(bg.nextElementSibling).toBe(missionEl())
    expect(bg.hidden).toBe(false)
  })
})

describe('미션 컨트롤 — macOS 스페이스 바 (2026-11-13)', () => {
  test('카드 이름이 썸네일 위에 있다 (DOM 순서: 이름 → stage, CSS absolute)', () => {
    const m = makeManager()
    m.toggleMission()
    const card = cards()[0]
    const kids = Array.from(card.children) as any[]
    const nameIdx = kids.findIndex((el: any) => el.classList.contains('dt-mission-name'))
    const stageIdx = kids.findIndex((el: any) => el.classList.contains('dt-mission-stage'))
    expect(nameIdx).toBeGreaterThanOrEqual(0)
    expect(stageIdx).toBeGreaterThanOrEqual(0)
    expect(nameIdx).toBeLessThan(stageIdx)
    // 이름은 카드 위쪽 바깥에 절대 배치된다 (썸네일 위 라벨).
    // ^ 앵커 필수 — 앞에 .dt-mission-card .dt-mission-name 후손
    // 규칙이 있어 앵커 없으면 그쪽이 먼저 잡힌다.
    const name = DESKTOP_CSS.match(/^\.dt-mission-name\s*\{([^}]*)\}/m)
    expect(name).not.toBeNull()
    const body = (name as RegExpMatchArray)[1]
    expect(body).toContain('position: absolute')
    expect(body).toContain('top: -26px')
  })

  test('+ 버튼이 스페이스 바 우상단에 고정된다 (absolute·right 0·썸네일 중앙)', () => {
    const add = DESKTOP_CSS.match(/\.dt-mission-add\s*\{([^}]*)\}/)
    expect(add).not.toBeNull()
    const body = (add as RegExpMatchArray)[1]
    expect(body).toContain('position: absolute')
    expect(body).toContain('right: 0')
    // 스트립 높이 = 이름 여유 26px + 카드 높이 — + 버튼 중심은
    // 카드(썸네일) 중심과 일치해야 한다 (50% + 13px).
    expect(body).toContain('top: calc(50% + 13px)')
    expect(body).toContain('transform: translateY(-50%)')
    // hover가 transform을 scale만으로 덮으면 버튼이 22px 아래로
    // 튄다 — hover도 translateY(-50%)를 유지해야 한다.
    const hover = DESKTOP_CSS.match(/\.dt-mission-add:hover\s*\{([^}]*)\}/)
    expect(hover).not.toBeNull()
    expect((hover as RegExpMatchArray)[1]).toContain('translateY(-50%)')
  })

  test('미션 배경은 상단바 아래에서 시작하고 상단바가 배경보다 위에 있다', () => {
    const bg = DESKTOP_CSS.match(/\.dt-mission-bg\s*\{([^}]*)\}/)
    expect(bg).not.toBeNull()
    const body = (bg as RegExpMatchArray)[1]
    // inset: 0이면 상단바 뒤까지 어둡게 덮어 상단바가 어두워진다.
    expect(body).not.toContain('inset: 0')
    expect(body).toContain('top: calc(var(--topnav-h')
    expect(body).toContain('left: 0')
    expect(body).toContain('right: 0')
    expect(body).toContain('bottom: 0')
    // 상단바(.g-nav) z 60 > 미션 배경 z 58 — 상단바가 가려지지 않는다.
    // ^ 앵커 필수 — 앞에 html.myhub-embedded .g-nav 규칙이 있어
    // 앵커 없으면 그쪽이 먼저 잡힌다.
    const nav = SHELL_CSS.match(/^\.g-nav\s*\{([^}]*)\}/m)
    expect(nav).not.toBeNull()
    expect((nav as RegExpMatchArray)[1]).toContain('z-index: 60')
    expect(body).toContain('z-index: 58')
  })

  test('미션 중에는 바탕화면 아이콘·위젯이 숨겨지고 닫히면 돌아온다', async () => {
    const m = makeManager()
    const doc = getDoc()
    m.toggleMission()
    expect(doc.body.classList.contains('dt-mission-open')).toBe(true)
    m.toggleMission()
    await wait(350)
    expect(doc.body.classList.contains('dt-mission-open')).toBe(false)
    // CSS가 그 클래스로 아이콘·위젯을 숨긴다 (클래스만 붙고 규칙이
    // 없으면 소용없다 — 양쪽을 함께 고정한다).
    expect(DESKTOP_CSS).toMatch(/body\.dt-mission-open #dt-icons[^{]*\{[^}]*visibility:\s*hidden/)
    expect(DESKTOP_CSS).toMatch(/body\.dt-mission-open #dt-widgets[^{]*\{[^}]*visibility:\s*hidden/)
  })

  test('winrect에 창틀 밴드가 있다 (흰 네모가 아니라 미니 창처럼 보인다)', () => {
    const rect = DESKTOP_CSS.match(/\.dt-mission-winrect\s*\{([^}]*)\}/)
    expect(rect).not.toBeNull()
    expect((rect as RegExpMatchArray)[1]).toContain('inset 0 3px 0')
  })
})

describe('미션 컨트롤 — 전환과 추가', () => {
  test('카드 클릭 → 그 데스크톱으로 전환되고 오버레이가 닫힌다', () => {
    const m = makeManager()
    m.addSpace() // 기존 계약: 추가하면 새 스페이스로 전환된다
    const spaces = m.getState().spaces.slice()
    m.switchSpace(spaces[0])
    expect(m.getState().activeSpace).toBe(spaces[0])
    m.toggleMission()
    click(cards()[1])
    expect(m.getState().activeSpace).toBe(spaces[1])
    expect(m.isMissionOpen()).toBe(false)
  })

  test('+ 버튼 → 데스크톱이 추가되고 오버레이는 열린 채 카드가 늘어난다', () => {
    const m = makeManager()
    m.toggleMission()
    click(getDoc().querySelector('.dt-mission-add'))
    expect(m.getState().spaces.length).toBe(2)
    expect(m.isMissionOpen()).toBe(true)
    expect(cardNames()).toEqual(['데스크톱 1', '데스크톱 2'])
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
    expect(missionEl().hidden).toBe(true)
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

describe('미션 컨트롤 — 원본 기하·CSS 계약', () => {
  test('스프레드 시작점은 MISSION_AREA_TOP 176이다 (바 시절 84가 아니다)', () => {
    expect(WINDOWS_JS).toContain('var MISSION_AREA_TOP = 176;')
    expect(WINDOWS_JS).not.toContain('MISSION_AREA_TOP = 84')
  })

  test('JS는 카드 마크업만 만들고 바 마크업은 만들지 않는다', () => {
    expect(WINDOWS_JS).toContain('dt-mission-spaces')
    expect(WINDOWS_JS).toContain('dt-mission-card')
    expect(WINDOWS_JS).toContain('dt-mission-winrect')
    expect(WINDOWS_JS).not.toContain('dt-mission-bar')
    expect(WINDOWS_JS).not.toContain('dt-mission-label')
    expect(WINDOWS_JS).not.toContain('is-open')
  })

  test('배경 레이어는 fixed·z 58로 배경화면을 직접 칠하고 blur(14px) saturate(1.3)를 건다', () => {
    const bg = DESKTOP_CSS.match(/\.dt-mission-bg\s*\{([^}]*)\}/)
    expect(bg).not.toBeNull()
    const body = (bg as RegExpMatchArray)[1]
    expect(body).toContain('position: fixed')
    expect(body).toContain('z-index: 58')
    expect(body).toContain('var(--dt-mission-wp')
    expect(body).toContain('background-size: cover')
    expect(body).toContain('blur(14px) saturate(1.3)')
    // --dt-mission-wp 소비처는 배경뿐 아니라 카드 썸네일(stage)에도 있다
    const stage = DESKTOP_CSS.match(/\.dt-mission-stage\s*\{([^}]*)\}/)
    expect(stage).not.toBeNull()
    expect((stage as RegExpMatchArray)[1]).toContain('var(--dt-mission-wp')
    // JS가 그 변수를 실제로 공급한다 (죽은 배선이 아니다)
    expect(WINDOWS_JS).toContain("setProperty('--dt-mission-wp'")
  })

  test('애니메이션 동안 블러를 끄는 목록에 .dt-mission-bg가 들어 있다', () => {
    // body.dt-mission-anim 목록에서 배경이 빠지면 스프레드 매 프레임
    // 전폭 블러가 재계산된다 (바 시절 버벅임의 한 원인).
    const off = DESKTOP_CSS.match(/body\.dt-mission-anim [^{]*\{([^}]*)\}/)
    expect(off).not.toBeNull()
    expect(DESKTOP_CSS).toMatch(/body\.dt-mission-anim \.dt-mission-bg/)
    expect((off as RegExpMatchArray)[1]).toContain('backdrop-filter: none')
  })

  test('+ 버튼은 스트립 기준 점선 원형 44px이고, 바 규칙은 CSS에 없다', () => {
    const add = DESKTOP_CSS.match(/\.dt-mission-add\s*\{([^}]*)\}/)
    expect(add).not.toBeNull()
    const body = (add as RegExpMatchArray)[1]
    expect(body).toContain('width: 44px')
    expect(body).toContain('height: 44px')
    expect(body).toContain('border-radius: 50%')
    expect(body).toContain('dashed')
    expect(DESKTOP_CSS).not.toContain('.dt-mission-bar')
    expect(DESKTOP_CSS).not.toContain('.dt-mission-label')
    expect(DESKTOP_CSS).not.toMatch(/#dt-mission\.is-open/)
    expect(DESKTOP_CSS).not.toMatch(/\.dt-mission-anim\s*\{[^}]*transition/)
  })

  test('스프레드 transform 원점과 포인터 차단은 본문 공통 규칙이 보장한다 (원본 계약)', () => {
    // 원점·포인터 차단은 운영 CSS에도 있는 본문 공통 규칙
    // (#dt-root.dt-mission-mode .dt-window / .dt-frame)의 몫이다.
    // 후단 오버레이에 남아 있던 미션 잔존 규칙(라벨 바 시대 값)은
    // 운영 CSS에 없으므로 트리에도 없어야 한다 (감사 B-4로 전량 제거).
    expect(DESKTOP_CSS).toMatch(/#dt-root\.dt-mission-mode \.dt-window\s*\{[^}]*transform-origin:\s*0 0/)
    expect(DESKTOP_CSS).toMatch(/#dt-root\.dt-mission-mode \.dt-frame\s*\{[^}]*pointer-events:\s*none/)
    expect(DESKTOP_CSS).not.toMatch(/\.dt-mission-empty\s*\{/)
    expect(DESKTOP_CSS).not.toMatch(/\.dt-window\.dt-mission-win\s*\{[^}]*box-shadow/)
    expect(DESKTOP_CSS).not.toMatch(/\.dt-window\.dt-mission-win[^{]*\{[^}]*transform-origin/)
    expect(DESKTOP_CSS).not.toMatch(/\.dt-mission-mode \.dt-window iframe/)
    expect(DESKTOP_CSS).not.toMatch(/\.dt-window\.dt-mission-drag\s*\{[^}]*opacity/)
  })

  test('캡션은 운영 원본 값이다 (그림자 4px·nowrap 말줄임)', () => {
    const cap = DESKTOP_CSS.match(/\.dt-mission-caption\s*\{([^}]*)\}/)
    expect(cap).not.toBeNull()
    const body = (cap as RegExpMatchArray)[1]
    expect(body).toContain('text-shadow: 0 1px 4px')
    expect(body).toContain('white-space: nowrap')
    expect(body).toContain('overflow: hidden')
    expect(body).toContain('text-overflow: ellipsis')
  })
})
