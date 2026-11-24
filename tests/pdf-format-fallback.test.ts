/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
// 모듈 스코프 선언 (2026-11-18): import/export가 없어 두 테스트 파일이
// 전역 스코프를 공유해 createHost 등 동명 선언이 TS2451 충돌을 냈다.
export {};
/**
 * PDF 뷰어 대체 화면·지연 로딩 테스트 (2026-11-15).
 *
 * 배경: 뷰어 글루 소실로 ready 신호가 오지 않아 20초 타이머가 항상
 * 발동했고, 대체 화면이 sandbox="" iframe이라 크롬이 PDF 플러그인을 막아
 * "Chrome에서 차단한 페이지입니다"만 떴다. 또한 폰트 풀(11MB)과 편집기
 * WASM이 마운트 때 뷰어와 동시에 받아 첫 페이지를 늦췄다.
 *
 * 검증 성질:
 * - ready가 오지 않아 대체 화면으로 바뀌면, 네이티브 iframe은
 *   샌드박스를 갖지 않는다 — 크롬의 PDF 뷰어는 샌드박스가 걸린
 *   iframe에서는 어떤 토큰으로도 렌더링되지 않는다 (실브라우저
 *   헤드풀 3종 대조 실측, 2026-11-15). 콘텐츠 응답의 nosniff가
 *   HTML 둔갑을 막는다.
 * - ready가 오면 타이머가 취소돼 대체 화면으로 바뀌지 않는다.
 * - 폰트 풀과 편집기는 마운트 때 시작하지 않고, 뷰어 ready 뒤에야
 *   시작한다.
 *
 * 카나리아: fallback에 sandbox를 다시 걸면 첫 테스트가 실패하고,
 * startCraft 호출을 마운트 때로 되돌리면 지연 테스트가 실패한다.
 * (internals.readyTimeoutMs는 테스트 훅으로 짧게 줄여 쓴다.)
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../public/js/common/constants.js')
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../public/js/finder-codec.js')
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../public/js/finder-pdf-ops.js')
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../public/js/finder-viewer.js')

const fbWin: any = (globalThis as any).window
const fbDoc: any = (globalThis as any).document

// 가짜 PdfCraft 브리지 — 모듈 로드 전에 window에 올려야 한다
// (finder-format-pdf.js가 로드 때 읽는다).
const createHost = jest.fn(() => ({
  frame: fbDoc.createElement('div'),
  destroy: jest.fn(),
  open: jest.fn(() => true),
}))
fbWin.MyHubFinderPdfCraft = { createHost }
const fontsLoad = jest.fn()
fbWin.MyHubFonts = { load: fontsLoad }

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfFormat = require('../public/js/finder-format-pdf.js')

const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms))

describe('PDF 뷰어 대체 화면·지연 로딩', () => {
  let bodyEl: any
  let current = true
  let folded = true
  const notes: string[] = []

  function makeCtx() {
    bodyEl = fbDoc.createElement('div')
    fbDoc.body.appendChild(bodyEl)
    return {
      doc: fbDoc,
      body: bodyEl,
      file: { fileId: 5, name: '문서.pdf' },
      minimalChrome: false,
      chromeFold: null,
      saveBtn: fbDoc.createElement('button'),
      clearBody: () => { bodyEl.innerHTML = '' },
      contentUrl: () => '/api/drive/files/5/content',
      fetchContent: jest.fn(() => Promise.resolve(new ArrayBuffer(0))),
      fetchRaw: jest.fn(() => Promise.resolve({ ok: true })),
      isCurrent: () => current,
      isFolded: () => folded,
      setNote: (m: string) => notes.push(m),
      setStatus: jest.fn(),
      markDirty: jest.fn(),
      setSaveHandler: jest.fn(),
      onFoldChange: jest.fn(),
      requestOpen: jest.fn(),
      putContent: jest.fn(() => Promise.resolve(true)),
      saveAsContent: jest.fn(() => Promise.resolve(true)),
      showMessage: jest.fn(),
    }
  }

  beforeEach(() => {
    fbDoc.body.innerHTML = ''
    current = true
    folded = true
    notes.length = 0
    jest.clearAllMocks()
  })

  afterEach(() => {
    current = false
    pdfFormat.internals.readyTimeoutMs = 20000
  })

  function viewerFrame() {
    return bodyEl.querySelector('iframe.fv-pdf-frame')
  }

  function sendReady(frame: any, pages = 3) {
    fbWin.dispatchEvent(
      new fbWin.MessageEvent('message', {
        data: { type: 'myhub-pdf:ready', pages },
        origin: fbWin.location.origin,
        source: frame.contentWindow,
      }),
    )
  }

  test('ready가 오지 않으면 대체 화면은 샌드박스 없는 iframe으로 PDF를 보여준다', async () => {
    pdfFormat.internals.readyTimeoutMs = 50
    const ctx = makeCtx()
    await pdfFormat.handlePdf(ctx)
    expect(viewerFrame()).not.toBeNull()
    await flush(120)
    // 뷰어 프레임이 네이티브 프레임으로 교체됐다.
    expect(viewerFrame()).toBeNull()
    const native = bodyEl.querySelector('iframe.fv-frame')
    expect(native).not.toBeNull()
    expect(native.getAttribute('src')).toBe('/api/drive/files/5/content')
    // 어떤 샌드박스 토큰도 크롬 PDF 뷰어를 막는다 — 샌드박스가
    // 없어야 PDF가 렌더링된다 (실브라우저 헤드풀 실측).
    expect(native.hasAttribute('sandbox')).toBe(false)
    expect(notes.join(' ')).toContain('기본 미리보기')
  })

  test('ready가 오면 타이머가 취소돼 대체 화면으로 바뀌지 않는다', async () => {
    pdfFormat.internals.readyTimeoutMs = 50
    const ctx = makeCtx()
    await pdfFormat.handlePdf(ctx)
    const frame = viewerFrame()
    expect(frame).not.toBeNull()
    sendReady(frame)
    await flush(120)
    expect(viewerFrame()).not.toBeNull()
    expect(bodyEl.querySelectorAll('iframe').length).toBe(1)
  })

  test('폰트 풀과 편집기는 마운트 때 바로 시작한다 (2026-11-21 편집기 직접 진입)', async () => {
    folded = false // 펼친 상태 — 편집기 시작 조건 충족
    const ctx = makeCtx()
    await pdfFormat.handlePdf(ctx)
    expect(viewerFrame()).not.toBeNull()
    // 직접 진입: 뷰어 ready를 기다리지 않고 마운트 때 바로 시작한다.
    // 예전에는 뷰어와 대역폭 경합을 피해 ready 뒤에 시작했으나, 이제는
    // 뷰어가 먼저 보이지 않으므로(로딩 화면) 빨리 시작하는 게 맞다.
    expect(fontsLoad).toHaveBeenCalledTimes(1)
    expect(createHost).toHaveBeenCalledTimes(1)
    // ready 뒤에 다시 시작하지 않는다 (중복 부팅 방지).
    sendReady(viewerFrame())
    await flush(10)
    expect(fontsLoad).toHaveBeenCalledTimes(1)
    expect(createHost).toHaveBeenCalledTimes(1)
  })

  test('접힌 상태에서는 ready 뒤에도 편집기가 시작하지 않는다', async () => {
    folded = true // 접힌 상태 — 뷰어 모드이므로 편집기 불필요
    const ctx = makeCtx()
    await pdfFormat.handlePdf(ctx)
    sendReady(viewerFrame())
    await flush(10)
    expect(createHost).not.toHaveBeenCalled()
    expect(fontsLoad).not.toHaveBeenCalled()
  })
})

describe('PDF 안내 문구 — 깨진 한국어 재작성 (2026-11-25)', () => {
  let bodyEl: any
  let current = true
  let folded = true
  const notes: string[] = []

  function makeCtx() {
    bodyEl = fbDoc.createElement('div')
    fbDoc.body.appendChild(bodyEl)
    return {
      doc: fbDoc,
      body: bodyEl,
      file: { fileId: 5, name: '문서.pdf' },
      minimalChrome: false,
      chromeFold: null,
      saveBtn: fbDoc.createElement('button'),
      clearBody: () => { bodyEl.innerHTML = '' },
      contentUrl: () => '/api/drive/files/5/content',
      fetchContent: jest.fn(() => Promise.resolve(new ArrayBuffer(0))),
      fetchRaw: jest.fn(() => Promise.resolve({ ok: true })),
      isCurrent: () => current,
      isFolded: () => folded,
      setNote: (m: string) => notes.push(m),
      setStatus: jest.fn(),
      markDirty: jest.fn(),
      setSaveHandler: jest.fn(),
      onFoldChange: jest.fn(),
      requestOpen: jest.fn(),
      putContent: jest.fn(() => Promise.resolve(true)),
      saveAsContent: jest.fn(() => Promise.resolve(true)),
      showMessage: jest.fn(),
    }
  }

  beforeEach(() => {
    fbDoc.body.innerHTML = ''
    current = true
    folded = true
    notes.length = 0
    jest.clearAllMocks()
  })

  afterEach(() => {
    current = false
    pdfFormat.internals.readyTimeoutMs = 20000
  })

  function viewerFrame() {
    return bodyEl.querySelector('iframe.fv-pdf-frame')
  }

  function sendReady(frame: any, pages = 3) {
    fbWin.dispatchEvent(
      new fbWin.MessageEvent('message', {
        data: { type: 'myhub-pdf:ready', pages },
        origin: fbWin.location.origin,
        source: frame.contentWindow,
      }),
    )
  }

  test('뷰어 안내(NOTE)는 자연스러운 한국어 문장이다', async () => {
    const ctx = makeCtx()
    await pdfFormat.handlePdf(ctx)
    sendReady(viewerFrame())
    await flush(10)
    expect(notes).toContain(
      '전용 뷰어에서는 찾기·돋보기·주석·양식 입력을 할 수 있습니다. 본문·그림 직접 편집과 XFA 양식은 제한됩니다.',
    )
    // 복원 당시 깨진 형태('등 찾기 돋보기', '는. 합니다')가 없어야 한다.
    expect(notes.join(' ')).not.toContain('등 찾기')
    expect(notes.join(' ')).not.toContain('는. 합니다')
  })

  test('편집기 안내(CRAFT_NOTE)는 자연스러운 한국어 문장이다', async () => {
    folded = false
    const ctx = makeCtx()
    await pdfFormat.handlePdf(ctx)
    expect(createHost).toHaveBeenCalledTimes(1)
    const opts: any = (createHost.mock.calls as any)[0][0]
    opts.onReady()
    await flush(10)
    expect(notes).toContain(
      '전용 편집기에서는 페이지 정리·주석·양식 입력을 할 수 있습니다. 본문·그림 직접 편집은 제한됩니다.',
    )
    expect(notes.join(' ')).not.toContain('등 페이지')
  })

  test('대체 화면 안내도 자연스러운 한국어 문장이다', async () => {
    pdfFormat.internals.readyTimeoutMs = 50
    const ctx = makeCtx()
    await pdfFormat.handlePdf(ctx)
    await flush(120)
    expect(notes).toContain(
      '전용 뷰어를 불러오지 못해 기본 미리보기로 표시합니다 (주석 조작은 할 수 없습니다)',
    )
    expect(notes.join(' ')).not.toContain('조작등 합니다')
  })
})
