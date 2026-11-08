import { STUDIO_TOOLS, type StudioToolCall } from './studio-tools'
import { inspectEgress, canUseRelay, PRIVACY_GATEWAY_BLOCK_MESSAGE } from './privacy-gateway'
import { redactForLog } from './privacy-engine'

type GeminiStage = 'request' | 'transport' | 'http' | 'parse' | 'response'

export class GeminiCallError extends Error {
  constructor(
    public readonly stage: GeminiStage,
    public readonly httpStatus: number | null,
    public readonly providerCode: string,
    message: string,
  ) {
    super(message)
    this.name = 'GeminiCallError'
  }
}

function safeErrorMessage(message: string): string {
  return redactForLog(message, 1000)
    .replace(/key=[^&\s]+/gi, 'key=[REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]+/g, '[REDACTED]')
    .slice(0, 1000)
}

function desanitizeValue(value: any, vault: any): any {
  if (typeof value === 'string') return vault.desanitize(value)
  if (Array.isArray(value)) return value.map((v) => desanitizeValue(v, vault))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = desanitizeValue(v, vault)
    }
    return out
  }
  return value
}

export async function callWithTools(
  env: any,
  provider: string,
  model: string,
  apiKey: string,
  messages: any[],
  geminiSystem?: string | null,
  isFirstCall?: boolean,
  options?: { jobId?: string | number; sensitivity?: string },
): Promise<{ text: string; toolCalls: StudioToolCall[]; rawContent?: any; rawToolCalls?: any[] }> {
  const flatForGate = messages.map((m) => ({
    role: String(m?.role ?? 'user'),
    content:
      typeof m?.content === 'string'
        ? m.content
        : Array.isArray(m?.parts)
          ? m.parts.map((p: any) => p?.text ?? '').join('\n')
          : '',
  }))
  const gate = inspectEgress({
    origin: 'studio',
    policy: options?.sensitivity ? ({ sensitivity: options.sensitivity } as any) : undefined,
    messages: flatForGate,
  })
  if (gate.action === 'block') {
    console.warn('privacy_gateway_blocked', { origin: 'studio', reasons: gate.reasons.join(',') })
    throw new GeminiCallError('request', null, 'PRIVACY_BLOCKED', PRIVACY_GATEWAY_BLOCK_MESSAGE)
  }
  if (gate.action === 'tokenized') {
    messages = messages.map((m) => {
      if (typeof m?.content === 'string') return { ...m, content: gate.vault.sanitize(m.content).text }
      if (Array.isArray(m?.parts)) return { ...m, parts: m.parts.map((p: any) => typeof p?.text === 'string' ? { ...p, text: gate.vault.sanitize(p.text).text } : p) }
      return m
    })
  }
  const gateLevel = gate.level
  let apiUrl: string
  let headers: Record<string, string> = { 'Content-Type': 'application/json' }
  let body: any

  const tools = STUDIO_TOOLS

  if (provider === 'gemini') {
    apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`
    const geminiTools = [{
      functionDeclarations: tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters
      }))
    }]
    const contents = messages.map((m) => {
      if (m.parts) return m
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content || '' }],
      }
    })
    body = {
      contents,
      tools: geminiTools,
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 8192, // 커뮤니티: 도구 호출 JSON 잘림 방지
      },
      ...(geminiSystem ? { systemInstruction: { parts: [{ text: geminiSystem }] } } : {}),
      // GPT 지침: 첫 호출에서는 도구 호출 강제
      // 커뮤니티 발견: ANY만으로는 부족, allowedFunctionNames 필요
      ...(isFirstCall
        ? {
            toolConfig: {
              functionCallingConfig: {
                mode: 'ANY',
                allowedFunctionNames: ['create_file'],
              },
            },
          }
        : {}),
    }
  } else {
    apiUrl =
      provider === 'groq'
        ? 'https://api.groq.com/openai/v1/chat/completions'
        : 'https://integrate.api.nvidia.com/v1/chat/completions'
    headers['Authorization'] = `Bearer ${apiKey}`
    body = {
      model,
      messages,
      tools,
      tool_choice: isFirstCall ? 'required' : 'auto',
      temperature: 0.3,
      max_tokens: 8192, // 커뮤니티: 도구 호출 JSON 잘림 방지
    }
  }

  const jobId = options?.jobId || 'unknown'
  let payload: string
  try {
    payload = JSON.stringify(body)
  } catch {
    throw new GeminiCallError('request', null, 'SERIALIZATION_FAILED', '요청 직렬화 실패')
  }

  console.log(JSON.stringify({
    event: 'STUDIO_HTTP_START',
    jobId,
    route: 'direct',
    provider,
    model,
    toolCount: provider === 'gemini' ? body.tools?.[0]?.functionDeclarations?.length ?? 0 : body.tools?.length ?? 0,
    requestBytes: new TextEncoder().encode(payload).byteLength
  }))

  let res: Response
  try {
    res = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(120000),
    })
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(JSON.stringify({
      event: 'STUDIO_TRANSPORT_ERROR',
      jobId,
      provider,
      error: safeErrorMessage(message)
    }))
    throw new GeminiCallError('transport', null, 'TRANSPORT_FAILED', safeErrorMessage(message))
  }

  const rawText = await res.text().catch(() => '')
  let data: any
  try {
    data = JSON.parse(rawText)
  } catch {
    console.error(JSON.stringify({
      event: 'STUDIO_HTTP_RESULT',
      jobId,
      provider,
      httpStatus: res.status,
      parseError: true,
      rawLength: rawText.length
    }))
    throw new GeminiCallError('parse', res.status, 'INVALID_JSON', `JSON 파싱 실패 (length=${rawText.length})`)
  }

  console.log(JSON.stringify({
    event: 'STUDIO_HTTP_RESULT',
    jobId,
    provider,
    route: 'direct',
    httpStatus: res.status,
    providerStatus: data.error?.status ?? null,
    providerCode: data.error?.code ?? null,
    providerMessage: data.error?.message ? safeErrorMessage(data.error.message) : null,
    candidateCount: data.candidates?.length ?? (data.choices?.length ?? 0),
    finishReason: data.candidates?.[0]?.finishReason ?? data.choices?.[0]?.finish_reason ?? null,
    blockReason: data.promptFeedback?.blockReason ?? null
  }))

  if (!res.ok && provider === 'gemini' && res.status === 400) {
    const isLocationBlocked = (data.error?.message || '').includes('User location is not supported')
    if (isLocationBlocked && !canUseRelay(gateLevel) && (env as any).GEMINI_RELAY_URL) {
      console.warn('privacy_relay_blocked', { origin: 'studio', level: gateLevel, reason: 'relay-l2-plus' })
      throw new GeminiCallError('http', res.status, 'PRIVACY_RELAY_BLOCKED', '개인정보 등급상 릴레이를 경유할 수 없습니다.')
    }
    if (isLocationBlocked && (env as any).GEMINI_RELAY_URL && (env as any).GEMINI_RELAY_SECRET) {
      console.log(JSON.stringify({
        event: 'STUDIO_RELAY_ATTEMPT',
        jobId,
        reason: 'location_blocked'
      }))
      const relayPayload = JSON.stringify({ model, key: apiKey, payload: body })
      console.log(JSON.stringify({
        event: 'STUDIO_HTTP_START',
        jobId,
        route: 'relay',
        provider,
        model,
        requestBytes: new TextEncoder().encode(relayPayload).byteLength
      }))
      let relayRes: Response
      try {
        relayRes = await fetch((env as any).GEMINI_RELAY_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Relay-Key': (env as any).GEMINI_RELAY_SECRET,
          },
          body: relayPayload,
          signal: AbortSignal.timeout(120000),
        })
      } catch (error: any) {
        throw new GeminiCallError('transport', null, 'RELAY_TRANSPORT_FAILED', safeErrorMessage(error.message))
      }
      const relayRaw = await relayRes.text().catch(() => '')
      let relayData: any
      try {
        relayData = JSON.parse(relayRaw)
      } catch {
        throw new GeminiCallError('parse', relayRes.status, 'RELAY_INVALID_JSON', '릴레이 응답 파싱 실패')
      }
      console.log(JSON.stringify({
        event: 'STUDIO_HTTP_RESULT',
        jobId,
        route: 'relay',
        httpStatus: relayRes.status,
        relayOk: relayData.ok ?? null
      }))
      if (relayData.ok) {
        const gdata =
          typeof relayData.body === 'string' ? JSON.parse(relayData.body) : relayData.body
        data = gdata
        console.log(JSON.stringify({
          event: 'STUDIO_RELAY_SUCCESS',
          jobId,
          candidateCount: data.candidates?.length ?? 0
        }))
      } else {
        throw new GeminiCallError(
          'http',
          relayRes.status,
          'RELAY_FAILED',
          safeErrorMessage(relayData.body || relayData.error || '릴레이 실패'),
        )
      }
    } else {
      throw new GeminiCallError(
        'http',
        res.status,
        String(data.error?.status ?? data.error?.code ?? 'HTTP_ERROR'),
        safeErrorMessage(data.error?.message ?? `HTTP ${res.status}`),
      )
    }
  } else if (!res.ok) {
    throw new GeminiCallError(
      'http',
      res.status,
      String(data.error?.status ?? data.error?.code ?? 'HTTP_ERROR'),
      safeErrorMessage(data.error?.message ?? `HTTP ${res.status}`),
    )
  }

  const toolCalls: StudioToolCall[] = []
  let text = ''
  let rawContent: any = undefined
  let rawToolCalls: any[] | undefined = undefined

  if (provider === 'gemini') {
    const candidate = data.candidates?.[0]
    logGeminiDiagnostics(data, res.status)
    rawContent = candidate?.content
    const parts = candidate?.content?.parts || []
    for (const p of parts) {
      if (p.text) text += p.text
      if (p.functionCall) {
        const args = p.functionCall.args || {}
        console.log(JSON.stringify({
          event: 'STUDIO_TOOL_CALL',
          jobId,
          toolName: p.functionCall.name,
          hasArgs: Object.keys(args).length > 0,
          argKeys: Object.keys(args),
          contentLength: typeof args.content === 'string' ? args.content.length : null
        }))
        toolCalls.push({
          name: p.functionCall.name,
          arguments: args,
          id: p.functionCall.id,
        } as any)
      }
    }
  } else {
    const msg = data.choices?.[0]?.message
    text = msg?.content || ''
    rawToolCalls = msg?.tool_calls || []
    for (const tc of rawToolCalls || []) {
      if (tc.type === 'function') {
        try {
          toolCalls.push({
            name: tc.function.name,
            arguments: JSON.parse(tc.function.arguments || '{}'),
            id: tc.id,
          } as any)
        } catch {}
      }
    }
  }

  text = gate.vault.desanitize(text)
  for (const tc of toolCalls) {
    tc.arguments = desanitizeValue(tc.arguments, gate.vault)
  }

  return { text, toolCalls, rawContent, rawToolCalls }
}

function logGeminiDiagnostics(data: any, httpStatus: number) {
  try {
    const candidate = data.candidates?.[0]
    const parts = candidate?.content?.parts ?? []
    console.log(JSON.stringify({
      event: 'STUDIO_GEMINI_RESPONSE',
      httpStatus,
      responseId: data.responseId,
      modelVersion: data.modelVersion,
      candidateCount: data.candidates?.length ?? 0,
      finishReason: candidate?.finishReason ?? null,
      finishMessage: candidate?.finishMessage ?? null,
      blockReason: data.promptFeedback?.blockReason ?? null,
      partTypes: parts.map(
        (p: any) => p.functionCall ? 'functionCall' : p.text !== undefined ? 'text' : 'other'
      ),
      toolNames: parts.filter((p: any) => p.functionCall).map((p: any) => p.functionCall.name),
      usage: data.usageMetadata ?? null
    }))
  } catch {}
}
