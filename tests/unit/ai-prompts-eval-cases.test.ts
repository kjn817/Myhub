/// <reference types="jest" />
import {
  LUMI_CASES,
  ECHO_CASES,
  NOVA_CASES,
  CALI_CASES,
  ALL_EVAL_CASES,
  type EvalCase,
} from '../../src/ai/prompts/eval-cases'

const VALID_PERSONAS = ['concierge', 'keeper', 'builder', 'scheduler'] as const

function checkCaseShape(cases: EvalCase[], prefix: string) {
  const ids = new Set<string>()
  for (const c of cases) {
    expect(typeof c.id).toBe('string')
    expect(c.id.startsWith(prefix)).toBe(true)
    expect(ids.has(c.id)).toBe(false)
    ids.add(c.id)
    expect(VALID_PERSONAS).toContain(c.personaId)
    expect(typeof c.input).toBe('string')
    expect(c.input.length).toBeGreaterThan(0)
    expect(Array.isArray(c.expectations)).toBe(true)
    expect(c.expectations.length).toBeGreaterThan(0)
    for (const e of c.expectations) expect(typeof e).toBe('string')
    expect(Array.isArray(c.avoid)).toBe(true)
    expect(c.avoid.length).toBeGreaterThan(0)
    for (const a of c.avoid) expect(typeof a).toBe('string')
  }
}

describe('eval case datasets', () => {
  test('LUMI_CASES has 10 cases with lumi- prefix', () => {
    expect(LUMI_CASES.length).toBe(10)
    checkCaseShape(LUMI_CASES, 'lumi-')
  })

  test('ECHO_CASES has 10 cases with echo- prefix', () => {
    expect(ECHO_CASES.length).toBe(10)
    checkCaseShape(ECHO_CASES, 'echo-')
  })

  test('NOVA_CASES has 10 cases with nova- prefix', () => {
    expect(NOVA_CASES.length).toBe(10)
    checkCaseShape(NOVA_CASES, 'nova-')
  })

  test('CALI_CASES has 10 cases with cali- prefix', () => {
    expect(CALI_CASES.length).toBe(10)
    checkCaseShape(CALI_CASES, 'cali-')
  })

  test('ALL_EVAL_CASES is the concatenation of all 4 sets', () => {
    expect(ALL_EVAL_CASES.length).toBe(40)
    expect(ALL_EVAL_CASES).toEqual([
      ...LUMI_CASES,
      ...ECHO_CASES,
      ...NOVA_CASES,
      ...CALI_CASES,
    ])
  })

  test('all ids are unique across ALL_EVAL_CASES', () => {
    const ids = ALL_EVAL_CASES.map((c) => c.id)
    expect(new Set(ids).size).toBe(40)
  })

  test('personaId matches the dataset owner', () => {
    for (const c of LUMI_CASES) expect(c.personaId).toBe('concierge')
    for (const c of ECHO_CASES) expect(c.personaId).toBe('keeper')
    for (const c of NOVA_CASES) expect(c.personaId).toBe('builder')
    for (const c of CALI_CASES) expect(c.personaId).toBe('scheduler')
  })

  test('expectations and avoid lists do not overlap', () => {
    for (const c of ALL_EVAL_CASES) {
      for (const e of c.expectations) {
        expect(c.avoid).not.toContain(e)
      }
    }
  })
})
