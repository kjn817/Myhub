/// <reference types="jest" />
/**
 * src/services/agent-team-clef.ts — 팀 계획에 대한 Clef 자문 성질 테스트.
 *
 * 실제 routeMessage/classifyIntent 파이프라인에 가짜 Clef 응답을 넣어
 * 검증한다 (라우터 자체를 목으로 대체하지 않는다). 고정하는 성질:
 * - off·무호출 조건에서는 절대 자문하지 않고 결정 로그도 남기지 않는다.
 * - shadow 모드는 판정을 기록만 하고 팀 계획을 절대 바꾸지 않는다.
 * - active 적용은 G5 안전 구간(top≥0.90 등)을 통과하고, Clef가 고른
 *   비서가 이미 계획 안에 있을 때만 일어난다 (계획 밖 비서로 못 바꾼다).
 * - 명시 멘션·워크플로 잠금 같은 규칙 경로는 Clef 판정이 아니므로
 *   게이트 면제지만, 사유에 exempt- 접두사로 구분해 남긴다.
 * - 내부 오류가 나면 자문 실패로 떨어지고 팀 계획은 Clef 없이 진행된다.
 * 카나리아: G5 게이트 적용 조건을 무력화하면 실패한다.
 */
import { consultClefForTeamPlan } from '../../src/services/agent-team-clef'
import type { TeamDeps, TeamPlan } from '../../src/services/agent-team'

const PROBS = {
  // top 0.95 / margin 0.93 — 라우팅·G5 안전 구간 모두 통과
  strongCode: { chat: 0.02, summarize: 0.01, code: 0.95, schedule: 0.01, unclear: 0.01 },
  // top 0.85 — 라우팅 하한(0.70)은 넘지만 G5 안전 구간(0.90) 미달
  midCode: { chat: 0.05, summarize: 0.02, code: 0.85, schedule: 0.04, unclear: 0.04 },
  // top 0.90 정확히 — G5 경계
  boundaryCode: { chat: 0.04, summarize: 0.03, code: 0.9, schedule: 0.02, unclear: 0.01 },
  strongSummarize: { chat: 0.01, summarize: 0.95, code: 0.02, schedule: 0.01, unclear: 0.01 },
  // top 0.30 — 라우팅 하한 미달 → low_confidence 폴백
  flat: { chat: 0.3, summarize: 0.25, code: 0.2, schedule: 0.15, unclear: 0.1 },
}

function invokerReturning(probs: Record<string, number>, noul = 0.1) {
  const choice = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0]
  return async () => ({
    answers: {
      assistant: { type: 'choice', choice, probabilities: probs },
      multiple_actions: { type: 'noul', noul },
    },
  })
}

function makePlan(personas: string[]): TeamPlan {
  return {
    needsTeam: false,
    split: false,
    truncated: false,
    reason: 'test-plan',
    steps: personas.map((personaId, i) => ({
      index: i,
      personaId,
      clause: '요청',
      expectedOutcome: '',
      verify: {},
      reason: 'test',
    })),
  } as unknown as TeamPlan
}

function makeDeps(over: Partial<TeamDeps> = {}, captured?: any[]): TeamDeps {
  return {
    callAssistant: async () => ({ text: 'ok' }),
    clefMode: 'active',
    clefInvoker: invokerReturning(PROBS.strongCode) as any,
    recordDecision: async (entry: any) => { captured?.push(entry); return {} },
    ...over,
  } as TeamDeps
}

const READ_CODE_MSG = '이 코드가 왜 이렇게 동작하는지 설명해줘'

// ---------------- 자문하지 않는 조건 ----------------

describe('consultClefForTeamPlan — 자문 생략 조건 (fail-safe)', () => {
  test('off 모드: 자문하지 않고 로그도 남기지 않는다', async () => {
    const captured: any[] = []
    const r = await consultClefForTeamPlan(makeDeps({ clefMode: 'off' }, captured), makePlan(['builder']), READ_CODE_MSG, [])
    expect(r.outcome.consulted).toBe(false)
    expect(r.outcome.mode).toBe('off')
    expect(r.primaryOverride).toBeNull()
    expect(captured).toHaveLength(0)
  })

  test('모드 미지정: useClefRouter=false면 off, true면 active로 도출된다', async () => {
    const off = await consultClefForTeamPlan(
      makeDeps({ clefMode: undefined, useClefRouter: false }), makePlan(['builder']), READ_CODE_MSG, [])
    expect(off.outcome.consulted).toBe(false)
    expect(off.outcome.mode).toBe('off')
    const on = await consultClefForTeamPlan(
      makeDeps({ clefMode: undefined, useClefRouter: true }), makePlan(['builder']), READ_CODE_MSG, [])
    expect(on.outcome.consulted).toBe(true)
    expect(on.outcome.mode).toBe('active')
  })

  test('명시 clefMode=off는 useClefRouter=true보다 우선한다', async () => {
    const r = await consultClefForTeamPlan(
      makeDeps({ clefMode: 'off', useClefRouter: true }), makePlan(['builder']), READ_CODE_MSG, [])
    expect(r.outcome.consulted).toBe(false)
  })

  test('호출 함수가 없거나, 빈 메시지거나, 계획 단계가 없으면 자문하지 않는다', async () => {
    const noInvoker = await consultClefForTeamPlan(makeDeps({ clefInvoker: undefined }), makePlan(['builder']), READ_CODE_MSG, [])
    expect(noInvoker.outcome.consulted).toBe(false)
    const empty = await consultClefForTeamPlan(makeDeps(), makePlan(['builder']), '   ', [])
    expect(empty.outcome.consulted).toBe(false)
    const noSteps = await consultClefForTeamPlan(makeDeps(), makePlan([]), READ_CODE_MSG, [])
    expect(noSteps.outcome.consulted).toBe(false)
    expect(noSteps.outcome.applied).toBe(false)
  })

  test('내부 오류(깨진 라우팅 컨텍스트)는 clef_error로 떨어지고 계획은 그대로 진행된다', async () => {
    const poisoned = { get lockedPersona(): string { throw new Error('ctx boom') } }
    const r = await consultClefForTeamPlan(
      makeDeps({ routeContext: poisoned as any }), makePlan(['builder']), READ_CODE_MSG, [])
    expect(r.outcome.consulted).toBe(false)
    expect(r.outcome.reason).toBe('clef_error:ctx boom')
    expect(r.primaryOverride).toBeNull()
  })
})

// ---------------- shadow 모드 ----------------

describe('consultClefForTeamPlan — shadow는 기록만, 적용은 없다', () => {
  test('강한 Clef 판정이어도 applied=false, 기준 비서로 기록된다', async () => {
    const captured: any[] = []
    const r = await consultClefForTeamPlan(
      makeDeps({ clefMode: 'shadow' }, captured), makePlan(['concierge', 'builder']), READ_CODE_MSG, [])
    expect(r.outcome.consulted).toBe(true)
    expect(r.outcome.applied).toBe(false)
    expect(r.outcome.mode).toBe('shadow')
    expect(r.outcome.choice).toBe('nova')
    expect(r.outcome.reason).toMatch(/^team:shadow:/)
    expect(r.primaryOverride).toBeNull()
    expect(captured).toHaveLength(1)
    expect(captured[0].kind).toBe('team_routing')
    expect(captured[0].mode).toBe('shadow')
    expect(captured[0].applied).toBe(false)
    expect(captured[0].servedPersona).toBe('concierge')
  })
})

// ---------------- active 모드와 G5 안전 구간 ----------------

describe('consultClefForTeamPlan — active 적용 조건', () => {
  test('안전 구간 통과 + 계획 안 비서: 적용되고 override가 돌아온다', async () => {
    const captured: any[] = []
    const r = await consultClefForTeamPlan(
      makeDeps({}, captured), makePlan(['concierge', 'builder']), READ_CODE_MSG, [])
    expect(r.outcome.consulted).toBe(true)
    expect(r.outcome.applied).toBe(true)
    expect(r.outcome.choice).toBe('nova')
    expect(r.outcome.top).toBeCloseTo(0.95)
    expect(r.outcome.source).toBe('clef')
    expect(r.outcome.gateReasons).toEqual([])
    expect(r.outcome.reason).toBe('team:clef_applied:classified')
    expect(r.primaryOverride).toEqual({ primary: 'builder', confidence: 0.95 })
    expect(captured[0].applied).toBe(true)
    expect(captured[0].servedPersona).toBe('builder')
  })

  test('top이 정확히 0.90이면 안전 구간 경계 통과로 적용된다', async () => {
    const r = await consultClefForTeamPlan(
      makeDeps({ clefInvoker: invokerReturning(PROBS.boundaryCode) as any }),
      makePlan(['builder']), READ_CODE_MSG, [])
    expect(r.outcome.top).toBeCloseTo(0.9)
    expect(r.outcome.applied).toBe(true)
    expect(r.primaryOverride?.primary).toBe('builder')
  })

  test('top 0.85: 라우팅은 되지만 G5 안전 구간 미달로 적용 금지 (fail-closed)', async () => {
    const r = await consultClefForTeamPlan(
      makeDeps({ clefInvoker: invokerReturning(PROBS.midCode) as any }),
      makePlan(['builder']), READ_CODE_MSG, [])
    expect(r.outcome.consulted).toBe(true)
    expect(r.outcome.applied).toBe(false)
    expect(r.outcome.gateReasons).toContain('top_below_safe')
    expect(r.outcome.reason).toBe('team:g5:top_below_safe')
    expect(r.primaryOverride).toBeNull()
  })

  test('쓰기 의도가 있는 메시지는 G5에서 write_intent로 차단된다', async () => {
    const r = await consultClefForTeamPlan(
      makeDeps({ clefInvoker: invokerReturning(PROBS.strongSummarize) as any }),
      makePlan(['keeper']), '메모 저장해줘', [])
    expect(r.outcome.applied).toBe(false)
    expect(r.outcome.gateReasons).toContain('write_intent')
    expect(r.outcome.reason).toBe('team:g5:write_intent')
  })

  test('Clef가 고른 비서가 계획에 없으면 적용하지 않는다 (계획 밖 변경 금지)', async () => {
    const r = await consultClefForTeamPlan(makeDeps(), makePlan(['concierge']), READ_CODE_MSG, [])
    expect(r.outcome.applied).toBe(false)
    expect(r.outcome.reason).toBe('team:clef_outside_plan:classified')
    expect(r.primaryOverride).toBeNull()
  })

  test('신뢰도가 낮으면 reply 결과로 떨어져 적용하지 않는다', async () => {
    const r = await consultClefForTeamPlan(
      makeDeps({ clefInvoker: invokerReturning(PROBS.flat) as any }),
      makePlan(['builder']), READ_CODE_MSG, [])
    expect(r.outcome.consulted).toBe(true)
    expect(r.outcome.applied).toBe(false)
    expect(r.outcome.choice).toBeNull()
    expect(r.outcome.reason).toBe('team:clef_reply:low_confidence')
  })

  test('결정 로그 기록이 실패해도 자문 결과는 그대로다', async () => {
    const r = await consultClefForTeamPlan(
      makeDeps({ recordDecision: async () => { throw new Error('db down') } }),
      makePlan(['builder']), READ_CODE_MSG, [])
    expect(r.outcome.applied).toBe(true)
    expect(r.primaryOverride?.primary).toBe('builder')
  })
})

// ---------------- 규칙 경로 면제 ----------------

describe('consultClefForTeamPlan — 규칙 경로는 게이트 면제, 사유로 구분', () => {
  test('명시 멘션(@노바)은 Clef 판정이 아니라 exempt-explicit로 적용된다', async () => {
    const r = await consultClefForTeamPlan(makeDeps(), makePlan(['builder']), '@노바 이 코드 설명해줘', [])
    expect(r.outcome.applied).toBe(true)
    expect(r.outcome.source).toBe('explicit')
    expect(r.outcome.reason).toBe('team:exempt-explicit:explicit_mention')
    expect(r.outcome.gateReasons).toEqual([])
    expect(r.primaryOverride?.primary).toBe('builder')
  })

  test('워크플로 잠금 비서는 exempt-rule로 적용된다', async () => {
    const r = await consultClefForTeamPlan(
      makeDeps({ routeContext: { lockedPersona: 'echo' } as any }),
      makePlan(['keeper']), '메모 찾아줘', [])
    expect(r.outcome.applied).toBe(true)
    expect(r.outcome.source).toBe('rule')
    expect(r.outcome.reason).toBe('team:exempt-rule:active_workflow_lock')
    expect(r.primaryOverride?.primary).toBe('keeper')
  })
})

// ---------------- G6 연동 기록 ----------------

describe('consultClefForTeamPlan — G6 섀도 기록 연동', () => {
  test('g6Mode=shadow면 팀 결정 로그 뒤에 g6_routing 로그가 함께 남는다', async () => {
    const captured: any[] = []
    const r = await consultClefForTeamPlan(
      makeDeps({ g6Mode: 'shadow' }, captured), makePlan(['concierge', 'builder']), READ_CODE_MSG, [])
    expect(r.outcome.applied).toBe(true)
    expect(captured).toHaveLength(2)
    expect(captured[0].kind).toBe('team_routing')
    expect(captured[1].kind).toBe('g6_routing')
    expect(captured[1].mode).toBe('g6_shadow')
    // 읽기 전용 단일 요청은 G6 범위 밖 — 그 사실이 사유에 실린다
    expect(captured[1].reason).toContain('g6_shadow:not_g6_scope')
    expect(captured[1].reason).toContain('risk=read')
    // 원장 연결: 팀 라우팅 traceId가 ledger로 실린다
    expect(captured[1].reason).toMatch(/^ledger:(?!none;)/)
  })

  test('g6Mode=off면 G6 로그는 남기지 않는다', async () => {
    const captured: any[] = []
    await consultClefForTeamPlan(makeDeps({ g6Mode: 'off' }, captured), makePlan(['builder']), READ_CODE_MSG, [])
    expect(captured).toHaveLength(1)
    expect(captured[0].kind).toBe('team_routing')
  })
})
