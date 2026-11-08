/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 앱 타일 아이콘 복원 결선 테스트 (2026-11-08, 사용자 재공급 아이콘)
 *
 * 검증하는 성질:
 * ① APP_TILES의 모든 image src가 public/에 실제 파일로 존재하고
 *    scripts/static-assets.json의 files에 등록돼 있다 (배포 업로드 집합에
 *    없으면 운영에서 404가 된다). 일정(schedule)은 동적 달력 타일이 확정
 *    디자인이라 image 항목이 없는 것이 정본이다.
 *    versioned에는 아이콘을 넣지 않는다: versioned는 배포 NODE_GEN이
 *    본문을 문자열로 읽어 ?v=를 재작성하는 텍스트 파일 전용 목록이고,
 *    PNG를 넣으면 UTF-8 왕복으로 바이트가 깨진다 (71,564B → 130,953B 실측).
 *    ?v= 부착 기준은 files 집합 전체이므로 files 등록만으로 충분하다 —
 *    이 배치는 tests/unit/static-assets.test.ts의 가드와 짝을 이룬다.
 * ② tiles 렌더 우선순위: APP_TILES image가 있으면 img가 문서형 SVG보다
 *    먼저 렌더되고, img 로드 실패 시 SVG 종류(excel·hangul·powerpoint)는
 *    문서형 SVG로, 그 외(memo·finder 등)는 글리프로 폴백한다.
 *    우선순위를 되돌리면( SVG 선행) 이 테스트가 실패한다 — 카나리아.
 * ③ pdf는 image가 아니라 자체 제작 SVG 타일(빨강 타일+흰 매듭)이 정본이다
 *    (2026-11-03 원본 기록). pdf-app.png 같은 PNG 참조가 되살아나면 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const PUBLIC = path.join(ROOT, 'public')
const FILE_ICONS_JS = fs.readFileSync(path.join(PUBLIC, 'js', 'file-icons.js'), 'utf-8')
const TILES_JS = fs.readFileSync(path.join(PUBLIC, 'js', 'desktop', 'tiles.js'), 'utf-8')
const DOCK_JS = fs.readFileSync(path.join(PUBLIC, 'js', 'desktop', 'dock.js'), 'utf-8')
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'scripts', 'static-assets.json'), 'utf-8'),
) as { files: string[]; versioned: string[] }

function getWin(): any {
  return (globalThis as any).window
}

function loadApis(): { fi: any; tiles: any } {
  const win = getWin()
  new Function('window', 'document', FILE_ICONS_JS)(win, win.document)
  new Function('window', 'document', TILES_JS)(win, win.document)
  return { fi: win.MyHubFileIcons, tiles: win.MyHubDesktopTiles }
}

// 일정(동적 달력 타일)과 pdf(자체 제작 SVG 타일)를 제외한 전 앱 —
// 전부 image 타일이 정본이다.
// (휴지통은 빈/찬 2종 변형이 있어 별도 describe에서 검증한다.)
const IMAGE_MODULES = [
  'finder',
  'browser',
  'studio',
  'memo',
  'todo',
  'chat',
  'excel',
  'hangul',
  'powerpoint',
  'settings',
]

describe('APP_TILES image 항목 — 파일·매니페스트 결선', () => {
  const { fi } = loadApis()

  test('일정 제외 전 앱이 image 타일로 정의돼 있다', () => {
    for (const id of IMAGE_MODULES) {
      expect(fi.APP_TILES[id]).toBeDefined()
      expect(fi.APP_TILES[id].type).toBe('image')
      expect(typeof fi.APP_TILES[id].src).toBe('string')
    }
    // 일정은 동적 달력 타일이 확정 디자인 — image가 아닌 것이 정본
    expect(fi.APP_TILES.schedule.type).toBe('calendar')
  })

  test('pdf는 image가 아니라 자체 제작 SVG 타일이 정본이다', () => {
    expect(fi.APP_TILES.pdf).toBeDefined()
    expect(fi.APP_TILES.pdf.type).toBe('svg')
    expect(fi.APP_TILES.pdf.src).toBeUndefined()
    // 재구축 명명이던 pdf-app.png는 원본에 없었다 — 파일·매니페스트 모두 없어야 한다
    expect(fs.existsSync(path.join(PUBLIC, 'icons', 'pdf-app.png'))).toBe(false)
    expect(new Set(MANIFEST.files).has('/icons/pdf-app.png')).toBe(false)
  })

  test('모든 image src가 실제 파일로 존재하고 매니페스트 files에 등록돼 있다', () => {
    const fileSet = new Set(MANIFEST.files)
    for (const id of IMAGE_MODULES) {
      const src: string = fi.APP_TILES[id].src
      expect(fs.statSync(path.join(PUBLIC, src)).isFile()).toBe(true)
      expect(fileSet.has(src)).toBe(true)
    }
  })

  test('versioned에는 아이콘 PNG가 없다 (바이너리 UTF-8 왕복 깨짐 방지)', () => {
    const inVersioned = MANIFEST.versioned.filter((v) => v.startsWith('/icons/'))
    expect(inVersioned).toEqual([])
  })
})

describe('tiles 렌더 우선순위 — image-first + 종류별 폴백', () => {
  let tiles: any
  let fi: any

  beforeEach(() => {
    const apis = loadApis()
    tiles = apis.tiles
    fi = apis.fi
  })

  function fireImgError(span: any): void {
    const img = span.querySelector('img')
    expect(img).not.toBeNull()
    img.dispatchEvent(new (getWin().Event)('error'))
  }

  test('excel: 문서형 SVG가 아니라 앱 PNG img로 렌더된다', () => {
    const span = tiles.createTile('excel')
    const img = span.querySelector('img')
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe('/icons/excel-app-v3.png')
    expect(span.classList.contains('dt-tile-svg')).toBe(false)
    expect(span.querySelector('svg')).toBeNull()
  })

  test('memo·hangul도 앱 PNG img로 렌더된다', () => {
    expect(tiles.createTile('memo').querySelector('img').getAttribute('src')).toBe(
      '/icons/memo-app-v3.png',
    )
    expect(tiles.createTile('hangul').querySelector('img').getAttribute('src')).toBe(
      '/icons/hangul-app-v2.png',
    )
  })

  // jsdom 직렬화(<path/> → <path></path>)를 양쪽에 동일 적용해 비교한다
  function serializedSvg(kind: string): string {
    const probe = getWin().document.createElement('span')
    probe.innerHTML = fi.svgFor(kind)
    return probe.innerHTML
  }

  test('excel img 로드 실패 → 문서형 SVG(dt-tile-svg)로 폴백한다', () => {
    const span = tiles.createTile('excel')
    fireImgError(span)
    expect(span.classList.contains('dt-tile-svg')).toBe(true)
    expect(span.querySelector('img')).toBeNull()
    expect(span.innerHTML).toContain('<svg')
    expect(span.innerHTML).toBe(serializedSvg('excel'))
  })

  test('pdf는 img가 아니라 자체 SVG 타일(빨강 본체+흰 매듭)로 렌더된다', () => {
    const span = tiles.createTile('pdf')
    expect(span.querySelector('img')).toBeNull()
    expect(span.classList.contains('dt-tile-image')).toBe(false)
    expect(span.classList.contains('dt-tile-svg')).toBe(true)
    const probe = getWin().document.createElement('span')
    probe.innerHTML = fi.pdfTileSvg()
    expect(span.innerHTML).toBe(probe.innerHTML)
    // 형태 핀 (2026-11-03 원본 기록): 빨간 라운드 본체 + 흰 매듭, 흰 배경 없음,
    // 문서형 파일 아이콘(svgFor)과는 다른 타일이어야 한다
    expect(span.innerHTML).toContain('fill="#ec1c24"')
    expect(span.innerHTML).toContain('stroke="#ffffff"')
    expect(span.innerHTML).not.toContain('fill="#ffffff"')
    expect(span.innerHTML).not.toBe(serializedSvg('pdf'))
  })

  test('memo img 로드 실패 → SVG 종류가 아니므로 글리프로 폴백한다', () => {
    const span = tiles.createTile('memo')
    fireImgError(span)
    expect(span.classList.contains('dt-tile-img-fallback')).toBe(true)
    expect(span.classList.contains('dt-tile-svg')).toBe(false)
    const glyph = span.querySelector('i[data-lucide]')
    expect(glyph).not.toBeNull()
    expect(glyph.getAttribute('data-lucide')).toBe('notebook-pen')
  })

  test('schedule은 여전히 동적 달력 타일이다 (image 분기에 가로채이지 않는다)', () => {
    const span = tiles.createTile('schedule')
    expect(span.querySelector('img')).toBeNull()
    expect(span.classList.contains('dt-tile-svg')).toBe(true)
    const now = new Date()
    expect(span.innerHTML).toContain(fi.WEEKDAY_KO[now.getDay()])
    expect(span.innerHTML).toContain('>' + now.getDate() + '<')
  })

  test('APP_TILES에 없는 모듈(backup)은 기존 그라데이션+글리프 그대로다', () => {
    const span = tiles.createTile('backup')
    expect(span.querySelector('img')).toBeNull()
    const glyph = span.querySelector('i[data-lucide]')
    expect(glyph).not.toBeNull()
    expect(glyph.getAttribute('data-lucide')).toBe('archive')
  })
})

describe('타일 마감 계약 — full-bleed와 달력 신디자인 (2026-11-08 독 마감)', () => {
  let tiles: any
  let fi: any

  beforeEach(() => {
    const apis = loadApis()
    tiles = apis.tiles
    fi = apis.fi
  })

  test('이미지 타일은 full-bleed다 — dt-tile-image만 있고 런타임 축소 배선이 없다', () => {
    for (const id of IMAGE_MODULES) {
      const span = tiles.createTile(id)
      expect(span.classList.contains('dt-tile-image')).toBe(true)
      const img = span.querySelector('img')
      // 축소 배율(CSS 변수·인라인 transform)이 다시 생기면 회색 판 시절의
      // 광학 보정이 부활한 것이므로 실패해야 한다 (사용자 지시: full-bleed)
      expect(img.style.getPropertyValue('--tile-img-scale')).toBe('')
      expect('imgScale' in fi.APP_TILES[id]).toBe(false)
    }
  })

  test('글리프 타일은 이미지·SVG 클래스를 갖지 않는다 (자체 그라데이션이 박스를 채운다)', () => {
    const glyph = tiles.createTile('backup')
    expect(glyph.classList.contains('dt-tile-image')).toBe(false)
    expect(glyph.classList.contains('dt-tile-svg')).toBe(false)
    expect(glyph.querySelector('i[data-lucide]')).not.toBeNull()
  })

  test('달력 타일: 흰 squircle에 한글 요일 전체 이름 + 큰 날짜 (사용자 확정 디자인)', () => {
    // 2026-11-08은 일요일이다
    const svg = fi.calendarTileSvg(new Date(2026, 10, 8))
    expect(svg).toContain('일요일')
    expect(svg).toContain('>8<')
    expect(svg).toContain('fill="#ffffff"')
    // 예전 디자인(빨간 띠 + 영문 월 약어)이 부활하면 실패한다
    expect(svg).not.toContain('#e5484d')
    expect(svg).not.toContain('NOV')
    // 요일은 날짜에 따라 바뀐다 — 2026-11-09는 월요일
    expect(fi.calendarTileSvg(new Date(2026, 10, 9))).toContain('월요일')
  })

  test('달력 도형 크기는 이미지 아이콘 아트워크 충전율(선형 0.82)에 맞춘 39.5/48이다', () => {
    const svg = fi.calendarTileSvg(new Date())
    expect(svg).toContain('width="39.5"')
    expect(svg).toContain('height="39.5"')
    expect(svg).toContain('rx="9"')
  })

  test('img 실패 폴백에서는 dt-tile-image가 제거된다', () => {
    const memo = tiles.createTile('memo')
    memo.querySelector('img').dispatchEvent(new (getWin().Event)('error'))
    expect(memo.classList.contains('dt-tile-image')).toBe(false)
    expect(memo.classList.contains('dt-tile-img-fallback')).toBe(true)
    const excel = tiles.createTile('excel')
    excel.querySelector('img').dispatchEvent(new (getWin().Event)('error'))
    expect(excel.classList.contains('dt-tile-image')).toBe(false)
    expect(excel.classList.contains('dt-tile-svg')).toBe(true)
  })
})

describe('휴지통 타일 — 빈 통/찬 통 결선 (2026-11-08)', () => {
  let tiles: any
  let fi: any

  beforeEach(() => {
    const apis = loadApis()
    tiles = apis.tiles
    fi = apis.fi
  })

  test('trash-empty/full 파일이 존재하고 매니페스트 files에 등록돼 있다', () => {
    const fileSet = new Set(MANIFEST.files)
    expect(fi.APP_TILES.trash.type).toBe('image')
    for (const src of [fi.APP_TILES.trash.src, fi.APP_TILES.trash.fullSrc]) {
      expect(fs.statSync(path.join(PUBLIC, src)).isFile()).toBe(true)
      expect(fileSet.has(src)).toBe(true)
    }
  })

  test('createTile 기본은 빈 통, trashFull 옵션이면 찬 통이다', () => {
    expect(tiles.createTile('trash').querySelector('img').getAttribute('src')).toBe(
      '/icons/trash-empty.png',
    )
    expect(
      tiles.createTile('trash', { trashFull: true }).querySelector('img').getAttribute('src'),
    ).toBe('/icons/trash-full.png')
  })

  test('고정 꼬리(settings·trash)가 저장 구성에 남아 있어도 독에 중복 렌더되지 않는다', () => {
    const win = getWin()
    new Function('window', 'document', DOCK_JS)(win, win.document)
    const dock = win.MyHubDesktopDock
    // 마이그레이션: 현행 포맷(v6) 저장값에 settings·trash가 섞여 있어도 제외된다
    const migrated = dock.migrateDockIds({
      version: 6,
      ids: ['finder', 'memo', 'settings', 'chat', 'trash'],
    })
    expect(migrated.ids).not.toContain('settings')
    expect(migrated.ids).not.toContain('trash')
    expect(migrated.ids).toContain('memo')
    // 구 포맷(배열)도 마찬가지다
    expect(dock.migrateDockIds(['finder', 'settings']).ids).not.toContain('settings')
    // 렌더 결과: 설정·휴지통 버튼은 고정 꼬리의 각 1개뿐이다
    const root = win.document.createElement('nav')
    win.document.body.appendChild(root)
    const d = dock.createDock({
      root,
      tiles,
      ids: migrated.ids,
      titles: {},
      getRecents: () => [],
    })
    d.render()
    expect(root.querySelectorAll('.dt-dock-settings')).toHaveLength(1)
    expect(root.querySelectorAll('.dt-dock-trash')).toHaveLength(1)
    expect(root.querySelectorAll('.dt-dock-item')).toHaveLength(migrated.ids.length + 2)
  })

  test('독 렌더: 개수 0이면 빈 통·배지 없음, 1개 이상이면 찬 통·배지 유지', () => {
    const win = getWin()
    new Function('window', 'document', DOCK_JS)(win, win.document)
    const dock = win.MyHubDesktopDock
    const root = win.document.createElement('nav')
    win.document.body.appendChild(root)
    const d = dock.createDock({
      root,
      tiles,
      ids: ['finder'],
      titles: {},
      getRecents: () => [],
    })
    d.render({ trashCount: 0 })
    let trashBtn = root.querySelector('.dt-dock-trash')
    expect(trashBtn.querySelector('img').getAttribute('src')).toBe('/icons/trash-empty.png')
    expect(trashBtn.querySelector('.dt-dock-badge')).toBeNull()
    // 설정 버튼도 실물 아이콘으로 렌더된다
    expect(
      root.querySelector('.dt-dock-settings').querySelector('img').getAttribute('src'),
    ).toBe('/icons/settings-app-v3.png')
    d.render({ trashCount: 3 })
    trashBtn = root.querySelector('.dt-dock-trash')
    expect(trashBtn.querySelector('img').getAttribute('src')).toBe('/icons/trash-full.png')
    expect(trashBtn.querySelector('.dt-dock-badge').textContent).toBe('3')
  })
})
