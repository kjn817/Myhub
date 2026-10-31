/// <reference types="jest" />
/**
 * memory-reflection.ts 단위 테스트 (순수 함수 + 플래그)
 * - buildReflectionText: 요청/결과 조합, 빈 입력
 * - isLlmReflectionEnabled: 플래그 ON/OFF/행 없음/조회 실패
 */
import { buildReflectionText, isLlmReflectionEnabled } from '../../src/services/memory-reflection'

function makeDb(flagValue: any) {
  return {
    prepare(_sql: string) {
      return {
        bind(..._p: any[]) { return this },
        async first() {
          if (flagValue === 'throw') throw new Error('db')
          return flagValue === null ? null : { value: flagValue }
        },
      }
    },
  }
}

describe('buildReflectionText', () => {
  test('요청+결과를 작업 라벨과 함께 합친다', () => {
    const text = buildReflectionText('memo_create', '매주 월요일 회의 메모해줘', '메모를 생성했어.')
    expect(text).toContain('요청 [memo_create]: 매주 월요일 회의 메모해줘')
    expect(text).toContain('결과 [memo_create]: 메모를 생성했어.')
  })

  test('taskType 없으면 chat 기본값', () => {
    expect(buildReflectionText(undefined, '요청', '결과')).toContain('요청 [chat]: 요청')
  })

  test('요청만 있어도 텍스트 생성', () => {
    const text = buildReflectionText('summary', '요약해줘', '')
    expect(text).toContain('요청 [summary]: 요약해줘')
    expect(text).not.toContain('결과 [summary]:')
  })

  test('[LOCKED_BLOCK]은 문장 경계로 치환된다', () => {
    const text = buildReflectionText('chat', '', '찾았어. [LOCKED_BLOCK] 내일 10시에 회의가 있어.')
    expect(text).not.toContain('[LOCKED_BLOCK]')
    expect(text).toContain('내일 10시에 회의가 있어.')
  })

  test('둘 다 비면 빈 문자열', () => {
    expect(buildReflectionText('chat', '', '')).toBe('')
    expect(buildReflectionText(undefined, undefined, undefined)).toBe('')
  })
})

describe('isLlmReflectionEnabled', () => {
  test('true → true', async () => {
    expect(await isLlmReflectionEnabled({ DB: makeDb('true') } as any)).toBe(true)
  })
  test('false → false', async () => {
    expect(await isLlmReflectionEnabled({ DB: makeDb('false') } as any)).toBe(false)
  })
  test('행 없음 → false (기본 OFF)', async () => {
    expect(await isLlmReflectionEnabled({ DB: makeDb(null) } as any)).toBe(false)
  })
  test('조회 실패 → false', async () => {
    expect(await isLlmReflectionEnabled({ DB: makeDb('throw') } as any)).toBe(false)
  })
})
