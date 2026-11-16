/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 오피스 형식 모듈 지연 로드 (2026-11-16, 성능 6라운드).
 *
 * 배경: office.html이 형식 모듈 14개(321KB)를 정적으로 먼저 받아
 * 스로틀링 오피스 열기가 4.2초였다. 이제 정적 태그를 빼고, 파일이
 * 실제로 열 때 뷰어 코어의 ensureFormat 훅이 office.js의 로더로
 * 해당 kind 모듈만 순서대로 동적 import한다 (Finder와 같은 패턴).
 * 엔진 프리패치도 load 뒤에 자기 앱 엔진만 데운다.
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - office.html에 14개 형식 모듈 정적 태그가 하나도 없다.
 * - ensureFormat(kind)이 kind별 모듈만 순서대로 import한다
 *   (xlsx 2개·pptx 4개·pdf 5개·hwp 3개).
 * - 모르는 kind는 import하지 않는다.
 * - 같은 kind를 두 번 불러도 각 URL은 한 번만 import한다 (캐시).
 * - getViewer가 viewerFactory에 ensureFormat을 넘긴다 (배선).
 * - 앱 엔진 프리패치는 자기 앱 래퍼만 부른다 (excel→gridcraft,
 *   powerpoint→deckcraft, hangul→rhwp, pdf→없음).
 * 카나리아: 맵·순서·캐시·배선을 깨면 해당 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const OFFICE_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'office.js'), 'utf-8')
const OFFICE_HTML = fs.readFileSync(path.join(ROOT, 'public', 'office.html'), 'utf-8')
const CONSTANTS_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'common', 'constants.js'), 'utf-8')

const getWin = (): any => (globalThis as any).window
const getDoc = (): any => (globalThis as any).document

const STATIC_REMOVED = [
  '/js/finder-format-text.js',
  '/js/finder-format-hwp.js',
  '/js/craft-clipboard.js',
  '/js/finder-format-sheet.js',
  '/js/craft-prefetch-core.js',
  '/js/gridcraft-prefetch.js',
  '/js/deckcraft-prefetch.js',
  '/js/rhwp-prefetch.js',
  '/js/finder-deckcraft.js',
  '/js/finder-format-slide.js',
  '/js/finder-format-doc.js',
  '/js/finder-pdf-ops.js',
  '/js/finder-pdfcraft.js',
  '/js/finder-format-pdf.js',
]

function flush(ms = 0) {
  return new Promise((r) => setTimeout(r, ms))
}

function setupOffice(search: string) {
  const win = getWin()
  const doc = getDoc()
  doc.body.innerHTML = ''
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
  const imported: string[] = []
  const importModule = jest.fn((url: string) => {
    imported.push(url)
    return Promise.resolve({})
  })
  const viewerDeps: any[] = []
  const viewerStub = { open: jest.fn(() => Promise.resolve()), close: jest.fn() }
  const api = win.MyHubOffice
  const app = api.createApp({
    doc,
    search,
    fetchFn: jest.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) })),
    viewerFactory: (deps: any) => {
      viewerDeps.push(deps)
      return viewerStub
    },
    importModule,
  })
  return { app, imported, importModule, viewerDeps, viewerStub }
}

describe('오피스 형식 모듈 지연 로드', () => {
  test('office.html에 형식 모듈 정적 태그가 하나도 없다', () => {
    for (const url of STATIC_REMOVED) {
      expect(OFFICE_HTML).not.toContain(`<script src="${url}"`)
    }
    // 뷰어 코어·부팅 스크립트는 그대로 정적이다.
    expect(OFFICE_HTML).toContain('<script src="/js/finder-viewer.js"')
    expect(OFFICE_HTML).toContain('<script src="/js/office.js"')
  })

  test('xlsx는 클립보드→시트 순서로 2개만 import한다', async () => {
    const { app, imported } = setupOffice('?app=pdf')
    imported.length = 0
    await app.ensureFormat('xlsx')
    expect(imported).toEqual(['/js/craft-clipboard.js', '/js/finder-format-sheet.js'])
  })

  test('pptx는 코어→클립보드→deckcraft→슬라이드 순서로 4개 import한다', async () => {
    const { app, imported } = setupOffice('?app=pdf')
    imported.length = 0
    await app.ensureFormat('pptx')
    expect(imported).toEqual([
      '/js/craft-prefetch-core.js',
      '/js/craft-clipboard.js',
      '/js/finder-deckcraft.js',
      '/js/finder-format-slide.js',
    ])
  })

  test('pdf는 5개 체인 순서대로 import한다', async () => {
    const { app, imported } = setupOffice('?app=pdf')
    imported.length = 0
    await app.ensureFormat('pdf')
    expect(imported).toEqual([
      '/js/finder-pdf-ops.js',
      '/js/craft-prefetch-core.js',
      '/js/craft-clipboard.js',
      '/js/finder-pdfcraft.js',
      '/js/finder-format-pdf.js',
    ])
  })

  test('hwp는 코어→rhwp 프리패치→hwp 순서로 3개 import한다', async () => {
    const { app, imported } = setupOffice('?app=pdf')
    imported.length = 0
    await app.ensureFormat('hwp')
    expect(imported).toEqual([
      '/js/craft-prefetch-core.js',
      '/js/rhwp-prefetch.js',
      '/js/finder-format-hwp.js',
    ])
  })

  test('모르는 kind는 import하지 않는다', async () => {
    const { app, importModule } = setupOffice('?app=pdf')
    importModule.mockClear()
    await app.ensureFormat('unknown-kind')
    expect(importModule).not.toHaveBeenCalled()
  })

  test('같은 kind를 두 번 불러도 각 URL은 한 번만 import한다', async () => {
    const { app, imported } = setupOffice('?app=pdf')
    imported.length = 0
    await app.ensureFormat('xlsx')
    await app.ensureFormat('xlsx')
    await app.ensureFormat('xls')
    expect(imported).toEqual(['/js/craft-clipboard.js', '/js/finder-format-sheet.js'])
  })

  test('getViewer가 viewerFactory에 ensureFormat을 넘긴다', async () => {
    const { app, viewerDeps } = setupOffice('?app=excel')
    await app.openFile({ fileId: 102, name: 'test.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    expect(viewerDeps.length).toBe(1)
    expect(typeof viewerDeps[0].ensureFormat).toBe('function')
    expect(viewerDeps[0].ensureFormat).toBe(app.ensureFormat)
  })

  test('앱 엔진 프리패치는 자기 앱 래퍼만 부른다', async () => {
    const cases: Array<[string, string | null]> = [
      ['?app=excel', '/js/gridcraft-prefetch.js'],
      ['?app=powerpoint', '/js/deckcraft-prefetch.js'],
      ['?app=hangul', '/js/rhwp-prefetch.js'],
      ['?app=pdf', null],
    ]
    for (const [search, wrapper] of cases) {
      const { imported } = setupOffice(search)
      await flush(20)
      if (wrapper) {
        expect(imported).toEqual(['/js/craft-prefetch-core.js', wrapper])
      } else {
        expect(imported).toEqual([])
      }
    }
  })
})
