/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 빈 탭 포커스 요청 (2026-11-20 QA 결함: 새 탭 직후 키 입력이
 * 주소창에 안 들어감).
 *
 * 배경: 셸 + 버튼의 일회성 플래그 방식은 ① 연속 빈 탭이면 내비
 * 상태 서명이 같아 게시 자체가 안 되고 ② 메뉴 등 + 버튼이 아닌
 * 경로에는 플래그가 없어서 포커스가 안 됐다. 호스팅 모드에서는
 * iframe 주소창이 숨겨져 있어 newTab()의 urlInput.focus()도
 * 무용지물이었다. 수정: browser.js가 빈 탭이 될 때 셸에
 * myhub:browser-nav-focus를 명시적으로 요청한다 (상태 게시와 별개
 * 메시지라 서명 중복에 안 걸린다).
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - 호스팅 모드에서 newTab()은 셸에 포커스 요청을 보낸다.
 * - 연속 newTab()도 매번 포커스 요청을 보낸다 — 내비 게시가
 *   서명 중복으로 안 나가도 포커스 요청은 나간다.
 * - URL 탭에서 newTab()을 열면 내비 상태 게시가 포커스 요청보다
 *   먼저 나간다 (셸이 새 상태로 값을 비운 뒤 포커스해야 한다).
 * - 호스팅이 아니면 포커스 요청을 보내지 않고 iframe 주소창에
 *   직접 포커스한다 (단독 모드).
 * - 빈 탭으로 전환하면 포커스 요청을 보내고, URL 탭으로 전환하면
 *   보내지 않는다.
 * - 활성 탭을 닫아 빈 탭으로 넘어가면 포커스 요청을 보낸다
 *   (closeTab은 activateTab을 거치지 않아 같은 구멍이 있었다).
 *   비활성 탭을 닫으면 보내지 않고, 마지막 탭을 닫으면 새로
 *   생긴 빈 탭에 보낸다.
 *
 * 로딩 패턴은 tests/browser-tabs.test.ts와 동일하다 (실제
 * browser-live.js + browser.js, 스텁 아님). 단, 부모 창은
 * postMessage를 기록하는 가짜이며, adopt 메시지를 직접
 * 디스패치할 수 있게 addEventListener를 캡처한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const LIVE_JS = fs.readFileSync(path.join(ROOT, 'public/js/browser-live.js'), 'utf-8')
const BROWSER_JS = fs.readFileSync(path.join(ROOT, 'public/js/browser.js'), 'utf-8')

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

function loadBrowser(): any {
  const win = getWin()
  const doc = getDoc()
  doc.body.innerHTML = ''
  new Function('window', 'document', LIVE_JS)(win, doc)
  new Function('window', 'document', BROWSER_JS)(win, doc)
  return win.MyHubBrowser
}

function setupFixture(): void {
  const doc = getDoc()
  doc.body.innerHTML = `
    <div class="bw-toolbar" id="bwToolbar">
      <button type="button" id="bwBackBtn" aria-label="뒤로"></button>
      <button type="button" id="bwFwdBtn" aria-label="앞으로"></button>
      <button type="button" id="bwReloadBtn" aria-label="새로고침"></button>
      <input id="bwUrl" type="text" autocomplete="off" spellcheck="false" aria-label="주소 또는 검색어">
      <button type="button" id="bwNewTabBtn" aria-label="새 탭"></button>
      <button type="button" id="bwOverviewBtn" aria-label="탭 개요"></button>
      <button type="button" id="bwSidebarBtn" aria-label="사이드바"></button>
    </div>
    <div id="bwTabstrip"><div id="bwTabs"></div></div>
    <div class="bw-stage" id="bwStage">
      <div class="bw-home" id="bwHome">
        <div class="bw-bookmark-grid" id="bwBookmarkGrid"></div>
      </div>
      <iframe class="bw-frame" id="bwLiveFrame" title="원격 브라우저" hidden></iframe>
      <div class="bw-notice-card" id="bwNoticeCard" hidden>
        <p id="bwNoticeMsg"></p><button type="button" id="bwNoticeClose">닫기</button>
      </div>
    </div>
    <div class="bw-overview" id="bwOverview" hidden>
      <div class="bw-overview-head">
        <h2 class="bw-overview-title">열린 탭</h2>
        <input type="text" class="bw-overview-search" id="bwOverviewSearch" placeholder="탭 검색" autocomplete="off" spellcheck="false" aria-label="탭 검색">
        <button type="button" class="bw-icon-btn" id="bwOverviewClose" aria-label="탭 개요 닫기"></button>
      </div>
      <div class="bw-overview-grid" id="bwOverviewGrid"></div>
    </div>
    <div class="bw-sidebar" id="bwSidebar" hidden>
      <div id="bwSidebarTabs"></div>
      <button type="button" id="bwSidebarClose" aria-label="사이드바 닫기"></button>
    </div>
    <div class="bw-sidebar-backdrop" id="bwSidebarBackdrop" hidden></div>
  `
  const stage = doc.getElementById('bwStage')
  stage.getBoundingClientRect = () => ({ width: 1920, height: 1000, top: 0, left: 0, right: 1920, bottom: 1000, x: 0, y: 0, toJSON: () => ({}) })
  const liveFrame = doc.getElementById('bwLiveFrame')
  liveFrame.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) })
}

interface Harness {
  app: any
  postMessage: any
  dispatchMessage: (data: any) => void
  adopt: () => void
}

function makeApp(): Harness {
  const api = loadBrowser()
  setupFixture()
  const doc = getDoc()
  const postMessage = jest.fn()
  const listeners: Record<string, Array<(e: any) => void>> = {}
  const fakeWin: any = {
    parent: { postMessage },
    location: { origin: 'https://myhub.test' },
    addEventListener: (type: string, fn: (e: any) => void) => {
      if (!listeners[type]) listeners[type] = []
      listeners[type].push(fn)
    },
    fetch: () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, bookmarks: [], history: [] }),
      }),
  }
  const app = api.createApp({
    doc,
    win: fakeWin,
    storage: new MemoryStorage(),
    liveDeps: {
      navigate: () => Promise.resolve({ status: 200, body: { ok: true, nav: 'ok', navStage: 'ok' } }),
      applyViewport: () => Promise.resolve({ status: 200, body: { ok: true, stage: 'ok' } }),
      checkUnlock: () => Promise.resolve({ status: 0, body: null }),
      fetchState: () => Promise.resolve({ status: 200, body: { ok: true } }),
      history: () => Promise.resolve({ status: 200, body: { ok: true, stage: 'ok' } }),
      statePollMs: 2000,
    },
  })
  const dispatchMessage = (data: any) => {
    ;(listeners.message || []).forEach((fn) => fn({ data, source: fakeWin.parent }))
  }
  return {
    app,
    postMessage,
    dispatchMessage,
    adopt: () => dispatchMessage({ type: 'myhub:browser-nav-adopt' }),
  }
}

function callsOfType(h: Harness, type: string): any[] {
  return h.postMessage.mock.calls
    .map((c: any[]) => c[0])
    .filter((d: any) => d && d.type === type)
}

async function flush(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe('browser 빈 탭 포커스 요청', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(async () => {
    jest.useRealTimers()
  })

  test('호스팅 모드에서 newTab()은 셸에 포커스 요청을 보낸다', () => {
    const h = makeApp()
    h.adopt()
    expect(h.app.isToolbarHosted()).toBe(true)
    h.postMessage.mockClear()
    h.app.newTab()
    expect(callsOfType(h, 'myhub:browser-nav-focus')).toHaveLength(1)
    expect(h.postMessage).toHaveBeenCalledWith(
      { type: 'myhub:browser-nav-focus' },
      'https://myhub.test',
    )
  })

  test('연속 newTab()도 매번 포커스 요청을 보낸다 (내비 게시 중복과 무관)', () => {
    const h = makeApp()
    h.adopt()
    h.postMessage.mockClear()
    h.app.newTab()
    h.app.newTab()
    // 두 번째 빈 탭은 내비 상태 서명이 같아 게시가 안 나간다 — 그래도
    // 포커스 요청은 매번 나가야 한다 (결함의 핵심).
    expect(callsOfType(h, 'myhub:browser-nav')).toHaveLength(0)
    expect(callsOfType(h, 'myhub:browser-nav-focus')).toHaveLength(2)
  })

  test('URL 탭에서 newTab()을 열면 내비 게시가 포커스 요청보다 먼저 나간다', async () => {
    const h = makeApp()
    h.adopt()
    h.app.go('https://www.naver.com/')
    await flush()
    h.postMessage.mockClear()
    h.app.newTab()
    const calls = h.postMessage.mock.calls.map((c: any[]) => c[0].type)
    const navIdx = calls.indexOf('myhub:browser-nav')
    const focusIdx = calls.indexOf('myhub:browser-nav-focus')
    expect(navIdx).toBeGreaterThanOrEqual(0)
    expect(focusIdx).toBeGreaterThanOrEqual(0)
    expect(navIdx).toBeLessThan(focusIdx)
  })

  test('호스팅이 아니면 포커스 요청을 보내지 않고 iframe 주소창에 직접 포커스한다', () => {
    const h = makeApp()
    expect(h.app.isToolbarHosted()).toBe(false)
    h.postMessage.mockClear()
    h.app.newTab()
    expect(callsOfType(h, 'myhub:browser-nav-focus')).toHaveLength(0)
    const urlInput = getDoc().getElementById('bwUrl')
    expect(getDoc().activeElement).toBe(urlInput)
  })

  test('빈 탭으로 전환하면 포커스 요청을 보내고, URL 탭으로 전환하면 보내지 않는다', async () => {
    const h = makeApp()
    h.adopt()
    h.app.go('https://www.naver.com/')
    await flush()
    h.app.newTab()
    const tabs = h.app.getTabs()
    const urlTab = tabs.find((t: any) => t.url)
    const emptyTab = tabs.find((t: any) => !t.url)
    expect(urlTab).toBeDefined()
    expect(emptyTab).toBeDefined()
    h.postMessage.mockClear()
    h.app.activateTab(urlTab.id)
    expect(callsOfType(h, 'myhub:browser-nav-focus')).toHaveLength(0)
    h.app.activateTab(emptyTab.id)
    expect(callsOfType(h, 'myhub:browser-nav-focus')).toHaveLength(1)
  })

  test('활성 URL 탭을 닫아 빈 탭으로 넘어가면 포커스 요청을 보낸다', async () => {
    const h = makeApp()
    h.adopt()
    h.app.go('https://www.naver.com/')
    await flush()
    h.app.newTab()
    const tabs = h.app.getTabs()
    const urlTab = tabs.find((t: any) => t.url)
    const emptyTab = tabs.find((t: any) => !t.url)
    expect(urlTab).toBeDefined()
    expect(emptyTab).toBeDefined()
    h.app.activateTab(urlTab.id)
    expect(h.app.getTabs().find((t: any) => t.active).id).toBe(urlTab.id)
    h.postMessage.mockClear()
    h.app.closeTab(urlTab.id)
    expect(h.app.getTabs().find((t: any) => t.active).id).toBe(emptyTab.id)
    expect(callsOfType(h, 'myhub:browser-nav-focus')).toHaveLength(1)
  })

  test('비활성 탭을 닫으면 포커스 요청을 보내지 않는다', async () => {
    const h = makeApp()
    h.adopt()
    h.app.go('https://www.naver.com/')
    await flush()
    h.app.newTab()
    const tabs = h.app.getTabs()
    const urlTab = tabs.find((t: any) => t.url)
    const emptyTab = tabs.find((t: any) => !t.url)
    expect(h.app.getTabs().find((t: any) => t.active).id).toBe(emptyTab.id)
    h.postMessage.mockClear()
    h.app.closeTab(urlTab.id)
    expect(h.app.getTabs().find((t: any) => t.active).id).toBe(emptyTab.id)
    expect(callsOfType(h, 'myhub:browser-nav-focus')).toHaveLength(0)
  })

  test('마지막 탭을 닫으면 새로 생긴 빈 탭에 포커스 요청을 보낸다', async () => {
    const h = makeApp()
    h.adopt()
    h.app.go('https://www.naver.com/')
    await flush()
    const tabs = h.app.getTabs()
    expect(tabs).toHaveLength(1)
    h.postMessage.mockClear()
    h.app.closeTab(tabs[0].id)
    const next = h.app.getTabs()
    expect(next).toHaveLength(1)
    expect(next[0].url).toBeFalsy()
    expect(callsOfType(h, 'myhub:browser-nav-focus')).toHaveLength(1)
  })
})
