/// <reference types="jest" />
import {
  CALI_ROLE,
  CALI_PRINCIPLES,
  CALI_TOOL_POLICY,
  buildTimeContextSection,
  buildCaliPrompt,
  type TimeContext,
} from '../../src/ai/prompts/cali'

const SAMPLE_CTX: TimeContext = {
  nowIso: '2026-10-17T14:30:00+09:00',
  timezone: 'Asia/Seoul',
  todayLocal: '2026-10-17',
  weekStart: '2026-10-13',
}

describe('cali constants', () => {
  test('CALI_ROLE is non-empty and mentions cali', () => {
    expect(typeof CALI_ROLE).toBe('string')
    expect(CALI_ROLE.length).toBeGreaterThan(0)
    expect(CALI_ROLE).toContain('캘리')
  })

  test('CALI_PRINCIPLES contains 8 principles', () => {
    const lines = CALI_PRINCIPLES.split('\n')
    expect(lines.length).toBe(8)
    expect(lines[0]).toContain('추측')
  })

  test('CALI_TOOL_POLICY documents schedule/todo/memo tools', () => {
    expect(CALI_TOOL_POLICY).toContain('[SCHEDULE_LIST]')
    expect(CALI_TOOL_POLICY).toContain('[SCHEDULE_CREATE]')
    expect(CALI_TOOL_POLICY).toContain('[TODO_ADD]')
    // 번들 계약 (a2702ca4): 메모는 직접 검색이 아니라 에코 질의, 반복
    // 자동화(CRON) 마커군이 원본이다. [MEMO_SEARCH]는 원본 캘리 정책에 없다.
    expect(CALI_TOOL_POLICY).toContain('[ASK:keeper]')
    expect(CALI_TOOL_POLICY).toContain('[CRON_CREATE]')
    expect(CALI_TOOL_POLICY).toContain('[CRON_TOGGLE]')
    expect(CALI_TOOL_POLICY).toContain('[CRON_DELETE]')
    expect(CALI_TOOL_POLICY).not.toContain('[MEMO_SEARCH]')
  })

  test('CALI_TOOL_POLICY documents web search marker (2026-10-21)', () => {
    expect(CALI_TOOL_POLICY).toContain('[SEARCH: 검색어]')
  })
})

describe('buildTimeContextSection', () => {
  test('renders all four fields', () => {
    const section = buildTimeContextSection(SAMPLE_CTX)
    expect(section).toContain('2026-10-17T14:30:00+09:00')
    expect(section).toContain('Asia/Seoul')
    expect(section).toContain('2026-10-17')
    expect(section).toContain('2026-10-13')
    expect(section).toContain('NOW_ISO')
    expect(section).toContain('TIMEZONE')
    expect(section).toContain('TODAY_LOCAL')
    expect(section).toContain('WEEK_START')
  })

  test('handles different timezones', () => {
    const ctx: TimeContext = {
      nowIso: '2026-01-01T00:00:00Z',
      timezone: 'UTC',
      todayLocal: '2026-01-01',
      weekStart: '2025-12-29',
    }
    const section = buildTimeContextSection(ctx)
    expect(section).toContain('UTC')
    expect(section).toContain('2026-01-01T00:00:00Z')
  })
})

describe('buildCaliPrompt', () => {
  test('includes role, principles and tool policy', () => {
    const prompt = buildCaliPrompt()
    expect(prompt).toContain(CALI_ROLE)
    expect(prompt).toContain(CALI_PRINCIPLES)
    expect(prompt).toContain(CALI_TOOL_POLICY)
    expect(prompt).toContain('응답 원칙:')
  })

  test('omits time section when no context given', () => {
    const prompt = buildCaliPrompt()
    expect(prompt).not.toContain('서버 시간 컨텍스트')
    expect(prompt).not.toContain('NOW_ISO')
  })

  test('includes time section when context given', () => {
    const prompt = buildCaliPrompt(SAMPLE_CTX)
    expect(prompt).toContain('서버 시간 컨텍스트')
    expect(prompt).toContain('2026-10-17T14:30:00+09:00')
  })

  test('time section appears after tool policy', () => {
    const prompt = buildCaliPrompt(SAMPLE_CTX)
    const policyIdx = prompt.indexOf('도구 사용:')
    const timeIdx = prompt.indexOf('서버 시간 컨텍스트')
    expect(timeIdx).toBeGreaterThan(policyIdx)
  })
})
