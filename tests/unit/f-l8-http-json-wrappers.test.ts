/// <reference types="jest" />
/**
 * F-L8 http-json 래퍼 테스트 (5-5)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - drop-upload.js·fonts.js에 로컬 jsonOrThrow 본문이 없다
 *   (res.json().catch 본문은 코어에만 있다). drop-upload의 인라인
 *   복사(업로드 기본 문구)도 코어 호출로 바뀌었다.
 * - 두 파일 모두 같은 이름의 래퍼를 남겨 `.then(jsonOrThrow)` 호출이
 *   그대로 된다.
 * - HTML 5곳의 로딩 순서와 에셋 등록이 맞다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

describe('F-L8 http-json 래퍼', () => {
  test('drop-upload.js·fonts.js에 로컬 json 본문이 없다', () => {
    for (const f of ['public/js/desktop/drop-upload.js', 'public/js/fonts.js']) {
      const src = read(f)
      // 로컬 본문의 특징: res.json().catch(() => null) 뒤의 본문 검사
      expect(src).not.toMatch(/body && body\.error \? String\(body\.error\)/)
      expect(src).toMatch(/MyHubHttpJson/)
      expect(src).toMatch(/function jsonOrThrow\(res, fallbackMsg\) \{/)
    }
  })

  test('drop-upload의 인라인 업로드 복사가 코어 호출로 바뀌었다', () => {
    const src = read('public/js/desktop/drop-upload.js')
    expect(src).toMatch(
      /return jsonOrThrow\(res, '업로드에 실패했습니다 \(' \+ res\.status \+ '\)'\);/,
    )
    // .then(jsonOrThrow) 직접 전달 호출이 그대로 있다 (기본 문구 경로)
    expect(src).toMatch(/\.then\(jsonOrThrow\)/)
  })

  test('fonts.js의 .then(jsonOrThrow) 호출이 그대로 있다', () => {
    const src = read('public/js/fonts.js')
    expect(src.match(/\.then\(jsonOrThrow\)/g)?.length).toBeGreaterThanOrEqual(3)
  })

  test('HTML 5곳이 http-json을 소비자보다 먼저 받는다', () => {
    const cases: Array<[string, string]> = [
      ['public/desktop.html', '/js/desktop/drop-upload.js'],
      ['public/finder.html', '/js/fonts.js'],
      ['public/office.html', '/js/fonts.js'],
      ['public/sheet.html', '/js/fonts.js'],
      ['public/sheet-fortune.html', '/js/fonts.js'],
    ]
    for (const [htmlFile, consumer] of cases) {
      const html = read(htmlFile)
      expect(html.indexOf('/js/common/http-json.js')).toBeGreaterThan(-1)
      expect(html.indexOf('/js/common/http-json.js')).toBeLessThan(
        html.indexOf(consumer),
      )
    }
  })

  test('http-json이 static-assets.json + DYNAMIC_ASSETS에 등록됐다', () => {
    const manifest = JSON.parse(read('scripts/static-assets.json'))
    expect(manifest.files).toContain('/js/common/http-json.js')
    expect(read('public/js/asset-url.js')).toContain("'/js/common/http-json.js'")
  })
})
