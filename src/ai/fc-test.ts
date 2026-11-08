/**
 * Workers AI Function Calling 최소 실증 테스트
 * 1단계: 모델이 tool_calls를 올바르게 반환하는지 확인
 */

// Cloudflare AI Gateway 통합 관측성 (트랙 B2, 2026-10-26)
import { AI_GATEWAY_OPTIONS } from '../services/ai-gateway'

export const TEST_TOOLS = [
  {
    name: 'test_echo',
    description: 'Echo back the input text for testing',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to echo back',
        },
      },
      required: ['text'],
    },
  },
]

export async function testFunctionCalling(env: any): Promise<{
  success: boolean
  hasToolCalls: boolean
  toolCalls?: any[]
  error?: string
  rawResponse?: any
}> {
  const ai = (env as any).AI
  if (!ai) {
    return { success: false, hasToolCalls: false, error: 'AI binding missing' }
  }

  try {
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Please echo back the text "hello world" using the test_echo tool.' },
    ]

    const result = (await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages,
      tools: TEST_TOOLS,
    }, AI_GATEWAY_OPTIONS)) as any

    const toolCalls = result?.tool_calls || result?.toolCalls || []

    return {
      success: true,
      hasToolCalls: Array.isArray(toolCalls) && toolCalls.length > 0,
      toolCalls,
      rawResponse: result,
    }
  } catch (e: any) {
    return {
      success: false,
      hasToolCalls: false,
      error: String(e?.message || e),
    }
  }
}
