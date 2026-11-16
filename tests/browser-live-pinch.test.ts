/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 원격 브라우저 핀치 줌 차단 (2026-11-16, 네이버 90% 사고 재발 방지).
 *
 * 배경: 트랙패드 핀치는 브라우저에서 Ctrl+휠로 들어오고, Selkies
 * 클라이언트가 Ctrl 키 + 휠을 원격에 그대로 전달해 Chromium이 페이지
 * 줌을 바꾼다 (2026-11-16 08:47 네이버 줌 90% 저장됨). iframe이 동일
 * 출처(/api/browse/view/)라 contentWindow에 캡처 단계 wheel 리스너를
 * 걸어 Ctrl+휠만 막는다.
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - iframe load 후 contentWindow에 캡처 단계 wheel 가드가 걸린다.
 * - Ctrl+휠은 preventDefault + stopPropagation 되어 하위(버블)
 *   리스너 — Selkies 클라이언트 자리 — 에 닿지 않는다.
 * - 일반 휠(ctrlKey 없음)은 그대로 통과해 하위 리스너가 받는다.
 * - load가 다시 와도 가드는 유지되고 일반 휠은 계속 통과한다.
 * 카나리아: ctrlKey 분기·stopPropagation·load 배선을 깨면 해당
 * 테스트가 실패한다.
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

/** iframe 문서 body를 타깃으로 wheel 이벤트를 쏜다 (캡처→버블 전파 재현). */
function dispatchFrameWheel(ctrlKey: boolean): { ev: any; downstream: number } {
  const frame = el('bwLiveFrame')
  const frameWin = frame.contentWindow
  const frameDoc = frame.contentDocument
  let downstream = 0
  // Selkies 클라이언트 자리: 버블 단계 리스너 (캡처 가드보다 나중에 돈다).
  frameWin.addEventListener('wheel', () => { downstream += 1 }, { passive: true })
  const ev: any = new (getWin() as any).Event('wheel', { bubbles: true, cancelable: true })
  ev.ctrlKey = ctrlKey
  ev.deltaY = 100
  frameDoc.body.dispatchEvent(ev)
  return { ev, downstream }
}

describe('browser-live 핀치 줌 차단', () => {
  test('iframe load 후 Ctrl+휠은 하위 리스너에 닿지 않는다', () => {
    setupFixture()
    const { live } = makeLive()
    el('bwLiveFrame').dispatchEvent(new (getWin() as any).Event('load'))
    const { ev, downstream } = dispatchFrameWheel(true)
    expect(ev.defaultPrevented).toBe(true)
    expect(downstream).toBe(0)
    live.endLive()
  })

  test('일반 휠은 그대로 통과해 하위 리스너가 받는다', () => {
    setupFixture()
    const { live } = makeLive()
    el('bwLiveFrame').dispatchEvent(new (getWin() as any).Event('load'))
    const { ev, downstream } = dispatchFrameWheel(false)
    expect(ev.defaultPrevented).toBe(false)
    expect(downstream).toBe(1)
    live.endLive()
  })

  test('load가 다시 와도 가드는 유지되고 일반 휠은 통과한다', () => {
    setupFixture()
    const { live } = makeLive()
    const frame = el('bwLiveFrame')
    frame.dispatchEvent(new (getWin() as any).Event('load'))
    frame.dispatchEvent(new (getWin() as any).Event('load'))
    expect(dispatchFrameWheel(true).downstream).toBe(0)
    expect(dispatchFrameWheel(false).downstream).toBe(1)
    live.endLive()
  })

  test('load 전에는 가드가 없다 (배선 확인)', () => {
    setupFixture()
    const { live } = makeLive()
    // load를 쏘지 않으면 가드가 안 걸려 Ctrl+휠이 그대로 통과한다.
    const { downstream } = dispatchFrameWheel(true)
    expect(downstream).toBe(1)
    live.endLive()
  })
})
