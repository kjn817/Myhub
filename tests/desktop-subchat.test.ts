/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 서브챗 (상단바 우측 비서 아바타 패널) — 표시 계약 (2026-11-12)
 *
 * 배경: 아바타를 눌러도 패널이 뜨지 않았다. 원인은 CSS·JS 표시 계약
 * 불일치 — CSS는 기본 display:none + .is-open으로만 보이게 했는데,
 * JS(원본 전사 그대로)는 hidden 속성만 토글하고 is-open을 건드리지
 * 않아, hidden을 풀어도 display:none이 남아 있었다.
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - 아바타 클릭(또는 open()) 후 패널 hidden=false이고 인사말 1건이
 *   렌더된다. close() 후 hidden=true로 돌아간다.
 * - CSS 표시 계약은 이 코드베이스의 정본 패턴(미션·브라우저 탭과
 *   동일)이다: 기본 규칙 display:flex + [hidden]{display:none}.
 *   기본 규칙에 display:none이 있거나 .is-open 규칙이 돌아오면 실패한다.
 * - 패널 내부는 동작에 필요한 최소 배치를 가진다: 메시지 영역이
 *   flex:1로 늘어나 스크롤되고, 입력행이 flex 행으로 아래에 붙는다.
 *   (이 규칙들이 없으면 열려도 입력이 패널 밖으로 밀려 잘린다.)
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const SUBCHAT_JS = read('public/js/desktop/subchat.js')
const DESKTOP_CSS = read('public/css/desktop.css')

const getWin = (): any => (globalThis as any).window
const getDoc = (): any => (globalThis as any).document

function loadSubchat(): any {
  const win = getWin()
  const doc = getDoc()
  new Function('window', 'document', SUBCHAT_JS)(win, doc)
  return win.MyHubSubchat
}

function createManager(): { mgr: any; slot: any; panel: () => any } {
  const doc = getDoc()
  doc.body.innerHTML = ''
  const slot = doc.createElement('div')
  slot.id = 'dt-bar-assistant'
  doc.body.appendChild(slot)
  const api = loadSubchat()
  const mgr = api.create({
    doc,
    slotEl: slot,
    fetchFn: () => Promise.reject(new Error('no network in test')),
  })
  return { mgr, slot, panel: () => doc.querySelector('.myhub-subchat-panel') }
}

describe('서브챗 아바타 패널 표시', () => {
  test('아바타 클릭으로 패널이 열리고 인사말이 보인다', () => {
    const { mgr, slot, panel } = createManager()
    const btn = slot.querySelector('.myhub-subchat-avatar')
    expect(btn).not.toBeNull()
    expect(panel().hidden).toBe(true)
    btn.click()
    expect(mgr.isOpen()).toBe(true)
    expect(panel().hidden).toBe(false)
    expect(panel().querySelectorAll('.myhub-subchat-msg').length).toBe(1)
    btn.click()
    expect(mgr.isOpen()).toBe(false)
    expect(panel().hidden).toBe(true)
  })

  test('open()/close()가 hidden만으로 패널을 토글한다 (is-open 불필요)', () => {
    const { mgr, panel } = createManager()
    mgr.open()
    expect(panel().hidden).toBe(false)
    expect(panel().classList.contains('is-open')).toBe(false)
    mgr.close()
    expect(panel().hidden).toBe(true)
  })

  test('CSS 표시 계약: 기본 display:flex + [hidden]{display:none}, is-open 없음', () => {
    const base = DESKTOP_CSS.match(/\.myhub-subchat-panel \{([^}]*)\}/)
    expect(base).not.toBeNull()
    expect((base as RegExpMatchArray)[1]).toContain('display: flex')
    expect((base as RegExpMatchArray)[1]).not.toContain('display: none')
    const hiddenRule = DESKTOP_CSS.match(/\.myhub-subchat-panel\[hidden\] \{([^}]*)\}/)
    expect(hiddenRule).not.toBeNull()
    expect((hiddenRule as RegExpMatchArray)[1]).toContain('display: none')
    expect(DESKTOP_CSS).not.toContain('.myhub-subchat-panel.is-open')
    expect(SUBCHAT_JS).not.toContain('is-open')
  })

  test('패널 내부 배치: 메시지 영역 flex:1 스크롤 + 입력행 flex', () => {
    const msgs = DESKTOP_CSS.match(/\.myhub-subchat-msgs \{([^}]*)\}/)
    expect(msgs).not.toBeNull()
    expect((msgs as RegExpMatchArray)[1]).toContain('flex: 1')
    expect((msgs as RegExpMatchArray)[1]).toContain('overflow-y: auto')
    const inputRow = DESKTOP_CSS.match(/\.myhub-subchat-input-row \{([^}]*)\}/)
    expect(inputRow).not.toBeNull()
    expect((inputRow as RegExpMatchArray)[1]).toContain('display: flex')
    const panel = DESKTOP_CSS.match(/\.myhub-subchat-panel \{([^}]*)\}/)
    expect((panel as RegExpMatchArray)[1]).toContain('flex-direction: column')
  })
})
