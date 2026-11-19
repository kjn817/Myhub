/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 새 창→새 탭 — browser.js 셸 탭 · 원격 타깃 연동 (2026-11-19).
 *
 * 배경: 키오스크 모드에서 window.open·target=_blank 팝업은 전체 화면
 * 창으로 떠서 셸이 몰랐고, 돌아오는 길은 주소창 이동뿐인데 그 이동이
 * 팝업을 닫아버렸다. 이제 사이드카 /control/state가 탭 목록을 주고,
 * 셸은 팝업을 새 탭으로 만들고 탭 전환·닫기를 원격에 중계한다.
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - 첫 상태 폴링에서 라이브 탭이 메인 타깃에 묶인다.
 * - openerId가 있는 원격 탭이 뜨면 셸 탭이 생기고 그 탭으로 전환되며
 *   뷰 소유권도 옮겨간다 (원격 화면이 이미 팝업이므로).
 * - openerId 없는 임시 탭(비서 읽기)은 셸 탭이 되지 않는다.
 * - tabs가 없는 폴백 상태는 탭을 건드리지 않는다.
 * - 원격 탭이 사라지면 셸 탭이 지워지고 활성 타깃 소유 탭으로 돌아간다.
 * - 셸 탭 전환은 원격 activate를 부르고 뷰 소유권을 옮긴다.
 * - 팝업 탭 닫기는 원격 close를 부르고 뷰를 메인 탭으로 옮긴다
 *   (라이브를 끄지 않는다). 메인 탭 닫기는 원격 close를 안 부른다.
 * - 라이브 탭의 원격 타깃이 사라지면(크로뮴 재시작) 탭은 안 지워지고
 *   연결만 끊긴 뒤 다음 폴링에서 새 메인 타깃에 다시 묶인다.
 * 카나리아: 동기화·중계·가드를 빼면 해당 테스트가 실패한다.
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

function stubRect(el: any, width: number, height: number): void {
  el.getBoundingClientRect = () => ({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
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
    </div>
    <div id="bwTabstrip"><div id="bwTabs"></div></div>
    <div class="bw-stage" id="bwStage">
      <div class="bw-home" id="bwHome"></div>
      <iframe class="bw-frame" id="bwLiveFrame" title="원격 브라우저" hidden></iframe>
      <div class="bw-notice-card" id="bwNoticeCard" hidden>
        <p id="bwNoticeMsg"></p><button type="button" id="bwNoticeClose">닫기</button>
      </div>
    </div>
  `
  stubRect(doc.getElementById('bwStage'), 1920, 1000)
  stubRect(doc.getElementById('bwLiveFrame'), 0, 0)
}

interface RemoteTab {
  targetId: string
  url: string
  title: string
  openerId: string | null
}

interface RemoteState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  tabs?: RemoteTab[]
  activeTargetId?: string | null
  mainTargetId?: string | null
}

const MAIN_TAB: RemoteTab = { targetId: 'page-1', url: 'https://www.naver.com/', title: 'NAVER', openerId: null }
const POPUP_TAB: RemoteTab = {
  targetId: 'page-2',
  url: 'https://news.naver.com/article/123',
  title: '뉴스 기사',
  openerId: 'page-1',
}
const TEMP_TAB: RemoteTab = {
  targetId: 'temp-1',
  url: 'https://example.com/',
  title: '임시',
  openerId: null,
}

function mainOnlyState(): RemoteState {
  return {
    url: 'https://www.naver.com/',
    title: 'NAVER',
    canGoBack: false,
    canGoForward: false,
    tabs: [MAIN_TAB],
    activeTargetId: 'page-1',
    mainTargetId: 'page-1',
  }
}

function popupState(): RemoteState {
  return {
    url: 'https://news.naver.com/article/123',
    title: '뉴스 기사',
    canGoBack: true,
    canGoForward: false,
    tabs: [MAIN_TAB, POPUP_TAB],
    activeTargetId: 'page-2',
    mainTargetId: 'page-1',
  }
}

interface TabPost {
  action: string
  targetId: string
}

interface Harness {
  app: any
  remote: RemoteState
  setRemote: (s: RemoteState) => void
  tabPosts: TabPost[]
}

function makeApp(): Harness {
  const api = loadBrowser()
  setupFixture()
  const doc = getDoc()
  const tabPosts: TabPost[] = []
  const fakeWin = {
    parent: { postMessage: () => {} },
    location: { origin: 'https://myhub.test' },
    addEventListener: () => {},
    fetch: (url: string, init?: { body?: string }) => {
      const action = String(url).split('/').pop() ?? ''
      let targetId = ''
      try {
        targetId = JSON.parse(init?.body ?? '{}').targetId ?? ''
      } catch {
        targetId = ''
      }
      tabPosts.push({ action, targetId })
      return Promise.resolve({ ok: true })
    },
  }
  const h: Harness = {
    app: null as any,
    remote: mainOnlyState(),
    setRemote(s: RemoteState) {
      h.remote = s
    },
    tabPosts,
  }
  const app = api.createApp({
    doc,
    win: fakeWin,
    storage: new MemoryStorage(),
    liveDeps: {
      navigate: () => Promise.resolve({ status: 200, body: { ok: true, nav: 'ok', navStage: 'ok' } }),
      applyViewport: () => Promise.resolve({ status: 200, body: { ok: true, stage: 'ok' } }),
      checkUnlock: () => Promise.resolve({ status: 0, body: null }),
      fetchState: () => Promise.resolve({ status: 200, body: { ok: true, ...h.remote } }),
      history: () => Promise.resolve({ status: 200, body: { ok: true, stage: 'ok' } }),
      statePollMs: 2000,
    },
  })
  h.app = app
  return h
}

async function flush(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

async function startLive(h: Harness): Promise<void> {
  h.app.go('https://www.naver.com/')
  await flush()
}

async function poll(h: Harness): Promise<void> {
  await h.app.live.refreshState()
  await flush()
}

describe('browser 새 창→새 탭 연동', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(async () => {
    jest.useRealTimers()
  })

  test('첫 폴링에서 라이브 탭이 메인 타깃에 묶인다', async () => {
    const h = makeApp()
    await startLive(h)
    const tabs = h.app.getTabs()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].remoteTargetId).toBe('page-1')
    await h.app.live.endLive()
  })

  test('팝업이 뜨면 셸 탭이 생기고 전환+뷰 소유권이 옮겨간다', async () => {
    const h = makeApp()
    await startLive(h)
    h.setRemote(popupState())
    await poll(h)
    const tabs = h.app.getTabs()
    expect(tabs).toHaveLength(2)
    const popup = tabs.find((t: any) => t.remoteTargetId === 'page-2')
    expect(popup).toBeDefined()
    expect(popup.url).toBe('https://news.naver.com/article/123')
    expect(popup.active).toBe(true)
    expect(popup.live).toBe(true)
    // 생성 자체는 원격 activate를 부르지 않는다 (원격 화면이 이미 팝업).
    expect(h.tabPosts).toHaveLength(0)
    await h.app.live.endLive()
  })

  test('openerId 없는 임시 탭은 셸 탭이 되지 않는다', async () => {
    const h = makeApp()
    await startLive(h)
    const s = mainOnlyState()
    s.tabs = [MAIN_TAB, TEMP_TAB]
    h.setRemote(s)
    await poll(h)
    expect(h.app.getTabs()).toHaveLength(1)
    await h.app.live.endLive()
  })

  test('tabs가 없는 폴백 상태는 탭을 건드리지 않는다', async () => {
    const h = makeApp()
    await startLive(h)
    h.setRemote(popupState())
    await poll(h)
    expect(h.app.getTabs()).toHaveLength(2)
    const { tabs: _t, activeTargetId: _a, mainTargetId: _m, ...fallback } = popupState()
    h.setRemote(fallback)
    await poll(h)
    expect(h.app.getTabs()).toHaveLength(2)
    await h.app.live.endLive()
  })

  test('팝업이 사라지면 셸 탭이 지워지고 메인 탭으로 돌아간다', async () => {
    const h = makeApp()
    await startLive(h)
    h.setRemote(popupState())
    await poll(h)
    expect(h.app.getTabs()).toHaveLength(2)
    h.setRemote(mainOnlyState())
    await poll(h)
    const tabs = h.app.getTabs()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].remoteTargetId).toBe('page-1')
    expect(tabs[0].active).toBe(true)
    expect(tabs[0].live).toBe(true)
    await h.app.live.endLive()
  })

  test('셸 탭 전환은 원격 activate를 부르고 뷰 소유권을 옮긴다', async () => {
    const h = makeApp()
    await startLive(h)
    h.setRemote(popupState())
    await poll(h)
    const tabs = h.app.getTabs()
    const main = tabs.find((t: any) => t.remoteTargetId === 'page-1')
    const popup = tabs.find((t: any) => t.remoteTargetId === 'page-2')
    h.tabPosts.length = 0
    h.app.activateTab(main.id)
    await flush()
    expect(h.tabPosts).toEqual([{ action: 'activate', targetId: 'page-1' }])
    expect(h.app.getTabs().find((t: any) => t.id === main.id).live).toBe(true)
    h.app.activateTab(popup.id)
    await flush()
    expect(h.tabPosts).toEqual([
      { action: 'activate', targetId: 'page-1' },
      { action: 'activate', targetId: 'page-2' },
    ])
    expect(h.app.getTabs().find((t: any) => t.id === popup.id).live).toBe(true)
    await h.app.live.endLive()
  })

  test('팝업 탭 닫기는 원격 close를 부르고 뷰를 메인 탭으로 옮긴다 (라이브 유지)', async () => {
    const h = makeApp()
    await startLive(h)
    h.setRemote(popupState())
    await poll(h)
    const popup = h.app.getTabs().find((t: any) => t.remoteTargetId === 'page-2')
    h.tabPosts.length = 0
    h.app.closeTab(popup.id)
    await flush()
    expect(h.tabPosts).toContainEqual({ action: 'close', targetId: 'page-2' })
    expect(h.tabPosts).toContainEqual({ action: 'activate', targetId: 'page-1' })
    const tabs = h.app.getTabs()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].remoteTargetId).toBe('page-1')
    expect(tabs[0].live).toBe(true)
    expect(h.app.live.isActive()).toBe(true)
    await h.app.live.endLive()
  })

  test('메인 탭 닫기는 원격 close를 부르지 않는다', async () => {
    const h = makeApp()
    await startLive(h)
    const main = h.app.getTabs()[0]
    h.tabPosts.length = 0
    h.app.closeTab(main.id)
    await flush()
    expect(h.tabPosts).toHaveLength(0)
    await h.app.live.endLive()
  })

  test('라이브 탭의 원격 타깃이 사라지면 탭은 유지되고 다음 폴링에서 다시 묶인다', async () => {
    const h = makeApp()
    await startLive(h)
    expect(h.app.getTabs()[0].remoteTargetId).toBe('page-1')
    // 크로뮴 재시작: 모든 타깃 id가 바뀌고 새 메인(page-9)만 남는다.
    const restarted: RemoteState = {
      url: 'https://www.naver.com/',
      title: 'NAVER',
      canGoBack: false,
      canGoForward: false,
      tabs: [{ targetId: 'page-9', url: 'https://www.naver.com/', title: 'NAVER', openerId: null }],
      activeTargetId: 'page-9',
      mainTargetId: 'page-9',
    }
    h.setRemote(restarted)
    await poll(h)
    const afterFirst = h.app.getTabs()
    expect(afterFirst).toHaveLength(1)
    expect(afterFirst[0].remoteTargetId).toBeNull()
    await poll(h)
    expect(h.app.getTabs()[0].remoteTargetId).toBe('page-9')
    await h.app.live.endLive()
  })
})
