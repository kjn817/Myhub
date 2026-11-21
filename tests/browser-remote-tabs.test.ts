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
 *   URL이 같은 복원 탭에 즉시 다시 묶인다 (2026-11-20 5단계 — 옛
 *   동작은 연결만 끊고 다음 폴링에서 메인 타깃에 묶었다). URL이
 *   맞는 복원 탭이 없으면 옛 동작대로 연결만 끊고 다음 폴링에서
 *   다시 묶인다.
 * - 재시작 후 팝업 탭도 URL로 다시 묶여 지워지지 않고, 복원된 팝업이
 *   새 셸 탭으로 중복 생성되지 않는다 (2026-11-20 5단계).
 * - 재시작 후 URL이 없는 팝업 탭(진짜 닫힘)은 여전히 지워진다.
 * - 같은 URL의 셸 탭이 두 개면 복원 탭 하나에 하나만 묶이고
 *   나머지는 지워진다 (1:1 — 한 타깃에 두 탭이 안 묶인다).
 * - 재시작 후 원격이 새 탭뿐이면 모든 셸 탭이 지워지지 않고 연결만
 *   끊긴다 (2026-11-21 셸 주도 복원 — 옛 가드는 라이브 탭만 살리고
 *   나머지 탭을 전부 지워 저장된 탭이 날아갔다). 다음 폴링에서
 *   라이브 탭은 새 메인 타깃에 다시 묶인다.
 * - 재시작 감지 시 라이브 탭 URL로 한 번만 다시 이동한다 (플래그
 *   소비 — 두 번째 폴링에서는 이동하지 않는다).
 * - chrome:// 상태 URL이 http(s) 탭 URL을 덮지 않는다 (재이동 전
 *   폴링이 먼저 와도 라이브 탭 URL이 보존된다).
 * - 팝업 닫힘(활성 타깃 소유자 존재)에는 재시작 플래그가 안 서고
 *   재이동하지 않는다.
 * 카나리아: 동기화·중계·가드·재바인딩·재시작 플래그를 빼면 해당 테스트가 실패한다.
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
  navigateCalls: string[]
  navigateTargets: (string | null)[]
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
      const u = String(url)
      // 탭 제어(/api/browse/tab)만 tabPosts로 기록한다 — 북마크·기록
      // API는 탭 제어가 아니므로 (2026-11-20 브라우저 1단계로 추가됨)
      // 여기서 기록하면 'activate를 부르지 않는다' 단언이 오탐한다.
      if (u.startsWith('/api/browse/tab')) {
        const action = u.split('/').pop() ?? ''
        let targetId = ''
        try {
          targetId = JSON.parse(init?.body ?? '{}').targetId ?? ''
        } catch {
          targetId = ''
        }
        tabPosts.push({ action, targetId })
        return Promise.resolve({ ok: true })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, bookmarks: [], history: [] }),
      })
    },
  }
  const navigateCalls: string[] = []
  const navigateTargets: (string | null)[] = []
  const h: Harness = {
    app: null as any,
    remote: mainOnlyState(),
    setRemote(s: RemoteState) {
      h.remote = s
    },
    tabPosts,
    navigateCalls,
    navigateTargets,
  }
  const app = api.createApp({
    doc,
    win: fakeWin,
    storage: new MemoryStorage(),
    liveDeps: {
      navigate: (url: string, _viewport: unknown, targetId?: string) => {
        navigateCalls.push(url)
        navigateTargets.push(typeof targetId === 'string' && targetId ? targetId : null)
        return Promise.resolve({ status: 200, body: { ok: true, nav: 'ok', navStage: 'ok' } })
      },
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

  test('라이브인 메인 탭을 닫으면 뷰가 팝업 탭으로 옮겨간다 (꺼지지 않는다, 2026-11-21)', async () => {
    const h = makeApp()
    await startLive(h)
    h.setRemote(popupState())
    await poll(h)
    const tabs = h.app.getTabs()
    const main = tabs.find((t: any) => t.remoteTargetId === 'page-1')
    const popup = tabs.find((t: any) => t.remoteTargetId === 'page-2')
    // 메인 탭을 활성화한 뒤 닫는다 — 옛 코드는 라이브를 통째로 껐다
    h.app.activateTab(main.id)
    await flush()
    expect(h.app.getTabs().find((t: any) => t.id === main.id).live).toBe(true)
    h.tabPosts.length = 0
    h.app.closeTab(main.id)
    await flush()
    // 원격 close는 안 부른다 (메인 타깃은 영구 브라우저)
    expect(h.tabPosts.filter((p) => p.action === 'close')).toHaveLength(0)
    // 뷰는 팝업 탭으로 옮겨지고 라이브는 유지된다
    expect(h.tabPosts).toContainEqual({ action: 'activate', targetId: 'page-2' })
    const after = h.app.getTabs()
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(popup.id)
    expect(after[0].live).toBe(true)
    expect(h.app.live.isActive()).toBe(true)
    await h.app.live.endLive()
  })

  test('팝업이 라이브일 때 go()는 팝업 타깃 id를 navigate에 싣는다 (2026-11-21)', async () => {
    const h = makeApp()
    await startLive(h)
    h.setRemote(popupState())
    await poll(h)
    // 팝업이 라이브·활성 탭이다 (원격 활성이 page-2).
    const liveTab = h.app.getTabs().find((t: any) => t.live)
    expect(liveTab.remoteTargetId).toBe('page-2')
    h.navigateCalls.length = 0
    h.navigateTargets.length = 0
    h.app.go('https://example.com/')
    await flush()
    // 이동이 활성 탭이 아니라 조작 중인 팝업 탭으로 간다 — 옛 코드는
    // 타깃을 안 실어 서버가 활성 탭으로 갔고, 뉴스 팝업이 naver.com으로
    // 덮어씌워졌다 (CDP 내역 [news, naver.com]으로 확정).
    expect(h.navigateCalls).toEqual(['https://example.com/'])
    expect(h.navigateTargets).toEqual(['page-2'])
    await h.app.live.endLive()
  })

  test('라이브 탭을 닫을 때 이웃 탭이 없으면 뷰가 꺼진다', async () => {
    const h = makeApp()
    await startLive(h)
    const main = h.app.getTabs()[0]
    h.app.closeTab(main.id)
    await flush()
    expect(h.app.getTabs()).toHaveLength(1)
    expect(h.app.getTabs()[0].url).toBeNull()
    expect(h.app.live.isActive()).toBe(false)
  })

  test('재시작 후 라이브 탭은 URL이 같은 복원 탭에 즉시 다시 묶인다 (5단계)', async () => {
    const h = makeApp()
    await startLive(h)
    expect(h.app.getTabs()[0].remoteTargetId).toBe('page-1')
    // 크로뮴 재시작: 모든 타깃 id가 바뀌고 새 메인(page-9)만 남는다.
    // URL이 같으므로 첫 폴링에서 바로 다시 묶인다 (옛 동작은 첫 폴링에서
    // 연결만 끊고 null이 됐다가 다음 폴링에서 묶었다).
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
    expect(afterFirst[0].remoteTargetId).toBe('page-9')
    await poll(h)
    expect(h.app.getTabs()[0].remoteTargetId).toBe('page-9')
    await h.app.live.endLive()
  })

  test('재시작 후 URL이 안 맞는 라이브 탭은 연결만 끊고 다음 폴링에서 다시 묶인다', async () => {
    const h = makeApp()
    await startLive(h)
    expect(h.app.getTabs()[0].remoteTargetId).toBe('page-1')
    // 크로뮴 재시작: 복원된 탭이 다른 URL(example.com)이라 재바인딩 불가.
    const restarted: RemoteState = {
      url: 'https://example.com/',
      title: 'Example',
      canGoBack: false,
      canGoForward: false,
      tabs: [{ targetId: 'page-9', url: 'https://example.com/', title: 'Example', openerId: null }],
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

  test('재시작 후 팝업 탭이 URL로 다시 묶이고 중복 생성되지 않는다 (5단계)', async () => {
    const h = makeApp()
    await startLive(h)
    h.setRemote(popupState())
    await poll(h)
    const before = h.app.getTabs()
    expect(before).toHaveLength(2)
    const popupId = before.find((t: any) => t.remoteTargetId === 'page-2').id
    const mainId = before.find((t: any) => t.remoteTargetId === 'page-1').id
    // 크로뮴 재시작: 타깃 id가 전부 바뀌지만 URL은 그대로 복원된다.
    // 팝업은 openerId도 복원된 상태 (page-9가 새 메인).
    const restarted: RemoteState = {
      url: 'https://news.naver.com/article/123',
      title: '뉴스 기사',
      canGoBack: true,
      canGoForward: false,
      tabs: [
        { targetId: 'page-9', url: 'https://www.naver.com/', title: 'NAVER', openerId: null },
        { targetId: 'page-10', url: 'https://news.naver.com/article/123', title: '뉴스 기사', openerId: 'page-9' },
      ],
      activeTargetId: 'page-10',
      mainTargetId: 'page-9',
    }
    h.setRemote(restarted)
    await poll(h)
    const after = h.app.getTabs()
    // 기존 셸 탭 2개가 그대로 다시 묶인다 — 삭제도, 중복 생성도 없다.
    expect(after).toHaveLength(2)
    const popup = after.find((t: any) => t.id === popupId)
    const main = after.find((t: any) => t.id === mainId)
    expect(popup.remoteTargetId).toBe('page-10')
    expect(main.remoteTargetId).toBe('page-9')
    expect(popup.url).toBe('https://news.naver.com/article/123')
    expect(popup.active).toBe(true)
    expect(popup.live).toBe(true)
    await h.app.live.endLive()
  })

  test('재시작 후 URL이 없는 팝업 탭은 여전히 지워진다 (5단계)', async () => {
    const h = makeApp()
    await startLive(h)
    h.setRemote(popupState())
    await poll(h)
    expect(h.app.getTabs()).toHaveLength(2)
    // 크로뮴 재시작: 메인만 복원되고 팝업은 복원되지 않았다 (진짜 닫힘).
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
    const after = h.app.getTabs()
    expect(after).toHaveLength(1)
    expect(after[0].remoteTargetId).toBe('page-9')
    expect(after[0].active).toBe(true)
    expect(after[0].live).toBe(true)
    await h.app.live.endLive()
  })

  test('같은 URL의 셸 탭이 두 개면 복원 탭 하나에 하나만 묶인다 (5단계)', async () => {
    const h = makeApp()
    await startLive(h)
    // 같은 URL의 팝업이 떠서 셸 탭이 2개가 된다 (둘 다 naver URL).
    const dupPopup: RemoteState = {
      url: 'https://www.naver.com/',
      title: 'NAVER',
      canGoBack: false,
      canGoForward: false,
      tabs: [
        MAIN_TAB,
        { targetId: 'page-2', url: 'https://www.naver.com/', title: 'NAVER', openerId: 'page-1' },
      ],
      activeTargetId: 'page-2',
      mainTargetId: 'page-1',
    }
    h.setRemote(dupPopup)
    await poll(h)
    expect(h.app.getTabs()).toHaveLength(2)
    // 크로뮴 재시작: naver 탭 하나만 복원된다.
    h.setRemote({
      url: 'https://www.naver.com/',
      title: 'NAVER',
      canGoBack: false,
      canGoForward: false,
      tabs: [{ targetId: 'page-9', url: 'https://www.naver.com/', title: 'NAVER', openerId: null }],
      activeTargetId: 'page-9',
      mainTargetId: 'page-9',
    })
    await poll(h)
    const after = h.app.getTabs()
    // 복원 탭은 하나뿐이라 하나의 셸 탭만 남는다 (1:1 — 한 타깃에
    // 두 탭이 묶이지 않는다).
    expect(after).toHaveLength(1)
    expect(after[0].remoteTargetId).toBe('page-9')
    await h.app.live.endLive()
  })

  test('재시작 후 원격이 새 탭뿐이면 모든 셸 탭이 보존되고 라이브 탭 URL로 한 번만 이동한다', async () => {
    const h = makeApp()
    await startLive(h)
    h.setRemote(popupState())
    await poll(h)
    expect(h.app.getTabs()).toHaveLength(2)
    // 시작 내비게이션 기록을 비운다 — 재시작 재이동만 본다.
    h.navigateCalls.length = 0
    h.navigateTargets.length = 0
    // 크로뮴 재시작: 원격은 새 탭 하나뿐, 어떤 URL도 안 맞는다.
    // 네이티브 복원은 이 빌드에서 동작하지 않는다 (Session 미기록).
    const fresh: RemoteState = {
      url: 'chrome://newtab/',
      title: '',
      canGoBack: false,
      canGoForward: false,
      tabs: [{ targetId: 'page-9', url: 'chrome://newtab/', title: '', openerId: null }],
      activeTargetId: 'page-9',
      mainTargetId: 'page-9',
    }
    h.setRemote(fresh)
    await poll(h)
    // 두 탭 모두 지워지지 않고 연결만 끊긴다 (옛 가드는 라이브
    // 탭만 살리고 나머지를 지웠다 — 여기서 라이브 탭은 팝업이라
    // 메인 탭이 지워졌다).
    const afterFirst = h.app.getTabs()
    expect(afterFirst).toHaveLength(2)
    expect(afterFirst.every((t: any) => t.remoteTargetId === null)).toBe(true)
    expect(afterFirst.find((t: any) => t.live).url).toBe('https://news.naver.com/article/123')
    // 라이브 탭(팝업, 뉴스) URL로 한 번 이동한다. 재시작 직후라
    // 탭이 묶여 있지 않아 targetId는 null — 서버가 활성 탭으로 간다.
    expect(h.navigateCalls).toEqual(['https://news.naver.com/article/123'])
    expect(h.navigateTargets).toEqual([null])
    // 두 번째 폴링: 라이브 탭이 새 메인에 묶이고, chrome:// 상태가
    // http URL을 덮지 않으며, 재이동은 반복되지 않는다.
    await poll(h)
    const afterSecond = h.app.getTabs()
    expect(afterSecond).toHaveLength(2)
    const liveTab = afterSecond.find((t: any) => t.live)
    expect(liveTab.remoteTargetId).toBe('page-9')
    expect(liveTab.url).toBe('https://news.naver.com/article/123')
    expect(afterSecond.find((t: any) => !t.live).remoteTargetId).toBeNull()
    expect(h.navigateCalls).toHaveLength(1)
    await h.app.live.endLive()
  })

  test('팝업 닫힘에는 재시작 플래그가 안 서고 재이동하지 않는다', async () => {
    const h = makeApp()
    await startLive(h)
    h.setRemote(popupState())
    await poll(h)
    expect(h.app.getTabs()).toHaveLength(2)
    h.navigateCalls.length = 0
    h.setRemote(mainOnlyState())
    await poll(h)
    expect(h.app.getTabs()).toHaveLength(1)
    expect(h.navigateCalls).toHaveLength(0)
    await h.app.live.endLive()
  })
})
