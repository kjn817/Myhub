/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 앱 표면 발산 수정 고정 (2026-11-11 앱 대조 카탈로그 기반).
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - 채팅 상단 메뉴 첫 라벨이 운영 정본 '대화'다 (트리 발산: '파일').
 * - 일정 페이지 달력 위에 알림 안내 문구(#pushNotice)가 있다.
 * - Finder: 상단 메뉴 [파일·보기·이동], 임베드 시 창 제목
 *   '찾기 / 보관함' 게시, 하단 좌측 선택 표시 '보관함 선택'.
 *   (도움말은 항목 내용 미회수로 빈 라벨만 게시되던 것을 2026-11-12
 *   사용자 결정으로 제거했다 — 게시하는 메뉴는 전부 실동작해야 한다.)
 * - 스튜디오: 상단 메뉴를 게시하지 않는다 (빈 라벨 5종을 2026-11-12
 *   사용자 결정으로 제거 — 위와 같은 이유), 웰컴 정본 문구, 입력
 *   placeholder, 좌측 '검색…' 입력란+필터, 공유 win-action, 기본
 *   문서 제목 '제목 없음.ai' 게시.
 * - 시트 호스트: 문서가 열리면 OfficeTabs에 Excel 메뉴 8종을
 *   kind 'menu'로 게시하고, menu-request에 provideMenuItems로 답한다.
 */
import * as fs from 'fs'
import * as path from 'path'
import { loadPage, until, jsonRes, PUB, type Handler } from './f2-page-harness'

const read = (rel: string) => fs.readFileSync(path.join(PUB, rel), 'utf-8')

function fakeParent(posted: any[]) {
  return {
    postMessage: (msg: any) => {
      posted.push(msg)
    },
  }
}
function installFakeParent(w: any, posted: any[]) {
  try {
    Object.defineProperty(w, 'parent', { value: fakeParent(posted), configurable: true })
  } catch (e) {
    /* jsdom이 허용하지 않으면 게시 캡처 없이 DOM 단언만으로 검증한다 */
  }
}

/* ================= 채팅: 첫 메뉴 라벨 ================= */
describe('채팅 상단 메뉴 (정본: 대화·대화 목록·참여자)', () => {
  const handler: Handler = (url: string, init: any) => {
    if (url.startsWith('/api/ai/personas')) return jsonRes([{ id: 'concierge', name: '루미', avatar: '', desc: '대표 비서' }])
    if (url.startsWith('/api/ai/conversations')) return jsonRes({ ok: true, conversations: [], hasMore: false })
    if (url.startsWith('/api/ai/room-history')) return jsonRes({ ok: true, messages: [], hasMore: false })
    if (url.startsWith('/api/ai/models')) return jsonRes({ ok: true, models: [] })
    if (url.startsWith('/api/ai/settings')) return jsonRes({ ok: true, settings: {} })
    if (url.startsWith('/api/ai/quota')) return jsonRes({ ok: true, usage: [], budgets: {} })
    return jsonRes({ ok: true })
  }

  it("MyHubMenus 첫 라벨이 '대화'이고 전체 순서가 정본과 같다", async () => {
    const page = loadPage('chat.html', handler)
    expect(await until(() => Array.isArray((page.window as any).MyHubMenus))).toBe(true)
    const labels = (page.window as any).MyHubMenus.map((m: any) => m.label)
    expect(labels).toEqual(['대화', '대화 목록', '참여자'])
    // 페이지의 비동기 초기화가 이 DOM이 살아 있을 때 끝나도록 정착시킨다
    // (다음 테스트의 loadPage가 본문을 교체한 뒤 잔여 작업이 돌면
    //  없는 요소를 만져 무관한 테스트가 실패로 물든다).
    expect(await until(() => page.calls.some((c) => c.url.startsWith('/api/ai/room-history')))).toBe(true)
    await new Promise((r) => setTimeout(r, 400))
  })
})

/* ================= 일정: 알림 안내 문구 ================= */
describe('일정 알림 안내 문구', () => {
  const handler: Handler = (url: string) => {
    if (url.startsWith('/api/schedule/list')) return jsonRes({ schedules: [] })
    if (url.startsWith('/api/google/status')) return jsonRes({ connected: false })
    return jsonRes({})
  }

  it('달력 위에 안내 문구가 있고 문구는 운영 실측 전문과 같다', async () => {
    const page = loadPage('schedule.html', handler)
    const el = page.document.getElementById('pushNotice')
    expect(el).toBeTruthy()
    expect(el!.textContent).toBe('일정 알림은 이 기기에서 알림을 켠 경우에만 와요. 아이폰에서는 Safari의 공유 메뉴에서 ‘홈 화면에 추가’한 뒤, 그 아이콘으로 연 MyHub에서 알림 버튼을 켜야 해요.')
    // 달력 격자보다 문서 순서상 앞에 있다 (달력 위 배치)
    const grid = page.document.getElementById('calGrid')
    expect(el!.compareDocumentPosition(grid!) & 4 /* DOCUMENT_POSITION_FOLLOWING */).toBeTruthy()
  })
})

/* ================= Finder ================= */
describe('Finder (상단 메뉴·창 제목·하단 선택 표시)', () => {
  const LIST = {
    folder: null,
    folders: [
      { id: 11, name: '다운로드', created_at: '2026-11-04T06:29:00' },
      { id: 12, name: '문서', created_at: '2026-11-04T06:29:00' },
      { id: 13, name: '바탕화면', created_at: '2026-11-02T09:03:00' },
    ],
    files: [{ id: 21, filename: '메모.txt', size: 128, created_at: '2026-11-08T10:00:00', mime: 'text/plain' }],
  }
  const handler: Handler = (url: string) => {
    if (url.includes('/api/drive/list')) return jsonRes(LIST)
    if (url.includes('/api/drive/usage')) return jsonRes({ files: 4, bytes: 3450000 })
    if (url.includes('/api/drive/recent')) return jsonRes({ folders: [], files: [] })
    if (url.includes('/api/drive/trash')) return jsonRes({ folders: [], files: [] })
    return jsonRes({})
  }

  it('상단 메뉴가 [파일·보기·이동]이고 하단 좌측에 보관함 선택이 표시된다', async () => {
    const page = loadPage('finder.html', handler)
    expect(await until(() => page.document.querySelectorAll('.finder-row').length >= 4)).toBe(true)
    const labels = ((page.window as any).MyHubMenus || []).map((m: any) => m.label)
    expect(labels).toEqual(['파일', '보기', '이동'])
    expect(page.document.getElementById('finderSelStatus')!.textContent).toBe('보관함 선택')
    expect(page.document.getElementById('finderStatus')!.textContent).toBe('4개 항목')
    await new Promise((r) => setTimeout(r, 400))
  })

  it("임베드(셸)에서는 창 제목을 '찾기 / 보관함'으로 게시한다", async () => {
    const posted: any[] = []
    const page = loadPage('finder.html', handler, (w) => installFakeParent(w, posted))
    expect(await until(() => page.document.querySelectorAll('.finder-row').length >= 4)).toBe(true)
    const titles = posted.filter((m) => m && m.type === 'myhub:doc-title').map((m) => m.name)
    expect(titles.length).toBeGreaterThan(0)
    expect(titles[titles.length - 1]).toBe('찾기 / 보관함')
    await new Promise((r) => setTimeout(r, 400))
  })

  // 행 클릭 → 'N개 선택' 전이는 별도 파일(f2-finder-selstatus-20261111)
  // 에서 검증한다: 이 파일에서는 앞선 페이지(일정·채팅)의 document
  // 리스너가 같은 jsdom 창에 남아 클릭에 끼어드는 환경 artifact가 있어
  // 격리한다 (실제품은 앱마다 별도 문서라 무관하다).
})

/* ================= AI 스튜디오 ================= */
describe('AI 스튜디오 (메뉴·웰컴·검색·제목·공유)', () => {
  const project = { id: 7, title: '임시 도우미 앱', type: 'html', status: 'draft', created_at: '2026-11-07 00:00:00' }
  const handler: Handler = (url: string, init: any) => {
    const p = url.replace('/api/artifact', '')
    if (p === '/') return jsonRes({ ok: true, data: [] })
    if (p === '/drafts') return jsonRes({ ok: true, data: [project] })
    if (p === '/jobs') return jsonRes({ ok: true, data: [] })
    if (p.startsWith('/chats')) return jsonRes({ ok: true, data: [] })
    return jsonRes({ ok: true, data: [] })
  }
  function loadStudio(posted?: any[]) {
    return loadPage('agent.html', handler, (w) => {
      // 하네스는 jsdom 창을 페이지마다 공유한다 — 앞선 Finder 페이지가 남긴
      // window.MyHubMenus를 지워야 스튜디오가 메뉴를 게시하지 않는다는 것을
      // 제대로 검증할 수 있다 (실제품은 앱마다 별도 문서라 무관하다).
      delete (w as any).MyHubMenus
      w.confirm = () => false
      w.alert = () => {}
      w.CodeMirror = Object.assign(function () {}, {
        fromTextArea: () => ({ getValue: () => '', setValue() {}, on() {}, setOption() {} }),
      })
      if (posted) installFakeParent(w, posted)
    })
  }

  it('상단 메뉴를 게시하지 않는다 (빈 라벨 5종 제거, 2026-11-12)', async () => {
    const page = loadStudio()
    await new Promise((r) => setTimeout(r, 300))
    // 빈 항목의 라벨만 게시되던 스튜디오 메뉴 5종은 눌러도 아무 일도 안 해
    // 2026-11-12 사용자 결정으로 제거했다 — MyHubMenus 자체가 없어야 한다.
    expect((page.window as any).MyHubMenus).toBeUndefined()
  })

  it('웰컴 문구·placeholder·검색란이 정본이고 템플릿 카드는 없다', async () => {
    const page = loadStudio()
    const welcome = page.document.getElementById('welcomePane')
    expect(welcome?.querySelector('h2')?.textContent).toBe('안녕하세요, JN님')
    expect(welcome?.querySelector('p')?.textContent).toBe('오늘은 무엇을 도와드릴까요?')
    expect(page.document.querySelectorAll('.tpl-card').length).toBe(0)
    expect((page.document.getElementById('chatInput') as any).getAttribute('placeholder')).toBe('무엇이든 물어보세요')
    const search = page.document.getElementById('sbSearchInput') as any
    expect(search).toBeTruthy()
    expect(search.getAttribute('placeholder')).toBe('검색…')
  })

  it('검색 입력이 프로젝트 목록을 제목으로 거른다', async () => {
    const page = loadStudio()
    expect(await until(() => (page.document.getElementById('sbProjects')?.textContent || '').includes(project.title))).toBe(true)
    ;(page.window as any).setSbQuery('없는제목xyz')
    expect((page.document.getElementById('sbProjects')?.textContent || '').includes(project.title)).toBe(false)
    ;(page.window as any).setSbQuery('임시')
    expect((page.document.getElementById('sbProjects')?.textContent || '').includes(project.title)).toBe(true)
  })

  it("새 채팅 웰컴도 정본 문구이고, 기본 문서 제목 '제목 없음.ai'와 공유 액션이 게시된다", async () => {
    const posted: any[] = []
    const page = loadStudio(posted)
    expect(await until(() => posted.some((m) => m && m.type === 'myhub:doc-title' && m.name === '제목 없음.ai'))).toBe(true)
    const actions = posted.filter((m) => m && m.type === 'myhub:win-actions').pop()
    expect(actions).toBeTruthy()
    expect(actions.actions.map((a: any) => a.id)).toContain('studio-share')
    ;(page.window as any).newChat()
    const h2 = page.document.querySelector('#chatInner .welcome h2')
    expect(h2?.textContent).toBe('안녕하세요, JN님')
  })
})

/* ================= Excel(시트 호스트) 메뉴 게시 ================= */
describe('시트 호스트 OfficeTabs 메뉴 게시', () => {
  it('문서가 열리면 메뉴 8종을 게시하고 menu-request에 빈 항목으로 답한다', async () => {
    const w: any = (globalThis as any).window
    const registered: Record<string, Function> = {}
    const states: any[] = []
    const commands: Record<string, Function> = {}
    const provided: any[] = []
    w.MyHubFinderViewer = {
      registerFormat: (ext: string, fn: Function) => {
        registered[ext] = fn
      },
    }
    w.MyHubOfficeTabs = {
      setState: (app: string, state: any) => states.push({ app, state }),
      onCommand: (app: string, fn: Function) => {
        commands[app] = fn
      },
      onQuick: () => {},
      setQuick: () => {},
      provideMenuItems: (app: string, id: string, items: any[], seq: number) =>
        provided.push({ app, id, items, seq }),
    }
    try {
      w.eval(read('js/finder-format-sheet.js'))
      expect(typeof registered['xlsx']).toBe('function')
      const body = w.document.createElement('div')
      w.document.body.appendChild(body)
      const ctx: any = {
        doc: w.document,
        body,
        file: { name: '새 통합 문서.xlsx' }, // fileId 없음 → 새 문서 경로로 mountSheet 직행
        minimalChrome: true,
        clearBody() {},
        isCurrent: () => true,
        isFolded: () => false,
        setSaveHandler() {},
        setNote() {},
        setStatus() {},
        saveBtn: null,
      }
      await registered['xlsx'](ctx)
      const pub = states.find((s) => s.app === 'excel' && s.state && Array.isArray(s.state.tabs))
      expect(pub).toBeTruthy()
      expect(pub.state.tabs.map((t: any) => t.label)).toEqual([
        '파일', '편집', '보기', '삽입', '데이터', '도구', '자동화', '설정',
      ])
      expect(pub.state.tabs.every((t: any) => t.kind === 'menu')).toBe(true)
      expect(pub.state.menuShell).toBe(true)
      expect(typeof commands['excel']).toBe('function')
      commands['excel']({ type: 'menu-request', id: 'file', seq: 7 })
      expect(provided).toEqual([{ app: 'excel', id: 'file', items: [], seq: 7 }])
    } finally {
      delete w.MyHubFinderViewer
      delete w.MyHubOfficeTabs
    }
  })
})
