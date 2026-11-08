/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * F4 프론트 회귀 테스트 (2026-11-07 운영 QA 2차 실패의 카나리아).
 *
 * 검증하는 성질:
 * 1. office-fetch 계약: 신규 생성은 폼 필드 'files'로 보내고 응답을
 *    {id, name, version(storage_key)}으로 정규화한다. 'file'로 되돌리면
 *    서버가 400 'empty'로 거부하던 결함이 재발하므로 여기서 잡는다.
 *    PUT은 'file' + base_version, 409는 conflict로 정규화. 메타 이름은
 *    Content-Disposition에서 읽는다 (GET /files/:id는 302라 JSON이 없다).
 * 2. 패널 결과 합성(composeResult): 실패가 답변보다 먼저 나오고, 서버
 *    validationErrors가 표면화되며, 실패 시 "적용 전에 작성된 내용"
 *    고지가 붙는다. 전부 성공이면 고지가 없다.
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
 * 6. GridCraft exec 채널: exec()가 exec-result를 tag로 매칭해 결과를
 *    돌려준다 (스냅샷 조회·연산 확인의 토대).
 * 7. 패널 instruct 흐름: 지시가 세션 스냅샷과 함께 POST /instruct로
 *    나가고, 연산 실패가 합성 메시지에 실패로 먼저 표시된다.
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

/* ---------- 1. office-fetch 계약 ---------- */
describe('office-fetch 서버 계약', () => {
  let F: any
  let calls: FetchCall[]
  let handler: (url: string, init?: RequestInit) => Promise<Response>

  beforeAll(() => {
    const g = globalThis as any
    g.fetch = (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return handler(url, init)
    }
    calls = []
    g.eval(readPub('/js/office-fetch.js'))
    F = g.MyHubOfficeFetch
  })
  beforeEach(() => { calls = [] })

  test("신규 생성은 'files' 필드로 보내고 {id,name,version}으로 정규화한다", async () => {
    handler = async (url) => {
      if (url === '/api/drive/files') return jsonResponse({ ok: true, files: [{ id: 42, filename: '새 문서.xlsx', size: 10 }] })
      if (url === '/api/drive/recent') return jsonResponse({ ok: true, files: [{ id: 42, version: 'myhub/drive/abc' }] })
      throw new Error('unexpected ' + url)
    }
    const out = await F.createFile('새 문서.xlsx', new Blob(['x']))
    expect(out).toEqual({ id: 42, name: '새 문서.xlsx', version: 'myhub/drive/abc' })
    const post = calls.find((c) => c.url === '/api/drive/files')!
    const form = post.init!.body as FormData
    expect(form.get('files')).toBeInstanceOf(File)
    expect(form.get('file')).toBeNull() // 'file'로 보내면 서버 400 — 카나리아
  })

  test('생성 응답이 비정상이면 조용히 성공으로 세지 않고 던진다', async () => {
    handler = async () => jsonResponse({ ok: true, files: [] })
    await expect(F.createFile('x.xlsx', new Blob(['x']))).rejects.toThrow()
  })

  test("PUT은 'file' + base_version, 200이면 새 version, 409면 conflict", async () => {
    handler = async () => jsonResponse({ ok: true, size: 5, version: 'myhub/drive/def' })
    const okOut = await F.saveFile(7, new Blob(['y']), 'myhub/drive/abc', '문서.xlsx')
    expect(okOut).toEqual({ ok: true, version: 'myhub/drive/def' })
    const put = calls[0]
    const form = put.init!.body as FormData
    expect(form.get('file')).toBeInstanceOf(File)
    expect(form.get('base_version')).toBe('myhub/drive/abc')

    handler = async () => jsonResponse({ ok: false, error: 'CONFLICT' }, 409)
    const conflict = await F.saveFile(7, new Blob(['y']), 'stale', '문서.xlsx')
    expect(conflict).toEqual({ conflict: true })
  })

  test('loadMeta는 Content-Disposition에서 이름을 읽는다 (302라 JSON이 없음)', async () => {
    handler = async () => jsonResponse({}, 200, {
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent('한글 이름.pdf')}`,
    })
    const meta = await F.loadMeta(9)
    expect(meta.name).toBe('한글 이름.pdf')
    const loaded = await F.loadFile(9)
    expect(loaded.name).toBe('한글 이름.pdf')
  })
})

/* ---------- 2·3·4. 세션 순수 함수 + 한글 연산 ---------- */
describe('office-sessions 순수 변환·검증', () => {
  let S: any
  beforeAll(() => {
    ;(globalThis as any).eval(readPub('/js/office-sessions.js'))
    S = (globalThis as any).MyHubOfficeSessions
  })

  test('sheetSnapshotFromRead: 수식은 {f}, 값은 {v}, 빈 셀은 null', () => {
    const snap = S.sheetSnapshotFromRead({ range: 'A1:AD120', values: [[1, '=SUM(A1:A2)', null, '텍스트']] })
    expect(snap.cells[0]).toEqual([{ v: 1 }, { f: '=SUM(A1:A2)' }, null, { v: '텍스트' }])
    expect(snap.range).toBe('A1:AD120')
  })

  test('slideSnapshotFromInspects: 400자 절단 + 빈 자리표시자도 text:"" 명시', () => {
    const long = '가'.repeat(500)
    const snap = S.slideSnapshotFromInspects({ slides: 1 }, [
      { index: 0, layout: 'title', title: '제목', shapes: [
        { id: 1, kind: 'text', placeholder: 'title', text: long },
        { id: 2, kind: 'text', placeholder: 'body' },
      ] },
    ])
    expect(snap.slides[0].shapes[0].text).toHaveLength(400)
    expect(snap.slides[0].shapes[1].text).toBe('')
  })

  test('verify 계열: 적용 후 스냅샷에 흔적이 없으면 실패로 센다', () => {
    const ins = { shapes: [{ id: 5, text: '새 제목' }, { id: 6, text: '본문' }] }
    expect(S.verifyTextSet(ins, 5, '새 제목')).toBe(true)
    expect(S.verifyTextSet(ins, 5, '옛 제목')).toBe(false)
    expect(S.verifyInsertTextBox(ins, '본문')).toBe(true)
    expect(S.verifyInsertTextBox(ins, '없는 글')).toBe(false)
    expect(S.verifyTextReplace([ins], '옛말', '새 제목')).toBe(true)
    expect(S.verifyTextReplace([ins], '본문', '어디에도 없는 말')).toBe(false)
  })

  test('applyHwpOp: 문단 추가·첫 일치만 치환·표 삽입', () => {
    // HwpDocument 계약을 흉내 내는 가짜 문서 (문단 배열 기반)
    const paras = ['검토 요망 문서', '검토 요망 재언급']
    const cells: string[] = []
    const fakeDoc = {
      getSectionCount: () => 1,
      getParagraphCount: () => paras.length,
      getParagraphLength: (_s: number, p: number) => paras[p].length,
      getTextRange: (_s: number, p: number, off: number, n: number) => paras[p].slice(off, off + n),
      insertParagraph: (_s: number, at: number) => { paras.splice(at, 0, ''); return '{"ok":true}' },
      insertText: (_s: number, p: number, off: number, t: string) => {
        paras[p] = paras[p].slice(0, off) + t + paras[p].slice(off); return ''
      },
      deleteText: (_s: number, p: number, off: number, n: number) => {
        paras[p] = paras[p].slice(0, off) + paras[p].slice(off + n); return ''
      },
      createTable: (_s: number, _p: number, _o: number, rows: number, cols: number) => {
        for (let i = 0; i < rows * cols; i++) cells.push('')
        return JSON.stringify({ ok: true, paraIdx: 0, controlIdx: 0 })
      },
      insertTextInCell: (_s: number, _p: number, _c: number, cell: number, _cp: number, _o: number, t: string) => {
        cells[cell] = t; return ''
      },
    }
    expect(S.applyHwpOp(fakeDoc, { type: 'append_paragraphs', paragraphs: ['총무팀 안내'] })).toBe(true)
    expect(paras[paras.length - 1]).toBe('총무팀 안내')
    expect(S.applyHwpOp(fakeDoc, { type: 'replace_text', find: '검토 요망', replace: '검토 완료' })).toBe(true)
    expect(paras[0]).toBe('검토 완료 문서')
    expect(paras[1]).toBe('검토 요망 재언급') // 첫 일치만 — 두 번째는 그대로
    expect(() => S.applyHwpOp(fakeDoc, { type: 'replace_text', find: '없는 말', replace: 'x' })).toThrow()
    expect(S.applyHwpOp(fakeDoc, { type: 'insert_table', headers: ['이름', '금액'], rows: [['김', '100']] })).toBe(true)
    expect(cells).toEqual(['이름', '금액', '김', '100'])
  })
})

/* ---------- 2. composeResult ---------- */
describe('office-assistant 결과 합성', () => {
  let A: any
  beforeAll(() => {
    ;(globalThis as any).eval(readPub('/js/office-assistant.js'))
    A = (globalThis as any).MyHubOfficeAssistant
  })

  test('전부 성공이면 답변만, 고지 없음', () => {
    const out = A.composeResult({ reply: '다 바꿨어요', ops: [{}] }, [{ op: { type: 'set_cell' }, ok: true }])
    expect(out).toBe('다 바꿨어요')
  })

  test('실패가 있으면 실패가 먼저 + 적용 전 작성 고지', () => {
    const out = A.composeResult(
      { reply: '회전했어요', validationErrors: ['2쪽은 범위를 벗어났어요'] },
      [
        { op: { type: 'rotate_page', page: 1 }, ok: true },
        { op: { type: 'rotate_page', page: 2 }, ok: false, error: '범위 초과' },
      ],
    )
    const lines = out.split('\n')
    expect(lines[0]).toBe('적용하지 못한 항목이 있어요:')
    expect(out).toContain('2쪽은 범위를 벗어났어요')
    expect(out).toContain('페이지 회전: 범위 초과')
    expect(out).toContain('(1개 연산은 적용했어요)')
    expect(out.indexOf('적용하지 못한 항목')).toBeLessThan(out.indexOf('회전했어요'))
    expect(out).toContain('적용 전에 작성된 내용이라 실제 결과와 다를 수 있어요')
  })

  test('답변도 연산도 없으면 처리 완료 문구', () => {
    expect(A.composeResult({}, [])).toBe('처리했어요.')
  })
})

/* ---------- 6. GridCraft exec 채널 ---------- */
describe('sheet-gridcraft exec 채널', () => {
  test('exec-result가 tag로 매칭되어 결과를 돌려준다', async () => {
    const posted: any[] = []
    const fakeFrame = { contentWindow: { postMessage: (m: any) => posted.push(m) } }
    ;(globalThis as any).eval(readPub('/js/sheet-gridcraft.js'))
    const G = (globalThis as any).MyHubSheetGridcraft
    const adapter = G.attach({ engineFrame: fakeFrame })
    const p = adapter.exec([{ id: 'sheet.read', params: { range: 'A1:B2' } }])
    expect(posted).toHaveLength(1)
    expect(posted[0].type).toBe('gridcraft:exec')
    const ev = new W.MessageEvent('message', {
      data: { type: 'gridcraft:exec-result', tag: posted[0].tag, results: [{ ok: true, result: { values: [[1]] } }] },
      origin: W.location.origin,
    })
    W.dispatchEvent(ev)
    await expect(p).resolves.toEqual([{ ok: true, result: { values: [[1]] } }])
  })
})

/* ---------- 7. 패널 instruct 흐름 ---------- */
describe('office-assistant 패널 instruct 흐름', () => {
  test('지시 → 스냅샷 포함 POST → 실패 합성 표시', async () => {
    DOC.body.innerHTML = '<header class="g-nav"></header>'
    const g = globalThis as any
    let instructBody: any = null
    g.fetch = async (url: string, init?: RequestInit) => {
      if (url === '/api/ai/office/instruct') {
        instructBody = JSON.parse(String(init?.body))
        return jsonResponse({
          ok: true,
          reply: '2쪽을 회전했어요',
          ops: [{ type: 'rotate_page', page: 2 }],
          validationErrors: [],
          opsDiag: [],
        })
      }
      throw new Error('unexpected ' + url)
    }
    const session = {
      kind: 'pdf',
      snapshot: async () => ({ pageCount: 3 }),
      applyOps: async () => [{ op: { type: 'rotate_page', page: 2 }, ok: false, error: '아직 저장되지 않은 문서예요' }],
    }
    const api = g.MyHubOfficeAssistant.attach({
      host: {
        getState: () => ({ app: 'pdf', fileName: '보고.pdf', fileId: null, dirty: false }),
      },
      session,
    })
    expect(DOC.querySelector('#officeAssistantBtn')).not.toBeNull()
    expect(DOC.querySelector('#oaMemoBtn')).toBeNull() // pdf는 메모로 만들기 없음
    await api.runInstruction('2쪽 회전해줘')
    expect(instructBody).toEqual({
      app: 'pdf',
      fileName: '보고.pdf',
      instruction: '2쪽 회전해줘',
      snapshot: { pageCount: 3 },
    })
    const msgs = DOC.querySelector('#oaMsgs')!.textContent || ''
    expect(msgs).toContain('적용하지 못한 항목이 있어요')
    expect(msgs).toContain('아직 저장되지 않은 문서예요')
  })

  test('snapshot이 동기적으로 던져도 패널이 멈추지 않고 다음 지시를 받는다', async () => {
    // F6 카나리아: 세션 배선 결함으로 snapshot()이 동기 TypeError를 던지면
    // 예전에는 busy가 영원히 안 풀려 "작업 중이에요…"에 고정됐다. 이제는
    // 스냅샷 실패를 null로 접고 instruct까지 진행해 결과를 표시해야 한다.
    DOC.body.innerHTML = '<header class="g-nav"></header>'
    const g = globalThis as any
    let instructBody: any = null
    g.fetch = async (url: string, init?: RequestInit) => {
      if (url === '/api/ai/office/instruct') {
        instructBody = JSON.parse(String(init?.body))
        return jsonResponse({ ok: true, reply: '처리했어요', ops: [], validationErrors: [] })
      }
      throw new Error('unexpected ' + url)
    }
    const session = {
      kind: 'pdf',
      snapshot: () => { throw new TypeError('F.loadFile is not a function') },
      applyOps: async () => [],
    }
    const api = g.MyHubOfficeAssistant.attach({
      host: { getState: () => ({ app: 'pdf', fileName: '보고.pdf', fileId: 9, dirty: false }) },
      session,
    })
    await api.runInstruction('1쪽 회전해줘')
    expect(instructBody.snapshot).toBeNull()
    const msgs = DOC.querySelector('#oaMsgs')!.textContent || ''
    expect(msgs).not.toContain('작업 중이에요')
    expect(msgs).toContain('처리했어요')
    // busy가 풀렸으므로 두 번째 지시도 같은 흐름으로 처리된다
    await api.runInstruction('한 번 더')
    expect(instructBody.instruction).toBe('한 번 더')
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
    g.eval(readPub('/js/todo.js'))
    await tick(); await tick()
    const delBtn = DOC.querySelector('[data-act="del"]') as any
    expect(delBtn).not.toBeNull()
    delBtn.click()
    await tick()
    expect(confirmSpy).not.toHaveBeenCalled()
    const modal = DOC.querySelector('.modal-back.open')
    expect(modal).not.toBeNull()
    expect(deleted).toHaveLength(0) // 확인 전에는 DELETE가 나가지 않는다
    ;(modal!.querySelector('.m-btn.danger') as any).click()
    await tick(); await tick()
    expect(deleted).toHaveLength(1)
    expect(DOC.querySelector('.modal-back.open')).toBeNull()
  })
})
