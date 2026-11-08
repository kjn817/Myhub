/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 로그아웃 UI 테스트 — 공용 상단바(nav.js)의 로그아웃 버튼
 *
 * 배경: 로그아웃 API(POST /api/auth/logout — 쿠키 삭제 + 서버 측 세션 무효화)는
 * 있었지만 어떤 화면에서도 호출하지 않아 사용자가 화면에서 로그아웃할 방법이
 * 없었다. nav.js가 .g-nav(시계 앞)에 버튼을 마운트하는 방식으로 진입점을 추가한다.
 *
 * - handleLogout: POST /api/auth/logout 호출 → 성공 시 /login.html 이동,
 *   실패(네트워크·비200) 시 사용자에게 알리고 이동하지 않음
 * - mountLogoutButton: .g-nav에 버튼 1개 마운트, 클릭 배선, 중복 클릭 가드,
 *   .g-nav 없는 화면에서는 무동작
 * - 배선: 주요 화면 10개가 nav.js를 로드하고, shell.css에 버튼 스타일이 있으며,
 *   nav.js·shell.css가 정적 에셋 집합에 포함됨. memory·search·backup 화면은
 *   .g-nav는 있으나 시계(#clock)가 없어 버튼이 상단바 끝에 붙는 경로를 탄다
 *
 * 운영 DB·실제 서버에 닿지 않음. nav.js는 시계 setInterval을 시작하므로
 * 로드 시 no-op setInterval을 주입한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const NAV_JS = fs.readFileSync(path.join(ROOT, 'public', 'nav.js'), 'utf-8')
const SHELL_CSS = fs.readFileSync(path.join(ROOT, 'public', 'shell.css'), 'utf-8')

const NAV_HTML = `
<header class="g-nav">
  <a href="/" class="brand-logo">JN</a>
  <div class="spacer"></div>
  <span class="ver" id="clock"></span>
</header>`

function getWin(): any {
  return (globalThis as any).window
}
function getDoc(): any {
  return (globalThis as any).document
}

/** nav.js를 현재 jsdom 문서에 대해 1회 로드하고 MyHubNav를 반환한다. */
function loadNav(): any {
  const win = getWin()
  const doc = getDoc()
  const loader = new Function('window', 'document', 'setInterval', NAV_JS)
  loader(win, doc, () => 0)
  return win.MyHubNav
}

interface FakeLocation {
  href: string
}

function makeDeps(behavior: 'ok' | 'http-error' | 'network-error') {
  const calls: Array<{ url: string; method?: string }> = []
  const fetchFn = jest.fn(async (url: string, opts?: { method?: string }) => {
    calls.push({ url, method: opts?.method })
    if (behavior === 'network-error') throw new Error('network down')
    if (behavior === 'http-error') return { ok: false, status: 500 }
    return { ok: true, status: 200 }
  })
  const location: FakeLocation = { href: '' }
  const alertFn = jest.fn()
  return { calls, fetchFn, location, alertFn, deps: { fetchFn, location, alertFn } }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 10))

describe('handleLogout — 로그아웃 API 호출과 화면 이동', () => {
  test('성공: POST /api/auth/logout을 호출하고 /login.html로 이동한다', async () => {
    const MyHubNav = loadNav()
    const h = makeDeps('ok')
    const ok = await MyHubNav.handleLogout(h.deps)
    expect(ok).toBe(true)
    expect(h.calls).toEqual([{ url: '/api/auth/logout', method: 'POST' }])
    expect(h.location.href).toBe('/login.html')
    expect(h.alertFn).not.toHaveBeenCalled()
  })

  test('HTTP 오류: 이동하지 않고 사용자에게 실패를 알린다', async () => {
    const MyHubNav = loadNav()
    const h = makeDeps('http-error')
    const ok = await MyHubNav.handleLogout(h.deps)
    expect(ok).toBe(false)
    expect(h.location.href).toBe('')
    expect(h.alertFn).toHaveBeenCalledTimes(1)
    expect(h.alertFn.mock.calls[0][0]).toContain('로그아웃에 실패')
  })

  test('네트워크 오류: 조용히 넘어가지 않고 사용자에게 실패를 알린다', async () => {
    const MyHubNav = loadNav()
    const h = makeDeps('network-error')
    const ok = await MyHubNav.handleLogout(h.deps)
    expect(ok).toBe(false)
    expect(h.location.href).toBe('')
    expect(h.alertFn).toHaveBeenCalledTimes(1)
  })

  test('상수: 로그아웃 경로·로그인 경로는 서버 라우트와 일치한다', () => {
    const MyHubNav = loadNav()
    expect(MyHubNav.LOGOUT_URL).toBe('/api/auth/logout')
    expect(MyHubNav.LOGIN_URL).toBe('/login.html')
  })
})

describe('설정 버튼·메뉴 — 상단바 마운트와 로그아웃 배선', () => {
  test('.g-nav의 시계 앞에 설정(기어) 버튼이 마운트된다', () => {
    const doc = getDoc()
    doc.body.innerHTML = NAV_HTML
    loadNav() // 로드 시 자동 마운트됨
    const btn = doc.getElementById('settingsBtn')
    expect(btn).not.toBeNull()
    expect(btn.className).toContain('settings-btn')
    expect(btn.getAttribute('aria-label')).toBe('설정')
    expect(btn.querySelector('svg')).not.toBeNull() // 기어 아이콘
    // 시계 바로 앞
    const clock = doc.getElementById('clock')
    expect(btn.nextElementSibling).toBe(clock)
  })

  test('두 번 마운트해도 버튼은 1개만 남는다', () => {
    const doc = getDoc()
    doc.body.innerHTML = NAV_HTML
    const MyHubNav = loadNav()
    MyHubNav.mountSettingsButton(doc)
    MyHubNav.mountSettingsButton(doc)
    expect(doc.querySelectorAll('#settingsBtn').length).toBe(1)
  })

  test('시계(#clock)가 없는 .g-nav에서는 버튼이 상단바 끝에 붙는다 (memory·search·backup 구조)', () => {
    const doc = getDoc()
    doc.body.innerHTML = `
<header class="g-nav">
  <a href="/" class="brand-logo">JN</a>
  <div class="spacer"></div>
</header>`
    loadNav()
    const btn = doc.getElementById('settingsBtn')
    expect(btn).not.toBeNull()
    const nav = doc.querySelector('.g-nav')
    expect(btn.parentElement).toBe(nav)
    expect(nav.lastElementChild).toBe(btn)
  })

  test('.g-nav가 없는 화면에서는 버튼을 만들지 않고 오류도 내지 않는다', () => {
    const doc = getDoc()
    doc.body.innerHTML = '<main>상단바 없음</main>'
    const MyHubNav = loadNav()
    expect(MyHubNav.mountSettingsButton(doc)).toBeNull()
    expect(doc.getElementById('settingsBtn')).toBeNull()
  })

  function openMenuAndFindLogout(doc: any): any {
    doc.getElementById('settingsBtn').click()
    const menu = doc.querySelector('.myhub-settings-menu')
    expect(menu).not.toBeNull()
    const item = [...menu.querySelectorAll('.myhub-settings-item')].find((b: any) =>
      b.textContent.includes('로그아웃'),
    )
    expect(item).toBeDefined()
    return item
  }

  test('메뉴의 로그아웃 클릭: API를 호출하고 메뉴가 닫힌다', async () => {
    const doc = getDoc()
    doc.body.innerHTML = NAV_HTML
    loadNav()
    const fetchFn = jest.fn(async () => ({ ok: true, status: 200 }))
    ;(globalThis as any).fetch = fetchFn
    const item = openMenuAndFindLogout(doc)
    item.click()
    await flush()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' })
    // 항목 클릭 즉시 메뉴가 닫혀 같은 항목을 연달아 누를 수 없다
    expect(doc.querySelector('.myhub-settings-menu')).toBeNull()
    delete (globalThis as any).fetch
  })

  test('메뉴의 로그아웃 클릭 실패: 사용자에게 실패를 알린다', async () => {
    const doc = getDoc()
    doc.body.innerHTML = NAV_HTML
    loadNav()
    const fetchFn = jest.fn(async () => { throw new Error('network down') })
    ;(globalThis as any).fetch = fetchFn
    const alertSpy = jest.spyOn(getWin(), 'alert').mockImplementation(() => {})
    try {
      const item = openMenuAndFindLogout(doc)
      item.click()
      await flush()
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(alertSpy).toHaveBeenCalledTimes(1)
      expect(alertSpy.mock.calls[0][0]).toContain('로그아웃에 실패')
    } finally {
      alertSpy.mockRestore()
      delete (globalThis as any).fetch
    }
  })
})

describe('배선 — 주요 화면과 정적 에셋', () => {
  const MAIN_PAGES = ['index.html', 'memo.html', 'schedule.html', 'todo.html', 'chat.html', 'agent.html', 'trace.html', 'memory.html', 'search.html', 'backup.html']

  test.each(MAIN_PAGES)('%s는 공용 nav.js를 로드한다 (로그아웃 버튼이 닿는 화면)', (page) => {
    const html = fs.readFileSync(path.join(ROOT, 'public', page), 'utf-8')
    expect(html).toContain('src="/nav.js"')
  })

  test('nav.js·shell.css가 정적 에셋 업로드 집합에 있다', () => {
    const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'static-assets.json'), 'utf-8'))
    expect(list.files).toContain('/nav.js')
    expect(list.files).toContain('/shell.css')
  })

  test('createVersioner가 nav.js·shell.css에 ?v=를 붙인다 (구버전 캐시 방지)', () => {
    // ?v= 부착은 deploy_full.py의 고정 목록이 아니라 scripts/asset-version.cjs의
    // createVersioner(매니페스트 집합 기준)가 담당한다 (2026-11-01 교체).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createVersioner } = require('../scripts/asset-version.cjs')
    const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'static-assets.json'), 'utf-8'))
    const ver = createVersioner(list, 'testver1')
    expect(ver('<script src="/nav.js"></script>')).toContain('/nav.js?v=testver1')
    expect(ver('<link href="/shell.css">')).toContain('/shell.css?v=testver1')
    const deploy = fs.readFileSync(path.join(ROOT, 'deploy_full.py'), 'utf-8')
    expect(deploy).toContain('createVersioner')
  })

  test('shell.css에 설정 버튼과 로그아웃(danger) 메뉴 항목 스타일이 있다', () => {
    expect(SHELL_CSS).toContain('.g-nav .settings-btn')
    expect(SHELL_CSS).toContain('.myhub-settings-item-danger')
  })

  test('nav.js 소스에 로그아웃 API 경로가 정확히 있다 (카나리아 기준)', () => {
    expect(NAV_JS).toContain("'/api/auth/logout'")
  })
})
