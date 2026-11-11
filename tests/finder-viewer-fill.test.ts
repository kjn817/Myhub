/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 뷰어 임베드 화면(시트·한글 편집기) 채움 회귀 (2026-11-11)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - 시트 프레임·한글 편집기에 고정 vh 높이가 없다. 72vh 시절에는
 *   창이 클수록 시트 아래 여백이 커졌다 (실측: 기본 창 137.8px,
 *   최대화 185.2px).
 * - 채움 규칙(.finder-viewer-body.fv-fill …)이 실제로 닿는 DOM 계약:
 *   finder.html·office.html 양쪽의 #fvBody가 finder-viewer-body
 *   클래스를 가진다. 클래스가 없으면 JS가 붙이는 fv-fill만으로는
 *   규칙이 영원히 매칭되지 않는다.
 * - 높이 전파 체인이 끊기지 않는다: .fv-window가 세로 flex로
 *   크롬과 본문을 쌓고, office 루트(.office-viewer)도 세로 flex이며,
 *   본문(.finder-viewer-body)이 flex:1 + min-height:0을 가진다.
 * - Finder 뷰어 루트는 finder-viewer 오버레이 + hidden 시작이다
 *   (닫힌 상태는 목록 표면과 간섭 없음, 열면 전체 화면 다이얼로그).
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const FINDER_CSS = read('public/css/finder.css')
const OFFICE_CSS = read('public/css/office.css')
const FINDER_HTML = read('public/finder.html')
const OFFICE_HTML = read('public/office.html')

function ruleBody(css: string, selector: string): string {
  const idx = css.indexOf(selector)
  if (idx < 0) return ''
  const open = css.indexOf('{', idx)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

describe('뷰어 임베드 채움 계약', () => {
  test('시트 프레임·한글 편집기에 고정 vh 높이가 없다', () => {
    const cssNoComments = FINDER_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(cssNoComments).not.toMatch(/72vh/)
    const sheet = ruleBody(FINDER_CSS, '.fv-sheet-frame {')
    expect(sheet).not.toMatch(/height\s*:/)
    const hwp = ruleBody(FINDER_CSS, '.fv-hwp-editor {')
    expect(hwp).not.toMatch(/height\s*:/)
  })

  test('fv-fill 채움 규칙이 flex 채움을 선언한다', () => {
    const fill = ruleBody(FINDER_CSS, '.finder-viewer-body.fv-fill .fv-sheet-frame,')
    expect(fill).toMatch(/flex:\s*1 1 auto/)
    expect(fill).toMatch(/min-height:\s*0/)
  })

  test('한글 편집기 iframe은 절대배치로 컨테이너를 채운다 (% 높이 붕괴 회귀 방지)', () => {
    // .fv-hwp-editor는 flex 아이템이지만 그 안의 iframe은 height:100%가
    // 해소되지 않아 150px로 무너진다 (office.html 단독 진입 실측).
    // 컨테이너를 기준 상자로 삼는 절대배치가 깨지면 이 테스트가 실패한다.
    const box = ruleBody(FINDER_CSS, '.finder-viewer-body.fv-fill .fv-hwp-editor { position')
    expect(box).toMatch(/position:\s*relative/)
    const frame = ruleBody(FINDER_CSS, '.finder-viewer-body.fv-fill .fv-hwp-editor iframe {')
    expect(frame).toMatch(/position:\s*absolute/)
    expect(frame).toMatch(/inset:\s*0/)
  })

  test('양쪽 페이지의 #fvBody가 finder-viewer-body 클래스를 가진다', () => {
    // 원본 마크업은 class가 id보다 앞이다 (<div class="finder-viewer-body"
    // id="fvBody">) — 계약은 속성 순서가 아니라, id="fvBody"인 div가
    // finder-viewer-body 클래스를 품는 것이다 (클래스가 없으면
    // .finder-viewer-body 규칙이 매칭되지 않는다).
    for (const html of [FINDER_HTML, OFFICE_HTML]) {
      const tag = html.match(/<div[^>]*id="fvBody"[^>]*>/)
      expect(tag).not.toBeNull()
      expect(tag![0]).toContain('finder-viewer-body')
    }
  })

  test('Finder 뷰어 루트는 finder-viewer 오버레이로 hidden 시작한다', () => {
    const tag = FINDER_HTML.match(/<div[^>]*id="finderViewer"[^>]*>/)
    expect(tag).not.toBeNull()
    expect(tag![0]).toContain('finder-viewer')
    expect(tag![0]).toContain('hidden')
  })

  test('높이 전파 체인: .fv-window와 .office-viewer가 세로 flex다', () => {
    const win = ruleBody(FINDER_CSS, '.fv-window {')
    expect(win).toMatch(/display:\s*flex/)
    expect(win).toMatch(/flex-direction:\s*column/)
    expect(win).toMatch(/min-height:\s*0/)
    const officeViewer = ruleBody(OFFICE_CSS, '.office-viewer {')
    expect(officeViewer).toMatch(/display:\s*flex/)
    expect(officeViewer).toMatch(/flex-direction:\s*column/)
    const body = ruleBody(FINDER_CSS, '.finder-viewer-body {')
    expect(body).toMatch(/flex:\s*1 1 auto/)
    expect(body).toMatch(/min-height:\s*0/)
  })
})
