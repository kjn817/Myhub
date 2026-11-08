/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * Google 연결 버튼 UI 테스트 — 일정 화면(schedule.html) 상단 Google 연동 행
 *
 * - 순수 로직: describeGoogleStatus / googleCallbackNotice
 * - jsdom + fetch 모의: 연결 버튼 클릭 → /api/google/oauth/start 이동,
 *   상태 표시가 /api/google/status 응답과 일치, 해제 버튼 → POST /api/google/disconnect
 * - schedule.html 배선: 행·버튼·스크립트 참조 + static-assets 집합 + deploy ver() 포함
 * - AI 안내 문구가 실제 버튼 위치(일정 화면 상단)를 가리키는지
 *
 * 운영 DB·실제 Google API에 닿지 않음.
 * (jsdom은 직접 import하면 ESM 로딩에 걸리므로 jest-environment-jsdom 경유로 쓴다.)
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  GOOGLE_NOT_CONNECTED_MESSAGE,
  GOOGLE_RECONNECT_MESSAGE,
} from '../src/services/google-tools'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const GoogleConnect = require('../public/js/google-connect')

const ROOT = path.resolve(__dirname, '..')
const SCHEDULE_HTML = fs.readFileSync(path.join(ROOT, 'public', 'schedule.html'), 'utf-8')

const ROW_HTML = `
<div class="google-row" id="googleRow">
  <div class="google-info">
    <div class="google-title">Google 연동 <span class="google-status" id="googleStatusLabel" data-state="unknown">확인 중…</span></div>
    <div class="google-desc" id="googleStatusDesc"></div>
  </div>
  <button id="googleConnectBtn" type="button" style="display:none;">연결하기</button>
  <button id="googleDisconnectBtn" type="button" style="display:none;">연결 해제</button>
</div>`

interface FakeLocation {
  href: string
  search: string
  pathname: string
}

function getDoc(): any {
  return (globalThis as any).document
}

function makeHarness(statusQueue: Array<Record<string, unknown>>, search = '') {
  const doc = getDoc()
  doc.body.innerHTML = ROW_HTML
  const calls: Array<{ url: string; method: string }> = []
  const location: FakeLocation = { href: '', search, pathname: '/schedule.html' }
  const history = { replaceState: jest.fn() }
  const fetchMock = jest.fn(async (url: string, opts?: { method?: string }) => {
    calls.push({ url, method: opts?.method || 'GET' })
    if (url === '/api/google/disconnect') return { json: async () => ({ ok: true }) }
    const next = statusQueue.shift() ?? { connected: false, configured: true }
    return { json: async () => next }
  })
  return { doc, calls, location, history, fetchMock }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 10))

describe('describeGoogleStatus — /api/google/status 응답 → 화면 표시', () => {
  test('연결됨 + 이메일: 연결됨 표시, 연결 버튼 숨김, 해제 버튼 표시', () => {
    const v = GoogleConnect.describeGoogleStatus({
      connected: true,
      email: 'jn817k@gmail.com',
      configured: true,
    })
    expect(v.label).toBe('연결됨')
    expect(v.state).toBe('connected')
    expect(v.desc).toContain('jn817k@gmail.com')
    expect(v.email).toBe('jn817k@gmail.com')
    expect(v.connectVisible).toBe(false)
    expect(v.disconnectVisible).toBe(true)
  })

  test('연결됨 + 이메일 없음: 여전히 연결됨, undefined이 desc에 새지 않음', () => {
    const v = GoogleConnect.describeGoogleStatus({ connected: true, configured: true })
    expect(v.label).toBe('연결됨')
    expect(v.desc).not.toContain('undefined')
    expect(v.disconnectVisible).toBe(true)
  })

  test('미연결 + 설정됨: 연결 안 됨 표시, 연결 버튼 활성화, 해제 버튼 숨김', () => {
    const v = GoogleConnect.describeGoogleStatus({ connected: false, configured: true })
    expect(v.label).toBe('연결 안 됨')
    expect(v.state).toBe('disconnected')
    expect(v.connectVisible).toBe(true)
    expect(v.connectDisabled).toBe(false)
    expect(v.disconnectVisible).toBe(false)
  })

  test('미연결 + 미설정(configured:false): 연결 버튼 비활성화', () => {
    const v = GoogleConnect.describeGoogleStatus({ connected: false, configured: false })
    expect(v.label).toBe('연결 안 됨')
    expect(v.connectVisible).toBe(true)
    expect(v.connectDisabled).toBe(true)
    expect(v.disconnectVisible).toBe(false)
  })

  test('미연결 + configured 미상: 연결 버튼 활성화 (구버전 응답 호환)', () => {
    const v = GoogleConnect.describeGoogleStatus({ connected: false })
    expect(v.connectVisible).toBe(true)
    expect(v.connectDisabled).toBe(false)
  })

  test('조회 실패(null): 상태 확인 불가, 연결 버튼은 보여 재시도 가능', () => {
    const v = GoogleConnect.describeGoogleStatus(null)
    expect(v.label).toBe('상태 확인 불가')
    expect(v.state).toBe('unknown')
    expect(v.connectVisible).toBe(true)
    expect(v.disconnectVisible).toBe(false)
  })
})

describe('googleCallbackNotice — ?google= 복귀 안내', () => {
  test.each([
    ['connected', 'Google 계정이 연결됐어요.'],
    ['denied', 'Google 연결이 거부됐어요. 다시 시도해 주세요.'],
    ['error', 'Google 연결 중 오류가 발생했어요. 다시 시도해 주세요.'],
  ])('%s → %s', (param, expected) => {
    expect(GoogleConnect.googleCallbackNotice(param)).toBe(expected)
  })

  test('알 수 없는 값·없음 → null', () => {
    expect(GoogleConnect.googleCallbackNotice('foo')).toBeNull()
    expect(GoogleConnect.googleCallbackNotice(null)).toBeNull()
    expect(GoogleConnect.googleCallbackNotice(undefined)).toBeNull()
  })
})

describe('init — jsdom + fetch 모의로 버튼 동작', () => {
  test('연결됨 상태: 라벨·설명·버튼 표시가 status 응답과 일치', async () => {
    const h = makeHarness([{ connected: true, email: 'jn817k@gmail.com', configured: true }])
    await GoogleConnect.init({
      doc: h.doc,
      fetchFn: h.fetchMock,
      location: h.location,
      history: h.history,
    })
    expect(h.fetchMock).toHaveBeenCalledWith('/api/google/status')
    expect(h.doc.getElementById('googleStatusLabel').textContent).toBe('연결됨')
    expect(h.doc.getElementById('googleStatusDesc').textContent).toContain('jn817k@gmail.com')
    expect(h.doc.getElementById('googleConnectBtn').style.display).toBe('none')
    expect(h.doc.getElementById('googleDisconnectBtn').style.display).toBe('')
  })

  test('미연결 상태: 연결 안 됨 표시 + 연결 버튼 클릭이 /api/google/oauth/start로 이동', async () => {
    const h = makeHarness([{ connected: false, configured: true }])
    await GoogleConnect.init({
      doc: h.doc,
      fetchFn: h.fetchMock,
      location: h.location,
      history: h.history,
    })
    expect(h.doc.getElementById('googleStatusLabel').textContent).toBe('연결 안 됨')
    expect(h.doc.getElementById('googleConnectBtn').style.display).toBe('')
    h.doc.getElementById('googleConnectBtn').click()
    expect(h.location.href).toBe('/api/google/oauth/start')
  })

  test('미설정 상태: 연결 버튼이 비활성화되고 클릭해도 이동하지 않음', async () => {
    const h = makeHarness([{ connected: false, configured: false }])
    await GoogleConnect.init({
      doc: h.doc,
      fetchFn: h.fetchMock,
      location: h.location,
      history: h.history,
    })
    const btn = h.doc.getElementById('googleConnectBtn')
    expect(btn.hasAttribute('disabled')).toBe(true)
    btn.click()
    expect(h.location.href).toBe('')
  })

  test('해제 버튼: POST /api/google/disconnect 호출 후 연결 안 됨으로 다시 표시', async () => {
    const h = makeHarness([
      { connected: true, email: 'jn817k@gmail.com', configured: true },
      { connected: false, configured: true },
    ])
    await GoogleConnect.init({
      doc: h.doc,
      fetchFn: h.fetchMock,
      location: h.location,
      history: h.history,
    })
    expect(h.doc.getElementById('googleStatusLabel').textContent).toBe('연결됨')
    h.doc.getElementById('googleDisconnectBtn').click()
    await flush()
    expect(h.calls).toContainEqual({ url: '/api/google/disconnect', method: 'POST' })
    expect(h.doc.getElementById('googleStatusLabel').textContent).toBe('연결 안 됨')
    expect(h.doc.getElementById('googleConnectBtn').style.display).toBe('')
  })

  test('?google=connected 복귀: 연결 안내를 보여주고 쿼리를 지운다 — 이메일도 함께 보인다', async () => {
    const h = makeHarness(
      [{ connected: true, email: 'jn817k@gmail.com', configured: true }],
      '?google=connected',
    )
    await GoogleConnect.init({
      doc: h.doc,
      fetchFn: h.fetchMock,
      location: h.location,
      history: h.history,
    })
    // 콜백 안내가 desc를 통째로 덮으면 이메일이 사라진다 (2026-10-28 QA 결함 ②).
    // 안내와 이메일 설명을 합쳐 둘 다 보여야 한다.
    expect(h.doc.getElementById('googleStatusDesc').textContent).toContain('Google 계정이 연결됐어요.')
    expect(h.doc.getElementById('googleStatusDesc').textContent).toContain('jn817k@gmail.com')
    expect(h.history.replaceState).toHaveBeenCalledWith(null, '', '/schedule.html')
  })

  test('?google=denied 복귀: 거부 안내를 보여준다', async () => {
    const h = makeHarness([{ connected: false, configured: true }], '?google=denied')
    await GoogleConnect.init({
      doc: h.doc,
      fetchFn: h.fetchMock,
      location: h.location,
      history: h.history,
    })
    expect(h.doc.getElementById('googleStatusDesc').textContent).toContain('거부됐어요')
  })

  test('status 조회 실패: 상태 확인 불가 표시', async () => {
    const h = makeHarness([])
    h.fetchMock.mockRejectedValueOnce(new Error('network down'))
    await GoogleConnect.init({
      doc: h.doc,
      fetchFn: h.fetchMock,
      location: h.location,
      history: h.history,
    })
    expect(h.doc.getElementById('googleStatusLabel').textContent).toBe('상태 확인 불가')
  })
})

describe('init — 쓰기 활성화 시 연결 버튼이 ?mode=write로 시작한다 (QA 결함 ①)', () => {
  test('writeEnabled:true → 연결 클릭이 /api/google/oauth/start?mode=write로 이동', async () => {
    const h = makeHarness([{ connected: false, configured: true, writeEnabled: true }])
    await GoogleConnect.init({
      doc: h.doc,
      fetchFn: h.fetchMock,
      location: h.location,
      history: h.history,
    })
    h.doc.getElementById('googleConnectBtn').click()
    expect(h.location.href).toBe('/api/google/oauth/start?mode=write')
  })

  test('writeEnabled:false → 연결 클릭이 읽기 전용 시작(기존 동작) 그대로', async () => {
    const h = makeHarness([{ connected: false, configured: true, writeEnabled: false }])
    await GoogleConnect.init({
      doc: h.doc,
      fetchFn: h.fetchMock,
      location: h.location,
      history: h.history,
    })
    h.doc.getElementById('googleConnectBtn').click()
    expect(h.location.href).toBe('/api/google/oauth/start')
  })

  test('writeEnabled 필드 없음(구버전 응답) → 읽기 전용 시작', async () => {
    const h = makeHarness([{ connected: false, configured: true }])
    await GoogleConnect.init({
      doc: h.doc,
      fetchFn: h.fetchMock,
      location: h.location,
      history: h.history,
    })
    h.doc.getElementById('googleConnectBtn').click()
    expect(h.location.href).toBe('/api/google/oauth/start')
  })

  test('해제 후 상태 재조회로 writeEnabled를 다시 읽는다 — 해제 전 false, 해제 후 true면 mode=write', async () => {
    const h = makeHarness([
      { connected: true, email: 'jn817k@gmail.com', configured: true, writeEnabled: false },
      { connected: false, configured: true, writeEnabled: true },
    ])
    await GoogleConnect.init({
      doc: h.doc,
      fetchFn: h.fetchMock,
      location: h.location,
      history: h.history,
    })
    h.doc.getElementById('googleDisconnectBtn').click()
    await flush()
    expect(h.doc.getElementById('googleStatusLabel').textContent).toBe('연결 안 됨')
    h.doc.getElementById('googleConnectBtn').click()
    expect(h.location.href).toBe('/api/google/oauth/start?mode=write')
  })

  test('status 조회 실패 시 연결 클릭은 읽기 전용 시작(안전 기본값)', async () => {
    const h = makeHarness([])
    h.fetchMock.mockRejectedValueOnce(new Error('network down'))
    await GoogleConnect.init({
      doc: h.doc,
      fetchFn: h.fetchMock,
      location: h.location,
      history: h.history,
    })
    h.doc.getElementById('googleConnectBtn').click()
    expect(h.location.href).toBe('/api/google/oauth/start')
  })
})

describe('init — 연결된 이메일 표시 (QA 결함 ②)', () => {
  test('연결됨 + 이메일 없음 + ?google=connected: 안내는 보이고 undefined이 새지 않음', async () => {
    const h = makeHarness(
      [{ connected: true, configured: true }],
      '?google=connected',
    )
    await GoogleConnect.init({
      doc: h.doc,
      fetchFn: h.fetchMock,
      location: h.location,
      history: h.history,
    })
    const desc = h.doc.getElementById('googleStatusDesc').textContent
    expect(desc).toContain('Google 계정이 연결됐어요.')
    expect(desc).not.toContain('undefined')
  })
})

describe('schedule.html 배선', () => {
  test('Google 연동 행·버튼·상태 요소가 있다', () => {
    for (const id of ['googleRow', 'googleStatusLabel', 'googleStatusDesc', 'googleConnectBtn', 'googleDisconnectBtn']) {
      expect(SCHEDULE_HTML).toContain(`id="${id}"`)
    }
    expect(SCHEDULE_HTML).toContain('Google 연동')
  })

  test('google-connect.js를 참조한다 (하드코딩된 ?v= 없음)', () => {
    expect(SCHEDULE_HTML).toContain('src="/js/google-connect.js"')
    expect(SCHEDULE_HTML).not.toMatch(/google-connect\.js\?v=/)
  })

  test('static-assets.json 집합에 google-connect.js가 있다', () => {
    const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'static-assets.json'), 'utf-8'))
    expect(list.files).toContain('/js/google-connect.js')
  })

  test('createVersioner가 google-connect.js에 ?v=를 붙인다 (구버전 캐시 방지)', () => {
    // ?v= 부착은 deploy_full.py의 고정 목록이 아니라 scripts/asset-version.cjs의
    // createVersioner(매니페스트 집합 기준)가 담당한다 (2026-11-01 교체).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createVersioner } = require('../scripts/asset-version.cjs')
    const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'static-assets.json'), 'utf-8'))
    const ver = createVersioner(list, 'testver1')
    expect(ver('<script src="/js/google-connect.js"></script>')).toContain(
      '/js/google-connect.js?v=testver1',
    )
    const deploy = fs.readFileSync(path.join(ROOT, 'deploy_full.py'), 'utf-8')
    expect(deploy).toContain('createVersioner')
  })
})

describe('AI 안내 문구 — 실제 버튼 위치를 가리킨다', () => {
  // 현행 설계 (사용자 확정): 'Google 연동'은 일정 화면 상단이 아니라
  // 설정 메뉴 안에 있다. 안내 문구도 그 위치를 가리켜야 한다.
  test('미연동 문구가 설정 메뉴의 Google 연동을 가리킨다', () => {
    expect(GOOGLE_NOT_CONNECTED_MESSAGE).toContain('설정 메뉴의 Google 연동')
    expect(GOOGLE_NOT_CONNECTED_MESSAGE).not.toContain('일정 화면 상단')
  })

  test('재연결 문구가 설정 메뉴의 Google 연동을 가리킨다', () => {
    expect(GOOGLE_RECONNECT_MESSAGE).toContain('설정 메뉴의 Google 연동')
    expect(GOOGLE_RECONNECT_MESSAGE).not.toContain('일정 화면 상단')
  })
})
