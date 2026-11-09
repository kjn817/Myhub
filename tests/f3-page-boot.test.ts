/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * F3 페이지 부팅 테스트 (2026-11-07) — 인라인 추출·CDN 로컬화·핸들러
 * 재배선을 거친 enforce 페이지들이 실페이지 로드 수준에서 실제로
 * 부팅하고, 재배선한 버튼이 동작하는지 고정한다.
 *
 * 하네스는 F2의 loadPage를 쓴다: CDN 스크립트는 로드되지 않으므로
 * (운영 enforce CSP와 동일 조건) 외부 참조가 되돌아오면 페이지가
 * 죽어 이 테스트가 실패한다 (카나리아).
 */
import { loadPage, jsonRes, until } from './f2-page-harness'

const okHandler = async () => jsonRes({ ok: true })

describe('F3 부팅: backup', () => {
  test('스크립트 오류 없이 부팅하고, 백업 버튼 클릭이 검증 오류를 띄운다', async () => {
    const page = loadPage('backup.html', okHandler)
    expect(page.externalSkipped).toEqual([])
    expect(page.errors).toEqual([])
    page.document.getElementById('backupBtn').click()
    const box = page.document.getElementById('errorBox')
    expect(box.classList.contains('show')).toBe(true)
    expect(box.textContent).toContain('비밀번호를 입력해주세요.')
  })
})

describe('F3 부팅: briefing', () => {
  test('브리핑을 불러와 렌더하고, 재시도 버튼이 다시 fetch한다', async () => {
    let fail = true
    const page = loadPage('briefing.html', async (url: string) => {
      if (url.includes('/api/briefing/today')) {
        if (fail) return jsonRes({ ok: false }, 500)
        return jsonRes({ date: '2026-11-07', timezone: 'Asia/Seoul', schedules: [], todos: [], memos: [], memories: [] })
      }
      return jsonRes({ ok: true })
    })
    // DOMContentLoaded 핸들러가 첫 로드를 건다
    page.document.dispatchEvent(new page.window.Event('DOMContentLoaded'))
    expect(await until(() => page.document.getElementById('btn-retry').style.display === 'inline-block')).toBe(true)
    fail = false
    page.document.getElementById('btn-retry').click()
    expect(await until(() => page.document.getElementById('briefing-date').textContent.includes('2026-11-07'))).toBe(true)
    expect(page.errors).toEqual([])
    expect(page.externalSkipped).toEqual([])
  })
})

describe('F3 부팅: search', () => {
  test('검색 결과가 data-href 카드로 렌더된다 (인라인 onclick 없음)', async () => {
    const page = loadPage('search.html', async (url: string) => {
      if (url.includes('/api/search')) {
        return jsonRes({ results: [{ source_type: 'memo', title: '검색 제목', snippet: '본문 일부', created_at: '2026-11-07T00:00:00' }] })
      }
      return jsonRes({ ok: true })
    })
    expect(page.errors).toEqual([])
    expect(page.externalSkipped).toEqual([])
    page.document.getElementById('q').value = '검색'
    page.document.getElementById('searchBtn').click()
    expect(await until(() => page.document.querySelector('.result') !== null)).toBe(true)
    const card = page.document.querySelector('.result')
    expect(card.getAttribute('data-href')).toBe('/memo.html')
    expect(card.getAttribute('onclick')).toBeNull()
    expect(card.querySelector('.title').textContent).toBe('검색 제목')
  })
})

describe('F3 부팅: todo', () => {
  test('할 일 목록이 렌더되고 refreshAfterAI가 전역에 있다', async () => {
    const page = loadPage('todo.html', async (url: string) => {
      if (url.includes('/api/todo/list')) return jsonRes({ todos: [{ id: 1, title: '테스트 할일', status: 'pending' }] })
      return jsonRes({ ok: true })
    })
    expect(page.externalSkipped).toEqual([])
    expect(page.errors).toEqual([])
    expect(typeof page.window.refreshAfterAI).toBe('function')
    expect(await until(() => page.document.body.textContent.includes('테스트 할일'))).toBe(true)
  })
})

describe('F3 부팅: key-rotation', () => {
  test('dry-run 버튼 클릭이 rotate API를 호출한다', async () => {
    // 운영 계약: dry-run 응답은 서버 실시간 census와 분류별 pending·already를
    // 함께 준다. pending+already 합계가 census와 전 항목 일치할 때만
    // 실행 버튼이 활성화된다 (fail-closed).
    const census = { memo_text: 4, memo_block: 0, google_token_row: 1, locked_file: 0 }
    const already = { memo_text: 0, memo_block: 0, google_token_row: 0, locked_file: 0 }
    const page = loadPage('key-rotation.html', async () =>
      jsonRes({ ok: true, census, pending: census, already, rotated: null }),
    )
    expect(page.externalSkipped).toEqual([])
    expect(page.errors).toEqual([])
    page.document.getElementById('newKey').value = 'test-new-key'
    page.document.getElementById('newKeyConfirm').value = 'test-new-key'
    page.document.getElementById('dryRunBtn').click()
    expect(await until(() => page.calls.some((c) => c.url.includes('/api/key-rotation/rotate') && c.method === 'POST'))).toBe(true)
    expect(await until(() => page.document.getElementById('executeBtn').disabled === false)).toBe(true)
  })
})

describe('F3 부팅: trace', () => {
  test('목록을 불러오고 새로고침 버튼이 다시 fetch한다', async () => {
    const page = loadPage('trace.html', async (url: string) => {
      if (url.includes('/api/ai/traces')) return jsonRes({ ok: true, traces: [] })
      return jsonRes({ ok: true })
    })
    expect(page.externalSkipped).toEqual([])
    expect(page.errors).toEqual([])
    expect(await until(() => page.calls.some((c) => c.url.includes('/api/ai/traces')))).toBe(true)
    const before = page.calls.length
    page.document.getElementById('refreshBtn').click()
    expect(await until(() => page.calls.length > before)).toBe(true)
  })
})

describe('F3 부팅: sheet', () => {
  test('시트 페이지가 부팅하고 gridcraft 브리지가 엔진 iframe을 GC_URL로 건다', () => {
    const page = loadPage('sheet.html', okHandler)
    expect(page.externalSkipped).toEqual([])
    // 운영 sheet-gridcraft.js는 #sheetApp이 있는 문서에서 스스로 브리지를
    // 마운트한다 (sheet-bridge.js는 운영에 없는 재구축 파일이라 계약에서
    // 제외). 브리지 iframe src는 GC_URL(host=parent)이 정본이다.
    const G = page.window.MyHubSheetGridcraft
    expect(G).toBeDefined()
    expect(G.GC_URL).toContain('/vendor/gridcraft/index.html')
    expect(G.GC_URL).toContain('host=parent')
    const mount = page.document.createElement('div')
    mount.id = 'sheetApp'
    page.document.body.appendChild(mount)
    // 스크립트 재평가로 자체 마운트 경로를 태운다
    page.window.eval('') // noop — 마운트는 로드 시점에만 일어나므로 직접 createBridge로 확인
    const bridge = G.createBridge({
      document: page.document,
      window: page.window,
      root: mount,
      postToParent: () => undefined,
      fonts: null,
      fetchFn: async () => {
        throw new Error('offline')
      },
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => undefined,
    })
    const frame = mount.querySelector('iframe.sheet-gc-frame')
    expect(frame).not.toBeNull()
    expect(frame.getAttribute('src')).toContain('/vendor/gridcraft/index.html')
    expect(frame.getAttribute('src')).toContain('host=parent')
    bridge.destroy()
  })
})

describe('F3 부팅: office', () => {
  test('스크립트 오류 없이 부팅하고 노바 패널 버튼이 초기화된다', async () => {
    const page = loadPage('office.html', okHandler)
    expect(page.externalSkipped).toEqual([])
    expect(page.errors).toEqual([])
    // F4 (2026-11-07): 오피스는 범용 위젯(AssistantWidget)이 아니라 전용
    // office-assistant 패널이 정본이다 — #officeAssistantBtn이 생기고
    // 셸이 이를 상단바에 프록시한다. 위젯 기준 기대는 F4에서 교체됐다.
    expect(await until(() => page.document.querySelector('#officeAssistantBtn') !== null, 3000)).toBe(true)
    expect(page.document.querySelector('#officeAssistant .oa-panel')).not.toBeNull()
  })
})

describe('F3 부팅: schedule (스타일 추출만 — 동작 불변 확인)', () => {
  test('스크립트 오류 없이 부팅한다', () => {
    const page = loadPage('schedule.html', okHandler)
    expect(page.externalSkipped).toEqual([])
    expect(page.errors).toEqual([])
  })
})
