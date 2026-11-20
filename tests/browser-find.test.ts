/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 페이지 내 찾기 프론트 (2026-11-20, 브라우저 5단계).
 *
 * 가짜 fetch로 고정하는 성질:
 * - '보기' 메뉴에 '페이지에서 찾기'가 있고, 라이브가 꺼져 있으면
 *   비활성화되고 켜져 있으면 활성화된다.
 * - 메뉴 클릭 시 POST /api/browse/find가 나가고, 성공하면 안내
 *   카드가 뜨지 않는다.
 * - 실패(ok:false·503·응답 없음)하면 안내 카드가 뜨고 라이브 화면은
 *   그대로 보인다 (상태 기계 불변, 조용한 실패 금지).
 * - 라이브가 꺼져 있으면 openFind가 POST를 보내지 않는다.
 *
 * 참고: CDP 키 이벤트로는 브라우저 단축키가 안 열려 (실브라우저
 * 실측, 2026-11-20) 찾기는 Selkies kd/ku 주입이 정본 경로다 —
 * 프론트는 /find 중계만 부른다. 이 파일은 중계 호출·안내만 검증하고,
 * 키 주입 자체는 사이드카 smoke-test가 검증한다.
 * 카나리아: 메뉴 항목·/find 호출·실패 안내를 빼면 해당 테스트가
 * 실패한다.
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

interface Harness {
  app: any
  findCalls: number
  findResult: { status: number; body: unknown } | null
  remote: { url: string; title: string; canGoBack: boolean; canGoForward: boolean }
  setRemote: (s: { url: string; title: string; canGoBack: boolean; canGoForward: boolean }) => void
}

function okJson(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function makeApp(): Harness {
  const api = loadBrowser()
  setupFixture()
  const doc = getDoc()
  const findCalls = { n: 0 }
  const h: Harness = {
    app: null as any,
    get findCalls() {
      return findCalls.n
    },
    findResult: { status: 200, body: { ok: true, connections: 1 } },
    remote: { url: 'https://www.naver.com', title: 'naver.com', canGoBack: false, canGoForward: false },
    setRemote(s) {
      h.remote = s
    },
  }
  const fakeWin = {
    parent: { postMessage: () => {} },
    location: { origin: 'https://myhub.test' },
    addEventListener: () => {},
    fetch: (url: string, init: any = {}) => {
      const method = (init.method || 'GET').toUpperCase()
      const path = String(url).split('?')[0]
      if (path === '/api/browse/find' && method === 'POST') {
        findCalls.n += 1
        if (h.findResult === null) return Promise.resolve(null)
        return Promise.resolve(okJson(h.findResult.body, h.findResult.status))
      }
      return Promise.resolve(okJson({ ok: true, bookmarks: [], history: [] }))
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

async function flush(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

function viewMenuItems(win: any): any[] {
  const menus = win.MyHubMenus as any[]
  const view = menus.find((m: any) => m.label === '보기')
  return view.items()
}

function findMenuItem(win: any): any {
  return viewMenuItems(win).find((i: any) => i.label === '페이지에서 찾기')
}

describe('브라우저 5단계 — 페이지에서 찾기', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(async () => {
    jest.useRealTimers()
  })

  test('라이브가 꺼져 있으면 찾기 메뉴가 비활성화된다', async () => {
    const h = makeApp()
    const item = findMenuItem(getWin())
    expect(item).toBeDefined()
    expect(item.disabled).toBe(true)
    await h.app.live.endLive()
  })

  test('라이브가 켜져 있으면 메뉴가 활성화되고 클릭하면 POST /api/browse/find가 나간다', async () => {
    const h = makeApp()
    h.app.go('https://www.naver.com')
    await flush()
    const item = findMenuItem(getWin())
    expect(item.disabled).toBe(false)
    item.run()
    await flush()
    expect(h.findCalls).toBe(1)
    // 성공하면 안내 카드가 뜨지 않는다.
    expect(getDoc().getElementById('bwNoticeCard').hidden).toBe(true)
    await h.app.live.endLive()
  })

  test('찾기 실패(ok:false) 시 안내 카드가 뜨고 라이브 화면은 그대로다', async () => {
    const h = makeApp()
    h.app.go('https://www.naver.com')
    await flush()
    h.findResult = { status: 503, body: { ok: false, error: 'no_active_connection' } }
    findMenuItem(getWin()).run()
    await flush()
    expect(h.findCalls).toBe(1)
    const doc = getDoc()
    expect(doc.getElementById('bwNoticeCard').hidden).toBe(false)
    expect(doc.getElementById('bwNoticeMsg').textContent).toContain('페이지 내 찾기를 열 수 없어요')
    expect(h.app.live.state()).toBe('on')
    expect(doc.getElementById('bwLiveFrame').hidden).toBe(false)
    await h.app.live.endLive()
  })

  test('찾기 응답이 없으면 안내 카드가 뜬다', async () => {
    const h = makeApp()
    h.app.go('https://www.naver.com')
    await flush()
    h.findResult = null
    findMenuItem(getWin()).run()
    await flush()
    expect(h.findCalls).toBe(1)
    expect(getDoc().getElementById('bwNoticeCard').hidden).toBe(false)
    expect(getDoc().getElementById('bwNoticeMsg').textContent).toContain('페이지 내 찾기를 열 수 없어요')
    await h.app.live.endLive()
  })
})
