/**
 * Cloudflare AI Gateway 통합 관측성 (트랙 B2, 2026-10-26) 테스트
 *
 * 모든 Workers AI(`env.AI.run`) 호출에 `gateway: { id: "default" }` 옵션이
 * 3번째 인자로 전달되는지 기록형 fake가 받은 인자 데이터로 검증한다.
 * 실제 Workers AI 호출 없음. 운영 D1·배포에 닿지 않는다.
 */
/// <reference types="jest" />

import { AI_GATEWAY_ID, AI_GATEWAY_OPTIONS } from '../../src/services/ai-gateway'
import { CLEF_MODEL, createClefInvoker } from '../../src/services/router'
import { testFunctionCalling } from '../../src/ai/fc-test'
import {
  VOICE_STT_MODEL,
  VOICE_TTS_MODEL,
  transcribeAudio,
  synthesizeSpeech,
} from '../../src/services/voice'
import { WorkersAIAdapter } from '../../src/ai/providers/workers-ai'
// services/ai import 시 프로바이더 플러그인이 등록된다 (callWorkersAI 경유 테스트용)
import '../../src/services/ai'
import { getProvider } from '../../src/services/provider-registry'

describe('AI_GATEWAY_OPTIONS', () => {
  test('게이트웨이 ID는 자동 생성되는 "default"', () => {
    expect(AI_GATEWAY_ID).toBe('default')
  })

  test('옵션 형태는 { gateway: { id: "default", collectLog: false } } (페이로드 로깅 차단)', () => {
    expect(AI_GATEWAY_OPTIONS).toEqual({ gateway: { id: 'default', collectLog: false } })
  })
})

// (c) 정리(2026-11-08 최종 배치): env.AI.run을 기록형 fake로 교체해
// 실제로 전달된 (모델, 입력, 옵션) 인자를 데이터로 단언한다
// (toHaveBeenCalledWith mock 단언 대체).
function recordingRun(result: any) {
  const calls: any[][] = []
  const run = async (...a: any[]) => {
    calls.push(a)
    return result
  }
  return { calls, run }
}

describe('createClefInvoker', () => {
  test('Clef 호출에 gateway 옵션을 단다', async () => {
    const { calls, run } = recordingRun({ ok: true })
    const invoker = createClefInvoker({ run } as any)
    await invoker({ question: 'q' } as any)
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(CLEF_MODEL)
    expect(calls[0][1]).toEqual({ question: 'q' })
    expect(calls[0][2]).toEqual(AI_GATEWAY_OPTIONS)
  })
})

describe('testFunctionCalling', () => {
  test('FC 실증 호출에 gateway 옵션을 단다', async () => {
    const { calls, run } = recordingRun({ tool_calls: [{ name: 'test_echo' }] })
    await testFunctionCalling({ AI: { run } })
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast')
    expect(calls[0][1]).toBeDefined()
    expect(calls[0][2]).toEqual(AI_GATEWAY_OPTIONS)
  })
})

describe('음성 (transcribeAudio / synthesizeSpeech)', () => {
  test('STT 호출에 gateway 옵션을 단다', async () => {
    const { calls, run } = recordingRun({ text: '안녕하세요' })
    await transcribeAudio({ run } as any, new Uint8Array([1, 2, 3]))
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(VOICE_STT_MODEL)
    expect(calls[0][1]).toEqual({ audio: [1, 2, 3] })
    expect(calls[0][2]).toEqual(AI_GATEWAY_OPTIONS)
  })

  test('TTS 호출에 gateway 옵션을 단다', async () => {
    const { calls, run } = recordingRun(new Uint8Array([1, 2, 3]))
    await synthesizeSpeech({ run } as any, '안녕하세요')
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(VOICE_TTS_MODEL)
    expect(calls[0][1]).toEqual(expect.objectContaining({ lang: 'kr' }))
    expect(calls[0][2]).toEqual(AI_GATEWAY_OPTIONS)
  })
})

describe('WorkersAIAdapter (Native 경로)', () => {
  test('nextNative 호출에 gateway 옵션을 단다', async () => {
    const run = jest.fn().mockResolvedValue({ response: 'x' })
    const adapter = new WorkersAIAdapter({ ai: { run }, model: 'test-model', apiMode: 'native' })
    adapter.addUserMessage('hi')
    await adapter.next({ tools: [], toolChoice: 'auto', maxOutputTokens: 100 })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0]).toBe('test-model')
    expect(run.mock.calls[0][2]).toEqual(AI_GATEWAY_OPTIONS)
  })
})

describe('callWorkersAI (프로바이더 레지스트리 경유)', () => {
  test('workers-ai 플러그인 호출에 gateway 옵션을 단다', async () => {
    const run = jest.fn().mockResolvedValue({ response: 'hi' })
    const plugin = getProvider('workers-ai')
    expect(plugin).toBeDefined()
    const result = await plugin!.call({
      env: { AI: { run } },
      key: null,
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(result.text).toBe('hi')
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][2]).toEqual(AI_GATEWAY_OPTIONS)
  })
})
