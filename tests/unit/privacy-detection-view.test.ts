/// <reference types="jest" />
/**
 * src/services/privacy-detection-view.ts — 탐지용 정제 사본과 원본 좌표의 대응.
 *
 * 핵심 성질: ① 보이지 않는 형식 문자(Cf 전반·U+180E·변형 선택자
 * U+FE00–FE0F·U+E0100–E01EF)는 사본에서 빠지고, 나머지는 순서·내용이
 * 그대로다 ② cleanPos/orig는 서로 역방향으로 읽히는 단조 대응이라,
 * 정제 사본에서 찾은 구간을 원본으로 되돌리면 사이에 끼어 있던 투명
 * 문자까지 포함해 잘라낸다 ③ 온전히 투명 문자 위에만 걸친 구간은
 * 대응이 없어 null이다.
 * 카나리아: isInvisibleFormat의 범위 검사 중 하나를 지우거나, 서로게이트
 * 쌍의 폭(2) 처리를 1로 바꾸면 실패한다.
 */
import {
  buildDetectionView,
  viewSpanToOriginal,
  originalSpanToView,
} from '../../src/services/privacy-detection-view'

describe('buildDetectionView — 정제와 대응표', () => {
  test('일반 텍스트는 항등 대응이다', () => {
    const v = buildDetectionView('abc')
    expect(v.clean).toBe('abc')
    expect(v.orig).toEqual([0, 1, 2])
    expect(v.cleanPos).toEqual([0, 1, 2])
    expect(v.hasInvisible).toBe(false)
  })

  test('빈 문자열', () => {
    const v = buildDetectionView('')
    expect(v.clean).toBe('')
    expect(v.orig).toEqual([])
    expect(v.cleanPos).toEqual([])
    expect(v.hasInvisible).toBe(false)
  })

  test('제로폭 문자(U+200B, Cf)는 빠지고 그 자리만 -1이 된다', () => {
    const v = buildDetectionView('a\u200Bb')
    expect(v.clean).toBe('ab')
    expect(v.orig).toEqual([0, 2])
    expect(v.cleanPos).toEqual([0, -1, 1])
    expect(v.hasInvisible).toBe(true)
  })

  test('U+180E(cp 6158)도 투명으로 취급한다', () => {
    const v = buildDetectionView('a\u180Eb')
    expect(v.clean).toBe('ab')
    expect(v.cleanPos).toEqual([0, -1, 1])
    expect(v.hasInvisible).toBe(true)
  })

  test('변형 선택자 U+FE0F(cp 65039)는 Cf가 아니라도 명시 범위로 빠진다', () => {
    // U+FE0F는 Mn(결합 문자)이라 \p{Cf}만으로는 잡히지 않는다 — 명시 범위 검사의 몫.
    const v = buildDetectionView('a\uFE0Fb')
    expect(v.clean).toBe('ab')
    expect(v.hasInvisible).toBe(true)
  })

  test('U+E0100(cp 917760, 서로게이트 쌍)도 명시 범위로 빠진다', () => {
    const v = buildDetectionView('a\u{E0100}b')
    expect(v.clean).toBe('ab')
    expect(v.orig).toEqual([0, 3])
    expect(v.cleanPos).toEqual([0, -1, -1, 1])
    expect(v.hasInvisible).toBe(true)
  })

  test('보이는 서로게이트 쌍(😀)은 폭 2로 온전히 남는다', () => {
    const v = buildDetectionView('a😀b')
    expect(v.clean).toBe('a😀b')
    expect(v.orig).toEqual([0, 1, 2, 3])
    expect(v.cleanPos).toEqual([0, 1, 2, 3])
    expect(v.hasInvisible).toBe(false)
  })

  test('보이는 쌍 + 투명 문자가 섞이면 대응이 어긋나지 않는다', () => {
    // 원본: a(0) 😀(1,2) ZWSP(3) b(4)
    const v = buildDetectionView('a😀\u200Bb')
    expect(v.clean).toBe('a😀b')
    expect(v.orig).toEqual([0, 1, 2, 4])
    expect(v.cleanPos).toEqual([0, 1, 2, -1, 3])
  })
})

describe('viewSpanToOriginal — 정제 구간을 원본으로', () => {
  test('투명 문자를 사이에 낀 구간은 원본에서 투명 문자까지 포함해 잘린다', () => {
    const text = '김\u200B민준'
    const v = buildDetectionView(text)
    const span = viewSpanToOriginal(v, 0, 3) // 정제 사본의 '김민준' 전체
    expect(text.slice(span.start, span.end)).toBe('김\u200B민준')
  })

  test('투명 문자 뒤에서 시작하는 구간은 정확한 원본 위치를 가리킨다', () => {
    const text = 'a\u200Bbc'
    const v = buildDetectionView(text)
    const span = viewSpanToOriginal(v, 1, 3) // 정제 사본의 'bc'
    expect(text.slice(span.start, span.end)).toBe('bc')
    expect(span.start).toBe(2)
  })
})

describe('originalSpanToView — 원본 구간을 정제로', () => {
  test('전체 구간은 투명 문자를 제외한 길이가 된다', () => {
    const v = buildDetectionView('a\u200Bb')
    expect(originalSpanToView(v, 0, 3)).toEqual({ start: 0, end: 2 })
  })

  test('온전히 투명 문자 위에만 걸친 구간은 null이다', () => {
    const v = buildDetectionView('a\u200Bb')
    expect(originalSpanToView(v, 1, 2)).toBeNull()
  })

  test('투명 문자와 겹쳐 시작하면 보이는 부분부터 대응한다', () => {
    const v = buildDetectionView('a\u200Bb')
    expect(originalSpanToView(v, 1, 3)).toEqual({ start: 1, end: 2 })
  })

  test('왕복: 정제→원본→정제는 같은 구간으로 돌아온다', () => {
    const text = 'ab\u200Bcd\uFE0Fe'
    const v = buildDetectionView(text)
    const orig = viewSpanToOriginal(v, 1, 5) // 정제 'bcde'
    expect(text.slice(orig.start, orig.end)).toBe('b\u200Bcd\uFE0Fe')
    expect(originalSpanToView(v, orig.start, orig.end)).toEqual({ start: 1, end: 5 })
  })
})
