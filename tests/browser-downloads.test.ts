/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 다운로드 목록 프론트 (2026-11-20, 브라우저 2단계).
 *
 * 가짜 Drive 목록(fakeWin.fetch)으로 고정하는 성질:
 * - 사이드바를 열면 Drive '다운로드' 폴더(folder=4) 목록을 불러와
 *   최신순(API id DESC 그대로) 최대 20개만 그린다.
 * - 항목에 파일명·크기(B/KB/MB/GB)·시간(오늘은 시:분, 그 전은 월/일)이
 *   보인다. 파일이 없으면 빈 상태 문구가 보인다.
 * - 오피스 파일 클릭은 부모에 myhub:open-in-app(해당 앱·fileId·
 *   폴더 4)을, 그 밖의 파일 클릭은 myhub:open-file-in-finder
 *   (fileId·폴더 4)를 보낸다 — 셸이 파인더에 open-file을 중계해
 *   해당 파일까지 이동한다. 단독 실행(부모 없음)에서는 콘텐츠 URL로
 *   내려받는다.
 * 카나리아: 목록 렌더링·클릭 분기를 빼면 해당 테스트가 실패한다.
 *
 * 참고: '페이지에서 찾기'는 CDP 키 이벤트로는 브라우저 단축키가 안
 * 열려 (실브라우저 실측, 2026-11-20) 사이드카 배치(5단계)로 미뤘다 —
 * Selkies kd/ku 주입이 정본 경로다. 이 파일에 찾기 테스트는 없다.
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
            <h3 class="bw-sidebar-section-title">다운로드</h3>
            <div class="bw-sidebar-list" id="bwSidebarDownloads"></div>
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

interface FakeFile {
  id: number
  folder_id: number
  filename: string
  mime: string | null
  size: number
  url: string | null
  created_at: string
  deleted_at: string | null
  version: string
}

interface ApiCall {
  method: string
  path: string
  body: any
}

interface Harness {
  app: any
  files: FakeFile[]
  calls: ApiCall[]
  posted: any[]
  opened: Array<{ url: string; target: string }>
  remote: any
}

function okJson(body: any, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function makeFile(id: number, filename: string, size: number, createdAt: string, mime: string | null = null): FakeFile {
  return {
    id,
    folder_id: 4,
    filename,
    mime,
    size,
    url: null,
    created_at: createdAt,
    deleted_at: null,
    version: `v${id}`,
  }
}

function makeApp(seedFiles: FakeFile[] = [], standalone = false): Harness {
  const api = loadBrowser()
  setupFixture()
  const doc = getDoc()
  const h: Harness = {
    app: null as any,
    files: seedFiles.map((f) => ({ ...f })),
    calls: [],
    posted: [],
    opened: [],
    remote: {
      url: 'https://www.naver.com/',
      title: 'NAVER',
      canGoBack: false,
      canGoForward: false,
      tabs: [{ targetId: 'page-1', url: 'https://www.naver.com/', title: 'NAVER', openerId: null }],
      activeTargetId: 'page-1',
      mainTargetId: 'page-1',
    },
  }
  const fakeWin: any = {
    location: { origin: 'https://myhub.test' },
    addEventListener: () => {},
    open: (url: string, target: string) => {
      h.opened.push({ url, target })
      return null
    },
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
      h.calls.push({ method, path: queryString ? `${path}?${queryString}` : path, body })
      if (path === '/api/drive/list' && method === 'GET') {
        if (query.get('folder') !== '4') {
          return Promise.resolve(okJson({ ok: false, error: 'bad folder' }, 400))
        }
        return Promise.resolve(
          okJson({ ok: true, folder: { id: 4, name: '다운로드' }, folders: [], files: h.files }),
        )
      }
      if (path === '/api/browse/bookmarks' && method === 'GET') {
        return Promise.resolve(okJson({ ok: true, bookmarks: [] }))
      }
      if (path === '/api/browse/history' && method === 'GET') {
        return Promise.resolve(okJson({ ok: true, history: [] }))
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    },
  }
  // 셸 안: 부모가 별도 객체. 단독 실행: 부모가 자기 자신.
  fakeWin.parent = standalone
    ? fakeWin
    : {
        postMessage: (msg: any) => {
          h.posted.push(msg)
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

function openSidebar(doc: any): void {
  ;(doc.getElementById('bwSidebarBtn') as any).click()
}

function downloadItems(doc: any): any[] {
  return Array.from(doc.querySelectorAll('#bwSidebarDownloads .bw-side-item'))
}

function downloadNames(doc: any): string[] {
  return downloadItems(doc).map((el: any) => el.querySelector('.bw-side-name')?.textContent ?? '')
}

function downloadMetas(doc: any): string[] {
  return downloadItems(doc).map((el: any) => el.querySelector('.bw-side-meta')?.textContent ?? '')
}

const NOW_ISO = new Date().toISOString()

const SEEDS: FakeFile[] = [
  makeFile(45, '회의록.xlsx', 1536, NOW_ISO, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  makeFile(44, '발표자료.pptx', 2 * 1024 * 1024, '2026-11-10T08:30:00.000Z', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
  makeFile(43, '스크린샷.png', 512, '2026-11-09T15:04:00.000Z', 'image/png'),
]

describe('다운로드 목록 — 사이드바', () => {
  test('사이드바를 열면 다운로드 폴더(folder=4) 목록을 불러와 최신순으로 그린다', async () => {
    const h = makeApp(SEEDS)
    const doc = getDoc()
    openSidebar(doc)
    await flush()
    expect(h.calls.some((c) => c.method === 'GET' && c.path === '/api/drive/list?folder=4')).toBe(true)
    // API가 준 id DESC 순서 그대로 (새 파일이 위).
    expect(downloadNames(doc)).toEqual(['회의록.xlsx', '발표자료.pptx', '스크린샷.png'])
  })

  test('20개가 넘으면 20개만 그린다', async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      makeFile(100 + i, `파일${String(i + 1).padStart(2, '0')}.txt`, 100, NOW_ISO, 'text/plain'),
    ).reverse() // id DESC: 124부터
    const h = makeApp(many)
    const doc = getDoc()
    openSidebar(doc)
    await flush()
    expect(downloadItems(doc)).toHaveLength(20)
    expect(downloadNames(doc)[0]).toBe('파일25.txt')
    expect(downloadNames(doc)[19]).toBe('파일06.txt')
  })

  test('파일이 없으면 빈 상태 문구를 보인다', async () => {
    const h = makeApp([])
    const doc = getDoc()
    openSidebar(doc)
    await flush()
    expect(downloadItems(doc)).toHaveLength(0)
    expect(doc.querySelector('#bwSidebarDownloads .bw-sidebar-empty')?.textContent).toBe(
      '아직 다운로드한 파일이 없어요',
    )
  })

  test('항목에 파일명·크기·시간이 보인다 (오늘은 시:분, 그 전은 월/일)', async () => {
    const h = makeApp(SEEDS)
    const doc = getDoc()
    openSidebar(doc)
    await flush()
    const metas = downloadMetas(doc)
    expect(metas).toHaveLength(3)
    // 크기: 1536B → 1.5KB, 2MB → 2MB, 512B → 512B.
    expect(metas[0]).toContain('1.5KB')
    expect(metas[1]).toContain('2MB')
    expect(metas[2]).toContain('512B')
    // 오늘 파일은 날짜 없이 시:분만, 옛 파일은 월/일이 들어간다.
    expect(metas[0]).toMatch(/^\S+ · \d{2}:\d{2}$/)
    expect(metas[1]).toContain('/')
    expect(metas[2]).toContain('/')
  })

  test('오피스 파일 클릭은 부모에 myhub:open-in-app을 보낸다', async () => {
    const h = makeApp(SEEDS)
    const doc = getDoc()
    openSidebar(doc)
    await flush()
    downloadItems(doc)[0].click()
    expect(h.posted).toContainEqual({
      type: 'myhub:open-in-app',
      app: 'excel',
      fileId: 45,
      name: '회의록.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      version: 'v45',
      folderId: 4,
      folderName: '다운로드',
    })
    expect(h.opened).toHaveLength(0)
  })

  test('그 밖의 파일 클릭은 부모에 myhub:open-file-in-finder를 보낸다', async () => {
    const h = makeApp(SEEDS)
    const doc = getDoc()
    openSidebar(doc)
    await flush()
    downloadItems(doc)[2].click()
    expect(h.posted).toContainEqual({
      type: 'myhub:open-file-in-finder',
      fileId: 43,
      name: '스크린샷.png',
      mime: 'image/png',
      folderId: 4,
      folderName: '다운로드',
    })
    expect(h.opened).toHaveLength(0)
  })

  test('단독 실행에서는 콘텐츠 URL로 내려받는다', async () => {
    const h = makeApp(SEEDS, true)
    const doc = getDoc()
    openSidebar(doc)
    await flush()
    downloadItems(doc)[2].click()
    expect(h.posted).toHaveLength(0)
    expect(h.opened).toEqual([{ url: '/api/drive/files/43/content', target: '_blank' }])
  })
})
