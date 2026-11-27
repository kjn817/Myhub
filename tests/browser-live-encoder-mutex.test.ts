/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 원격 브라우저 인코더 뮤텍스 (2026-11-26 Waydroid Phase 3 후속, C안:
 * 활성 인코더 최대 1개).
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - setAndroidVisible(true)는 { paused: true }를 보내고 성공 시 true +
 *   isAndroidVisible()가 true가 된다.
 * - setAndroidVisible(false)는 { paused: false }를 보낸다.
 * - 같은 값이면 요청을 보내지 않고 true다.
 * - 무효 입력(비boolean)은 요청을 보내지 않고 false다.
 * - 전환 실패(502 등)면 false이고 다음 폴링 때 다시 시도한다.
 * - 라이브 시작 시 현재 가시성을 다시 보낸다 (사이드카 재시작·Selkies
 *   재생성으로 소실된 pause 복원).
 * - 폴링 실패 뒤 복구되면 가시성을 다시 보낸다.
 * - connections: 0이어도 성공으로 보고 다시 보내지 않는다 (상태 저장됨).
 * - 연속 전환(true→false)은 POST 순서가 지켜진다 (직렬화 — 뒤집히면 안 됨).
 * 카나리아: 반전·재확언·직렬화 분기를 깨면 해당 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const LIVE_JS = fs.readFileSync(path.join(ROOT, 'public/js/browser-live.js'), 'utf-8')

const getWin = (): any => (globalThis as any).window
const getDoc = (): any => (globalThis as any).document
const storage = (): Storage => (globalThis as any).window.localStorage

function setupFixture(): void {
  const doc = getDoc()
  doc.body.innerHTML = `
    <div class="bw-stage" id="bwStage">
      <div class="bw-home" id="bwHome"></div>
      <iframe class="bw-frame" id="bwLiveFrame" title="원격 브라우저" hidden></iframe>
      <div class="bw-notice-card" id="bwNoticeCard" hidden>
        <p id="bwNoticeMsg"></p><button type="button" id="bwNoticeClose">닫기</button>
      </div>
      <div class="bw-lock-card" id="bwLockCard" hidden>
        <h2 class="bw-lock-title" id="bwLockTitle">브라우저가 잠겨 있어요</h2>
        <p class="bw-lock-desc" id="bwLockDesc"></p>
        <div class="bw-lock-form" id="bwLockForm">
          <input type="password" id="bwLockPassword" placeholder="보관함 암호">
          <input type="password" id="bwLockConfirm" placeholder="암호 다시 입력" hidden>
          <p class="bw-lock-msg" id="bwLockMsg" hidden></p>
          <button type="button" class="bw-lock-btn" id="bwLockSubmit">풀기</button>
          <button type="button" class="bw-lock-close" id="bwLockClose">닫기</button>
        </div>
      </div>
    </div>
  `
  const stage = doc.getElementById('bwStage')
  stage.getBoundingClientRect = () => ({ width: 1200, height: 700, top: 0, left: 0, right: 1200, bottom: 700, x: 0, y: 0, toJSON: () => ({}) })
}

function loadLive(): any {
  const win = getWin()
  new Function('window', 'document', LIVE_JS)(win, getDoc())
  return win.MyHubBrowserLive
}

interface MutexStubs {
  setEncoderMutexImpl?: (payload: unknown) => Promise<unknown>
  fetchStateImpl?: () => Promise<unknown>
}

function makeLive(stubs: MutexStubs = {}) {
  const calls = { mutex: [] as unknown[] }
  const api = loadLive()
  const deps: Record<string, unknown> = {
    doc: getDoc(),
    navigate: () => Promise.resolve({ status: 200, body: { ok: true, nav: 'ok', navStage: 'ok' } }),
    checkUnlock: () => Promise.resolve({ status: 200, body: { configured: true, unlocked: true } }),
    submitUnlock: () => Promise.resolve({ status: 200, body: { ok: true } }),
    setQuality: () => Promise.resolve({ status: 200, body: { ok: true, mode: 'auto', connections: 1 } }),
    setEncoderMutex: (payload: unknown) => {
      calls.mutex.push(payload)
      if (stubs.setEncoderMutexImpl) return stubs.setEncoderMutexImpl(payload)
      return Promise.resolve({ status: 200, body: { ok: true, enabled: true, connections: 1 } })
    },
    pollDelayMs: 10,
    onChange: () => live.syncChrome(),
  }
  if (stubs.fetchStateImpl) deps.fetchState = stubs.fetchStateImpl
  const live = api.createLive(deps)
  return { live, calls }
}

async function flush(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

function okState(): Promise<unknown> {
  return Promise.resolve({
    status: 200,
    body: { ok: true, url: 'https://example.com', title: 't', canGoBack: false, canGoForward: false },
  })
}

describe('browser-live 인코더 뮤텍스', () => {
  beforeEach(() => {
    storage().clear()
  })

  test('setAndroidVisible(true)는 paused:true를 보내고 true를 돌려준다', async () => {
    setupFixture()
    const { live, calls } = makeLive()
    const ok = await live.setAndroidVisible(true)
    expect(ok).toBe(true)
    expect(calls.mutex).toEqual([{ paused: true }])
    expect(live.isAndroidVisible()).toBe(true)
    live.endLive()
  })

  test('setAndroidVisible(false)는 paused:false를 보낸다', async () => {
    setupFixture()
    const { live, calls } = makeLive()
    await live.setAndroidVisible(true)
    const ok = await live.setAndroidVisible(false)
    expect(ok).toBe(true)
    expect(calls.mutex).toEqual([{ paused: true }, { paused: false }])
    expect(live.isAndroidVisible()).toBe(false)
    live.endLive()
  })

  test('같은 값이면 요청을 보내지 않고 true다', async () => {
    setupFixture()
    const { live, calls } = makeLive()
    expect(await live.setAndroidVisible(false)).toBe(true)
    expect(calls.mutex).toHaveLength(0)
    await live.setAndroidVisible(true)
    expect(await live.setAndroidVisible(true)).toBe(true)
    expect(calls.mutex).toEqual([{ paused: true }])
    live.endLive()
  })

  test('무효 입력은 요청을 보내지 않고 false다', async () => {
    setupFixture()
    const { live, calls } = makeLive()
    for (const bad of ['yes', 1, 0, null, undefined, {}, []]) {
      expect(await live.setAndroidVisible(bad)).toBe(false)
    }
    expect(calls.mutex).toHaveLength(0)
    expect(live.isAndroidVisible()).toBe(false)
    live.endLive()
  })

  test('전환 실패면 false이고 다음 폴링 때 다시 시도한다', async () => {
    setupFixture()
    const { live, calls } = makeLive({
      fetchStateImpl: okState,
      setEncoderMutexImpl: () => Promise.resolve({ status: 502, body: { ok: false, error: 'ORACLE_UPSTREAM' } }),
    })
    await live.enterLive(null)
    await flush()
    // 시작 시 숨김 상태라 resume이 한 번 간다.
    expect(calls.mutex).toEqual([{ paused: false }])
    const ok = await live.setAndroidVisible(true)
    expect(ok).toBe(false)
    expect(calls.mutex).toEqual([{ paused: false }, { paused: true }])
    // 실패했으므로 보류 상태 — 다음 폴링(refreshState)에서 다시 보낸다.
    await live.refreshState()
    await flush()
    expect(calls.mutex).toEqual([{ paused: false }, { paused: true }, { paused: true }])
    live.endLive()
  })

  test('라이브 시작 시 현재 가시성을 다시 보낸다', async () => {
    setupFixture()
    const { live, calls } = makeLive({ fetchStateImpl: okState })
    await live.setAndroidVisible(true)
    expect(calls.mutex).toEqual([{ paused: true }])
    await live.enterLive(null)
    await flush()
    // 시작 시 재확언이 한 번 더 간다 (사이드카 재시작 대비).
    expect(calls.mutex).toEqual([{ paused: true }, { paused: true }])
    await live.refreshState()
    await flush()
    expect(calls.mutex).toHaveLength(2)
    live.endLive()
  })

  test('라이브 시작 시 숨김 상태면 resume을 다시 보낸다 (낡은 pause 해제)', async () => {
    setupFixture()
    const { live, calls } = makeLive({ fetchStateImpl: okState })
    await live.enterLive(null)
    await flush()
    expect(calls.mutex).toEqual([{ paused: false }])
    live.endLive()
  })

  test('폴링 실패 뒤 복구되면 가시성을 다시 보낸다', async () => {
    setupFixture()
    let fails = 0
    const { live, calls } = makeLive({
      fetchStateImpl: () => {
        fails += 1
        if (fails === 1) return Promise.reject(new Error('down'))
        return okState()
      },
    })
    await live.setAndroidVisible(true)
    await live.enterLive(null)
    await flush()
    const before = calls.mutex.length
    // 실패한 폴링 1회 뒤 복구 폴링 — 복구 시 재확언이 간다.
    await live.refreshState()
    await flush()
    await live.refreshState()
    await flush()
    expect(calls.mutex.length).toBeGreaterThan(before)
    expect(calls.mutex[calls.mutex.length - 1]).toEqual({ paused: true })
    live.endLive()
  })

  test('connections: 0이어도 성공으로 보고 다시 보내지 않는다', async () => {
    setupFixture()
    const { live, calls } = makeLive({
      fetchStateImpl: okState,
      setEncoderMutexImpl: () => Promise.resolve({ status: 200, body: { ok: true, enabled: false, connections: 0 } }),
    })
    await live.setAndroidVisible(true)
    expect(calls.mutex).toEqual([{ paused: true }])
    await live.enterLive(null)
    await flush()
    // 시작 시 재확언 1회만 가고, 그 뒤 폴링에서는 안 보낸다.
    await live.refreshState()
    await flush()
    await live.refreshState()
    await flush()
    expect(calls.mutex).toHaveLength(2)
    live.endLive()
  })

  test('연속 전환(true→false)은 POST 순서가 지켜진다 (직렬화)', async () => {
    setupFixture()
    const order: unknown[] = []
    let releaseFirst: ((v: unknown) => void) | null = null
    const firstGate = new Promise<unknown>((resolve) => {
      releaseFirst = resolve
    })
    let n = 0
    const { live, calls } = makeLive({
      setEncoderMutexImpl: (payload: unknown) => {
        n += 1
        order.push(payload)
        if (n === 1) {
          // 첫 POST를 붙잡아 둔다 — 두 번째 전환이 먼저 나가면 순서가 깨진다.
          return firstGate.then(() => Promise.resolve({ status: 200, body: { ok: true, enabled: false, connections: 1 } }))
        }
        return Promise.resolve({ status: 200, body: { ok: true, enabled: true, connections: 1 } })
      },
    })
    const p1 = live.setAndroidVisible(true)
    const p2 = live.setAndroidVisible(false)
    await flush(10)
    // 첫 POST가 아직 안 끝났는데도 두 번째 POST가 나가면 안 된다.
    expect(calls.mutex).toEqual([{ paused: true }])
    if (releaseFirst) releaseFirst(null)
    expect(await p1).toBe(true)
    expect(await p2).toBe(true)
    expect(calls.mutex).toEqual([{ paused: true }, { paused: false }])
    expect(order).toEqual([{ paused: true }, { paused: false }])
    live.endLive()
  })
})
