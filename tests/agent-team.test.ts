/**
 * AgentTeams 코디네이터 테스트 (Octop 트랙 4-2)
 * - 기존 오케스트레이터 위에 얹음: 단일 요청은 orchestrate() 위임,
 *   복합 요청만 다단계 팀 루프.
 */
import {
  planTeam,
  runTeam,
  runTeamOrSingle,
  splitClauses,
  verifyStepResult,
  MAX_TEAM_STEPS,
  MAX_STEP_ATTEMPTS,
  MIN_STEP_RESULT_LENGTH,
  type TeamDeps,
  type TeamStep,
} from '../src/services/agent-team'

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

const MESSAGES = [{ role: 'user', content: '메모 요약해줘 그리고 내일 일정 알려줘' }]

describe('splitClauses', () => {
  test('접속사로 절 분리', () => {
    expect(splitClauses('메모 요약해줘 그리고 내일 일정 알려줘')).toEqual([
      '메모 요약해줘',
      '내일 일정 알려줘',
    ])
    expect(splitClauses('메모 요약해줘 또 코드 짜줘 이어서 일정 알려줘')).toEqual([
      '메모 요약해줘',
      '코드 짜줘',
      '일정 알려줘',
    ])
  })

  test('단일 요청은 1절', () => {
    expect(splitClauses('메모 요약해줘')).toEqual(['메모 요약해줘'])
  })

  test('단어 안의 "또"는 분리하지 않음 ("또다른")', () => {
    expect(splitClauses('또다른 메모 찾아줘')).toEqual(['또다른 메모 찾아줘'])
  })
})

describe('planTeam', () => {
  test('두 절·두 비서 → 팀 계획', async () => {
    const plan = await planTeam('메모 요약해줘 그리고 내일 일정 알려줘')
    expect(plan.needsTeam).toBe(true)
    expect(plan.split).toBe(true)
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0].personaId).toBe('keeper')
    expect(plan.steps[1].personaId).toBe('scheduler')
    expect(plan.steps[0].clause).toBe('메모 요약해줘')
    expect(plan.steps[1].clause).toBe('내일 일정 알려줘')
  })

  test('각 단계에 기대 결과·검증 조건이 명시됨 (Plan & Execute 계획 단계)', async () => {
    const plan = await planTeam('메모 요약해줘 그리고 내일 일정 알려줘')
    expect(plan.steps).toHaveLength(2)
    // 요약 단계: 기대 결과 + 구조 검증 조건
    expect(plan.steps[0].expectedOutcome).toContain('요약')
    expect(plan.steps[0].verify).toEqual({ kind: 'min_length', min: MIN_STEP_RESULT_LENGTH })
    // 일정 단계: 기대 결과
    expect(plan.steps[1].expectedOutcome).toContain('일정')
    expect(plan.steps[1].verify).toEqual({ kind: 'min_length', min: MIN_STEP_RESULT_LENGTH })
  })
  test('단일 절·단일 비서 → 팀 아님', async () => {
    const plan = await planTeam('메모 요약해줘')
    expect(plan.needsTeam).toBe(false)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].personaId).toBe('keeper')
  })

  test('단일 절이지만 다중 도메인(회의+요약) → 2단계 팀', async () => {
    // KeywordRouter는 builder→keeper→scheduler 순서로 첫 매치를 주 담당으로 삼음
    const plan = await planTeam('회의 등록하고 요약해줘')
    expect(plan.needsTeam).toBe(true)
    expect(plan.split).toBe(false)
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0].personaId).toBe('keeper')
    expect(plan.steps[1].personaId).toBe('scheduler')
    expect(plan.steps[1].focus).toBeTruthy()
  })

  test('연속 동일 비서 절은 병합', async () => {
    const plan = await planTeam('메모 요약해줘 그리고 메모 정리해줘')
    expect(plan.needsTeam).toBe(false)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].personaId).toBe('keeper')
  })

  test('4개 절은 3단계로 잘림', async () => {
    const plan = await planTeam(
      '메모 요약해줘 그리고 내일 일정 알려줘 그리고 코드 짜줘 그리고 메모 정리해줘',
    )
    expect(plan.steps.length).toBeLessThanOrEqual(MAX_TEAM_STEPS)
    expect(plan.truncated).toBe(true)
    expect(plan.needsTeam).toBe(true)
  })

  test('빈 입력은 팀 아님', async () => {
    const plan = await planTeam('   ')
    expect(plan.needsTeam).toBe(false)
    expect(plan.steps).toEqual([])
  })

  test('파괴적 절은 needsApproval (다른 비서 절과 분리된 경우)', async () => {
    const plan = await planTeam('메모 123 삭제해줘 그리고 내일 일정 알려줘')
    expect(plan.needsTeam).toBe(true)
    expect(plan.steps[0].personaId).toBe('keeper')
    expect(plan.steps[0].needsApproval).toBe(true)
    expect(plan.steps[1].needsApproval).toBe(false)
  })

  test('연속 동일 비서 절은 병합되고, 파괴적 동사가 있으면 병합 단계 전체가 승인 대상', async () => {
    const plan = await planTeam('메모 요약해줘 그리고 메모 123 삭제해줘')
    expect(plan.needsTeam).toBe(false)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].needsApproval).toBe(true)
  })
})

describe('verifyStepResult', () => {
  const step = (verify: TeamStep['verify']): TeamStep => ({
    index: 0,
    personaId: 'keeper',
    clause: '메모 요약해줘',
    reason: 'test',
    needsApproval: false,
    expectedOutcome: '요약 결과가 담긴 답변',
    verify,
  })

  test('min_length: 빈 응답·한 글자 응답은 실패, 그 이상은 성공', () => {
    const s = step({ kind: 'min_length', min: MIN_STEP_RESULT_LENGTH })
    expect(verifyStepResult(s, '')).toEqual({ ok: false, reason: 'too_short:0<2' })
    expect(verifyStepResult(s, ' ').ok).toBe(false)
    expect(verifyStepResult(s, 'x').ok).toBe(false)
    expect(verifyStepResult(s, 'ok').ok).toBe(true)
  })

  test('non_empty: 공백만 있으면 실패', () => {
    const s = step({ kind: 'non_empty' })
    expect(verifyStepResult(s, '   ').ok).toBe(false)
    expect(verifyStepResult(s, '답변').ok).toBe(true)
  })

  test('contains_any: 기대 키워드 중 하나라도 있으면 성공', () => {
    const s = step({ kind: 'contains_any', keywords: ['요약', '정리'] })
    expect(verifyStepResult(s, '메모를 정리했습니다').ok).toBe(true)
    expect(verifyStepResult(s, '관련 메모가 없습니다').ok).toBe(false)
    expect(verifyStepResult(s, '메모를 정리했습니다').reason).toBeUndefined()
    expect(verifyStepResult(s, '관련 메모가 없습니다').reason).toBe('missing_expected_content')
  })
})

describe('runTeam', () => {
  test('단계를 순차 실행하고 이전 결과를 다음 단계에 전달', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const plan = await planTeam('메모 요약해줘 그리고 내일 일정 알려줘')
    const result = await runTeam(baseDeps(calls), plan, MESSAGES, 1)

    expect(result.participants).toEqual(['keeper', 'scheduler'])
    expect(result.primaryId).toBe('keeper')
    expect(result.text).toContain('에코 답변')
    expect(result.text).toContain('캘리 답변')
    expect(calls).toHaveLength(2)
    // 1단계는 절로 교체된 사용자 메시지를 받음
    expect(calls[0].messages[calls[0].messages.length - 1].content).toBe('메모 요약해줘')
    // 2단계는 1단계 결과를 컨텍스트로 받음
    const secondTexts = JSON.stringify(calls[1].messages)
    expect(secondTexts).toContain('에코 답변')
    expect(calls[1].messages[calls[1].messages.length - 1].content).toBe('내일 일정 알려줘')
  })

  test('단일 절 다중 도메인: 0단계는 원본 메시지를 그대로 받고, 1단계는 이전 결과+담당 범위를 받음', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const messages = [{ role: 'user', content: '회의 등록하고 요약해줘' }]
    const plan = await planTeam('회의 등록하고 요약해줘')
    expect(plan.needsTeam).toBe(true)
    const result = await runTeam(baseDeps(calls), plan, messages, 1)
    expect(result.participants).toEqual(['keeper', 'scheduler'])
    // 0단계: 마지막 사용자 메시지가 이미 요청이므로 중복 추가 없음
    const firstUserMsgs = calls[0].messages.filter((m) => m.role === 'user')
    expect(firstUserMsgs).toHaveLength(1)
    expect(firstUserMsgs[0].content).toBe('회의 등록하고 요약해줘')
    // 1단계: 이전 결과 컨텍스트 + 담당 범위 안내 포함
    const secondTexts = JSON.stringify(calls[1].messages)
    expect(secondTexts).toContain('에코 답변')
    expect(secondTexts).toContain('일정·할 일')
  })

  test('승인 없는 파괴적 단계는 스킵되고 안내 문구가 붙음', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const plan = await planTeam('메모 123 삭제해줘 그리고 내일 일정 알려줘')
    const result = await runTeam(baseDeps(calls), plan, MESSAGES, 1)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].reason).toBe('approval_required')
    expect(result.text).toContain('승인이 필요해 실행하지 않았습니다')
    expect(calls).toHaveLength(1) // 삭제 단계는 호출 안 함
    expect(calls[0].personaId).toBe('scheduler')
  })

  test('승인 확인기가 true면 파괴적 단계도 실행', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const plan = await planTeam('메모 123 삭제해줘 그리고 내일 일정 알려줘')
    const deps = baseDeps(calls)
    deps.approvalChecker = async () => true
    const result = await runTeam(deps, plan, MESSAGES, 1)
    expect(result.skipped).toHaveLength(0)
    expect(calls).toHaveLength(2)
  })

  test('한 단계가 재시도(2회) 후에도 실패하면 중단하고 정직하게 보고 (조용한 실패 금지)', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const deps = baseDeps(calls)
    deps.callAssistant = async (personaId: string, messages: any[]) => {
      calls.push({ personaId, messages })
      if (personaId === 'keeper') throw new Error('boom')
      return { text: '캘리 답변' }
    }
    const plan = await planTeam('메모 요약해줘 그리고 내일 일정 알려줘')
    const result = await runTeam(deps, plan, MESSAGES, 1)
    // keeper 단계만 3회 시도(최초 1회 + 재시도 2회)하고 중단 — scheduler는 호출 안 함
    expect(calls).toHaveLength(MAX_STEP_ATTEMPTS)
    expect(calls.every((c) => c.personaId === 'keeper')).toBe(true)
    expect(result.participants).toEqual([])
    expect(result.stoppedEarly).toBe(true)
    expect(result.progress).toEqual({ total: 2, completed: 0, skipped: 0, failed: 1, done: true })
    expect(result.stepResults).toHaveLength(1)
    expect(result.stepResults[0]).toMatchObject({ status: 'failed', attempts: MAX_STEP_ATTEMPTS, reason: 'boom' })
    // 실패 보고: 진행 상황 + 시도 횟수 + 중단 사실이 텍스트에 그대로 드러남
    expect(result.text).toContain('계획 2개 중 0개 완료')
    expect(result.text).toContain('3회 시도 후에도 실패했습니다')
    expect(result.text).toContain('남은 1개 단계는 실행하지 않았습니다')
    expect(result.text).not.toContain('캘리 답변')
  })

  test('한 단계가 1회 실패 후 재시도로 성공하면 계속 진행', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const deps = baseDeps(calls)
    let keeperCalls = 0
    deps.callAssistant = async (personaId: string, messages: any[]) => {
      calls.push({ personaId, messages })
      if (personaId === 'keeper') {
        keeperCalls++
        if (keeperCalls === 1) throw new Error('transient')
        return { text: '에코 요약 답변입니다' }
      }
      return { text: '캘리 일정 답변입니다' }
    }
    const plan = await planTeam('메모 요약해줘 그리고 내일 일정 알려줘')
    const result = await runTeam(deps, plan, MESSAGES, 1)
    expect(result.participants).toEqual(['keeper', 'scheduler'])
    expect(result.stoppedEarly).toBe(false)
    expect(result.progress).toEqual({ total: 2, completed: 2, skipped: 0, failed: 0, done: true })
    expect(result.stepResults[0]).toMatchObject({ status: 'completed', attempts: 2 })
    expect(result.stepResults[1]).toMatchObject({ status: 'completed', attempts: 1 })
    expect(result.text).toContain('계획 2개 중 2개 완료')
    expect(calls).toHaveLength(3)
  })

  test('검증 실패(빈 응답)도 재시도하고, 재시도 끝에 유효 응답이면 성공', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const deps = baseDeps(calls)
    let keeperCalls = 0
    deps.callAssistant = async (personaId: string, messages: any[]) => {
      calls.push({ personaId, messages })
      if (personaId === 'keeper') {
        keeperCalls++
        if (keeperCalls <= 2) return { text: ' ' } // 빈 응답 2회
        return { text: '에코 요약 답변입니다' }
      }
      return { text: '캘리 일정 답변입니다' }
    }
    const plan = await planTeam('메모 요약해줘 그리고 내일 일정 알려줘')
    const result = await runTeam(deps, plan, MESSAGES, 1)
    expect(result.stoppedEarly).toBe(false)
    expect(result.stepResults[0]).toMatchObject({ status: 'completed', attempts: 3 })
    expect(result.text).toContain('에코 요약 답변입니다')
  })

  test('검증 실패가 계속되면 재시도 소진 후 중단 (사유에 verify_failed 포함)', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const deps = baseDeps(calls)
    deps.callAssistant = async (personaId: string, messages: any[]) => {
      calls.push({ personaId, messages })
      if (personaId === 'keeper') return { text: '' }
      return { text: '캘리 일정 답변입니다' }
    }
    const plan = await planTeam('메모 요약해줘 그리고 내일 일정 알려줘')
    const result = await runTeam(deps, plan, MESSAGES, 1)
    expect(calls).toHaveLength(MAX_STEP_ATTEMPTS)
    expect(result.stoppedEarly).toBe(true)
    expect(result.stepResults[0].reason).toMatch(/^verify_failed:/)
    expect(result.text).toContain('계획 2개 중 0개 완료')
  })

  test('진행 상황: 완료 시 progress·stepResults·진행 문구가 모두 제공됨', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const progressSeen: Array<{ total: number; completed: number }> = []
    const deps = baseDeps(calls)
    deps.onProgress = (p) => {
      progressSeen.push({ total: p.total, completed: p.completed })
    }
    const plan = await planTeam('메모 요약해줘 그리고 내일 일정 알려줘')
    const result = await runTeam(deps, plan, MESSAGES, 1)
    expect(result.progress).toEqual({ total: 2, completed: 2, skipped: 0, failed: 0, done: true })
    expect(result.stepResults.map((s) => s.status)).toEqual(['completed', 'completed'])
    expect(result.text.startsWith('계획 2개 중 2개 완료.')).toBe(true)
    expect(result.runId).toBeNull() // env 없음 → 기록 없음
    // 단계 경계마다 진행 콜백 호출 (1단계 완료 → 2단계 완료)
    expect(progressSeen).toEqual([
      { total: 2, completed: 1 },
      { total: 2, completed: 2 },
    ])
  })

  test('승인 스킵도 진행 상황에 반영되고 나머지 단계는 계속', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const plan = await planTeam('메모 123 삭제해줘 그리고 내일 일정 알려줘')
    const result = await runTeam(baseDeps(calls), plan, MESSAGES, 1)
    expect(result.progress).toEqual({ total: 2, completed: 1, skipped: 1, failed: 0, done: true })
    expect(result.stepResults[0]).toMatchObject({ status: 'skipped', attempts: 0, reason: 'approval_required' })
    expect(result.stepResults[1]).toMatchObject({ status: 'completed', attempts: 1 })
    expect(result.text).toContain('계획 2개 중 1개 완료')
    expect(result.text).toContain('승인이 필요해 실행하지 않았습니다')
  })
})

describe('runTeamOrSingle', () => {
  test('단일 요청은 기존 orchestrate()로 위임 (호출 1회)', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const result = await runTeamOrSingle(
      baseDeps(calls),
      '안녕',
      [{ role: 'user', content: '안녕' }],
      1,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].personaId).toBe('concierge')
    expect(result.primaryId).toBe('concierge')
    expect(result.text).toBe('루미 답변')
  })

  test('복합 요청은 팀 루프 (호출 2회, 비서 2명)', async () => {
    const calls: Array<{ personaId: string; messages: any[] }> = []
    const result = await runTeamOrSingle(baseDeps(calls), '메모 요약해줘 그리고 내일 일정 알려줘', MESSAGES, 1)
    expect(calls).toHaveLength(2)
    expect(result.participants).toEqual(['keeper', 'scheduler'])
  })
})
