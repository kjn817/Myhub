/**
 * Groq Provider Adapter — Phase 1C
 *
 * OpenAI 호환 Chat Completions API 사용.
 * - tools → OpenAI tools 형식 변환
 * - message.tool_calls → 공통 ToolCall 정규화
 * - tool 결과 → role:tool 메시지로 재전송
 *
 * 기존 callGroq (src/services/ai.ts) 로직 재사용.
 */

import type {
  ToolDefinition,
  ToolCall,
  ModelStep,
  ProviderSession,
  TokenUsage,
} from '../types'
import { ProviderError } from '../types'
import { toJsonSchema } from '../tools/registry'
import { OpenAIStyleSession, applyNextSystemPrompt } from './session-base'

// ---------------------------------------------------------------------------
// 오류 정규화
// ---------------------------------------------------------------------------

function toProviderError(e: any): ProviderError {
  const status = e?.code || e?.status
  if (status === 429 || String(e?.message).includes('rate_limited')) {
    return new ProviderError({
      code: 'RATE_LIMITED',
      retryable: true,
      provider: 'groq',
      message: 'Rate limited',
      retryAfterMs: e?.retryAfterMs,
    })
  }
  if (status === 401 || status === 403) {
    return new ProviderError({
      code: 'AUTH_ERROR',
      retryable: false,
      provider: 'groq',
      message: 'Authentication failed',
    })
  }
  if (String(e?.message).includes('timeout') || e?.name === 'TimeoutError') {
    return new ProviderError({ code: 'TIMEOUT', retryable: true, provider: 'groq', message: 'Request timed out' })
  }
  if (status === 503 || status === 502) {
    return new ProviderError({ code: 'SERVICE_UNAVAILABLE', retryable: true, provider: 'groq', message: 'Service unavailable' })
  }
  if (status === 400) {
    return new ProviderError({ code: 'INVALID_REQUEST', retryable: false, provider: 'groq', message: 'Invalid request' })
  }
  return new ProviderError({ code: 'UNKNOWN', retryable: false, provider: 'groq', message: String(e?.message || 'Unknown error') })
}

// ---------------------------------------------------------------------------
// Groq Adapter
// ---------------------------------------------------------------------------

export type GroqAdapterConfig = {
  apiKey: string
  model: string
}

export class GroqAdapter extends OpenAIStyleSession implements ProviderSession {
  readonly provider = 'groq' as const
  readonly modelId: string

  private apiKey: string

  constructor(config: GroqAdapterConfig) {
    super()
    this.apiKey = config.apiKey
    this.modelId = config.model
  }

  async next(options: {
    tools: ToolDefinition[]
    toolChoice: 'auto' | 'none'
    maxOutputTokens: number
    systemPrompt?: string
  }): Promise<ModelStep> {
    applyNextSystemPrompt(this, options)

    // ToolDefinition → OpenAI tools 형식
    const tools = options.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: toJsonSchemaForGroq(t),
      },
    }))

    const body: any = {
      model: this.modelId,
      messages: this.messages,
      temperature: 0.1,
      max_tokens: options.maxOutputTokens,
    }
    if (tools.length > 0) {
      body.tools = tools
      if (options.toolChoice === 'none') {
        body.tool_choice = 'none'
      }
    }

    let res: Response
    try {
      res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25000),
      })
    } catch (e: any) {
      throw toProviderError(e)
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after')
      throw toProviderError({
        code: 429,
        retryAfterMs: retryAfter ? parseInt(retryAfter) * 1000 : undefined,
      })
    }
    if (!res.ok) {
      throw toProviderError({ code: res.status, message: `groq ${res.status}` })
    }

    const data = (await res.json()) as any
    const msg = data.choices?.[0]?.message

    if (!msg) {
      throw toProviderError({ message: 'Empty response from Groq' })
    }

    // 원본 assistant 메시지 보존 (tool_calls 포함)
    this.messages.push(msg)

    // tool_calls → ToolCall 정규화
    const toolCalls: ToolCall[] = []
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        let args: unknown = {}
        let parseError = false
        try {
          args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}
        } catch {
          // 잘못된 JSON → 파싱 실패 표시, Runner에서 INVALID_ARGUMENTS 처리
          parseError = true
          args = {}
        }
        const toolCall: ToolCall = {
          id: tc.id || `groq-${Date.now()}-${toolCalls.length}`,
          name: tc.function?.name || '',
          args,
          provider: 'groq',
        }
        // 파싱 실패를 명시적으로 표시 (Zod 검증 전에 Runner가 확인)
        if (parseError) {
          toolCall.parseError = true
        }
        toolCalls.push(toolCall)
      }
    }

    const finishReason = mapFinishReason(data.choices?.[0]?.finish_reason, toolCalls.length > 0)

    const usage: TokenUsage = {
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
      source: data.usage ? 'provider' : 'unavailable',
    }

    return {
      text: msg.content ?? null,
      toolCalls,
      finishReason,
      usage,
    }
  }
}

function mapFinishReason(
  reason: string | undefined,
  hasToolCalls: boolean
): ModelStep['finishReason'] {
  if (hasToolCalls) return 'tool_calls'
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'tool_calls':
      return 'tool_calls'
    default:
      return 'unknown'
  }
}

function toJsonSchemaForGroq(t: ToolDefinition): Record<string, unknown> {
  // toJsonSchema 사용, Groq 호환성 확인
  try {
    return toJsonSchema(t.parameters as any)
  } catch {
    // 폴백: definition의 parameters 직접 사용
    return t.parameters
  }
}
