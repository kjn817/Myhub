/// <reference types="jest" />
/**
 * F-L14 finder-format-hwp.js 내부 중복 추출 테스트 (5-5)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - wireIframeRetry 정의 1개·호출 2곳(메뉴 배선 2종), 재시도 스케줄
 *   [300,900,2000,4500]은 골격 안에 1번만 있다.
 * - listenEditorMessage 정의 1개·호출 2곳(파일 액션·메뉴 호스트).
 * - clearTimers는 state를 live로 읽는다 (wire 교체 후에도 현재 wire
 *   타이머를 비운다 — 원본 동작 보존).
 * - dirty-watch의 동일 스케줄은 별도 계약이라 합치지 않았다 (가드·
 *   errorKey 없음, doc 중복 방지) — 스케줄 리터럴은 파일 전체 2회.
 * - 파일에 NUL·DEL 바이트가 없다 (2단계 정리 유지).
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

describe('F-L14 hwp 배선 골격', () => {
  const src = read('public/js/finder-format-hwp.js')

  test('wireIframeRetry 정의 1개·호출 2곳', () => {
    expect(src.match(/function wireIframeRetry\(ctx, state, container, opts\)/g))
      .toHaveLength(1)
    expect(src.match(/wireIframeRetry\(ctx, state, container, \{/g)).toHaveLength(2)
  })

  test('재시도 스케줄은 상수 1곳 정의·2곳 참조 (5-9 중앙화)', () => {
    // 주석 속 언급(설계 노트 인용 1건)을 빼고 코드만 센다
    const code = src.replace(/\/\/.*$/gm, '')
    // 리터럴 정의는 1곳뿐, 두 배선 지점은 상수를 참조한다
    expect(code.match(/\[300, 900, 2000, 4500\]/g)).toHaveLength(1)
    expect(code).toMatch(/var HWP_RETRY_SCHEDULE_MS = \[300, 900, 2000, 4500\];/)
    expect(code.match(/HWP_RETRY_SCHEDULE_MS\.forEach/g)).toHaveLength(2)
    // 골격 본문에 상수 참조가 있다
    const skeleton = src.slice(src.indexOf('function wireIframeRetry'))
    expect(skeleton.slice(0, skeleton.indexOf('function wireStudioFileMenu'))).toContain(
      'HWP_RETRY_SCHEDULE_MS.forEach',
    )
  })

  test('clearTimers는 state를 live로 읽는다', () => {
    expect(src).toMatch(/var w = state\[opts\.wireKey\];/)
    expect(src).toMatch(/api\.clearTimers\(\)/)
  })

  test('listenEditorMessage 정의 1개·호출 2곳', () => {
    expect(src.match(/function listenEditorMessage\(ctx, state, flagKey, dispatch\)/g))
      .toHaveLength(1)
    expect(src.match(/listenEditorMessage\(ctx, state, '(fileActionListening|menuHostListening)'/g))
      .toHaveLength(2)
  })

  test('파일에 NUL·DEL 바이트가 없다', () => {
    const buf = fs.readFileSync(path.join(ROOT, 'public/js/finder-format-hwp.js'))
    expect(buf.includes(0)).toBe(false)
    expect(buf.includes(0x7f)).toBe(false)
  })
})
