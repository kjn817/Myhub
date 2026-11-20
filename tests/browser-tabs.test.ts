/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 브라우저 탭 관리 (2026-11-20, 브라우저 3단계).
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - 탭을 드래그하면 순서가 바뀌고 localStorage에도 같은 순서로 저장된다.
 * - 드래그 직후 클릭은 억제되고(탭 전환 안 됨), 그 다음 클릭부터 전환된다.
 * - 닫기 버튼을 누르면 드래그가 시작되지 않고, 클릭하면 탭이 닫힌다
 *   (포인터 캡처가 click을 탭 버튼으로 재겨냥해 닫기가 안 되던 결함).
 * - 고정하면 탭이 파비콘만 작게 맨 앞에 모이고 닫기 버튼이 없으며,
 *   localStorage를 거쳐 다시 열어도 고정이 유지된다.
 * - 고정 탭이 있으면 고정되지 않은 탭은 그 앞으로 못 간다 (구역 클램프).
 * - 복제하면 같은 URL·기록의 탭이 바로 옆에 생기고 활성화된다.
 * - 개요 검색은 제목·URL로 필터링하고, 결과가 없으면 빈 상태를 보여준다.
 * - 원격 state의 title이 탭 줄·사이드바·개요에 표시되고, 없으면 호스트로 폴백한다.
 * - 새 탭을 열면 주소창이 비워진 채 포커스된다 (이전 URL이 남지 않는다).
 * - 탭·사이드바 파비콘은 /api/browse/favicon을 쓰고, 로딩 실패 시
 *   첫 글자 타일로 폴백한다.
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
  stubRectAt(el, 0, width, height)
}

function stubRectAt(el: any, left: number, width: number, height: number): void {
  el.getBoundingClientRect = () => ({
    width,
    height,
    top: 0,
    left,
    right: left + width,
    bottom: height,
    x: left,
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

interface Harness {
  app: any
  storage: MemoryStorage
  remote: RemoteState
  setRemote: (s: RemoteState) => void
}

function makeApp(storage?: MemoryStorage): Harness {
  const api = loadBrowser()
  setupFixture()
  const doc = getDoc()
  const store = storage ?? new MemoryStorage()
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
  const h: Harness = {
    app: null as any,
    storage: store,
    remote: {
      url: 'https://www.naver.com/',
      title: 'NAVER',
      canGoBack: false,
      canGoForward: false,
      tabs: [{ targetId: 'page-1', url: 'https://www.naver.com/', title: 'NAVER', openerId: null }],
      activeTargetId: 'page-1',
      mainTargetId: 'page-1',
    },
    setRemote(s: RemoteState) {
      h.remote = s
    },
  }
  const app = api.createApp({
    doc,
    win: fakeWin,
    storage: store,
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

function tabEls(): any[] {
  return Array.from(getDoc().querySelectorAll('.bw-tab'))
}

function tabUrls(h: Harness): string[] {
  return h.app.getTabs().map((t: any) => t.url)
}

async function openThreeTabs(h: Harness): Promise<void> {
  h.app.go('https://www.naver.com/')
  await flush()
  h.app.newTab()
  h.app.go('https://www.google.com/')
  await flush()
  h.app.newTab()
  h.app.go('https://github.com/')
  await flush()
}

function pointerEvent(type: string, clientX: number): any {
  return new (getWin().MouseEvent)(type, { bubbles: true, clientX, button: 0 })
}

function openCtxOn(el: any): void {
  el.dispatchEvent(new (getWin().MouseEvent)('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
}

function clickCtxItem(label: string): boolean {
  const items = Array.from(getDoc().querySelectorAll('.bw-tab-ctx-item')) as any[]
  const item = items.find((b) => b.textContent === label)
  if (!item) return false
  item.click()
  return true
}

describe('browser 탭 관리 (3단계)', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(async () => {
    jest.useRealTimers()
  })

  test('탭을 드래그하면 순서가 바뀌고 localStorage에도 같은 순서로 저장된다', async () => {
    const h = makeApp()
    await openThreeTabs(h)
    expect(tabUrls(h)).toEqual([
      'https://www.naver.com/',
      'https://www.google.com/',
      'https://github.com/',
    ])
    const els = tabEls()
    expect(els).toHaveLength(3)
    els.forEach((el, i) => stubRectAt(el, i * 150, 150, 30))
    // 구글 탭(인덱스 1, 가운데 225px)을 맨 앞(60px)으로 드래그한다.
    // move/up 리스너는 탭 요소에 붙어 있다 (실브라우저에서는 포인터
    // 캡처가 move/up을 그 요소로 보내준다).
    els[1].dispatchEvent(pointerEvent('pointerdown', 225))
    els[1].dispatchEvent(pointerEvent('pointermove', 60))
    els[1].dispatchEvent(pointerEvent('pointerup', 60))
    expect(tabUrls(h)).toEqual([
      'https://www.google.com/',
      'https://www.naver.com/',
      'https://github.com/',
    ])
    const saved = JSON.parse(h.storage.getItem('myhub.browser.tabs.v1') ?? '{"tabs":[]}')
    expect(saved.tabs.map((t: any) => t.url)).toEqual([
      'https://www.google.com/',
      'https://www.naver.com/',
      'https://github.com/',
    ])
    // 드래그 뒤 다시 렌더링된 탭에 transform이 남지 않는다.
    expect((tabEls()[0] as any).style.transform).toBe('')
  })

  test('드래그 직후 클릭은 억제되고 그 다음 클릭부터 전환된다', async () => {
    const h = makeApp()
    await openThreeTabs(h)
    // 활성 탭은 github(마지막). 구글 탭을 맨 앞으로 드래그한다.
    expect(h.app.getTabs().find((t: any) => t.active).url).toBe('https://github.com/')
    const els = tabEls()
    els.forEach((el, i) => stubRectAt(el, i * 150, 150, 30))
    els[1].dispatchEvent(pointerEvent('pointerdown', 225))
    els[1].dispatchEvent(pointerEvent('pointermove', 60))
    els[1].dispatchEvent(pointerEvent('pointerup', 60))
    const googleEl = tabEls()[0]
    googleEl.dispatchEvent(new (getWin().MouseEvent)('click', { bubbles: true }))
    // 드래그 뒤 첫 클릭은 억제된다 — 활성 탭은 그대로 github이다.
    expect(h.app.getTabs().find((t: any) => t.active).url).toBe('https://github.com/')
    googleEl.dispatchEvent(new (getWin().MouseEvent)('click', { bubbles: true }))
    // 두 번째 클릭부터는 전환된다 (억제는 1회성).
    expect(h.app.getTabs().find((t: any) => t.active).url).toBe('https://www.google.com/')
  })

  test('닫기 버튼을 누르면 드래그가 시작되지 않고 클릭하면 탭이 닫힌다', async () => {
    const h = makeApp()
    await openThreeTabs(h)
    const els = tabEls()
    els.forEach((el, i) => stubRectAt(el, i * 150, 150, 30))
    // 닫기 버튼에서 pointerdown + 임계값을 넘는 이동 + pointerup.
    // 가드 없이 드래그가 시작되면 구글 탭이 맨 앞으로 이동한다.
    const closeBtn = els[1].querySelector('.bw-tab-close')
    closeBtn.dispatchEvent(pointerEvent('pointerdown', 225))
    els[1].dispatchEvent(pointerEvent('pointermove', 60))
    els[1].dispatchEvent(pointerEvent('pointerup', 60))
    expect(tabUrls(h)).toEqual([
      'https://www.naver.com/',
      'https://www.google.com/',
      'https://github.com/',
    ])
    expect(tabEls()[1].classList.contains('is-dragging')).toBe(false)
    expect((tabEls()[1] as any).style.transform).toBe('')
    // 닫기 버튼 클릭 — 구글 탭이 닫힌다. jsdom은 포인터 캡처의 click
    // 재겨냥을 재현하지 못하므로, 실제 클릭이 span에 닿는지는
    // tests/e2e/browser-tab-close.e2e.cjs가 실브라우저로 검증한다.
    tabEls()[1]
      .querySelector('.bw-tab-close')
      .dispatchEvent(new (getWin().MouseEvent)('click', { bubbles: true }))
    expect(tabUrls(h)).toEqual(['https://www.naver.com/', 'https://github.com/'])
    const saved = JSON.parse(h.storage.getItem('myhub.browser.tabs.v1') ?? '{"tabs":[]}')
    expect(saved.tabs.map((t: any) => t.url)).toEqual([
      'https://www.naver.com/',
      'https://github.com/',
    ])
  })

  test('고정하면 파비콘만 작게 맨 앞에 모이고 다시 열어도 유지된다', async () => {
    const h = makeApp()
    await openThreeTabs(h)
    openCtxOn(tabEls()[1])
    expect(clickCtxItem('고정')).toBe(true)
    const tabs = h.app.getTabs()
    expect(tabs[0].url).toBe('https://www.google.com/')
    expect(tabs[0].pinned).toBe(true)
    const pinnedEl = tabEls()[0]
    expect(pinnedEl.classList.contains('is-pinned')).toBe(true)
    expect(pinnedEl.querySelector('.bw-tab-name')).toBeNull()
    expect(pinnedEl.querySelector('.bw-tab-close')).toBeNull()
    // 다시 열어도(같은 storage로 새 앱) 고정이 유지된다.
    const h2 = makeApp(h.storage)
    await flush()
    const tabs2 = h2.app.getTabs()
    expect(tabs2[0].url).toBe('https://www.google.com/')
    expect(tabs2[0].pinned).toBe(true)
    expect(tabEls()[0].classList.contains('is-pinned')).toBe(true)
    // 고정 해제하면 일반 탭으로 돌아간다.
    openCtxOn(tabEls()[0])
    expect(clickCtxItem('고정 해제')).toBe(true)
    expect(h2.app.getTabs()[0].pinned).toBe(false)
    expect(tabEls()[0].querySelector('.bw-tab-close')).not.toBeNull()
  })

  test('고정 탭이 있으면 고정되지 않은 탭은 그 앞으로 못 간다', async () => {
    const h = makeApp()
    await openThreeTabs(h)
    openCtxOn(tabEls()[0])
    expect(clickCtxItem('고정')).toBe(true)
    expect(h.app.getTabs()[0].url).toBe('https://www.naver.com/')
    const els = tabEls()
    els.forEach((el, i) => stubRectAt(el, i * 150, 150, 30))
    // github 탭을 맨 왼쪽(10px)으로 드래그해도 고정 탭 뒤에 멈춘다.
    els[2].dispatchEvent(pointerEvent('pointerdown', 375))
    els[2].dispatchEvent(pointerEvent('pointermove', 10))
    els[2].dispatchEvent(pointerEvent('pointerup', 10))
    expect(tabUrls(h)).toEqual([
      'https://www.naver.com/',
      'https://github.com/',
      'https://www.google.com/',
    ])
  })

  test('복제하면 같은 URL·기록의 탭이 바로 옆에 생기고 활성화된다', async () => {
    const h = makeApp()
    h.app.go('https://www.naver.com/')
    await flush()
    h.app.go('https://www.google.com/')
    await flush()
    const before = h.app.getTabs()
    expect(before).toHaveLength(1)
    expect(before[0].history).toEqual(['https://www.naver.com/', 'https://www.google.com/'])
    openCtxOn(tabEls()[0])
    expect(clickCtxItem('탭 복제')).toBe(true)
    const tabs = h.app.getTabs()
    expect(tabs).toHaveLength(2)
    expect(tabs[1].url).toBe('https://www.google.com/')
    expect(tabs[1].history).toEqual(['https://www.naver.com/', 'https://www.google.com/'])
    expect(tabs[1].active).toBe(true)
  })

  test('개요 검색은 제목·URL로 필터링하고 결과가 없으면 빈 상태를 보여준다', async () => {
    const h = makeApp()
    await openThreeTabs(h)
    getDoc().getElementById('bwOverviewBtn').click()
    expect(getDoc().querySelectorAll('.bw-ov-card')).toHaveLength(3)
    const input = getDoc().getElementById('bwOverviewSearch')
    input.value = 'git'
    input.dispatchEvent(new (getWin().Event)('input', { bubbles: true }))
    const cards = getDoc().querySelectorAll('.bw-ov-card')
    expect(cards).toHaveLength(1)
    expect(cards[0].querySelector('.bw-ov-name')?.textContent).toContain('github.com')
    input.value = 'zzz-no-such-tab'
    input.dispatchEvent(new (getWin().Event)('input', { bubbles: true }))
    expect(getDoc().querySelectorAll('.bw-ov-card')).toHaveLength(0)
    expect(getDoc().querySelector('.bw-overview-empty')?.textContent).toBe('검색 결과가 없어요')
    input.value = ''
    input.dispatchEvent(new (getWin().Event)('input', { bubbles: true }))
    expect(getDoc().querySelectorAll('.bw-ov-card')).toHaveLength(3)
  })

  test('원격 title이 탭 줄·사이드바·개요에 표시되고 없으면 호스트로 폴백한다', async () => {
    const h = makeApp()
    h.app.go('https://www.naver.com/')
    await flush()
    await h.app.live.refreshState()
    await flush()
    expect(tabEls()[0].querySelector('.bw-tab-name')?.textContent).toBe('NAVER')
    // 사이드바
    getDoc().getElementById('bwSidebarBtn').click()
    expect(getDoc().querySelector('#bwSidebarTabs .bw-side-name')?.textContent).toBe('NAVER')
    // 개요
    getDoc().getElementById('bwOverviewBtn').click()
    expect(getDoc().querySelector('.bw-ov-name')?.textContent).toBe('NAVER')
    // title이 비면 호스트명으로 폴백한다.
    h.setRemote({ ...h.remote, title: '', tabs: [{ targetId: 'page-1', url: 'https://www.naver.com/', title: '', openerId: null }] })
    await h.app.live.refreshState()
    await flush()
    expect(tabEls()[0].querySelector('.bw-tab-name')?.textContent).toBe('naver.com')
  })

  test('새 탭을 열면 주소창이 비워진 채 포커스된다', async () => {
    const h = makeApp()
    h.app.go('https://www.naver.com/')
    await flush()
    const urlInput = getDoc().getElementById('bwUrl')
    expect(urlInput.value).toBe('https://www.naver.com/')
    // 주소창에 포커스가 있는 상태(입력 중 가드가 값을 안 건드리는 상황)에서
    // 새 탭을 열어도 이전 URL이 남지 않는다.
    urlInput.focus()
    h.app.newTab()
    expect(urlInput.value).toBe('')
    expect(getDoc().activeElement).toBe(urlInput)
  })

  test('탭 파비콘은 프록시를 쓰고 로딩 실패 시 첫 글자 타일로 폴백한다', async () => {
    const h = makeApp()
    await openThreeTabs(h)
    const fav = tabEls()[0].querySelector('.bw-tab-fav')
    const img = fav.querySelector('img')
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe(
      '/api/browse/favicon?url=' + encodeURIComponent('https://www.naver.com/'),
    )
    img.dispatchEvent(new (getWin().Event)('error'))
    expect(fav.querySelector('img')).toBeNull()
    expect(fav.textContent).toBe('N')
    // 사이드바 탭도 같은 파비콘을 쓴다.
    getDoc().getElementById('bwSidebarBtn').click()
    const sideImg = getDoc().querySelector('#bwSidebarTabs .bw-side-fav img')
    expect(sideImg).not.toBeNull()
    expect(sideImg.getAttribute('src')).toContain('/api/browse/favicon?url=')
  })
})
