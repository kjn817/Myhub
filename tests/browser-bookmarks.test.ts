/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 북마크·방문 기록 프론트 (2026-11-20, 브라우저 1단계).
 *
 * 가짜 북마크·히스토리 API(fakeWin.fetch)로 고정하는 성질:
 * - 시작 페이지 타일은 pinned 북마크만 API에서 그린다 (unpinned은 제외).
 * - 편집 모드에서만 삭제 배지·추가 타일이 보인다 (평소엔 없음).
 * - 추가 폼으로 북마크를 만들면 타일이 생기고 POST가 pinned: true다.
 * - 편집 모드 삭제 배지·사이드바 삭제 버튼이 북마크를 지운다.
 * - 타일 이름 편집은 PATCH로 저장되고 타일 이름이 바뀐다.
 * - 잘못된 주소는 폼 오류를 보이고 API를 부르지 않는다.
 * - 메뉴에서 현재 페이지 북마크를 추가·제거할 수 있다 (토글 라벨).
 * - 사이드바 방문 기록은 열 때 불러오고, 검색은 API q로 필터링하며,
 *   전체 삭제는 DELETE 뒤 목록을 비운다.
 * - 이동·원격 URL 변경은 방문 기록 POST로 남긴다 (fire-and-forget).
 * 카나리아: 타일 렌더링·토글·기록 훅을 빼면 해당 테스트가 실패한다.
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
      <button type="button" id="bwSidebarBtn" aria-label="사이드바"></button>
      <button type="button" id="bwBackBtn" aria-label="뒤로"></button>
      <button type="button" id="bwFwdBtn" aria-label="앞으로"></button>
      <button type="button" id="bwReloadBtn" aria-label="새로고침"></button>
      <input id="bwUrl" type="text" autocomplete="off" spellcheck="false" aria-label="주소 또는 검색어">
      <button type="button" id="bwShareBtn" aria-label="링크 복사"></button>
      <button type="button" id="bwNewTabBtn" aria-label="새 탭"></button>
      <button type="button" id="bwOverviewBtn" aria-label="탭 개요"></button>
    </div>
    <div id="bwTabstrip"><div id="bwTabs"></div></div>
    <div class="bw-stage" id="bwStage">
      <div class="bw-home" id="bwHome">
        <div class="bw-section-head">
          <h2 class="bw-section-title">즐겨찾기</h2>
          <button type="button" class="bw-section-edit" id="bwFavsEdit">편집</button>
        </div>
        <div class="bw-favs" id="bwFavs"></div>
        <div class="bw-fav-form" id="bwFavForm" hidden>
          <input type="text" id="bwFavUrl" placeholder="주소">
          <input type="text" id="bwFavTitle" placeholder="이름">
          <p class="bw-fav-form-msg" id="bwFavFormMsg" hidden></p>
          <div class="bw-fav-form-btns">
            <button type="button" id="bwFavSave">추가</button>
            <button type="button" id="bwFavCancel">취소</button>
          </div>
        </div>
        <div id="bwRecents" hidden>
          <h2 class="bw-section-title">최근 방문</h2>
          <div class="bw-recents" id="bwRecentsList"></div>
        </div>
      </div>
      <iframe class="bw-frame" id="bwLiveFrame" title="원격 브라우저" hidden></iframe>
      <div class="bw-notice-card" id="bwNoticeCard" hidden>
        <p id="bwNoticeMsg"></p><button type="button" id="bwNoticeClose">닫기</button>
      </div>
      <div class="bw-sidebar-backdrop" id="bwSidebarBackdrop" hidden></div>
      <aside class="bw-sidebar" id="bwSidebar" hidden aria-label="사이드바">
        <div class="bw-sidebar-head">
          <h2 class="bw-sidebar-title">브라우저</h2>
          <button type="button" id="bwSidebarClose" aria-label="사이드바 닫기"></button>
        </div>
        <div class="bw-sidebar-body">
          <section class="bw-sidebar-section">
            <h3 class="bw-sidebar-section-title">즐겨찾기</h3>
            <div class="bw-sidebar-list" id="bwSidebarFavs"></div>
          </section>
          <section class="bw-sidebar-section" id="bwSidebarHistorySection">
            <div class="bw-sidebar-section-head">
              <h3 class="bw-sidebar-section-title">방문 기록</h3>
              <button type="button" id="bwHistoryClear">전체 삭제</button>
            </div>
            <input type="text" id="bwHistorySearch" placeholder="기록 검색">
            <div class="bw-sidebar-list" id="bwSidebarHistory"></div>
          </section>
          <section class="bw-sidebar-section">
            <h3 class="bw-sidebar-section-title">열린 탭</h3>
            <div class="bw-sidebar-list" id="bwSidebarTabs"></div>
          </section>
        </div>
      </aside>
      <div class="bw-overview" id="bwOverview" hidden>
        <div class="bw-overview-head">
          <h2 class="bw-overview-title">열린 탭</h2>
          <button type="button" id="bwOverviewClose" aria-label="탭 개요 닫기"></button>
        </div>
        <div class="bw-overview-grid" id="bwOverviewGrid"></div>
      </div>
    </div>
  `
  stubRect(doc.getElementById('bwStage'), 1920, 1000)
  stubRect(doc.getElementById('bwLiveFrame'), 0, 0)
}

interface FakeBookmark {
  id: number
  url: string
  title: string | null
  pinned: boolean
  position: number
}

interface FakeHistory {
  id: number
  url: string
  title: string | null
  visited_at: string
}

interface ApiCall {
  method: string
  path: string
  body: any
}

interface Harness {
  app: any
  bookmarks: FakeBookmark[]
  history: FakeHistory[]
  calls: ApiCall[]
  remote: any
  setRemote: (s: any) => void
  nextId: number
}

function okJson(body: any, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function makeApp(seedBookmarks: FakeBookmark[] = [], seedHistory: FakeHistory[] = []): Harness {
  const api = loadBrowser()
  setupFixture()
  const doc = getDoc()
  const h: Harness = {
    app: null as any,
    bookmarks: seedBookmarks.map((b) => ({ ...b })),
    history: seedHistory.map((x) => ({ ...x })),
    calls: [],
    remote: {
      url: 'https://www.naver.com/',
      title: 'NAVER',
      canGoBack: false,
      canGoForward: false,
      tabs: [{ targetId: 'page-1', url: 'https://www.naver.com/', title: 'NAVER', openerId: null }],
      activeTargetId: 'page-1',
      mainTargetId: 'page-1',
    },
    setRemote(s: any) {
      h.remote = s
    },
    nextId: 100,
  }
  const fakeWin = {
    parent: { postMessage: () => {} },
    location: { origin: 'https://myhub.test' },
    addEventListener: () => {},
    fetch: (url: string, init: any = {}) => {
      const method = (init.method || 'GET').toUpperCase()
      const [path, queryString] = String(url).split('?')
      const query = new URLSearchParams(queryString || '')
      let body: any = null
      try {
        body = init.body ? JSON.parse(init.body) : null
      } catch {
        body = null
      }
      h.calls.push({ method, path, body })
      if (path === '/api/browse/bookmarks' && method === 'GET') {
        return Promise.resolve(okJson({ ok: true, bookmarks: h.bookmarks }))
      }
      if (path === '/api/browse/bookmarks' && method === 'POST') {
        const created: FakeBookmark = {
          id: h.nextId++,
          url: body.url,
          title: body.title ?? null,
          pinned: !!body.pinned,
          position: h.bookmarks.length,
        }
        h.bookmarks.push(created)
        return Promise.resolve(okJson({ ok: true, bookmark: created }, 201))
      }
      const bmMatch = path.match(/^\/api\/browse\/bookmarks\/(\d+)$/)
      if (bmMatch && method === 'PATCH') {
        const b = h.bookmarks.find((x) => x.id === Number(bmMatch[1]))
        if (!b) return Promise.resolve(okJson({ ok: false, error: 'not_found' }, 404))
        if (body.title !== undefined) b.title = body.title
        if (body.pinned !== undefined) b.pinned = !!body.pinned
        if (body.position !== undefined) b.position = body.position
        return Promise.resolve(okJson({ ok: true, bookmark: b }))
      }
      if (bmMatch && method === 'DELETE') {
        h.bookmarks = h.bookmarks.filter((x) => x.id !== Number(bmMatch[1]))
        return Promise.resolve(okJson({ ok: true, deleted: Number(bmMatch[1]) }))
      }
      if (path === '/api/browse/history' && method === 'GET') {
        const q = (query.get('q') || '').toLowerCase()
        const limit = Number(query.get('limit') || 100)
        const rows = h.history
          .filter((x) => !q || x.url.toLowerCase().includes(q) || (x.title || '').toLowerCase().includes(q))
          .slice(0, limit)
        return Promise.resolve(okJson({ ok: true, history: rows }))
      }
      if (path === '/api/browse/history' && method === 'POST') {
        const existing = h.history.find((x) => x.url === body.url)
        if (existing) {
          existing.visited_at = new Date().toISOString()
          return Promise.resolve(okJson({ ok: true, history: existing }))
        }
        const created: FakeHistory = {
          id: h.nextId++,
          url: body.url,
          title: body.title ?? null,
          visited_at: new Date().toISOString(),
        }
        h.history.unshift(created)
        return Promise.resolve(okJson({ ok: true, history: created }))
      }
      if (path === '/api/browse/history' && method === 'DELETE') {
        const n = h.history.length
        h.history = []
        return Promise.resolve(okJson({ ok: true, deleted: n }))
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    },
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

async function flush(n = 40): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

function favTiles(doc: any): any[] {
  // 편집 모드의 '추가' 타일(.bw-fav-add)은 북마크 타일이 아니므로 제외한다.
  return Array.from(doc.querySelectorAll('#bwFavs .bw-fav:not(.bw-fav-add)'))
}

function favNames(doc: any): string[] {
  return favTiles(doc).map((t: any) => t.querySelector('.bw-fav-name')?.textContent ?? '')
}

function openSidebar(doc: any): void {
  ;(doc.getElementById('bwSidebarBtn') as any).click()
}

function favMenuItems(win: any): any[] {
  const menus = win.MyHubMenus as any[]
  const fav = menus.find((m: any) => m.label === '즐겨찾기')
  return fav.items()
}

const SEEDS: FakeBookmark[] = [
  { id: 1, url: 'https://www.naver.com/', title: 'NAVER', pinned: true, position: 0 },
  { id: 2, url: 'https://www.google.com/', title: 'Google', pinned: true, position: 1 },
  { id: 3, url: 'https://example.com/', title: '예시', pinned: false, position: 2 },
]

const HISTORY_SEED: FakeHistory[] = [
  { id: 11, url: 'https://news.example/politics', title: '정치 뉴스', visited_at: '2026-11-20T10:00:00.000Z' },
  { id: 12, url: 'https://news.example/sports', title: '스포츠 뉴스', visited_at: '2026-11-20T11:00:00.000Z' },
  { id: 13, url: 'https://docs.example/guide', title: '가이드', visited_at: '2026-11-20T12:00:00.000Z' },
]

describe('브라우저 북마크·방문 기록 프론트', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(async () => {
    jest.useRealTimers()
  })

  test('시작 페이지 타일은 pinned 북마크만 API에서 그린다', async () => {
    const h = makeApp(SEEDS)
    await flush()
    const doc = getDoc()
    expect(favNames(doc)).toEqual(['NAVER', 'Google'])
    expect(favTiles(doc).length).toBe(2)
    // 사이드바에는 unpinned 포함 전체가 보인다.
    openSidebar(doc)
    await flush()
    const sideNames = Array.from(doc.querySelectorAll('#bwSidebarFavs .bw-side-name')).map(
      (el: any) => el.textContent,
    )
    expect(sideNames).toEqual(['NAVER', 'Google', '예시'])
  })

  test('편집 모드에서만 삭제 배지·추가 타일이 보인다', async () => {
    const h = makeApp(SEEDS)
    await flush()
    const doc = getDoc()
    expect(doc.querySelectorAll('#bwFavs .bw-fav-del').length).toBe(0)
    expect(doc.querySelector('#bwFavs .bw-fav-add')).toBeNull()
    ;(doc.getElementById('bwFavsEdit') as any).click()
    expect(doc.querySelectorAll('#bwFavs .bw-fav-del').length).toBe(2)
    expect(doc.querySelector('#bwFavs .bw-fav-add')).not.toBeNull()
    expect((doc.getElementById('bwFavsEdit') as any).textContent).toBe('완료')
    ;(doc.getElementById('bwFavsEdit') as any).click()
    expect(doc.querySelectorAll('#bwFavs .bw-fav-del').length).toBe(0)
    expect(doc.querySelector('#bwFavs .bw-fav-add')).toBeNull()
    expect((doc.getElementById('bwFavsEdit') as any).textContent).toBe('편집')
  })

  test('추가 폼으로 북마크를 만들면 타일이 생기고 POST가 pinned: true다', async () => {
    const h = makeApp(SEEDS)
    await flush()
    const doc = getDoc()
    ;(doc.getElementById('bwFavsEdit') as any).click()
    ;(doc.querySelector('#bwFavs .bw-fav-add') as any).click()
    expect((doc.getElementById('bwFavForm') as any).hidden).toBe(false)
    ;(doc.getElementById('bwFavUrl') as any).value = 'https://newsite.example/'
    ;(doc.getElementById('bwFavTitle') as any).value = '새 사이트'
    ;(doc.getElementById('bwFavSave') as any).click()
    await flush()
    expect(favNames(doc)).toContain('새 사이트')
    const post = h.calls.find((c) => c.method === 'POST' && c.path === '/api/browse/bookmarks')
    expect(post).toBeDefined()
    expect(post!.body.pinned).toBe(true)
    expect(post!.body.url).toBe('https://newsite.example/')
  })

  test('편집 모드 삭제 배지를 누르면 타일이 사라진다', async () => {
    const h = makeApp(SEEDS)
    await flush()
    const doc = getDoc()
    ;(doc.getElementById('bwFavsEdit') as any).click()
    const firstDel = doc.querySelector('#bwFavs .bw-fav-del') as any
    firstDel.click()
    await flush()
    expect(favNames(doc)).toEqual(['Google'])
    expect(h.calls.some((c) => c.method === 'DELETE' && c.path === '/api/browse/bookmarks/1')).toBe(true)
  })

  test('사이드바 삭제 버튼도 북마크를 지운다', async () => {
    const h = makeApp(SEEDS)
    await flush()
    const doc = getDoc()
    openSidebar(doc)
    await flush()
    const dels = doc.querySelectorAll('#bwSidebarFavs .bw-side-del')
    expect(dels.length).toBe(3)
    ;(dels[2] as any).click()
    await flush()
    const sideNames = Array.from(doc.querySelectorAll('#bwSidebarFavs .bw-side-name')).map(
      (el: any) => el.textContent,
    )
    expect(sideNames).toEqual(['NAVER', 'Google'])
  })

  test('편집 모드에서 타일을 누르면 이름 편집 폼이 열리고 저장하면 이름이 바뀐다', async () => {
    const h = makeApp(SEEDS)
    await flush()
    const doc = getDoc()
    ;(doc.getElementById('bwFavsEdit') as any).click()
    const firstTile = favTiles(doc)[0] as any
    firstTile.click()
    expect((doc.getElementById('bwFavForm') as any).hidden).toBe(false)
    expect((doc.getElementById('bwFavUrl') as any).value).toBe('https://www.naver.com/')
    expect((doc.getElementById('bwFavUrl') as any).disabled).toBe(true)
    expect((doc.getElementById('bwFavTitle') as any).value).toBe('NAVER')
    ;(doc.getElementById('bwFavTitle') as any).value = '네이버'
    ;(doc.getElementById('bwFavSave') as any).click()
    await flush()
    expect(favNames(doc)).toContain('네이버')
    const patch = h.calls.find((c) => c.method === 'PATCH' && c.path === '/api/browse/bookmarks/1')
    expect(patch).toBeDefined()
    expect(patch!.body.title).toBe('네이버')
  })

  test('폼에 잘못된 주소를 넣으면 오류가 뜨고 API를 부르지 않는다', async () => {
    const h = makeApp(SEEDS)
    await flush()
    const doc = getDoc()
    ;(doc.getElementById('bwFavsEdit') as any).click()
    ;(doc.querySelector('#bwFavs .bw-fav-add') as any).click()
    ;(doc.getElementById('bwFavUrl') as any).value = '그냥 단어'
    const before = h.calls.length
    ;(doc.getElementById('bwFavSave') as any).click()
    expect((doc.getElementById('bwFavFormMsg') as any).hidden).toBe(false)
    expect(h.calls.length).toBe(before)
    expect(favNames(doc)).toEqual(['NAVER', 'Google'])
  })

  test('메뉴에서 현재 페이지 북마크를 추가·제거할 수 있다 (토글 라벨)', async () => {
    const h = makeApp(SEEDS)
    await flush()
    const doc = getDoc()
    const win = getWin()
    // 원격 상태 URL도 같은 곳으로 맞춘다 — enterLive 뒤 폴링이 탭 URL을
    // 원격 상태 URL로 덮으므로, 안 맞추면 메뉴가 네이버를 보게 된다.
    h.setRemote({ ...h.remote, url: 'https://docs.example/guide', title: '가이드' })
    h.app.go('https://docs.example/guide')
    await flush()
    let items = favMenuItems(win)
    const addItem = items.find((i: any) => i.label === '현재 페이지 북마크에 추가')
    expect(addItem).toBeDefined()
    addItem.run()
    await flush()
    expect(h.bookmarks.some((b) => b.url === 'https://docs.example/guide')).toBe(true)
    items = favMenuItems(win)
    const removeItem = items.find((i: any) => i.label === '현재 페이지 북마크에서 제거')
    expect(removeItem).toBeDefined()
    removeItem.run()
    await flush()
    expect(h.bookmarks.some((b) => b.url === 'https://docs.example/guide')).toBe(false)
    expect(doc.querySelector('#bwFavs')).not.toBeNull()
  })

  test('사이드바 방문 기록은 열 때 불러오고 검색하면 필터링된다', async () => {
    const h = makeApp(SEEDS, HISTORY_SEED)
    await flush()
    const doc = getDoc()
    openSidebar(doc)
    await flush()
    let rows = Array.from(doc.querySelectorAll('#bwSidebarHistory .bw-side-name')).map(
      (el: any) => el.textContent,
    )
    expect(rows).toEqual(['정치 뉴스', '스포츠 뉴스', '가이드'])
    const search = doc.getElementById('bwHistorySearch') as any
    search.value = '스포츠'
    search.dispatchEvent(new (winEvent())('input', { bubbles: true }))
    jest.advanceTimersByTime(250)
    await flush()
    rows = Array.from(doc.querySelectorAll('#bwSidebarHistory .bw-side-name')).map(
      (el: any) => el.textContent,
    )
    expect(rows).toEqual(['스포츠 뉴스'])
    expect(h.calls.some((c) => c.method === 'GET' && c.path === '/api/browse/history')).toBe(true)
  })

  test('방문 기록 전체 삭제는 DELETE 뒤 목록을 비운다', async () => {
    const h = makeApp(SEEDS, HISTORY_SEED)
    await flush()
    const doc = getDoc()
    openSidebar(doc)
    await flush()
    expect(doc.querySelectorAll('#bwSidebarHistory .bw-side-item').length).toBe(3)
    ;(doc.getElementById('bwHistoryClear') as any).click()
    await flush()
    expect(doc.querySelectorAll('#bwSidebarHistory .bw-side-item').length).toBe(0)
    expect(doc.querySelector('#bwSidebarHistory .bw-sidebar-empty')?.textContent).toBe('방문 기록이 없어요')
    expect(h.calls.some((c) => c.method === 'DELETE' && c.path === '/api/browse/history')).toBe(true)
  })

  test('이동하면 방문 기록이 POST된다', async () => {
    const h = makeApp(SEEDS)
    await flush()
    h.setRemote({ ...h.remote, url: 'https://docs.example/guide', title: '가이드' })
    h.app.go('https://docs.example/guide')
    await flush()
    const posts = h.calls.filter((c) => c.method === 'POST' && c.path === '/api/browse/history')
    expect(posts.length).toBeGreaterThanOrEqual(1)
    // 이동 훅과 폴링 훅이 같은 URL을 두 번 기록할 수 있으므로 포함으로 본다.
    expect(posts.map((p) => p.body.url)).toContain('https://docs.example/guide')
    expect(h.history.some((x) => x.url === 'https://docs.example/guide')).toBe(true)
  })

  test('원격 URL 변경(폴링)도 방문 기록에 남긴다', async () => {
    const h = makeApp(SEEDS)
    await flush()
    h.app.go('https://www.naver.com/')
    await flush()
    h.calls.length = 0
    h.setRemote({
      ...h.remote,
      url: 'https://news.naver.com/article/123',
      title: '뉴스 기사',
      canGoBack: true,
    })
    await h.app.live.refreshState()
    await flush()
    const posts = h.calls.filter((c) => c.method === 'POST' && c.path === '/api/browse/history')
    expect(posts.map((p) => p.body.url)).toContain('https://news.naver.com/article/123')
    await h.app.live.endLive()
  })
})

function winEvent(): any {
  return (globalThis as any).window.Event
}
