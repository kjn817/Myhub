/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 데스크톱 워크스페이스 셸 UI 테스트 (windows.js + nav.js 데스크톱 링크)
 *
 * 설계: docs/desktop-workspace-design-20261030.md 8·10·12절
 * 상태 모델은 병렬 트랙 산출물인 실제 public/js/desktop/state.js를 함께
 * 로드한다 (스텁 아님). 검증 성질:
 * - keep-alive: 창·iframe은 생성 시 1회만 만들어지고 포커스·최소화·복원·
 *   재열기에서 교체/재생성되지 않는다 (닫을 때만 DOM 제거)
 * - 최소화/복원/닫기가 display 토글과 상태 전이에 정확히 연결된다
 * - 포커스 전환 시 z 순서와 active 표시가 상태를 따른다
 * - 저장된 상태로 매니저를 새로 만들면 같은 창 구성이 복원된다
 * - nav.js는 설정 버튼(#settingsBtn)을 .g-nav에 1개만 마운트하고, 설정
 *   메뉴에 '데스크톱 열기'·'로그아웃' 항목이 공존한다 (구 mountDesktopLink·
 *   mountLogoutButton는 설정 메뉴 구조로 대체됨)
 *
 * 런처(독)·아이콘 등 셸 합성은 main.js+dock.js의 몫이라 이 파일에서는
 * 매니저 공개 API(openModule 등)로 창을 연다 — 합성 자체는 실브라우저
 * QA가 담당한다 (jsdom은 히트 테스트를 못 한다).
 *
 * 운영 DB·실제 서버에 닿지 않는다. nav.js는 시계 setInterval을 시작하므로
 * 로드 시 no-op setInterval을 주입한다 (logout-ui.test.ts와 같은 패턴).
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const NAV_JS = fs.readFileSync(path.join(ROOT, 'public', 'nav.js'), 'utf-8')
const STATE_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'state.js'), 'utf-8')
const WINDOWS_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'windows.js'), 'utf-8')
const DESKTOP_HTML = fs.readFileSync(path.join(ROOT, 'public', 'desktop.html'), 'utf-8')

const VIEWPORT = { w: 1280, h: 800 }

function getWin(): any {
  return (globalThis as any).window
}
function getDoc(): any {
  return (globalThis as any).document
}

function loadNav(): any {
  const loader = new Function('window', 'document', 'setInterval', NAV_JS)
  loader(getWin(), getDoc(), () => 0)
  return getWin().MyHubNav
}

function loadStateApi(): any {
  const loader = new Function('window', 'document', STATE_JS)
  loader(getWin(), getDoc())
  return getWin().MyHubDesktopState
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

let manager: any = null

function setupShell() {
  const doc = getDoc()
  doc.body.innerHTML = `
<main id="dt-root"></main>
<footer id="dt-taskbar">
  <div class="dt-launchers"></div>
  <div class="dt-task-sep"></div>
  <div class="dt-task-windows"></div>
</footer>`
  return { root: doc.getElementById('dt-root'), taskbar: doc.getElementById('dt-taskbar') }
}

function makeManager(storage: MemoryStorage): any {
  const { root, taskbar } = setupShell()
  const stateApi = loadStateApi()
  const windowsApi = loadWindowsApi()
  // 현행 배선(main.js)과 동일하게 상태 로드는 호출자가 하고 매니저에 주입한다.
  // renderDock은 독 실행 표시의 경계 — 호출 인자를 모아 검증에 쓴다.
  const dockCalls: any[] = []
  manager = windowsApi.createManager({
    root,
    taskbar,
    stateApi,
    storage,
    getViewport: () => ({ ...VIEWPORT }),
    state: stateApi.load(storage, { ...VIEWPORT }),
    renderDock: (info: any) => { dockCalls.push(info) },
  })
  manager._dockCalls = dockCalls
  return manager
}

afterEach(() => {
  manager = null
})

function lastDockRunning(m: any): Record<string, boolean> {
  const calls = m._dockCalls
  return calls.length ? calls[calls.length - 1].running : {}
}

function winEl(id: string): any {
  return getDoc().querySelector(`.dt-window[data-id="${id}"]`)
}
function pointer(target: any, type: string, x = 0, y = 0): void {
  const ev = new (getWin().MouseEvent)(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })
  target.dispatchEvent(ev)
}

describe('데스크톱 셸 — 창 생성과 keep-alive', () => {
  test('openModule → 창 DOM·iframe이 정확히 1개 생성되고 src가 모듈 url이다', () => {
    const storage = new MemoryStorage()
    const m = makeManager(storage)

    m.openModule('memo')

    const el = winEl('memo')
    expect(el).not.toBeNull()
    expect(getDoc().querySelectorAll('.dt-window').length).toBe(1)
    const frame = el.querySelector('iframe.dt-frame')
    expect(frame).not.toBeNull()
    expect(frame.getAttribute('src')).toBe('/memo.html')
    expect(m.getState().windows.map((w: any) => w.module)).toEqual(['memo'])
    // 독 실행 표시: memo가 실행 중으로 보고된다
    expect(lastDockRunning(m)).toEqual({ memo: true })
  })

  test('keep-alive: 이미 열린 모듈을 다시 열어도 iframe이 교체·재생성되지 않는다', () => {
    const storage = new MemoryStorage()
    const m = makeManager(storage)
    m.openModule('memo')
    const frameBefore = winEl('memo').querySelector('iframe.dt-frame')
    const elBefore = winEl('memo')

    m.openModule('memo')
    m.openModule('memo')

    expect(getDoc().querySelectorAll('.dt-window').length).toBe(1)
    expect(getDoc().querySelectorAll('iframe.dt-frame').length).toBe(1)
    expect(winEl('memo')).toBe(elBefore)
    expect(winEl('memo').querySelector('iframe.dt-frame')).toBe(frameBefore)
    expect(frameBefore.getAttribute('src')).toBe('/memo.html')
    expect(m.getState().windows.length).toBe(1)
  })

  test('keep-alive: 최소화→복원에서도 같은 iframe이 유지된다', () => {
    const storage = new MemoryStorage()
    const m = makeManager(storage)
    m.openModule('memo')
    const frameBefore = winEl('memo').querySelector('iframe.dt-frame')

    winEl('memo').querySelector('.dt-light-min').click()
    m.openModule('memo') // 복원 (독 아이콘 클릭이 이 경로를 탄다)

    expect(winEl('memo').querySelector('iframe.dt-frame')).toBe(frameBefore)
  })
})

describe('데스크톱 셸 — 최소화·복원·닫기', () => {
  test('최소화 → 창이 숨고 상태가 minimized가 되며, 다시 열면 복원된다', () => {
    const storage = new MemoryStorage()
    const m = makeManager(storage)
    m.openModule('memo')

    winEl('memo').querySelector('.dt-light-min').click()

    const el = winEl('memo') // DOM은 keep-alive로 남아 있어야 한다
    expect(el).not.toBeNull()
    expect(el.style.display).toBe('none')
    expect(m.getState().windows[0].minimized).toBe(true)
    // 최소화해도 실행 중 표시는 유지된다 (독 점)
    expect(lastDockRunning(m)).toEqual({ memo: true })

    m.openModule('memo') // 복원

    expect(winEl('memo').style.display).toBe('')
    expect(m.getState().windows[0].minimized).toBe(false)
    expect(m.getState().activeId).toBe('memo')
  })

  test('닫기 → 창 DOM과 상태, 독 실행 표시가 모두 제거된다', () => {
    const storage = new MemoryStorage()
    const m = makeManager(storage)
    m.openModule('memo')
    m.openModule('todo')
    expect(getDoc().querySelectorAll('.dt-window').length).toBe(2)

    winEl('memo').querySelector('.dt-light-close').click()

    expect(winEl('memo')).toBeNull()
    expect(getDoc().querySelectorAll('.dt-window').length).toBe(1)
    expect(m.getState().windows.map((w: any) => w.id)).toEqual(['todo'])
    expect(lastDockRunning(m)).toEqual({ todo: true })
    const saved = JSON.parse(storage.getItem(loadStateApi().STORAGE_KEY) as string)
    expect(saved.windows.map((w: any) => w.id)).toEqual(['todo'])
  })
})

describe('데스크톱 셸 — 포커스와 드래그', () => {
  test('두 창을 열고 본문을 누르면 zIndex·active가 상태를 따라 전환된다', () => {
    const storage = new MemoryStorage()
    const m = makeManager(storage)
    m.openModule('memo')
    m.openModule('schedule')
    expect(m.getState().activeId).toBe('schedule')
    expect(winEl('schedule').classList.contains('is-active')).toBe(true)

    pointer(winEl('memo'), 'pointerdown', 10, 10)

    const st = m.getState()
    const memo = st.windows.find((w: any) => w.id === 'memo')
    const sched = st.windows.find((w: any) => w.id === 'schedule')
    expect(st.activeId).toBe('memo')
    expect(memo.z).toBeGreaterThan(sched.z)
    // zIndex는 상태 z에 셸 베이스(10)를 더한 값으로 렌더된다
    expect(winEl('memo').style.zIndex).toBe(String(10 + memo.z))
    expect(winEl('schedule').style.zIndex).toBe(String(10 + sched.z))
    expect(winEl('memo').classList.contains('is-active')).toBe(true)
    expect(winEl('schedule').classList.contains('is-active')).toBe(false)
  })

  test('이미 active인 창을 다시 눌러도 z가 오르지 않는다 (무동작)', () => {
    const storage = new MemoryStorage()
    const m = makeManager(storage)
    m.openModule('memo')
    const zBefore = m.getState().windows[0].z
    pointer(winEl('memo'), 'pointerdown', 10, 10)
    expect(m.getState().windows[0].z).toBe(zBefore)
  })

  test('제목줄 드래그: 이동 중에는 요소 위치만, 종료 시 상태·저장에 확정된다', () => {
    const storage = new MemoryStorage()
    const m = makeManager(storage)
    m.openModule('memo')
    const before = { ...m.getState().windows[0] }
    const bar = winEl('memo').querySelector('.dt-win-bar')

    pointer(bar, 'pointerdown', 200, 200)
    pointer(getDoc(), 'pointermove', 240, 230)
    // 드래그 중: 요소 left/top만 따라가고 상태는 아직 확정되지 않는다
    expect(winEl('memo').style.left).toBe(before.x + 40 + 'px')
    expect(winEl('memo').style.top).toBe(before.y + 30 + 'px')
    expect(m.getState().windows[0].x).toBe(before.x)

    pointer(getDoc(), 'pointerup', 240, 230)
    const after = m.getState().windows[0]
    expect(after.x).toBe(before.x + 40)
    expect(after.y).toBe(before.y + 30)
    expect(winEl('memo').style.left).toBe(after.x + 'px')
    const saved = JSON.parse(storage.getItem(loadStateApi().STORAGE_KEY) as string)
    expect(saved.windows[0].x).toBe(after.x)
  })
})

describe('데스크톱 셸 — 새로고침 복원', () => {
  test('storage에 저장된 상태로 매니저를 새로 만들면 같은 구성의 창이 렌더링된다', () => {
    const storage = new MemoryStorage()
    const m1 = makeManager(storage)
    m1.openModule('memo')
    m1.openModule('todo')
    const savedState = JSON.parse(JSON.stringify(m1.getState()))
    manager = null // 매니저를 버리고(새로고침 모사) 같은 storage로 다시 만든다

    const m2 = makeManager(storage)

    expect(m2.getState().windows.map((w: any) => w.id)).toEqual(['memo', 'todo'])
    expect(getDoc().querySelectorAll('.dt-window').length).toBe(2)
    for (const w of savedState.windows) {
      const el = winEl(w.id)
      expect(el).not.toBeNull()
      expect(el.style.left).toBe(w.x + 'px')
      expect(el.style.top).toBe(w.y + 'px')
      expect(el.style.width).toBe(w.w + 'px')
      expect(el.style.height).toBe(w.h + 'px')
    }
    expect(winEl('memo').querySelector('iframe.dt-frame').getAttribute('src')).toBe('/memo.html')
    expect(winEl('todo').querySelector('iframe.dt-frame').getAttribute('src')).toBe('/todo.html')
    expect(m2.getState().activeId).toBe(savedState.activeId)
  })
})

describe('nav.js — 설정 버튼과 데스크톱 진입', () => {
  const NAV_HTML = `
<header class="g-nav">
  <a href="/" class="brand-logo">JN</a>
  <div class="spacer"></div>
  <span class="ver" id="clock"></span>
</header>`

  test('로드 시 설정 버튼이 .g-nav 시계 앞에 1개만 마운트된다 (멱등)', () => {
    const doc = getDoc()
    doc.body.innerHTML = NAV_HTML
    const MyHubNav = loadNav() // 로드 시 자동 마운트됨

    const btn = doc.getElementById('settingsBtn')
    expect(btn).not.toBeNull()
    expect(btn!.getAttribute('aria-label')).toBe('설정')
    // 시계 앞 위치
    const clock = doc.getElementById('clock')
    expect(btn!.nextSibling).toBe(clock)

    expect(MyHubNav.mountSettingsButton(doc)).toBe(btn)
    MyHubNav.mountSettingsButton(doc)
    expect(doc.querySelectorAll('#settingsBtn').length).toBe(1)
  })

  test('설정 메뉴에 데스크톱 열기와 로그아웃이 함께 있다', () => {
    const doc = getDoc()
    doc.body.innerHTML = NAV_HTML
    loadNav()
    const btn = doc.getElementById('settingsBtn')
    btn.click() // 메뉴 열기

    const menu = doc.querySelector('.myhub-settings-menu')
    expect(menu).not.toBeNull()
    const labels = [...menu.querySelectorAll('.myhub-settings-item')].map((b: any) => b.textContent)
    expect(labels.some((t: string) => t.includes('데스크톱 열기'))).toBe(true)
    expect(labels.some((t: string) => t.includes('로그아웃'))).toBe(true)
    const logoutItem = [...menu.querySelectorAll('.myhub-settings-item')].find((b: any) => b.textContent.includes('로그아웃'))
    expect(logoutItem.classList.contains('myhub-settings-item-danger')).toBe(true)
  })

  test('.g-nav가 없는 화면에서는 버튼을 만들지 않는다', () => {
    const doc = getDoc()
    doc.body.innerHTML = '<main>상단바 없음</main>'
    const MyHubNav = loadNav()
    expect(MyHubNav.mountSettingsButton(doc)).toBeNull()
    expect(doc.getElementById('settingsBtn')).toBeNull()
  })
})

describe('desktop.html 배선', () => {
  test('스크립트를 file-icons → state → tiles → windows → dock → … → main 순서로 로드하고 인라인 스크립트가 없다', () => {
    const idx = (s: string) => DESKTOP_HTML.indexOf(s)
    // 셸은 nav.js를 쓰지 않는다 (상단바·설정은 셸 자체 구성)
    expect(idx('src="/nav.js"')).toBe(-1)
    const chain = [
      'src="/js/file-icons.js"',
      'src="/js/desktop/state.js"',
      'src="/js/desktop/tiles.js"',
      'src="/js/desktop/windows.js"',
      'src="/js/desktop/dock.js"',
      'src="/js/desktop/desktop-icons.js"',
      'src="/js/desktop/widgets.js"',
      'src="/js/desktop/menu.js"',
      'src="/js/desktop/settings-menu.js"',
      'src="/js/desktop/wallpaper.js"',
      'src="/js/desktop/subchat.js"',
      'src="/js/desktop/version-guard.js"',
      'src="/js/desktop/main.js"',
    ]
    for (const srcAttr of chain) expect(idx(srcAttr)).toBeGreaterThan(-1)
    for (let i = 1; i < chain.length; i++) {
      expect(idx(chain[i - 1])).toBeLessThan(idx(chain[i]))
    }
    expect(DESKTOP_HTML).toContain('href="/css/desktop.css"')
    expect(DESKTOP_HTML).toContain('id="dt-root"')
    expect(DESKTOP_HTML).toContain('id="dt-taskbar"')
    // src 없는 <script> (인라인) 금지 — AGENTS.md 배포 전 esbuild 검증 대상
    expect(/<script(?![^>]*\bsrc=)[^>]*>/.test(DESKTOP_HTML)).toBe(false)
  })

  test('신규 데스크톱 에셋이 정적 에셋 집합에 등록돼 있다', () => {
    const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'static-assets.json'), 'utf-8'))
    for (const f of ['/desktop.html', '/css/desktop.css', '/js/desktop/state.js', '/js/desktop/windows.js', '/js/desktop/main.js']) {
      expect(list.files).toContain(f)
    }
    expect(list.versioned).toContain('/desktop.html')
  })
})
