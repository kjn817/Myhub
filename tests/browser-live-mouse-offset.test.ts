/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 마우스 오프셋 보고·뷰포트 재시도 백오프 — browser-live.js (2026-11-18).
 *
 * 배경: Selkies 클라이언트가 iframe 좌표에 iframe의 화면상 위치를
 * 더해서 보낸다 (영상 3종 분석: 최대화 (0,66)·축소 (339,273)).
 * 프론트가 #bwLiveFrame의 화면상 rect를 사이드카에 보고하면
 * 사이드카가 'm,' 메시지에서 빼서 되돌린다. 창 드래그(이동)는
 * ResizeObserver에 안 잡히므로 500ms 폴링으로 따라간다.
 *
 * 좌표계 주의 (2026-11-18 오후 실측): 브라우저 앱은 데스크톱 창
 * iframe 안에서 돈다. #bwLiveFrame의 직접 rect는 앱 iframe
 * 기준이라 임베드 시 (0,0)이 나온다 — 실제로 17:19 보고가 (0,0)
 * 이라 보정이 안 먹혀 호버가 그대로였던 전례. 보정에 필요한 건
 * 최상위 뷰포트 기준 위치이므로 frameElement 체인을 따라 부모
 * iframe들의 위치를 더한다.
 *
 * 뷰포트 재시도 백오프: 2초 단발 재시도로는 1078×658 축소 적용이
 * 유실된 전례가 있다 (실패가 두 번 겹치면 그 크기는 다시 안 감).
 * 2초·5초·15초 세 번까지 다시 시도하고, 새 크기가 오면 횟수를 리셋한다.
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - enterLive하면 iframe 화면 위치를 즉시 한 번 보고한다.
 * - 위치가 안 바뀌면 폴링 틱이 다시 보고하지 않는다.
 * - 위치가 바뀌면 다음 폴링 틱에 새 위치를 보고한다.
 * - iframe이 숨겨지면(0 크기) 보고하지 않고 마지막 값을 유지한다.
 * - 보고 실패는 기록하지 않아 다음 틱에 다시 시도한다.
 * - endLive하면 오프셋 폴링이 멈춘다.
 * - 임베드 시 frameElement 체인을 더해 최상위 뷰포트 기준 위치를 보고한다.
 * - frameElement 접근이 던지면(크로스오리진) 직접 잰 값으로 폴백한다.
 * - 뷰포트 적용 실패 시 2초·5초·15초 뒤 세 번 재시도하고 멈춘다.
 * - 재시도 중 성공하면 더 이상 재시도하지 않는다.
 * - 새 크기가 오면 재시도 횟수가 리셋돼 새 크기에 3번의 기회가 있다.
 * 카나리아: 보고·폴링·백오프·frameElement 체인을 빼면 해당 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const LIVE_JS = fs.readFileSync(path.join(ROOT, 'public/js/browser-live.js'), 'utf-8')

const getWin = (): any => (globalThis as any).window
const getDoc = (): any => (globalThis as any).document

function stubRect(el: any, rect: { left: number; top: number; width: number; height: number }): void {
  el.getBoundingClientRect = () => ({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  })
}

function setupFixture(): void {
  const doc = getDoc()
  doc.body.innerHTML = `
    <div class="bw-stage" id="bwStage">
      <div class="bw-home" id="bwHome"></div>
      <iframe class="bw-frame" id="bwLiveFrame" title="원격 브라우저" hidden></iframe>
      <div class="bw-notice-card" id="bwNoticeCard" hidden>
        <p id="bwNoticeMsg"></p><button type="button" id="bwNoticeClose">닫기</button>
      </div>
    </div>
  `
  stubRect(doc.getElementById('bwStage'), { left: 0, top: 66, width: 1920, height: 1000 })
  stubRect(doc.getElementById('bwLiveFrame'), { left: 0, top: 66, width: 1920, height: 1000 })
}

function loadLive(): any {
  const win = getWin()
  const doc = getDoc()
  new Function('window', 'document', LIVE_JS)(win, doc)
  return win.MyHubBrowserLive
}

interface OffsetHarness {
  live: any
  offsetCalls: Array<{ x: number; y: number }>
  viewportCalls: Array<{ width: number; height: number }>
}

function makeLive(opts: {
  reportMouseOffsetImpl?: (offset: { x: number; y: number }) => Promise<unknown>
  applyViewportImpl?: (viewport: { width: number; height: number }) => Promise<unknown>
  mouseOffsetPollMs?: number
} = {}): OffsetHarness {
  const offsetCalls: Array<{ x: number; y: number }> = []
  const viewportCalls: Array<{ width: number; height: number }> = []
  const api = loadLive()
  const live = api.createLive({
    doc: getDoc(),
    navigate: () => Promise.resolve({ status: 200, body: { ok: true, nav: 'ok', navStage: 'ok' } }),
    applyViewport: (viewport: { width: number; height: number }) => {
      viewportCalls.push({ ...viewport })
      if (opts.applyViewportImpl) return opts.applyViewportImpl(viewport)
      return Promise.resolve({ status: 200, body: { ok: true, stage: 'ok' } })
    },
    checkUnlock: () => Promise.resolve({ status: 0, body: null }),
    fetchState: () =>
      Promise.resolve({ status: 200, body: { ok: true, url: 'https://example.com', title: 't' } }),
    reportMouseOffset: (offset: { x: number; y: number }) => {
      offsetCalls.push({ ...offset })
      if (opts.reportMouseOffsetImpl) return opts.reportMouseOffsetImpl(offset)
      return Promise.resolve({ status: 200, body: { ok: true, offset } })
    },
    onChange: () => undefined,
    statePollMs: 60000,
    mouseOffsetPollMs: opts.mouseOffsetPollMs ?? 100,
  })
  return { live, offsetCalls, viewportCalls }
}

async function flush(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

async function tick(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms)
  await flush()
}

function mockFrameElement(rect: { left: number; top: number; width: number; height: number }): void {
  const el = getDoc().createElement('iframe')
  stubRect(el, rect)
  Object.defineProperty(getWin(), 'frameElement', { value: el, configurable: true })
}

function mockThrowingFrameElement(): void {
  Object.defineProperty(getWin(), 'frameElement', {
    get() {
      throw new Error('cross-origin')
    },
    configurable: true,
  })
}

function restoreFrameElement(): void {
  // 인스턴스 섀도만 지우면 프로토타입의 원래 동작(null)으로 돌아간다.
  delete (getWin() as any).frameElement
  delete (getWin() as any).parent
}

describe('browser-live 마우스 오프셋 보고', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    setupFixture()
  })
  afterEach(() => {
    restoreFrameElement()
    jest.useRealTimers()
  })

  test('enterLive하면 iframe 화면 위치를 즉시 한 번 보고한다', async () => {
    const { live, offsetCalls } = makeLive()
    await live.enterLive('https://example.com')
    await flush()
    expect(offsetCalls).toEqual([{ x: 0, y: 66 }])
  })

  test('위치가 안 바뀌면 폴링 틱이 다시 보고하지 않는다', async () => {
    const { live, offsetCalls } = makeLive()
    await live.enterLive('https://example.com')
    await flush()
    await tick(1000)
    expect(offsetCalls).toEqual([{ x: 0, y: 66 }])
  })

  test('위치가 바뀌면 다음 폴링 틱에 새 위치를 보고한다', async () => {
    const { live, offsetCalls } = makeLive()
    await live.enterLive('https://example.com')
    await flush()
    stubRect(getDoc().getElementById('bwLiveFrame'), { left: 339, top: 273, width: 1078, height: 658 })
    await tick(100)
    expect(offsetCalls).toEqual([
      { x: 0, y: 66 },
      { x: 339, y: 273 },
    ])
  })

  test('iframe이 숨겨지면(0 크기) 보고하지 않고 마지막 값을 유지한다', async () => {
    const { live, offsetCalls } = makeLive()
    await live.enterLive('https://example.com')
    await flush()
    stubRect(getDoc().getElementById('bwLiveFrame'), { left: 0, top: 0, width: 0, height: 0 })
    await tick(1000)
    expect(offsetCalls).toEqual([{ x: 0, y: 66 }])
  })

  test('보고 실패는 기록하지 않아 다음 틱에 다시 시도하고, 성공하면 멈춘다', async () => {
    let attempts = 0
    const { live, offsetCalls } = makeLive({
      reportMouseOffsetImpl: () => {
        attempts += 1
        if (attempts === 1) return Promise.resolve({ status: 502, body: null })
        return Promise.resolve({ status: 200, body: { ok: true } })
      },
    })
    await live.enterLive('https://example.com')
    await flush()
    expect(offsetCalls).toEqual([{ x: 0, y: 66 }])
    await tick(100)
    expect(offsetCalls).toEqual([
      { x: 0, y: 66 },
      { x: 0, y: 66 },
    ])
    await tick(1000)
    expect(offsetCalls).toHaveLength(2)
  })

  test('endLive하면 오프셋 폴링이 멈춘다', async () => {
    const { live, offsetCalls } = makeLive()
    await live.enterLive('https://example.com')
    await flush()
    await live.endLive()
    stubRect(getDoc().getElementById('bwLiveFrame'), { left: 500, top: 300, width: 1078, height: 658 })
    await tick(5000)
    expect(offsetCalls).toEqual([{ x: 0, y: 66 }])
  })

  test('임베드 시 frameElement를 더해 최상위 뷰포트 기준 위치를 보고한다', async () => {
    // 실제 임베드 상태 재현: 라이브 iframe은 앱 안에서 (0,0),
    // 앱 iframe(창 프레임)은 최상위에서 (0,66) — 합이 보정값이다.
    stubRect(getDoc().getElementById('bwLiveFrame'), { left: 0, top: 0, width: 1920, height: 1000 })
    mockFrameElement({ left: 0, top: 66, width: 1920, height: 1014 })
    const { live, offsetCalls } = makeLive()
    await live.enterLive('https://example.com')
    await flush()
    expect(offsetCalls).toEqual([{ x: 0, y: 66 }])
  })

  test('창을 옮기면 frameElement 위치 변화를 다음 틱에 보고한다', async () => {
    stubRect(getDoc().getElementById('bwLiveFrame'), { left: 0, top: 0, width: 1078, height: 658 })
    mockFrameElement({ left: 0, top: 66, width: 1920, height: 1014 })
    const { live, offsetCalls } = makeLive()
    await live.enterLive('https://example.com')
    await flush()
    expect(offsetCalls).toEqual([{ x: 0, y: 66 }])
    mockFrameElement({ left: 339, top: 273, width: 1078, height: 658 })
    await tick(100)
    expect(offsetCalls).toEqual([
      { x: 0, y: 66 },
      { x: 339, y: 273 },
    ])
  })

  test('frameElement 체인이 두 단이면 두 단을 모두 더한다', async () => {
    stubRect(getDoc().getElementById('bwLiveFrame'), { left: 0, top: 0, width: 1078, height: 658 })
    mockFrameElement({ left: 0, top: 66, width: 1920, height: 1014 })
    const outer = getDoc().createElement('iframe')
    stubRect(outer, { left: 100, top: 50, width: 1920, height: 1080 })
    const fakeParent: any = { frameElement: outer, parent: null }
    fakeParent.parent = fakeParent
    Object.defineProperty(getWin(), 'parent', { value: fakeParent, configurable: true })
    const { live, offsetCalls } = makeLive()
    await live.enterLive('https://example.com')
    await flush()
    expect(offsetCalls).toEqual([{ x: 100, y: 116 }])
  })

  test('frameElement 접근이 던지면 직접 잰 값으로 폴백한다', async () => {
    mockThrowingFrameElement()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { live, offsetCalls } = makeLive()
    try {
      await live.enterLive('https://example.com')
      await flush()
      expect(offsetCalls).toEqual([{ x: 0, y: 66 }])
      expect(warn).toHaveBeenCalledTimes(1)
      await tick(1000)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('browser-live 뷰포트 재시도 백오프', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    setupFixture()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  test('실패 시 2초·5초·15초 뒤 세 번 재시도하고 멈춘다', async () => {
    const { live, viewportCalls } = makeLive({
      applyViewportImpl: () => Promise.resolve({ status: 502, body: null }),
    })
    await live.enterLive()
    await flush()
    expect(viewportCalls).toHaveLength(1)
    await tick(2000)
    expect(viewportCalls).toHaveLength(2)
    await tick(5000)
    expect(viewportCalls).toHaveLength(3)
    await tick(15000)
    expect(viewportCalls).toHaveLength(4)
    await tick(60000)
    expect(viewportCalls).toHaveLength(4)
  })

  test('재시도 중 성공하면 더 이상 재시도하지 않는다', async () => {
    let attempts = 0
    const { live, viewportCalls } = makeLive({
      applyViewportImpl: () => {
        attempts += 1
        if (attempts < 3) return Promise.resolve({ status: 502, body: null })
        return Promise.resolve({ status: 200, body: { ok: true, stage: 'ok' } })
      },
    })
    await live.enterLive()
    await flush()
    await tick(2000)
    await tick(5000)
    await tick(60000)
    expect(viewportCalls).toHaveLength(3)
  })

  test('새 크기가 오면 재시도 횟수가 리셋돼 새 크기에 3번의 기회가 있다', async () => {
    const { live, viewportCalls } = makeLive({
      applyViewportImpl: () => Promise.resolve({ status: 502, body: null }),
    })
    await live.enterLive()
    await flush()
    expect(viewportCalls).toEqual([{ width: 1920, height: 1000 }])
    // 첫 재시도 전에 stage를 축소한다 — 재시도가 새 크기를 보낸다.
    stubRect(getDoc().getElementById('bwStage'), { left: 339, top: 273, width: 1078, height: 658 })
    await tick(2000)
    expect(viewportCalls).toHaveLength(2)
    expect(viewportCalls[1]).toEqual({ width: 1078, height: 658 })
    await tick(2000)
    await tick(5000)
    await tick(15000)
    expect(viewportCalls).toHaveLength(5)
    expect(viewportCalls.slice(1)).toEqual([
      { width: 1078, height: 658 },
      { width: 1078, height: 658 },
      { width: 1078, height: 658 },
      { width: 1078, height: 658 },
    ])
    await tick(60000)
    expect(viewportCalls).toHaveLength(5)
  })
})
