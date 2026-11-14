/// <reference types="jest" />

/**
 * B-L3: FC 검증기 3중복 통합 — 공용 코어 validateFCArgsBase + 래퍼 검증
 * - 코어: 미지 도구 → args 객체 → required → properties 타입(string/number/boolean)
 * - schedule 래퍼: 코어 통과 뒤 말미 3검사(title 비어 있지 않음·start_at/end_at ISO 형식)
 */

import { validateFCArgsBase } from '../../src/ai/fc-validate'
import type { FCToolDefinition } from '../../src/ai/memo-fc-tools'
import { validateFCArgs } from '../../src/ai/memo-fc-tools'
import { validateCronFCArgs } from '../../src/ai/cron-fc-tools'
import { validateScheduleFCArgs } from '../../src/ai/schedule-fc-tools'

const FAKE_TOOL: FCToolDefinition = {
  name: 'fake_tool',
  description: 'test tool',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'text' },
      count: { type: 'number', description: 'count' },
      flag: { type: 'boolean', description: 'flag' },
    },
    required: ['text'],
  },
}

const getFakeTool = (name: string) => (name === 'fake_tool' ? FAKE_TOOL : undefined)

describe('validateFCArgsBase 코어', () => {
  test('정상 인자는 valid', () => {
    expect(validateFCArgsBase(getFakeTool, 'fake_tool', { text: 'a', count: 1, flag: true }))
      .toEqual({ valid: true })
  })

  test('필수 인자만으로도 valid (선택 인자 생략 가능)', () => {
    expect(validateFCArgsBase(getFakeTool, 'fake_tool', { text: 'a' })).toEqual({ valid: true })
  })

  test('미지 도구는 invalid + 도구명 포함', () => {
    const r = validateFCArgsBase(getFakeTool, 'nope', { text: 'a' })
    expect(r.valid).toBe(false)
    expect(r.error).toContain('nope')
  })

  test('args가 객체가 아니면 invalid (null·문자열·undefined·숫자)', () => {
    for (const bad of [null, undefined, 'string', 42]) {
      expect(validateFCArgsBase(getFakeTool, 'fake_tool', bad).valid).toBe(false)
    }
  })

  test('필수 인자 누락은 invalid + 인자명 포함', () => {
    const r = validateFCArgsBase(getFakeTool, 'fake_tool', { count: 1 })
    expect(r.valid).toBe(false)
    expect(r.error).toContain('text')
  })

  test('string 타입 불일치는 invalid', () => {
    const r = validateFCArgsBase(getFakeTool, 'fake_tool', { text: 123 })
    expect(r.valid).toBe(false)
    expect(r.error).toContain('text')
  })

  test('number 타입 불일치는 invalid', () => {
    const r = validateFCArgsBase(getFakeTool, 'fake_tool', { text: 'a', count: '1' })
    expect(r.valid).toBe(false)
    expect(r.error).toContain('count')
  })

  test('boolean 타입 불일치는 invalid', () => {
    const r = validateFCArgsBase(getFakeTool, 'fake_tool', { text: 'a', flag: 'yes' })
    expect(r.valid).toBe(false)
    expect(r.error).toContain('flag')
  })

  test('정의에 없는 키는 무시한다 (원본 동작 유지)', () => {
    expect(validateFCArgsBase(getFakeTool, 'fake_tool', { text: 'a', extra: 1 }))
      .toEqual({ valid: true })
  })

  test('미지 도구 검사가 args 검사보다 먼저다', () => {
    const r = validateFCArgsBase(getFakeTool, 'nope', null)
    expect(r.valid).toBe(false)
    expect(r.error).toContain('Unknown tool')
  })
})

describe('래퍼 동작 동일성', () => {
  test('memo validateFCArgs: 정상 통과·미지 도구·타입 불일치', () => {
    expect(validateFCArgs('memo_create', { text: 'hello' }).valid).toBe(true)
    expect(validateFCArgs('unknown_tool', {}).valid).toBe(false)
    expect(validateFCArgs('memo_create', { text: 123 }).valid).toBe(false)
  })

  test('cron validateCronFCArgs: boolean 검사 유지', () => {
    expect(validateCronFCArgs('cron_set_enabled', { id: 1, enabled: true }).valid).toBe(true)
    expect(validateCronFCArgs('cron_set_enabled', { id: 1, enabled: 'yes' }).valid).toBe(false)
    expect(validateCronFCArgs('cron_create', { text: '매일 8시' }).valid).toBe(true)
    expect(validateCronFCArgs('cron_create', {}).valid).toBe(false)
  })
})

describe('schedule 말미 검사 (코어 통과 뒤 추가 검사)', () => {
  const ok = { title: '회의', start_at: '2026-11-20T15:00:00' }

  test('정상 인자 + end_at 생략은 valid', () => {
    expect(validateScheduleFCArgs('schedule_create', ok)).toEqual({ valid: true })
  })

  test('end_at이 올바른 ISO 형식이면 valid', () => {
    expect(validateScheduleFCArgs('schedule_create', { ...ok, end_at: '2026-11-20T16:00:00' }))
      .toEqual({ valid: true })
  })

  test('start_at 초 생략(YYYY-MM-DDTHH:MM)도 정규식이 허용한다', () => {
    expect(validateScheduleFCArgs('schedule_create', { ...ok, start_at: '2026-11-20T15:00' }))
      .toEqual({ valid: true })
  })

  test('title 빈 문자열은 invalid', () => {
    const r = validateScheduleFCArgs('schedule_create', { ...ok, title: '' })
    expect(r.valid).toBe(false)
    expect(r.error).toContain('title')
  })

  test('title 공백만 있는 문자열은 invalid', () => {
    const r = validateScheduleFCArgs('schedule_create', { ...ok, title: '   ' })
    expect(r.valid).toBe(false)
    expect(r.error).toContain('title')
  })

  test('start_at 자연어 형식은 invalid', () => {
    const r = validateScheduleFCArgs('schedule_create', { ...ok, start_at: '내일 오후 3시' })
    expect(r.valid).toBe(false)
    expect(r.error).toContain('start_at')
  })

  test('start_at 공백 구분자 형식은 invalid', () => {
    const r = validateScheduleFCArgs('schedule_create', { ...ok, start_at: '2026-11-20 15:00' })
    expect(r.valid).toBe(false)
    expect(r.error).toContain('start_at')
  })

  test('end_at 형식 오류는 invalid', () => {
    const r = validateScheduleFCArgs('schedule_create', { ...ok, end_at: '16:00' })
    expect(r.valid).toBe(false)
    expect(r.error).toContain('end_at')
  })

  test('end_at이 문자열이 아니면 invalid', () => {
    const r = validateScheduleFCArgs('schedule_create', { ...ok, end_at: 1600 })
    expect(r.valid).toBe(false)
    expect(r.error).toContain('end_at')
  })

  test('코어 실패(필수 누락)는 말미 검사 전에 invalid로 반환된다', () => {
    const r = validateScheduleFCArgs('schedule_create', { start_at: ok.start_at })
    expect(r.valid).toBe(false)
    expect(r.error).toContain('title')
  })
})
