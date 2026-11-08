/// <reference types="jest" />
/**
 * src/services/privacy-detection-split.ts — 공백/점으로 쪼갠 API 키 탐지 성질.
 *
 * 핵심 성질: "쪼갠 조각을 이으면 완전한 키 형식이 되는 경우에만" 탐지한다.
 * 이으면 짧거나 형식이 깨지는 조각 묶음은 탐지하지 않는다(오탐 방지),
 * 붙어 있는 정상 키는 이 스캐너의 몫이 아니다(엔진 RULES 담당).
 * 카나리아: API_KEY_FULL_RE의 sk 최소 길이를 16→8로 낮추면 near-miss 케이스가 실패한다.
 */
import { scanSeparatedApiKeys } from '../../src/services/privacy-detection-split'

describe('scanSeparatedApiKeys — 쪼갠 키 탐지', () => {
  test('공백으로 쪼갠 sk 키: 이으면 16자 이상이면 탐지하고 구간은 원문 전체를 덮는다', () => {
    const text = '키는 sk-abcdefgh ijklmnop qrstuvwx 입니다'
    const out = scanSeparatedApiKeys(text)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'API_KEY', level: 3 })
    expect(text.slice(out[0].start, out[0].end)).toBe('sk-abcdefgh ijklmnop qrstuvwx')
    expect(out[0].value).toBe('sk-abcdefgh ijklmnop qrstuvwx')
  })

  test('점으로 쪼갠 키도 탐지한다', () => {
    const out = scanSeparatedApiKeys('sk-abcdefgh.ijklmnop.qrstuvwx')
    expect(out).toHaveLength(1)
    expect(out[0].value).toBe('sk-abcdefgh.ijklmnop.qrstuvwx')
  })

  test('AIza·ghp_ 접두사도 쪼개면 탐지한다', () => {
    expect(scanSeparatedApiKeys('AIza abcdefghij klmnopqrst uvwxyz')).toHaveLength(1)
    expect(scanSeparatedApiKeys('ghp_aaaaaaaaaa bbbbbbbbbb cccccccccc')).toHaveLength(1)
  })

  test('한 문장에 쪼갠 키가 둘이면 둘 다, 순서대로', () => {
    const text = 'sk-abcdefgh ijklmnop qrstuvwx 그리고 AIza abcdefghij klmnopqrst uvwxyz'
    const out = scanSeparatedApiKeys(text)
    expect(out).toHaveLength(2)
    expect(out[0].start).toBeLessThan(out[1].start)
  })
})

describe('scanSeparatedApiKeys — 오탐 방지', () => {
  test('이으면 최소 길이에 못 미치는 조각은 탐지하지 않는다', () => {
    expect(scanSeparatedApiKeys('sk-abcd efgh')).toEqual([])
    expect(scanSeparatedApiKeys('AIza abc def')).toEqual([])
  })

  test('한 글자 조각이 끼면 연결이 끊겨 탐지하지 않는다', () => {
    expect(scanSeparatedApiKeys('sk-abcdefgh i jklmnopqrstuv')).toEqual([])
  })

  test('키 접두사가 없는 일반 문장은 탐지하지 않는다', () => {
    expect(scanSeparatedApiKeys('오늘 회의는 세 시에 시작합니다')).toEqual([])
    expect(scanSeparatedApiKeys('hello world this is a test')).toEqual([])
    expect(scanSeparatedApiKeys('')).toEqual([])
  })

  test('붙어 있는 정상 키는 이 스캐너가 탐지하지 않는다 (구분자 필수)', () => {
    expect(scanSeparatedApiKeys('sk-abcdefghijklmnopqrstuvwx')).toEqual([])
  })

  test('접두사만 있고 본문이 없으면 탐지하지 않는다', () => {
    expect(scanSeparatedApiKeys('sk- 그리고 AIza')).toEqual([])
  })
})
