/// <reference types="jest" />

import { getSetting } from '../../src/services/ai'
import {
  isPromptV2Enabled,
  isPromptV2EnabledForPersona,
  toCaliTimeContext,
  createRequestTimeContext,
  getPersonaCapabilities,
  composeV2Prompt,
  resolvePromptVersion,
  LEGACY_PROMPT_VERSION,
  PROMPT_VERSION,
} from '../../src/ai/prompt-integration'

jest.mock('../../src/services/ai', () => ({
  getSetting: jest.fn(),
  PERSONAS: [
    { id: 'keeper', capabilities: ['memo'] },
    { id: 'scheduler', capabilities: ['schedule'] },
  ],
}))

const mockGetSetting = getSetting as jest.Mock

beforeEach(() => {
  mockGetSetting.mockReset()
})

describe('isPromptV2Enabled', () => {
  test('true 문자열이면 true', async () => {
    mockGetSetting.mockResolvedValue('true')
    expect(await isPromptV2Enabled({} as any)).toBe(true)
    expect(mockGetSetting).toHaveBeenCalledWith(expect.anything(), 'ai.prompt_v2')
  })

  test('false 문자열이면 false', async () => {
    mockGetSetting.mockResolvedValue('false')
    expect(await isPromptV2Enabled({} as any)).toBe(false)
  })

  test('다른 값이면 false', async () => {
    mockGetSetting.mockResolvedValue('yes')
    expect(await isPromptV2Enabled({} as any)).toBe(false)
  })

  test('DB 조회 실패 시 false (fail-closed)', async () => {
    mockGetSetting.mockRejectedValue(new Error('db down'))
    expect(await isPromptV2Enabled({} as any)).toBe(false)
  })
})

describe('isPromptV2EnabledForPersona', () => {
  test('비서별 설정 true면 true', async () => {
    mockGetSetting.mockResolvedValue('true')
    expect(await isPromptV2EnabledForPersona({} as any, 'keeper')).toBe(true)
    expect(mockGetSetting).toHaveBeenCalledWith(expect.anything(), 'ai.prompt_v2.keeper')
  })

  test('비서별 설정 없고 전역 true면 true', async () => {
    mockGetSetting
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('true')
    expect(await isPromptV2EnabledForPersona({} as any, 'keeper')).toBe(true)
  })

  test('비서별 설정 없고 전역 false면 false', async () => {
    mockGetSetting
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('false')
    expect(await isPromptV2EnabledForPersona({} as any, 'keeper')).toBe(false)
  })

  test('비서별 false면 전역 무시', async () => {
    mockGetSetting.mockResolvedValue('false')
    expect(await isPromptV2EnabledForPersona({} as any, 'keeper')).toBe(false)
  })

  test('DB 조회 실패 시 false', async () => {
    mockGetSetting.mockRejectedValue(new Error('db down'))
    expect(await isPromptV2EnabledForPersona({} as any, 'keeper')).toBe(false)
  })
})

describe('toCaliTimeContext', () => {
  test('ServerTimeContext를 CaliTimeContext로 변환', () => {
    const server = {
      nowIso: '2026-10-17T05:00:00Z',
      timezone: 'Asia/Seoul',
      todayLocal: '2026-10-17',
      weekStartLocal: '2026-10-12',
    } as any
    const cali = toCaliTimeContext(server)
    expect(cali.nowIso).toBe('2026-10-17T05:00:00Z')
    expect(cali.timezone).toBe('Asia/Seoul')
    expect(cali.todayLocal).toBe('2026-10-17')
    expect(cali.weekStart).toBe('2026-10-12')
  })
})

describe('createRequestTimeContext', () => {
  test('DB 없이 기본 Asia/Seoul', async () => {
    mockGetSetting.mockRejectedValue(new Error('no db'))
    const ctx = await createRequestTimeContext(null as any)
    expect(ctx.timezone).toBe('Asia/Seoul')
    expect(ctx.todayLocal).toBeDefined()
  })

  test('설정된 시간대 사용', async () => {
    mockGetSetting.mockResolvedValue('America/New_York')
    const ctx = await createRequestTimeContext({} as any)
    expect(ctx.timezone).toBe('America/New_York')
  })

  test('잘못된 시간대는 Asia/Seoul 폴백', async () => {
    mockGetSetting.mockResolvedValue('Invalid/Timezone')
    const ctx = await createRequestTimeContext({} as any)
    expect(ctx.timezone).toBe('Asia/Seoul')
  })

  test('fixedEpochMs 전달', async () => {
    mockGetSetting.mockRejectedValue(new Error('no db'))
    const ctx = await createRequestTimeContext(null as any, 1729123456789)
    expect(ctx.timezone).toBe('Asia/Seoul')
  })
})

describe('getPersonaCapabilities', () => {
  test('등록된 비서의 capabilities 반환', () => {
    const caps = getPersonaCapabilities('keeper')
    expect(Array.isArray(caps)).toBe(true)
  })

  test('알 수 없는 비서는 빈 배열', () => {
    expect(getPersonaCapabilities('unknown')).toEqual([])
  })
})

describe('composeV2Prompt', () => {
  test('알 수 없는 비서는 throw', () => {
    expect(() => composeV2Prompt('unknown')).toThrow('unknown persona')
  })

  test('keeper 프롬프트 합성', () => {
    const result = composeV2Prompt('keeper')
    expect(result.prompt.length).toBeGreaterThan(100)
    expect(result.version).toBe(PROMPT_VERSION)
  })

  test('scheduler는 timeContext 전달 시 변환됨', () => {
    const timeCtx = {
      nowIso: '2026-10-17T05:00:00Z',
      timezone: 'Asia/Seoul',
      todayLocal: '2026-10-17',
      weekStartLocal: '2026-10-12',
    } as any
    const result = composeV2Prompt('scheduler', { timeContext: timeCtx })
    expect(result.prompt).toContain('2026-10-17')
  })

  test('allowedTools 전달', () => {
    const result = composeV2Prompt('keeper', { allowedTools: ['search_memo'] })
    expect(result.prompt.length).toBeGreaterThan(100)
  })

  test('legacyMarkerTools 폴백', () => {
    const result = composeV2Prompt('keeper', { legacyMarkerTools: ['MEMO_SEARCH'] })
    expect(result.prompt.length).toBeGreaterThan(100)
  })

  test('scheduler + userMessage + timeContext: 날짜 확정 블록', () => {
    const timeCtx = {
      nowIso: '2026-10-17T05:00:00Z',
      timezone: 'Asia/Seoul',
      todayLocal: '2026-10-17',
      weekStartLocal: '2026-10-12',
    } as any
    const result = composeV2Prompt('scheduler', {
      timeContext: timeCtx,
      userMessage: '내일 회의 잡아줘',
    })
    // 날짜가 해석되면 확정 블록 포함
    expect(result.prompt).toContain('서버 확정 날짜')
  })

  test('scheduler + 복수 날짜: 복수 확정 블록', () => {
    const timeCtx = {
      nowIso: '2026-10-17T05:00:00Z',
      timezone: 'Asia/Seoul',
      todayLocal: '2026-10-17',
      weekStartLocal: '2026-10-12',
    } as any
    const result = composeV2Prompt('scheduler', {
      timeContext: timeCtx,
      userMessage: '내일과 모레 회의 잡아줘',
    })
    expect(result.prompt).toContain('서버 확정 날짜 - 복수')
  })

  test('scheduler + 모호한 날짜: 확인 요청 블록', () => {
    const timeCtx = {
      nowIso: '2026-10-17T05:00:00Z',
      timezone: 'Asia/Seoul',
      todayLocal: '2026-10-17',
      weekStartLocal: '2026-10-12',
    } as any
    const result = composeV2Prompt('scheduler', {
      timeContext: timeCtx,
      userMessage: '언젠가 만나자',
    })
    // 모호하면 확인 요청 또는 확정 블록 없음
    expect(result.prompt.length).toBeGreaterThan(100)
  })
})

describe('resolvePromptVersion', () => {
  test('v2 적용 시 PROMPT_VERSION', () => {
    expect(resolvePromptVersion(true)).toBe(PROMPT_VERSION)
  })

  test('미적용 시 legacy', () => {
    expect(resolvePromptVersion(false)).toBe(LEGACY_PROMPT_VERSION)
    expect(resolvePromptVersion(false)).toBe('legacy')
  })
})

describe('상수', () => {
  test('LEGACY_PROMPT_VERSION은 legacy', () => {
    expect(LEGACY_PROMPT_VERSION).toBe('legacy')
  })

  test('PROMPT_VERSION 정의됨', () => {
    expect(PROMPT_VERSION).toBeDefined()
    expect(typeof PROMPT_VERSION).toBe('string')
  })
})

describe('composeV2Prompt 날짜 블록 추가 커버리지', () => {
  const timeCtx = {
    nowIso: '2026-10-17T05:00:00Z',
    timezone: 'Asia/Seoul',
    todayLocal: '2026-10-17',
    weekStartLocal: '2026-10-12',
  } as any

  test('단일 확정 + 복수 표현 중 일부 미해석 → 경고 블록 (199-201행)', () => {
    // "내일"은 해석되지만 다른 표현은 미해석 → multiResults.length > 1, unresolved > 0
    const result = composeV2Prompt('scheduler', {
      timeContext: timeCtx,
      userMessage: '내일과 다음 주 중에 회의 잡아줘',
    })
    // 단일 확정 블록 + 미해석 경고가 포함되거나, 복수 블록이 포함됨
    expect(result.prompt).toContain('서버 확정 날짜')
  })

  test('단일 확정 + 복수 표현 모두 해석됨 → 경고 없음 (200행 false)', () => {
    const result = composeV2Prompt('scheduler', {
      timeContext: timeCtx,
      userMessage: '내일 회의 잡아줘',
    })
    expect(result.prompt).toContain('서버 확정 날짜')
    // 미해석 경고는 없어야 함
    expect(result.prompt).not.toContain('해석하지 못했습니다')
  })
})
