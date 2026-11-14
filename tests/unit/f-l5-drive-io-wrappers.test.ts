/// <reference types="jest" />
/**
 * F-L5 drive-io 래퍼 테스트 (5-5)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - finder.js·office.js에 로컬 "다른 이름으로 저장" POST 본문이 없다
 *   ('create http'·'create shape'·'import http'·'import shape' 문구는
 *   코어에만 있다). finder의 hwp→hwpx 이름 교정은 유지된다.
 * - 세 호출처가 코어를 쓴다 (finder save-as, office createSaveFlow,
 *   office importDriveFile — label 'create' 2곳·'import' 1곳).
 * - 버전 조회는 resolveDriveFileVersion으로 가고, finder의 warn·
 *   office의 adoptError 처리는 호출처에 남아 있다.
 * - HTML 로딩 순서와 에셋 등록이 맞다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

describe('F-L5 drive-io 래퍼', () => {
  test('finder.js·office.js에 로컬 생성 POST 본문이 없다', () => {
    for (const f of ['public/js/finder.js', 'public/js/office.js']) {
      const src = read(f)
      expect(src).not.toMatch(/create http/)
      expect(src).not.toMatch(/create shape/)
      expect(src).not.toMatch(/throw new Error\('import http/)
      expect(src).not.toMatch(/throw new Error\('import shape/)
      // 로컬 FormData 생성 POST가 아니라 코어 호출이다
      expect(src).toMatch(/uploadDriveFile\(/)
      expect(src).toMatch(/resolveDriveFileVersion\(/)
      expect(src).toMatch(/requireDriveIo\(\)/)
    }
  })

  test('label이 호출처별로 맞다 (create 2곳·import 2곳)', () => {
    const finder = read('public/js/finder.js')
    expect(finder).toMatch(/uploadDriveFile\(fetch, blob, name, sel\.folderId, 'create'\)/)
    expect(finder).toMatch(/uploadDriveFile\(fetch, file, file\.name, folderId, 'import'\)/)
    const office = read('public/js/office.js')
    expect(office).toMatch(
      /uploadDriveFile\(baseFetch, blob, sel\.name, sel\.folderId, 'create'\)/,
    )
    expect(office).toMatch(
      /uploadDriveFile\(baseFetch, file, file\.name, folderId, 'import'\)/,
    )
  })

  test('finder의 hwp→hwpx 이름 교정이 유지된다', () => {
    const finder = read('public/js/finder.js')
    expect(finder).toMatch(/file\.kind === 'hwp' \|\| file\.kind === 'hwpx'/)
    expect(finder).toMatch(/name \+= '\.hwpx'/)
  })

  test('버전 조회 실패 처리가 호출처에 남아 있다', () => {
    const finder = read('public/js/finder.js')
    expect(finder).toContain('저장 뒤 파일 정보 넣기 실패(무시):')
    const office = read('public/js/office.js')
    expect(office).toContain('file.adoptError = String((err && err.message) || err);')
  })

  test('HTML이 drive-io를 소비자보다 먼저 받는다', () => {
    const finderHtml = read('public/finder.html')
    expect(finderHtml.indexOf('/js/common/drive-io.js')).toBeLessThan(
      finderHtml.indexOf('/js/finder.js'),
    )
    const officeHtml = read('public/office.html')
    expect(officeHtml.indexOf('/js/common/drive-io.js')).toBeLessThan(
      officeHtml.indexOf('/js/office.js'),
    )
  })

  test('drive-io가 static-assets.json + DYNAMIC_ASSETS에 등록됐다', () => {
    const manifest = JSON.parse(read('scripts/static-assets.json'))
    expect(manifest.files).toContain('/js/common/drive-io.js')
    expect(read('public/js/asset-url.js')).toContain("'/js/common/drive-io.js'")
  })
})
