/// <reference types="jest" />
import {
  LUMI_ROLE,
  LUMI_PRINCIPLES,
  LUMI_TOOL_POLICY,
  buildLumiPrompt,
} from '../../src/ai/prompts/lumi'

describe('lumi constants', () => {
  test('LUMI_ROLE is non-empty and mentions lumi', () => {
    expect(typeof LUMI_ROLE).toBe('string')
    expect(LUMI_ROLE.length).toBeGreaterThan(0)
    expect(LUMI_ROLE).toContain('루미')
  })

  test('LUMI_PRINCIPLES contains 7 principles', () => {
    const lines = LUMI_PRINCIPLES.split('\n')
    expect(lines.length).toBe(7)
  })

  test('LUMI_TOOL_POLICY covers no-tool greetings and marker usage', () => {
    expect(LUMI_TOOL_POLICY).toContain('안녕')
    expect(LUMI_TOOL_POLICY).toContain('[SCHEDULE_CREATE]')
    expect(LUMI_TOOL_POLICY).toContain('[TODO_ADD]')
    expect(LUMI_TOOL_POLICY).toContain('[MEMO_SEARCH]')
    expect(LUMI_TOOL_POLICY).toContain('[ASK:비서id]')
  })

  test('LUMI_TOOL_POLICY documents web search marker (2026-10-21)', () => {
    expect(LUMI_TOOL_POLICY).toContain('[SEARCH: 검색어]')
    expect(LUMI_TOOL_POLICY).toContain('[/SEARCH] 블록 형식은 절대 사용하지 마라')
  })
})

describe('buildLumiPrompt', () => {
  test('includes role, principles and tool policy', () => {
    const prompt = buildLumiPrompt()
    expect(prompt).toContain(LUMI_ROLE)
    expect(prompt).toContain(LUMI_PRINCIPLES)
    expect(prompt).toContain(LUMI_TOOL_POLICY)
  })

  test('has 응답 원칙 section', () => {
    const prompt = buildLumiPrompt()
    expect(prompt).toContain('응답 원칙:')
  })

  test('mentions delegation to other assistants', () => {
    const prompt = buildLumiPrompt()
    expect(prompt).toContain('keeper')
    expect(prompt).toContain('scheduler')
    expect(prompt).toContain('builder')
  })
})
