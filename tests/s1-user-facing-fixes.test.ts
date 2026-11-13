/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 1단계 사용자 대면 수정 회귀 (2026-11-13 전수 감사 S1-1~S1-11).
 *
 * 검증하는 성질 (깨지면 실패해야 한다):
 * - 깨진 한국어 문구가 소스에 남아 있지 않고 새 문구가 그 자리에 있다
 *   (S1-1 백업 3건, S1-4 후보 선택 2곳, S1-5 구형 HWP 2곳,
 *   S1-6 브라우저 elsewhere, S1-7 서브챗).
 * - backup.html이 step-up.css를 link로 선언한다 — CSP enforce 아래에서는
 *   step-up.js의 인라인 <style> 주입이 차단되므로 link가 없으면 PIN 모달이
 *   무스타일로 뜬다 (S1-2). step-up.js는 같은 id의 요소가 있으면 주입을
 *   건너뛰므로 link 존재 자체가 스타일 경로를 결정한다.
 * - memo.css의 step-up 사본에 파란 확인 버튼 규칙이 있고, 그 값이 공용
 *   step-up.css와 같다 (S1-3). step-up.js=step-up.css 쌍은
 *   csp-inventory 테스트가 고정하므로 이 테스트는 메모 사본만 본다.
 * - JN 메뉴 '백업'을 누르면 백업 모듈 창이 실제로 열린다 — 설정 메뉴를
 *   경유하지 않는다 (S1-8). 구 코드는 설정 기어 버튼 클릭이라 백업 창이
 *   열리지 않고, 설정 버튼이 없는 셸에서는 항목 자체가 비활성화였다.
 * - 표기 통일: '데스크탑'·'Claude' 잔존 없음, memory.html 비문 교정 (S1-9).
 * - memo.css의 죽은 충돌 규칙이 제거됐다: .tag.on은 연한 배경 1개만
 *   남고(화면 변화 없음), #panes none !important는 사라지고 #pager는
 *   살아 있다 (S1-10·S1-11).
 *
 * 카나리아: 각 원본 문자열을 되돌리면 해당 단언이 실패한다 (수동 실증).
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

const BACKUP_JS = read('public/js/backup.js')
const BACKUP_HTML = read('public/backup.html')
const KEY_ROTATION_HTML = read('public/key-rotation.html')
const MEMO_CSS = read('public/css/memo.css')
const STEPUP_CSS = read('public/css/step-up.css')
const ASSISTANT_WIDGET_JS = read('public/assistant-widget.js')
const SUBCHAT_JS = read('public/js/desktop/subchat.js')
const HWP_JS = read('public/js/finder-format-hwp.js')
const VIEWER_JS = read('public/js/finder-viewer.js')
const BROWSER_JS = read('public/js/browser.js')
const FINDER_HTML = read('public/finder.html')
const KEY_ROTATION_JS = read('public/js/key-rotation.js')
const MEMORY_HTML = read('public/memory.html')
const WINDOWS_JS = read('public/js/desktop/windows.js')

describe('S1-1 — 백업 문구 재작성', () => {
  test('깨진 성공·오류 문구가 없고 새 문구가 있다', () => {
    expect(BACKUP_JS).not.toContain('백업이 완료됐! 습니다')
    expect(BACKUP_JS).not.toContain('PIN만들수없다')
    expect(BACKUP_JS).not.toContain('확인 하세요')
    expect(BACKUP_JS).not.toContain('비밀 번호는 특수문자')
    expect(BACKUP_JS).toContain(
      '백업이 완료됐습니다. 백업 파일은 비밀번호로 보호되니 안전한 곳에 보관하세요.'
    )
    expect(BACKUP_JS).toContain('백업하려면 먼저 PIN을 등록하세요.')
    expect(BACKUP_JS).toContain('백업 파일을 여는 비밀번호를 확인하세요.')
  })
})

describe('S1-2 — 백업 PIN 모달 스타일 link', () => {
  test('backup.html이 key-rotation과 같은 step-up.css link를 선언한다', () => {
    const link = '<link rel="stylesheet" id="step-up-style" href="/css/step-up.css">'
    expect(BACKUP_HTML).toContain(link)
    expect(KEY_ROTATION_HTML).toContain(link)
  })
})

describe('S1-3 — 메모 PIN 확인 버튼 파란색', () => {
  test('memo.css 사본에 파란 확인 버튼 규칙이 있고 공용 값과 같다', () => {
    const memoYes = MEMO_CSS.match(/\.myhub-stepup-btns\s+\.myhub-stepup-yes\s*\{([^}]*)\}/)
    expect(memoYes).not.toBeNull()
    expect(memoYes![1]).toContain('#007aff')
    // 공용 step-up.css의 같은 규칙과 배경값이 같아야 두 페이지의 버튼이 같다.
    const sharedYes = STEPUP_CSS.match(/\.myhub-stepup-btns\s+\.myhub-stepup-yes\{([^}]*)\}/)
    expect(sharedYes).not.toBeNull()
    const bg = (body: string) => body.match(/background:([^;]+)/)?.[1].trim()
    expect(bg(memoYes![1])).toBe(bg(sharedYes![1]))
  })
})

describe('S1-4·S1-5 — 깨진 문구 2곳씩 동시 재작성', () => {
  test('후보 선택 문구가 양쪽 파일에서 함께 바뀌었다', () => {
    for (const src of [ASSISTANT_WIDGET_JS, SUBCHAT_JS]) {
      expect(src).not.toContain('앱을 앱에서 발견했어요')
      expect(src).toContain('비슷한 항목이 여러 개 있어요. 선택해주세요:')
    }
  })

  test('구형 HWP 안내가 양쪽 파일에서 함께 바뀌었다', () => {
    for (const src of [HWP_JS, VIEWER_JS]) {
      expect(src).not.toContain('서명스튜디오')
      expect(src).toContain('구형 한글(hwp) 파일은 미리보기가 안 됩니다. 가져와서 한글 편집기로 여세요.')
    }
  })
})

describe('S1-6·S1-7 — 브라우저·서브챗 문구 교정', () => {
  test('elsewhere 안내는 탭에서 실행 중이에요', () => {
    expect(BROWSER_JS).not.toContain('중이예요')
    expect(BROWSER_JS).not.toContain('앱에서 실행 중')
    expect(BROWSER_JS).toContain('탭에서 실행 중이에요')
  })

  test('서브챗 동작 안내는 주어가 바로 잡혔다', () => {
    expect(SUBCHAT_JS).not.toContain('앱 동작은 해당 앱 창이 앞에 있을 때 실행해요')
    expect(SUBCHAT_JS).toContain('이 동작은 해당 앱 창이 앞에 있을 때 실행해요.')
  })
})

describe('S1-9 — 표기 통일', () => {
  test('데스크탑 잔존이 없고 데스크톱으로 통일됐다', () => {
    expect(FINDER_HTML).not.toContain('데스크탑')
    expect(FINDER_HTML).toContain('title="데스크톱"')
    expect(FINDER_HTML).toContain('<span>데스크톱</span>')
  })

  test('키 로테이션의 Claude 표기가 Muse로 바뀌었다', () => {
    expect(KEY_ROTATION_HTML).not.toContain('Claude')
    expect(KEY_ROTATION_JS).not.toContain('Claude')
    expect(KEY_ROTATION_HTML.match(/Muse에 알려주세요/g)?.length).toBe(2)
    expect(KEY_ROTATION_HTML).toContain('Muse와 함께')
    expect(KEY_ROTATION_JS.match(/Muse에 알려주세요/g)?.length).toBe(2)
  })

  test('memory.html 비문이 교정됐다', () => {
    expect(MEMORY_HTML).not.toContain('네 비서가 대화에 활용 허용')
    expect(MEMORY_HTML).toContain('내 비서가 대화에 활용하도록 허용')
  })
})

describe('S1-10·S1-11 — memo.css 죽은 충돌 규칙 제거', () => {
  test('.tag.on은 연한 배경 규칙 1개만 남았다 (화면 변화 없음)', () => {
    const rules = MEMO_CSS.match(/\.tag\.on\s*\{[^}]*\}/g) || []
    expect(rules.length).toBe(1)
    expect(rules[0]).toContain('var(--accent-soft)')
    expect(rules[0]).toContain('font-weight: 700')
  })

  test('#panes none !important는 사라지고 #pager는 살아 있다', () => {
    expect(MEMO_CSS).not.toContain('#panes { display: none !important; }')
    expect(MEMO_CSS).toContain('#pager { display: none !important; }')
  })
})

describe('S1-8 — JN 메뉴 백업이 백업 모듈을 연다', () => {
  test('소스상 백업 항목이 openModule(backup)을 부른다', () => {
    expect(WINDOWS_JS).toContain("openModule('backup')")
  })
})

// ---- jsdom 동작 테스트: JN 메뉴 → 백업 클릭 → 백업 창 열림 ----
// 로더 패턴은 tests/desktop-shell-restore.test.ts와 동일하다.

const NAV_JS = read('public/nav.js')
const STATE_JS = read('public/js/desktop/state.js')
const TILES_JS = read('public/js/desktop/tiles.js')
const MENU_JS = read('public/js/desktop/menu.js')
const MENUBAR_JS = read('public/js/desktop/menubar.js')
const DOCK_JS = read('public/js/desktop/dock.js')

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

function menuItem(label: string): any {
  const items = Array.from(getDoc().querySelectorAll('.dt-ctx-menu .dt-ctx-item'))
  return items.find((b: any) => b.querySelector('.dt-ctx-label')?.textContent === label)
}

describe('S1-8 — JN 메뉴 백업 클릭 동작 (jsdom)', () => {
  test('백업 항목은 비활성화가 아니고, 누르면 백업 창이 열린다', () => {
    const m = makeManager()
    click(getDoc().querySelector('.g-nav .brand-logo'))
    const backupItem = menuItem('백업')
    expect(backupItem).toBeTruthy()
    // 구 코드는 설정 버튼 유무에 disabled를 걸어 설정 버튼이 없는 셸에서는
    // 항목 자체가 비활성화였다. 백업 열기는 설정 버튼과 무관하다.
    expect(backupItem.disabled).toBe(false)
    expect(backupItem.className).not.toContain('is-disabled')

    click(backupItem)
    const wins = m.getState().windows
    expect(wins.some((w: any) => w.id === 'backup')).toBe(true)
    expect(m.getState().activeId).toBe('backup')
  })

  test('백업 클릭이 설정 메뉴를 열지 않는다 (설정 버튼이 있는 셸에서)', () => {
    const m = makeManager()
    // nav.js는 로드 시점에 .g-nav가 없어 설정 버튼을 마운트하지 못하므로
    // 실제 셸처럼 명시적으로 마운트한다. 구 코드는 이 버튼을 클릭해
    // 설정 메뉴를 열었으므로, 버튼이 있는 상태에서만 구별이 된다.
    getWin().MyHubNav.mountSettingsButton(getDoc())
    expect(getDoc().querySelector('.g-nav .settings-btn')).not.toBeNull()
    click(getDoc().querySelector('.g-nav .brand-logo'))
    click(menuItem('백업'))
    const settingsRoot = getDoc().getElementById('myhubSettingsMenu')
    expect(settingsRoot === null || settingsRoot.hidden === true).toBe(true)
    expect(m.getState().windows.some((w: any) => w.id === 'backup')).toBe(true)
  })
})
