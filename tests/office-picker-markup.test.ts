/// <reference types="jest" />
/**
 * 열기/저장 패널(office-picker.js)의 DOM 계약 테스트.
 *
 * 검증 성질: office-picker.js의 createPicker가 el()로 찾는 모든 요소 ID가
 * 패널을 쓰는 문서(office.html·finder.html)에 실제로 존재한다. 마크업이
 * 빠지면 createPicker의 조회가 전부 null이 되어 패널이 열리지 않고
 * 저장 흐름이 '저장 중'에서 영원히 멈춘다 (2026-11-09 실브라우저에서
 * 재현·수정한 결함). ID 목록은 하드코딩하지 않고 office-picker.js
 * 소스에서 추출하므로 계약이 늘면 테스트도 따라간다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')

function pickerElementIds(): string[] {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/office-picker.js'), 'utf8')
  const ids = new Set<string>()
  for (const m of src.matchAll(/\bel\('([A-Za-z][A-Za-z0-9]*)'\)/g)) ids.add(m[1])
  return [...ids]
}

describe('office-picker DOM 계약', () => {
  const ids = pickerElementIds()

  it('office-picker.js에서 조회 ID가 추출된다', () => {
    expect(ids.length).toBeGreaterThanOrEqual(10)
    expect(ids).toContain('officePicker')
    expect(ids).toContain('officePickConfirm')
  })

  it.each(['office.html', 'finder.html'])('%s에 패널 요소가 전부 있다', (page) => {
    const html = fs.readFileSync(path.join(ROOT, 'public', page), 'utf8')
    const missing = ids.filter((id) => !html.includes(`id="${id}"`))
    expect(missing).toEqual([])
  })

  it('office.html의 패널은 처음에 숨겨져 있다', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/office.html'), 'utf8')
    const tag = html.match(/<div id="officePicker"[^>]*>/)
    expect(tag).not.toBeNull()
    expect(tag![0]).toContain('hidden')
  })
})
