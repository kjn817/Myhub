/// <reference types="jest" />
/**
 * F-L15 finder.js promptName 공유 테스트 (5-5)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - promptName 정의 1개, 호출처 3곳(파일 이름 바꾸기·폴더 이름
 *   바꾸기·새 폴더). 같은 이름이면 resolve(null)로 건너뛰는 계약과
 *   빈 이름이면 빈 문자열로 거절하는 계약이 1곳에 있다.
 * - 이름 프롬프트의 window.prompt 직접 호출은 promptName 안에만 있다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

describe('F-L15 promptName', () => {
  const src = read('public/js/finder.js')

  test('promptName 정의 1개·호출처 3곳', () => {
    expect(src.match(/function promptName\(title, def, sameAs\)/g)).toHaveLength(1)
    expect(src.match(/promptName\('파일 이름', row\.name, row\.name\)/g)).toHaveLength(1)
    expect(src.match(/promptName\('폴더 이름', row\.name, row\.name\)/g)).toHaveLength(1)
    expect(src.match(/promptName\('새 폴더 이름', '새 폴더'\)/g)).toHaveLength(1)
  })

  test('같은 이름 건너뛰기·빈 이름 거절 계약이 1곳에 있다', () => {
    const fn = src.slice(src.indexOf('function promptName'))
    const body = fn.slice(0, fn.indexOf('\n    }\n'))
    expect(body).toMatch(/if \(!name\) return null;/)
    expect(body).toMatch(/if \(sameAs !== undefined && name === sameAs\) return null;/)
  })

  test('window.prompt 직접 호출은 promptFn 기본값 1곳뿐이다', () => {
    expect(src.match(/window\.prompt\(msg, def\)/g)).toHaveLength(1)
    // 세 호출처는 promptName을 거친다 (promptFn 직접 호출 없음)
    expect(src.match(/promptFn\('파일 이름'|promptFn\('폴더 이름'|promptFn\('새 폴더 이름'/g)).toBeNull()
  })
})
