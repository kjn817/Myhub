/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 브라우저 앱 재시작 복원 (2026-11-26 사용자 보고).
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - 앱을 열면 저장된 활성 탭으로 라이브가 바로 켜진다 — 웰컴페이지만
 *   뜨던 결함. 원격 타깃이 있으면 붙이고(다시 로드 안 함), 없으면
 *   저장된 URL로 이동한다.
 * - 라이브가 꺼져 있을 때 탭을 누르면 그 탭으로 라이브가 켜진다 —
 *   탭은 떠 있는데 눌러도 웰컴페이지만 남던 결함.
 * - 빈 탭만 저장돼 있으면 웰컴페이지를 유지한다 (라이브 안 켬).
 *
 * 카나리아: enterLiveForTab 호출·앱 열 때 자동 시작을 지우면
 * 1·2번이 실패한다 (isActive()가 false로 남는다).
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

function makeApp(store: MemoryStorage): any {
  const api = loadBrowser()
  setupFixture()
  const doc = getDoc()
  const fakeWin = {
    parent: { postMessage: () => {} },
    location: { origin: 'https://myhub.test' },
    addEventListener: () => {},
    fetch: () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, bookmarks: [], history: [] }),
      }),
  }
  return api.createApp({
    doc,
    win: fakeWin,
    storage: store,
    liveDeps: {
      navigate: () => Promise.resolve({ status: 200, body: { ok: true, nav: 'ok', navStage: 'ok' } }),
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
}

async function flush(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

const NAVER_ARTICLE = 'https://n.news.naver.com/article/001/0016463219?ntype=RANKING'

describe('브라우저 앱 재시작 복원', () => {
  test('앱을 열면 저장된 활성 탭으로 라이브가 바로 켜진다 (원격 타깃 있음)', async () => {
    const store = new MemoryStorage()
    seedTabs(
      store,
      [{ id: 'tab-1', url: NAVER_ARTICLE, remoteTargetId: 'page-1', title: '美정보당국 기사' }],
      'tab-1',
    )
    const app = makeApp(store)
    await flush()
    expect(app.live.isActive()).toBe(true)
    const liveTabs = app.getTabs().filter((t: any) => t.live)
    expect(liveTabs).toHaveLength(1)
    expect(liveTabs[0].id).toBe('tab-1')
  })

  test('원격 타깃이 없어도 저장된 URL로 라이브가 켜진다', async () => {
    const store = new MemoryStorage()
    seedTabs(store, [{ id: 'tab-1', url: NAVER_ARTICLE, remoteTargetId: null }], 'tab-1')
    const app = makeApp(store)
    await flush()
    expect(app.live.isActive()).toBe(true)
    expect(app.getTabs().filter((t: any) => t.live)[0].id).toBe('tab-1')
  })

  test('라이브가 꺼져 있을 때 탭을 누르면 그 탭으로 라이브가 켜진다', async () => {
    const store = new MemoryStorage()
    seedTabs(
      store,
      [
        { id: 'tab-1', url: 'https://www.naver.com/', remoteTargetId: 'page-1', title: 'NAVER' },
        { id: 'tab-2', url: NAVER_ARTICLE, remoteTargetId: 'page-2', title: '美정보당국 기사' },
      ],
      'tab-1',
    )
    const app = makeApp(store)
    await flush()
    expect(app.live.isActive()).toBe(true)
    app.live.endLive()
    await flush()
    expect(app.live.isActive()).toBe(false)
    app.activateTab('tab-2')
    await flush()
    expect(app.live.isActive()).toBe(true)
    expect(app.getTabs().filter((t: any) => t.live)[0].id).toBe('tab-2')
  })

  test('빈 탭만 저장돼 있으면 웰컴페이지를 유지한다 (라이브 안 켬)', async () => {
    const store = new MemoryStorage()
    seedTabs(store, [{ id: 'tab-1', url: null, remoteTargetId: null }], 'tab-1')
    const app = makeApp(store)
    await flush()
    expect(app.live.isActive()).toBe(false)
  })
})
