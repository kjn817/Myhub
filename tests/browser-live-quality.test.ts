/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 원격 브라우저 화질 설정 (2026-11-15, 성능 개선: 사이드카 적응 제어의
 * 수동 오버라이드 + 초기 비트레이트).
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - 수동 화질 저장값이 있으면 iframe 시작 시 src에 ?vb=<kbps>가 붙는다.
 * - 저장값이 없거나 'auto'면 쿼리 없이 시작한다 (사이드카 자동 조절).
 * - 잘못된 저장값(범위 밖·숫자 아님)은 무시하고 자동 모드로 시작한다.
 * - setQuality(숫자)는 { bitrate }를 보내고 성공 시 true + 저장값을 갱신한다.
 * - setQuality('auto')는 { mode: 'auto' }를 보내고 성공 시 저장값을 'auto'로 한다.
 * - 무효 입력(범위 밖·비숫자·null)은 요청을 보내지 않고 false를 돌려준다.
 * - 전환 실패(502 등)면 false이고 저장값이 바뀌지 않는다.
 * - 소수 입력은 반올림된다.
 * 카나리아: 쿼리 부착·검증·저장 분기를 깨면 해당 테스트가 실패한다.
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

interface QualityStubs {
  setQualityImpl?: (payload: unknown) => Promise<unknown>
}

function makeLive(stubs: QualityStubs = {}) {
  const calls = { quality: [] as unknown[] }
  const api = loadLive()
  const live = api.createLive({
    doc: getDoc(),
    navigate: () => Promise.resolve({ status: 200, body: { ok: true, nav: 'ok', navStage: 'ok' } }),
    checkUnlock: () => Promise.resolve({ status: 200, body: { configured: true, unlocked: true } }),
    submitUnlock: () => Promise.resolve({ status: 200, body: { ok: true } }),
    setQuality: (payload: unknown) => {
      calls.quality.push(payload)
      if (stubs.setQualityImpl) return stubs.setQualityImpl(payload)
      return Promise.resolve({ status: 200, body: { ok: true, mode: 'manual', connections: 1 } })
    },
    pollDelayMs: 10,
    onChange: () => live.syncChrome(),
  })
  return { live, calls }
}

function el(id: string): any {
  return getDoc().getElementById(id)
}

describe('browser-live 화질 설정', () => {
  beforeEach(() => {
    storage().clear()
  })

  test('수동 저장값이 있으면 iframe src에 ?vb=가 붙는다', async () => {
    storage().setItem('myhub-bw-quality', '1800')
    setupFixture()
    const { live } = makeLive()
    await live.enterLive(null)
    expect(live.state()).toBe('on')
    expect(el('bwLiveFrame').getAttribute('src')).toBe('/api/browse/view/?vb=1800')
    live.endLive()
  })

  test('저장값이 없거나 auto면 쿼리 없이 시작한다', async () => {
    for (const saved of [null, 'auto']) {
      setupFixture()
      if (saved !== null) storage().setItem('myhub-bw-quality', saved)
      else storage().clear()
      const { live } = makeLive()
      await live.enterLive(null)
      expect(el('bwLiveFrame').getAttribute('src')).toBe('/api/browse/view/')
      live.endLive()
    }
  })

  test('잘못된 저장값은 무시하고 자동 모드로 시작한다', async () => {
    for (const saved of ['100', '9000', 'fast', '0', '-5', '18.5x']) {
      setupFixture()
      storage().setItem('myhub-bw-quality', saved)
      const { live } = makeLive()
      await live.enterLive(null)
      expect(el('bwLiveFrame').getAttribute('src')).toBe('/api/browse/view/')
      live.endLive()
    }
  })

  test('setQuality(숫자)는 bitrate를 보내고 성공 시 저장값을 갱신한다', async () => {
    setupFixture()
    const { live, calls } = makeLive()
    const ok = await live.setQuality(1800)
    expect(ok).toBe(true)
    expect(calls.quality).toEqual([{ bitrate: 1800 }])
    expect(storage().getItem('myhub-bw-quality')).toBe('1800')
  })

  test("setQuality('auto')는 mode:auto를 보내고 저장값을 auto로 한다", async () => {
    storage().setItem('myhub-bw-quality', '1800')
    setupFixture()
    const { live, calls } = makeLive()
    const ok = await live.setQuality('auto')
    expect(ok).toBe(true)
    expect(calls.quality).toEqual([{ mode: 'auto' }])
    expect(storage().getItem('myhub-bw-quality')).toBe('auto')
  })

  test('무효 입력은 요청을 보내지 않고 false를 돌려준다', async () => {
    setupFixture()
    const { live, calls } = makeLive()
    for (const bad of [100, 9000, 0, -1, NaN, Infinity, 'fast', null, undefined, {}, true]) {
      const ok = await live.setQuality(bad)
      expect(ok).toBe(false)
    }
    expect(calls.quality).toHaveLength(0)
    expect(storage().getItem('myhub-bw-quality')).toBeNull()
  })

  test('전환 실패면 false이고 저장값이 바뀌지 않는다', async () => {
    storage().setItem('myhub-bw-quality', 'auto')
    setupFixture()
    const { live, calls } = makeLive({
      setQualityImpl: () => Promise.resolve({ status: 502, body: { ok: false, error: 'ORACLE_UPSTREAM' } }),
    })
    const ok = await live.setQuality(1800)
    expect(ok).toBe(false)
    expect(calls.quality).toEqual([{ bitrate: 1800 }])
    expect(storage().getItem('myhub-bw-quality')).toBe('auto')
  })

  test('소수 입력은 반올림된다', async () => {
    setupFixture()
    const { live, calls } = makeLive()
    const ok = await live.setQuality(1800.6)
    expect(ok).toBe(true)
    expect(calls.quality).toEqual([{ bitrate: 1801 }])
    expect(storage().getItem('myhub-bw-quality')).toBe('1801')
  })
})
