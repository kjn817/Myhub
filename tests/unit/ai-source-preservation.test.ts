/// <reference types="jest" />

import { searchAnchor, getLastUserMessage } from '../../src/ai/source-preservation'

describe('searchAnchor', () => {
  const original = '내일 오후 3시에 회의가 있어. 회의 자료를 준비해줘.'

  test('유일 매칭 시 extractedText 반환', () => {
    const result = searchAnchor(original, '오후 3시')
    expect(result.found).toBe(true)
    expect(result.matchCount).toBe(1)
    expect(result.extractedText).toBe('오후 3시')
    expect(result.reason).toBeUndefined()
  })

  test('빈 앵커는 EMPTY_ANCHOR', () => {
    expect(searchAnchor(original, '')).toEqual({
      found: false,
      matchCount: 0,
      reason: 'EMPTY_ANCHOR',
    })
    expect(searchAnchor(original, '   ').reason).toBe('EMPTY_ANCHOR')
  })

  test('찾을 수 없으면 NOT_FOUND', () => {
    const result = searchAnchor(original, '없는 텍스트')
    expect(result.found).toBe(false)
    expect(result.matchCount).toBe(0)
    expect(result.reason).toBe('NOT_FOUND')
  })

  test('여러 곳에 매칭되면 MULTIPLE_MATCHES', () => {
    const result = searchAnchor(original, '회의')
    expect(result.found).toBe(false)
    expect(result.matchCount).toBe(2)
    expect(result.reason).toBe('MULTIPLE_MATCHES')
    expect(result.extractedText).toBeUndefined()
  })

  test('앵커 앞뒤 공백은 trim됨', () => {
    const result = searchAnchor(original, '  오후 3시  ')
    expect(result.found).toBe(true)
    expect(result.extractedText).toBe('오후 3시')
  })

  test('extractedText는 서버 원본 구간 (모델 앵커와 다를 수 있음)', () => {
    // 원본에 정확히 일치하는 경우
    const result = searchAnchor('hello world', 'world')
    expect(result.extractedText).toBe('world')
  })
})

describe('getLastUserMessage', () => {
  test('마지막 user 메시지 반환', () => {
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ]
    expect(getLastUserMessage(messages)).toBe('second')
  })

  test('user 메시지가 없으면 null', () => {
    const messages = [{ role: 'assistant', content: 'hi' }]
    expect(getLastUserMessage(messages)).toBeNull()
  })

  test('빈 배열이면 null', () => {
    expect(getLastUserMessage([])).toBeNull()
  })

  test('단일 user 메시지', () => {
    expect(getLastUserMessage([{ role: 'user', content: 'only' }])).toBe('only')
  })
})
