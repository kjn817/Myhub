/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "http://localhost/pdf-viewer/web/viewer.html?file=%2Fapi%2Fdrive%2Ffiles%2F5%2Fcontent"}
 */
/// <reference types="jest" />
/**
 * pdf.js 뷰어 글루(myhub-glue.mjs) 계약 테스트 (2026-11-15 재건).
 *
 * 배경: 2026-11-07 소실 사고로 글루가 사라져 호스트(finder-format-pdf.js)가
 * 뷰어의 ready 신호를 절대 받지 못했다. 그 결과 20초 타이머가 항상 발동해
 * 샌드박스 대체 화면으로 바뀌고, 크롬이 PDF 플러그인을 막아 "Chrome에서
 * 차단한 페이지입니다"만 떴다. 글루를 재건하고 그 계약을 고정한다.
 *
 * 검증 성질 (가짜 PDFViewerApplication + 가짜 부모 창):
 * - 초기화 완료 시 호스트에 appready를 보낸다.
 * - documentloaded 시 ready{pages}와 state{page, pages}를 보낸다.
 * - pagechanging 시 state를 보낸다.
 * - open-bytes를 받으면 뷰어 open({data, filename})을 부른다.
 * - reload를 받으면 ?file= URL을 다시 연다.
 * - request-save를 받으면 saveDocument 바이트를 saved로 보내고,
 *   실패하면 save-error를 보낸다.
 * - 주석 변경 추적이 뷰어 자체 콜백을 덮지 않고 체인한다
 *   (뷰어 콜백도 불리고 dirty도 보고된다). 이중 래핑하지 않는다.
 * - Ctrl/Cmd+S를 가로채 shortcut-save를 보내고 기본 동작을 막는다.
 *
 * 카나리아: 글루에서 appready 전송을 지우면 첫 테스트가 실패하고,
 * documentloaded 핸들러를 지우면 ready 테스트가 실패한다.
 * (글루는 로드 시 한 번만 와이어링하므로 파일당 한 번 로드하고
 * 테스트마다 전송 기록을 비워 쓴다.)
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const GLUE_JS = fs.readFileSync(path.join(ROOT, 'public', 'pdf-viewer', 'web', 'myhub-glue.mjs'), 'utf-8')

const getWin = (): any => (globalThis as any).window
const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms))

describe('pdf.js 뷰어 글루', () => {
  const posts: any[] = []
  const initialPosts: any[] = []
  const busHandlers: Record<string, Function> = {}
  let app: any
  let fakeParent: any
  let storage: any

  beforeAll(async () => {
    const win = getWin()
    fakeParent = { postMessage: jest.fn((msg: any) => posts.push(msg)) }
    // 임베드 환경을 만든다 (실제론 iframe의 parent가 호스트 창이다).
    Object.defineProperty(win, 'parent', { value: fakeParent, configurable: true })
    storage = {}
    app = {
      initializedPromise: Promise.resolve(),
      eventBus: { on: jest.fn((evt: string, fn: Function) => { busHandlers[evt] = fn }) },
      pagesCount: 59,
      page: 4,
      pdfDocument: {
        annotationStorage: storage,
        saveDocument: jest.fn(() => Promise.resolve(new Uint8Array([1, 2, 3]))),
      },
      open: jest.fn(),
    }
    win.PDFViewerApplication = app
    new Function('window', 'document', GLUE_JS)(win, win.document)
    await flush(10)
    // 로드 직후 전송(appready)을 따로 보관한다 — 각 테스트는
    // posts를 비우고 시작하므로 초기 전송은 여기서만 볼 수 있다.
    initialPosts.push(...posts)
    posts.length = 0
  })

  beforeEach(() => {
    posts.length = 0
    jest.clearAllMocks()
    // clearAllMocks가 eventBus.on 기록도 지우지만 핸들러 등록은 유지된다.
  })

  function fireDocumentLoaded() {
    expect(busHandlers['documentloaded']).toBeDefined()
    busHandlers['documentloaded']()
  }

  function sendToViewer(data: any) {
    const win = getWin()
    win.dispatchEvent(
      new win.MessageEvent('message', {
        data,
        origin: win.location.origin,
        source: fakeParent,
      }),
    )
  }

  test('초기화 완료 시 appready를 호스트에 보낸다', () => {
    expect(initialPosts).toContainEqual({ type: 'myhub-pdf:appready' })
    expect(busHandlers['documentloaded']).toBeDefined()
    expect(busHandlers['pagechanging']).toBeDefined()
  })

  test('documentloaded 시 ready와 state를 보낸다', () => {
    fireDocumentLoaded()
    expect(posts).toContainEqual({ type: 'myhub-pdf:ready', pages: 59 })
    expect(posts).toContainEqual({ type: 'myhub-pdf:state', page: 4, pages: 59 })
  })

  test('pagechanging 시 state를 보낸다', () => {
    expect(busHandlers['pagechanging']).toBeDefined()
    busHandlers['pagechanging']({ pageNumber: 7 })
    expect(posts).toContainEqual({ type: 'myhub-pdf:state', page: 7, pages: 59 })
  })

  test('open-bytes를 받으면 뷰어 open을 바이트와 파일명으로 부른다', () => {
    const bytes = new ArrayBuffer(8)
    sendToViewer({ type: 'myhub-pdf:open-bytes', bytes, filename: '문서.pdf' })
    expect(app.open).toHaveBeenCalledTimes(1)
    const arg = app.open.mock.calls[0][0]
    expect(arg.filename).toBe('문서.pdf')
    expect(arg.data).toBeInstanceOf(Uint8Array)
    expect(arg.data.byteLength).toBe(8)
  })

  test('reload를 받으면 ?file= URL을 다시 연다', () => {
    sendToViewer({ type: 'myhub-pdf:reload' })
    expect(app.open).toHaveBeenCalledTimes(1)
    expect(app.open).toHaveBeenCalledWith({ url: '/api/drive/files/5/content' })
  })

  test('request-save를 받으면 저장 바이트를 saved로 보낸다', async () => {
    sendToViewer({ type: 'myhub-pdf:request-save' })
    await flush(10)
    expect(app.pdfDocument.saveDocument).toHaveBeenCalledTimes(1)
    expect(posts.length).toBe(1)
    expect(posts[0].type).toBe('myhub-pdf:saved')
    expect(posts[0].bytes).toBeInstanceOf(ArrayBuffer)
    expect(posts[0].bytes.byteLength).toBe(3)
  })

  test('저장 실패 시 save-error를 보낸다', async () => {
    app.pdfDocument.saveDocument = jest.fn(() => Promise.reject(new Error('boom')))
    try {
      sendToViewer({ type: 'myhub-pdf:request-save' })
      await flush(10)
      expect(posts).toContainEqual({ type: 'myhub-pdf:save-error' })
    } finally {
      app.pdfDocument.saveDocument = jest.fn(() => Promise.resolve(new Uint8Array([1, 2, 3])))
    }
  })

  test('주석 변경 추적이 뷰어 콜백을 체인하고 dirty를 보고한다', () => {
    // 새 스토리지로 교체한다 (이전 테스트가 이미 래핑한 객체를
    // 재사용하면 뷰어 콜백을 끼워넣을 수 없다 — 실제론 문서마다
    // annotationStorage가 새로 만들어진다).
    storage = {}
    app.pdfDocument.annotationStorage = storage
    const viewerSet = jest.fn()
    const viewerReset = jest.fn()
    storage.onSetModified = viewerSet
    storage.onResetModified = viewerReset
    fireDocumentLoaded()
    // documentloaded를 두 번 쏴도 래핑은 한 번만 된다.
    fireDocumentLoaded()
    storage.onSetModified()
    expect(viewerSet).toHaveBeenCalledTimes(1)
    expect(posts).toContainEqual({ type: 'myhub-pdf:dirty', dirty: true })
    posts.length = 0
    storage.onResetModified()
    expect(viewerReset).toHaveBeenCalledTimes(1)
    expect(posts).toContainEqual({ type: 'myhub-pdf:dirty', dirty: false })
  })

  test('Ctrl+S를 가로채 shortcut-save를 보내고 기본 동작을 막는다', () => {
    const win = getWin()
    const evt = new win.KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    win.dispatchEvent(evt)
    expect(evt.defaultPrevented).toBe(true)
    expect(posts).toContainEqual({ type: 'myhub-pdf:shortcut-save' })
  })

  test('다른 출처의 메시지는 무시한다', () => {
    const win = getWin()
    win.dispatchEvent(
      new win.MessageEvent('message', {
        data: { type: 'myhub-pdf:reload' },
        origin: 'https://evil.example',
        source: fakeParent,
      }),
    )
    expect(app.open).not.toHaveBeenCalled()
  })
})
