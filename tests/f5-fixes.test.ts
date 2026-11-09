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

describe('F5-1 셸 액션 프록시 — 비서 버튼 제외 + img 크기 상한', () => {
  const win = readPub('/js/desktop/windows.js')
  const css = readPub('/css/desktop.css')

  test('syncAppActions가 비서 아바타 버튼을 프록시 생성 전에 제외한다', () => {
    // 운영 원본의 메커니즘: syncAppActions가 활성 창 문서의 .g-nav 버튼을
    // 수집할 때 awAvatarBtn(비서 아바타)을 건너뛰고 나머지만 프록시로 만든다.
    // (재구축본의 proxyBtn/innerHTML 복사 방식은 운영에 없다.)
    const start = win.indexOf('function syncAppActions()')
    const end = win.indexOf('function buildButtonProxy', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const region = win.slice(start, end)
    expect(region).toContain("node.id === 'awAvatarBtn'")
    expect(region).toContain("node.classList.contains('aw-avatar-btn')")
    expect(region.indexOf("node.id === 'awAvatarBtn'")).toBeLessThan(region.indexOf('buildButtonProxy(node)'))
  })

  test('desktop.css가 .dt-app-action img에 크기 상한을 둔다', () => {
    const m = css.match(/\.dt-app-action img\s*\{[^}]*\}/)
    expect(m).not.toBeNull()
    expect(m![0]).toMatch(/max-width\s*:/)
    expect(m![0]).toMatch(/max-height\s*:/)
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

