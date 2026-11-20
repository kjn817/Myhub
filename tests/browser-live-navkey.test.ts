/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 라이브 프레임 Ctrl+←/→/↑ → 셸 중계 (2026-11-20, 사용자 보고:
 * 브라우저 최대화 시 미션컨트롤 전환이 안 먹힘).
 *
 * 배경: 셸 단축키(windows.js onKeydown)는 셸 문서에만 걸려 있고,
 * 라이브 프레임(Selkies 화면, 별도 문서)에 포커스가 있으면 키가
 * 원격 크롬으로만 간다. 핀치 가드와 같은 자리에서 캡처 단계
 * keydown 리스너로 가로채 셸에 myhub:desktop-nav-key로 올려보낸다.
 * 무조건 전달한다 (사용자 선택 — 원격 텍스트 필드의 단어 이동
 * 손실 감수, 영상 스트림이라 조건부 전달 불가).
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - iframe load 후 Ctrl+←/→/↑는 window.parent로 중계되고,
 *   기본 동작이 막히며 하위(버블) 리스너에 닿지 않는다.
 * - Ctrl 없는 화살표·Ctrl+일반 키는 중계되지 않고 그대로 통과한다.
 * - load 전에는 중계가 없다 (배선 확인).
 * - load가 다시 와도 중계는 한 번만 나간다 (중복 등록이면
 *   데스크톱이 두 칸 움직인다).
 * - postMessage 실패가 예외로 번지지 않는다.
 * 카나리아: ctrlKey 분기·키 필터·postMessage·load 배선을 깨면
 * 해당 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const LIVE_JS = fs.readFileSync(path.join(ROOT, 'public/js/browser-live.js'), 'utf-8')

const getWin = (): any => (globalThis as any).window
const getDoc = (): any => (globalThis as any).document

function setupFixture(): void {
  const doc = getDoc()
  doc.body.innerHTML = `
    <div class="bw-stage" id="bwStage">
      <div class="bw-home" id="bwHome"></div>
      <iframe class="bw-frame" id="bwLiveFrame" title="원격 브라우저" hidden></iframe>
      <div class="bw-notice-card" id="bwNoticeCard" hidden>
        <p id="bwNoticeMsg"></p><button type="button" id="bwNoticeClose">닫기</button>
      </div>
      <div class="bw-lock-card" id="bwLockCard" hidden>
        <h2 class="bw-lock-title" id="bwLockTitle">브라우저가 잠겨 있어요</h2>
        <p class="bw-lock-desc" id="bwLockDesc"></p>
        <div class="bw-lock-form" id="bwLockForm">
          <input type="password" id="bwLockPassword" placeholder="보관함 암호">
          <input type="password" id="bwLockConfirm" placeholder="암호 다시 입력" hidden>
          <p class="bw-lock-msg" id="bwLockMsg" hidden></p>
          <button type="button" class="bw-lock-btn" id="bwLockSubmit">풀기</button>
          <button type="button" class="bw-lock-close" id="bwLockClose">닫기</button>
        </div>
      </div>
    </div>
  `
  const stage = doc.getElementById('bwStage')
  stage.getBoundingClientRect = () => ({ width: 1200, height: 700, top: 0, left: 0, right: 1200, bottom: 700, x: 0, y: 0, toJSON: () => ({}) })
}

function loadLive(): any {
  const win = getWin()
  new Function('window', 'document', LIVE_JS)(win, getDoc())
  return win.MyHubBrowserLive
}

function makeLive() {
  const api = loadLive()
  const live = api.createLive({
    doc: getDoc(),
    navigate: () => Promise.resolve({ status: 200, body: { ok: true, nav: 'ok', navStage: 'ok' } }),
    checkUnlock: () => Promise.resolve({ status: 200, body: { configured: true, unlocked: true } }),
    submitUnlock: () => Promise.resolve({ status: 200, body: { ok: true } }),
    setQuality: () => Promise.resolve({ status: 200, body: { ok: true, mode: 'auto', connections: 1 } }),
    pollDelayMs: 10,
    onChange: () => live.syncChrome(),
  })
  return { live }
}

function el(id: string): any {
  return getDoc().getElementById(id)
}

/** iframe 문서 body를 타깃으로 keydown 이벤트를 쏜다 (캡처→버블 전파 재현). */
function dispatchFrameKey(key: string, ctrlKey: boolean): { ev: any; downstream: number } {
  const frame = el('bwLiveFrame')
  const frameWin = frame.contentWindow
  const frameDoc = frame.contentDocument
  let downstream = 0
  // 프레임 안 페이지 자리: 버블 단계 리스너 (캡처 중계보다 나중에 돈다).
  frameWin.addEventListener('keydown', () => { downstream += 1 })
  const ev: any = new (getWin() as any).Event('keydown', { bubbles: true, cancelable: true })
  ev.key = key
  ev.ctrlKey = ctrlKey
  frameDoc.body.dispatchEvent(ev)
  return { ev, downstream }
}

describe('browser-live nav 키 중계', () => {
  const originalPostMessage = getWin().postMessage
  let postMessage: any

  beforeEach(() => {
    postMessage = jest.fn()
    getWin().postMessage = postMessage
  })

  afterEach(() => {
    getWin().postMessage = originalPostMessage
    jest.restoreAllMocks()
  })

  test('iframe load 후 Ctrl+←는 셸로 중계되고 하위 리스너에 닿지 않는다', () => {
    setupFixture()
    const { live } = makeLive()
    el('bwLiveFrame').dispatchEvent(new (getWin() as any).Event('load'))
    const { ev, downstream } = dispatchFrameKey('ArrowLeft', true)
    expect(ev.defaultPrevented).toBe(true)
    expect(downstream).toBe(0)
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'myhub:desktop-nav-key', key: 'ArrowLeft' },
      getWin().location.origin,
    )
    live.endLive()
  })

  test('Ctrl+→·Ctrl+↑도 같은 경로로 중계된다', () => {
    setupFixture()
    const { live } = makeLive()
    el('bwLiveFrame').dispatchEvent(new (getWin() as any).Event('load'))
    dispatchFrameKey('ArrowRight', true)
    dispatchFrameKey('ArrowUp', true)
    expect(postMessage).toHaveBeenCalledTimes(2)
    expect(postMessage).toHaveBeenNthCalledWith(1,
      { type: 'myhub:desktop-nav-key', key: 'ArrowRight' },
      getWin().location.origin,
    )
    expect(postMessage).toHaveBeenNthCalledWith(2,
      { type: 'myhub:desktop-nav-key', key: 'ArrowUp' },
      getWin().location.origin,
    )
    live.endLive()
  })

  test('Ctrl 없는 화살표는 중계되지 않고 하위 리스너가 받는다', () => {
    setupFixture()
    const { live } = makeLive()
    el('bwLiveFrame').dispatchEvent(new (getWin() as any).Event('load'))
    const { ev, downstream } = dispatchFrameKey('ArrowRight', false)
    expect(ev.defaultPrevented).toBe(false)
    expect(downstream).toBe(1)
    expect(postMessage).not.toHaveBeenCalled()
    live.endLive()
  })

  test('Ctrl+일반 키는 중계되지 않는다', () => {
    setupFixture()
    const { live } = makeLive()
    el('bwLiveFrame').dispatchEvent(new (getWin() as any).Event('load'))
    const { ev, downstream } = dispatchFrameKey('a', true)
    expect(ev.defaultPrevented).toBe(false)
    expect(downstream).toBe(1)
    expect(postMessage).not.toHaveBeenCalled()
    live.endLive()
  })

  test('load 전에는 중계가 없다 (배선 확인)', () => {
    setupFixture()
    const { live } = makeLive()
    // load를 쏘지 않으면 중계가 안 걸려 Ctrl+←이 그대로 통과한다.
    const { downstream } = dispatchFrameKey('ArrowLeft', true)
    expect(downstream).toBe(1)
    expect(postMessage).not.toHaveBeenCalled()
    live.endLive()
  })

  test('load가 다시 와도 중계는 한 번만 나간다', () => {
    setupFixture()
    const { live } = makeLive()
    const frame = el('bwLiveFrame')
    frame.dispatchEvent(new (getWin() as any).Event('load'))
    frame.dispatchEvent(new (getWin() as any).Event('load'))
    dispatchFrameKey('ArrowLeft', true)
    expect(postMessage).toHaveBeenCalledTimes(1)
    live.endLive()
  })

  test('postMessage가 실패해도 예외가 나지 않고 경고를 남긴다', () => {
    setupFixture()
    const { live } = makeLive()
    el('bwLiveFrame').dispatchEvent(new (getWin() as any).Event('load'))
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    postMessage.mockImplementation(() => { throw new Error('post fail') })
    expect(() => dispatchFrameKey('ArrowLeft', true)).not.toThrow()
    expect(warn).toHaveBeenCalled()
    live.endLive()
  })
})
