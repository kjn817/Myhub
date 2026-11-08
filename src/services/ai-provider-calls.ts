// Provider별 실제 호출 함수 (Gemini·Groq·NVIDIA·Workers AI)
// src/services/ai.ts에서 순수 이동 (트랙 D, 2026-10-31) — 동작 변경 없음.
// ai.ts의 프로바이더 플러그인 등록(registerProvider)이 이 함수들을 감싼다.
import type { Env } from '../types'
import type { ChatMessage } from './ai-types'
import { prepareToolsFor } from '../ai/memo-fc-tools'
import { AI_GATEWAY_OPTIONS } from './ai-gateway'
import { canUseRelay } from './privacy-gateway'

export const GROUNDING_CAPABLE_MODELS = new Set(['gemini-2.5-flash'])

export function groundingDecision(model: string, useSearch?: boolean): { enabled: boolean; reason?: string } {
  if (!useSearch) return { enabled: false, reason: 'search_not_requested' }
  if (!GROUNDING_CAPABLE_MODELS.has(model)) return { enabled: false, reason: 'model_not_capable' }
  return { enabled: true }
}

export async function callGemini(env: any, key: string, model: string, messages: ChatMessage[], useSearch: boolean = false, sensitivity?: string, signal?: AbortSignal, privacyLevel?: number): Promise<{ text: string; inputTokens?: number; outputTokens?: number; sources?: { title: string; url: string }[] }> {
  // OpenAI식 messages → Gemini 형식 변환
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
  const body: any = { contents }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  // Google Search grounding: gemini-2.5-flash만 무료 티어에서 지원
  const grounding = groundingDecision(model, useSearch)
  if (grounding.enabled) {
    body.tools = [{ google_search: {} }]
  } else if (grounding.reason === 'model_not_capable') {
    console.warn('grounding_skipped', { model, reason: 'model_not_capable' })
  }

  // 1차: 직접 호출 (릴레이를 거치지 않으므로 personal 전송 허용)
  try {
    return await callGeminiDirect(key, model, body, signal)
  } catch (e: any) {
    // 지역 제한이면 릴레이 경유 — 단, Privacy Gateway 레벨이 L2 이상이면
    // 릴레이(제3자 경유)로 개인정보를 보내지 않는다 (fail-closed).
    const msg = String(e?.message || '')
    if (msg.includes('User location is not supported') && env.GEMINI_RELAY_URL && env.GEMINI_RELAY_SECRET) {
      if (privacyLevel !== undefined && !canUseRelay(privacyLevel)) {
        console.warn('privacy_relay_blocked', { level: privacyLevel, reason: 'relay-l2-plus' })
        throw e
      }
      if (privacyLevel === undefined && sensitivity === 'restricted') {
        console.warn('privacy_relay_blocked', { level: 'restricted', reason: 'relay-l2-plus' })
        throw e
      }
      return await callGeminiViaRelay(env, key, model, body, signal)
    }
    throw e
  }
}


async function callGeminiDirect(key: string, model: string, body: any, signal?: AbortSignal): Promise<{ text: string; inputTokens?: number; outputTokens?: number; sources?: { title: string; url: string }[] }> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(25000) }
  )
  if (res.status === 429) throw Object.assign(new Error('rate_limited'), { code: 429 })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    if (res.status === 404) {
      console.error('gemini_model_unavailable', { model, httpStatus: 404 })
    }
    throw Object.assign(new Error(`gemini ${res.status}: ${errBody.slice(0, 200)}`), { code: res.status })
  }
  const data = (await res.json()) as any
  const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') ?? ''
  // grounding metadata에서 출처 추출
  const sources = parseGroundingSources(data)
  if ((body as any)?.tools && sources.length === 0) {
    console.warn('grounding_no_sources', { model })
  }
  return {
    text,
    inputTokens: data.usageMetadata?.promptTokenCount,
    outputTokens: data.usageMetadata?.candidatesTokenCount,
    sources: sources.length > 0 ? sources : undefined,
  }
}

// groundingMetadata에서 출처 URL 추출
function parseGroundingSources(data: any): { title: string; url: string }[] {
  try {
    const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []
    return chunks
      .map((c: any) => c?.web ? { title: c.web.title || c.web.uri, url: c.web.uri } : null)
      .filter((s: any) => s && s.url)
  } catch {
    return []
  }
}

// Deno Deploy 릴레이 경유 (지역 제한 우회)
async function callGeminiViaRelay(env: any, key: string, model: string, body: any, signal?: AbortSignal): Promise<{ text: string; inputTokens?: number; outputTokens?: number; sources?: { title: string; url: string }[] }> {
  const startedAt = Date.now()
  console.log('gemini_relay_attempt', { model })
  let res: Response
  try {
    res = await fetch(env.GEMINI_RELAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Key': env.GEMINI_RELAY_SECRET,
      },
      body: JSON.stringify({ model, key, payload: body }),
      signal: signal ?? AbortSignal.timeout(30000),
    })
  } catch (e: any) {
    console.error('gemini_relay_failed', { kind: 'transport', model, error: String(e?.message || e).slice(0, 120) })
    throw Object.assign(new Error(`gemini-relay transport failed: ${String(e?.message || e).slice(0, 120)}`), { code: 502 })
  }
  let data: any
  try {
    data = await res.json()
  } catch {
    console.error('gemini_relay_failed', { kind: 'non_json_response', model, httpStatus: (res as any).status ?? null })
    throw Object.assign(new Error(`gemini-relay non-json response (http ${(res as any).status ?? 'unknown'}) — relay may be down`), { code: (res as any).status || 502 })
  }
  if (!data.ok) {
    console.error('gemini_relay_failed', { kind: 'relay_error', model, httpStatus: (res as any).status ?? null, relayStatus: data.status ?? null })
    throw Object.assign(new Error(`gemini-relay ${data.status}: ${(data.body || data.error || '').slice(0, 120)}`), { code: data.status })
  }
  console.log('gemini_relay_success', { model, relayStatus: data.status ?? null, latencyMs: Date.now() - startedAt })
  let gdata: any
  try {
    gdata = JSON.parse(data.body)
  } catch {
    throw Object.assign(new Error(`gemini-relay bad body: ${String(data.body).slice(0, 120)}`), { code: data.status || 502 })
  }
  if (gdata.error) {
    throw Object.assign(new Error(`gemini ${gdata.error.code}: ${gdata.error.message?.slice(0, 100)}`), { code: gdata.error.code })
  }
  const text = gdata.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') ?? ''
  const sources = parseGroundingSources(gdata)
  return {
    text,
    inputTokens: gdata.usageMetadata?.promptTokenCount,
    outputTokens: gdata.usageMetadata?.candidatesTokenCount,
    sources: sources.length > 0 ? sources : undefined,
  }
}

export async function callGroq(key: string, model: string, messages: ChatMessage[], signal?: AbortSignal): Promise<{ text: string; inputTokens?: number; outputTokens?: number }> {
  // Function calling은 안정성 확인 후 재활성화 (현재 기본 채팅만)
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: 0.1 }),
    signal: signal ?? AbortSignal.timeout(25000),
  })
  if (res.status === 429) throw Object.assign(new Error('rate_limited'), { code: 429 })
  if (!res.ok) {
    // Groq 오류 응답 파싱 (error.type, error.code 등 구조화된 정보 추출)
    let errorType = 'unknown'
    let errorCode = ''
    let errorParam = ''
    try {
      const errData = (await res.json()) as any
      errorType = errData?.error?.type || 'unknown'
      errorCode = errData?.error?.code || ''
      errorParam = errData?.error?.param || ''
      // 민감정보가 포함될 수 있는 원문 메시지는 로그에 남기지 않음
    } catch {
      // JSON 파싱 실패 시 상태 코드만 사용
    }
    const err = new Error(`groq ${res.status}`) as any
    err.code = res.status
    err.errorType = errorType
    err.errorCode = errorCode
    err.errorParam = errorParam
    // 400은 재시도 불가능한 요청 오류로 표시
    if (res.status === 400) {
      err.retryable = false
    }
    throw err
  }
  const data = (await res.json()) as any
  const msg = data.choices?.[0]?.message

  return {
    text: msg?.content ?? '',
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  }
}

// P0-4: NVIDIA 오류 분류
type ProviderErrorKind =
  | "model_capacity"
  | "rate_limited"
  | "authentication_failed"
  | "access_denied"
  | "invalid_request"
  | "model_unavailable"
  | "provider_transient"
  | "timeout"
  | "unknown";

function classifyNvidiaFailure(status: number, message: string): ProviderErrorKind {
  const normalized = message.toLowerCase();
  if (
    status === 503 &&
    normalized.includes("resourceexhausted") &&
    normalized.includes("worker local total request limit reached")
  ) {
    return "model_capacity";
  }
  if (status === 429) return "rate_limited";
  if (status === 401) return "authentication_failed";
  if (status === 403) return "access_denied";
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 404) return "model_unavailable";
  if (status >= 500) return "provider_transient";
  return "unknown";
}

/**
 * Nemotron 추론 블록 제거 (2026-10-26 라이브 실측).
 * - NIM이 chat_template_kwargs 없이 호출되면(뉴스처럼 FC 도구가 없는 경로),
 *   모델의 추론이 <think>...</think> 블록째로 content에 들어온다.
 *   실측 응답은 추론 본문 + "</think>" + 답변 형태였다 (여는 태그 없이
 *   닫는 태그만 남은 경우도 있음).
 * - reasoning_content 필드는 별도라 content에 합치지 않는다 (읽지 않음).
 * - 정당한 답변에는 <think> 태그가 없으므로, 태그가 보이면 그 부분은
 *   추론으로 보고 제거한다. 빈 문자열이 되면 그대로 반환한다.
 */
export function stripThinkingBlocks(text: string): string {
  if (!text) return text
  let out = text
  // <think>...</think> 쌍 제거 (여러 개 가능)
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, '')
  // 닫는 태그만 남은 경우: 그 앞까지가 추론이므로 태그 포함 앞부분 제거
  const closeIdx = out.toLowerCase().lastIndexOf('</think>')
  if (closeIdx >= 0) out = out.slice(closeIdx + '</think>'.length)
  // 열린 태그만 남은 경우: 그 뒤는 추론이므로 제거
  const openIdx = out.toLowerCase().indexOf('<think>')
  if (openIdx >= 0) out = out.slice(0, openIdx)
  return out.trim()
}

export async function callNVIDIA(key: string, model: string, messages: ChatMessage[], tools?: any[], signal?: AbortSignal): Promise<{ text: string; toolCalls?: any[]; finishReason?: string; inputTokens?: number; outputTokens?: number }> {
  // NVIDIA NIM — OpenAI 호환 API (노바 전용)
  // P1: Native Function Calling 지원 (tools 파라미터)
  // - 도구 형식은 prepareToolsFor('nvidia')로 OpenAI 형식으로 변환한다
  //   (bare {name, description, parameters}는 NVIDIA가 무시하거나 거부함).
  // - Nemotron 3 Ultra는 추론 모델이라 tools가 있을 때
  //   chat_template_kwargs(enable_thinking + force_nonempty_content)를
  //   보내야 tool call 파싱이 된다 (NVIDIA 공식 문서·모델카드).
  const body: any = { model, messages, temperature: 0.1, max_tokens: 4096 }
  if (tools && tools.length > 0) {
    body.tools = prepareToolsFor('nvidia', tools)
    body.tool_choice = 'auto'
    body.chat_template_kwargs = { enable_thinking: true, force_nonempty_content: true }
  }
  const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(180000),
  })
  if (res.status === 429) throw Object.assign(new Error('rate_limited'), { code: 429 })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    const kind = classifyNvidiaFailure(res.status, errBody)
    console.error('nvidia_error_classified', { status: res.status, kind, model })
    throw Object.assign(new Error(`nvidia ${res.status}: ${errBody.slice(0, 200)}`), { code: res.status, kind })
  }
  const data = (await res.json()) as any
  const msg = data.choices?.[0]?.message
  return {
    text: stripThinkingBlocks(msg?.content ?? ''),
    toolCalls: msg?.tool_calls || undefined,
    finishReason: data.choices?.[0]?.finish_reason,
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  }
}

export async function callWorkersAI(
  env: Env,
  model: string,
  messages: ChatMessage[],
  tools?: any[],
  signal?: AbortSignal
): Promise<{ text: string; toolCalls?: any[]; inputTokens?: number; outputTokens?: number; neurons?: number }> {
  const ai = (env as any).AI
  if (!ai) throw new Error('workers-ai binding missing')

  const params: any = { messages, max_tokens: 2048 }
  if (tools && tools.length > 0) {
    params.tools = prepareToolsFor('workers-ai', tools)
  }

  const out = (await ai.run(model, params, AI_GATEWAY_OPTIONS)) as any

  // Function Calling 응답 처리
  const toolCalls = out?.tool_calls || out?.toolCalls || []

  const text = typeof out?.response === 'string' ? out.response : JSON.stringify(out?.response ?? '')
  // 사용량 패스스루 (2026-10-30): 이전에는 응답 usage를 버려 ai_usage의
  // workers-ai 행 토큰이 전부 NULL이었고 뉴런 소비를 사후 감사할 수 없었다.
  // 다른 프로바이더와 같은 방식으로 토큰을, 추가로 뉴런을 함께 반환한다
  // (usage.neurons는 공식 단가 역산과 소수점까지 일치함을 실측으로 확인 —
  // docs/nvidia-replacement-measurement-20261030.md §2).
  return {
    text,
    toolCalls: Array.isArray(toolCalls) ? toolCalls : [],
    inputTokens: out?.usage?.prompt_tokens,
    outputTokens: out?.usage?.completion_tokens,
    neurons: out?.usage?.neurons,
  }
}
