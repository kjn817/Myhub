/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 원격 브라우저 상태 폴링·뒤로/앞으로 — browser-live.js (2026-11-15 밤).
 *
 * 배경: 셸 로컬 기록만 보던 주소창·뒤로가기는 원격 내 링크 이동을
 * 몰라 주소가 naver.com에 고정되고 뒤로가기가 안 됐다. 정식 수정은
 * CDP 상태 폴링: 라이브가 켜져 있는 동안 GET /api/browse/state를
 * 2초마다 물어 onState로 주인에게 알리고, 뒤로/앞으로 이동은
 * POST /api/browse/back|forward로 원격 기록에 지시한다.
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - enterLive하면 즉시 한 번 + 주기적으로 fetchState를 부르고,
 *   받은 상태를 onState에 그대로 전달한다.
 * - endLive하면 폴링이 멈춘다 (타이머가 더 이상 fetchState를 안 부른다).
 * - 탭이 hidden이면 폴링을 쉰다 (백그라운드 폴링 낭비 방지).
 * - 요청이 진행 중이면 다음 틱이 겹쳐서 부르지 않는다.
 * - navigate 503(notice 전환)에서도 폴링이 멈춘다.
 * - goBack/goForward는 history('back'|'forward')를 부르고 성공 여부를
 *   돌려주며, 꺼져 있으면 호출 없이 false다.
 * - refreshState는 즉시 한 번 폴링한다.
 * - fetch 타임아웃 (2026-11-16 QA 1차): 기본 fetchState/history는
 *   10초 AbortController 타임아웃을 걸어, 서버가 응답 없이 걸리면
 *   {status: 0}으로 정리돼 statePolling이 풀리고 다음 폴링이 돈다.
 *   타임아웃이 없으면 폴링이 영원히 걸려 주소가 안 바뀐다.
 *   (QA 4차: 뷰포트 적용도 같은 타임아웃 — 없으면 한 번의 정체로
 *   적용이 영원히 멈춘다.)
 * - 뷰포트 주기 재적용 폐지 (2026-11-17 P1): 10초마다 같은 크기라도
 *   applyViewport를 다시 부르던 QA 2차 메커니즘은 사이드카 영구 CDP가
 *   새 탭에도 뷰포트를 즉시 적용하므로 불필요해 폐지됐다. 시간이
 *   지나도 applyViewport가 다시 나가지 않는다 (진입·리사이즈 때만).
 * 카나리아: 폴링 시작·정지·hidden 일시정지를 빼면 해당 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const LIVE_JS = fs.readFileSync(path.join(ROOT, 'public/js/browser-live.js'), 'utf-8')

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
  stubRect(doc.getElementById('bwStage'), 1920, 1000)
  stubRect(doc.getElementById('bwLiveFrame'), 0, 0)
}

function loadLive(): any {
  const win = getWin()
  const doc = getDoc()
  new Function('window', 'document', LIVE_JS)(win, doc)
  return win.MyHubBrowserLive
}

interface LiveHarness {
  live: any
  stateCalls: number
  states: Array<Record<string, unknown>>
  historyCalls: string[]
  viewportCalls: number
}

function makeLive(opts: {
  fetchStateImpl?: () => Promise<unknown>
  historyImpl?: (direction: string) => Promise<unknown>
  navigateImpl?: (url: string, viewport: unknown) => Promise<unknown>
  applyViewportImpl?: (viewport: unknown) => Promise<unknown>
  statePollMs?: number
} = {}): LiveHarness {
  const stateCalls = { n: 0 }
  const viewportCalls = { n: 0 }
  const states: Array<Record<string, unknown>> = []
  const historyCalls: string[] = []
  const api = loadLive()
  const live = api.createLive({
    doc: getDoc(),
    navigate: (url: string, viewport: unknown) => {
      if (opts.navigateImpl) return opts.navigateImpl(url, viewport)
      return Promise.resolve({ status: 200, body: { ok: true, nav: 'ok', navStage: 'ok' } })
    },
    applyViewport: (viewport: unknown) => {
      viewportCalls.n += 1
      if (opts.applyViewportImpl) return opts.applyViewportImpl(viewport)
      return Promise.resolve({ status: 200, body: { ok: true, stage: 'ok' } })
    },
    checkUnlock: () => Promise.resolve({ status: 0, body: null }),
    fetchState: () => {
      stateCalls.n += 1
      if (opts.fetchStateImpl) return opts.fetchStateImpl()
      return Promise.resolve({
        status: 200,
        body: {
          ok: true,
          url: 'https://news.naver.com/article/123',
          title: '뉴스 기사',
          canGoBack: true,
          canGoForward: false,
        },
      })
    },
    history: (direction: string) => {
      historyCalls.push(direction)
      if (opts.historyImpl) return opts.historyImpl(direction)
      return Promise.resolve({ status: 200, body: { ok: true, stage: 'ok' } })
    },
    onState: (body: Record<string, unknown>) => {
      states.push(body)
    },
    onChange: () => undefined,
    statePollMs: opts.statePollMs ?? 2000,
  })
  return {
    live,
    get stateCalls() {
      return stateCalls.n
    },
    get viewportCalls() {
      return viewportCalls.n
    },
    states,
    historyCalls,
  }
}

async function flush(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe('browser-live 상태 폴링', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
    // hidden 오버라이드가 있으면 복원한다.
    const doc = getDoc()
    const desc = Object.getOwnPropertyDescriptor(doc, 'hidden')
    if (desc) delete (doc as any).hidden
  })

  test('enterLive하면 즉시 한 번 + 주기적으로 상태를 묻고 onState에 전달한다', async () => {
    setupFixture()
    const h = makeLive()
    await h.live.enterLive('https://www.naver.com')
    await flush()
    expect(h.stateCalls).toBe(1)
    expect(h.states).toHaveLength(1)
    expect(h.states[0]).toEqual({
      ok: true,
      url: 'https://news.naver.com/article/123',
      title: '뉴스 기사',
      canGoBack: true,
      canGoForward: false,
    })
    jest.advanceTimersByTime(2000)
    await flush()
    expect(h.stateCalls).toBe(2)
    // 가짜 타이머는 틱 사이에 마이크로태스크를 양보하지 않으므로, 한 번에
    // 여러 간격을 밀면 진행 중 가드가 틱을 건너뛴다. 간격 단위로 나눈다
    // (실제 시간에서는 틱 간격 2초 사이에 응답이 끝나 가드에 안 걸린다).
    jest.advanceTimersByTime(2000)
    await flush()
    expect(h.stateCalls).toBe(3)
    jest.advanceTimersByTime(2000)
    await flush()
    expect(h.stateCalls).toBe(4)
    expect(h.states).toHaveLength(4)
    await h.live.endLive()
  })

  test('endLive하면 폴링이 멈춘다', async () => {
    setupFixture()
    const h = makeLive()
    await h.live.enterLive('https://www.naver.com')
    await flush()
    expect(h.stateCalls).toBe(1)
    await h.live.endLive()
    jest.advanceTimersByTime(10000)
    await flush()
    expect(h.stateCalls).toBe(1)
    expect(h.states).toHaveLength(1)
  })

  test('탭이 hidden이면 폴링을 쉬고, 보이면 다시 묻는다', async () => {
    setupFixture()
    const doc = getDoc()
    const h = makeLive()
    await h.live.enterLive('https://www.naver.com')
    await flush()
    expect(h.stateCalls).toBe(1)
    Object.defineProperty(doc, 'hidden', { value: true, configurable: true })
    jest.advanceTimersByTime(6000)
    await flush()
    expect(h.stateCalls).toBe(1)
    Object.defineProperty(doc, 'hidden', { value: false, configurable: true })
    jest.advanceTimersByTime(2000)
    await flush()
    expect(h.stateCalls).toBe(2)
    await h.live.endLive()
  })

  test('요청이 진행 중이면 다음 틱이 겹쳐서 부르지 않는다', async () => {
    setupFixture()
    let resolveFirst!: (v: unknown) => void
    let n = 0
    const h = makeLive({
      fetchStateImpl: () => {
        n += 1
        if (n === 1) return new Promise((resolve) => { resolveFirst = resolve })
        return Promise.resolve({
          status: 200,
          body: { ok: true, url: 'https://example.com', title: 't', canGoBack: false, canGoForward: false },
        })
      },
    })
    await h.live.enterLive('https://www.naver.com')
    await flush()
    expect(h.stateCalls).toBe(1)
    // 첫 요청이 안 끝난 채로 틱이 와도 두 번째 요청이 나가지 않는다.
    jest.advanceTimersByTime(4000)
    await flush()
    expect(h.stateCalls).toBe(1)
    resolveFirst({
      status: 200,
      body: { ok: true, url: 'https://example.com', title: 't', canGoBack: false, canGoForward: false },
    })
    await flush()
    expect(h.states).toHaveLength(1)
    jest.advanceTimersByTime(2000)
    await flush()
    expect(h.stateCalls).toBe(2)
    await h.live.endLive()
  })

  test('상태 조회 실패·ok:false면 onState를 부르지 않고 폴링은 계속된다', async () => {
    setupFixture()
    const h = makeLive({
      fetchStateImpl: () => Promise.resolve({ status: 502, body: null }),
    })
    await h.live.enterLive('https://www.naver.com')
    await flush()
    expect(h.stateCalls).toBe(1)
    expect(h.states).toHaveLength(0)
    jest.advanceTimersByTime(2000)
    await flush()
    expect(h.stateCalls).toBe(2)
    expect(h.states).toHaveLength(0)
    await h.live.endLive()
  })

  test('navigate 503으로 notice가 되면 폴링이 멈춘다', async () => {
    setupFixture()
    const h = makeLive({
      navigateImpl: () => Promise.resolve({ status: 503, body: { ok: false } }),
    })
    const started = await h.live.enterLive('https://www.naver.com')
    expect(started).toBe(false)
    expect(h.live.state()).toBe('notice')
    await flush()
    // 시작 직후 폴링이 한 번 나가고(시작→503 전환 순서), 이후는 멈춘다.
    // 1이라는 단언이 중요하다 — 폴링이 시작조차 안 됐으면 0이 돼 이
    // 테스트가 "멈췄다"고 거짓으로 통과하기 때문이다 (카나리아 지적).
    expect(h.stateCalls).toBe(1)
    jest.advanceTimersByTime(10000)
    await flush()
    expect(h.stateCalls).toBe(1)
    h.live.dismissNotice()
  })

  test('refreshState는 즉시 한 번 폴링한다', async () => {
    setupFixture()
    const h = makeLive()
    await h.live.enterLive('https://www.naver.com')
    await flush()
    expect(h.stateCalls).toBe(1)
    h.live.refreshState()
    await flush()
    expect(h.stateCalls).toBe(2)
    await h.live.endLive()
  })

  test('endLive 뒤의 늦은 응답은 onState를 부르지 않는다 (liveGen 가드)', async () => {
    setupFixture()
    let resolveFirst!: (v: unknown) => void
    const h = makeLive({
      fetchStateImpl: () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        }),
    })
    await h.live.enterLive('https://www.naver.com')
    await flush()
    expect(h.stateCalls).toBe(1)
    await h.live.endLive()
    resolveFirst({
      status: 200,
      body: { ok: true, url: 'https://example.com', title: 't', canGoBack: false, canGoForward: false },
    })
    await flush()
    expect(h.states).toHaveLength(0)
  })
})

describe('browser-live 뷰포트 주기 재적용 폐지 (2026-11-17 P1)', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  test('enterLive 후 30초가 지나도 applyViewport를 다시 부르지 않는다', async () => {
    // 10초 주기 재적용(QA 2차)은 사이드카 영구 CDP가 새 탭에도
    // 뷰포트를 즉시 적용하므로 폐지됐다 — 다시 넣으면 이 테스트가
    // 실패한다. URL 진입은 navigate 뒤 /viewport POST(영구 세션)가
    // 1회 나가고(2026-11-21: navigate 임시 세션만 믿으면 낡은
    // override가 남아 쏠림이 생긴다), 이후 30초 폴링은 추가 호출이
    // 없어야 한다.
    setupFixture()
    const h = makeLive()
    await h.live.enterLive('https://www.naver.com')
    await flush()
    expect(h.viewportCalls).toBe(1)
    jest.advanceTimersByTime(30000)
    await flush()
    expect(h.viewportCalls).toBe(1)
    await h.live.endLive()
  })

  test('url 없이 진입해도 시간이 지나도 다시 부르지 않는다', async () => {
    setupFixture()
    const h = makeLive()
    await h.live.enterLive()
    await flush()
    expect(h.viewportCalls).toBe(1)
    jest.advanceTimersByTime(30000)
    await flush()
    expect(h.viewportCalls).toBe(1)
    await h.live.endLive()
  })

  test('navigate 503으로 notice가 되면 뷰포트 호출이 없다', async () => {
    setupFixture()
    const h = makeLive({
      navigateImpl: () => Promise.resolve({ status: 503, body: { ok: false } }),
    })
    const started = await h.live.enterLive('https://www.naver.com')
    expect(started).toBe(false)
    expect(h.live.state()).toBe('notice')
    await flush()
    jest.advanceTimersByTime(30000)
    await flush()
    expect(h.viewportCalls).toBe(0)
    h.live.dismissNotice()
  })

  test('endLive 뒤에 도착한 늦은 적용 응답은 다음 시작의 적용을 막지 않는다 (liveGen 가드)', async () => {
    setupFixture()
    let releaseFirst!: (v: unknown) => void
    let first = true
    const h = makeLive({
      applyViewportImpl: () => {
        if (first) {
          first = false
          return new Promise((resolve) => {
            releaseFirst = resolve
          })
        }
        return Promise.resolve({ status: 200, body: { ok: true, stage: 'ok' } })
      },
    })
    // URL 없이 진입하면 시작 직후 applyViewportNow가 나간다.
    await h.live.enterLive()
    await flush()
    expect(h.viewportCalls).toBe(1)
    await h.live.endLive()
    // 늦은 응답이 도착한다 — 가드가 없으면 lastAppliedViewport가 채워진다.
    releaseFirst({ status: 200, body: { ok: true, stage: 'ok' } })
    await flush()
    // 다시 진입하면 같은 크기라도 적용이 나가야 한다 (새 세션이다).
    await h.live.enterLive()
    await flush()
    expect(h.viewportCalls).toBe(2)
    await h.live.endLive()
  })
})

describe('browser-live 뒤로/앞으로 (history)', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  test('goBack/goForward는 history에 방향을 보내고 성공 여부를 돌려준다', async () => {
    setupFixture()
    const h = makeLive()
    await h.live.enterLive('https://www.naver.com')
    await flush()
    await expect(h.live.goBack()).resolves.toBe(true)
    await expect(h.live.goForward()).resolves.toBe(true)
    expect(h.historyCalls).toEqual(['back', 'forward'])
    await h.live.endLive()
  })

  test('history 실패·거부는 false다', async () => {
    setupFixture()
    const h = makeLive({
      historyImpl: (direction: string) =>
        direction === 'back'
          ? Promise.resolve({ status: 502, body: null })
          : Promise.reject(new Error('down')),
    })
    await h.live.enterLive('https://www.naver.com')
    await flush()
    await expect(h.live.goBack()).resolves.toBe(false)
    await expect(h.live.goForward()).resolves.toBe(false)
    await h.live.endLive()
  })

  test('꺼져 있으면 history를 부르지 않고 false다', async () => {
    setupFixture()
    const h = makeLive()
    await expect(h.live.goBack()).resolves.toBe(false)
    await expect(h.live.goForward()).resolves.toBe(false)
    expect(h.historyCalls).toEqual([])
  })
})

describe('browser-live fetch 타임아웃 (2026-11-16 QA 1차)', () => {
  const realFetch = (globalThis as any).fetch

  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
    ;(globalThis as any).fetch = realFetch
  })

  /** abort 신호를 받아야만 끝나는 fetch — 신호가 없으면 즉시 거부한다
   * (구현이 signal을 안 넘기면 테스트가 빨리 실패하는 카나리아). */
  function hangUntilAbort(init: any): Promise<never> {
    const signal = init && init.signal
    if (!signal) return Promise.reject(new Error('no abort signal'))
    if (signal.aborted) return Promise.reject(new Error('aborted'))
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }

  function jsonRes(status: number, body: unknown): unknown {
    return { status, json: () => Promise.resolve(body) }
  }

  /** 기본 fetch 목: unlock 503(미구성, fail-open)·navigate/viewport 200.
   * state/history/viewport는 opts로 동작을 정한다. */
  function stubLiveFetch(opts: {
    state?: (init: any) => Promise<unknown>
    history?: (init: any) => Promise<unknown>
    viewport?: (init: any) => Promise<unknown>
  } = {}): { stateCalls: () => number; historyCalls: () => number; viewportCalls: () => number } {
    let stateCalls = 0
    let historyCalls = 0
    let viewportCalls = 0
    ;(globalThis as any).fetch = (url: string, init?: any) => {
      if (url === '/api/browse/state') {
        stateCalls += 1
        if (opts.state) return opts.state(init)
        return Promise.resolve(
          jsonRes(200, { ok: true, url: 'https://www.naver.com', title: 'naver.com', canGoBack: false, canGoForward: false }),
        )
      }
      if (url === '/api/browse/back' || url === '/api/browse/forward') {
        historyCalls += 1
        if (opts.history) return opts.history(init)
        return Promise.resolve(jsonRes(200, { ok: true, stage: 'ok' }))
      }
      if (url === '/api/browse/unlock/status') {
        return Promise.resolve(jsonRes(503, {}))
      }
      if (url === '/api/browse/navigate') {
        return Promise.resolve(jsonRes(200, { ok: true, nav: 'ok', navStage: 'ok' }))
      }
      if (url === '/api/browse/viewport') {
        viewportCalls += 1
        if (opts.viewport) return opts.viewport(init)
        return Promise.resolve(jsonRes(200, { ok: true, stage: 'ok' }))
      }
      return Promise.resolve(jsonRes(404, null))
    }
    return { stateCalls: () => stateCalls, historyCalls: () => historyCalls, viewportCalls: () => viewportCalls }
  }

  /** fetchState/history 주입 없이 기본 fetch를 쓰는 live (타임아웃 대상). */
  function makeLiveDefault(): { live: any; states: Array<Record<string, unknown>> } {
    const states: Array<Record<string, unknown>> = []
    const api = loadLive()
    const live = api.createLive({
      doc: getDoc(),
      onState: (body: Record<string, unknown>) => {
        states.push(body)
      },
      onChange: () => undefined,
      statePollMs: 2000,
    })
    return { live, states }
  }

  test('state fetch가 10초 안에 안 끝나면 타임아웃돼 statePolling이 풀리고 다음 폴링이 돈다', async () => {
    setupFixture()
    const calls = stubLiveFetch({ state: (init) => hangUntilAbort(init) })
    const { live } = makeLiveDefault()
    await live.enterLive('https://www.naver.com')
    await flush()
    expect(calls.stateCalls()).toBe(1)
    // 10초가 되기 전에는 타임아웃이 안 된다 — 틱이 와도 진행 중 가드에 걸린다.
    jest.advanceTimersByTime(9000)
    await flush()
    expect(calls.stateCalls()).toBe(1)
    // 10초 경과 → abort → {status: 0} → statePolling 해제.
    jest.advanceTimersByTime(1000)
    await flush()
    expect(calls.stateCalls()).toBe(1) // 아직 다음 틱이 안 왔다
    jest.advanceTimersByTime(2000)
    await flush()
    expect(calls.stateCalls()).toBe(2) // 해제돼 다음 폴링이 돈다
    await live.endLive()
  })

  test('history fetch가 10초 안에 안 끝나면 타임아웃돼 false를 돌린다', async () => {
    setupFixture()
    stubLiveFetch({ history: (init) => hangUntilAbort(init) })
    const { live } = makeLiveDefault()
    await live.enterLive('https://www.naver.com')
    await flush()
    let settled: boolean | null = null
    const p = live.goBack().then((v: boolean) => {
      settled = v
      return v
    })
    await flush()
    expect(settled).toBeNull()
    jest.advanceTimersByTime(9000)
    await flush()
    expect(settled).toBeNull()
    jest.advanceTimersByTime(1000)
    await expect(p).resolves.toBe(false)
    expect(settled).toBe(false)
    await live.endLive()
  })

  test('viewport fetch가 10초 안에 안 끝나면 타임아웃돼 {status: 0}으로 정리되고 2초 뒤 재시도한다 (2026-11-16 QA 4차)', async () => {
    setupFixture()
    const calls = stubLiveFetch({ viewport: (init) => hangUntilAbort(init) })
    const { live } = makeLiveDefault()
    // url 없는 진입: startLive가 applyViewportNow를 부른다 (기본 fetch 사용).
    await live.enterLive()
    await flush()
    expect(calls.viewportCalls()).toBe(1)
    // 10초가 되기 전에는 타임아웃이 안 된다 — 재시도도 없다.
    jest.advanceTimersByTime(9000)
    await flush()
    expect(calls.viewportCalls()).toBe(1)
    // 10초 경과 → abort → {status: 0} → 2초 뒤 재시도 타이머.
    jest.advanceTimersByTime(1000)
    await flush()
    expect(calls.viewportCalls()).toBe(1) // 아직 재시도 전
    jest.advanceTimersByTime(2000)
    await flush()
    expect(calls.viewportCalls()).toBe(2) // 정리돼 재시도가 돈다
    await live.endLive()
  })

  test('viewport fetch가 한 번 멈춰도 타임아웃으로 풀려 2초 뒤 재시도가 성공한다 (2026-11-16 QA 4차 wedge, 2026-11-17 P1 주기 재적용 폐지)', async () => {
    setupFixture()
    // 첫 호출만 abort까지 멈추고 이후는 즉시 성공한다 — 멈춤이
    // 재시도를 막는지(wedge)가 이 테스트가 보는 성질이다. 주기
    // 재적용이 폐지됐으므로 재시도 뒤에는 시간만으로 더 안 나간다.
    let n = 0
    const calls = stubLiveFetch({
      viewport: (init) => {
        n += 1
        if (n === 1) return hangUntilAbort(init)
        return Promise.resolve(jsonRes(200, { ok: true, stage: 'ok' }))
      },
    })
    const { live } = makeLiveDefault()
    await live.enterLive()
    await flush()
    expect(calls.viewportCalls()).toBe(1)
    // +10초: 첫 호출이 abort돼 {status: 0}으로 정리되고 2초 뒤 재시도.
    jest.advanceTimersByTime(10000)
    await flush()
    expect(calls.viewportCalls()).toBe(1) // 아직 재시도 전
    jest.advanceTimersByTime(2000)
    await flush()
    expect(calls.viewportCalls()).toBe(2) // 재시도가 성공한다
    // 이후 30초가 지나도 주기 재적용이 없어 더 나가지 않는다.
    jest.advanceTimersByTime(30000)
    await flush()
    expect(calls.viewportCalls()).toBe(2)
    await live.endLive()
  })
})
