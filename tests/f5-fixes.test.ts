/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/// <reference types="node" />
/**
 * F5 프론트 회귀 테스트 (2026-11-07 운영 QA 3차 실패의 카나리아).
 *
 * 검증하는 성질:
 * 1. 사진 오버레이(결함 ①): 셸 windows.js의 일반 액션 프록시는 오피스 전용
 *    비서 버튼(#officeAssistantBtn)을 복사하지 않는다 — 복사하면 내부 아바타
 *    img(1600px 원본)가 크기 제약 없이 상단바에 붙어 화면 전체를 덮는다.
 *    desktop.css도 프록시 img에 크기 상한을 둬 이중으로 막는다.
 * 2. syncChrome(결함 ②b): office.js host는 존재하지 않는 syncChrome()을
 *    부르지 않고 실제 크롬 갱신 함수 publishTitle()을 쓴다 — 한글 세션이
 *    host.markDirty()를 부르면 ReferenceError로 연산이 실패하던 결함.
 * 3. PDF 스냅샷(결함 ③): 페이지 수만이 아니라 페이지별 크기·회전 메타를
 *    싣고, 미저장 새 문서에서도 엔진 기본 문서(blank.pdf)의 메타가 실려
 *    모델이 연산을 만들 수 있다 (pageCount: null이면 모델이 대화 막다른
 *    길로 빠진다).
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const PUB = path.join(ROOT, 'public')
function readPub(p: string): string {
  return fs.readFileSync(path.join(PUB, p), 'utf-8')
}

describe('F5-1 셸 액션 프록시 제거 (2026-11-12 사용자 결정)', () => {
  const win = readPub('/js/desktop/windows.js')
  const css = readPub('/css/desktop.css')

  test('syncAppActions에 .g-nav 프록시 수집이 없다 (buildButtonProxy·buildSearchProxy 제거)', () => {
    // 옛 프록시 수집(.g-nav 버튼·검색창을 상단바로 복사)은 모든 현행 앱이
    // MyHubMenus를 갖거나 data-app-actions="none"이라 수집할 것이 없었고,
    // 2026-11-04 결정대로 상단바 프록시는 원하지 않아 2026-11-12에 제거했다.
    // 비서 아바타 제외 로직도 수집 자체가 없어져 함께 사라진다.
    expect(win).not.toContain('function buildButtonProxy')
    expect(win).not.toContain('function buildSearchProxy')
    expect(win).not.toContain("querySelector('.g-nav')")
    expect(win).not.toContain("querySelectorAll('.g-nav")
    expect(win).not.toContain('dt-app-action')
    // 메뉴 경로는 살아 있다: MyHubMenus가 있으면 상단바에 게시한다.
    expect(win).toContain('function syncAppActions()')
    expect(win).toContain('readAppMenus(doc)')
  })

  test('desktop.css에 죽은 프록시 스타일(.dt-app-action·.dt-app-search)이 없다', () => {
    // 프록시 버튼·검색창을 만드는 코드가 없어져 그 스타일도 함께 제거했다.
    // 메뉴바 호스트인 컨테이너(#dt-app-actions·.dt-app-actions)는 남는다.
    expect(css).not.toContain('.dt-app-action ')
    expect(css).not.toContain('.dt-app-action{')
    expect(css).not.toContain('.dt-app-action:')
    expect(css).not.toContain('.dt-app-search')
    expect(css).toContain('#dt-app-actions {')
    expect(css).toContain('.dt-app-actions {')
  })
})

describe('F5-2 office.js host — syncChrome 참조 제거', () => {
  const office = readPub('/js/office.js')

  test('office.js 어디에도 syncChrome 식별자가 없다', () => {
    expect(office).not.toContain('syncChrome')
  })

  test('제목 동기 notifyDocTitle이 미저장 점(●)과 문서명을 탭 제목에 반영한다', () => {
    // 운영 원본의 제목 갱신 경로는 markDirty/publishTitle이 아니라
    // notifyDocTitle이다 (I-11: 파일명 + 미저장 점을 탭 제목에도 반영).
    const start = office.indexOf('function notifyDocTitle()')
    expect(start).toBeGreaterThan(-1)
    const end = office.indexOf('\n    function ', start + 10)
    const region = office.slice(start, end === -1 ? start + 2000 : end)
    expect(region).toContain("payload.dirty ? '● ' : ''")
    expect(region).toContain('payload.name')
    expect(office).toContain('notifyDocTitle: notifyDocTitle')
  })
})

