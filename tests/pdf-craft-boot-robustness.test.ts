/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
// 모듈 스코프 선언 (2026-11-18): pdf-format-fallback.test.ts와 동명
// 최상위 선언(createHost 등)이 전역 스코프에서 TS2451 충돌을 냈다.
export {};
/**
 * PDF 편집기 부팅 강건화 — 포맷 층 (2026-11-15, 1dc37bf 패턴의 PDF 적용).
 *
 * 배경: PdfCraft 부팅이 45초 고정 워치독에 걸려 조용히 뷰어로 폴백했고,
 * 사용자는 메뉴가 사라진 이유를 알 수 없었다. 이제 브리지가 부팅 게이트
 * 프리패치+재시도를 돌리고, 포맷 층은 진행을 상태 표시줄에 띄우며,
 * 전부 실패하면 실패를 알리고 다시 시도를 제공한다.
 *
 * 검증 성질:
 * - onBootProgress가 'PDF 엔진 받는 중… XMB'를 상태 표시줄에 띄우고,
 *   재시도 때는 '(다시 시도 N/M)'을 붙인다.
 * - onReady가 되면 진행 표시가 지워진다.
 * - 전부 실패하면 노트에 실패를 알리고 다시 시도 패널이 뜨며,
 *   [다시 시도]를 누르면 startCraft가 다시 돌아 createHost가 또 불린다.
 * - [닫기]는 패널만 닫고 호스트를 다시 만들지 않는다.
 * - 페이지 조작 확인이 떠 있을 때는 폴백이 패널을 덮지 않는다.
 * - 편집기가 떠 있던 상태에서 실패하면 뷰어로 돌아가고 패널이 뜬다.
 *
 * 카나리아: showCraftRetry 호출을 빼면 세 번째 테스트가 실패하고,
 * onBootProgress 배선을 빼면 첫 테스트가 실패한다.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../public/js/common/constants.js')
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../public/js/finder-codec.js')
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../public/js/finder-pdf-ops.js')
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../public/js/finder-viewer.js')

const win: any = (globalThis as any).window
const doc: any = (globalThis as any).document

// 가짜 PdfCraft 브리지 — 호출마다 deps를 캡처해 테스트가 콜백을 직접
// 구동한다. 모듈 로드 전에 window에 올려야 한다.
const capturedDeps: any[] = []
const createHost = jest.fn((deps: any) => {
  capturedDeps.push(deps)
  return {
    frame: doc.createElement('div'),
    destroy: jest.fn(),
    open: jest.fn(() => true),
    sendMode: jest.fn(),
    sendMenuCommand: jest.fn(() => true),
  }
})
win.MyHubFinderPdfCraft = { createHost }
const fontsLoad = jest.fn()
win.MyHubFonts = { load: fontsLoad }

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfFormat = require('../public/js/finder-format-pdf.js')

const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms))

describe('PDF 편집기 부팅 강건화', () => {
  let bodyEl: any
  let notes: string[]
  let teardowns: Array<() => void>

  function makeCtx() {
    bodyEl = doc.createElement('div')
    doc.body.appendChild(bodyEl)
    let alive = true
    let folded = false // 펼친 상태 — 편집기 시작 조건 충족
    teardowns.push(() => { alive = false })
    return {
      doc,
      body: bodyEl,
      file: { fileId: 5, name: '문서.pdf' },
      minimalChrome: false,
      chromeFold: null,
      saveBtn: doc.createElement('button'),
      clearBody: () => { bodyEl.innerHTML = '' },
      contentUrl: () => '/api/drive/files/5/content',
      fetchContent: jest.fn(() => Promise.resolve(new ArrayBuffer(0))),
      fetchRaw: jest.fn(() => Promise.resolve({ ok: true })),
      isCurrent: () => alive,
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
    doc.body.innerHTML = ''
    notes = []
    teardowns = []
    capturedDeps.length = 0
    jest.clearAllMocks()
  })

  afterEach(() => {
    teardowns.forEach((fn) => fn())
  })

  function viewerFrame() {
    return bodyEl.querySelector('iframe.fv-pdf-frame')
  }

  function sendReady(frame: any, pages = 3) {
    win.dispatchEvent(
      new win.MessageEvent('message', {
        data: { type: 'myhub-pdf:ready', pages },
        origin: win.location.origin,
        source: frame.contentWindow,
      }),
    )
  }

  function retryPanel() {
    return bodyEl.querySelector('.fv-pdf-panel')
  }

  function panelButton(label: string) {
    const panel = retryPanel()
    if (!panel) return null
    return [...panel.querySelectorAll('button')].find(
      (b: any) => (b.textContent || '') === label,
    ) as any
  }

  async function mountAndReady() {
    const ctx: any = makeCtx()
    await pdfFormat.handlePdf(ctx)
    sendReady(viewerFrame())
    await flush(10)
    expect(createHost).toHaveBeenCalledTimes(1)
    return ctx
  }

  test('onBootProgress가 MB 진행을 상태 표시줄에 띄운다', async () => {
    const ctx: any = await mountAndReady()
    capturedDeps[0].onBootProgress({
      receivedBytes: 3 * 1048576,
      filesDone: 1,
      filesTotal: 4,
      attempt: 1,
      maxAttempts: 3,
    })
    expect(ctx.setStatus).toHaveBeenCalledWith('PDF 엔진 받는 중… 3.0MB')
    capturedDeps[0].onBootProgress({
      receivedBytes: 10 * 1048576,
      filesDone: 2,
      filesTotal: 4,
      attempt: 2,
      maxAttempts: 3,
    })
    expect(ctx.setStatus).toHaveBeenCalledWith('PDF 엔진 받는 중… 10.0MB (다시 시도 2/3)')
  })

  test('onReady가 되면 진행 표시가 지워지고 편집기가 뜬다', async () => {
    const ctx: any = await mountAndReady()
    capturedDeps[0].onBootProgress({ receivedBytes: 1048576, attempt: 1, maxAttempts: 3 })
    expect(ctx.setStatus).toHaveBeenCalledWith('PDF 엔진 받는 중… 1.0MB')
    capturedDeps[0].onReady()
    await flush(10)
    expect(ctx.setStatus).toHaveBeenCalledWith('')
    const stateEl = bodyEl.querySelector('.fv-pdf-state')
    expect(stateEl && stateEl.textContent).toBe('전용 편집기')
  })

  test('전부 실패하면 다시 시도 패널이 뜨고 [다시 시도]가 부팅을 다시 돈다', async () => {
    const ctx: any = await mountAndReady()
    capturedDeps[0].onFallback('prefetch-failed')
    expect(notes.join(' ')).toContain('불러오지 못해 기본 뷰어로 표시합니다')
    const panel = retryPanel()
    expect(panel).not.toBeNull()
    expect(panel.hidden).toBe(false)
    expect(panel.textContent).toContain('전용 편집기를 불러오지 못했습니다')
    const retry = panelButton('다시 시도')
    expect(retry).not.toBeNull()
    retry.click()
    await flush(10)
    expect(createHost).toHaveBeenCalledTimes(2)
    expect(retryPanel().hidden).toBe(true)
  })

  test('[닫기]는 패널만 닫고 호스트를 다시 만들지 않는다', async () => {
    await mountAndReady()
    capturedDeps[0].onFallback('timeout')
    expect(retryPanel().hidden).toBe(false)
    const close = panelButton('닫기')
    expect(close).not.toBeNull()
    close.click()
    expect(retryPanel().hidden).toBe(true)
    expect(createHost).toHaveBeenCalledTimes(1)
  })

  test('페이지 조작 확인이 떠 있을 때는 폴백이 패널을 덮지 않는다', async () => {
    await mountAndReady()
    const rotate = bodyEl.querySelector('[data-act="rotate"]') as any
    expect(rotate).not.toBeNull()
    rotate.click()
    expect(retryPanel().hidden).toBe(false)
    expect(retryPanel().textContent).toContain('회전합니다')
    capturedDeps[0].onFallback('prefetch-failed')
    // 조작 확인이 그대로 남아야 한다 — 다시 시도 버튼이 생기면 안 된다.
    expect(retryPanel().textContent).toContain('회전합니다')
    expect(panelButton('다시 시도')).toBeUndefined()
  })

  test('편집기가 떠 있던 상태에서 실패하면 뷰어로 돌아가고 패널이 뜬다', async () => {
    await mountAndReady()
    capturedDeps[0].onReady()
    await flush(10)
    expect(bodyEl.querySelector('.fv-pdf-state').textContent).toBe('전용 편집기')
    capturedDeps[0].onFallback('failed: engine')
    expect(bodyEl.querySelector('.fv-pdf-state').textContent).toBe('1 / 3 페이지')
    expect(retryPanel().hidden).toBe(false)
    expect(panelButton('다시 시도')).not.toBeNull()
  })
})
