/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 진짜 새로고침 + 화질 메뉴 + 일시 안내 (2026-11-20 브라우저 4단계).
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - 라이브가 켜져 있을 때 새로고침 버튼·메뉴는 /reload를 부르고,
 *   같은 URL 재이동(navigate)은 나가지 않는다.
 * - reload 실패 시 재이동으로 조용히 폴백하지 않고 안내 카드가
 *   뜨고, 라이브 화면은 그대로 보인다 (상태 기계 불변).
 * - 라이브가 꺼져 있을 때는 시작하면서 이동하는 수밖에 없어 go()로 간다.
 * - 일시 안내는 6초 뒤 자동으로 사라지고, 닫기 버튼으로도 닫힌다.
 * - 보기 메뉴에 화질 5종(자동/최고/고/중/저)이 있고, 저장값이 없으면
 *   자동이 체크되며 시작 시 화질 POST를 보내지 않는다 (기본값 유지).
 *   최고화질은 15000이다 (2026-11-20 5단계 — 사이드카 상한도 15000).
 * - 화질 선택은 POST + localStorage 저장되고, 저장값이 있으면
 *   해당 항목이 체크된다.
 * - "여기서 시작" 버튼은 세션 종료가 아니라 화면 이동이라 표기한다
 *   (실제 동작은 소유권 이동 — 원격 세션은 끝나지 않는다).
 * 카나리아: reload가 navigate를 부르거나, 실패 시 안내를 안 띄우거나,
 * 화질 선택이 저장을 안 하면 해당 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const LIVE_JS = fs.readFileSync(path.join(ROOT, 'public/js/browser-live.js'), 'utf-8')
const BROWSER_JS = fs.readFileSync(path.join(ROOT, 'public/js/browser.js'), 'utf-8')
const BROWSER_HTML = fs.readFileSync(path.join(ROOT, 'public/browser.html'), 'utf-8')

const getWin = (): any => (globalThis as any).window
const getDoc = (): any => (globalThis as any).document
const storage = (): Storage => (globalThis as any).window.localStorage

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
  navigateCalls: string[]
  reloadCalls: number
  qualityCalls: unknown[]
  reloadOk: boolean
  qualityOk: boolean
  remote: { url: string; title: string; canGoBack: boolean; canGoForward: boolean }
  setRemote: (s: { url: string; title: string; canGoBack: boolean; canGoForward: boolean }) => void
}

function makeApp(): Harness {
  const api = loadBrowser()
  setupFixture()
  const doc = getDoc()
  const navigateCalls: string[] = []
  const qualityCalls: unknown[] = []
  const reloadCalls = { n: 0 }
  const navPosts: Array<Record<string, any>> = []
  const fakeWin = {
    parent: { postMessage: (payload: Record<string, any>) => navPosts.push(payload) },
    location: { origin: 'https://myhub.test' },
    addEventListener: () => {},
  }
  const h: Harness = {
    app: null as any,
    navigateCalls,
    get reloadCalls() {
      return reloadCalls.n
    },
    qualityCalls,
    reloadOk: true,
    qualityOk: true,
    remote: { url: 'https://www.naver.com', title: 'naver.com', canGoBack: false, canGoForward: false },
    setRemote(s) {
      h.remote = s
    },
  }
  const app = api.createApp({
    doc,
    win: fakeWin,
    storage: new MemoryStorage(),
    liveDeps: {
      navigate: (url: string) => {
        navigateCalls.push(url)
        return Promise.resolve({ status: 200, body: { ok: true, nav: 'ok', navStage: 'ok' } })
      },
      applyViewport: () => Promise.resolve({ status: 200, body: { ok: true, stage: 'ok' } }),
      checkUnlock: () => Promise.resolve({ status: 0, body: null }),
      fetchState: () =>
        Promise.resolve({ status: 200, body: { ok: true, ...h.remote } }),
      history: () => Promise.resolve({ status: 200, body: { ok: true, stage: 'ok' } }),
      reload: () => {
        reloadCalls.n += 1
        if (!h.reloadOk) return Promise.resolve({ status: 502, body: null })
        return Promise.resolve({ status: 200, body: { ok: true, stage: 'ok' } })
      },
      setQuality: (payload: unknown) => {
        qualityCalls.push(payload)
        if (!h.qualityOk) return Promise.resolve({ status: 502, body: null })
        return Promise.resolve({ status: 200, body: { ok: true, mode: 'manual', connections: 1 } })
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

function viewMenuItems(win: any): any[] {
  const menus = win.MyHubMenus as any[]
  const view = menus.find((m: any) => m.label === '보기')
  return view.items()
}

function moveMenuItems(win: any): any[] {
  const menus = win.MyHubMenus as any[]
  const move = menus.find((m: any) => m.label === '이동')
  return move.items()
}

describe('브라우저 4단계 — 새로고침·화질·일시 안내', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    storage().clear()
  })
  afterEach(async () => {
    jest.useRealTimers()
  })

  test('라이브가 켜져 있을 때 새로고침 버튼은 /reload를 부르고 navigate는 안 나간다', async () => {
    const h = makeApp()
    h.app.go('https://www.naver.com')
    await flush()
    expect(h.navigateCalls).toEqual(['https://www.naver.com'])
    const reloadBtn = getDoc().getElementById('bwReloadBtn')
    expect(reloadBtn.disabled).toBe(false)
    reloadBtn.click()
    await flush()
    expect(h.reloadCalls).toBe(1)
    expect(h.navigateCalls).toEqual(['https://www.naver.com'])
    await h.app.live.endLive()
  })

  test('메뉴 새로고침도 /reload를 부른다', async () => {
    const h = makeApp()
    h.app.go('https://www.naver.com')
    await flush()
    const item = moveMenuItems(getWin()).find((i: any) => i.label === '새로고침')
    expect(item).toBeDefined()
    expect(item.disabled).toBe(false)
    item.run()
    await flush()
    expect(h.reloadCalls).toBe(1)
    expect(h.navigateCalls).toEqual(['https://www.naver.com'])
    await h.app.live.endLive()
  })

  test('reload 실패 시 재이동 폴백 없이 안내 카드가 뜨고 라이브 화면은 그대로다', async () => {
    const h = makeApp()
    h.app.go('https://www.naver.com')
    await flush()
    h.reloadOk = false
    const doc = getDoc()
    doc.getElementById('bwReloadBtn').click()
    await flush()
    expect(h.reloadCalls).toBe(1)
    // 조용한 폴백 금지: navigate가 추가로 나가면 안 된다.
    expect(h.navigateCalls).toEqual(['https://www.naver.com'])
    const card = doc.getElementById('bwNoticeCard')
    const msg = doc.getElementById('bwNoticeMsg')
    expect(card.hidden).toBe(false)
    expect(msg.textContent).toContain('새로고침하지 못했어요')
    // 상태 기계는 'on' 그대로 — iframe이 숨겨지면 안 된다.
    expect(h.app.live.state()).toBe('on')
    expect(doc.getElementById('bwLiveFrame').hidden).toBe(false)
    await h.app.live.endLive()
  })

  test('라이브가 꺼져 있을 때 새로고침은 시작하면서 이동한다 (go 경로)', async () => {
    const h = makeApp()
    // 라이브를 켜지 않고 주소만 있는 탭: go()로 주소를 넣은 뒤 endLive로 끈다.
    h.app.go('https://www.naver.com')
    await flush()
    await h.app.live.endLive()
    await flush()
    expect(h.app.live.state()).toBe('off')
    getDoc().getElementById('bwReloadBtn').click()
    await flush()
    expect(h.reloadCalls).toBe(0)
    expect(h.navigateCalls).toEqual(['https://www.naver.com', 'https://www.naver.com'])
    await h.app.live.endLive()
  })

  test('일시 안내는 6초 뒤 자동으로 사라진다', async () => {
    const h = makeApp()
    h.app.go('https://www.naver.com')
    await flush()
    h.reloadOk = false
    getDoc().getElementById('bwReloadBtn').click()
    await flush()
    const card = getDoc().getElementById('bwNoticeCard')
    expect(card.hidden).toBe(false)
    jest.advanceTimersByTime(6000)
    await flush()
    expect(card.hidden).toBe(true)
    expect(h.app.live.state()).toBe('on')
    await h.app.live.endLive()
  })

  test('일시 안내는 닫기 버튼으로 닫히고 라이브는 그대로 켜져 있다', async () => {
    const h = makeApp()
    h.app.go('https://www.naver.com')
    await flush()
    h.reloadOk = false
    getDoc().getElementById('bwReloadBtn').click()
    await flush()
    const doc = getDoc()
    expect(doc.getElementById('bwNoticeCard').hidden).toBe(false)
    doc.getElementById('bwNoticeClose').click()
    expect(doc.getElementById('bwNoticeCard').hidden).toBe(true)
    expect(h.app.live.state()).toBe('on')
    await h.app.live.endLive()
  })

  test('보기 메뉴에 화질 5종이 있고, 저장값이 없으면 자동이 체크된다', async () => {
    const h = makeApp()
    const items = viewMenuItems(getWin())
    const quality = items.filter((i: any) => typeof i.label === 'string' && i.label.startsWith('화질:'))
    expect(quality.map((i: any) => i.label)).toEqual([
      '화질: 자동',
      '화질: 최고화질',
      '화질: 고화질',
      '화질: 중화질',
      '화질: 저화질',
    ])
    expect(quality.find((i: any) => i.label === '화질: 자동').checked).toBe(true)
    expect(quality.filter((i: any) => i.checked)).toHaveLength(1)
    // 저장값이 없으면 시작 시 화질 POST를 보내지 않는다 (기본값 유지).
    h.app.go('https://www.naver.com')
    await flush()
    expect(h.qualityCalls).toHaveLength(0)
    await h.app.live.endLive()
  })

  test('화질 고화질 선택은 12000을 보내고 localStorage에 저장한다', async () => {
    const h = makeApp()
    h.app.go('https://www.naver.com')
    await flush()
    const item = viewMenuItems(getWin()).find((i: any) => i.label === '화질: 고화질')
    item.run()
    await flush()
    expect(h.qualityCalls).toEqual([{ bitrate: 12000 }])
    expect(storage().getItem('myhub-bw-quality')).toBe('12000')
    // 다시 메뉴를 열면 고화질이 체크된다.
    const again = viewMenuItems(getWin()).find((i: any) => i.label === '화질: 고화질')
    expect(again.checked).toBe(true)
    await h.app.live.endLive()
  })

  test('화질 최고화질 선택은 15000을 보내고 localStorage에 저장한다 (5단계)', async () => {
    const h = makeApp()
    h.app.go('https://www.naver.com')
    await flush()
    const item = viewMenuItems(getWin()).find((i: any) => i.label === '화질: 최고화질')
    item.run()
    await flush()
    expect(h.qualityCalls).toEqual([{ bitrate: 15000 }])
    expect(storage().getItem('myhub-bw-quality')).toBe('15000')
    // 다시 메뉴를 열면 최고화질이 체크된다.
    const again = viewMenuItems(getWin()).find((i: any) => i.label === '화질: 최고화질')
    expect(again.checked).toBe(true)
    await h.app.live.endLive()
  })

  test('저장값 8000이면 중화질이 체크된다', async () => {
    storage().setItem('myhub-bw-quality', '8000')
    const h = makeApp()
    const items = viewMenuItems(getWin())
    const checked = items.filter((i: any) => i.checked && typeof i.label === 'string' && i.label.startsWith('화질:'))
    expect(checked.map((i: any) => i.label)).toEqual(['화질: 중화질'])
    await h.app.live.endLive()
  })

  test('화질 자동 선택은 mode:auto를 보내고 저장값을 auto로 한다', async () => {
    storage().setItem('myhub-bw-quality', '8000')
    const h = makeApp()
    h.app.go('https://www.naver.com')
    await flush()
    // 시작 시 저장된 8000 재적용 POST가 나가므로 비운 뒤 측정한다.
    h.qualityCalls.length = 0
    const item = viewMenuItems(getWin()).find((i: any) => i.label === '화질: 자동')
    item.run()
    await flush()
    expect(h.qualityCalls).toEqual([{ mode: 'auto' }])
    expect(storage().getItem('myhub-bw-quality')).toBe('auto')
    await h.app.live.endLive()
  })

  test('화질 전환 실패 시 안내 카드가 뜬다', async () => {
    const h = makeApp()
    h.app.go('https://www.naver.com')
    await flush()
    h.qualityOk = false
    const item = viewMenuItems(getWin()).find((i: any) => i.label === '화질: 저화질')
    item.run()
    await flush()
    const doc = getDoc()
    expect(doc.getElementById('bwNoticeCard').hidden).toBe(false)
    expect(doc.getElementById('bwNoticeMsg').textContent).toContain('화질을 바꾸지 못했어요')
    expect(storage().getItem('myhub-bw-quality')).toBeNull()
    await h.app.live.endLive()
  })

  test('"여기서 시작" 버튼은 세션 종료가 아니라 화면 이동이라 표기한다', () => {
    expect(BROWSER_HTML).toContain('여기서 시작 (화면이 여기로 이동)')
    expect(BROWSER_HTML).not.toContain('실행 중인 세션 종료')
  })
})
