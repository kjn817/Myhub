/// <reference types="jest" />
/**
 * src/services/orchestrator.ts — 라우팅 컨텍스트·Clef 섀도/게이트·핸드오프 성질 테스트.
 * (svc3-orchestrator가 다루지 않는 분기 보강)
 *
 * 핵심 성질: ① buildRouteContext의 이전 메시지는 assistant를 제외한
 * 사용자 발화 중 뒤에서 두 번째이며, 명시 컨텍스트가 계산값보다 우선한다
 * ② Clef 섀도 모드는 실제 서빙을 레거시 라우터로 하면서 결정 로그에
 * applied=false로 남긴다 ③ G5 게이트가 막으면 레거시로 폴백하고
 * 사유를 결정·로그 양쪽에 남긴다 ④ 멘션·잠금 비서·쓰기 의도는 게이트
 * 사유가 된다 ⑤ 핸드오프 기록 실패는 협업을 막지 않는다.
 * 카나리아: 섀도 모드에서 decision을 Clef 결과로 바꾸거나
 * 게이트 폴백의 reason 접두를 지우면 실패한다.
 */
import {
  buildRouteContext,
  orchestrate,
  type OrchestratorDeps,
} from '../../src/services/orchestrator'

jest.mock('../../src/services/router', () => ({
  routeMessage: jest.fn(),
}))
jest.mock('../../src/services/persona-id-adapter', () => ({
  resolveClefRoute: jest.fn(),
}))

import { routeMessage } from '../../src/services/router'
import { resolveClefRoute } from '../../src/services/persona-id-adapter'

const routeMessageMock = routeMessage as jest.Mock
const resolveClefRouteMock = resolveClefRoute as jest.Mock

const makeDeps = (overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps => ({
  callAssistant: jest.fn().mockResolvedValue({ text: 'hello' }),
  ...overrides,
})

beforeEach(() => {
  jest.clearAllMocks()
})

describe('buildRouteContext', () => {
  test('메시지가 없거나 null이면 이전 메시지 없음 + 쓰기 의도 없음', () => {
    expect(buildRouteContext([], '안녕')).toEqual({
      previousPersona: undefined,
      previousMessage: undefined,
      lockedPersona: undefined,
      writeActionPossible: false,
    })
    expect(buildRouteContext(null as any, '안녕').previousMessage).toBeUndefined()
  })

  test('이전 메시지는 assistant를 뺀 발화 중 뒤에서 두 번째 (트림 적용)', () => {
    const messages = [
      { role: 'user', content: '  첫 질문  ' },
      { role: 'assistant', content: '답변' },
      { role: 'user', content: '둘째 질문' },
      { role: 'assistant', content: '답변2' },
      { role: 'user', content: '지금 질문' },
    ]
    const ctx = buildRouteContext(messages, '지금 질문')
    expect(ctx.previousMessage).toBe('둘째 질문')
  })

  test('사용자 발화가 1개뿐이면 이전 메시지는 없다', () => {
    expect(buildRouteContext([{ role: 'user', content: '유일' }], '유일').previousMessage).toBeUndefined()
  })

  test('비문자열·공백 발화와 null 항목은 세지 않는다', () => {
    const messages = [
      null,
      { role: 'user', content: 42 },
      { role: 'user', content: '   ' },
      { role: 'user', content: '실제 발화' },
    ]
    expect(buildRouteContext(messages as any, '실제 발화').previousMessage).toBeUndefined()
  })

  test('명시 컨텍스트가 계산값보다 우선하고, 미지정 필드만 계산값을 쓴다', () => {
    const messages = [
      { role: 'user', content: '이전 발화' },
      { role: 'user', content: '지금 발화' },
    ]
    const full = buildRouteContext(messages, '메모 저장해줘', {
      previousPersona: 'keeper' as any,
      previousMessage: '명시적 이전',
      lockedPersona: 'keeper' as any,
      writeActionPossible: false,
    })
    expect(full).toEqual({
      previousPersona: 'keeper',
      previousMessage: '명시적 이전',
      lockedPersona: 'keeper',
      writeActionPossible: false, // 쓰기 문장이어도 명시 false가 이긴다
    })
    const partial = buildRouteContext(messages, '메모 저장해줘', { lockedPersona: 'nova' as any })
    expect(partial.previousMessage).toBe('이전 발화')
    expect(partial.lockedPersona).toBe('nova')
    expect(partial.writeActionPossible).toBe(true) // 메모+저장 = 쓰기 의도
  })

  test('쓰기 의도는 대상+동사가 함께 있을 때만 성립한다', () => {
    expect(buildRouteContext([], '메모 보여줘').writeActionPossible).toBe(false)
    expect(buildRouteContext([], '내일 일정 알려줘').writeActionPossible).toBe(false)
    expect(buildRouteContext([], '메모 삭제해줘').writeActionPossible).toBe(true)
  })
})

describe('orchestrate — Clef 섀도 모드', () => {
  test('서빙은 레거시 라우터가 하고 결정 로그는 applied=false·shadow로 남는다', async () => {
    routeMessageMock.mockResolvedValue({
      traceId: 'tr-1', specHash: 'spec-x', persona: 'builder',
      probabilities: { builder: 0.7 }, confidence: 0.7, margin: 0.3, reason: 'clef-reason',
    })
    resolveClefRouteMock.mockReturnValue({ kind: 'dispatch', primary: 'builder', reason: 'r' })
    const recordDecision = jest.fn().mockResolvedValue(undefined)
    const deps = makeDeps({ clefMode: 'shadow', clefInvoker: jest.fn(), recordDecision })
    const result = await orchestrate(deps, '메모 찾아줘', [], 1)
    // 섀도: Clef가 builder를 골라도 실제 서빙은 레거시(메모→keeper)
    expect(result.primaryId).toBe('keeper')
    expect(recordDecision).toHaveBeenCalledTimes(1)
    const entry = recordDecision.mock.calls[0][0]
    expect(entry).toMatchObject({
      traceId: 'tr-1', kind: 'routing', specHash: 'spec-x',
      choice: 'builder', top: 0.7, margin: 0.3,
      applied: false, servedPersona: 'keeper', mode: 'shadow', reason: 'clef-reason',
    })
    expect(entry.probabilitiesJson).toBe(JSON.stringify({ builder: 0.7 }))
  })

  test('routeResult 필드가 비어 있으면 로그 기본값으로 채운다', async () => {
    routeMessageMock.mockResolvedValue({})
    resolveClefRouteMock.mockReturnValue({ kind: 'dispatch', primary: 'keeper', reason: 'r' })
    const recordDecision = jest.fn().mockResolvedValue(undefined)
    const deps = makeDeps({ clefMode: 'shadow', clefInvoker: jest.fn(), recordDecision })
    await orchestrate(deps, '안녕', [], 1)
    const entry = recordDecision.mock.calls[0][0]
    expect(entry.traceId).toMatch(/^shadow-/)
    expect(entry.specHash).toBe('unknown')
    expect(entry.choice).toBeNull()
    expect(entry.probabilitiesJson).toBeNull()
    expect(entry.top).toBeNull()
    expect(entry.reason).toBeNull()
  })

  test('recordDecision이 없어도 섀도 모드는 정상 동작한다', async () => {
    routeMessageMock.mockResolvedValue({ confidence: 0.5 })
    resolveClefRouteMock.mockReturnValue({ kind: 'dispatch', primary: 'keeper', reason: 'r' })
    const deps = makeDeps({ clefMode: 'shadow', clefInvoker: jest.fn() })
    const result = await orchestrate(deps, '메모 찾아줘', [], 1)
    expect(result.primaryId).toBe('keeper')
  })
})

describe('orchestrate — Clef reply + G6 기록', () => {
  test('reply outcome에서 G6 모드가 켜져 있으면 G6 결정까지 기록한다', async () => {
    routeMessageMock.mockResolvedValue({ traceId: 'tr-9', confidence: 0.3, persona: null })
    resolveClefRouteMock.mockReturnValue({ kind: 'reply', reason: 'low-confidence', message: '안내' })
    const recordDecision = jest.fn().mockResolvedValue(undefined)
    const log = jest.fn().mockResolvedValue(undefined)
    const deps = makeDeps({
      clefMode: 'active', clefInvoker: jest.fn(), recordDecision, g6Mode: 'shadow', log,
    })
    const result = await orchestrate(deps, '아무거나', [], 1)
    expect(result.primaryId).toBe('concierge')
    // 라우팅 로그 1 + G6 로그 1
    expect(recordDecision).toHaveBeenCalledTimes(2)
    const routingEntry = recordDecision.mock.calls[0][0]
    expect(routingEntry).toMatchObject({ mode: 'active', applied: false, servedPersona: 'concierge' })
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ success: true }))
  })

  test('G6가 꺼져 있으면 reply에서 라우팅 로그만 남는다', async () => {
    routeMessageMock.mockResolvedValue({ confidence: 0.3 })
    resolveClefRouteMock.mockReturnValue({ kind: 'reply', reason: 'x', message: 'm' })
    const recordDecision = jest.fn().mockResolvedValue(undefined)
    const deps = makeDeps({ clefMode: 'active', clefInvoker: jest.fn(), recordDecision })
    await orchestrate(deps, '아무거나', [], 1)
    expect(recordDecision).toHaveBeenCalledTimes(1)
  })
})

describe('orchestrate — Clef dispatch 게이트', () => {
  const dispatchTo = (primary: string) =>
    resolveClefRouteMock.mockReturnValue({ kind: 'dispatch', primary, reason: 'test-reason' })

  test('신뢰도가 낮으면 G5 게이트가 막고 레거시로 폴백하며 사유를 남긴다', async () => {
    routeMessageMock.mockResolvedValue({ traceId: 'tr-2', confidence: 0.5, margin: 0.1, persona: 'builder' })
    dispatchTo('builder')
    const recordDecision = jest.fn().mockResolvedValue(undefined)
    const deps = makeDeps({ clefMode: 'active', clefInvoker: jest.fn(), recordDecision })
    const result = await orchestrate(deps, '안녕', [], 1)
    expect(result.primaryId).toBe('concierge')
    expect(result.decision.reason).toBe('clef-g5-blocked:top_below_safe,margin_below_safe')
    const entry = recordDecision.mock.calls[0][0]
    expect(entry).toMatchObject({ applied: false, reason: 'g5:top_below_safe,margin_below_safe' })
  })

  test('멘션이 있으면 고신뢰여도 게이트가 막는다', async () => {
    routeMessageMock.mockResolvedValue({ confidence: 0.95, margin: 0.6, persona: 'builder' })
    dispatchTo('builder')
    const deps = makeDeps({ clefMode: 'active', clefInvoker: jest.fn() })
    const result = await orchestrate(deps, '@노바 코드 짜줘', [], 1)
    expect(result.decision.reason).toContain('clef-g5-blocked:')
    expect(result.decision.reason).toContain('mention')
  })

  test('잠금 비서가 걸려 있으면 게이트가 막는다', async () => {
    routeMessageMock.mockResolvedValue({ confidence: 0.95, margin: 0.6, persona: 'builder' })
    dispatchTo('builder')
    const deps = makeDeps({
      clefMode: 'active', clefInvoker: jest.fn(),
      routeContext: { lockedPersona: 'keeper' as any },
    })
    const result = await orchestrate(deps, '일반 질문입니다', [], 1)
    expect(result.decision.reason).toContain('locked_persona')
  })

  test('쓰기 의도 문장은 게이트 사유 write_intent로 막힌다', async () => {
    routeMessageMock.mockResolvedValue({ confidence: 0.95, margin: 0.6, persona: 'keeper' })
    dispatchTo('keeper')
    const deps = makeDeps({ clefMode: 'active', clefInvoker: jest.fn() })
    const result = await orchestrate(deps, '메모 저장해줘', [], 1)
    expect(result.decision.reason).toContain('write_intent')
  })

  test('needsHistory면 이력 맥락 시스템 메시지가 앞에 붙고 로그에 표시된다', async () => {
    routeMessageMock.mockResolvedValue({
      confidence: 0.95, margin: 0.6, persona: 'keeper', needsHistory: true,
    })
    dispatchTo('keeper')
    const callAssistant = jest.fn().mockResolvedValue({ text: '답' })
    const log = jest.fn().mockResolvedValue(undefined)
    const deps = makeDeps({ clefMode: 'active', clefInvoker: jest.fn(), callAssistant, log })
    const original = [{ role: 'user', content: '전에 말한 거 뭐였지' }]
    const result = await orchestrate(deps, '전에 말한 거 뭐였지', original, 1)
    expect(result.primaryId).toBe('keeper')
    const sentMessages = callAssistant.mock.calls[0][1]
    expect(sentMessages[0].role).toBe('system')
    expect(sentMessages[0].content).toContain('이력 맥락')
    expect(sentMessages[1]).toEqual(original[0])
    expect(log.mock.calls[0][0].needsHistory).toBe(true)
  })

  test('출처가 explicit/fallback이면 게이트 면제 — 저신뢰여도 Clef 결정을 적용한다', async () => {
    for (const source of ['explicit', 'fallback'] as const) {
      routeMessageMock.mockResolvedValue({ source, confidence: 0.1, margin: 0.01, persona: 'keeper' })
      dispatchTo('keeper')
      const recordDecision = jest.fn().mockResolvedValue(undefined)
      const deps = makeDeps({ clefMode: 'active', clefInvoker: jest.fn(), recordDecision })
      const result = await orchestrate(deps, '안녕', [], 1)
      expect(result.primaryId).toBe('keeper')
      expect(result.decision.reason).toBe(`${source}:test-reason`)
      expect(recordDecision.mock.calls[0][0]).toMatchObject({
        applied: true, reason: `exempt-${source}:test-reason`,
      })
    }
  })

  test('recordDecision이 실패해도 dispatch는 계속된다', async () => {
    routeMessageMock.mockResolvedValue({ confidence: 0.95, margin: 0.6, persona: 'keeper' })
    dispatchTo('keeper')
    const recordDecision = jest.fn().mockRejectedValue(new Error('db down'))
    const deps = makeDeps({ clefMode: 'active', clefInvoker: jest.fn(), recordDecision })
    const result = await orchestrate(deps, '안녕', [], 1)
    expect(result.primaryId).toBe('keeper')
    expect(result.text).toBe('hello')
  })

  test('dispatch 경로에서도 G6 모드가 켜져 있으면 G6 로그가 추가된다', async () => {
    routeMessageMock.mockResolvedValue({ confidence: 0.95, margin: 0.6, persona: 'keeper' })
    dispatchTo('keeper')
    const recordDecision = jest.fn().mockResolvedValue(undefined)
    const deps = makeDeps({
      clefMode: 'active', clefInvoker: jest.fn(), recordDecision, g6Mode: 'shadow',
    })
    await orchestrate(deps, '안녕', [], 1)
    expect(recordDecision).toHaveBeenCalledTimes(2)
  })

  test('clefMode를 명시하면 useClefRouter 없이도 Clef 경로를 쓴다', async () => {
    routeMessageMock.mockResolvedValue({ confidence: 0.3 })
    resolveClefRouteMock.mockReturnValue({ kind: 'reply', reason: 'x', message: 'm' })
    const deps = makeDeps({ clefMode: 'active', clefInvoker: jest.fn() })
    const result = await orchestrate(deps, '안녕', [], 1)
    expect(routeMessageMock).toHaveBeenCalled()
    expect(result.text).toBe('m')
  })
})

describe('orchestrate — 코디네이터 핸드오프 (협업)', () => {
  const MULTI = '메모 요약하고 코드로 정리해줘'

  test('협업자 호출 전에 핸드오프가 제약과 함께 기록된다', async () => {
    const callAssistant = jest.fn(async (personaId: string, _messages?: any[]) => ({ text: `${personaId} 답변` }))
    const recordHandoff = jest.fn().mockResolvedValue(undefined)
    const deps = makeDeps({
      callAssistant, recordHandoff,
      handoffConstraints: { keeper: ['민감정보 금지'] },
    })
    const result = await orchestrate(deps, MULTI, [{ role: 'user', content: MULTI }], 1)
    expect(result.participants).toHaveLength(2)
    const [toPersona] = result.participants.slice(1)
    expect(recordHandoff).toHaveBeenCalledTimes(1)
    const handoff = recordHandoff.mock.calls[0][0]
    expect(handoff).toMatchObject({
      fromPersona: result.primaryId,
      toPersona,
      request: MULTI,
      constraints: ['민감정보 금지'],
    })
    expect(handoff.context[0]).toContain(`${result.primaryId} 답변`)
    // 협업자에게는 주 담당 답변이 컨텍스트로 전달된다
    const collabMessages = callAssistant.mock.calls[1][1]
    const last = collabMessages[collabMessages.length - 1]
    expect(last.role).toBe('assistant')
    expect(last.content).toContain(`[${result.primaryId}의 답변]`)
  })

  test('제약이 없으면 빈 배열로 기록하고, 기록 실패해도 협업은 계속된다', async () => {
    const callAssistant = jest.fn(async (personaId: string, _messages?: any[]) => ({ text: `${personaId} 답변` }))
    const recordHandoff = jest.fn().mockRejectedValue(new Error('handoff db down'))
    const deps = makeDeps({ callAssistant, recordHandoff })
    const result = await orchestrate(deps, MULTI, [{ role: 'user', content: MULTI }], 1)
    expect(recordHandoff.mock.calls[0][0].constraints).toEqual([])
    expect(result.participants).toHaveLength(2)
    expect(result.text).toContain('답변')
  })
})
