/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * F4 프론트 회귀 테스트 (2026-11-07 운영 QA 2차 실패의 카나리아).
 *
 * 검증하는 성질:
 * 1. office-fetch 계약 (운영 재건 기준): office-fetch는 CRUD 클라이언트가
 *    아니라 /api/drive/files/:id/content GET 전용 인터셉터다 — 기대
 *    version이 등록돼 있고 캐시가 일치하면 네트워크 없이 shim 응답,
 *    스트리밍 받으면 진행률을 알리고 다 받으면 캐시에 넣는다. 대상이
 *    아닌 요청은 baseFetch로 그대로 통과한다.
 * 2. 비서 코어 결과 합성 (createCore.runInstruction → emit.say):
 *    실패가 답변보다 먼저 나오고, 서버 validationErrors가 표면화되며,
 *    실패 시 "적용 전에 작성된 내용" 고지가 붙는다. 전부 성공이면
 *    답변 + "연산 N개를 적용했어요"가 붙는다.
 * 3. 세션 순수 변환: sheet.read 결과 → SheetSnapshot (수식은 {f}, 값은
 *    {v}), slide.inspect 조립 (텍스트 400자 절단·빈 자리표시자 text:""),
 *    적용 검증(verifyTextSet/Replace/InsertTextBox)은 전후 스냅샷이
 *    다르면 실패로 센다.
 * 4. 한글 바이트 경로 연산(applyHwpOp): 문단 추가·첫 일치 치환·표 삽입이
 *    HwpDocument API 계약대로 동작한다 (가짜 문서로 검증 — 실엔진 왕복은
 *    실브라우저 하네스 몫).
 * 5. 할 일 삭제: 네이티브 confirm()을 쓰지 않고 인페이지 모달로 확인한
 *    뒤에야 DELETE가 나간다 (confirm 게이트가 조용히 false로 떨어져
 *    삭제가 무반응이던 결함의 카나리아).
 * 6. GridCraft exec 채널: 부모의 myhub-sheet:ops가 opsToCommands로
 *    번역돼 gridcraft:exec(tag)로 엔진에 나가고, exec-result가
 *    aggregateExecResults로 합산돼 myhub-sheet:ops-result로 돌아온다.
 * 7. 코어 instruct 흐름: 지시가 세션 스냅샷과 함께 POST /instruct로
 *    나가고, 스냅샷이 동기적으로 던져도 null로 접혀 흐름이 멈추지
 *    않는다 (busy 해제 — F6 카나리아).
 */
import * as fs from 'fs'
import * as path from 'path'

const W: any = (globalThis as any).window
const DOC: any = (globalThis as any).document
const ROOT = path.resolve(__dirname, '..')
const PUB = path.join(ROOT, 'public')
function readPub(p: string): string {
  return fs.readFileSync(path.join(PUB, p), 'utf-8')
}

type FetchCall = { url: string; init?: RequestInit }
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  // jsdom 환경에는 fetch Response가 없어 표면(ok/status/json/blob/headers)만
  // 흉내 낸 가짜 응답을 쓴다 (f2-page-harness와 같은 방식).
  const text = JSON.stringify(body)
  const lower: Record<string, string> = {}
  Object.entries({ 'Content-Type': 'application/json', ...headers }).forEach(([k, v]) => { lower[k.toLowerCase()] = v })
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => (n.toLowerCase() in lower ? lower[n.toLowerCase()] : null) },
    json: async () => body,
    text: async () => text,
    blob: async () => new Blob([text]),
    body: null,
  } as unknown as Response
}
const tick = () => new Promise((r) => setTimeout(r, 0))

/* ---------- 1. office-fetch 계약 (내용 캐시 + 진행 표시 인터셉터) ---------- */
describe('office-fetch — content 인터셉터 계약', () => {
  let F: any

  beforeAll(() => {
    const g = globalThis as any
    // jsdom 환경에 없는 TextDecoder를 Node util로 보충 (shim text() 경로용)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const util = require('util')
    if (typeof g.TextDecoder === 'undefined') g.TextDecoder = util.TextDecoder
    g.eval(readPub('/js/office-fetch.js'))
    F = g.MyHubOfficeFetch
  })

  function streamResponse(chunks: Uint8Array[], total?: number): any {
    let i = 0
    return {
      ok: true,
      status: 200,
      headers: {
        get: (n: string) => (n.toLowerCase() === 'content-length' && total != null ? String(total) : null),
      },
      body: {
        getReader: () => ({
          read: async () =>
            i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
        }),
      },
    }
  }

  // 이 jsdom 환경에는 TextEncoder가 없어 ASCII 범위에서 직접 만든다
  const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))

  test('대상 아닌 URL·메서드는 baseFetch로 그대로 통과한다', async () => {
    const seen: Array<[string, unknown]> = []
    const baseRes = { ok: true, marker: 'base' }
    const of = F.createOfficeFetch({
      fetchFn: async (url: string, opts?: unknown) => {
        seen.push([url, opts])
        return baseRes
      },
      onProgress: () => undefined,
    })
    await expect(of.fetch('/api/drive/files', { method: 'POST' })).resolves.toBe(baseRes)
    await expect(of.fetch('/api/drive/files/9/content', { method: 'PUT' })).resolves.toBe(baseRes)
    await expect(of.fetch('/api/memo/list')).resolves.toBe(baseRes)
    expect(seen).toHaveLength(3)
  })

  test('스트리밍 다운로드는 진행률을 알리고, 다 받으면 전체 바이트의 shim 응답을 돌려준다', async () => {
    const phases: any[] = []
    const of = F.createOfficeFetch({
      fetchFn: async () => streamResponse([bytes('hel'), bytes('lo')], 5),
      onProgress: (p: any) => phases.push(p),
    })
    const res: any = await of.fetch('/api/drive/files/9/content')
    expect(res.ok).toBe(true)
    expect(await res.text()).toBe('hello')
    expect(phases[0]).toEqual({ phase: 'download', got: 0, total: 5 })
    expect(phases[phases.length - 1]).toEqual({ phase: 'parse' })
    const downloads = phases.filter((p) => p.phase === 'download').map((p) => p.got)
    expect(downloads).toEqual([0, 3, 5])
  })

  test('expectVersion이 일치하면 두 번째 요청은 네트워크 없이 캐시로 답한다', async () => {
    let baseCalls = 0
    const phases: any[] = []
    const of = F.createOfficeFetch({
      fetchFn: async () => {
        baseCalls += 1
        return streamResponse([bytes('data')], 4)
      },
      onProgress: (p: any) => phases.push(p),
    })
    of.expectVersion(9, 'v1')
    await of.fetch('/api/drive/files/9/content')
    expect(baseCalls).toBe(1)
    phases.length = 0
    const res: any = await of.fetch('/api/drive/files/9/content')
    expect(baseCalls).toBe(1) // 캐시 히트 — 다시 묻지 않는다
    expect(phases).toEqual([{ phase: 'cache' }])
    expect(await res.text()).toBe('data')
  })

  test('기대 version이 바뀌거나 invalidate하면 캐시를 쓰지 않고 새로 받는다', async () => {
    let baseCalls = 0
    const of = F.createOfficeFetch({
      fetchFn: async () => {
        baseCalls += 1
        return streamResponse([bytes('x')], 1)
      },
      onProgress: () => undefined,
    })
    of.expectVersion(9, 'v1')
    await of.fetch('/api/drive/files/9/content')
    await of.fetch('/api/drive/files/9/content')
    expect(baseCalls).toBe(1)
    of.expectVersion(9, 'v2')
    await of.fetch('/api/drive/files/9/content')
    expect(baseCalls).toBe(2)
    of.invalidate(9)
    await of.fetch('/api/drive/files/9/content')
    expect(baseCalls).toBe(3)
  })

  test('스트림이 없는 응답은 그대로 반환하고 캐시하지 않는다', async () => {
    let baseCalls = 0
    const plain = { ok: true, status: 200, headers: { get: () => null }, body: null }
    const of = F.createOfficeFetch({
      fetchFn: async () => {
        baseCalls += 1
        return plain
      },
      onProgress: () => undefined,
    })
    of.expectVersion(9, 'v1')
    await expect(of.fetch('/api/drive/files/9/content')).resolves.toBe(plain)
    await expect(of.fetch('/api/drive/files/9/content')).resolves.toBe(plain)
    expect(baseCalls).toBe(2)
  })
})


/* ---------- 2. composeResult ---------- */
/* ---------- 2·7. 비서 코어: 결과 합성 + instruct 흐름 ---------- */
// 운영 office-assistant.js는 attach API가 아니라, #officeAssistant와
// window.MyHubOffice가 있는 문서에서 스스로 부팅해 코어를
// window.MyHubOfficeAssistantCore로 노출한다. 세션은 형식별 전역
// (MyHubFinderFormatPdf 등)의 getSession으로 얻고, 결과는 emit로만 낸다.
describe('office-assistant 코어 — instruct 흐름과 결과 합성', () => {
  function makeAssistant(opts: {
    session: any
    instruct: (body: any) => unknown
    file?: { fileId: number; name: string } | null
  }) {
    DOC.body.innerHTML = '<div id="officeAssistant"></div>'
    const g = globalThis as any
    g.MyHubOffice = { parseAppKey: () => 'pdf' }
    g.MyHubOfficeApp = { getCurrent: () => opts.file ?? { fileId: 9, name: '보고.pdf' } }
    g.MyHubFinderFormatPdf = { getSession: () => opts.session }
    const bodies: any[] = []
    g.fetch = async (url: string, init?: RequestInit) => {
      if (url === '/api/ai/office/instruct') {
        const body = JSON.parse(String(init?.body))
        bodies.push(body)
        return jsonResponse(opts.instruct(body))
      }
      throw new Error('unexpected ' + url)
    }
    g.eval(readPub('/js/office-assistant.js'))
    const core = g.MyHubOfficeAssistantCore
    const says: string[] = []
    const busies: boolean[] = []
    core.setEmit({
      say: (t: string) => says.push(t),
      findings: () => undefined,
      busy: (on: boolean) => busies.push(on),
    })
    return { core, says, busies, bodies, lastSay: () => says[says.length - 1] }
  }

  const pdfSession = (applyOps: (ops: any[]) => Promise<any>) => ({
    getState: () => ({ pageCount: 3 }),
    applyOps,
  })

  test('지시 → 스냅샷 포함 POST → 전부 성공이면 답변 + 적용 개수 보고', async () => {
    const h = makeAssistant({
      session: pdfSession(async () => ({ applied: 1, errors: [] })),
      instruct: () => ({
        ok: true,
        reply: '다 바꿨어요',
        ops: [{ type: 'rotate_page', page: 1 }],
        validationErrors: [],
      }),
    })
    await expect(h.core.runInstruction('1쪽 회전해줘')).resolves.toBe(true)
    expect(h.bodies).toEqual([
      { app: 'pdf', fileName: '보고.pdf', instruction: '1쪽 회전해줘', snapshot: { pageCount: 3 } },
    ])
    expect(h.lastSay()).toBe('다 바꿨어요\n연산 1개를 적용했어요.')
    expect(h.busies).toEqual([true, false])
  })

  test('실패가 있으면 실패 보고가 먼저 + 적용 전 작성 고지 + 답변이 뒤에 붙는다', async () => {
    const h = makeAssistant({
      session: pdfSession(async () => ({
        applied: 0,
        errors: [{ message: '아직 저장되지 않은 문서예요' }],
      })),
      instruct: () => ({
        ok: true,
        reply: '2쪽을 회전했어요',
        ops: [{ type: 'rotate_page', page: 2 }],
        validationErrors: [],
      }),
    })
    await h.core.runInstruction('2쪽 회전해줘')
    const say = h.lastSay()
    expect(say).toContain('연산 0개 적용, 1개 실패했어요. (첫 실패: 아직 저장되지 않은 문서예요)')
    expect(say).toContain('(비서 답변이 적용 전에 작성된 내용이라 실제 결과와 다를 수 있어요)')
    // 실패가 답변보다 먼저 나와야 한다 (거짓 성공 방어)
    expect(say.indexOf('실패했어요')).toBeLessThan(say.indexOf('2쪽을 회전했어요'))
  })

  test('연산이 없고 validationErrors가 있으면 적용 실패로 보고한다', async () => {
    const h = makeAssistant({
      session: pdfSession(async () => ({ applied: 0, errors: [] })),
      instruct: () => ({
        ok: true,
        reply: '회전했어요',
        ops: [],
        validationErrors: ['2쪽은 범위를 벗어났어요'],
      }),
    })
    await h.core.runInstruction('9쪽 회전해줘')
    expect(h.lastSay()).toContain('요청한 변경을 적용하지 못했어요. (2쪽은 범위를 벗어났어요)')
  })

  test('세션이 없으면 문서를 열라는 안내만 하고 POST하지 않는다', async () => {
    const h = makeAssistant({
      session: null,
      instruct: () => ({ ok: true, reply: '', ops: [] }),
    })
    await expect(h.core.runInstruction('고쳐줘')).resolves.toBe(false)
    expect(h.lastSay()).toContain('먼저 문서를 열어 주세요')
    expect(h.bodies).toHaveLength(0)
  })

  test('snapshot이 동기적으로 던져도 null로 접고 instruct까지 진행한다 (F6 카나리아)', async () => {
    // 세션 배선 결함으로 getState()가 동기 TypeError를 던지면 예전에는
    // busy가 영원히 안 풀려 "작업 중이에요"에 고정됐다. 이제는 스냅샷을
    // null로 접고 결과를 표시해야 한다 (office-assistant.js 결함 수정).
    const h = makeAssistant({
      session: {
        getState: () => {
          throw new TypeError('F.loadFile is not a function')
        },
        applyOps: async () => ({ applied: 0, errors: [] }),
      },
      instruct: () => ({ ok: true, reply: '처리했어요', ops: [], validationErrors: [] }),
    })
    await expect(h.core.runInstruction('1쪽 회전해줘')).resolves.toBe(true)
    expect(h.bodies[0].snapshot).toBeUndefined()
    expect(h.lastSay()).toContain('처리했어요')
    expect(h.busies).toEqual([true, false])
    // busy가 풀렸으므로 두 번째 지시도 같은 흐름으로 처리된다
    await h.core.runInstruction('한 번 더')
    expect(h.bodies[1].instruction).toBe('한 번 더')
  })
})

/* ---------- 6. GridCraft exec 채널 ---------- */
describe('sheet-gridcraft exec 채널 — ops ↔ exec 번역·합산', () => {
  test('opsToCommands: set_cell은 cell.set으로, format_range는 명령 여러 개로 펼쳐진다', () => {
    ;(globalThis as any).eval(readPub('/js/sheet-gridcraft.js'))
    const G = (globalThis as any).MyHubSheetGridcraft
    expect(G.opsToCommands([{ type: 'set_cell', cell: 'B2', value: 7 }])).toEqual([
      { op: 0, id: 'cell.set', params: { cell: 'B2', input: '7' } },
    ])
    expect(G.opsToCommands([{ type: 'set_cell', cell: 'A1', formula: 'SUM(B1:B3)' }])).toEqual([
      { op: 0, id: 'cell.set', params: { cell: 'A1', input: '=SUM(B1:B3)' } },
    ])
    const flat = G.opsToCommands([{ type: 'format_range', range: 'A1:B1', bold: true, background: '#fff' }])
    expect(flat.map((c: any) => c.id)).toEqual(['home.bold', 'home.fillColor'])
    expect(G.opsToCommands([{ type: 'nope' }])).toEqual([])
  })

  test('aggregateExecResults: 명령 하나라도 실패하면 그 연산이 실패로 합산된다', () => {
    ;(globalThis as any).eval(readPub('/js/sheet-gridcraft.js'))
    const G = (globalThis as any).MyHubSheetGridcraft
    const ops = [{ type: 'set_cell' }, { type: 'format_range' }, { type: 'nope' }]
    const flat = [
      { op: 0, id: 'cell.set' },
      { op: 1, id: 'home.bold' },
      { op: 1, id: 'home.fillColor' },
    ]
    const agg = G.aggregateExecResults(ops, flat, [{ ok: true }, { ok: true }, { ok: false, error: '범위 오류' }])
    expect(agg.applied).toBe(1)
    expect(agg.errors).toEqual([
      { index: 1, message: '범위 오류' },
      { index: 2, message: '지원하지 않는 연산입니다: nope' },
    ])
  })

  test('브리지 왕복: myhub-sheet:ops → gridcraft:exec(tag) → exec-result → ops-result', async () => {
    ;(globalThis as any).eval(readPub('/js/sheet-gridcraft.js'))
    const G = (globalThis as any).MyHubSheetGridcraft
    const toParent: any[] = []
    const root = DOC.createElement('div')
    DOC.body.appendChild(root)
    const bridge = G.createBridge({
      document: DOC,
      window: W,
      root,
      postToParent: (m: any) => toParent.push(m),
      fonts: null,
      fetchFn: async () => {
        throw new Error('offline')
      },
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => undefined,
    })
    expect(toParent).toContainEqual({ type: 'myhub-sheet:ready' })
    const frame = bridge.frame
    const gcPosted: any[] = []
    frame.contentWindow.postMessage = (m: any) => {
      gcPosted.push(m)
    }
    const origin = W.location.origin
    const evt = (data: any, source: any) => {
      const ev: any = new W.MessageEvent('message', { data, origin })
      try {
        Object.defineProperty(ev, 'source', { value: source })
      } catch {
        ev.source = source
      }
      return ev
    }
    W.dispatchEvent(evt({ type: 'gridcraft:ready' }, frame.contentWindow))
    W.dispatchEvent(evt({ type: 'myhub-sheet:open', name: 't.xlsx', bytes: null }, W))
    W.dispatchEvent(
      evt({ type: 'myhub-sheet:ops', ops: [{ type: 'set_cell', cell: 'B2', value: 7 }] }, W),
    )
    const execMsg = gcPosted.find((m) => m.type === 'gridcraft:exec')
    expect(execMsg).toBeDefined()
    expect(execMsg.commands).toEqual([{ id: 'cell.set', params: { cell: 'B2', input: '7' } }])
    W.dispatchEvent(
      evt({ type: 'gridcraft:exec-result', tag: execMsg.tag, results: [{ ok: true }] }, frame.contentWindow),
    )
    expect(toParent).toContainEqual({ type: 'myhub-sheet:ops-result', applied: 1, errors: [] })
    bridge.destroy()
  })
})

/* ---------- 5. 할 일 삭제 모달 ---------- */
describe('todo 삭제는 인페이지 모달 (네이티브 confirm 금지)', () => {
  test('삭제 클릭 → 모달 확인 → DELETE, confirm()은 호출되지 않는다', async () => {
    const html = readPub('/todo.html')
    const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)![1].replace(/<script[\s\S]*?<\/script>/g, '')
    DOC.body.innerHTML = body
    const g = globalThis as any
    const confirmSpy = jest.fn(() => false)
    g.confirm = confirmSpy
    W.confirm = confirmSpy
    const deleted: string[] = []
    let listTodos = [{ id: 11, title: '지울 항목', status: 'pending' }]
    g.fetch = async (url: string, init?: RequestInit) => {
      if (url.includes('/api/todo/list')) return jsonResponse({ ok: true, todos: listTodos })
      if (url.includes('/api/todo/11') && init?.method === 'DELETE') {
        deleted.push(url)
        listTodos = []
        return jsonResponse({ ok: true })
      }
      return jsonResponse({ ok: true, todos: [] })
    }
    // 5-4 F-L3: todo.js는 text-utils.js 코어를 먼저 필요로 한다 (운영 HTML 순서와 동일)
    g.eval(readPub('/js/common/text-utils.js'))
    g.eval(readPub('/js/todo.js'))
    await tick(); await tick()
    const delBtn = DOC.querySelector('[data-act="del"]') as any
    expect(delBtn).not.toBeNull()
    delBtn.click()
    await tick()
    expect(confirmSpy).not.toHaveBeenCalled()
    const modal = DOC.querySelector('.todo-confirm-overlay')
    expect(modal).not.toBeNull()
    expect(deleted).toHaveLength(0) // 확인 전에는 DELETE가 나가지 않는다
    ;(modal!.querySelector('.todo-confirm-yes') as any).click()
    await tick(); await tick()
    expect(deleted).toHaveLength(1)
    expect(DOC.querySelector('.todo-confirm-overlay')).toBeNull()
  })
})
