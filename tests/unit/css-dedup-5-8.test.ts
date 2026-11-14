/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 5-8 CSS 중복 통합 회귀 (C-L1~C-L7)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - 중복 규칙이 하나로 줄었다 (주석 제거 후 규칙 개수 단언 — 되돌아오면 실패).
 * - 공용 코어 파일이 있고, 페이지 CSS에는 공용 규칙이 남아 있지 않다.
 * - 공용 CSS가 페이지 CSS보다 먼저 로드된다 (델타가 뒤에서 이기는 캐스케이드 전제).
 * - 페이지별 델타(의도된 차이)가 그대로 남아 있다.
 * - 선택자는 실제 DOM에 매칭되고 (문자열 존재만 확인하는 테스트 금지),
 *   계산 스타일이 맥락별 기대값과 같다 (공용+페이지 합집합 기준).
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..', '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

const CHAT_CSS = read('public/css/chat.css')
const MEMO_CSS = read('public/css/memo.css')
const DESKTOP_CSS = read('public/css/desktop.css')
const OFFICE_CSS = read('public/css/office.css')
const BACKUP_CSS = read('public/css/backup.css')
const KEY_ROTATION_CSS = read('public/css/key-rotation.css')
const SCHEDULE_CSS = read('public/css/schedule.css')
const TODO_CSS = read('public/css/todo.css')
const FORM_PANEL_CSS = read('public/css/common/form-panel.css')
const MODAL_CSS = read('public/css/common/modal.css')
const CTX_MENU_CSS = read('public/css/common/ctx-menu.css')

const CHAT_HTML = read('public/chat.html')
const SCHEDULE_HTML = read('public/schedule.html')
const TODO_HTML = read('public/todo.html')
const BACKUP_HTML = read('public/backup.html')
const KEY_ROTATION_HTML = read('public/key-rotation.html')
const DESKTOP_HTML = read('public/desktop.html')
const OFFICE_HTML = read('public/office.html')

const getDoc = (): any => (globalThis as any).document
const getWin = (): any => (globalThis as any).window

/** 주석을 제거한다 — C-L4 주석 안에 삭제된 규칙이 인용돼 있어 그대로 세면 2건이 된다. */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** 행 첫머리에서 시작하는 선택자 규칙의 개수를 센다 (미디어 쿼리 안 들여쓴 규칙은 제외). */
const countTopRule = (css: string, selector: string): number => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (stripComments(css).match(new RegExp('^' + esc + '\\s*\\{', 'gm')) || []).length
}

/** body 마크업을 jsdom 문서에 넣고 CSS를 <style>로 주입한다. */
function mount(bodyHtml: string, cssList: string[]): void {
  const doc = getDoc()
  doc.head.innerHTML = ''
  doc.body.innerHTML = bodyHtml
  for (const css of cssList) {
    const style = doc.createElement('style')
    style.textContent = css
    doc.head.appendChild(style)
  }
}

const bodyOf = (html: string): string => {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/)
  return m ? m[1] : html
}

const computed = (selector: string): any => {
  const el = getDoc().querySelector(selector)
  expect(el).not.toBeNull()
  return getWin().getComputedStyle(el)
}

describe('C-L1 — .input-bar 바이트 동일 블록', () => {
  test('chat.css에 .input-bar 규칙이 정확히 1개만 남고 선언이 온전하다', () => {
    expect(countTopRule(CHAT_CSS, '.input-bar')).toBe(1)
    // 행 첫머리 규칙만 본다 — 미디어 쿼리 안의 padding-bottom 오버라이드가 먼저 잡히면 안 된다
    const body = stripComments(CHAT_CSS).match(/^\.input-bar\s*\{([^}]*)\}/m)?.[1] ?? ''
    expect(body).toContain('position: sticky')
    expect(body).toContain('linear-gradient(to top, var(--bg) 60%, transparent)')
    expect(body).toContain('max-width: 800px')
  })

  test('실제 채팅 DOM의 .input-bar에 규칙이 매칭되고 sticky로 계산된다', () => {
    mount(bodyOf(CHAT_HTML), [CHAT_CSS])
    const cs = computed('.input-bar')
    expect(cs.position).toBe('sticky')
    expect(cs.maxWidth).toBe('800px')
  })
})

describe('C-L2 — .chat-layout 부분 중복', () => {
  test('chat.css에 최상위 .chat-layout 규칙이 1개만 남고 overflow까지 합쳐졌다', () => {
    expect(countTopRule(CHAT_CSS, '.chat-layout')).toBe(1)
    // 행 첫머리 규칙만 본다 — 미디어 쿼리 안의 transform 오버라이드가 먼저 잡히면 안 된다
    const body = stripComments(CHAT_CSS).match(/^\.chat-layout\s*\{([^}]*)\}/m)?.[1] ?? ''
    expect(body).toContain('flex: 1')
    expect(body).toContain('display: flex')
    expect(body).toContain('min-height: 0')
    expect(body).toContain('overflow: hidden')
  })

  test('실제 채팅 DOM의 .chat-layout이 flex + overflow hidden으로 계산된다', () => {
    mount(bodyOf(CHAT_HTML), [CHAT_CSS])
    const cs = computed('.chat-layout')
    expect(cs.display).toBe('flex')
    expect(cs.overflow).toBe('hidden')
    expect(cs.minHeight).toBe('0') // jsdom은 0을 '0'으로 반환한다 (브라우저는 '0px')
  })
})

describe('C-L3 — .file-chip .size 인접 중복', () => {
  test('memo.css에 .file-chip .size 규칙이 1개만 남고 flex-shrink: 0을 포함한다', () => {
    const matches = stripComments(MEMO_CSS).match(/\.file-chip \.size\s*\{[^}]*\}/g) || []
    expect(matches).toHaveLength(1)
    expect(matches[0]).toContain('flex-shrink: 0')
    expect(matches[0]).toContain('font-size: 12px')
  })

  test('파일 칩 크기 표시가 flex-shrink: 0으로 계산된다 (줄어들지 않음)', () => {
    mount('<div class="file-chip"><span class="name">a.hwp</span><span class="size">12KB</span></div>', [MEMO_CSS])
    const cs = computed('.file-chip .size')
    expect(cs.flexShrink).toBe('0')
    expect(cs.fontSize).toBe('12px')
  })
})

describe('C-L4 — .dt-dock-item position 재선언', () => {
  test('desktop.css에 .dt-dock-item 본 규칙이 1개만 남고 position: relative를 포함한다', () => {
    expect(countTopRule(DESKTOP_CSS, '.dt-dock-item')).toBe(1)
    const body = stripComments(DESKTOP_CSS).match(/\.dt-dock-item\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(body).toContain('position: relative')
  })

  test('독 항목이 position: relative로 계산된다 (툴팁·배지 앵커 전제)', () => {
    mount('<button class="dt-dock-item"><span class="dt-dock-tile"></span></button>', [DESKTOP_CSS])
    expect(computed('.dt-dock-item').position).toBe('relative')
  })
})

describe('C-L5 — backup ≒ key-rotation 공용화', () => {
  test('form-panel 공용 코어에 공유 규칙이 있다', () => {
    for (const sel of [
      '.wrap', '.card', '.card h2', '.desc', '.field', '.field label',
      '.field input', '.field input:focus', '.btn', '.btn:disabled',
      '.btn.secondary', '.error.show', '.success.show', '.info', '.info ul',
    ]) {
      expect(stripComments(FORM_PANEL_CSS)).toContain(sel + ' {')
    }
  })

  test('두 페이지 CSS에 공용 규칙이 남아 있지 않다 (중복 회귀 가드)', () => {
    for (const css of [BACKUP_CSS, KEY_ROTATION_CSS]) {
      const stripped = stripComments(css)
      expect(stripped).not.toContain('.card {')
      expect(stripped).not.toContain('.btn {')
      expect(stripped).not.toContain('.wrap {')
      expect(stripped).not.toContain('.info {')
    }
  })

  test('두 페이지가 공용 CSS를 페이지 CSS보다 먼저 로드한다', () => {
    for (const html of [BACKUP_HTML, KEY_ROTATION_HTML]) {
      const common = html.indexOf('/css/common/form-panel.css')
      expect(common).toBeGreaterThan(-1)
      const page = Math.max(html.indexOf('/css/backup.css'), html.indexOf('/css/key-rotation.css'))
      expect(page).toBeGreaterThan(common)
    }
  })

  test('페이지별 델타가 보존된다', () => {
    // backup 전용 .loading + line-height 없는 .error/.success
    expect(BACKUP_CSS).toContain('.loading {')
    expect(BACKUP_CSS).toContain('.loading.show {')
    expect(BACKUP_CSS).not.toContain('line-height: 1.6')
    // key-rotation 전용 .warn·table.census·.info ol + line-height 1.6
    expect(KEY_ROTATION_CSS).toContain('.warn {')
    expect(KEY_ROTATION_CSS).toContain('.warn.show {')
    expect(KEY_ROTATION_CSS).toContain('table.census {')
    expect(KEY_ROTATION_CSS).toContain('.info ol {')
    const err = stripComments(KEY_ROTATION_CSS).match(/\.error\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(err).toContain('line-height: 1.6')
  })

  test('실제 백업 DOM의 .card·.btn에 공용 규칙이 매칭된다', () => {
    mount(bodyOf(BACKUP_HTML), [FORM_PANEL_CSS, BACKUP_CSS])
    expect(computed('.card').borderRadius).toBe('12px')
    expect(computed('.btn').backgroundColor).toBe('rgb(0, 122, 255)')
  })

  test('실제 키 로테이션 DOM의 .warn·table.census에 델타 규칙이 매칭된다', () => {
    mount(bodyOf(KEY_ROTATION_HTML), [FORM_PANEL_CSS, KEY_ROTATION_CSS])
    expect(computed('.warn').display).toBe('none')
    expect(computed('.card').borderRadius).toBe('12px')
  })
})

describe('C-L6 — schedule ≒ todo 모달 시스템 공용화', () => {
  test('modal 공용 코어에 모달 규칙이 있다', () => {
    for (const sel of [
      '.modal-back', '.modal-back.open', '.modal', '@keyframes pop', '.modal h3',
      '.fld', '.fld label', '.fld-row', '.modal-acts', '.m-btn',
      '.m-btn.ghost', '.m-btn.solid',
    ]) {
      expect(stripComments(MODAL_CSS)).toContain(sel)
    }
    expect(MODAL_CSS).toContain('@media (max-width: 640px)')
  })

  test('두 페이지 CSS에 모달 본 규칙이 남아 있지 않다 (중복 회귀 가드)', () => {
    for (const css of [SCHEDULE_CSS, TODO_CSS]) {
      const stripped = stripComments(css)
      expect(stripped).not.toContain('.modal-back {')
      expect(stripped).not.toContain('.modal-back.open {')
      expect(stripped).not.toContain('.m-btn {')
      // .fld는 행 첫머리 규칙으로만 본다 — schedule 델타 '.fld-row .fld {'
      // 안에 '.fld {' 부분 문자열이 들어 있어 toContain으로는 구분이 안 된다
      expect(stripped).not.toMatch(/^\s*\.fld\s*\{/m)
      expect(stripped).not.toContain('@keyframes pop')
    }
  })

  test('두 페이지가 공용 CSS를 페이지 CSS보다 먼저 로드한다', () => {
    for (const html of [SCHEDULE_HTML, TODO_HTML]) {
      const common = html.indexOf('/css/common/modal.css')
      expect(common).toBeGreaterThan(-1)
      const page = Math.max(html.indexOf('/css/schedule.css'), html.indexOf('/css/todo.css'))
      expect(page).toBeGreaterThan(common)
    }
  })

  test('일정 전용 델타가 schedule.css에 보존된다', () => {
    expect(SCHEDULE_CSS).toContain('.modal { overflow-x: hidden; }')
    expect(SCHEDULE_CSS).toContain('.fld-row .fld { min-width: 0; }')
    expect(SCHEDULE_CSS).toContain('.modal-acts { align-items: center; }')
    expect(SCHEDULE_CSS).toContain('.modal-acts .grow { flex: 1; }')
    expect(SCHEDULE_CSS).toContain('.m-btn.text-danger {')
    expect(SCHEDULE_CSS).toContain('.modal { max-height: 85dvh; }')
    // todo에는 이 델타가 없다
    expect(TODO_CSS).not.toContain('overflow-x: hidden')
    expect(TODO_CSS).not.toContain('.m-btn.text-danger')
  })

  test('실제 일정 DOM의 모달이 공용+델타 값으로 계산된다', () => {
    mount(bodyOf(SCHEDULE_HTML), [MODAL_CSS, SCHEDULE_CSS])
    const modal = computed('.modal')
    expect(modal.maxWidth).toBe('440px')
    expect(modal.borderRadius).toBe('12px')
    expect(modal.overflowX).toBe('hidden') // 일정 델타
    expect(modal.overflowY).toBe('auto')
  })

  test('실제 할 일 DOM의 모달은 공용 값만으로 계산된다 (overflow-x 델타 없음)', () => {
    mount(bodyOf(TODO_HTML), [MODAL_CSS, TODO_CSS])
    const modal = computed('.modal')
    expect(modal.maxWidth).toBe('440px')
    expect(modal.borderRadius).toBe('12px')
    // jsdom은 미지정 overflow-x를 ''로 반환한다 — 지키는 성질은 'hidden 델타가 없음'이다
    expect(modal.overflowX).not.toBe('hidden')
    expect(modal.overflowY).toBe('auto')
  })

  test('모달 배경은 .open일 때만 flex로 보인다', () => {
    mount(bodyOf(SCHEDULE_HTML), [MODAL_CSS, SCHEDULE_CSS])
    expect(computed('.modal-back').display).toBe('none')
    getDoc().querySelector('.modal-back').classList.add('open')
    expect(computed('.modal-back').display).toBe('flex')
  })
})

describe('C-L7 — .dt-ctx-* 이중 정의 공용화', () => {
  const SHARED = [
    '.dt-ctx-item:hover', '.dt-ctx-item.is-danger', '.dt-ctx-item.is-danger:hover',
    '.dt-ctx-item svg', '.dt-ctx-item.is-active', '.dt-ctx-item.is-danger.is-active',
    '.dt-ctx-item.is-disabled', '.dt-ctx-check', '.dt-ctx-check svg',
    '.dt-ctx-label', '.dt-ctx-sub', '.dt-ctx-item .dt-ctx-arrow',
    '.dt-ctx-item.is-active .dt-ctx-arrow',
  ]

  test('ctx-menu 공용 코어에 공유 규칙 17개가 있다', () => {
    const stripped = stripComments(CTX_MENU_CSS)
    for (const sel of SHARED) expect(stripped).toContain(sel)
    expect(stripped).toContain('.dt-ctx-item.is-disabled:hover, .dt-ctx-item.is-disabled.is-active')
    expect(stripped).toContain('.dt-ctx-item:hover .dt-ctx-sub, .dt-ctx-item.is-active .dt-ctx-sub')
    expect(stripped).toContain('.dt-ctx-item.is-disabled .dt-ctx-sub')
    expect(stripped).toContain('.dt-ctx-item:hover .dt-ctx-shortcut, .dt-ctx-item.is-active .dt-ctx-shortcut')
    // hover·danger 색은 원본 값이다
    expect(stripped).toContain('background: #0a84ff')
    expect(stripped).toContain('background: #dc2626')
  })

  test('두 페이지 CSS에 공유 규칙이 남아 있지 않다 (중복 회귀 가드)', () => {
    for (const css of [DESKTOP_CSS, OFFICE_CSS]) {
      const stripped = stripComments(css)
      // 행 첫머리 규칙으로만 본다 — desktop.css의 :not(:disabled) 복원 블록에
      // '.dt-ctx-item.is-active .dt-ctx-check {' 같은 후손 선택자가 있어
      // toContain으로는 공용 슬롯 규칙과 구분이 안 된다
      for (const sel of ['.dt-ctx-item:hover', '.dt-ctx-check', '.dt-ctx-label', '.dt-ctx-item svg']) {
        const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        expect(stripped).not.toMatch(new RegExp('^' + esc + '\\s*\\{', 'm'))
      }
    }
  })

  test('두 페이지가 공용 CSS를 페이지 CSS보다 먼저 로드한다', () => {
    for (const html of [DESKTOP_HTML, OFFICE_HTML]) {
      const common = html.indexOf('/css/common/ctx-menu.css')
      expect(common).toBeGreaterThan(-1)
      const page = Math.max(html.indexOf('/css/desktop.css'), html.indexOf('/css/office.css'))
      expect(page).toBeGreaterThan(common)
    }
  })

  test('맥락별 의도된 차이가 각 페이지에 핀으로 남아 있다', () => {
    const desktopMenu = stripComments(DESKTOP_CSS).match(/\.dt-ctx-menu\s*\{([^}]*)\}/)?.[1] ?? ''
    const officeMenu = stripComments(OFFICE_CSS).match(/\.dt-ctx-menu\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(desktopMenu).toContain('min-width: 200px')
    expect(desktopMenu).toContain('padding: 6px')
    expect(desktopMenu).toContain('border-radius: 12px')
    expect(officeMenu).toContain('min-width: 180px')
    expect(officeMenu).toContain('padding: 5px')
    expect(officeMenu).toContain('border-radius: 10px')
    const desktopItem = stripComments(DESKTOP_CSS).match(/\.dt-ctx-item\s*\{([^}]*)\}/)?.[1] ?? ''
    const officeItem = stripComments(OFFICE_CSS).match(/\.dt-ctx-item\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(desktopItem).toContain('padding: 7px 10px')
    expect(desktopItem).toContain('font-size: 13.5px')
    expect(officeItem).toContain('padding: 6px 9px')
    expect(officeItem).toContain('font-size: 13px')
    expect(DESKTOP_CSS).toContain('.dt-ctx-shortcut { flex: none; font-size: 12.5px; color: #9ca3af; letter-spacing: .02em; }')
    expect(OFFICE_CSS).toContain('.dt-ctx-shortcut { flex: none; font-size: 12px; color: #9ca3af; }')
    expect(DESKTOP_CSS).toContain('.dt-ctx-heading { padding: 7px 10px 3px;')
    expect(OFFICE_CSS).toContain('.dt-ctx-heading { padding: 7px 9px 3px;')
    expect(DESKTOP_CSS).toContain('.dt-ctx-sep { height: 1px; margin: 6px 10px;')
    expect(OFFICE_CSS).toContain('.dt-ctx-sep { height: 1px; margin: 5px 8px;')
  })

  const MENU_MARKUP =
    '<div class="dt-ctx-menu"><button class="dt-ctx-item"><span class="dt-ctx-check"></span>' +
    '<span class="dt-ctx-label">열기</span><span class="dt-ctx-sub">보조</span>' +
    '<span class="dt-ctx-shortcut">⌘K</span><span class="dt-ctx-arrow"></span></button></div>'

  test('데스크톱 맥락: 공용 규칙 + 데스크톱 값이 계산된다', () => {
    mount(MENU_MARKUP, [CTX_MENU_CSS, DESKTOP_CSS])
    expect(computed('.dt-ctx-menu').minWidth).toBe('200px')
    expect(computed('.dt-ctx-menu').padding).toBe('6px')
    expect(computed('.dt-ctx-menu').borderRadius).toBe('12px')
    expect(computed('.dt-ctx-item').paddingTop).toBe('7px')
    expect(computed('.dt-ctx-item').fontSize).toBe('13.5px')
    expect(computed('.dt-ctx-check').width).toBe('16px')
    expect(computed('.dt-ctx-sub').fontSize).toBe('11.5px')
    expect(computed('.dt-ctx-shortcut').fontSize).toBe('12.5px')
  })

  test('오피스 맥락: 공용 규칙은 같고 컨테이너·항목 값만 조밀하다', () => {
    mount(MENU_MARKUP, [CTX_MENU_CSS, OFFICE_CSS])
    expect(computed('.dt-ctx-menu').minWidth).toBe('180px')
    expect(computed('.dt-ctx-menu').padding).toBe('5px')
    expect(computed('.dt-ctx-menu').borderRadius).toBe('10px')
    expect(computed('.dt-ctx-item').paddingTop).toBe('6px')
    expect(computed('.dt-ctx-item').fontSize).toBe('13px')
    // 공용 규칙은 맥락과 무관하게 동일하다
    expect(computed('.dt-ctx-check').width).toBe('16px')
    expect(computed('.dt-ctx-sub').fontSize).toBe('11.5px')
    expect(computed('.dt-ctx-shortcut').fontSize).toBe('12px')
  })
})

describe('공용 CSS 에셋 등록', () => {
  test('신규 공용 파일 3개가 static-assets.json files에 있다', () => {
    const manifest = JSON.parse(read('scripts/static-assets.json')) as { files: string[] }
    expect(manifest.files).toContain('/css/common/form-panel.css')
    expect(manifest.files).toContain('/css/common/modal.css')
    expect(manifest.files).toContain('/css/common/ctx-menu.css')
  })
})
