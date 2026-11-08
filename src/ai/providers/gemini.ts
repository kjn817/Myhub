/**
 * Gemini Provider Adapter — Phase 1C
 *
 * Native Function Calling 방식.
 * - functionDeclarations → Gemini tools 형식
 * - functionCall 파트 → 공통 ToolCall 정규화
 * - functionResponse → 도구 결과 재전송
 *
 * 중요: Thought Signature 및 원본 parts를 손실 없이 보존.
 * 후속 요청에서 원본 응답을 그대로 재사용.
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
import { canUseRelay } from '../../services/privacy-gateway'

/**
 * Gemini API용 스키마 정제
 * Gemini는 JSON Schema의 일부 필드를 지원하지 않음
 * - additionalProperties, $schema, $id, examples 등 제거
 * - 중첩된 properties/items도 재귀적으로 처리
 */
function sanitizeForGemini(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) {
    return schema.map(sanitizeForGemini)
  }
  const result: any = {}
  // Gemini가 지원하지 않는 필드 제외
  const UNSUPPORTED = new Set([
    'additionalProperties', '$schema', '$id', 'examples', 'example',
    'patternProperties', 'dependencies', 'allOf', 'anyOf', 'oneOf', 'not',
  ])
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED.has(key)) continue
    result[key] = sanitizeForGemini(value)
  }
  return result
}

function toProviderError(e: any): ProviderError {
  const status = e?.code || e?.status
  const msg = String(e?.message || '')
  if (status === 429 || msg.includes('rate_limited') || msg.includes('429')) {
    return new ProviderError({ code: 'RATE_LIMITED', retryable: true, provider: 'gemini', message: 'Rate limited' })
  }
  if (status === 401 || status === 403 || msg.includes('API key')) {
    return new ProviderError({ code: 'AUTH_ERROR', retryable: false, provider: 'gemini', message: 'Authentication failed' })
  }
  if (msg.includes('timeout') || e?.name === 'TimeoutError') {
    return new ProviderError({ code: 'TIMEOUT', retryable: true, provider: 'gemini', message: 'Request timed out' })
  }
  if (status === 503 || status === 502 || msg.includes('503')) {
    return new ProviderError({ code: 'SERVICE_UNAVAILABLE', retryable: true, provider: 'gemini', message: 'Service unavailable' })
  }
  if (status === 400 || msg.includes('400')) {
    return new ProviderError({ code: 'INVALID_REQUEST', retryable: false, provider: 'gemini', message: 'Invalid request' })
  }
  // 지역 제한
  if (msg.includes('User location is not supported')) {
    return new ProviderError({ code: 'INVALID_REQUEST', retryable: false, provider: 'gemini', message: 'Region not supported' })
  }
  return new ProviderError({ code: 'UNKNOWN', retryable: false, provider: 'gemini', message: msg || 'Unknown error' })
}

export type GeminiAdapterConfig = {
  apiKey: string
  model: string
  /** Deno 릴레이 URL (지역 제한 시) */
  relayUrl?: string
  relaySecret?: string
  /** Privacy 게이트 등급 (R-05) — L2+는 릴레이 경유 금지 */
  privacyLevel?: number
}

export class GeminiAdapter implements ProviderSession {
  readonly provider = 'gemini' as const
  readonly modelId: string

  private apiKey: string
  private relayUrl?: string
  private relaySecret?: string
  private privacyLevel?: number
  /** Gemini Native contents 이력 (원본 보존) */
  private contents: any[] = []
  private systemInstruction: any = null

  constructor(config: GeminiAdapterConfig) {
    this.apiKey = config.apiKey
    this.modelId = config.model
    this.relayUrl = config.relayUrl
    this.relaySecret = config.relaySecret
    this.privacyLevel = config.privacyLevel
  }

  setSystemPrompt(prompt: string): void {
    this.systemInstruction = { parts: [{ text: prompt }] }
  }

  addUserMessage(content: string): void {
    this.contents.push({ role: 'user', parts: [{ text: content }] })
  }

  async next(options: {
    tools: ToolDefinition[]
    toolChoice: 'auto' | 'none'
    maxOutputTokens: number
    systemPrompt?: string
  }): Promise<ModelStep> {
    if (options.systemPrompt) {
      this.setSystemPrompt(options.systemPrompt)
    }

    const body: any = {
      contents: this.contents,
    }
    if (this.systemInstruction) {
      body.systemInstruction = this.systemInstruction
    }

    // 도구 정의 변환 (toolChoice가 none이면 tools 제외)
    // Gemini는 JSON Schema의 일부 필드를 지원하지 않으므로 정제 필요
    if (options.tools.length > 0 && options.toolChoice !== 'none') {
      body.tools = [
        {
          functionDeclarations: options.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: sanitizeForGemini(t.parameters),
          })),
        },
      ]
    }

    body.generationConfig = {
      maxOutputTokens: options.maxOutputTokens,
      temperature: 0.1,
    }

    let data: any
    try {
      data = await this.callGemini(body)
    } catch (e: any) {
      throw toProviderError(e)
    }

    const candidate = data.candidates?.[0]
    if (!candidate) {
      throw toProviderError({ message: 'Empty response from Gemini' })
    }

    const parts = candidate.content?.parts || []

    // 원본 모델 응답 보존 (Thought Signature 포함)
    // 중요: parts를 그대로 저장하여 후속 요청에 재사용
    this.contents.push({
      role: 'model',
      parts: parts, // 원본 그대로 (thoughtSignature 포함)
    })

    // functionCall 파트 → ToolCall 정규화
    const toolCalls: ToolCall[] = []
    let text: string | null = null
    const textParts: string[] = []

    for (const part of parts) {
      if (part.functionCall) {
        const fc = part.functionCall
        toolCalls.push({
          // Gemini는 호출 ID가 없을 수 있음 → 내부 ID 생성
          id: fc.id || `gemini-${Date.now()}-${toolCalls.length}`,
          name: fc.name || '',
          args: fc.args || {},
          provider: 'gemini',
        })
        // 원본 functionCall 파트 정보 보존 (ID 매핑용)
        ;(toolCalls[toolCalls.length - 1] as any)._originalPart = part
      } else if (part.text) {
        textParts.push(part.text)
      }
      // thoughtSignature 파트는 파싱하지 않고 보존만
    }

    if (textParts.length > 0) {
      text = textParts.join('')
    }

    const finishReason = mapFinishReason(candidate.finishReason, toolCalls.length > 0)

    const usage: TokenUsage = {
      inputTokens: data.usageMetadata?.promptTokenCount,
      outputTokens: data.usageMetadata?.candidatesTokenCount,
      source: data.usageMetadata ? 'provider' : 'unavailable',
    }

    return { text, toolCalls, finishReason, usage }
  }

  appendToolResults(results: ToolResult[]): void {
    // 각 ToolResult를 functionResponse 파트로 변환
    const parts = results.map((r) => {
      // 원본 호출 ID 찾기 (내부 매핑)
      const response: any = {
        functionResponse: {
          name: r.name,
          response: r.output.ok
            ? { result: r.output.data }
            : { error: r.output.errorCode, message: r.output.message },
        },
      }
      // 원본 functionCall에 ID가 있었다면 유지
      // (Gemini Native에서는 name으로 매칭)
      return response
    })

    this.contents.push({
      role: 'user',
      parts,
    })
  }

  private async callGemini(body: any): Promise<any> {
    try {
      return await this.callDirect(body)
    } catch (e: any) {
      const msg = String(e?.message || '')
      // 지역 제한 오류일 때만 릴레이로 폴백한다. 단, Privacy 등급이
      // 릴레이를 금지하는 경우(L2+)는 그대로 실패시킨다 (R-05).
      if (this.relayUrl && msg.includes('User location is not supported') && (this.privacyLevel === undefined || canUseRelay(this.privacyLevel))) {
        return this.callViaRelay(body)
      }
      throw e
    }
  }

  private async callDirect(body: any): Promise<any> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelId}:generateContent?key=${encodeURIComponent(this.apiKey)}`

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25000),
      })

      if (res.status === 429) {
        throw Object.assign(new Error('rate_limited'), { code: 429 })
      }
      if (!res.ok) {
 const errBody = await res.text().catch( () => '')
        throw Object.assign(new Error(`gemini ${res.status}: ${errBody.slice(0, 200)}`), {
          code: res.status,
        })
      }
      return await res.json()
    } catch (e: any) {
      throw e
    }
  }

  private async callViaRelay(body: any): Promise<any> {
    if (!this.relayUrl) throw new Error('Relay URL not configured')
    // 릴레이 서버 형식: X-Relay-Key 헤더, { model, key, payload } body
    // (src/services/ai.ts의 callGeminiViaRelay와 동일한 형식)
    const res = await fetch(this.relayUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Key': this.relaySecret || '',
      },
      body: JSON.stringify({ model: this.modelId, key: this.apiKey, payload: body }),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) throw new Error(`relay ${res.status}`)
    const data = (await res.json()) as any
    // 릴레이 응답 형식: { ok, status, body }
    if (!data.ok) {
      throw new Error(`relay ${data.status}: ${(data.body || data.error || '').slice(0, 200)}`)
    }
    try {
      return JSON.parse(data.body)
    } catch {
      throw new Error(`relay bad body: ${String(data.body).slice(0, 200)}`)
    }
  }

  /** 디버깅용 */
  getContents(): any[] {
    return [...this.contents]
  }
}

function mapFinishReason(
  reason: string | undefined,
  hasToolCalls: boolean
): ModelStep['finishReason'] {
  if (hasToolCalls) return 'tool_calls'
  switch (reason) {
    case 'STOP':
      return 'stop'
    case 'MAX_TOKENS':
      return 'length'
    default:
      return 'unknown'
  }
}
