/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 오피스 자동 새 문서 진입과 파일 열기 경합 (2026-11-13).
 *
 * 배경: 부팅 직후 빈 문서를 먼저 만들면 파일 열기가 그 뒤에 줄을 서서
 * 빈 문서 로딩이 파일 로딩 전에 보였다. 수정: 자동 진입을 200ms 미루고,
 * 그 안에 파일 열기가 오면 타이머를 취소하고 파일만 연다.
 *
 * (구 office-progress-handoff.test.ts에서 진행 막대 테스트를 뺀 파일 —
 * 진행 막대는 2026-11-13 부팅 로딩 화면으로 대체되어 삭제됐다. 막대
 * 이어받기 성질은 tests/office-boot-loading.test.ts가 대신 가드한다.)
 *
 * 검증 성질:
 * - 파일 열기가 오면 자동 새 문서 진입이 취소되고 파일만 열린다.
 * - 파일 열기가 없으면 200ms 뒤 자동 새 문서 진입이 실행된다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const OFFICE_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'office.js'), 'utf-8')
const CONSTANTS_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'common', 'constants.js'), 'utf-8')

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
  // 5-9: 공용 상수를 office.js보다 먼저 뜬다 (운영 정적 태그 순서).
  new Function('window', 'document', CONSTANTS_JS)(win, doc)
  new Function('window', 'document', OFFICE_JS)(win, doc)
  doc.body.innerHTML = `
<section class="office-boot-loading" id="officeBootLoading" aria-label="불러오는 중">
  <div class="office-boot-loading-title" id="officeBootTitle">오피스</div>
  <div class="office-boot-loading-spin" aria-hidden="true"></div>
  <div class="office-boot-loading-status" id="officeBootStatus">불러오는 중…</div>
</section>
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
    viewerFactory: () => viewerStub,
  })
  return { doc, app, viewerStub, resolveOpen: () => resolveOpen() }
}

describe('자동 새 문서 진입과 파일 열기 경합', () => {
  test('파일 열기가 오면 자동 새 문서 진입이 취소되고 파일만 열린다', async () => {
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
