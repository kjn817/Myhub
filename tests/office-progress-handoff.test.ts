/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 오피스 진행 막대 → 뷰어 로딩 화면 이어받기 (2026-11-13 사용자 지적).
 *
 * 배경: 한글 파일을 열면 다운로드 막대(막대형)가 먼저 보이고, 그 위에
 * "한글 편집기를 불러오는 중" 원형 로딩이 겹쳐 보였다. 원인은 office.js가
 * fetch 'parse' 단계(다운로드 완료)에서도 showProgress('여는 중…')로
 * 막대를 계속 유지했기 때문이다. 수정: 'parse' 단계에서는 막대를 치우고
 * 뷰어의 로딩 화면이 이어받는다.
 *
 * 검증 성질:
 * - 다운로드 중에는 막대가 보인다 (진행률 표시).
 * - 'parse' 단계가 오면 막대가 사라진다 (뷰어 로딩 화면이 이어받음).
 * - 열기가 끝나면 막대는 계속 숨은 상태다.
 *
 * 카나리아: office.js에서 'parse' 단계의 hideProgress()를 다시
 * showProgress('여는 중…')로 바꾸면 두 번째 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const OFFICE_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'office.js'), 'utf-8')

const getWin = (): any => (globalThis as any).window
const getDoc = (): any => (globalThis as any).document

function flush(ms = 0) {
  return new Promise((r) => setTimeout(r, ms))
}

function setupOffice(opts: { autoNew?: boolean } = {}) {
  const win = getWin()
  const doc = getDoc()
  // office.js IIFE는 #officeStart가 있으면 자동 부팅한다 — 픽스처를 넣기
  // 전에 먼저 로드해 자동 부팅을 피하고 createApp만 직접 부른다.
  doc.body.innerHTML = ''
  new Function('window', 'document', OFFICE_JS)(win, doc)
  doc.body.innerHTML = `
<div class="office-progress" id="officeProgress" hidden>
  <div class="office-progress-track"><div class="office-progress-fill" id="officeProgressFill"></div></div>
  <span class="office-progress-label" id="officeProgressLabel"></span>
</div>
<section class="office-start" id="officeStart" hidden>
  <div class="office-start-icon" id="officeStartIcon"></div>
  <h1 class="office-start-name" id="officeStartName">오피스</h1>
  <p class="office-start-desc" id="officeStartDesc"></p>
  <div class="office-start-actions">
    <button type="button" id="officeStartOpen"></button>
    <button type="button" id="officeStartNew" hidden></button>
  </div>
  <div class="office-resume" id="officeResume" hidden>
    <button type="button" id="officeResumeBtn"></button>
  </div>
  <div class="office-recent" id="officeRecentWrap" hidden>
    <div class="office-recent-list" id="officeRecent"></div>
  </div>
</section>
<div class="office-tabs" id="officeTabs" hidden></div>
<div class="finder-viewer office-viewer" id="finderViewer" hidden>
  <div class="finder-viewer-body" id="fvBody"></div>
</div>
<button type="button" id="officeOpenBtn"></button>
<button type="button" id="officeNewBtn" hidden></button>
<button type="button" id="officeCloseBtn" hidden></button>
<span id="officeAppName"></span>
<span id="officeBrandIcon"></span>
<strong id="officeBrandName"></strong>
<span id="clock"></span>`
  let onProgress: ((p: any) => void) | null = null
  let resolveOpen!: () => void
  const openPromise = new Promise<void>((res) => {
    resolveOpen = res
  })
  const viewerStub = {
    open: jest.fn(() => openPromise),
    close: jest.fn(),
  }
  const api = win.MyHubOffice
  const app = api.createApp({
    doc,
    search: '?app=hangul',
    autoNew: opts.autoNew === true,
    fetchFn: jest.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(8),
    })),
    fetchFactory: (opts: any) => {
      onProgress = opts.onProgress
      return {
        fetch: jest.fn(async () => ({ ok: true, status: 200 })),
        expectVersion: jest.fn(),
        invalidate: jest.fn(),
      }
    },
    viewerFactory: () => viewerStub,
  })
  return {
    doc,
    app,
    viewerStub,
    fireProgress: (p: any) => {
      if (!onProgress) throw new Error('onProgress가 등록되지 않았다')
      onProgress(p)
    },
    resolveOpen: () => resolveOpen(),
  }
}

describe('오피스 진행 막대 → 로딩 화면 이어받기', () => {
  test('다운로드 중에는 막대가 보이고 parse 단계에서 사라진다', async () => {
    const { doc, app, fireProgress, resolveOpen } = setupOffice()
    const progress = doc.getElementById('officeProgress') as any
    expect(progress.hidden).toBe(true)
    const p = app.openFile({ fileId: 102, name: 'test.hwp', mime: 'application/x-hwp' })
    await flush(20)
    // 열기 시작 + 다운로드 진행 중에는 막대가 보인다.
    expect(progress.hidden).toBe(false)
    fireProgress({ phase: 'download', got: 50, total: 100 })
    expect(progress.hidden).toBe(false)
    expect((doc.getElementById('officeProgressLabel') as any).textContent).toBe('받는 중 50%')
    // 다운로드 완료(parse) — 막대가 사라지고 뷰어 로딩 화면이 이어받는다.
    fireProgress({ phase: 'parse' })
    expect(progress.hidden).toBe(true)
    resolveOpen()
    await p
    expect(progress.hidden).toBe(true)
  })
})

describe('자동 새 문서 진입과 파일 열기 경합', () => {
  test('파일 열기가 오면 자동 새 문서 진입이 취소되고 파일만 열린다', async () => {
    // 2026-11-13: 부팅 직후 빈 문서를 먼저 만들면 파일 열기가 그 뒤에
    // 줄을 서서 빈 문서 로딩이 파일 로딩 전에 보였다.
    const { app, viewerStub, resolveOpen } = setupOffice({ autoNew: true })
    const p = app.openFile({ fileId: 102, name: 'test.hwp', mime: 'application/x-hwp' })
    // 파일 열기를 200ms 안에 끝낸다 — 취소가 없으면 타이머가 빈 문서를
    // 파일 위에 열어 버린다 (opening이 이미 false가 됐기 때문).
    await flush(20)
    resolveOpen()
    await p
    await flush(300)
    // 200ms 지연이 지나도 빈 문서(fileId 0)는 열리지 않는다.
    const opened = viewerStub.open.mock.calls.map((c: any) => c[0].fileId)
    expect(opened).toEqual([102])
  })

  test('파일 열기가 없으면 200ms 뒤 자동 새 문서 진입이 실행된다', async () => {
    const { viewerStub, resolveOpen } = setupOffice({ autoNew: true })
    await flush(50)
    // 지연 중에는 아직 빈 문서가 열리지 않는다.
    expect(viewerStub.open).not.toHaveBeenCalled()
    await flush(250)
    const opened = viewerStub.open.mock.calls.map((c: any) => c[0].fileId)
    expect(opened).toEqual([0])
    resolveOpen()
    await flush(20)
  })
})
