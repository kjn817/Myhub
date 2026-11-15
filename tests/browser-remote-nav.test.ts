/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 원격 상태 기반 주소·뒤로/앞으로 — browser.js + browser-live.js 연동
 * (2026-11-15 밤).
 *
 * 배경: 셸 로컬 기록만 보던 주소창·뒤로가기는 원격 내 링크 이동을
 * 몰라 주소가 naver.com에 고정되고 뒤로가기가 안 됐다. 정식 수정은
 * CDP 상태 폴링: 라이브가 켜져 있는 동안 원격의 실제 URL·뒤로/앞으로
 * 가능 여부를 받아 주소창·버튼을 원격 기준으로 맞추고, 뒤로/앞으로
 * 버튼은 원격 기록에 지시한다. 라이브가 켜져 있을 때는 로컬 폴백을
 * 쓰지 않는다 (2026-11-16 QA 1차: 로컬 기록은 원격 내 이동을 몰라
 * 낡은 URL로 가고, go()→navigate가 다른 탭을 닫아버린다 — 상태를
 * 모르면 버튼을 끄는 것이 엉뚱한 곳에 가는 것보다 옳다). 로컬 폴백은
 * 라이브가 꺼져 있을 때만.
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - 폴링이 본 원격 URL이 주소창에 반영되고, 로컬 기록은 건드리지 않는다.
 * - 뒤로/앞으로 버튼 disabled가 원격 canGoBack/canGoForward를 따른다
 *   (로컬 기록과 다를 때도 원격이 우선한다).
 * - 뒤로/앞으로 클릭은 원격 history를 부르고, 성공하면 상태를
 *   즉시 다시 물어 주소를 맞춘다 (로컬 navigate는 안 나간다).
 * - 원격 이동이 실패해도 라이브가 켜져 있으면 로컬 폴백을 하지 않는다.
 * - 폴링이 실패해 원격 상태를 모르면 버튼이 꺼지고, 뒤로 클릭은
 *   아무것도 하지 않는다 (로컬 폴백 호출 없음).
 * - 라이브가 꺼져 있으면 로컬 기록 기준으로 동작한다 (폴백은 그때만).
 * - 폴링 결과는 뷰를 소유한 탭에만 반영된다 (다른 탭을 보고 있으면
 *   그 탭의 주소창은 안 바뀐다).
 * 카나리아: onState 연동·navCaps 우선순위·CDP 우선 이동·라이브 켜짐
 * 시 폴백 금지를 빼면 해당 테스트가 실패한다.
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

/* 스크립트를 로드한다. browser.js는 #bwUrl이 있으면 createApp을
   자동 실행하므로, 빈 body에서 로드한 뒤 픽스처를 깐다. */
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

interface RemoteState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
}

interface Harness {
  app: any
  navigateCalls: string[]
  historyCalls: string[]
  stateCalls: number
  remote: RemoteState
  setRemote: (s: RemoteState) => void
  historyOk: boolean
  fetchStateOk: boolean
}

function makeApp(): Harness {
  const api = loadBrowser()
  setupFixture()
  const doc = getDoc()
  const navigateCalls: string[] = []
  const historyCalls: string[] = []
  const stateCalls = { n: 0 }
  const h: Harness = {
    app: null as any,
    navigateCalls,
    historyCalls,
    get stateCalls() {
      return stateCalls.n
    },
    remote: {
      url: 'https://www.naver.com',
      title: 'naver.com',
      canGoBack: false,
      canGoForward: false,
    },
    setRemote(s: RemoteState) {
      h.remote = s
    },
    historyOk: true,
    fetchStateOk: true,
  }
  const app = api.createApp({
    doc,
    storage: new MemoryStorage(),
    liveDeps: {
      navigate: (url: string) => {
        navigateCalls.push(url)
        return Promise.resolve({ status: 200, body: { ok: true, nav: 'ok', navStage: 'ok' } })
      },
      applyViewport: () => Promise.resolve({ status: 200, body: { ok: true, stage: 'ok' } }),
      checkUnlock: () => Promise.resolve({ status: 0, body: null }),
      fetchState: () => {
        stateCalls.n += 1
        if (!h.fetchStateOk) return Promise.resolve({ status: 502, body: null })
        return Promise.resolve({ status: 200, body: { ok: true, ...h.remote } })
      },
      history: (direction: string) => {
        historyCalls.push(direction)
        if (!h.historyOk) return Promise.resolve({ status: 502, body: null })
        return Promise.resolve({ status: 200, body: { ok: true, stage: 'ok' } })
      },
      statePollMs: 2000,
    },
  })
  h.app = app
  return h
}

async function flush(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

function els(): { urlInput: any; backBtn: any; fwdBtn: any } {
  const doc = getDoc()
  return {
    urlInput: doc.getElementById('bwUrl'),
    backBtn: doc.getElementById('bwBackBtn'),
    fwdBtn: doc.getElementById('bwFwdBtn'),
  }
}

describe('browser 원격 상태 연동', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(async () => {
    jest.useRealTimers()
  })

  test('폴링이 본 원격 URL이 주소창에 반영되고, 로컬 기록은 건드리지 않는다', async () => {
    const h = makeApp()
    // 원격에서는 링크를 눌러 뉴스 기사로 이동한 상태 (로컬 기록에는 없다).
    h.setRemote({
      url: 'https://news.naver.com/article/123',
      title: '뉴스 기사',
      canGoBack: true,
      canGoForward: false,
    })
    h.app.go('https://www.naver.com')
    await flush()
    const { urlInput } = els()
    expect(urlInput.value).toBe('https://news.naver.com/article/123')
    const tabs = h.app.getTabs()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].url).toBe('https://news.naver.com/article/123')
    // 로컬 기록에는 원격 이동이 섞이지 않는다 (폴백이 엉키지 않게).
    expect(tabs[0].history).toEqual(['https://www.naver.com'])
    expect(tabs[0].hIndex).toBe(0)
    await h.app.live.endLive()
  })

  test('뒤로/앞으로 버튼이 원격 canGoBack/canGoForward를 따른다 (로컬과 달라도 원격 우선)', async () => {
    const h = makeApp()
    // 로컬 기록은 1개뿐이라 뒤로 불가지만, 원격 기록은 뒤로 갈 수 있다.
    h.setRemote({
      url: 'https://news.naver.com/article/123',
      title: '뉴스 기사',
      canGoBack: true,
      canGoForward: false,
    })
    h.app.go('https://www.naver.com')
    await flush()
    const { backBtn, fwdBtn } = els()
    expect(backBtn.disabled).toBe(false)
    expect(fwdBtn.disabled).toBe(true)
    // 원격 상태가 바뀌면 버튼도 따라 바뀐다.
    h.setRemote({
      url: 'https://www.naver.com',
      title: 'naver.com',
      canGoBack: false,
      canGoForward: true,
    })
    h.app.live.refreshState()
    await flush()
    expect(backBtn.disabled).toBe(true)
    expect(fwdBtn.disabled).toBe(false)
    await h.app.live.endLive()
  })

  test('뒤로 클릭은 원격 history를 먼저 부르고, 성공하면 즉시 상태를 다시 물어 주소를 맞춘다', async () => {
    const h = makeApp()
    h.setRemote({
      url: 'https://news.naver.com/article/123',
      title: '뉴스 기사',
      canGoBack: true,
      canGoForward: false,
    })
    h.app.go('https://www.naver.com')
    await flush()
    expect(h.navigateCalls).toEqual(['https://www.naver.com'])
    // 뒤로 간 뒤의 원격 상태를 미리 정해 둔다.
    h.setRemote({
      url: 'https://www.naver.com',
      title: 'naver.com',
      canGoBack: false,
      canGoForward: true,
    })
    const { urlInput, backBtn, fwdBtn } = els()
    backBtn.click()
    await flush()
    expect(h.historyCalls).toEqual(['back'])
    // 원격 뒤로가기라 로컬 navigate는 나가지 않는다.
    expect(h.navigateCalls).toEqual(['https://www.naver.com'])
    // 성공 후 즉시 폴링해 주소가 바뀐다 (2초를 안 기다린다).
    expect(urlInput.value).toBe('https://www.naver.com')
    expect(backBtn.disabled).toBe(true)
    expect(fwdBtn.disabled).toBe(false)
    await h.app.live.endLive()
  })

  test('앞으로 클릭도 원격 history를 먼저 부른다', async () => {
    const h = makeApp()
    h.setRemote({
      url: 'https://www.naver.com',
      title: 'naver.com',
      canGoBack: false,
      canGoForward: true,
    })
    h.app.go('https://www.naver.com')
    await flush()
    const { fwdBtn } = els()
    expect(fwdBtn.disabled).toBe(false)
    fwdBtn.click()
    await flush()
    expect(h.historyCalls).toEqual(['forward'])
    expect(h.navigateCalls).toEqual(['https://www.naver.com'])
    await h.app.live.endLive()
  })

  test('원격 뒤로가기 실패 시에도 라이브가 켜져 있으면 로컬 폴백을 하지 않는다', async () => {
    const h = makeApp()
    h.app.go('https://www.naver.com')
    await flush()
    h.app.go('https://www.google.com')
    await flush()
    expect(h.navigateCalls).toEqual(['https://www.naver.com', 'https://www.google.com'])
    // 원격은 뒤로 갈 수 있다고 하지만, 원격 이동은 실패한다.
    h.setRemote({
      url: 'https://www.google.com',
      title: 'google.com',
      canGoBack: true,
      canGoForward: false,
    })
    h.app.live.refreshState()
    await flush()
    h.historyOk = false
    const { backBtn } = els()
    expect(backBtn.disabled).toBe(false)
    backBtn.click()
    await flush()
    expect(h.historyCalls).toEqual(['back'])
    // 폴백 없음: 로컬 기록의 이전 주소로 navigate하지 않는다 (낡은
    // 기록으로 가면 엉뚱한 곳에 가고 navigate가 다른 탭을 닫는다).
    expect(h.navigateCalls).toEqual(['https://www.naver.com', 'https://www.google.com'])
    const tabs = h.app.getTabs()
    expect(tabs[0].url).toBe('https://www.google.com')
    expect(tabs[0].hIndex).toBe(1)
    await h.app.live.endLive()
  })

  test('폴링이 실패해 원격 상태를 모르면 버튼이 꺼지고, 뒤로 클릭은 아무것도 하지 않는다', async () => {
    const h = makeApp()
    h.fetchStateOk = false
    h.app.go('https://www.naver.com')
    await flush()
    const { urlInput, backBtn } = els()
    // 폴링 실패라 주소는 로컬 이동 주소 그대로, 뒤로 버튼은 꺼져 있다.
    expect(urlInput.value).toBe('https://www.naver.com')
    expect(backBtn.disabled).toBe(true)
    h.app.go('https://www.google.com')
    await flush()
    // 로컬 기록에 2개가 있어도 원격 상태를 모르므로 버튼은 꺼진 채다.
    expect(backBtn.disabled).toBe(true)
    // disabled 버튼은 클릭 이벤트가 안 나가므로, goBack 가드 자체를
    // 검증하려고 버튼을 강제로 켜고 누른다.
    backBtn.disabled = false
    backBtn.click()
    await flush()
    // 로컬 폴백이 호출되지 않는다: history도 navigate도 나가지 않고,
    // 로컬 기록 인덱스도 그대로다.
    expect(h.historyCalls).toEqual([])
    expect(h.navigateCalls).toEqual(['https://www.naver.com', 'https://www.google.com'])
    const tabs = h.app.getTabs()
    expect(tabs[0].url).toBe('https://www.google.com')
    expect(tabs[0].hIndex).toBe(1)
    await h.app.live.endLive()
  })

  test('라이브가 꺼져 있으면 로컬 기록 기준으로 동작한다 (폴백은 그때만)', async () => {
    const h = makeApp()
    h.fetchStateOk = false
    h.app.go('https://www.naver.com')
    await flush()
    h.app.go('https://www.google.com')
    await flush()
    const { backBtn } = els()
    // 켜져 있을 때는 원격 상태를 몰라 버튼이 꺼져 있다.
    expect(backBtn.disabled).toBe(true)
    await h.app.live.endLive()
    await flush()
    // 꺼지면 로컬 기록 기준으로 버튼이 켜지고, 뒤로 클릭은 로컬 폴백으로 간다.
    expect(backBtn.disabled).toBe(false)
    backBtn.click()
    await flush()
    expect(h.historyCalls).toEqual([])
    expect(h.navigateCalls[h.navigateCalls.length - 1]).toBe('https://www.naver.com')
    const tabs = h.app.getTabs()
    expect(tabs[0].url).toBe('https://www.naver.com')
    expect(tabs[0].hIndex).toBe(0)
  })

  test('폴링 결과는 뷰를 소유한 탭에만 반영된다', async () => {
    const h = makeApp()
    h.setRemote({
      url: 'https://news.naver.com/article/123',
      title: '뉴스 기사',
      canGoBack: true,
      canGoForward: false,
    })
    h.app.go('https://www.naver.com')
    await flush()
    const ownerId = h.app.getTabs()[0].id
    h.app.newTab()
    await flush()
    const { urlInput } = els()
    // 새 탭(주소 없음)을 보고 있는 동안 원격 상태가 바뀌어도 주소창은 비어 있다.
    expect(urlInput.value).toBe('')
    h.setRemote({
      url: 'https://www.google.com',
      title: 'google.com',
      canGoBack: true,
      canGoForward: true,
    })
    h.app.live.refreshState()
    await flush()
    expect(urlInput.value).toBe('')
    // 소유 탭의 URL은 바뀌어 있다.
    const tabs = h.app.getTabs()
    const owner = tabs.find((t: any) => t.id === ownerId)
    expect(owner.url).toBe('https://www.google.com')
    await h.app.live.endLive()
  })

  test('endLive하면 폴링이 멈춘다', async () => {
    const h = makeApp()
    h.app.go('https://www.naver.com')
    await flush()
    expect(h.stateCalls).toBe(1)
    await h.app.live.endLive()
    jest.advanceTimersByTime(10000)
    await flush()
    expect(h.stateCalls).toBe(1)
  })
})
