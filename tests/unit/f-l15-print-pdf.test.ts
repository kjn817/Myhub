/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * F-L15 printPdfBytes 공용 본문 테스트 (5-5)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - 바이트가 있으면 숨은 1px iframe을 body에 붙이고, load 뒤에
 *   iframe의 print를 부른다.
 * - 바이트가 없으면 onFail을 부르고 iframe을 만들지 않는다.
 * - sheet·slide의 인쇄 래퍼가 이 공용 본문을 쓴다 (로컬 iframe
 *   생성 본문 없음).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../public/js/finder-codec.js')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const viewer = require('../../public/js/finder-viewer.js')
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const doc: any = (globalThis as any).document
const win: any = (globalThis as any).window
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

// jsdom의 URL에는 createObjectURL이 없다 — 브라우저에만 있는 API라
// 스텁으로 채운다 (iframe 생성·print 호출이 검증 대상이다).
const g = globalThis as any
if (typeof g.URL.createObjectURL !== 'function') {
  g.URL.createObjectURL = () => 'blob:test-print'
  g.URL.revokeObjectURL = () => {}
}

describe('F-L15 printPdfBytes', () => {
  beforeEach(() => {
    doc.body.innerHTML = ''
  })

  test('바이트가 있으면 숨은 iframe을 붙이고 load 뒤 print를 부른다', async () => {
    const failed: string[] = []
    viewer.printPdfBytes(doc, new Uint8Array([1, 2, 3]), () => failed.push('fail'))
    const pf = doc.querySelector('iframe')
    expect(pf).not.toBeNull()
    expect(pf.getAttribute('aria-hidden')).toBe('true')
    expect(pf.style.width).toBe('1px')
    expect(pf.src.startsWith('blob:')).toBe(true)
    const printed: string[] = []
    const cw: any = pf.contentWindow
    cw.print = () => printed.push('printed')
    pf.dispatchEvent(new win.Event('load'))
    await new Promise((r) => setTimeout(r, 350))
    expect(printed).toEqual(['printed'])
    expect(failed).toEqual([])
  })

  test('바이트가 없으면 onFail을 부르고 iframe을 만들지 않는다', () => {
    const failed: string[] = []
    viewer.printPdfBytes(doc, null, () => failed.push('fail'))
    expect(failed).toEqual(['fail'])
    expect(doc.querySelector('iframe')).toBeNull()
  })

  test('sheet·slide 인쇄 래퍼 본문이 공용 코어를 쓴다', () => {
    // 래퍼 함수 본문만 잘라서 본다 (시트 파일의 다른 iframe은 엔진
    // 임베드라 인쇄와 무관하다).
    const sheet = read('public/js/finder-format-sheet.js')
    const sheetFn = sheet.slice(
      sheet.indexOf('function printPdfBase64'),
      sheet.indexOf('function mountSheet'),
    )
    expect(sheetFn).toContain('MyHubFinderViewer.printPdfBytes')
    expect(sheetFn).not.toContain("createElement('iframe')")
    expect(sheetFn).not.toContain('contentWindow.print()')

    const slide = read('public/js/finder-format-slide.js')
    const slideFn = slide.slice(
      slide.indexOf('function printPdfBytes(bytes)'),
      slide.indexOf('function downloadExport'),
    )
    expect(slideFn).toContain('MyHubFinderViewer.printPdfBytes')
    expect(slideFn).not.toContain("createElement('iframe')")
    expect(slideFn).not.toContain('contentWindow.print()')

    // 실패 문구는 각자 유지한다
    expect(sheet).toContain('서식을 시작하지 못했습니다')
    expect(slide).toContain('인쇄를 시작하지 못했습니다')
  })
})
