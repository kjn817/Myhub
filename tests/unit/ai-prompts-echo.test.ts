/// <reference types="jest" />
import {
  ECHO_ROLE,
  ECHO_PRINCIPLES,
  ECHO_TOOL_POLICY,
  buildEchoPrompt,
} from '../../src/ai/prompts/echo'

describe('echo constants', () => {
  test('ECHO_ROLE is non-empty and mentions echo', () => {
    expect(typeof ECHO_ROLE).toBe('string')
    expect(ECHO_ROLE.length).toBeGreaterThan(0)
    expect(ECHO_ROLE).toContain('에코')
  })

  test('ECHO_PRINCIPLES contains 7 principles', () => {
    const lines = ECHO_PRINCIPLES.split('\n')
    expect(lines.length).toBe(7)
    // fact vs inference distinction is the first principle
    expect(lines[0]).toContain('사실')
  })

  test('ECHO_TOOL_POLICY forbids fabricating records', () => {
    expect(ECHO_TOOL_POLICY).toContain('만들어내지')
    expect(ECHO_TOOL_POLICY).toContain('추측')
  })

  test('ECHO_TOOL_POLICY documents web search on explicit request (2026-10-21)', () => {
    expect(ECHO_TOOL_POLICY).toContain('[SEARCH: 검색어]')
    expect(ECHO_TOOL_POLICY).toContain('거부하지 마라')
  })
})

describe('buildEchoPrompt', () => {
  test('includes role, principles and tool policy', () => {
    const prompt = buildEchoPrompt()
    expect(prompt).toContain(ECHO_ROLE)
    expect(prompt).toContain(ECHO_PRINCIPLES)
    expect(prompt).toContain(ECHO_TOOL_POLICY)
  })

  test('has 응답 원칙 section', () => {
    const prompt = buildEchoPrompt()
    expect(prompt).toContain('응답 원칙:')
  })

  test('sections are in order: role -> principles -> policy', () => {
    const prompt = buildEchoPrompt()
    const roleIdx = prompt.indexOf(ECHO_ROLE)
    const princIdx = prompt.indexOf('응답 원칙:')
    const policyIdx = prompt.indexOf('메모 처리 원칙:')
    expect(roleIdx).toBeLessThan(princIdx)
    expect(princIdx).toBeLessThan(policyIdx)
  })
})
