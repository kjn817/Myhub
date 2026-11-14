/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 바탕화면 셸 복원 회귀 (2026-11-10 파손 9표면 중 메뉴·상단바·창 컨트롤)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - JN 메뉴가 원본 구성 [미션 컨트롤·시스템 설정·백업·로그아웃]으로
 *   실제 렌더된다 (전사 소실로 label:''가 되면 항목이 빈칸이 되거나
 *   adaptMenuItem에서 버려져 이 단언이 실패한다).
 * - 앱 이름 메뉴가 [최소화·창 닫기]로 렌더되고, 활성 창이 없으면
 *   상단바 앱 제목이 '데스크톱'이다.
 * - 확대 버튼 aria-label이 모드 동기화에서 지워지지 않는다
 *   (full이면 '원래 크기로', 아니면 '확대').
 * - 독 항목 라벨(설정·휴지통)이 aria-label로 실제 렌더된다.
 * - desktop.html/CSS의 구조 계약: #dt-surface가 배경·아이콘·위젯
 *   레이어를 감싸고 #dt-root(창 루트)는 body 직속 형제다 (아래 구조
 *   계약 테스트의 개정 사유 참조), JN은 텍스트 마크이며, #dt-icons는
 *   pointer-events:none + 아이콘만 auto (빈 영역 입력이 배경화면에
 *   닿는 전제), .dt-desk-icon은 투명 배경 (UA 버튼 면 #efefef 회귀
 *   방지), shell.css는 운영 원본이다
 *   (--aws-* 토큰 명명은 원본의 잔존 명명 — 2026-11-11 바이트 회수로 정정).
 * - 컨텍스트 메뉴 hover·활성 선택 색이 원본 값(#0a84ff/#dc2626 솔리드 +
 *   흰 글자)이다 — #eff6ff 틴트로 되돌리면 실패한다.
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
const ANIM_JS = read('public/js/common/anim.js')
const MENU_ITEMS_JS = read('public/js/common/menu-items.js')
const DESKTOP_HTML = read('public/desktop.html')
const DESKTOP_CSS = read('public/css/desktop.css')
// C-L7 (5-8): 컨텍스트 메뉴 hover·활성·danger·체크·라벨·보조·화살표 규칙은
// desktop.css에서 공용 코어로 이동했다 — 페이지는 두 파일을 함께 로드한다.
const CTX_MENU_CSS = read('public/css/common/ctx-menu.css')
const DESKTOP_CTX_CSS = DESKTOP_CSS + '\n' + CTX_MENU_CSS
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
  // F-L11/F-L13: menu-items·anim 공용 코어를 windows.js보다 먼저 뜬다
  // (운영 desktop.html의 정적 태그 순서와 동일).
  new Function('window', 'document', ANIM_JS)(win, doc)
  new Function('window', 'document', MENU_ITEMS_JS)(win, doc)
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
function menuLabels(): string[] {
  return Array.from(getDoc().querySelectorAll('.dt-ctx-menu .dt-ctx-label')).map(
    (n: any) => n.textContent,
  )
}

describe('JN 메뉴 — 원본 구성 라벨 복원', () => {
  test('JN 클릭 → [미션 컨트롤·시스템 설정·백업·로그아웃]이 렌더된다', () => {
    makeManager()
    click(getDoc().querySelector('.g-nav .brand-logo'))
    expect(menuLabels()).toEqual(['미션 컨트롤', '시스템 설정', '백업', '로그아웃'])
  })

  test('활성 창이 없으면 앱 제목이 데스크톱이다', () => {
    makeManager()
    expect(getDoc().getElementById('dt-active-title').textContent).toBe('데스크톱')
  })
})

describe('앱 이름 메뉴 — 라벨 복원', () => {
  test('창을 열고 앱 제목 클릭 → [최소화·창 닫기]가 렌더된다', () => {
    const m = makeManager()
    m.openModule('memo')
    expect(getDoc().getElementById('dt-active-title').textContent).toBe('메모')
    click(getDoc().getElementById('dt-active-title'))
    expect(menuLabels()).toEqual(['최소화', '창 닫기'])
  })
})

describe('창 컨트롤 — 확대 버튼 라벨', () => {
  test('확대 전 aria-label은 확대, full 진입 후 원래 크기로, 복원하면 다시 확대', () => {
    const m = makeManager()
    m.openModule('memo')
    const btn = getDoc().querySelector('.dt-window .dt-btn-max')
    expect(btn.getAttribute('aria-label')).toBe('확대')
    m.toggleMaximize(m.getState().activeId)
    expect(btn.getAttribute('aria-label')).toBe('원래 크기로')
    m.toggleMaximize(m.getState().activeId)
    expect(btn.getAttribute('aria-label')).toBe('확대')
  })
})

describe('독 항목 라벨', () => {
  test('설정·휴지통 독 항목의 aria-label이 비어 있지 않다', () => {
    makeManager()
    const labels: Record<string, string> = {}
    getDoc().querySelectorAll('.dt-dock-item').forEach((b: any) => {
      labels[b.dataset.module] = b.getAttribute('aria-label')
    })
    expect(labels.settings).toBe('설정')
    expect(labels.trash).toBe('휴지통')
  })
})

describe('desktop.html / CSS 구조 계약', () => {
  // 구조 계약 개정 (2026-11-11): 종전 계약은 "#dt-surface가 창 루트까지
  // 감싼다"였으나 원본 구조로 정정한다. 근거:
  // - 원본 증거에 #dt-surface가 없다 — 운영 전사본 JS 전체
  //   (~/workspace/prod-pull/files/)와 운영 회수 desktop.css 어디에도
  //   'dt-surface' 참조가 0건이다. 래퍼는 재구성 산물이다.
  // - 운영 CSS의 미션 레이어 산술(배경 z 58 < 창 루트 z 60 < 미션 띠
  //   z 65 < 독 z 70)은 네 레이어가 전부 body 형제일 때만 성립한다.
  // - position:fixed인 #dt-surface는 스태킹 컨텍스트를 만들어 내부
  //   #dt-root의 z 60을 통째로 가둔다 — 실제로 미션 컨트롤에서 배경
  //   (z 58)이 스프레드 창 위에 깔려 창 본문이 블러에 묻히는 결함이
  //   실브라우저 elementsFromPoint로 확정됐다 (진단 후속 실측).
  // #dt-root는 position:fixed라 부모와 무관하게 뷰포트 기준이며,
  // 히트 테스트 계약(루트 pointer-events:none·창만 auto)과 밴드 표면
  // (배경화면 레이어) 계약은 부모 이동과 무관하게 유지된다.
  test('#dt-surface는 배경·아이콘·위젯을 감싸고 창 루트는 감싸지 않는다', () => {
    const surface = DESKTOP_HTML.match(/<main id="dt-surface">([\s\S]*?)<\/main>/)
    expect(surface).not.toBeNull()
    const inner = (surface as RegExpMatchArray)[1]
    for (const id of ['dt-wallpaper', 'dt-icons', 'dt-widgets']) {
      expect(inner).toContain(`id="${id}"`)
    }
    expect(inner).not.toContain('id="dt-root"')
  })

  test('#dt-root는 body 직속 형제로 #dt-surface 다음·#dt-mission 앞에 있다', () => {
    const mainEnd = DESKTOP_HTML.indexOf('</main>')
    const rootIdx = DESKTOP_HTML.indexOf('id="dt-root"')
    const missionIdx = DESKTOP_HTML.indexOf('id="dt-mission"')
    expect(mainEnd).toBeGreaterThan(-1)
    expect(rootIdx).toBeGreaterThan(mainEnd)
    expect(missionIdx).toBeGreaterThan(rootIdx)
  })

  test('미션 레이어 z 산술이 원본대로다 (배경 58 < 창 루트 60 < 띠 65 < 독 70)', () => {
    const zOf = (re: RegExp) => {
      const m = DESKTOP_CSS.match(re)
      expect(m).not.toBeNull()
      return parseInt((m as RegExpMatchArray)[1], 10)
    }
    const bg = zOf(/\.dt-mission-bg\s*\{[^}]*z-index:\s*(\d+)/)
    const root = zOf(/#dt-root\.dt-mission-mode\s*\{\s*z-index:\s*(\d+)/)
    const strip = zOf(/\.dt-mission\s*\{[^}]*z-index:\s*(\d+)/)
    const dock = zOf(/#dt-dock\s*\{[^}]*z-index:\s*(\d+)/)
    expect([bg, root, strip, dock]).toEqual([58, 60, 65, 70])
  })

  test('JN 마크는 운영 메커니즘이다: brand-logo img + desktop.css ::after 텍스트', () => {
    // 운영본 desktop.css(2026-11-10 회수)가 정본: 데스크톱에서는 img를
    // 숨기고 .brand-logo::after { content:'JN' }가 글자를 그린다.
    // 마크업에 텍스트 노드까지 있으면 'JNJN'으로 이중 렌더된다.
    const header = DESKTOP_HTML.match(/<header class="g-nav">([\s\S]*?)<\/header>/)
    expect(header).not.toBeNull()
    const inner = (header as RegExpMatchArray)[1]
    expect(inner).toContain('class="brand-logo"')
    expect(inner).toContain('<img src="/icon-192.png" alt="JN">')
    expect(inner).not.toContain('>JN</a>')
    expect(DESKTOP_CSS).toMatch(/\.g-nav \.brand-logo img\s*\{\s*display: none/)
    expect(DESKTOP_CSS).toMatch(/\.g-nav \.brand-logo::after\s*\{\s*content: 'JN'/)
  })

  test('상단바 앱 제목은 .dt-active-title 버튼이다 (원본 캡처 글리프 시작 56.1px의 전제)', () => {
    // 운영본 desktop.css의 .dt-active-title(padding 3px 7px·margin 0 -1px·
    // cursor pointer·버튼 리셋)이 가리키는 요소가 제목 버튼이다. 클래스 없는
    // span이면 글리프 시작이 원본 캡처 56.1px보다 7px 왼쪽(49px)으로 어긋나고
    // (2026-11-10 표면 게이트 실측), 메뉴바 트리거의 알약 스타일도 죽는다.
    const header = DESKTOP_HTML.match(/<header class="g-nav">([\s\S]*?)<\/header>/)
    expect(header).not.toBeNull()
    const inner = (header as RegExpMatchArray)[1]
    expect(inner).toContain('<button type="button" id="dt-active-title" class="dt-active-title">데스크톱</button>')
    expect(DESKTOP_CSS).toMatch(/\.dt-active-title\s*\{[^}]*padding: 3px 7px/)
  })

  test('#dt-icons는 pointer-events:none, 아이콘 실물만 auto다', () => {
    const layer = DESKTOP_CSS.match(/#dt-icons\s*\{([^}]*)\}/)
    expect(layer).not.toBeNull()
    expect((layer as RegExpMatchArray)[1]).toContain('pointer-events: none')
    const icon = DESKTOP_CSS.match(/\.dt-desk-icon\s*\{([^}]*)\}/)
    expect(icon).not.toBeNull()
    const body = (icon as RegExpMatchArray)[1]
    expect(body).toContain('pointer-events: auto')
    // 운영본(2026-11-10 회수)의 표기는 'background: none'이다.
    expect(body).toContain('background: none')
  })

  test('shell.css는 운영 원본이다 (AWS 토큰 표기는 원본의 잔존 명명)', () => {
    // 2026-11-11 정정: 재구성 시절엔 --aws-* 토큰을 구세대 오염으로 보고
    // 금지했었다. 그러나 운영 원본 바이트(해시 대조로 회수)를 직접 읽으면
    // 원본 :root에 --aws-* 명명이 그대로 있고, 본문 규칙(.g-nav·설정·연결
    // 패널)이 현행 값이다 — 토큰 이름만 옛 명명일 뿐 파일은 현행 원본이다.
    // 재구성본으로 되돌리면 아래 단언이 실패한다 (카나리아).
    expect(SHELL_CSS).toContain('--aws-nav: #232f3e')
    expect(SHELL_CSS).toContain('.myhub-connect-panel')
    // 본 규칙(position: fixed인 것)을 골라 검사한다 — 앞쪽의 임베드용
    // .g-nav 숨김 규칙과 혼동하지 않기 위해서다.
    const navBodies = [...SHELL_CSS.matchAll(/\.g-nav \{([^}]*)\}/g)].map((m) => m[1])
    const mainNav = navBodies.find((b) => b.includes('position: fixed'))
    expect(mainNav).toBeDefined()
    expect(mainNav as string).toContain('blur(20px)')
  })

  // 메뉴 hover·활성 선택 색은 원본(운영 서빙본, 2026-11-10 회수) 값이어야 한다:
  // hover/is-active = #0a84ff 솔리드 + 흰 글자, danger = #dc2626.
  // 재구성본의 var(--dt-accent-soft)(#eff6ff 틴트)로 되돌리면 실패한다.
  test('컨텍스트 메뉴 hover·활성 선택 색이 원본 #0a84ff/#dc2626이다', () => {
    // C-L7 (5-8): 이 규칙들은 공용 코어(ctx-menu.css)에 있다 — desktop.css
    // 단독이 아니라 페이지가 함께 로드하는 합집합에서 검사한다.
    const hover = DESKTOP_CTX_CSS.match(/\.dt-ctx-item:hover\s*\{([^}]*)\}/)
    expect(hover).not.toBeNull()
    expect((hover as RegExpMatchArray)[1]).toContain('background: #0a84ff')
    expect((hover as RegExpMatchArray)[1]).toContain('color: #fff')
    const active = DESKTOP_CTX_CSS.match(/\.dt-ctx-item\.is-active\s*\{([^}]*)\}/)
    expect(active).not.toBeNull()
    expect((active as RegExpMatchArray)[1]).toContain('background: #0a84ff')
    const danger = DESKTOP_CTX_CSS.match(/\.dt-ctx-item\.is-danger:hover\s*\{([^}]*)\}/)
    expect(danger).not.toBeNull()
    expect((danger as RegExpMatchArray)[1]).toContain('background: #dc2626')
    const dangerActive = DESKTOP_CTX_CSS.match(/\.dt-ctx-item\.is-danger\.is-active\s*\{([^}]*)\}/)
    expect(dangerActive).not.toBeNull()
    expect((dangerActive as RegExpMatchArray)[1]).toContain('background: #dc2626')
    expect(DESKTOP_CTX_CSS).not.toMatch(/\.dt-ctx-item:hover[^{]*\{[^}]*--dt-accent-soft/)
    // menu.js가 방출하는 클래스는 is-danger다 — 죽은 규칙(.dt-ctx-item-danger)이
    // 아니라 실제 클래스에 danger 색이 걸려 있어야 한다.
    expect(DESKTOP_CTX_CSS).toMatch(/\.dt-ctx-item\.is-danger\s*\{[^}]*color: #dc2626/)
    expect(DESKTOP_CTX_CSS).not.toContain('.dt-ctx-item-danger')
  })
})

// 원본(a2702ca4) 캡처 2026-11-10 image-2 실측 계약:
// 메뉴 구성은 데스크톱 열기/데이터 백업/암호화 키 교체/구분선/Google 연동/
// 배경/앱 관리/창 질감 전환 (유리/불투명)/데스크톱/구분선/로그아웃이며,
// 패널 폭 263px·행 간격은 패널 gap으로 균일하게 적용된다.
describe('설정 메뉴 — 원본 캡처(2026-11-10) 계약', () => {
  test('desktop.html은 nav.js보다 먼저 google-connect.js를 로드한다 (Google 연동이 페이지 항목 맨 앞)', () => {
    const gc = DESKTOP_HTML.indexOf('/js/google-connect.js')
    const nav = DESKTOP_HTML.indexOf('/nav.js')
    expect(gc).toBeGreaterThan(-1)
    expect(nav).toBeGreaterThan(-1)
    expect(gc).toBeLessThan(nav)
  })

  test('shell.css 설정 패널·서브메뉴 기하가 운영 원본과 같다', () => {
    // 2026-11-11: shell.css 운영 원본 바이트를 회수해 설치했다. 아래 값은
    // 원본 파일 자체의 값이다 (재구성 시절 캡처 실측 263/236은 근사였다).
    const panel = SHELL_CSS.match(/\.myhub-settings-panel \{([^}]*)\}/)
    expect(panel).not.toBeNull()
    const panelBody = (panel as RegExpMatchArray)[1]
    expect(panelBody).toContain('width: 264px')
    expect(panelBody).toContain('padding: 6px')
    const sub = SHELL_CSS.match(/\.myhub-settings-submenu \{([^}]*)\}/)
    expect(sub).not.toBeNull()
    expect((sub as RegExpMatchArray)[1]).toContain('width: 240px')
    // 원본 계약: 페이지 항목 컨테이너(#myhubSettingsPageItems)는 shell.css가
    // 스타일하지 않고 nav.js의 hidden 속성으로만 제어된다. 재구성본이 넣었던
    // display:contents 규칙은 원본에 없다 — 되돌아오면 이 테스트가 잡는다.
    expect(SHELL_CSS).not.toContain('#myhubSettingsPageItems')
    // 원본에만 있던 연결 패널 스타일도 함께 복원됐다.
    expect(SHELL_CSS).toContain('.myhub-connect-panel')
  })

  test('desktop.css에 죽은 설정 메뉴 블록이 없다 (settings-menu.js 전용 규칙 제거, 2026-11-12)', () => {
    // settings-menu.js는 2026-11-12에 삭제됐고, 그 전용이던 .myhub-settings-menu·
    // .myhub-settings-modal 규칙 19개도 desktop.css에서 함께 제거했다.
    // nav.js 설정 패널은 shell.css가 스타일하므로 desktop.css에는 이
    // 클래스들의 규칙이 남아 있으면 안 된다. 돌아오면 이 테스트가 잡는다.
    const stripped = DESKTOP_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(stripped).not.toContain('.myhub-settings-menu')
    expect(stripped).not.toContain('.myhub-settings-modal')
  })
})

describe('컨텍스트 메뉴 기하 — 운영 서빙본 복원 (2026-11-10 회수본 기준)', () => {
  // 기준은 prod-pull 전사본(다른 세대 파일)이 아니라 2026-11-10에
  // 운영에서 회수한 서빙본 desktop.css다. 재구성 값이 돌아오면 실패해야 한다.
  // C-L7 (5-8): svg·체크·보조 규칙은 공용 코어에 있으므로 페이지 로드
  // 합집합(desktop.css + ctx-menu.css)에서 찾는다.
  const rule = (sel: string) => {
    // 규칙은 행 첫머리에서 시작한다 — 후손 선택자(.a:hover .b)를 먼저 잡지 않게 앵커.
    const m = DESKTOP_CTX_CSS.match(new RegExp('(?:^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'))
    return (m as RegExpMatchArray | null)?.[1] ?? ''
  }

  test('컨테이너: min-width 200·max-height+스크롤·반경 12·반투명 배경', () => {
    const menu = rule('.dt-ctx-menu')
    expect(menu).toContain('min-width: 200px')
    expect(menu).toContain('max-height: min(74vh, 600px)')
    expect(menu).toContain('overflow-y: auto')
    expect(menu).toContain('border-radius: 12px')
    expect(menu).toContain('background: rgba(250, 250, 252, 0.82)')
  })

  test('항목 아이콘 svg는 14px, 체크 svg는 13px·슬롯 16px이다', () => {
    expect(rule('.dt-ctx-item svg')).toContain('width: 14px')
    expect(rule('.dt-ctx-check')).toContain('width: 16px')
    expect(rule('.dt-ctx-check svg')).toContain('width: 13px')
  })

  test('서브메뉴 화살표는 6px CSS 셰브론으로 그려진다 (0×0 소실 방지)', () => {
    const arrow = rule('.dt-ctx-arrow')
    expect(arrow).toContain('width: 6px')
    expect(arrow).toContain('height: 6px')
    expect(arrow).toContain('border-right: 1.5px solid #9ca3af')
    expect(arrow).toContain('rotate(-45deg)')
  })

  test('보조 텍스트·단축키는 원본 크기·색이다', () => {
    const sub = rule('.dt-ctx-sub')
    expect(sub).toContain('font-size: 11.5px')
    expect(sub).toContain('color: #6b7280')
    expect(sub).toContain('max-width: 190px')
    const sc = rule('.dt-ctx-shortcut')
    expect(sc).toContain('font-size: 12.5px')
    expect(sc).toContain('color: #9ca3af')
  })
})
