/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 원격 브라우저 뷰포트 측정 — hidden iframe 회귀 (2026-11-12)
 *
 * 사용자 실화면 지적: 최대화한 브라우저 창에서 네이버가 1.5배쯤 확대돼
 * 양쪽이 잘려 보인다. 100%면 일반 브라우저처럼 보여야 한다.
 * 원인: enterLive()가 뷰포트를 #bwLiveFrame 자기 자신에서 재는데, 시작
 * 중에는 iframe이 hidden(display:none)이라 rect가 항상 0x0이다. 그래서
 * 뷰포트가 서버에 한 번도 전달되지 않았고, 원격은 기본 1280x720으로 뜬
 * 채 최대화 iframe에 맞춰 확대돼 보였다. 2026-11-12에 넣은 "iframe 크기
 * 전송" 기능은 처음부터 동작하지 않은 셈이다.
 * 수정: iframe이 꽉 채우는 .bw-stage(부모, 항상 보임) 크기를 잰다.
 * (2026-11-14: 세션 발급 폐기 — 뷰포트는 POST /api/browse/navigate에
 * 실리고, iframe src는 /api/browse/view/로 직접 건다.)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - iframe이 hidden(0x0)이어도 stage 크기가 navigate에 뷰포트로 전달된다.
 * - stage 크기를 못 재면 iframe 자기 rect로 폴백한다.
 * - 둘 다 0x0이면 뷰포트 없이 이동한다 (서버 기본값).
 * - enterLive는 iframe src를 /api/browse/view/로 걸고, 이미 켜진
 *   상태의 enterLive는 이동만 지시한다 (src 재설정 없음).
 * 카나리아: 이 테스트는 수정 전 코드에서 실패한다 (iframe만 재서 null).
 *
 * (2026-11-14: 하단 "원격 브라우저" 필 제거 — 시간 제한 세션 시절의
 * 잔재. 오라클 서버는 상시 가동이라 종료 버튼이 서버의 뭘 끄는 게
 * 아니고 화면만 닫는 동작이라 새 탭으로 대체 가능하고, 사파리에도
 * 없는 UI다. 필·경과 시간·종료 버튼은 browser.html·browser-live.js·
 * browser.js·browser.css 어디에도 없어야 한다 — 아래 '필 부재' 테스트가
 * 실제 소스를 읽어 단언한다. 카나리아: 필을 다시 넣으면 실패한다.)
 *
 * (2026-11-15: 세션 복원 뒤 절반 크기 — Chromium 재시작 후 세션 복원으로
 * 네이버가 떠 있으면 navigate가 한 번도 나가지 않아 override가 적용되지
 * 않고, 원격이 X 디스플레이 전체(레티나 기기 픽셀 2940) 크기로 렌더링돼
 * 맥 브라우저(1470)의 절반 크기로 보였다. 수정: url 없는 진입 때도
 * POST /api/browse/viewport로 뷰포트를 맞추고, stage 리사이즈는
 * ResizeObserver로 다시 맞춘다. 실패 시 2초 뒤 한 번만 재시도한다.
 * 카나리아: 진입 적용·관찰자 연결·재시도 상한을 빼면 해당 테스트가
 * 실패한다.)
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const LIVE_JS = fs.readFileSync(path.join(ROOT, 'public/js/browser-live.js'), 'utf-8')
const BROWSER_HTML = fs.readFileSync(path.join(ROOT, 'public/browser.html'), 'utf-8')
const BROWSER_JS = fs.readFileSync(path.join(ROOT, 'public/js/browser.js'), 'utf-8')
const BROWSER_CSS = fs.readFileSync(path.join(ROOT, 'public/css/browser.css'), 'utf-8')

const getWin = (): any => (globalThis as any).window
const getDoc = (): any => (globalThis as any).document

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

function setupFixture(stageSize: { w: number; h: number }, frameSize: { w: number; h: number }): void {
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
  stubRect(doc.getElementById('bwStage'), stageSize.w, stageSize.h)
  stubRect(doc.getElementById('bwLiveFrame'), frameSize.w, frameSize.h)
}

function loadLive(): any {
  const win = getWin()
  const doc = getDoc()
  new Function('window', 'document', LIVE_JS)(win, doc)
  return win.MyHubBrowserLive
}

function makeLive(
  navigateImpl?: (url: string, viewport: unknown) => Promise<unknown>,
  applyViewportImpl?: (viewport: unknown) => Promise<unknown>,
) {
  const calls: Array<{ url: string; viewport: unknown }> = []
  const vpCalls: Array<{ viewport: unknown }> = []
  const api = loadLive()
  const live = api.createLive({
    doc: getDoc(),
    navigate: (url: string, viewport: unknown) => {
      calls.push({ url, viewport })
      if (navigateImpl) return navigateImpl(url, viewport)
      return Promise.resolve({ status: 200, body: { ok: true, nav: 'ok', navStage: 'ok' } })
    },
    applyViewport: (viewport: unknown) => {
      vpCalls.push({ viewport })
      if (applyViewportImpl) return applyViewportImpl(viewport)
      return Promise.resolve({ status: 200, body: { ok: true, stage: 'ok' } })
    },
    onChange: () => undefined,
  })
  return { live, calls, vpCalls }
}

/* 가짜 ResizeObserver: triggerAll()로 관찰 콜백을 손수 불린다.
   disconnect하면 인스턴스 목록에서 빠져 이후 트리거가 닿지 않는다. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  static triggerAll(): void {
    for (const inst of [...FakeResizeObserver.instances]) inst.cb()
  }
  private cb: () => void
  observed: unknown = null
  constructor(cb: () => void) {
    this.cb = cb
    FakeResizeObserver.instances.push(this)
  }
  observe(el: unknown): void {
    this.observed = el
  }
  disconnect(): void {
    const i = FakeResizeObserver.instances.indexOf(this)
    if (i >= 0) FakeResizeObserver.instances.splice(i, 1)
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('browser-live viewport 측정', () => {
  test('iframe이 hidden(0x0)이어도 stage 크기를 뷰포트로 보낸다', async () => {
    setupFixture({ w: 1920, h: 1000 }, { w: 0, h: 0 })
    const { live, calls } = makeLive()
    const started = await live.enterLive('https://www.naver.com')
    expect(started).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://www.naver.com')
    expect(calls[0].viewport).toEqual({ width: 1920, height: 1000 })
    expect(getDoc().getElementById('bwLiveFrame').getAttribute('src')).toBe('/api/browse/view/')
    live.endLive()
  })

  test('stage 크기를 못 재면 iframe rect로 폴백한다', async () => {
    setupFixture({ w: 0, h: 0 }, { w: 1280, h: 720 })
    const { live, calls } = makeLive()
    const started = await live.enterLive('https://www.naver.com')
    expect(started).toBe(true)
    expect(calls[0].viewport).toEqual({ width: 1280, height: 720 })
    live.endLive()
  })

  test('둘 다 0x0이면 뷰포트 없이 이동한다', async () => {
    setupFixture({ w: 0, h: 0 }, { w: 0, h: 0 })
    const { live, calls } = makeLive()
    const started = await live.enterLive('https://www.naver.com')
    expect(started).toBe(true)
    expect(calls[0].viewport).toBeNull()
    live.endLive()
  })
})

describe('browser-live enterLive 상태', () => {
  test('이미 켜진 상태의 enterLive는 이동만 지시하고 src를 다시 건드리지 않는다', async () => {
    setupFixture({ w: 1920, h: 1000 }, { w: 0, h: 0 })
    const { live, calls } = makeLive()
    const frame = getDoc().getElementById('bwLiveFrame')
    await live.enterLive('https://www.naver.com')
    expect(frame.getAttribute('src')).toBe('/api/browse/view/')
    const moved = await live.enterLive('https://example.com')
    expect(moved).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[1].url).toBe('https://example.com')
    expect(frame.getAttribute('src')).toBe('/api/browse/view/')
    expect(live.state()).toBe('on')
    live.endLive()
  })

  test('url 없이 enterLive하면 뷰만 켜고 navigate를 부르지 않는다', async () => {
    setupFixture({ w: 1920, h: 1000 }, { w: 0, h: 0 })
    const { live, calls } = makeLive()
    const started = await live.enterLive(null)
    expect(started).toBe(true)
    expect(calls).toHaveLength(0)
    expect(live.state()).toBe('on')
    live.endLive()
  })

  test('navigate 503이면 뷰를 끄고 안내 상태가 된다', async () => {
    setupFixture({ w: 1920, h: 1000 }, { w: 0, h: 0 })
    const { live } = makeLive(() => Promise.resolve({ status: 503, body: { ok: false } }))
    const started = await live.enterLive('https://www.naver.com')
    expect(started).toBe(false)
    expect(live.state()).toBe('notice')
    expect(getDoc().getElementById('bwLiveFrame').getAttribute('src')).toBeNull()
    expect(getDoc().getElementById('bwNoticeMsg').textContent).toContain('설정되지 않았어요')
    live.dismissNotice()
    expect(live.state()).toBe('off')
  })

  test('navigate 400이면 뷰는 켜진 채 두고 false만 돌려준다', async () => {
    setupFixture({ w: 1920, h: 1000 }, { w: 0, h: 0 })
    const { live } = makeLive(() => Promise.resolve({ status: 400, body: { ok: false } }))
    const started = await live.enterLive('https://www.naver.com')
    expect(started).toBe(false)
    expect(live.state()).toBe('on')
    expect(getDoc().getElementById('bwLiveFrame').getAttribute('src')).toBe('/api/browse/view/')
    live.endLive()
  })

  test('endLive는 src를 지우고 off가 된다', async () => {
    setupFixture({ w: 1920, h: 1000 }, { w: 0, h: 0 })
    const { live } = makeLive()
    await live.enterLive('https://www.naver.com')
    live.endLive()
    expect(live.state()).toBe('off')
    expect(getDoc().getElementById('bwLiveFrame').getAttribute('src')).toBeNull()
  })
})

describe('browser-live viewport 적용 — 이동 없는 진입·리사이즈 (2026-11-15 절반 크기 수정)', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    FakeResizeObserver.instances = []
    ;(getWin() as any).ResizeObserver = FakeResizeObserver
  })
  afterEach(() => {
    jest.useRealTimers()
    FakeResizeObserver.instances = []
    delete (getWin() as any).ResizeObserver
  })

  test('url 없이 enterLive하면 navigate 대신 applyViewport에 stage 크기를 보낸다', async () => {
    setupFixture({ w: 1920, h: 1000 }, { w: 0, h: 0 })
    const { live, calls, vpCalls } = makeLive()
    await live.enterLive()
    await flush()
    expect(calls).toEqual([])
    expect(vpCalls).toEqual([{ viewport: { width: 1920, height: 1000 } }])
  })

  test('리사이즈하면 새 크기로 뷰포트를 다시 맞춘다', async () => {
    setupFixture({ w: 1920, h: 1000 }, { w: 0, h: 0 })
    const { live, vpCalls } = makeLive()
    await live.enterLive()
    await flush()
    expect(vpCalls).toHaveLength(1)
    stubRect(getDoc().getElementById('bwStage'), 1470, 850)
    FakeResizeObserver.triggerAll()
    jest.advanceTimersByTime(300)
    await flush()
    expect(vpCalls).toHaveLength(2)
    expect(vpCalls[1]).toEqual({ viewport: { width: 1470, height: 850 } })
  })

  test('같은 크기로 다시 불려도 뷰포트를 다시 보내지 않는다', async () => {
    setupFixture({ w: 1920, h: 1000 }, { w: 0, h: 0 })
    const { live, vpCalls } = makeLive()
    await live.enterLive()
    await flush()
    expect(vpCalls).toHaveLength(1)
    FakeResizeObserver.triggerAll()
    jest.advanceTimersByTime(300)
    await flush()
    expect(vpCalls).toHaveLength(1)
  })

  test('endLive 뒤에는 리사이즈가 와도 뷰포트를 보내지 않는다', async () => {
    setupFixture({ w: 1920, h: 1000 }, { w: 0, h: 0 })
    const { live, vpCalls } = makeLive()
    await live.enterLive()
    await flush()
    expect(vpCalls).toHaveLength(1)
    await live.endLive()
    stubRect(getDoc().getElementById('bwStage'), 1470, 850)
    FakeResizeObserver.triggerAll()
    jest.advanceTimersByTime(300)
    await flush()
    expect(vpCalls).toHaveLength(1)
  })

  test('뷰포트 적용이 실패하면 2초 뒤 한 번 다시 시도하고 성공하면 그만둔다', async () => {
    setupFixture({ w: 1920, h: 1000 }, { w: 0, h: 0 })
    let n = 0
    const { live, vpCalls } = makeLive(undefined, () => {
      n += 1
      return Promise.resolve(
        n === 1 ? { status: 502, body: null } : { status: 200, body: { ok: true, stage: 'ok' } }
      )
    })
    await live.enterLive()
    await flush()
    expect(vpCalls).toHaveLength(1)
    jest.advanceTimersByTime(2000)
    await flush()
    expect(vpCalls).toHaveLength(2)
    jest.advanceTimersByTime(5000)
    await flush()
    expect(vpCalls).toHaveLength(2)
  })

  test('계속 실패해도 재시도는 세 번뿐이다 (2026-11-18 백오프, 무한 재시도 없음)', async () => {
    setupFixture({ w: 1920, h: 1000 }, { w: 0, h: 0 })
    const { live, vpCalls } = makeLive(
      undefined,
      () => Promise.resolve({ status: 502, body: null }),
    )
    await live.enterLive()
    await flush()
    expect(vpCalls).toHaveLength(1)
    jest.advanceTimersByTime(2000)
    await flush()
    expect(vpCalls).toHaveLength(2)
    jest.advanceTimersByTime(5000)
    await flush()
    expect(vpCalls).toHaveLength(3)
    jest.advanceTimersByTime(15000)
    await flush()
    expect(vpCalls).toHaveLength(4)
    jest.advanceTimersByTime(60000)
    await flush()
    expect(vpCalls).toHaveLength(4)
  })

  test('시간이 지나도 같은 크기를 다시 보내지 않는다 (2026-11-17 P1 주기 재적용 폐지)', async () => {
    // 옛 10초 주기 재적용은 사이드카 영구 CDP가 새 탭에도 뷰포트를
    // 적용하므로 불필요해 폐지됐다 — 다시 넣으면 이 테스트가 실패한다.
    // 뷰포트는 진입·리사이즈 때만 나가고, 시간만으로는 안 나간다.
    setupFixture({ w: 1920, h: 1000 }, { w: 0, h: 0 })
    const { live, vpCalls } = makeLive()
    await live.enterLive()
    await flush()
    expect(vpCalls).toHaveLength(1)
    jest.advanceTimersByTime(30000)
    await flush()
    expect(vpCalls).toHaveLength(1)
    await live.endLive()
  })

  test('리사이즈 보고가 유실돼도 상태 폴링이 새 크기를 다시 보낸다 (2026-11-19 정합)', async () => {
    // 새로고침 직후 최대화 때 1018×765 override에 머물러 화면이 절반만
    // 보이던 실화면 전례: 리사이즈 관찰자가 안 불리면(혹은 보고가
    // 유실되면) 복구 경로가 없었다. 상태 폴링(2초)이 매번 재서
    // 적용된 크기와 다르면 다시 보낸다.
    // 카나리아: 정합 호출을 빼면 두 번째 호출이 없어 실패한다.
    setupFixture({ w: 1018, h: 765 }, { w: 0, h: 0 })
    const { live, vpCalls } = makeLive()
    await live.enterLive()
    await flush()
    expect(vpCalls).toEqual([{ viewport: { width: 1018, height: 765 } }])
    // 관찰자를 일부러 안 불린다 — 최대화가 관찰자에 안 잡힌 경우.
    stubRect(getDoc().getElementById('bwStage'), 1920, 1014)
    jest.advanceTimersByTime(2000)
    await flush()
    expect(vpCalls).toHaveLength(2)
    expect(vpCalls[1]).toEqual({ viewport: { width: 1920, height: 1014 } })
    // 한 번 맞혀지면 이후 폴링은 요청을 안 보낸다.
    jest.advanceTimersByTime(30000)
    await flush()
    expect(vpCalls).toHaveLength(2)
    await live.endLive()
  })

  test('적용 실패 뒤 재시도가 끝나도 상태 폴링이 계속 다시 보내 결국 맞춘다 (2026-11-19 정합)', async () => {
    // 리사이즈 보고가 실패하고 2초·5초·15초 재시도까지 다 떨어지면
    // 그 크기는 다시 안 가는 게 옛 동작이었다 — 상태 폴링 정합이
    // 2초마다 다시 보내 서버가 살아나면 맞추고, 맞혀지면 그만둔다.
    setupFixture({ w: 1018, h: 765 }, { w: 0, h: 0 })
    let n1920 = 0
    const { live, vpCalls } = makeLive(undefined, (viewport: any) => {
      if (viewport && viewport.width === 1920) {
        n1920 += 1
        if (n1920 <= 3) return Promise.resolve({ status: 502, body: null })
      }
      return Promise.resolve({ status: 200, body: { ok: true, stage: 'ok' } })
    })
    await live.enterLive()
    await flush()
    expect(vpCalls).toEqual([{ viewport: { width: 1018, height: 765 } }])
    stubRect(getDoc().getElementById('bwStage'), 1920, 1014)
    FakeResizeObserver.triggerAll()
    jest.advanceTimersByTime(300)
    await flush()
    // 관찰자 보고(실패) 뒤 재시도·폴링이 이어진다 — 3번 실패 뒤
    // 네 번째 시도에서 성공해 맞혀진다.
    jest.advanceTimersByTime(10000)
    await flush()
    expect(n1920).toBeGreaterThanOrEqual(4)
    expect(vpCalls[vpCalls.length - 1]).toEqual({ viewport: { width: 1920, height: 1014 } })
    const settled = vpCalls.length
    jest.advanceTimersByTime(30000)
    await flush()
    expect(vpCalls).toHaveLength(settled)
    await live.endLive()
  })
})

describe('browser-live 주기 재적용 부재 (2026-11-17 P1 폐지)', () => {
  // 10초 주기 재적용을 다시 넣으면 실패한다: 실제 소스에 식별자가
  // 없어야 하고, setInterval은 상태 폴링(2초)과 마우스 오프셋 폴링
  // (2026-11-18, 창 위치 추적 — 뷰포트 재적용이 아니다)만 남아야 한다.
  test('browser-live.js에 주기 재적용 식별자가 없다', () => {
    for (const id of [
      'viewportReapplyMs',
      'viewportReapplyTimer',
      'viewportReapplying',
      'startViewportReapply',
      'stopViewportReapply',
      'reapplyViewportOnce',
    ]) {
      expect(LIVE_JS).not.toContain(id)
    }
    expect(LIVE_JS.match(/setInterval\(/g) ?? []).toHaveLength(2)
    expect(LIVE_JS).toContain('setInterval(pollStateOnce, statePollMs)')
    expect(LIVE_JS).toContain('setInterval(reportMouseOffsetNow, mouseOffsetPollMs)')
  })
})

describe('browser-live 필 부재 (2026-11-14 제거)', () => {
  // 필을 다시 넣으면 실패한다: 실제 소스 파일에 식별자가 없어야 한다.
  const PILL_IDS = ['bwPill', 'bwLiveMsg', 'bwLiveTime', 'bwLiveEnd']
  test('browser.html에 필 요소가 없다', () => {
    for (const id of PILL_IDS) {
      expect(BROWSER_HTML).not.toContain(id)
    }
    expect(BROWSER_HTML).not.toContain('bw-pill')
  })

  test('browser-live.js에 필 참조가 없다', () => {
    for (const id of [...PILL_IDS, 'liveMsg', 'liveTime', 'liveEndBtn', 'setLiveTime']) {
      expect(LIVE_JS).not.toContain(id)
    }
    // endLive API는 남아 있다 (탭 닫기·전환 시 browser.js가 호출한다).
    expect(LIVE_JS).toContain('function endLive()')
    expect(LIVE_JS).toContain('endLive: endLive')
  })

  test('browser.js·browser.css에 필 참조가 없다', () => {
    expect(BROWSER_JS).not.toContain('bwPill')
    expect(BROWSER_JS).not.toContain('pillEl')
    expect(BROWSER_CSS).not.toContain('.bw-pill')
  })

  test('라이브가 켜진 상태에도 필·종료 버튼이 DOM에 없다', async () => {
    setupFixture({ w: 1920, h: 1000 }, { w: 0, h: 0 })
    const { live } = makeLive()
    await live.enterLive('https://www.naver.com')
    expect(live.state()).toBe('on')
    const doc = getDoc()
    for (const id of PILL_IDS) {
      expect(doc.getElementById(id)).toBeNull()
    }
    expect(doc.querySelector('.bw-pill')).toBeNull()
    // 종료 버튼 없이도 endLive API로는 끌 수 있다.
    live.endLive()
    expect(live.state()).toBe('off')
  })
})
