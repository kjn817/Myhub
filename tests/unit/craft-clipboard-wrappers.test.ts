/// <reference types="jest" />
/**
 * 붙여넣기 헬퍼 소비처 동등성 테스트 (F-L2 통합, 5-3).
 *
 * 코어 위임으로 바꾼 5개 사이트가 구 동작과 같은 계약을 유지하는지
 * 고정한다:
 * - 5개 파일에 내장 헬퍼 정의가 없고 코어 참조만 남았다 (구조).
 * - 공개 API의 헬퍼가 코어 함수와 동일 참조다 (동작이 아니라 참조
 *   자체를 고정 — 위임이 빠지면 실패한다).
 * - slide/sheet의 인라인 32MB 리터럴이 코어 상한으로 바뀌었다.
 * - 로딩 순서: office.html·sheet.html 정적 태그와 finder.js 동적
 *   import 체인에서 코어가 소비처보다 먼저 온다.
 * - 코어 없이 소비처만 받아도 로드는 되고 붙여넣기는 조용히
 *   건너뛴다 (열화 경로).
 * 카나리아: 소비처가 로컬 정의를 되살리면 구조 테스트가, 코어
 * 태그 순서를 뒤집으면 로딩 순서 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..', '..')
const CORE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'craft-clipboard.js'), 'utf-8')
const CONSTANTS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'common', 'constants.js'), 'utf-8')
const DECK_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'finder-deckcraft.js'), 'utf-8')
const SLIDE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'finder-format-slide.js'), 'utf-8')
const SHEET_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'finder-format-sheet.js'), 'utf-8')
const GRID_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'sheet-gridcraft.js'), 'utf-8')
const PDF_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'finder-pdfcraft.js'), 'utf-8')
const FINDER_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'finder.js'), 'utf-8')
const OFFICE_HTML = fs.readFileSync(path.join(ROOT, 'public', 'office.html'), 'utf-8')
const SHEET_HTML = fs.readFileSync(path.join(ROOT, 'public', 'sheet.html'), 'utf-8')
const STATIC_ASSETS = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'scripts', 'static-assets.json'), 'utf-8'),
)
const ASSET_URL_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'asset-url.js'), 'utf-8')

/**
 * 샌드박스에 소스를 순서대로 실행한다. 코어를 먼저 받아야 소비처가
 * 동작한다 (실제 로드 순서와 같다). slide/sheet는 뷰어 코어가 없으면
 * IIFE 시작 시점에 그대로 끝나므로 뷰어 스텁을 넣어 준다.
 * document를 주지 않으면 자동 부팅 블록이 건너뛰어진다.
 */
function loadSources(
  sources: string[],
  opts: { win?: any; doc?: any; quietWarn?: boolean } = {},
): { win: any; moduleObj: any } {
  const win = opts.win !== undefined ? opts.win : {}
  if (!win.MyHubFinderViewer) {
    win.MyHubFinderViewer = { registerFormat: () => undefined }
  }
  const moduleObj: any = { exports: {} }
  const fakeConsole: any = {
    warn: opts.quietWarn ? () => undefined : (...args: any[]) => console.warn(...args),
    log: (...args: any[]) => console.log(...args),
    error: (...args: any[]) => console.error(...args),
  }
  // 5-9: 공용 상수를 항상 먼저 뜬다 (운영 페이지의 태그 순서와 동일 —
  // finder-deckcraft·sheet-gridcraft 등 소비처는 상수 없이는 로드 시점에
  // 실패한다. "클립보드 코어 부재" 열화 테스트와는 무관한 전제다).
  const allSources = [CONSTANTS_SRC, ...sources]
  for (const src of allSources) {
    const fn = new Function('window', 'document', 'navigator', 'setTimeout', 'console', 'module', src)
    fn(win, opts.doc, undefined, setTimeout, fakeConsole, moduleObj)
  }
  return { win, moduleObj }
}

describe('clipboard 소비처 구조: 내장 정의 제거', () => {
  const cases: Array<{ name: string; src: string; helpers: string[] }> = [
    { name: 'finder-deckcraft', src: DECK_SRC, helpers: ['isFormFieldTarget', 'pasteImageFile', 'fileToBase64', 'normalizeBytes'] },
    { name: 'finder-format-slide', src: SLIDE_SRC, helpers: ['isFormFieldTarget', 'pasteImageFile', 'fileToBase64'] },
    { name: 'finder-format-sheet', src: SHEET_SRC, helpers: ['isFormFieldTarget', 'pasteImageFile', 'fileToBase64'] },
    { name: 'sheet-gridcraft', src: GRID_SRC, helpers: ['isFormFieldTarget', 'pasteImageFile', 'fileToBase64'] },
    { name: 'finder-pdfcraft', src: PDF_SRC, helpers: ['normalizeBytes'] },
  ]
  for (const c of cases) {
    test(`${c.name}에 내장 헬퍼 함수 정의가 없다`, () => {
      for (const h of c.helpers) {
        expect(c.src).not.toMatch(new RegExp(`function ${h}\\s*\\(`))
      }
    })
    test(`${c.name}이 코어 전역을 참조한다`, () => {
      expect(c.src).toContain('window.MyHubCraftClipboard')
      expect(c.src).toContain('clipboardCore')
    })
  }

  test('slide/sheet의 인라인 32MB 리터럴이 코어 상한으로 바뀌었다', () => {
    // 붙여넣기 크기 검사는 코어 상한을 쓰고, 리터럴은 코어 부재 시
    // 폴백 바인딩 1곳에만 남는다.
    expect(SLIDE_SRC).toMatch(/f\.size > PASTE_MAX_BYTES/)
    expect(SHEET_SRC).toMatch(/f\.size > PASTE_MAX_BYTES/)
    expect(SLIDE_SRC.match(/32 \* 1024 \* 1024/g)).toHaveLength(1)
    expect(SHEET_SRC.match(/32 \* 1024 \* 1024/g)).toHaveLength(1)
    expect(SLIDE_SRC).toMatch(/clipboardCore\.PASTE_MAX_BYTES\) \|\| 32 \* 1024 \* 1024/)
    expect(SHEET_SRC).toMatch(/clipboardCore\.PASTE_MAX_BYTES\) \|\| 32 \* 1024 \* 1024/)
  })
})

describe('clipboard 소비처 동등성: 공개 API가 코어와 동일 참조', () => {
  test('finder-deckcraft: pasteImageFile·isFormFieldTarget·normalizeBytes가 코어와 같다', () => {
    const { win } = loadSources([CORE_SRC, DECK_SRC])
    const core = win.MyHubCraftClipboard
    const api = win.MyHubFinderDeckCraft
    expect(api).toBeDefined()
    expect(api.pasteImageFile).toBe(core.pasteImageFile)
    expect(api.isFormFieldTarget).toBe(core.isFormFieldTarget)
    expect(api.normalizeBytes).toBe(core.normalizeBytes)
  })
  test('finder-format-slide: pasteImageFile·isFormFieldTarget이 코어와 같다', () => {
    const { win } = loadSources([CORE_SRC, SLIDE_SRC])
    const core = win.MyHubCraftClipboard
    const api = win.MyHubFinderFormatSlide
    expect(api).toBeDefined()
    expect(api.pasteImageFile).toBe(core.pasteImageFile)
    expect(api.isFormFieldTarget).toBe(core.isFormFieldTarget)
  })
  test('finder-format-sheet: pasteImageFile·isFormFieldTarget이 코어와 같다', () => {
    const { win } = loadSources([CORE_SRC, SHEET_SRC])
    const core = win.MyHubCraftClipboard
    const api = win.MyHubFinderFormatSheet
    expect(api).toBeDefined()
    expect(api.pasteImageFile).toBe(core.pasteImageFile)
    expect(api.isFormFieldTarget).toBe(core.isFormFieldTarget)
  })
  test('sheet-gridcraft: pasteImageFile·isFormFieldTarget이 코어와 같다', () => {
    const { win } = loadSources([CORE_SRC, GRID_SRC])
    const core = win.MyHubCraftClipboard
    const api = win.MyHubSheetGridcraft
    expect(api).toBeDefined()
    expect(api.pasteImageFile).toBe(core.pasteImageFile)
    expect(api.isFormFieldTarget).toBe(core.isFormFieldTarget)
  })
  test('finder-pdfcraft: normalizeBytes가 코어와 같다', () => {
    const { win } = loadSources([CORE_SRC, PDF_SRC])
    const core = win.MyHubCraftClipboard
    const api = win.MyHubFinderPdfCraft
    expect(api).toBeDefined()
    expect(api.normalizeBytes).toBe(core.normalizeBytes)
  })
})

describe('clipboard 코어 선행 로딩', () => {
  test('office.html에서 코어 태그가 4개 소비처보다 먼저 온다', () => {
    const coreIdx = OFFICE_HTML.indexOf('/js/craft-clipboard.js')
    expect(coreIdx).toBeGreaterThan(-1)
    for (const consumer of [
      '/js/finder-format-sheet.js',
      '/js/finder-deckcraft.js',
      '/js/finder-format-slide.js',
      '/js/finder-pdfcraft.js',
    ]) {
      const idx = OFFICE_HTML.indexOf(consumer)
      expect(idx).toBeGreaterThan(-1)
      expect(coreIdx).toBeLessThan(idx)
    }
  })
  test('sheet.html에서 코어 태그가 sheet-gridcraft보다 먼저 온다', () => {
    const coreIdx = SHEET_HTML.indexOf('/js/craft-clipboard.js')
    const gridIdx = SHEET_HTML.indexOf('/js/sheet-gridcraft.js')
    expect(coreIdx).toBeGreaterThan(-1)
    expect(gridIdx).toBeGreaterThan(-1)
    expect(coreIdx).toBeLessThan(gridIdx)
  })
  test('finder.js FORMAT_MODULE_URLS에서 코어가 소비처보다 먼저 온다', () => {
    const table = FINDER_SRC.match(/var FORMAT_MODULE_URLS = \{([\s\S]*?)\n    \};/)
    expect(table).not.toBeNull()
    const body = table![1]
    const arrays: Record<string, string[]> = {}
    for (const m of body.matchAll(/(\w+): \[([^\]]*)\]/g)) {
      arrays[m[1]] = m[2].split(',').map((s) => s.trim().replace(/['"]/g, ''))
    }
    for (const kind of ['xlsx', 'xls', 'pptx', 'pdf']) {
      const urls = arrays[kind]
      expect(urls).toBeDefined()
      const coreIdx = urls.indexOf('/js/craft-clipboard.js')
      expect(coreIdx).toBeGreaterThan(-1)
      for (const consumer of [
        '/js/finder-format-sheet.js',
        '/js/finder-deckcraft.js',
        '/js/finder-format-slide.js',
        '/js/finder-pdfcraft.js',
      ]) {
        const idx = urls.indexOf(consumer)
        if (idx !== -1) expect(coreIdx).toBeLessThan(idx)
      }
    }
  })
  test('코어가 정적 자산 목록과 동적 자산 목록에 등록됐다', () => {
    const assets: string[] = Array.isArray(STATIC_ASSETS) ? STATIC_ASSETS : STATIC_ASSETS.files || []
    expect(assets).toContain('/js/craft-clipboard.js')
    expect(ASSET_URL_SRC).toContain("'/js/craft-clipboard.js'")
  })
})

describe('clipboard 열화 경로: 코어가 없어도 로드되고 조용히 건너뛴다', () => {
  test('finder-deckcraft 단독 로드: API는 있고 붙여넣기 헬퍼는 무동작 스텁이다', () => {
    const { win } = loadSources([DECK_SRC], { quietWarn: true })
    const api = win.MyHubFinderDeckCraft
    expect(api).toBeDefined()
    expect(api.pasteImageFile({ files: [{ type: 'image/png' }] })).toBeNull()
    expect(api.isFormFieldTarget({ tagName: 'INPUT' })).toBe(false)
    expect(api.normalizeBytes(new ArrayBuffer(4))).toBeNull()
  })
  test('sheet-gridcraft 단독 로드: API는 있고 붙여넣기 헬퍼는 무동작 스텁이다', () => {
    const { win } = loadSources([GRID_SRC], { quietWarn: true })
    const api = win.MyHubSheetGridcraft
    expect(api).toBeDefined()
    expect(api.pasteImageFile({ files: [{ type: 'image/png' }] })).toBeNull()
    expect(api.isFormFieldTarget({ tagName: 'INPUT' })).toBe(false)
  })
  test('finder-pdfcraft 단독 로드: normalizeBytes 스텁은 null을 반환한다', () => {
    const { win } = loadSources([PDF_SRC], { quietWarn: true })
    const api = win.MyHubFinderPdfCraft
    expect(api).toBeDefined()
    expect(api.normalizeBytes(new ArrayBuffer(4))).toBeNull()
  })
})
