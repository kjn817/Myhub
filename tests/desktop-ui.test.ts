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
 * - nav.js mountDesktopLink가 .g-nav에 링크 1개만 마운트하고 로그아웃과 공존한다
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
  manager = windowsApi.createManager({
    root,
    taskbar,
    stateApi,
    storage,
    getViewport: () => ({ ...VIEWPORT }),
  })
  return manager
}

afterEach(() => {
  if (manager) {
    manager.destroy()
    manager = null
  }
})

function launcher(moduleId: string): any {
  return getDoc().querySelector(`.dt-launcher[data-module="${moduleId}"]`)
}
function winEl(id: string): any {
  return getDoc().querySelector(`.dt-window[data-id="${id}"]`)
}
function taskBtn(id: string): any {
  return getDoc().querySelector(`.dt-task-btn[data-id="${id}"]`)
}
function pointer(target: any, type: string, x = 0, y = 0): void {
  const ev = new (getWin().MouseEvent)(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })
  target.dispatchEvent(ev)
}

describe('데스크톱 셸 — 창 생성과 keep-alive', () => {
  test('모듈 런처 클릭 → 창 DOM·iframe이 정확히 1개 생성되고 src가 모듈 url이다', () => {
    const storage = new MemoryStorage()
    const m = makeManager(storage)
    expect(launcher('memo')).not.toBeNull()
    expect(launcher('schedule')).not.toBeNull()
    expect(launcher('todo')).not.toBeNull()
    expect(launcher('chat')).not.toBeNull()

    launcher('memo').click()

    const el = winEl('memo')
    expect(el).not.toBeNull()
    expect(getDoc().querySelectorAll('.dt-window').length).toBe(1)
    const frame = el.querySelector('iframe.dt-frame')
    expect(frame).not.toBeNull()
    expect(frame.getAttribute('src')).toBe('/memo.html')
    expect(m.getState().windows.map((w: any) => w.module)).toEqual(['memo'])
    expect(taskBtn('memo')).not.toBeNull()
  })

  test('keep-alive: 이미 열린 모듈을 다시 열어도 iframe이 교체·재생성되지 않는다', () => {
    const storage = new MemoryStorage()
    const m = makeManager(storage)
    launcher('memo').click()
    const frameBefore = winEl('memo').querySelector('iframe.dt-frame')
    const elBefore = winEl('memo')

    launcher('memo').click()
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
    makeManager(storage)
    launcher('memo').click()
    const frameBefore = winEl('memo').querySelector('iframe.dt-frame')

    winEl('memo').querySelector('.dt-btn-min').click()
    taskBtn('memo').click()

    expect(winEl('memo').querySelector('iframe.dt-frame')).toBe(frameBefore)
  })
})

describe('데스크톱 셸 — 최소화·복원·닫기', () => {
  test('최소화 → 창이 숨고 작업 표시줄 버튼에 최소화 상태가 표시되며, 버튼 클릭으로 복원된다', () => {
    const storage = new MemoryStorage()
    const m = makeManager(storage)
    launcher('memo').click()

    winEl('memo').querySelector('.dt-btn-min').click()

    const el = winEl('memo') // DOM은 keep-alive로 남아 있어야 한다
    expect(el).not.toBeNull()
    expect(el.style.display).toBe('none')
    expect(el.classList.contains('dt-minimized')).toBe(true)
    expect(m.getState().windows[0].minimized).toBe(true)
    expect(taskBtn('memo').classList.contains('is-minimized')).toBe(true)

    taskBtn('memo').click()

    expect(winEl('memo').style.display).toBe('')
    expect(winEl('memo').classList.contains('dt-minimized')).toBe(false)
    expect(m.getState().windows[0].minimized).toBe(false)
    expect(m.getState().activeId).toBe('memo')
    expect(taskBtn('memo').classList.contains('is-minimized')).toBe(false)
  })

  test('닫기 → 창 DOM과 상태, 작업 표시줄 버튼이 모두 제거된다', () => {
    const storage = new MemoryStorage()
    const m = makeManager(storage)
    launcher('memo').click()
    launcher('todo').click()
    expect(getDoc().querySelectorAll('.dt-window').length).toBe(2)

    winEl('memo').querySelector('.dt-btn-close').click()

    expect(winEl('memo')).toBeNull()
    expect(getDoc().querySelectorAll('.dt-window').length).toBe(1)
    expect(m.getState().windows.map((w: any) => w.id)).toEqual(['todo'])
    expect(taskBtn('memo')).toBeNull()
    const saved = JSON.parse(storage.getItem(loadStateApi().STORAGE_KEY) as string)
    expect(saved.windows.map((w: any) => w.id)).toEqual(['todo'])
  })
})

describe('데스크톱 셸 — 포커스와 드래그', () => {
  test('두 창을 열고 본문을 누르면 zIndex·active가 상태를 따라 전환된다', () => {
    const storage = new MemoryStorage()
    const m = makeManager(storage)
    launcher('memo').click()
    launcher('schedule').click()
    expect(m.getState().activeId).toBe('schedule')
    expect(winEl('schedule').classList.contains('is-active')).toBe(true)

    pointer(winEl('memo'), 'pointerdown', 10, 10)

    const st = m.getState()
    const memo = st.windows.find((w: any) => w.id === 'memo')
    const sched = st.windows.find((w: any) => w.id === 'schedule')
    expect(st.activeId).toBe('memo')
    expect(memo.z).toBeGreaterThan(sched.z)
    expect(winEl('memo').style.zIndex).toBe(String(memo.z))
    expect(winEl('schedule').style.zIndex).toBe(String(sched.z))
    expect(winEl('memo').classList.contains('is-active')).toBe(true)
    expect(winEl('schedule').classList.contains('is-active')).toBe(false)
    expect(taskBtn('memo').classList.contains('is-active')).toBe(true)
    expect(taskBtn('schedule').classList.contains('is-active')).toBe(false)
  })

  test('이미 active인 창을 다시 눌러도 z가 오르지 않는다 (무동작)', () => {
    const storage = new MemoryStorage()
    const m = makeManager(storage)
    launcher('memo').click()
    const zBefore = m.getState().windows[0].z
    pointer(winEl('memo'), 'pointerdown', 10, 10)
    expect(m.getState().windows[0].z).toBe(zBefore)
  })

  test('제목줄 드래그: 이동 중에는 transform만, 종료 시 상태·저장에 확정된다', () => {
    const storage = new MemoryStorage()
    const m = makeManager(storage)
    launcher('memo').click()
    const before = { ...m.getState().windows[0] }
    const bar = winEl('memo').querySelector('.dt-titlebar')

    pointer(bar, 'pointerdown', 200, 200)
    pointer(getDoc(), 'pointermove', 240, 230)
    expect(winEl('memo').style.transform).toContain('40px')
    expect(m.getState().windows[0].x).toBe(before.x) // 종료 전에는 상태 불변

    pointer(getDoc(), 'pointerup', 240, 230)
    const after = m.getState().windows[0]
    expect(after.x).toBe(before.x + 40)
    expect(after.y).toBe(before.y + 30)
    expect(winEl('memo').style.transform).toBe('')
    expect(winEl('memo').style.left).toBe(after.x + 'px')
    expect(getDoc().getElementById('dt-root').classList.contains('dt-dragging')).toBe(false)
    const saved = JSON.parse(storage.getItem(loadStateApi().STORAGE_KEY) as string)
    expect(saved.windows[0].x).toBe(after.x)
  })
})

describe('데스크톱 셸 — 새로고침 복원', () => {
  test('storage에 저장된 상태로 매니저를 새로 만들면 같은 구성의 창이 렌더링된다', () => {
    const storage = new MemoryStorage()
    const m1 = makeManager(storage)
    launcher('memo').click()
    launcher('todo').click()
    const savedState = JSON.parse(JSON.stringify(m1.getState()))
    m1.destroy()
    manager = null

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

describe('nav.js — 데스크톱 진입 링크', () => {
  const NAV_HTML = `
<header class="g-nav">
  <a href="/" class="brand-logo">JN</a>
  <div class="spacer"></div>
  <span class="ver" id="clock"></span>
</header>`

  test('mountDesktopLink가 .g-nav에 데스크톱 링크 1개만 마운트하고 로그아웃과 공존한다', () => {
    const doc = getDoc()
    doc.body.innerHTML = NAV_HTML
    const MyHubNav = loadNav() // 로드 시 자동 마운트됨

    const link = doc.getElementById('desktopLink')
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('/desktop.html')
    expect(link.getAttribute('aria-label')).toBe('데스크톱')
    expect(link.querySelector('svg.lucide-layout-grid')).not.toBeNull()
    expect(doc.getElementById('logoutBtn')).not.toBeNull()

    MyHubNav.mountDesktopLink(doc)
    MyHubNav.mountDesktopLink(doc)
    expect(doc.querySelectorAll('#desktopLink').length).toBe(1)
    expect(doc.querySelectorAll('a.desktop-link').length).toBe(1)
    expect(MyHubNav.DESKTOP_URL).toBe('/desktop.html')
  })

  test('.g-nav가 없는 화면에서는 링크를 만들지 않는다', () => {
    const doc = getDoc()
    doc.body.innerHTML = '<main>상단바 없음</main>'
    const MyHubNav = loadNav()
    expect(MyHubNav.mountDesktopLink(doc)).toBeNull()
    expect(doc.getElementById('desktopLink')).toBeNull()
  })
})

describe('desktop.html 배선', () => {
  test('스크립트를 nav → state → windows → main 순서로 로드하고 인라인 스크립트가 없다', () => {
    const idx = (s: string) => DESKTOP_HTML.indexOf(s)
    expect(idx('src="/nav.js"')).toBeGreaterThan(-1)
    expect(idx('src="/nav.js"')).toBeLessThan(idx('src="/js/desktop/state.js"'))
    expect(idx('src="/js/desktop/state.js"')).toBeLessThan(idx('src="/js/desktop/windows.js"'))
    expect(idx('src="/js/desktop/windows.js"')).toBeLessThan(idx('src="/js/desktop/main.js"'))
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
