/// <reference types="jest" />

import { DEFAULT_BUDGET } from '../../src/ai/types'

describe('DEFAULT_BUDGET', () => {
  test('기본 예산 값이 정의되어 있다', () => {
    expect(DEFAULT_BUDGET.maxModelCalls).toBe(3)
    expect(DEFAULT_BUDGET.maxToolCalls).toBe(4)
    expect(DEFAULT_BUDGET.maxTotalInputTokens).toBe(8000)
    expect(DEFAULT_BUDGET.maxOutputTokensPerCall).toBe(1024)
    expect(DEFAULT_BUDGET.maxToolResultChars).toBe(1500)
    expect(DEFAULT_BUDGET.toolTimeoutMs).toBe(5000)
  })

  test('모든 필드가 양수', () => {
    expect(DEFAULT_BUDGET.maxModelCalls).toBeGreaterThan(0)
    expect(DEFAULT_BUDGET.maxToolCalls).toBeGreaterThan(0)
    expect(DEFAULT_BUDGET.maxTotalInputTokens).toBeGreaterThan(0)
    expect(DEFAULT_BUDGET.maxOutputTokensPerCall).toBeGreaterThan(0)
    expect(DEFAULT_BUDGET.maxToolResultChars).toBeGreaterThan(0)
    expect(DEFAULT_BUDGET.toolTimeoutMs).toBeGreaterThan(0)
  })
})
