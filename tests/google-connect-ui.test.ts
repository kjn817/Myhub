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

interface FakeLocation {
  href: string
  search: string
  pathname: string
}

function getDoc(): any {
  return (globalThis as any).document
}

// 운영 google-connect.js는 일정 화면 행이 아니라 설정 메뉴 패널이다:
// createConnectMenu(deps)가 .g-nav를 가진 최상위 문서에 #myhubConnectMenu
// 패널을 만들고, 설정 메뉴 항목(onSelect → openMenu)으로 열린다.
function makeHarness(statusQueue: Array<Record<string, unknown>>, search = '') {
  const doc = getDoc()
  doc.body.innerHTML = '<header class="g-nav"></header>'
  const win = getWin()
  const calls: Array<{ url: string; method: string }> = []
  const location: FakeLocation = { href: '', search, pathname: '/schedule.html' }
  const history = { replaceState: jest.fn() }
  const fetchMock = jest.fn(async (url: string, opts?: { method?: string }) => {
    calls.push({ url, method: opts?.method || 'GET' })
    if (url === '/api/google/disconnect') return { json: async () => ({ ok: true }) }
    const next = statusQueue.shift() ?? { connected: false, configured: true }
    return { json: async () => next }
  })
  const registered: any[] = []
  const nav = {
    addSettingsItems: (items: any[]) => {
      registered.push(...items)
    },
  }
  const root: any = GoogleConnect.createConnectMenu({
    doc,
    win,
    fetchFn: fetchMock,
    location,
    history,
    nav,
  })
  const q = (sel: string): any => root.querySelector(sel)
  return {
    doc,
    root,
    calls,
    location,
    history,
    fetchMock,
    registered,
    // onSelect는 openMenu의 promise를 돌려주지 않으므로 flush로 렌더를 기다린다
    open: async () => {
      registered[0].onSelect()
      await flush()
    },
    pill: () => q('.myhub-connect-pill'),
    desc: () => q('.myhub-connect-desc'),
    note: () => q('.myhub-connect-note'),
    connectBtn: () => q('.myhub-connect-action.solid'),
    disconnectBtn: () => q('.myhub-connect-action.ghost'),
  }
}

function getWin(): any {
  return (globalThis as any).window
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

describe('createConnectMenu — 설정 메뉴 패널 동작 (jsdom + fetch 모의)', () => {
  test('설정 메뉴에 Google 연동 항목이 등록되고, 패널은 닫힌 상태로 만들어진다', () => {
    const h = makeHarness([{ connected: true, configured: true }])
    expect(h.root).not.toBeNull()
    expect(h.root.id).toBe('myhubConnectMenu')
    expect(h.root.hidden).toBe(true)
    expect(h.registered).toHaveLength(1)
    expect(h.registered[0].id).toBe('google-connect')
    expect(h.registered[0].label).toBe('Google 연동')
    expect(h.doc.querySelector('.myhub-connect-panel').getAttribute('aria-label')).toBe('Google 연동')
  })

  test('.g-nav가 없는 문서에서는 패널을 만들지 않는다', () => {
    const doc = getDoc()
    doc.body.innerHTML = '<main></main>'
    const root = GoogleConnect.createConnectMenu({
      doc,
      win: getWin(),
      fetchFn: jest.fn(),
      location: { href: '', search: '', pathname: '/' },
      history: { replaceState: jest.fn() },
      nav: { addSettingsItems: jest.fn() },
    })
    expect(root).toBeNull()
  })

  test('연결됨 상태: 라벨·설명·버튼 표시가 status 응답과 일치', async () => {
    const h = makeHarness([{ connected: true, email: 'jn817k@gmail.com', configured: true }])
    await h.open()
    expect(h.root.hidden).toBe(false)
    expect(h.fetchMock).toHaveBeenCalledWith('/api/google/status')
    expect(h.pill().textContent).toBe('연결됨')
    expect(h.pill().getAttribute('data-state')).toBe('connected')
    expect(h.desc().textContent).toContain('jn817k@gmail.com')
    expect(h.connectBtn().style.display).toBe('none')
    expect(h.disconnectBtn().style.display).toBe('')
    expect(h.note().textContent).toBe('읽기 전용')
  })

  test('미연결 상태: 연결 안 됨 표시 + 연결 버튼 클릭이 /api/google/oauth/start로 이동', async () => {
    const h = makeHarness([{ connected: false, configured: true }])
    await h.open()
    expect(h.pill().textContent).toBe('연결 안 됨')
    expect(h.connectBtn().style.display).toBe('')
    h.connectBtn().click()
    expect(h.location.href).toBe('/api/google/oauth/start')
  })

  test('미설정 상태: 연결 버튼이 비활성화되고 클릭해도 이동하지 않음', async () => {
    const h = makeHarness([{ connected: false, configured: false }])
    await h.open()
    const btn = h.connectBtn()
    expect(btn.hasAttribute('disabled')).toBe(true)
    btn.click()
    expect(h.location.href).toBe('')
  })

  test('해제 버튼: POST /api/google/disconnect 호출 후 연결 안 됨으로 다시 표시', async () => {
    const h = makeHarness([
      { connected: true, email: 'jn817k@gmail.com', configured: true },
      { connected: false, configured: true },
    ])
    await h.open()
    expect(h.pill().textContent).toBe('연결됨')
    h.disconnectBtn().click()
    await flush()
    expect(h.calls).toContainEqual({ url: '/api/google/disconnect', method: 'POST' })
    expect(h.pill().textContent).toBe('연결 안 됨')
    expect(h.connectBtn().style.display).toBe('')
  })

  test('?google=connected 복귀: 패널이 자동으로 열리고 안내와 이메일을 함께 보여주며 쿼리를 지운다', async () => {
    const h = makeHarness(
      [{ connected: true, email: 'jn817k@gmail.com', configured: true }],
      '?google=connected',
    )
    await flush()
    // 콜백 안내가 desc를 통째로 덮으면 이메일이 사라진다 (2026-10-28 QA 결함 ②).
    // 안내와 이메일 설명을 합쳐 둘 다 보여야 한다.
    expect(h.root.hidden).toBe(false)
    expect(h.desc().textContent).toContain('Google 계정이 연결됐어요.')
    expect(h.desc().textContent).toContain('jn817k@gmail.com')
    expect(h.history.replaceState).toHaveBeenCalledWith(null, '', '/schedule.html')
  })

  test('?google=denied 복귀: 거부 안내를 보여준다', async () => {
    const h = makeHarness([{ connected: false, configured: true }], '?google=denied')
    await flush()
    expect(h.desc().textContent).toContain('거부됐어요')
  })

  test('status 조회 실패: 상태 확인 불가 표시', async () => {
    const h = makeHarness([])
    h.fetchMock.mockRejectedValueOnce(new Error('network down'))
    await h.open()
    expect(h.pill().textContent).toBe('상태 확인 불가')
    expect(h.connectBtn().style.display).toBe('')
  })
})

describe('createConnectMenu — 쓰기 활성화 시 연결 버튼이 ?mode=write로 시작한다 (QA 결함 ①)', () => {
  test('writeEnabled:true → 연결 클릭이 /api/google/oauth/start?mode=write로 이동 + 쓰기 가능 고지', async () => {
    const h = makeHarness([{ connected: false, configured: true, writeEnabled: true }])
    await h.open()
    // 고지 문구의 가운데점(·) 유무는 전사 경계 근사 영역이라 단언하지 않는다
    expect(h.note().textContent).toContain('쓰기 가능')
    expect(h.note().textContent).not.toBe('읽기 전용')
    h.connectBtn().click()
    expect(h.location.href).toBe('/api/google/oauth/start?mode=write')
  })

  test('writeEnabled:false → 연결 클릭이 읽기 전용 시작(기존 동작) 그대로', async () => {
    const h = makeHarness([{ connected: false, configured: true, writeEnabled: false }])
    await h.open()
    h.connectBtn().click()
    expect(h.location.href).toBe('/api/google/oauth/start')
  })

  test('writeEnabled 필드 없음(구버전 응답) → 읽기 전용 시작', async () => {
    const h = makeHarness([{ connected: false, configured: true }])
    await h.open()
    h.connectBtn().click()
    expect(h.location.href).toBe('/api/google/oauth/start')
  })

  test('해제 후 상태 재조회로 writeEnabled를 다시 읽는다 — 해제 전 false, 해제 후 true면 mode=write', async () => {
    const h = makeHarness([
      { connected: true, email: 'jn817k@gmail.com', configured: true, writeEnabled: false },
      { connected: false, configured: true, writeEnabled: true },
    ])
    await h.open()
    h.disconnectBtn().click()
    await flush()
    expect(h.pill().textContent).toBe('연결 안 됨')
    h.connectBtn().click()
    expect(h.location.href).toBe('/api/google/oauth/start?mode=write')
  })

  test('status 조회 실패 시 연결 클릭은 읽기 전용 시작(안전 기본값)', async () => {
    const h = makeHarness([])
    h.fetchMock.mockRejectedValueOnce(new Error('network down'))
    await h.open()
    h.connectBtn().click()
    expect(h.location.href).toBe('/api/google/oauth/start')
  })
})

describe('createConnectMenu — 연결된 이메일 표시 (QA 결함 ②)', () => {
  test('연결됨 + 이메일 없음 + ?google=connected: 안내는 보이고 undefined이 새지 않음', async () => {
    const h = makeHarness([{ connected: true, configured: true }], '?google=connected')
    await flush()
    const desc = h.desc().textContent
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

describe('wireInlineStatusRow — 일정 상단 인라인 상태 행 배선 (회귀: 확인 중… 고정)', () => {
  function buildRow() {
    const doc = getDoc()
    doc.body.innerHTML =
      '<span id="googleStatusLabel" data-state="unknown">확인 중…</span>' +
      '<div id="googleStatusDesc">Gmail·캘린더 연동 상태를 확인하고 있어요.</div>' +
      '<button id="googleConnectBtn" type="button" style="display:none;">연결하기</button>' +
      '<button id="googleDisconnectBtn" type="button" style="display:none;">연결 해제</button>'
    return doc
  }

  test('상태 응답이 오면 라벨이 확인 중…에서 연결됨으로 바뀌고 버튼이 맞게 토글된다', async () => {
    const doc = buildRow()
    const fetchFn = jest.fn(async () => ({
      json: async () => ({ connected: true, configured: true, email: 'jn817k@gmail.com', writeEnabled: true }),
    }))
    const load = GoogleConnect.wireInlineStatusRow(doc, fetchFn, { href: '' })
    expect(typeof load).toBe('function')
    await load()
    const label = doc.getElementById('googleStatusLabel')
    expect(label.textContent).toBe('연결됨')
    expect(label.getAttribute('data-state')).toBe('connected')
    expect(doc.getElementById('googleStatusDesc').textContent).toContain('jn817k@gmail.com')
    expect(doc.getElementById('googleConnectBtn').style.display).toBe('none')
    expect(doc.getElementById('googleDisconnectBtn').style.display).toBe('')
    expect(fetchFn).toHaveBeenCalledWith('/api/google/status')
  })

  test('조회 실패 시 상태 확인 불가로 정직하게 표시된다', async () => {
    const doc = buildRow()
    const fetchFn = jest.fn(async () => { throw new Error('network') })
    const load = GoogleConnect.wireInlineStatusRow(doc, fetchFn, { href: '' })
    await load()
    expect(doc.getElementById('googleStatusLabel').textContent).toBe('상태 확인 불가')
    expect(doc.getElementById('googleConnectBtn').style.display).toBe('')
  })

  test('인라인 행이 없는 페이지에서는 아무 것도 하지 않는다', () => {
    const doc = getDoc()
    doc.body.innerHTML = '<div></div>'
    expect(GoogleConnect.wireInlineStatusRow(doc, jest.fn(), { href: '' })).toBeNull()
  })
})
