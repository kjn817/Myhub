/**
 * Workers AI Provider Adapter — Phase 1C
 *
 * 우선 OpenAI 호환 Chat Completions API 시도.
 * 호환 API가 동작하지 않으면 Native API 폴백.
 *
 * 대상 모델: @cf/mistralai/mistral-small-3.1-24b-instruct
 */

import type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  ModelStep,
  ProviderSession,
  TokenUsage,
} from '../types'
import { ProviderError } from '../types'
import { OpenAIStyleSession, applyNextSystemPrompt } from './session-base'
// Cloudflare AI Gateway 통합 관측성 (트랙 B2, 2026-10-26) — Native 경로에만 적용.
// OpenAI 호환 REST 경로(api.cloudflare.com/.../ai/v1)는 env.AI.run이 아니라서 그대로 둔다.
import { AI_GATEWAY_OPTIONS } from '../../services/ai-gateway'

function toProviderError(e: any): ProviderError {
  const msg = String(e?.message || '')
  if (msg.includes('rate') || msg.includes('429')) {
    return new ProviderError({ code: 'RATE_LIMITED', retryable: true, provider: 'workers-ai', message: 'Rate limited' })
  }
  if (msg.includes('auth') || msg.includes('401') || msg.includes('403')) {
    return new ProviderError({ code: 'AUTH_ERROR', retryable: false, provider: 'workers-ai', message: 'Authentication failed' })
  }
  if (msg.includes('timeout') || e?.name === 'TimeoutError') {
    return new ProviderError({ code: 'TIMEOUT', retryable: true, provider: 'workers-ai', message: 'Request timed out' })
  }
  if (msg.includes('binding missing') || msg.includes('AI binding')) {
    return new ProviderError({ code: 'INVALID_REQUEST', retryable: false, provider: 'workers-ai', message: 'Workers AI binding missing' })
  }
  return new ProviderError({ code: 'UNKNOWN', retryable: false, provider: 'workers-ai', message: msg || 'Unknown error' })
}

export type WorkersAIAdapterConfig = {
  /** Workers AI 바인딩 (env.AI) */
  ai: any
  model: string
  /**
   * API 모드 (세션 시작 시 확정, 세션 중 변경 금지)
   * - 'openai': OpenAI 호환 Chat Completions API
   * - 'native': Workers AI Native API (ai.run)
   */
  apiMode: 'openai' | 'native'
  /** Cloudflare Account ID (OpenAI 호환 API용) */
  accountId?: string
  /** API Token (OpenAI 호환 API용) */
  apiToken?: string
}

export class WorkersAIAdapter extends OpenAIStyleSession implements ProviderSession {
  readonly provider = 'workers-ai' as const
  readonly modelId: string

  private ai: any
  private apiMode: 'openai' | 'native'
  private accountId?: string
  private apiToken?: string
  /** 도구가 이미 실행된 여부 (모드 변경 금지 판단용) */
  private hasExecutedTools: boolean = false

  constructor(config: WorkersAIAdapterConfig) {
    super()
    this.ai = config.ai
    this.modelId = config.model
    this.apiMode = config.apiMode
    this.accountId = config.accountId
    this.apiToken = config.apiToken
  }

  async next(options: {
    tools: ToolDefinition[]
    toolChoice: 'auto' | 'none'
    maxOutputTokens: number
    systemPrompt?: string
  }): Promise<ModelStep> {
    applyNextSystemPrompt(this, options)

    // 세션 시작 시 확정된 API 모드 사용 (세션 중 변경 금지)
    // 도구가 이미 실행된 세션에서는 모드 변경 불가
    if (this.apiMode === 'openai') {
      if (!this.accountId || !this.apiToken) {
        throw toProviderError({ message: 'OpenAI-compatible API requires accountId and apiToken' })
      }
      return this.nextOpenAICompatible(options)
    }

    return this.nextNative(options)
  }

  private async nextOpenAICompatible(options: {
    tools: ToolDefinition[]
    toolChoice: 'auto' | 'none'
    maxOutputTokens: number
  }): Promise<ModelStep> {
    const tools = options.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }))

    const body: any = {
      model: this.modelId,
      messages: this.messages,
      max_tokens: options.maxOutputTokens,
    }
    if (tools.length > 0 && options.toolChoice !== 'none') {
      body.tools = tools
    } else if (options.toolChoice === 'none') {
      body.tool_choice = 'none'
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/v1/chat/completions`
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiToken}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25000),
      })
    } catch (e: any) {
      throw toProviderError(e)
    }

    if (!res.ok) {
      throw toProviderError({ message: `workers-ai ${res.status}` })
    }

    const data = (await res.json()) as any
    // Cloudflare API는 result 래퍼 사용
    const msg = data.result?.choices?.[0]?.message || data.choices?.[0]?.message

    if (!msg) {
      throw toProviderError({ message: 'Empty response from Workers AI' })
    }

    // 원본 메시지 보존
    this.messages.push(msg)

    const toolCalls: ToolCall[] = []
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        let args: unknown = {}
        try {
          args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}
        } catch {
          args = { __parseError: true }
        }
        toolCalls.push({
          id: tc.id || `wai-${Date.now()}-${toolCalls.length}`,
          name: tc.function?.name || '',
          args,
          provider: 'workers-ai',
        })
      }
    }

    return {
      text: msg.content ?? null,
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      usage: { source: 'unavailable' }, // Workers AI는 usage 미반환
    }
  }

  private async nextNative(options: {
    tools: ToolDefinition[]
    toolChoice: 'auto' | 'none'
    maxOutputTokens: number
  }): Promise<ModelStep> {
    if (!this.ai) {
      throw toProviderError({ message: 'workers-ai binding missing' })
    }

    // Native API: ai.run(model, { messages, tools })
    const input: any = {
      messages: this.messages,
      max_tokens: options.maxOutputTokens,
    }

    if (options.tools.length > 0 && options.toolChoice !== 'none') {
      input.tools = options.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    }

    let out: any
    try {
      out = await this.ai.run(this.modelId, input, AI_GATEWAY_OPTIONS)
    } catch (e: any) {
      throw toProviderError(e)
    }

    // Native 응답 파싱 (모델별 형식 상이)
    const toolCalls: ToolCall[] = []
    let text: string | null = null

    if (typeof out?.response === 'string') {
      text = out.response
    } else if (out?.tool_calls) {
      for (const tc of out.tool_calls) {
        toolCalls.push({
          id: tc.id || `wai-native-${Date.now()}-${toolCalls.length}`,
          name: tc.name || tc.function?.name || '',
          args: typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments || {},
          provider: 'workers-ai',
        })
      }
      text = out.response?.content || null
    } else {
      text = JSON.stringify(out?.response ?? '')
    }

    // 원본 응답 보존
    this.messages.push({
      role: 'assistant',
      content: text,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    })

    return {
      text,
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      usage: { source: 'unavailable' },
    }
  }

  appendToolResults(results: ToolResult[]): void {
    if (results.length > 0) {
      this.hasExecutedTools = true
    }
    super.appendToolResults(results)
  }
}
