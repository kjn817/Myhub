/// <reference types="jest" />
/**
 * B-L6 Provider 세션 베이스 (5-7) — src/ai/providers/session-base.ts.
 *
 * 고정하는 성질:
 * - Groq·Workers AI 두 어댑터에 같은 호출 순서를 주면 메시지 이력이 동일하다
 *   (공용 베이스를 공유한다는 증거 — 한쪽만 바뀌면 실패한다).
 * - system 프롬프트 재설정은 기존 system을 걷어내고 맨 앞에 1개만 둔다.
 * - appendToolResults는 role:tool + 원본 tool_call_id + JSON 직렬화(성공은 data,
 *   실패는 {error, message})로 쌓는다.
 * - getMessages는 복사본을 낸다 (반환 배열을 바꿔도 이력이 안 바뀐다).
 * - applyNextSystemPrompt는 systemPrompt가 있을 때만 주입한다.
 * - Workers AI는 appendToolResults 후에도 nextNative/openai 분기가 유지된다
 *   (hasExecutedTools 오버라이드가 베이스 호출을 빠뜨리면 도구 결과가 안 쌓인다).
 * 카나리아: 베이스의 system 교체·tool 직렬화를 깨면 양쪽 어댑터 테스트가 함께 실패한다.
 */
import { GroqAdapter } from '../../src/ai/providers/groq'
import { WorkersAIAdapter } from '../../src/ai/providers/workers-ai'
import { applyNextSystemPrompt } from '../../src/ai/providers/session-base'
import type { ToolResult } from '../../src/ai/types'

function makeToolResult(callId: string, ok: boolean): ToolResult {
  return {
    callId,
    name: 'memo_search',
    output: ok
      ? { ok: true, data: { found: 2 } }
      : { ok: false, errorCode: 'NOT_FOUND', message: '없음' },
  } as ToolResult
}

/** 두 어댑터에 같은 호출 순서를 적용하고 이력을 비교한다. */
function driveBoth() {
  const groq = new GroqAdapter({ apiKey: 'x', model: 'm' })
  const wai = new WorkersAIAdapter({ ai: {}, model: 'm', apiMode: 'native' })
  for (const s of [groq, wai]) {
    s.setSystemPrompt('시스템1')
    s.addUserMessage('안녕')
    s.setSystemPrompt('시스템2')
    s.addUserMessage('메모 찾아줘')
    s.appendToolResults([makeToolResult('c1', true), makeToolResult('c2', false)])
  }
  return { groq: groq.getMessages(), wai: wai.getMessages() }
}

describe('공용 세션 동작 (Groq ≡ Workers AI)', () => {
  test('같은 호출 순서에 이력이 바이트 동일하다', () => {
    const { groq, wai } = driveBoth()
    expect(wai).toEqual(groq)
  })

  test('system 재설정은 기존 system을 걷어내고 맨 앞에 1개만 둔다', () => {
    const { groq } = driveBoth()
    const systems = groq.filter((m: any) => m.role === 'system')
    expect(systems).toHaveLength(1)
    expect(systems[0]).toEqual({ role: 'system', content: '시스템2' })
    expect(groq[0].role).toBe('system')
  })

  test('appendToolResults는 성공/실패를 구분해 직렬화한다', () => {
    const { groq } = driveBoth()
    const tools = groq.filter((m: any) => m.role === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools[0]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"found":2}' })
    expect(tools[1]).toEqual({
      role: 'tool',
      tool_call_id: 'c2',
      content: '{"error":"NOT_FOUND","message":"없음"}',
    })
  })

  test('getMessages는 복사본이다', () => {
    const adapter = new GroqAdapter({ apiKey: 'x', model: 'm' })
    adapter.addUserMessage('a')
    const copy = adapter.getMessages()
    copy.push({ role: 'user', content: 'forged' })
    expect(adapter.getMessages()).toHaveLength(1)
  })
})

describe('applyNextSystemPrompt', () => {
  test('systemPrompt가 있으면 주입한다', () => {
    const calls: string[] = []
    applyNextSystemPrompt({ setSystemPrompt: (p) => calls.push(p) }, { systemPrompt: 's' })
    expect(calls).toEqual(['s'])
  })

  test('systemPrompt가 없으면 아무것도 안 한다', () => {
    const calls: string[] = []
    applyNextSystemPrompt({ setSystemPrompt: (p) => calls.push(p) }, {})
    expect(calls).toEqual([])
  })

  test('빈 문자열이면 주입하지 않는다 (원본 if 조건과 동일)', () => {
    const calls: string[] = []
    applyNextSystemPrompt({ setSystemPrompt: (p) => calls.push(p) }, { systemPrompt: '' })
    expect(calls).toEqual([])
  })
})
