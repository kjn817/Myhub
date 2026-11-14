/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 6단계 잔정리 (D5/S5-3/S2-6/S2-7/S5-5) 계약 테스트.
 *
 * 고정하는 성질 (설계 노트 .scratch/s6-cleanup-design.md):
 * - D5: friendlyError는 window.friendlyErrorMessage 위임을 보지 않는다
 *   (error-messages.js 파일 자체가 없어 위임은 영원히 false였다).
 *   위임 함수가 있어도 fail-safe 패턴 결과가 그대로 나온다.
 * - S5-3: ai-model-selection.ts의 console 호출은 warn
 *   'selectModel_override_not_applied'과 error
 *   'selectModel_no_candidates' 2건뿐이다 (둘 다 실제 장애·경고라 유지).
 *   디버그성 console.log/debug가 다시 들어가면 실패한다.
 * - S2-6: finder.js의 legacyKindFor는 file-icons.js의 kindFor와
 *   (name, mime) 입력에 대해 같은 종류를 낸다 — 폴백이라 로드 실패
 *   시에도 종류가 열화되지 않는다. kindFor의 input.kind/input.folder
 *   분기는 (name, mime) 시그니처에 없어 비교에서 제외한다 (설계 노트).
 * - S2-7: 로컬 esc/friendlyError 정의가 남아 있지 않다 — 전부
 *   text-utils 공용 코어의 바인딩이다.
 * - S5-5: 정리한 파일들에 깨진 한국어 토큰이 다시 들어가지 않는다.
 *   '앱 앱'·'내장함'은 public/·src/ 전수 0건이다 ('내장함'은
 *   사용자 노출 라벨·alert까지 깨져 있어 '휴지통'으로 고쳤다).
 * D4(쓰기 전용 window 전역)는 기본값 유지·미접촉이라 테스트가 없다.
 *
 * 카나리아: 위임 분기를 복원하면 D5가, legacyKindFor 규칙 하나를
 * 지우면 S2-6 동등표가, '앱 앱'을 한 파일에 다시 넣으면 S5-5가
 * 실패한다 (설계 노트 카나리아 절).
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..', '..')
const PUBLIC = path.join(ROOT, 'public')
const JS_DIR = path.join(PUBLIC, 'js')

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8')
}

function loadTextUtils(win: any): any {
  const src = read('public/js/common/text-utils.js')
  const moduleObj: any = { exports: {} }
  const fn = new Function('window', 'document', 'navigator', 'setTimeout', 'module', src)
  fn(win, undefined, undefined, setTimeout, moduleObj)
  return win.MyHubTextUtils || moduleObj.exports
}

function loadFileIcons(): any {
  const src = read('public/js/file-icons.js')
  const win: any = {}
  new Function('window', 'document', src)(win, (globalThis as any).document)
  return win.MyHubFileIcons || (globalThis as any).MyHubFileIcons
}

/** finder.js 소스에서 legacyKindFor 함수 본문을 중괄호 매칭으로 잘라 실행한다. */
function loadLegacyKindFor(): (name: string, mime: string) => string {
  const src = read('public/js/finder.js')
  const start = src.indexOf('function legacyKindFor(')
  expect(start).toBeGreaterThanOrEqual(0)
  let depth = 0
  let i = src.indexOf('{', start)
  expect(i).toBeGreaterThanOrEqual(0)
  const bodyStart = i
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  expect(depth).toBe(0)
  const fnSrc = src.slice(start, i + 1)
  return new Function(`${fnSrc}; return legacyKindFor;`)() as (
    name: string,
    mime: string,
  ) => string
}

function walkJs(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkJs(full, out)
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

describe('D5 — friendlyError 위임 무시 (fail-safe 전용)', () => {
  const FALLBACK = '잠시 후 다시 시도해 주세요.'
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('window.friendlyErrorMessage가 있어도 위임하지 않고 폴백을 낸다', () => {
    const win: any = { friendlyErrorMessage: () => '위임 문구' }
    const core = loadTextUtils(win)
    expect(core.friendlyError('http_500', FALLBACK)).toBe(FALLBACK)
    expect(core.friendlyError('일반 문구', FALLBACK)).toBe('일반 문구')
  })

  it('로딩 뒤에 위임 함수를 꽂아도 무시한다', () => {
    const win: any = {}
    const core = loadTextUtils(win)
    win.friendlyErrorMessage = () => '나중 위임'
    expect(core.friendlyError('SOME_ERROR', FALLBACK)).toBe(FALLBACK)
  })

  it('text-utils.js 소스에서 friendlyErrorMessage는 주석에만 남는다', () => {
    const src = read('public/js/common/text-utils.js')
    const hits = src
      .split('\n')
      .filter((line) => line.includes('friendlyErrorMessage'))
    expect(hits.length).toBeGreaterThan(0)
    for (const line of hits) {
      const trimmed = line.trim()
      expect(trimmed.startsWith('//') || trimmed.startsWith('*')).toBe(true)
    }
  })

  it('fail-safe 패턴이 그대로 동작한다 (http_·서버 오류·snake_case → 폴백)', () => {
    const core = loadTextUtils({})
    expect(core.friendlyError('http_404', FALLBACK)).toBe(FALLBACK)
    expect(core.friendlyError('서버 오류 (503)', FALLBACK)).toBe(FALLBACK)
    expect(core.friendlyError('file_not_found', FALLBACK)).toBe(FALLBACK)
    expect(core.friendlyError('일반 문구', FALLBACK)).toBe('일반 문구')
  })
})

describe('S5-3 — ai-model-selection 디버그 로그 부재', () => {
  const src = read('src/services/ai-model-selection.ts')

  it('console 호출은 warn 1건·error 1건, 정확히 그 2건뿐이다', () => {
    const calls = [...src.matchAll(/console\.(log|debug|info|warn|error)\(\s*'([^']+)'/g)]
    expect(calls.map((m) => `${m[1]}:${m[2]}`).sort()).toEqual([
      'error:selectModel_no_candidates',
      'warn:selectModel_override_not_applied',
    ])
  })

  it('console.log/console.debug는 없다', () => {
    expect(src).not.toMatch(/console\.(log|debug)\(/)
  })
})

describe('S2-6 — legacyKindFor ↔ kindFor 동등표', () => {
  const kindFor = loadFileIcons().kindFor as (input: {
    name: string
    mime: string
  }) => string
  const legacy = loadLegacyKindFor()

  const cases: Array<[string, string, string]> = [
    // [name, mime, expected] — MIME 분기 전수
    ['a.bin', 'image/png', 'image'],
    ['a.bin', 'IMAGE/PNG', 'image'],
    ['a.bin', 'audio/mpeg', 'audio'],
    ['a.bin', 'video/mp4', 'video'],
    ['a.bin', 'application/pdf', 'pdf'],
    ['a.bin', 'text/csv', 'csv'],
    ['a.bin', 'TEXT/CSV', 'csv'],
    ['a.bin', 'application/x-hwp', 'hangul'],
    [
      'a.bin',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'excel',
    ],
    ['a.bin', 'application/vnd.ms-excel', 'excel'],
    [
      'a.bin',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'powerpoint',
    ],
    ['a.bin', 'application/vnd.ms-powerpoint', 'powerpoint'],
    [
      'a.bin',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'word',
    ],
    ['a.bin', 'application/msword', 'word'],
    ['a.bin', 'application/vnd.ms-word', 'word'],
    // 확장자 분기 전수 (MIME이 없을 때)
    ['a.xls', '', 'excel'],
    ['a.xlsx', '', 'excel'],
    ['a.csv', '', 'csv'],
    ['a.hwp', '', 'hangul'],
    ['a.hwpx', '', 'hangul'],
    ['a.ppt', '', 'powerpoint'],
    ['a.pptx', '', 'powerpoint'],
    ['a.doc', '', 'word'],
    ['a.docx', '', 'word'],
    ['a.pdf', '', 'pdf'],
    ['a.png', '', 'image'],
    ['a.jpg', '', 'image'],
    ['a.jpeg', '', 'image'],
    ['a.gif', '', 'image'],
    ['a.webp', '', 'image'],
    ['a.svg', '', 'image'],
    ['a.bmp', '', 'image'],
    ['a.heic', '', 'image'],
    ['a.mp3', '', 'audio'],
    ['a.wav', '', 'audio'],
    ['a.m4a', '', 'audio'],
    ['a.flac', '', 'audio'],
    ['a.ogg', '', 'audio'],
    ['a.mp4', '', 'video'],
    ['a.mov', '', 'video'],
    ['a.webm', '', 'video'],
    ['a.mkv', '', 'video'],
    ['a.avi', '', 'video'],
    ['a.zip', '', 'archive'],
    ['a.rar', '', 'archive'],
    ['a.7z', '', 'archive'],
    ['a.tar', '', 'archive'],
    ['a.gz', '', 'archive'],
    ['a.txt', '', 'text'],
    ['a.md', '', 'text'],
    ['a.markdown', '', 'text'],
    ['a.log', '', 'text'],
    ['a.js', '', 'code'],
    ['a.ts', '', 'code'],
    ['a.jsx', '', 'code'],
    ['a.tsx', '', 'code'],
    ['a.json', '', 'code'],
    ['a.html', '', 'code'],
    ['a.css', '', 'code'],
    ['a.xml', '', 'code'],
    ['a.yml', '', 'code'],
    ['a.yaml', '', 'code'],
    ['a.py', '', 'code'],
    // 폴백·우선순위·대소문자
    ['a.xyz', '', 'file'],
    ['noext', '', 'file'],
    ['PHOTO.PNG', '', 'image'],
    ['Doc.PDF', '', 'pdf'],
    ['a.png', 'application/pdf', 'pdf'],
    ['a.pdf', 'image/png', 'image'],
  ]

  it.each(cases)('%s + %s → %s (둘 다 같고 기대값과 같다)', (name, mime, expected) => {
    expect(kindFor({ name, mime })).toBe(expected)
    expect(legacy(name, mime)).toBe(expected)
  })

  it('kindForFile은 file-icons가 없을 때 legacyKindFor로 떨어진다 (소스 계약)', () => {
    const finder = read('public/js/finder.js')
    expect(finder).toMatch(/icons \? icons\.kindFor\(\{ name: name, mime: mime \}\) : legacyKindFor\(name, mime\)/)
  })
})

describe('S2-7 — 로컬 esc/friendlyError 정의 부재', () => {
  const files = walkJs(JS_DIR).filter(
    (f) => !f.endsWith('memo-bundle.js') && !f.endsWith(path.join('common', 'text-utils.js')),
  )

  it('function esc(/function friendlyError( 선언이 남아 있지 않다', () => {
    const hits: string[] = []
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf-8')
      if (/\bfunction\s+(esc|friendlyError)\s*\(/.test(src)) hits.push(path.relative(ROOT, f))
    }
    expect(hits).toEqual([])
  })

  it('esc/friendlyError 변수 바인딩은 전부 textUtils 별칭이다', () => {
    const bad: string[] = []
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf-8')
      for (const line of src.split('\n')) {
        if (/\b(const|let|var)\s+(esc|friendlyError)\s*=/.test(line) && !line.includes('textUtils.')) {
          bad.push(`${path.relative(ROOT, f)}: ${line.trim()}`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('escMd/escapeBlockStart는 별개 함수라 건드리지 않는다 (양성 대조)', () => {
    const md = read('public/js/memo/md.js')
    expect(md).toMatch(/escMd|escapeBlockStart/)
  })
})

describe('S5-5 — 깨진 한국어 토큰 재발 방지', () => {
  const BROKEN_TOKENS = [
    '앱 앱',
    '칸해',
    '붙인합',
    '이값',
    '앱 번',
    '앱는',
    '없든',
    '앱어',
    '앱고',
    '앱는다',
    '앱한다',
    '붇',
    '껍질',
    '내장함',
    '상링',
    '앱한것',
    '넣소',
  ]

  // 정리한 파일 목록 (설계 노트 S5-5 절). finder-format-sheet.js와
  // sheet-gridcraft.js는 헤더 손상이 깊어 이번 단계에서 손대지 않았고
  // 설계 노트에 후속으로 남겼다 — 목록에서 제외한다.
  const CLEANED = [
    'public/js/browser.js',
    'public/js/office.js',
    'public/js/finder.js',
    'public/js/file-icons.js',
    'public/js/backup.js',
    'public/js/fonts.js',
    'public/js/finder-deckcraft.js',
    'public/assistant-widget.js',
    'public/js/desktop/main.js',
    'public/js/desktop/menu.js',
    'public/js/desktop/dock.js',
    'public/js/desktop/tiles.js',
    'public/js/desktop/state.js',
    'public/js/desktop/windows.js',
    'public/js/desktop/subchat.js',
    'public/js/desktop/desktop-icons.js',
    'public/js/desktop/widgets.js',
  ]

  it.each(CLEANED)('%s에 깨진 토큰이 없다', (rel) => {
    const src = read(rel)
    const found = BROKEN_TOKENS.filter((t) => src.includes(t))
    expect(found).toEqual([])
  })

  it("'앱 앱'은 public/·src/ 전수 0건이다 (memo-bundle.js 제외 — 생성물)", () => {
    const hits: string[] = []
    const scan = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) scan(full)
        else if (/\.(js|ts|html|css)$/.test(entry.name) && !full.endsWith('memo-bundle.js')) {
          if (fs.readFileSync(full, 'utf-8').includes('앱 앱')) hits.push(path.relative(ROOT, full))
        }
      }
    }
    scan(PUBLIC)
    scan(path.join(ROOT, 'src'))
    expect(hits).toEqual([])
  })

  it("'내장함'은 public/·src/·tests/ 전수 0건이다 (이 테스트 파일 제외 — 토큰 자체를 단언한다)", () => {
    const hits: string[] = []
    const scan = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) scan(full)
        else if (
          /\.(js|ts|html|css)$/.test(entry.name) &&
          !full.endsWith('memo-bundle.js') &&
          !full.endsWith('s6-cleanup.test.ts')
        ) {
          if (fs.readFileSync(full, 'utf-8').includes('내장함')) hits.push(path.relative(ROOT, full))
        }
      }
    }
    scan(PUBLIC)
    scan(path.join(ROOT, 'src'))
    scan(path.join(ROOT, 'tests'))
    expect(hits).toEqual([])
  })

  it('휴지통 라벨이 올바른 문구로 존재한다 (양성 대조)', () => {
    expect(read('public/js/desktop/desktop-icons.js')).toContain('휴지통으로 이동')
    expect(read('public/js/desktop/main.js')).toContain('휴지통으로 보내지 못했습니다')
  })
})
