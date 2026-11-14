/// <reference types="jest" />
/**
 * F-L13 anim 래퍼 테스트 (5-5)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - desktop-icons.js·widgets.js·windows.js에 로컬 raf 본문이 없다
 *   (requestAnimationFrame 직접 호출은 코어에만 있다).
 * - getPositions 스냅샷 본문이 두 파일 모두에서 사라지고 copyPositions
 *   위임으로 바뀌었다.
 * - desktop.html이 anim을 세 소비자보다 먼저 받는다.
 * - 에셋 등록이 맞다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

describe('F-L13 anim 래퍼', () => {
  test('세 파일에 로컬 raf 본문이 없다', () => {
    for (const f of [
      'public/js/desktop/desktop-icons.js',
      'public/js/desktop/widgets.js',
      'public/js/desktop/windows.js',
    ]) {
      const src = read(f)
      expect(src).not.toMatch(/window\.requestAnimationFrame\(fn\)/)
      expect(src).not.toMatch(/window\.cancelAnimationFrame\(id\)/)
      expect(src).toMatch(/MyHubAnim/)
      expect(src).toMatch(/function animCore\(\) \{/)
    }
  })

  test('getPositions가 copyPositions 위임으로 바뀌었다', () => {
    for (const f of [
      'public/js/desktop/desktop-icons.js',
      'public/js/desktop/widgets.js',
    ]) {
      const src = read(f)
      expect(src).not.toMatch(/Object\.keys\(positions\)\.forEach/)
      expect(src).toMatch(/return copyPositions\(positions\);/)
    }
  })

  test('desktop.html이 anim을 세 소비자보다 먼저 받는다', () => {
    const html = read('public/desktop.html')
    const core = html.indexOf('/js/common/anim.js')
    expect(core).toBeGreaterThan(-1)
    for (const consumer of [
      '/js/desktop/windows.js',
      '/js/desktop/desktop-icons.js',
      '/js/desktop/widgets.js',
    ]) {
      expect(core).toBeLessThan(html.indexOf(consumer))
    }
  })

  test('anim이 static-assets.json + DYNAMIC_ASSETS에 등록됐다', () => {
    const manifest = JSON.parse(read('scripts/static-assets.json'))
    expect(manifest.files).toContain('/js/common/anim.js')
    expect(read('public/js/asset-url.js')).toContain("'/js/common/anim.js'")
  })
})
