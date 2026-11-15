/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 원격 브라우저 LUKS 잠금 화면 (2026-11-15, "MyHub에서 풀기").
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - enterLive는 iframe을 켜기 전에 언록 상태를 확인한다. 잠기면
 *   iframe src를 걸지 않고 잠금 카드를 띄우며 false를 돌려준다.
 * - 미설정(configured=false)이면 셋업 모드 카드(확인 입력 보임·
 *   '설정하기' 버튼)가 뜬다.
 * - 언록됨·조회 실패·503이면 기존 흐름대로 진행한다 (fail-open).
 * - 풀기 제출: 8자 미만은 클라이언트에서 막고, 401은 '암호가 맞지
 *   않습니다', 423은 잠금 시간 메시지를 띄우며 잠금 유지.
 * - 셋업 제출: 두 암호가 다르면 막는다.
 * - 제출 성공 후에는 다시 시작해 iframe이 켜진다 (보류 중이던 주소로 이동).
 * - 제출 후 네트워크 끊김(status 0)이면 상태를 폴링하다 풀리면 시작한다.
 * - navigate 423이면 잠금 카드를 띄운다.
 * - 닫기 버튼은 잠금을 해제하고 시작 화면으로 돌아간다.
 * 카나리아: 잠금 분기·제출·폴링을 깨면 해당 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const LIVE_JS = fs.readFileSync(path.join(ROOT, 'public/js/browser-live.js'), 'utf-8')
const BROWSER_HTML = fs.readFileSync(path.join(ROOT, 'public/browser.html'), 'utf-8')
const BROWSER_CSS = fs.readFileSync(path.join(ROOT, 'public/css/browser.css'), 'utf-8')

const getWin = (): any => (globalThis as any).window
const getDoc = (): any => (globalThis as any).document

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

interface LiveStubs {
  checkUnlock?: () => Promise<unknown>
  submitUnlock?: (mode: string, password: string) => Promise<unknown>
  navigateImpl?: (url: string, viewport: unknown) => Promise<unknown>
}

function makeLive(stubs: LiveStubs = {}) {
  const calls = { check: 0, submits: [] as Array<{ mode: string; password: string }>, navigates: [] as string[] }
  let checkImpl = stubs.checkUnlock
  const api = loadLive()
  const live = api.createLive({
    doc: getDoc(),
    navigate: (url: string, viewport: unknown) => {
      calls.navigates.push(url)
      if (stubs.navigateImpl) return stubs.navigateImpl(url, viewport)
      return Promise.resolve({ status: 200, body: { ok: true, nav: 'ok', navStage: 'ok' } })
    },
    checkUnlock: () => {
      calls.check += 1
      if (checkImpl) return checkImpl()
      return Promise.resolve({ status: 200, body: { configured: true, unlocked: true } })
    },
    submitUnlock: (mode: string, password: string) => {
      calls.submits.push({ mode, password })
      if (stubs.submitUnlock) return stubs.submitUnlock(mode, password)
      return Promise.resolve({ status: 200, body: { ok: true } })
    },
    pollDelayMs: 10,
    onChange: () => live.syncChrome(),
  })
  return {
    live,
    calls,
    setCheckImpl: (impl: () => Promise<unknown>) => {
      checkImpl = impl
    },
  }
}

function el(id: string): any {
  return getDoc().getElementById(id)
}

function submitLockForm(password: string, confirm?: string): void {
  el('bwLockPassword').value = password
  if (confirm !== undefined) el('bwLockConfirm').value = confirm
  el('bwLockSubmit').click()
}

function submitLockFormByEnter(password: string): void {
  el('bwLockPassword').value = password
  const ev = new (getWin() as any).KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  el('bwLockPassword').dispatchEvent(ev)
}

const flush = () => new Promise((r) => setTimeout(r, 30))

describe('browser-live LUKS 잠금 화면', () => {
  test('잠긴 볼륨이면 iframe을 켜지 않고 잠금 카드를 띄운다', async () => {
    setupFixture()
    const { live } = makeLive({
      checkUnlock: () => Promise.resolve({ status: 200, body: { configured: true, unlocked: false } }),
    })
    const started = await live.enterLive('https://www.naver.com')
    expect(started).toBe(false)
    expect(live.state()).toBe('locked')
    expect(el('bwLockCard').hidden).toBe(false)
    expect(el('bwLiveFrame').getAttribute('src')).toBeNull()
    expect(el('bwLockConfirm').hidden).toBe(true)
    expect(el('bwLockSubmit').textContent).toBe('풀기')
  })

  test('미설정이면 셋업 모드 카드가 뜬다', async () => {
    setupFixture()
    const { live } = makeLive({
      checkUnlock: () => Promise.resolve({ status: 200, body: { configured: false, unlocked: false } }),
    })
    await live.enterLive(null)
    expect(live.state()).toBe('locked')
    expect(el('bwLockConfirm').hidden).toBe(false)
    expect(el('bwLockSubmit').textContent).toBe('설정하기')
    expect(el('bwLockTitle').textContent).toContain('정해주세요')
  })

  test('언록됨·조회 실패·503이면 기존 흐름대로 진행한다 (fail-open)', async () => {
    for (const res of [
      { status: 200, body: { configured: true, unlocked: true } },
      { status: 0, body: null },
      { status: 503, body: { ok: false, error: 'UNLOCK_NOT_CONFIGURED' } },
    ]) {
      setupFixture()
      const { live, calls } = makeLive({ checkUnlock: () => Promise.resolve(res) })
      const started = await live.enterLive('https://www.naver.com')
      expect(started).toBe(true)
      expect(live.state()).toBe('on')
      expect(el('bwLiveFrame').getAttribute('src')).toBe('/api/browse/view/')
      expect(calls.navigates).toEqual(['https://www.naver.com'])
      live.endLive()
    }
  })

  test('풀기 성공 후 다시 시작해 iframe이 켜지고 보류 주소로 이동한다', async () => {
    setupFixture()
    let locked = true
    const { live, calls } = makeLive({
      checkUnlock: () => Promise.resolve({ status: 200, body: { configured: true, unlocked: !locked } }),
      submitUnlock: () => {
        locked = false
        return Promise.resolve({ status: 200, body: { ok: true } })
      },
    })
    await live.enterLive('https://www.naver.com')
    expect(live.state()).toBe('locked')
    submitLockForm('correct-horse-1')
    await flush()
    expect(calls.submits).toEqual([{ mode: 'unlock', password: 'correct-horse-1' }])
    expect(live.state()).toBe('on')
    expect(el('bwLiveFrame').getAttribute('src')).toBe('/api/browse/view/')
    expect(calls.navigates).toEqual(['https://www.naver.com'])
    expect(el('bwLockPassword').value).toBe('')
  })

  test('암호가 틀리면(401) 메시지를 띄우고 잠금을 유지한다', async () => {
    setupFixture()
    const { live, calls } = makeLive({
      checkUnlock: () => Promise.resolve({ status: 200, body: { configured: true, unlocked: false } }),
      submitUnlock: () => Promise.resolve({ status: 401, body: { ok: false, failed_attempts: 2 } }),
    })
    await live.enterLive(null)
    submitLockForm('wrong-password')
    await flush()
    expect(calls.submits).toHaveLength(1)
    expect(live.state()).toBe('locked')
    expect(el('bwLockMsg').hidden).toBe(false)
    expect(el('bwLockMsg').textContent).toContain('맞지 않습니다')
    expect(el('bwLockMsg').textContent).toContain('2/5')
  })

  test('잠금(423)이면 잠금 시간 메시지를 띄운다', async () => {
    setupFixture()
    const { live } = makeLive({
      checkUnlock: () => Promise.resolve({ status: 200, body: { configured: true, unlocked: false } }),
      submitUnlock: () => Promise.resolve({ status: 423, body: { ok: false, lockout_remaining: 420 } }),
    })
    await live.enterLive(null)
    submitLockForm('wrong-password')
    await flush()
    expect(live.state()).toBe('locked')
    expect(el('bwLockMsg').textContent).toContain('7분')
  })

  test('8자 미만 암호는 클라이언트에서 막고 제출하지 않는다', async () => {
    setupFixture()
    const { live, calls } = makeLive({
      checkUnlock: () => Promise.resolve({ status: 200, body: { configured: true, unlocked: false } }),
    })
    await live.enterLive(null)
    submitLockForm('short')
    await flush()
    expect(calls.submits).toHaveLength(0)
    expect(el('bwLockMsg').textContent).toContain('8자 이상')
  })

  test('셋업에서 두 암호가 다르면 막는다', async () => {
    setupFixture()
    const { live, calls } = makeLive({
      checkUnlock: () => Promise.resolve({ status: 200, body: { configured: false, unlocked: false } }),
    })
    await live.enterLive(null)
    submitLockForm('correct-horse-1', 'different-pass')
    await flush()
    expect(calls.submits).toHaveLength(0)
    expect(el('bwLockMsg').textContent).toContain('달라요')
  })

  test('제출 후 네트워크 끊김이면 상태를 폴링하다 풀리면 시작한다', async () => {
    setupFixture()
    let polls = 0
    const { live } = makeLive({
      checkUnlock: () => {
        polls += 1
        // 첫 조회는 잠김, 폴링 2회째부터 풀림
        return Promise.resolve({ status: 200, body: { configured: true, unlocked: polls >= 3 } })
      },
      submitUnlock: () => Promise.resolve({ status: 0, body: null }),
    })
    await live.enterLive(null)
    expect(live.state()).toBe('locked')
    submitLockForm('correct-horse-1')
    await new Promise((r) => setTimeout(r, 200))
    expect(live.state()).toBe('on')
    expect(el('bwLiveFrame').getAttribute('src')).toBe('/api/browse/view/')
  })

  test('navigate 423이면 잠금 카드를 띄운다', async () => {
    setupFixture()
    const { live } = makeLive({
      checkUnlock: () => Promise.resolve({ status: 200, body: { configured: true, unlocked: true } }),
      navigateImpl: () => Promise.resolve({ status: 423, body: { ok: false, error: 'BROWSER_LOCKED' } }),
    })
    const started = await live.enterLive('https://www.naver.com')
    expect(started).toBe(false)
    expect(live.state()).toBe('locked')
    expect(el('bwLockCard').hidden).toBe(false)
    expect(el('bwLiveFrame').getAttribute('src')).toBeNull()
  })

  test('닫기 버튼은 잠금을 해제하고 시작 화면으로 돌아간다', async () => {
    setupFixture()
    const { live } = makeLive({
      checkUnlock: () => Promise.resolve({ status: 200, body: { configured: true, unlocked: false } }),
    })
    await live.enterLive(null)
    expect(live.state()).toBe('locked')
    el('bwLockClose').click()
    expect(live.state()).toBe('off')
    expect(el('bwLockCard').hidden).toBe(true)
  })

  test('암호 입력에서 Enter 키로도 제출된다', async () => {
    setupFixture()
    const { live, calls } = makeLive({
      checkUnlock: () => Promise.resolve({ status: 200, body: { configured: true, unlocked: false } }),
    })
    await live.enterLive(null)
    submitLockFormByEnter('correct-horse-1')
    await flush()
    expect(calls.submits).toEqual([{ mode: 'unlock', password: 'correct-horse-1' }])
  })

  test('잠금 카드 마크업·CSS가 실제 소스에 있다', () => {
    for (const id of ['bwLockCard', 'bwLockTitle', 'bwLockDesc', 'bwLockForm', 'bwLockPassword', 'bwLockConfirm', 'bwLockMsg', 'bwLockSubmit', 'bwLockClose']) {
      expect(BROWSER_HTML).toContain(`id="${id}"`)
    }
    expect(BROWSER_CSS).toContain('.bw-lock-card')
    expect(BROWSER_CSS).toContain('.bw-lock-card[hidden]')
  })
})
