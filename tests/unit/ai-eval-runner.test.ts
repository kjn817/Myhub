/// <reference types="jest" />

import { runMockEval, summarizeEval, type EvalResult } from '../../src/ai/eval-runner'

describe('runMockEval', () => {
  test('평가 케이스 실행', () => {
    const results = runMockEval()
    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBeGreaterThan(0)
  })

  test('각 결과에 caseId, personaId, passed, checks 포함', () => {
    const results = runMockEval()
    for (const r of results) {
      expect(r.caseId).toBeDefined()
      expect(r.personaId).toBeDefined()
      expect(typeof r.passed).toBe('boolean')
      expect(Array.isArray(r.checks)).toBe(true)
    }
  })

  test('prompt_composed 체크 포함', () => {
    const results = runMockEval()
    for (const r of results) {
      const composed = r.checks.find((c) => c.name === 'prompt_composed')
      expect(composed).toBeDefined()
    }
  })

  test('scheduler 케이스는 time_context_present 체크', () => {
    const results = runMockEval()
    const schedulerCases = results.filter((r) => r.personaId === 'scheduler')
    for (const r of schedulerCases) {
      const timeCheck = r.checks.find((c) => c.name === 'time_context_present')
      expect(timeCheck).toBeDefined()
    }
  })

  test('no_input_injection 체크는 항상 true', () => {
    const results = runMockEval()
    for (const r of results) {
      const injection = r.checks.find((c) => c.name === 'no_input_injection')
      expect(injection?.passed).toBe(true)
    }
  })
})

describe('summarizeEval', () => {
  test('빈 결과', () => {
    const summary = summarizeEval([])
    expect(summary.total).toBe(0)
    expect(summary.passed).toBe(0)
    expect(summary.failed).toEqual([])
    expect(summary.byPersona).toEqual({})
  })

  test('모두 통과', () => {
    const results: EvalResult[] = [
      { caseId: 'c1', personaId: 'keeper', passed: true, checks: [] },
      { caseId: 'c2', personaId: 'keeper', passed: true, checks: [] },
      { caseId: 'c3', personaId: 'scheduler', passed: true, checks: [] },
    ]
    const summary = summarizeEval(results)
    expect(summary.total).toBe(3)
    expect(summary.passed).toBe(3)
    expect(summary.failed).toEqual([])
    expect(summary.byPersona.keeper).toEqual({ total: 2, passed: 2 })
    expect(summary.byPersona.scheduler).toEqual({ total: 1, passed: 1 })
  })

  test('일부 실패', () => {
    const results: EvalResult[] = [
      { caseId: 'c1', personaId: 'keeper', passed: true, checks: [] },
      { caseId: 'c2', personaId: 'keeper', passed: false, checks: [] },
    ]
    const summary = summarizeEval(results)
    expect(summary.total).toBe(2)
    expect(summary.passed).toBe(1)
    expect(summary.failed).toEqual(['c2'])
    expect(summary.byPersona.keeper).toEqual({ total: 2, passed: 1 })
  })

  test('실제 runMockEval 결과 요약', () => {
    const results = runMockEval()
    const summary = summarizeEval(results)
    expect(summary.total).toBe(results.length)
    expect(summary.passed + summary.failed.length).toBe(summary.total)
  })
})
