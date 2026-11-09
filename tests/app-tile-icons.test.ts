/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 앱 타일 아이콘 결선 테스트 — 운영(file-icons.js·tiles.js·dock.js) 계약 기준.
 *
 * 연혁: 초판(2026-11-08)은 재구축 file-icons의 APP_TILES 데이터 + <img>
 * 렌더를 전제로 쓰였으나, 운영 전사본 기준 재건(2026-11-09)에서 운영
 * API가 appTileFor(kind) → SVG 문자열(<image href="*-128.png"> 래퍼)임이
 * 확정돼 운영 계약으로 전면 재작성했다. 재구축 전제의 잔재를 검증하면
 * 운영 코드가 맞아도 실패하므로, 검증 성질만 운영 형태로 옮긴다.
 *
 * 검증하는 성질:
 * ① 앱 타일이 참조하는 -128.png 전량이 public/에 실제 파일로 존재하고
 *    scripts/static-assets.json의 files에 등록돼 있다 (등록이 없으면
 *    운영에서 404). 원본(512~824px)은 소스로만 보존하고 배포본은
 *    N-07의 128px 파생본이 정본이다.
 * ② versioned에는 아이콘 PNG가 없다 — versioned는 배포 NODE_GEN이 본문을
 *    문자열로 읽는 텍스트 전용 목록이라 PNG를 넣으면 UTF-8 왕복으로
 *    바이트가 깨진다.
 * ③ pdf는 <image>가 아니라 인라인 SVG 타일(그라데이션 본체 + 흰 매듭)이
 *    정본이다. pdf-app.png 같은 PNG 참조가 되살아나면 실패한다.
 * ④ schedule은 이미지 파일이 아니라 오늘 날짜로 라이브 렌더되는 인라인
 *    SVG다 (월 약어 + 날짜). appTileFor 캐시에 날짜 타일이 걸리면
 *    자정에 낡은 날짜가 남으므로 schedule만 캐시 제외가 계약이다.
 * ⑤ tiles.createTile은 앱 종류를 file-icons appTileFor에 위임해
 *    dt-tile-svg로, 그 외 모듈은 Lucide 글리프로 렌더한다.
 * ⑥ 휴지통 타일은 빈 통/찬 통 두 <image>를 함께 품고, 전환은 CSS
 *    (버튼의 dt-trash-full 클래스)가 담당한다 — 한쪽만 렌더하면 실패.
 * ⑦ dock.loadDockIds는 모르는 id 제거·중복 제거·저장 순서 존중과
 *    구버전 마이그레이션(미션·파인더·브라우저·오피스 4종 삽입)을 지킨다.
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

function loadApis(): { fi: any; tiles: any; dock: any } {
  const win = getWin()
  new Function('window', 'document', FILE_ICONS_JS)(win, win.document)
  new Function('window', 'document', TILES_JS)(win, win.document)
  new Function('window', 'document', DOCK_JS)(win, win.document)
  return {
    fi: win.MyHubFileIcons,
    tiles: win.MyHubDesktopTiles,
    dock: win.MyHubDesktopDock,
  }
}

// 이미지 타일 앱과 그 -128.png (일정·pdf·휴지통은 별도 형태라 제외)
const IMAGE_TILES: Record<string, string> = {
  finder: '/icons/finder-app-128.png',
  browser: '/icons/browser-app-v4-128.png',
  studio: '/icons/studio-app-v4-128.png',
  memo: '/icons/memo-app-v3-128.png',
  todo: '/icons/todo-app-128.png',
  chat: '/icons/chat-app-v2-128.png',
  excel: '/icons/excel-app-v3-128.png',
  hangul: '/icons/hangul-app-v2-128.png',
  powerpoint: '/icons/powerpoint-app-v3-128.png',
  settings: '/icons/settings-app-v3-128.png',
}

describe('appTileFor — 이미지 타일 결선 (파일·매니페스트)', () => {
  const { fi } = loadApis()

  test('전 앱 타일이 자기 -128.png를 <image>로 참조한다 (full-bleed 48×48)', () => {
    for (const [id, src] of Object.entries(IMAGE_TILES)) {
      const svg = fi.appTileFor(id)
      expect(svg).toContain('<image href="' + src + '"')
      expect(svg).toContain('width="48" height="48"')
      expect(svg).toContain('viewBox="0 0 48 48"')
    }
  })

  test('참조하는 -128.png 전량이 실제 파일로 존재하고 매니페스트 files에 등록돼 있다', () => {
    const fileSet = new Set(MANIFEST.files)
    const srcs = [...Object.values(IMAGE_TILES), '/icons/trash-empty-128.png', '/icons/trash-full-128.png']
    for (const src of srcs) {
      expect(fs.statSync(path.join(PUBLIC, src)).isFile()).toBe(true)
      expect(fileSet.has(src)).toBe(true)
    }
  })

  test('versioned에는 아이콘 PNG가 없다 (바이너리 UTF-8 왕복 깨짐 방지)', () => {
    const inVersioned = MANIFEST.versioned.filter((v) => v.startsWith('/icons/'))
    expect(inVersioned).toEqual([])
  })

  test('앱 타일은 캐시된다 — 같은 종류는 같은 문자열을 돌려준다', () => {
    expect(fi.appTileFor('excel')).toBe(fi.appTileFor('excel'))
    expect(fi.appTileFor('memo')).toBe(fi.appTileFor('memo'))
  })

  test('앱 종류가 아닌 파일 종류는 문서형 SVG(svgFor)로 폴백한다', () => {
    expect(fi.appTileFor('folder')).toBe(fi.svgFor('folder'))
  })
})

describe('appTileFor — pdf·일정 인라인 SVG 타일', () => {
  const { fi } = loadApis()

  test('pdf는 <image>가 아니라 인라인 SVG 타일(그라데이션 + 흰 매듭)이 정본이다', () => {
    const svg = fi.appTileFor('pdf')
    expect(svg).not.toContain('<image')
    expect(svg).toContain('mta-pdf-bg')
    expect(svg).toContain('stop-color="#f2544a"')
    expect(svg).toContain('stop-color="#d92315"')
    expect(svg).toContain('fill="#ffffff"')
    // 문서형 파일 아이콘(svgFor)과는 다른 타일이어야 한다
    expect(svg).not.toBe(fi.svgFor('pdf'))
    // 재구축 명명이던 pdf-app.png는 원본에 없었다 — 파일·매니페스트 모두 없어야 한다
    expect(fs.existsSync(path.join(PUBLIC, 'icons', 'pdf-app.png'))).toBe(false)
    expect(new Set(MANIFEST.files).has('/icons/pdf-app.png')).toBe(false)
  })

  test('schedule은 오늘 날짜로 라이브 렌더된다 (영문 월 약어 + 날짜, 이미지 파일 없음)', () => {
    const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
    const now = new Date()
    const svg = fi.appTileFor('schedule')
    expect(svg).not.toContain('<image')
    expect(svg).toContain('fill="#F4615B"')
    expect(svg).toContain('>' + MONTH_ABBR[now.getMonth()] + '<')
    expect(svg).toContain('>' + now.getDate() + '<')
  })
})

describe('tiles.createTile — 렌더 위임', () => {
  let tiles: any
  let fi: any

  beforeEach(() => {
    const apis = loadApis()
    tiles = apis.tiles
    fi = apis.fi
  })

  test('앱 종류는 dt-tile-svg + appTileFor 결과로 렌더된다 (<img> 아님)', () => {
    const doc = getWin().document
    for (const id of ['excel', 'memo', 'hangul', 'finder', 'settings']) {
      const span = tiles.createTile(doc, id)
      expect(span.classList.contains('dt-tile')).toBe(true)
      expect(span.classList.contains('dt-tile-' + id)).toBe(true)
      expect(span.classList.contains('dt-tile-svg')).toBe(true)
      expect(span.querySelector('img')).toBeNull()
      expect(span.innerHTML).toContain('href="' + IMAGE_TILES[id] + '"')
    }
  })

  test('pdf 타일은 인라인 SVG이고 <image>가 없다', () => {
    const span = tiles.createTile(getWin().document, 'pdf')
    expect(span.classList.contains('dt-tile-svg')).toBe(true)
    expect(span.querySelector('image')).toBeNull()
    expect(span.innerHTML).toContain('mta-pdf-bg')
  })

  test('schedule 타일은 오늘 날짜를 품는다', () => {
    const span = tiles.createTile(getWin().document, 'schedule')
    expect(span.classList.contains('dt-tile-svg')).toBe(true)
    expect(span.innerHTML).toContain('>' + new Date().getDate() + '<')
  })

  test('앱 종류가 아닌 모듈(backup)은 글리프 타일이다', () => {
    const span = tiles.createTile(getWin().document, 'backup')
    expect(span.classList.contains('dt-tile-svg')).toBe(false)
    const glyph = span.querySelector('i[data-lucide]')
    expect(glyph).not.toBeNull()
    expect(glyph.getAttribute('data-lucide')).toBe('archive')
    expect(tiles.glyphFor('backup')).toBe('archive')
    expect(tiles.tileDef('memo').label).toBe('메모')
  })
})

describe('휴지통 타일 — 빈 통/찬 통 결선', () => {
  let tiles: any
  let fi: any

  beforeEach(() => {
    const apis = loadApis()
    tiles = apis.tiles
    fi = apis.fi
  })

  test('타일 하나에 빈 통·찬 통 두 <image>가 함께 있고 CSS 전환용 클래스를 단다', () => {
    const svg = fi.appTileFor('trash')
    expect(svg).toContain('class="mta-trash-empty" href="/icons/trash-empty-128.png"')
    expect(svg).toContain('class="mta-trash-full" href="/icons/trash-full-128.png"')
    const span = tiles.createTile(getWin().document, 'trash')
    const images = span.querySelectorAll('image')
    expect(images).toHaveLength(2)
    expect(images[0].getAttribute('href')).toBe('/icons/trash-empty-128.png')
    expect(images[1].getAttribute('href')).toBe('/icons/trash-full-128.png')
  })
})

describe('dock — loadDockIds·createDock 결선', () => {
  let dock: any
  let tiles: any

  beforeEach(() => {
    const apis = loadApis()
    dock = apis.dock
    tiles = apis.tiles
  })

  function storageOf(value: unknown): any {
    return {
      getItem: (k: string) => (k === dock.DOCK_KEY ? (value == null ? null : JSON.stringify(value)) : null),
      setItem: () => undefined,
    }
  }

  test('저장이 없으면 카탈로그 전체, 저장이 있으면 모르는 id 제거·중복 제거·저장 순서 존중', () => {
    const catalog = ['finder', 'memo', 'chat']
    expect(dock.loadDockIds(null, catalog)).toEqual(catalog)
    expect(dock.loadDockIds(storageOf(null), catalog)).toEqual(catalog)
    const saved = { version: 5, ids: ['memo', 'finder', 'memo', 'unknown'] }
    expect(dock.loadDockIds(storageOf(saved), catalog)).toEqual(['memo', 'finder'])
  })

  test('구버전 저장은 마이그레이션으로 미션·파인더·브라우저·오피스 4종을 끼워 넣는다', () => {
    const catalog = ['finder', 'browser', 'mission', 'settings', 'chat', 'excel', 'hangul', 'powerpoint', 'pdf']
    const saved = { version: 1, ids: ['chat'] }
    expect(dock.loadDockIds(storageOf(saved), catalog)).toEqual([
      'finder',
      'browser',
      'excel',
      'hangul',
      'powerpoint',
      'pdf',
      'chat',
      'mission',
    ])
    // 현행 버전(v5) 저장은 사용자 구성을 그대로 존중한다
    const current = { version: 5, ids: ['chat'] }
    expect(dock.loadDockIds(storageOf(current), catalog)).toEqual(['chat'])
  })

  test('createDock은 항목 버튼·타일·실행점을 렌더하고 update가 열림 상태를 토글한다', () => {
    const win = getWin()
    const root = win.document.createElement('nav')
    win.document.body.appendChild(root)
    const d = dock.createDock({
      container: root,
      tilesApi: tiles,
      items: [
        { id: 'finder', label: 'Finder' },
        { id: 'settings', label: '설정' },
        { id: 'trash', label: '휴지통' },
      ],
      onActivate: () => undefined,
    })
    const items = root.querySelectorAll('.dt-dock-item')
    expect(items).toHaveLength(3)
    expect(items[0].dataset.module).toBe('finder')
    expect(items[0].querySelector('.dt-dock-tip').textContent).toBe('Finder')
    // 설정·휴지통도 실물 타일로 렌더된다
    expect(items[1].innerHTML).toContain('href="/icons/settings-app-v3-128.png"')
    expect(items[2].querySelectorAll('image')).toHaveLength(2)
    // 타일 크기는 BASE(48px)
    expect((items[0].querySelector('.dt-tile') as any).style.width).toBe('48px')
    d.update({ openIds: ['finder'], activeId: 'finder', minimizedIds: [] })
    expect(items[0].classList.contains('is-open')).toBe(true)
    expect((items[0].querySelector('.dt-dock-dot') as any).style.opacity).toBe('1')
    expect((items[1].querySelector('.dt-dock-dot') as any).style.opacity).toBe('0')
    d.destroy()
  })
})
