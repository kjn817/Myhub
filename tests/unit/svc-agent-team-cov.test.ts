/// <reference types="jest" />
/**
 * 그룹 F 커버리지 보강 — src/services/agent-team.ts
 * - 기존 tests/agent-team.test.ts에서 다루지 않은 미커버 라인:
 *   라우터 예외 시 concierge 폴백(175/210), 0단계 메시지 교체 분기(265-266),
 *   실행 로그 훅(360-365), 빈 계획 폴백 문구(352)
 */
import {
  planTeam,
  runTeam,
  type TeamDeps,
  type TeamPlan,
} from '../../src/services/agent-team'

function fakeCallAssistant(
  calls: Array<{ personaId: string; messages: any[] }>,
  replies: Record<string, string>,
) {
  return async (personaId: string, messages: any[]) => {
    calls.push({ personaId, messages })
    return { text: replies[personaId] ?? `(${personaId} 응답)` }
  }
}

function baseDeps(calls: Array<{ personaId: string; messages: any[] }>): TeamDeps {
  return {
    callAssistant: fakeCallAssistant(calls, {
      concierge: '루미 답변',
      keeper: '에코 답변',
      builder: '노바 답변',
      scheduler: '캘리 답변',
    }),
  }
}

// ---------------- planTeam — 라우터 예외 폴백 (175/210) ----------------

describe('planTeam — 라우터 예외 시 concierge 폴백', () => {
  const throwingRouter = {
    route: async (): Promise<never> => { throw new Error('router down') },
  }

  test('다절 요청: 절마다 concierge로 폴백해 연속 동일 비서로 병합 (175)', async () => {
    const plan = await planTeam('메모 요약해줘 그리고 내일 일정 알려줘', throwingRouter as any)
    expect(plan.split).toBe(true)
    expect(plan.needsTeam).toBe(false)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].personaId).toBe('concierge')
    // 연속 동일 비서는 한 단계로 병합된다
    expect(plan.steps[0].clause).toBe('메모 요약해줘 그리고 내일 일정 알려줘')
    expect(plan.reason).toBe('single:same-persona')
  })

  test('단일 절 요청: concierge 단일 단계 (210)', async () => {
    const plan = await planTeam('메모 요약해줘', throwingRouter as any)
    expect(plan.needsTeam).toBe(false)
    expect(plan.split).toBe(false)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].personaId).toBe('concierge')
    expect(plan.reason).toBe('single:router-error')
  })
})

// ---------------- messagesForStep — 0단계 메시지 교체 (265-266) ----------------

describe('runTeam — 0단계 메시지 처리 (265-266)', () => {
  test('메시지가 없으면 단계 절을 사용자 메시지로 추가', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const plan = await planTeam('안녕')
    expect(plan.split).toBe(false)
    expect(plan.steps[0].focus).toBeUndefined()
    const result = await runTeam(baseDeps(calls), plan, [], 1)
    expect(result.participants).toEqual(['concierge'])
    expect(calls).toHaveLength(1)
    expect(calls[0].messages).toEqual([{ role: 'user', content: '안녕' }])
    expect(result.text).toContain('루미 답변')
  })

  test('마지막 메시지가 assistant면 단계 절을 뒤에 추가', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const plan = await planTeam('안녕')
    const messages = [{ role: 'assistant', content: '이전 답변입니다' }]
    const result = await runTeam(baseDeps(calls), plan, messages, 1)
    expect(result.participants).toEqual(['concierge'])
    expect(calls).toHaveLength(1)
    expect(calls[0].messages).toEqual([
      { role: 'assistant', content: '이전 답변입니다' },
      { role: 'user', content: '안녕' },
    ])
    // 원본 메시지 배열은 바꾸지 않는다 (복사본에 추가)
    expect(messages).toHaveLength(1)
  })
})

// ---------------- runTeam — 실행 로그 훅 (360-365) ----------------

describe('runTeam — deps.log 훅', () => {
  test('완료 시 로그에 대화·결정·참여자·성공이 기록된다', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const log = jest.fn().mockResolvedValue(undefined)
    const plan = await planTeam('메모 요약해줘 그리고 내일 일정 알려줘')
    const messages = [{ role: 'user', content: '메모 요약해줘 그리고 내일 일정 알려줘' }]
    const result = await runTeam({ ...baseDeps(calls), log }, plan, messages, 42)
    expect(result.text).toContain('계획 2개 중 2개 완료')
    expect(log).toHaveBeenCalledTimes(1)
    const entry = log.mock.calls[0][0]
    expect(entry.conversationId).toBe(42)
    expect(entry.userText).toBe('메모 요약해줘 그리고 내일 일정 알려줘')
    expect(entry.decision.primary).toBe('keeper')
    expect(entry.participants).toEqual(['keeper', 'scheduler'])
    expect(entry.success).toBe(true)
    expect(typeof entry.latencyMs).toBe('number')
  })

  test('로그 실패해도 실행 결과는 그대로 반환된다', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const log = jest.fn().mockRejectedValue(new Error('log down'))
    const plan = await planTeam('메모 요약해줘 그리고 내일 일정 알려줘')
    const messages = [{ role: 'user', content: '메모 요약해줘 그리고 내일 일정 알려줘' }]
    const result = await runTeam({ ...baseDeps(calls), log }, plan, messages, 1)
    expect(result.text).toContain('에코 답변')
    expect(result.participants).toEqual(['keeper', 'scheduler'])
    expect(log).toHaveBeenCalledTimes(1)
  })

  test('실패로 중단되면 success=false로 기록된다', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const log = jest.fn().mockResolvedValue(undefined)
    const failingDeps: TeamDeps = {
      callAssistant: async (personaId: string, messages: any[]) => {
        calls.push({ personaId, messages })
        throw new Error('모델 호출 실패')
      },
      log,
    }
    const plan = await planTeam('메모 요약해줘 그리고 내일 일정 알려줘')
    const result = await runTeam(failingDeps, plan, [{ role: 'user', content: 'x' }], 1)
    expect(result.stoppedEarly).toBe(true)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0].success).toBe(false)
  })
})

// ---------------- runTeam — 빈 계획 폴백 (352) ----------------

describe('runTeam — 빈 계획', () => {
  test('단계가 없으면 폴백 문구 + primary는 concierge', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const emptyPlan: TeamPlan = {
      needsTeam: false, split: false, steps: [], truncated: false, reason: 'empty',
    }
    const result = await runTeam(baseDeps(calls), emptyPlan, [{ role: 'user', content: '안녕' }], 1)
    expect(result.text).toBe('요청을 처리하지 못했습니다. 다시 시도해 주세요.')
    expect(result.primaryId).toBe('concierge')
    expect(result.participants).toEqual([])
    expect(result.responses).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

// ---------------- 추가 브랜치 보강 (2차) ----------------

describe('planTeam — 알 수 없는 비서 ID (124/129/162)', () => {
  test('라우터가 모르는 비서를 반환하면 focus 없음 + 기본 기대 결과', async () => {
    const weirdRouter = {
      route: async () => ({
        primary: 'bogus-primary', collaborator: 'bogus-collab', reason: 'test', confidence: 1,
      }),
    }
    const plan = await planTeam('회의 등록하고 요약해줘', weirdRouter as any)
    expect(plan.needsTeam).toBe(true)
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0].expectedOutcome).toBe('요청 처리 결과가 담긴 답변')
    expect(plan.steps[1].focus).toBeUndefined()
    expect(plan.steps[1].expectedOutcome).toBe('요청 처리 결과가 담긴 답변')
  })
})

describe('runTeam — messagesForStep 추가 분기', () => {
  test('절 분리 계획인데 사용자 메시지가 전혀 없으면 절을 추가 (255)', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const plan = await planTeam('메모 요약해줘 그리고 내일 일정 알려줘')
    expect(plan.split).toBe(true)
    const messages = [{ role: 'assistant', content: '이전 답변입니다' }]
    const result = await runTeam(baseDeps(calls), plan, messages, 1)
    expect(result.participants).toEqual(['keeper', 'scheduler'])
    expect(calls[0].messages).toEqual([
      { role: 'assistant', content: '이전 답변입니다' },
      { role: 'user', content: '메모 요약해줘' },
    ])
  })

  test('단일 단계가 실패하면 남은 단계 없음 + 빈 텍스트 폴백 (329/330)', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const failingDeps: TeamDeps = {
      callAssistant: async (personaId: string, messages: any[]) => {
        calls.push({ personaId, messages })
        throw new Error('모델 호출 실패')
      },
    }
    const plan = await planTeam('메모 요약해줘')
    expect(plan.steps).toHaveLength(1)
    const result = await runTeam(failingDeps, plan, [{ role: 'user', content: '메모 요약해줘' }], 1)
    expect(result.stoppedEarly).toBe(true)
    expect(result.text).toMatch(/^계획 1개 중 0개 완료\.\n\n/)
    expect(result.text).toContain('실패했습니다')
    expect(result.text).not.toContain('남은')
  })

  test('단일 파괴적 단계 스킵 시 빈 텍스트 + 안내만 (345/347)', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const plan = await planTeam('메모 삭제해줘')
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].needsApproval).toBe(true)
    const result = await runTeam(baseDeps(calls), plan, [{ role: 'user', content: '메모 삭제해줘' }], 1)
    expect(result.skipped).toHaveLength(1)
    expect(result.text).toBe(
      '계획 1개 중 0개 완료.\n\n다음 단계는 처리하지 못했습니다:\n- keeper 단계(메모 삭제해줘): 승인이 필요해 실행하지 않았습니다',
    )
    expect(calls).toHaveLength(0)
  })
})

// ---------------- 추가 브랜치 보강 (3차) ----------------

describe('planTeam — null 입력 (162)', () => {
  test('null/undefined 입력 → 빈 계획', async () => {
    expect(await planTeam(null as any)).toEqual({
      needsTeam: false, split: false, steps: [], truncated: false, reason: 'empty',
    })
    expect(await planTeam(undefined as any)).toEqual({
      needsTeam: false, split: false, steps: [], truncated: false, reason: 'empty',
    })
  })
})

describe('runTeam — 실패 시 기존 응답 유지 (333)', () => {
  test('1단계 성공 후 2단계 실패 → 성공 응답 + 실패 안내가 함께 붙는다', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const deps: TeamDeps = {
      callAssistant: async (personaId: string, messages: any[]) => {
        calls.push({ personaId, messages })
        if (personaId === 'scheduler') throw new Error('일정 모델 실패')
        return { text: '에코 답변' }
      },
    }
    const plan = await planTeam('메모 요약해줘 그리고 내일 일정 알려줘')
    expect(plan.steps).toHaveLength(2)
    const result = await runTeam(deps, plan, [{ role: 'user', content: '메모 요약해줘 그리고 내일 일정 알려줘' }], 1)
    expect(result.stoppedEarly).toBe(true)
    expect(result.text).toContain('계획 2개 중 1개 완료.')
    expect(result.text).toContain('에코 답변')
    expect(result.text).toContain('scheduler 단계(내일 일정 알려줘)가 3회 시도 후에도 실패했습니다')
    // 실패한 단계가 마지막 단계라 남은 단계 문구는 붙지 않는다
    expect(result.text).not.toContain('남은')
  })
})
