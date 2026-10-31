/// <reference types="jest" />
import {
  NOVA_ROLE,
  NOVA_PRINCIPLES,
  NOVA_EXECUTION_POLICY,
  buildNovaPrompt,
} from '../../src/ai/prompts/nova'

describe('nova constants', () => {
  test('NOVA_ROLE is non-empty and mentions nova', () => {
    expect(typeof NOVA_ROLE).toBe('string')
    expect(NOVA_ROLE.length).toBeGreaterThan(0)
    expect(NOVA_ROLE).toContain('노바')
  })

  test('NOVA_PRINCIPLES contains 8 principles', () => {
    const lines = NOVA_PRINCIPLES.split('\n')
    expect(lines.length).toBe(8)
  })

  test('NOVA_EXECUTION_POLICY covers search markers and no-fabrication', () => {
    expect(NOVA_EXECUTION_POLICY).toContain('[SEARCH:')
    expect(NOVA_EXECUTION_POLICY).toContain('[GITHUB:')
    expect(NOVA_EXECUTION_POLICY).toContain('[MEMO_SEARCH]')
    expect(NOVA_EXECUTION_POLICY).toContain('승인 없는')
  })
})

describe('buildNovaPrompt', () => {
  test('includes role, principles and execution policy', () => {
    const prompt = buildNovaPrompt()
    expect(prompt).toContain(NOVA_ROLE)
    expect(prompt).toContain(NOVA_PRINCIPLES)
    expect(prompt).toContain(NOVA_EXECUTION_POLICY)
  })

  test('has 응답 원칙 section', () => {
    const prompt = buildNovaPrompt()
    expect(prompt).toContain('응답 원칙:')
  })

  test('sections are in order: role -> principles -> execution policy', () => {
    const prompt = buildNovaPrompt()
    const roleIdx = prompt.indexOf(NOVA_ROLE)
    const princIdx = prompt.indexOf('응답 원칙:')
    const policyIdx = prompt.indexOf('실행 관련 원칙:')
    expect(roleIdx).toBeLessThan(princIdx)
    expect(princIdx).toBeLessThan(policyIdx)
  })
})
