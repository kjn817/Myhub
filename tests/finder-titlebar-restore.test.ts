/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * Finder 전면·제목줄 복원 회귀 (2026-11-10 사용자 지적 "Finder도 많이
 * 다르고 앱 타이틀바 처리가 여전히 달랐다" 재감사)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - finder.js(운영 전사본과 코드 동일)가 getElementById로 찾는 요소가
 *   finder.html에 실제로 있다. 빠지면 그 기능이 조용히 죽는다 — 실제로
 *   #finderHead가 없어 열 헤더가, #sideDesktop 등이 없어 즐겨찾기
 *   시스템 폴더가, #finderModeList/Grid 이름이 어긋나 창 바 보기 전환이
 *   죽어 있었다. 선택 요소(없는 쪽이 정본인 것)만 예외로 명시한다.
 * - 로드된 Finder에서 열 헤더 4열이 렌더되고, 사이드바 시스템 폴더가
 *   루트 폴더 존재에 따라 보이고, 보관함이 활성이며 개수 배지가 찬다.
 * - 보기 전환 버튼 클릭이 목록 모드를 실제로 바꾼다 (창 바가 보내는
 *   mode-list/mode-grid 액션도 같은 버튼 .click() 경유).
 * - shell.css가 Finder 토큰을 운영 캡처 실측값으로 정의한다 (미정의면
 *   사이드바 폭·머티리얼·inset이 전부 무효로 떨어진다).
 * - 오피스 제목 줄: 빠른 실행이 제목보다 앞에 오는 flex order, 접기
 *   셰브론을 그리는 CSS, 검색 입력 placeholder '문서 내 검색'.
 */
import * as fs from 'fs'
import * as path from 'path'
import { loadPage, until, jsonRes, PUB } from './f2-page-harness'

const ROOT = path.resolve(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

// finder.js가 찾지만 없어도 되는 요소 (코드 주석 "없는 요소는 건너뜀" +
// 운영 캡처에서 부재 확인): navQ(상단바 검색, 폐지)·countTrash(휴지통
// 개수 배지 없음)·finderQ(호스팅 검색이 대체)
const OPTIONAL_IDS = new Set(['navQ', 'countTrash', 'finderQ'])

describe('finder.html — finder.js 필수 요소 계약', () => {
  const js = read('public/js/finder.js')
  const html = read('public/finder.html')
  const wanted = [...new Set([...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]))]
  const present = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))

  test('finder.js가 찾는 요소가 전부 finder.html에 있다 (선택 요소 제외)', () => {
    const missing = wanted.filter((id) => !OPTIONAL_IDS.has(id) && !present.has(id))
    expect(missing).toEqual([])
  })

  test('사이드바 순서: 즐겨찾기(응용 프로그램·데스크톱·문서·다운로드) → 위치(보관함·사용량·휴지통)', () => {
    const order = ['data-view="apps"', 'id="sideDesktop"', 'id="sideDocs"', 'id="sideDownloads"', 'id="sideFavorites"', 'data-view="drive"', 'id="sideUsage"', 'data-view="trash"']
    const idx = order.map((s) => html.indexOf(s))
    idx.forEach((i) => expect(i).toBeGreaterThan(-1))
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
  })

  test('보관함 항목은 data-view="drive"이고 개수 배지(#countDrive.finder-side-count)를 품는다', () => {
    // 원본 계약 (2026-11-11 운영 원본 설치로 정정): 보관함 항목은 id가
    // 없는 data-view="drive" 버튼이다. finder.js는 [data-view] 위임으로
    // 사이드바를 바인딩하고 is-active를 토글한다 — 'sideRoot' 같은 id는
    // 원본 HTML에도 finder.js에도 없다 (재구성본 픽션을 핀했던 테스트).
    const tag = html.match(/<button[^>]*data-view="drive"[^>]*>/)
    expect(tag).not.toBeNull()
    expect(html).toContain('<span class="finder-side-count" id="countDrive"></span>')
    // 배지는 보관함 버튼 안에 품어져 있다 (버튼 시작 ~ </button> 사이).
    const start = html.indexOf(tag![0])
    const badge = html.indexOf('id="countDrive"')
    expect(badge).toBeGreaterThan(start)
    expect(badge).toBeLessThan(html.indexOf('</button>', start))
  })

  test('열 헤더 컨테이너 #finderHead가 도구막대와 목록 사이에 있다', () => {
    const head = html.indexOf('id="finderHead"')
    expect(head).toBeGreaterThan(html.indexOf('class="finder-toolbar"'))
    expect(head).toBeLessThan(html.indexOf('id="finderList"'))
  })
})

describe('Finder 로드 — 헤더·사이드바·보기 전환 실동작', () => {
  const LIST = {
    folder: null,
    folders: [
      { id: 11, name: '다운로드', created_at: '2026-11-04T06:29:00' },
      { id: 12, name: '문서', created_at: '2026-11-04T06:29:00' },
      { id: 13, name: '바탕화면', created_at: '2026-11-02T09:03:00' },
    ],
    files: [{ id: 21, filename: '제목 없음.hwpx', size: 20480, created_at: '2026-11-08T10:00:00', mime: 'application/octet-stream' }],
  }
  function load() {
    return loadPage('finder.html', async (url: string) => {
      if (url.includes('/api/drive/list')) return jsonRes(LIST)
      if (url.includes('/api/drive/usage')) return jsonRes({ files: 3, bytes: 3450000 })
      if (url.includes('/api/drive/recent')) return jsonRes({ folders: [], files: [] })
      if (url.includes('/api/drive/trash')) return jsonRes({ folders: [], files: [] })
      return jsonRes({})
    })
  }

  test('열 헤더에 이름·수정일·크기·종류 4열이 렌더된다', async () => {
    const { document } = load()
    const ok = await until(() => document.querySelectorAll('#finderHead .finder-col').length === 4)
    expect(ok).toBe(true)
    const labels = [...document.querySelectorAll('#finderHead .finder-col')].map((e: any) => e.querySelector('span')?.textContent.trim())
    expect(labels).toEqual(['이름', '수정일', '크기', '종류'])
  })

  test('사이드바: 시스템 폴더 3종이 보이고 보관함 활성 + 개수 4 + 사용량 문구', async () => {
    const { document } = load()
    const ok = await until(() => (document.getElementById('countDrive')?.textContent || '') === '4')
    expect(ok).toBe(true)
    for (const id of ['sideDesktop', 'sideDocs', 'sideDownloads']) {
      expect(document.getElementById(id)!.hidden).toBe(false)
    }
    expect(document.querySelector('[data-view="drive"]')!.classList.contains('is-active')).toBe(true)
    expect(document.getElementById('sideUsage')!.textContent).toContain('파일 3개')
  })

  test('보기 전환: #finderModeGrid 클릭 → 격자 모드, #finderModeList 클릭 → 목록 복귀', async () => {
    const { document } = load()
    const ok = await until(() => document.querySelectorAll('.finder-row').length >= 4)
    expect(ok).toBe(true)
    document.getElementById('finderModeGrid')!.click()
    await until(() => document.getElementById('finderList')!.classList.contains('is-grid'))
    expect(document.getElementById('finderList')!.classList.contains('is-grid')).toBe(true)
    document.getElementById('finderModeList')!.click()
    await until(() => !document.getElementById('finderList')!.classList.contains('is-grid'))
    expect(document.getElementById('finderList')!.classList.contains('is-grid')).toBe(false)
  })
})

describe('shell.css Finder 토큰 — 운영 원본값', () => {
  const shell = read('public/shell.css')
  // 2026-11-11: shell.css 운영 원본 바이트 회수·설치 후 값 정정 —
  // 캡처 실측 근사(#eff4f8·31px)가 아니라 원본 파일의 정의값이 정본이다.
  test('사이드바 폭 208px·머티리얼 #eff4f9·inset 8px가 정의되어 있다', () => {
    expect(shell).toContain('--finder-side-w: 208px')
    expect(shell).toContain('--finder-side-material: #eff4f9')
    expect(shell).toContain('--finder-inset: 8px')
    expect(shell).toContain('--finder-name-slot: calc(var(--finder-icon-w) + var(--finder-icon-gap))')
  })
})

describe('제목줄 — Finder 투톤·오피스 배치·검색 캡슐', () => {
  const css = read('public/css/desktop.css')
  const win = read('public/js/desktop/windows.js')

  test('Finder 제목줄은 사이드바 폭까지 사이드바 머티리얼, 도구는 그 지점에서 시작한다', () => {
    // 운영본(2026-11-10 회수)의 메커니즘: 제목줄 ::before 띠가 사이드바
    // 폭·머티리얼로 칠해지고, 제목 흐름은 108px로 제한된다.
    expect(css).toMatch(/\.dt-win-finder \.dt-titlebar::before\s*\{[^}]*width: var\(--finder-side-w\)[^}]*background: var\(--finder-side-material\)/)
    expect(css).toMatch(/\.dt-win-finder \.dt-title-flow\s*\{\s*max-width: 108px/)
  })

  test('오피스 빠른 실행은 제목보다 앞(왼쪽)에 온다 (flex order)', () => {
    expect(css).toMatch(/\.dt-win-office \.myhub-win-quick\s*\{\s*order: 2/)
    expect(css).toMatch(/\.dt-win-office \.dt-title-flow\s*\{\s*order: 3/)
    expect(css).toMatch(/\.dt-win-office \.myhub-win-search\s*\{\s*order: 4/)
  })

  test('접기 버튼 아이콘은 Lucide 셰브론이다 (CSS 테두리 꺽쇠 제거, 2026-11-12)', () => {
    // CSS 테두리로 그린 7px 꺽쇠(.myhub-win-chevron)는 옆의 Lucide 빠른
    // 실행 아이콘들과 결이 달라 제목줄에서 튀었다는 사용자 지적. 접기
    // 버튼은 Lucide chevron-up(펼침)/chevron-down(접힘) 아이콘을 쓰고,
    // 접기 기능(myhub:office-fold-toggle)은 그대로 유지한다.
    expect(win).toContain('myhub-win-fold')
    expect(win).toContain("foldSt.folded ? 'chevron-down' : 'chevron-up'")
    expect(win).toContain('data-lucide')
    expect(win).toContain("type: 'myhub:office-fold-toggle'")
    expect(win).not.toContain('myhub-win-chevron')
    expect(css).not.toContain('.myhub-win-chevron')
  })

  test('오피스 검색 입력 placeholder는 문서 내 검색이다', () => {
    expect(win).toContain("input.placeholder = '문서 내 검색'")
  })

  test('검색 캡슐은 아이콘을 안쪽에 품는 알약이다 (배경이 label에 있다)', () => {
    // 배경 값은 운영본(2026-11-10 회수) 기준 rgba(15, 23, 42, 0.06).
    expect(css).toMatch(/\.myhub-oq-search\s*\{[^}]*background: rgba\(15, 23, 42, 0\.06\)[^}]*border-radius: 999px|border-radius: 999px[^}]*background: rgba\(15, 23, 42, 0\.06\)/)
    expect(css).toMatch(/\.myhub-oq-search input\s*\{[^}]*background: none/)
  })
})
