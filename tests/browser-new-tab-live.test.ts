/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 브라우저 새 탭 실제 브라우저 동작 (2026-11-26 사용자 보고).
 *
 * 결함: 새 탭에서 "브라우저 시작"을 누르면 '원격 브라우저는 한 번에
 * 한 탭에서만 열려요' 모달이 뜨고 시작이 안 됐다. 셸 탭에 원격 타깃이
 * 없어, 주소 입력 시 이동이 서버 활성 탭(뉴스 탭)의 페이지를 덮는
 * 길도 열려 있었다.
 *
 * 정식 수정: 라이브 뷰 소유권은 사용자가 조작하는 탭을 따라간다.
 * 타깃이 없는 탭은 POST /api/browse/tab/new로 새 원격 탭을 만들어
 * 묶은 뒤 그 타깃으로 이동한다. 모달은 폐기됐다.
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - 새 탭에서 "브라우저 시작"을 누르면 라이브가 그 탭으로 옮겨지고
 *   새 원격 탭이 만들어져 묶인다 (구 코드는 소유권을 안 옮기고
 *   /tab/new를 부르지도 않는다).
 * - 타깃 없는 탭에서 주소 입력 시 이동이 새 원격 탭으로 간다 —
 *   뉴스 탭 URL은 그대로다 (구 코드는 targetId null로 보내 서버
 *   활성 탭을 덮는다).
 * - 새 탭을 열어도 "다른 탭에서 실행 중" 안내가 뜨지 않는다
 *   (구 코드는 syncChrome에서 elsewhere를 보여준다).
 * - 원격 탭 만들기 실패 시 이동하지 않는다 — 엉뚱한 탭을 덮느니
 *   멈춘다 (구 코드는 실패와 무관하게 null 타깃으로 이동한다).
 *
 * 카나리아: enterLiveHere의 소유권 이동·createRemoteTab 호출을
 * 지우면 1·2·4번이, syncChrome의 elsewhere 제거를 되돌리면 3번이
 * 실패한다 (수동 실증).
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const LIVE_JS = fs.readFileSync(path.join(ROOT, 'public/js/browser-live.js'), 'utf-8')
const BROWSER_JS = fs.readFileSync(path.join(ROOT, 'public/js/browser.js'), 'utf-8')
const TABS_KEY = 'myhub.browser.tabs.v1'

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
      <button type="button" id="bwNewTabBtn" aria-label="새 탭"></button>
      <button type="button" id="bwOverviewBtn" aria-label="탭 개요"></button>
      <button type="button" id="bwSidebarBtn" aria-label="사이드바"></button>
    </div>
    <div id="bwTabstrip"><div id="bwTabs"></div></div>
    <div class="bw-stage" id="bwStage">
      <div class="bw-home" id="bwHome">
        <button type="button" class="bw-start-btn">브라우저 시작</button>
        <div class="bw-bookmark-grid" id="bwBookmarkGrid"></div>
      </div>
      <div class="bw-elsewhere" id="bwElsewhere" hidden>
        <p class="bw-elsewhere-msg" id="bwElsewhereMsg"></p>
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
  stubRect(doc.getElementById('bwStage'), 1920, 1000)
  stubRect(doc.getElementById('bwLiveFrame'), 0, 0)
}

interface SeedTab {
  id: string
  url: string | null
  remoteTargetId: string | null
  title?: string | null
}

function seedTabs(store: MemoryStorage, tabs: SeedTab[], activeTabId: string): void {
  store.setItem(
    TABS_KEY,
    JSON.stringify({
      tabs: tabs.map((t) => ({
        id: t.id,
        url: t.url,
        history: t.url ? [t.url] : [],
        hIndex: t.url ? 0 : -1,
        remoteTargetId: t.remoteTargetId,
        title: t.title ?? null,
        pinned: false,
      })),
      activeTabId,
    }),
  )
}

interface Harness {
  app: any
  fetchCalls: Array<{ url: string }>
  navigateCalls: Array<{ url: string; targetId: string | null | undefined }>
}

function makeApp(store: MemoryStorage, opts: { failTabNew?: boolean } = {}): Harness {
  const api = loadBrowser()
  setupFixture()
  const doc = getDoc()
  const fetchCalls: Array<{ url: string }> = []
  const navigateCalls: Array<{ url: string; targetId: string | null | undefined }> = []
  const fakeWin = {
    parent: { postMessage: () => {} },
    location: { origin: 'https://myhub.test' },
    addEventListener: () => {},
    fetch: (url: string) => {
      fetchCalls.push({ url: String(url) })
      if (String(url).includes('/api/browse/tab/new')) {
        if (opts.failTabNew) return Promise.resolve({ ok: false, json: () => Promise.resolve({}) })
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, targetId: 'page-new-1' }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, bookmarks: [], history: [] }),
      })
    },
  }
  const app = api.createApp({
    doc,
    win: fakeWin,
    storage: store,
    liveDeps: {
      navigate: (url: string, _viewport: unknown, targetId: string | null | undefined) => {
        navigateCalls.push({ url, targetId })
        return Promise.resolve({ status: 200, body: { ok: true, nav: 'ok', navStage: 'ok' } })
      },
      applyViewport: () => Promise.resolve({ status: 200, body: { ok: true, stage: 'ok' } }),
      checkUnlock: () => Promise.resolve({ status: 0, body: null }),
      fetchState: () =>
        Promise.resolve({
          status: 200,
          body: { ok: true, url: 'https://www.naver.com/', title: 'NAVER', canGoBack: false, canGoForward: false },
        }),
      history: () => Promise.resolve({ status: 200, body: { ok: true, stage: 'ok' } }),
      statePollMs: 2000,
    },
  })
  return { app, fetchCalls, navigateCalls }
}

async function flush(n = 40): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

const NAVER_ARTICLE = 'https://n.news.naver.com/article/001/0016463219?ntype=RANKING'

describe('브라우저 새 탭 실제 브라우저 동작', () => {
  test('새 탭에서 "브라우저 시작"을 누르면 라이브가 그 탭으로 옮겨지고 새 원격 탭이 만들어진다', async () => {
    const store = new MemoryStorage()
    seedTabs(
      store,
      [{ id: 'tab-1', url: NAVER_ARTICLE, remoteTargetId: 'page-1', title: '뉴스' }],
      'tab-1',
    )
    const { app, fetchCalls } = makeApp(store)
    await flush()
    expect(app.live.isActive()).toBe(true)
    app.newTab()
    await flush()
    const newTab = app.getTabs().find((t: any) => t.active)
    expect(newTab.remoteTargetId).toBeNull()
    const startBtn = getDoc().querySelector('.bw-start-btn') as any
    startBtn.click()
    await flush()
    expect(fetchCalls.some((c) => c.url.includes('/api/browse/tab/new'))).toBe(true)
    const tabs = app.getTabs()
    const liveTab = tabs.find((t: any) => t.live)
    expect(liveTab.id).toBe(newTab.id)
    expect(liveTab.remoteTargetId).toBe('page-new-1')
    expect(app.live.isActive()).toBe(true)
  })

  test('타깃 없는 탭에서 주소 입력 시 이동이 새 원격 탭으로 간다 (뉴스 탭을 덮지 않는다)', async () => {
    const store = new MemoryStorage()
    seedTabs(
      store,
      [{ id: 'tab-1', url: NAVER_ARTICLE, remoteTargetId: 'page-1', title: '뉴스' }],
      'tab-1',
    )
    const { app, navigateCalls } = makeApp(store)
    await flush()
    app.newTab()
    await flush()
    app.go('https://example.com')
    await flush()
    expect(navigateCalls).toHaveLength(1)
    expect(navigateCalls[0].url).toBe('https://example.com')
    expect(navigateCalls[0].targetId).toBe('page-new-1')
    const tabs = app.getTabs()
    // 뉴스 탭의 묶임은 그대로 — 이동이 뉴스 탭으로 간 게 아니다.
    expect(tabs.find((t: any) => t.id === 'tab-1').remoteTargetId).toBe('page-1')
    expect(tabs.find((t: any) => t.active).url).toBe('https://example.com')
    expect(tabs.find((t: any) => t.active).remoteTargetId).toBe('page-new-1')
  })

  test('새 탭을 열어도 "다른 탭에서 실행 중" 안내가 뜨지 않는다', async () => {
    const store = new MemoryStorage()
    seedTabs(
      store,
      [{ id: 'tab-1', url: NAVER_ARTICLE, remoteTargetId: 'page-1', title: '뉴스' }],
      'tab-1',
    )
    const { app } = makeApp(store)
    await flush()
    app.newTab()
    await flush()
    const elsewhere = getDoc().getElementById('bwElsewhere') as any
    expect(elsewhere.hidden).toBe(true)
  })

  test('원격 탭 만들기 실패 시 이동하지 않는다 (엉뚱한 탭을 덮느니 멈춘다)', async () => {
    const store = new MemoryStorage()
    seedTabs(
      store,
      [{ id: 'tab-1', url: NAVER_ARTICLE, remoteTargetId: 'page-1', title: '뉴스' }],
      'tab-1',
    )
    const { app, navigateCalls } = makeApp(store, { failTabNew: true })
    await flush()
    app.newTab()
    await flush()
    app.go('https://example.com')
    await flush()
    expect(navigateCalls).toHaveLength(0)
    // 실패한 탭에는 타깃이 묶이지 않고, 뉴스 탭의 묶임도 그대로다.
    expect(app.getTabs().find((t: any) => t.active).remoteTargetId).toBeNull()
    expect(app.getTabs().find((t: any) => t.id === 'tab-1').remoteTargetId).toBe('page-1')
  })
})
