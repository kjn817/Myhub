/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 오피스 부팅 로딩 화면 (2026-11-13 사용자 지시).
 *
 * 배경: 오피스 앱을 실행하면 빈 셸("오피스" + 파일 열기 버튼)이 먼저
 * 보이고, 그다음 진행 막대가 나왔다가 로딩 화면이 떴다. 사용자는
 * "로딩 페이지가 바로 나오면 된다"고 했다. 수정: 정적 마크업인 부팅
 * 로딩 화면(#officeBootLoading)이 스크립트 실행 전부터 보이고, 첫
 * 문서가 열리면(성공·실패 모두) 사라진다. 진행 막대(#officeProgress)는
 * 이 화면으로 대체되어 삭제됐다.
 *
 * 검증 성질:
 * - 정적: office.html에 #officeBootLoading이 hidden 없이 있고,
 *   #officeProgress 요소가 없으며, office.js에 showProgress/
 *   hideProgress가 없다. office-boot.js가 office.js보다 먼저
 *   로딩되고 static-assets.json에 등록돼 있다.
 * - 부팅 직후 로딩 화면이 보인다. 앱별 제목·문구는 office-boot.js가
 *   넣는다 (office.js init보다 먼저 실행돼야 일반 문구가 보였다가
 *   바뀌는 깜빡임이 없다).
 * - 새 문서 열기가 끝나면(성공·실패 모두) 로딩 화면이 사라진다.
 * - 파일 열기가 끝나면(성공·실패 모두) 로딩 화면이 사라진다.
 *
 * 카나리아: newDocument 성공 경로에서 hideBootLoading()을 빼면
 * '새 문서 열기가 끝나면 로딩 화면이 사라진다' 테스트가 실패하고,
 * office.html의 부팅 로딩 섹션에 hidden을 붙이면 정적 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const OFFICE_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'office.js'), 'utf-8')
const CONSTANTS_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'common', 'constants.js'), 'utf-8')
const DRIVE_IO_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'common', 'drive-io.js'), 'utf-8')
const JSON_STORE_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'common', 'json-store.js'), 'utf-8')
const OFFICE_BOOT_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'office-boot.js'), 'utf-8')
const OFFICE_HTML = fs.readFileSync(path.join(ROOT, 'public', 'office.html'), 'utf-8')
const OFFICE_CSS = fs.readFileSync(path.join(ROOT, 'public', 'css', 'office.css'), 'utf-8')
const STATIC_ASSETS = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'scripts', 'static-assets.json'), 'utf-8'),
) as { files: string[] }

const getWin = (): any => (globalThis as any).window
const getDoc = (): any => (globalThis as any).document

function flush(ms = 0) {
  return new Promise((r) => setTimeout(r, ms))
}

function setupOffice(opts: { autoNew?: boolean; templateOk?: boolean; openOk?: boolean } = {}) {
  const win = getWin()
  const doc = getDoc()
  // office.js IIFE는 #officeStart가 있으면 자동 부팅한다 — 픽스처를 넣기
  // 전에 먼저 로드해 자동 부팅을 피하고 createApp만 직접 부른다.
  doc.body.innerHTML = ''
  // F-L5/F-L7: 공용 코어를 office.js보다 먼저 뜬다 (운영 정적 태그 순서).
  // 5-9: 공용 상수는 drive-io보다도 먼저 (drive-io도 상수 소비자다).
  new Function('window', 'document', CONSTANTS_JS)(win, doc)
  new Function('window', 'document', DRIVE_IO_JS)(win, doc)
  new Function('window', 'document', JSON_STORE_JS)(win, doc)
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
  let rejectOpen!: (e: any) => void
  const openPromise = new Promise<void>((res, rej) => {
    resolveOpen = res
    rejectOpen = rej
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
    fetchFn: jest.fn(async () => {
      if (opts.templateOk === false) throw new Error('template 404')
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }
    }),
    viewerFactory: () => viewerStub,
  })
  return {
    doc,
    app,
    viewerStub,
    bootEl: () => doc.getElementById('officeBootLoading') as any,
    resolveOpen: () => resolveOpen(),
    rejectOpen: () => rejectOpen(new Error('viewer open failed')),
  }
}

describe('오피스 부팅 로딩 화면 (정적)', () => {
  test('office.html에 부팅 로딩 섹션이 hidden 없이 있고 진행 막대가 없다', () => {
    const bootTag = OFFICE_HTML.match(/<section[^>]*id="officeBootLoading"[^>]*>/)
    expect(bootTag).toBeTruthy()
    expect(bootTag![0]).not.toMatch(/\bhidden\b/)
    expect(OFFICE_HTML).toContain('id="officeBootTitle"')
    expect(OFFICE_HTML).toContain('id="officeBootStatus"')
    expect(OFFICE_HTML).not.toContain('id="officeProgress"')
    expect(OFFICE_HTML).not.toContain('office-progress-track')
  })

  test('office.css에 부팅 로딩 스타일이 있고 진행 막대 스타일이 없다', () => {
    expect(OFFICE_CSS).toContain('.office-boot-loading')
    expect(OFFICE_CSS).toContain('.office-boot-loading-spin')
    expect(OFFICE_CSS).not.toContain('.office-progress')
  })

  test('office.js에 진행 막대 함수가 없고 부팅 로딩 해제 함수가 있다', () => {
    expect(OFFICE_JS).not.toContain('showProgress')
    expect(OFFICE_JS).not.toContain('hideProgress')
    expect(OFFICE_JS).toContain('hideBootLoading')
    // 앱별 문구는 office-boot.js 몫이다 — office.js가 다시 만지면
    // 문구 책임이 두 곳으로 갈린다.
    expect(OFFICE_JS).not.toContain('bootStatus')
    expect(OFFICE_JS).not.toContain('bootTitleEl')
  })

  test('office-boot.js가 office.js보다 먼저 로딩되고 매니페스트에 있다', () => {
    // preload 링크(<head>)와 스크립트 태그(본문)가 같은 경로를 쓰므로
    // 태그 문자열로 구분해서 찾는다 — 맨 경로로 찾으면 preload가 잡힌다.
    const preloadIdx = OFFICE_HTML.indexOf('<link rel="preload" href="/js/office-boot.js" as="script">')
    const bootIdx = OFFICE_HTML.indexOf('<script src="/js/office-boot.js"></script>')
    const officeIdx = OFFICE_HTML.indexOf('<script src="/js/office.js"></script>')
    expect(preloadIdx).toBeGreaterThan(-1)
    expect(bootIdx).toBeGreaterThan(-1)
    expect(officeIdx).toBeGreaterThan(-1)
    expect(bootIdx).toBeLessThan(officeIdx)
    // 부팅 섹션 바로 뒤에 있어야 첫 페인트 전에 문구가 들어간다.
    const sectionIdx = OFFICE_HTML.indexOf('id="officeBootLoading"')
    const toolbarIdx = OFFICE_HTML.indexOf('class="office-toolbar"')
    expect(bootIdx).toBeGreaterThan(sectionIdx)
    expect(bootIdx).toBeLessThan(toolbarIdx)
    expect(STATIC_ASSETS.files).toContain('/js/office-boot.js')
  })
})

describe('오피스 부팅 문구 (office-boot.js)', () => {
  function setupBootText(search: string) {
    const win = getWin()
    const doc = getDoc()
    doc.body.innerHTML = `
<section class="office-boot-loading" id="officeBootLoading">
  <div class="office-boot-loading-title" id="officeBootTitle">오피스</div>
  <div class="office-boot-loading-spin"></div>
  <div class="office-boot-loading-status" id="officeBootStatus">불러오는 중…</div>
</section>`
    new Function('window', 'document', OFFICE_BOOT_JS)(win, doc)
    win.MyHubOfficeBoot.setBootText(search, doc)
    return doc
  }

  test.each([
    ['?app=excel', 'Excel', '시트 편집기를 불러오는 중'],
    ['?app=hangul', '한글 2020', '한글 편집기를 불러오는 중'],
    ['?app=powerpoint', 'PowerPoint', '프레젠테이션 편집기를 불러오는 중'],
    ['?app=pdf', 'PDF', 'PDF 뷰어를 불러오는 중'],
  ])('%s이면 앱별 제목·문구가 들어간다', (search, title, status) => {
    const doc = setupBootText(search)
    expect((doc.getElementById('officeBootTitle') as any).textContent).toBe(title)
    expect((doc.getElementById('officeBootStatus') as any).textContent).toBe(status)
  })

  test('알 수 없는 앱이면 Excel 문구로 떨어진다', () => {
    const doc = setupBootText('?app=unknown')
    expect((doc.getElementById('officeBootTitle') as any).textContent).toBe('Excel')
  })
})

describe('오피스 부팅 로딩 화면 (동작)', () => {
  test('부팅 직후 로딩 화면이 보인다 (문구는 office-boot.js 몫)', () => {
    const { bootEl } = setupOffice()
    expect(bootEl().hidden).toBe(false)
  })

  test('새 문서 열기가 끝나면 로딩 화면이 사라진다', async () => {
    const { app, bootEl, resolveOpen } = setupOffice()
    const p = app.newDocument()
    await flush(20)
    // 여는 중에는 로딩 화면이 계속 보인다.
    expect(bootEl().hidden).toBe(false)
    resolveOpen()
    await p
    expect(bootEl().hidden).toBe(true)
  })

  test('새 문서 열기가 실패해도 로딩 화면이 사라지고 시작 화면이 보인다', async () => {
    const { doc, app, bootEl } = setupOffice({ templateOk: false })
    const ok = await app.newDocument()
    expect(ok).toBe(false)
    expect(bootEl().hidden).toBe(true)
    expect((doc.getElementById('officeStart') as any).hidden).toBe(false)
  })

  test('파일 열기가 끝나면 로딩 화면이 사라진다', async () => {
    const { app, bootEl, resolveOpen } = setupOffice()
    const p = app.openFile({ fileId: 102, name: 'test.hwp', mime: 'application/x-hwp' })
    await flush(20)
    expect(bootEl().hidden).toBe(false)
    resolveOpen()
    await p
    expect(bootEl().hidden).toBe(true)
  })

  test('파일 열기가 실패해도 로딩 화면이 사라진다', async () => {
    const { app, bootEl, rejectOpen } = setupOffice()
    const p = app.openFile({ fileId: 102, name: 'test.hwp', mime: 'application/x-hwp' })
    await flush(20)
    expect(bootEl().hidden).toBe(false)
    rejectOpen()
    const ok = await p
    expect(ok).toBe(false)
    expect(bootEl().hidden).toBe(true)
  })
})
