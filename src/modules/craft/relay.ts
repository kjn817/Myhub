/**
 * Craft Anything 빌더 백엔드 릴레이 (Phase 0 스파이크, 2026-11-15).
 *
 * craft-anything CLI는 오라클 A1 호스트에서 돌고, 모델 키는 Worker Secrets
 * 안에만 있다. CLI가 키 값을 절대 보지 못하게, Worker가 키를 서버 사이드에서
 * 주입하는 OpenAI 호환 릴레이를 둔다:
 *
 *   CLI (base URL) ──► Worker /api/craft/relay/<provider>/... ──► 프로바이더
 *     Authorization: Bearer <ORIGIN_SECRET>     Authorization: Bearer <실제 키>
 *
 * - 인증: CLI가 보내는 Bearer는 ORIGIN_SECRET(Worker·사이드카가 이미 공유하는
 *   값). 값 자체는 Worker env에서만 대조하고, 로그·응답에 절대 남기지 않는다.
 *   Phase 1에서는 전용 CRAFT_RELAY_SECRET 분리를 권장한다 (게이트 분리).
 * - 전역 /api/* 세션 미들웨어는 /api/craft/relay/를 면제한다 (src/index.ts,
 *   /api/mcp·/api/channel/webhook/과 같은 선례) — CLI는 세션 쿠키를 못 보낸다.
 * - 프로바이더별 허용 모델만 통과한다 (fail-closed 400). 모델이 없는 요청은
 *   상류로 나가지 않는다.
 * - gemini/groq/nvidia는 HTTP 패스스루(스트리밍 SSE 그대로 전달).
 *   workers-ai는 env.AI 바인딩으로 호출하고 OpenAI 형식 SSE로 합성해 돌려준다
 *   (HTTP 토큰이 필요 없고, Workers AI 네이티브 스트림 형식에 의존하지 않는다).
 * - NVIDIA Nemotron은 추론 모델이라 tools가 있을 때 chat_template_kwargs를
 *   넣어줘야 tool call 파싱이 된다 (ai-provider-calls.ts의 실측 주석과 동일).
 *   CLI는 이 필드를 안 보내므로 릴레이가 주입한다.
 * - Groq는 비서 배정에서는 '캘리만'이었으나 2026-11-15 사용자 지시로 AI Studio
 *   빌더 백엔드로 명시 확대됐다. NVIDIA는 개인정보 미전송 규칙 유지 —
 *   Deep 모드/사용자 프로그램 분석 프롬프트는 Privacy Engine 경유가 필수이며,
 *   이 릴레이는 그 판정을 하지 않는다 (호출 전단에서 게이트할 것).
 */

import { getPool, pickKey, pickKeyForModel, type KeyState } from '../../services/ai-key-pool'
import { DEFAULT_MODEL_ID } from '../../services/ai-models'
import { secretsEqual } from '../../services/channel-gateway'
import type { Env } from '../../types'

export const CRAFT_RELAY_MOUNT = '/api/craft/relay'

export type CraftRelayProvider = 'gemini' | 'groq' | 'nvidia' | 'workers-ai'

interface HttpProviderDef {
  kind: 'http'
  upstream: string
  pool: 'gemini' | 'groq' | 'nvidia'
  models: readonly string[]
}

interface BindingProviderDef {
  kind: 'binding'
  models: readonly string[]
}

type ProviderDef = HttpProviderDef | BindingProviderDef

/**
 * 프로바이더별 상류·허용 모델. 모델은 MyHub 실측 기준(active)만 둔다.
 * - gemini-3.5-flash-lite: D1 model.code (ai-models.ts 목록 밖이지만 운영 코드 모델).
 * - gemini-3.8-flash는 craft-anything 기본값이지만 2026-10-13 실측 전멸 — 절대 제외.
 * - llama-3.3-70b-versatile는 Groq에서 2026-08-16 종료 — gpt-oss-120b가 대체.
 * - qwen3-30b는 function calling 할루시네이션으로 빌더 부적합 (ai-models.ts:36) — 제외.
 */
export const CRAFT_RELAY_PROVIDERS: Record<CraftRelayProvider, ProviderDef> = {
  gemini: {
    kind: 'http',
    upstream: 'https://generativelanguage.googleapis.com/v1beta/openai',
    pool: 'gemini',
    models: ['gemini-3.1-flash-lite', 'gemini-2.5-flash', DEFAULT_MODEL_ID],
  },
  groq: {
    kind: 'http',
    upstream: 'https://api.groq.com/openai/v1',
    pool: 'groq',
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  },
  nvidia: {
    kind: 'http',
    upstream: 'https://integrate.api.nvidia.com/v1',
    pool: 'nvidia',
    models: ['nvidia/nemotron-3-ultra-550b-a55b'],
  },
  'workers-ai': {
    kind: 'binding',
    models: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/mistralai/mistral-small-3.1-24b-instruct'],
  },
}

export function isCraftRelayProvider(name: string): name is CraftRelayProvider {
  return name in CRAFT_RELAY_PROVIDERS
}

export type RelayAuthResult = 'ok' | 'disabled' | 'unauthorized'

/** 릴레이 인증: Bearer == ORIGIN_SECRET (상수 시간 비교). 미설정 시 비활성화. */
export function relayAuth(env: Env, authHeader: string | null | undefined): RelayAuthResult {
  const configured = env.ORIGIN_SECRET
  if (!configured) return 'disabled'
  const m = /^Bearer\s+(.+)$/i.exec(authHeader ?? '')
  if (!m) return 'unauthorized'
  return secretsEqual(m[1].trim(), configured) ? 'ok' : 'unauthorized'
}

/** 허용 모델인지 확인 (모델 미지정·목록 밖은 상류로 보내지 않는다). */
export function isAllowedModel(provider: CraftRelayProvider, model: unknown): model is string {
  return typeof model === 'string' && (CRAFT_RELAY_PROVIDERS[provider].models as readonly string[]).includes(model)
}

/**
 * HTTP 프로바이더 상류 요청 조립 (순수 함수 — 테스트용).
 * NVIDIA는 tools가 있을 때 chat_template_kwargs를 주입한다.
 */
export function buildUpstreamRequest(
  provider: CraftRelayProvider,
  key: string,
  path: string,
  body: Record<string, unknown> | null,
): { url: string; init: RequestInit } {
  const def = CRAFT_RELAY_PROVIDERS[provider]
  if (def.kind !== 'http') throw new Error(`provider ${provider} is not an HTTP provider`)
  const upstreamBody: Record<string, unknown> = body ? { ...body } : {}
  if (
    provider === 'nvidia' &&
    Array.isArray(upstreamBody.tools) &&
    upstreamBody.tools.length > 0 &&
    !upstreamBody.chat_template_kwargs
  ) {
    upstreamBody.chat_template_kwargs = { enable_thinking: true, force_nonempty_content: true }
  }
  return {
    url: `${def.upstream}${path}`,
    init: {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(upstreamBody) : undefined,
    },
  }
}

/** 키 풀에서 키 선택 (gemini는 모델별 제한을 존중한다). */
export function pickRelayKey(env: Env, provider: CraftRelayProvider, model: string): KeyState | null {
  const def = CRAFT_RELAY_PROVIDERS[provider]
  if (def.kind !== 'http') return null
  const pool = getPool(env, def.pool)
  return def.pool === 'gemini' ? pickKeyForModel(pool, model) : pickKey(pool)
}

/** 상류 429 시 키 쿨다운 (ai.ts와 같은 규칙: 60초). */
export function coolKeyOnRateLimit(ks: KeyState): void {
  ks.failures++
  ks.cooledUntil = Date.now() + 60_000
}

// ---------------------------------------------------------------------------
// Workers AI 바인딩 경로 (env.AI.run → OpenAI 형식 응답 합성)
// ---------------------------------------------------------------------------

export interface WorkersAiRunResult {
  response?: unknown
  tool_calls?: Array<{ id?: string; name?: string; arguments?: unknown; function?: { name?: string; arguments?: string } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

function normalizeToolCalls(
  raw: WorkersAiRunResult['tool_calls'],
): Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> {
  if (!Array.isArray(raw)) return []
  return raw
    .map((tc, i) => {
      const name = tc.function?.name ?? tc.name ?? ''
      if (!name) return null
      const args = tc.function?.arguments ?? tc.arguments
      return {
        id: tc.id ?? `call_${i}`,
        type: 'function' as const,
        function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) },
      }
    })
    .filter((tc): tc is NonNullable<typeof tc> => tc !== null)
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/**
 * ai.run 결과를 OpenAI 스트리밍 SSE로 합성한다. CLI는 항상 stream:true를
 * 보내므로 이 형식이 기본 경로다. 단일 content 청크 + tool_calls 청크 +
 * finish 청크(usage 포함) + [DONE] 순이다.
 */
export function synthesizeOpenAiSse(result: WorkersAiRunResult, model: string): string {
  const id = `chatcmpl-craft-${Date.now().toString(36)}`
  const created = Math.floor(Date.now() / 1000)
  const text = typeof result.response === 'string' ? result.response : result.response == null ? '' : JSON.stringify(result.response)
  const toolCalls = normalizeToolCalls(result.tool_calls)
  const chunks: string[] = []
  if (text) {
    chunks.push(
      sseData({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }),
    )
  }
  if (toolCalls.length > 0) {
    chunks.push(
      sseData({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
      }),
    )
  }
  chunks.push(
    sseData({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop' }],
      usage: result.usage ?? null,
    }),
  )
  return `${chunks.join('')}data: [DONE]\n\n`
}

/** stream:false 요청용 OpenAI chat.completion JSON. */
export function openAiCompletionFromAiRun(result: WorkersAiRunResult, model: string): Record<string, unknown> {
  const text = typeof result.response === 'string' ? result.response : result.response == null ? '' : JSON.stringify(result.response)
  const toolCalls = normalizeToolCalls(result.tool_calls)
  const message: Record<string, unknown> = { role: 'assistant', content: text }
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  return {
    id: `chatcmpl-craft-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop' }],
    usage: result.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

/**
 * POST /chat/completions 처리. fetchFn 주입으로 테스트 가능.
 * - HTTP 프로바이더: 상류 응답(스트림 포함)을 그대로 반환한다.
 * - workers-ai: env.AI.run 후 SSE/JSON 합성.
 */
export async function handleChatCompletions(
  env: Env,
  provider: CraftRelayProvider,
  body: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const def = CRAFT_RELAY_PROVIDERS[provider]
  const model = body.model
  if (!isAllowedModel(provider, model)) {
    return Response.json({ ok: false, error: 'model_not_allowed', message: `model ${String(model)} is not allowed for ${provider}` }, { status: 400 })
  }
  if (def.kind === 'binding') {
    const ai = (env as Env & { AI?: { run(model: string, params: Record<string, unknown>): Promise<WorkersAiRunResult> } }).AI
    if (!ai) return Response.json({ ok: false, error: 'workers_ai_binding_missing' }, { status: 503 })
    const params: Record<string, unknown> = {
      messages: body.messages,
      max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : 8192,
    }
    if (Array.isArray(body.tools) && body.tools.length > 0) params.tools = body.tools
    if (typeof body.temperature === 'number') params.temperature = body.temperature
    let result: WorkersAiRunResult
    try {
      result = await ai.run(model, params)
    } catch (e) {
      return Response.json({ ok: false, error: 'workers_ai_failed', message: e instanceof Error ? e.message : String(e) }, { status: 502 })
    }
    if (body.stream) {
      return new Response(synthesizeOpenAiSse(result, model), {
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
      })
    }
    return Response.json(openAiCompletionFromAiRun(result, model))
  }
  const ks = pickRelayKey(env, provider, model)
  if (!ks) return Response.json({ ok: false, error: 'no_key_available', message: `no ${provider} key available` }, { status: 429 })
  const { url, init } = buildUpstreamRequest(provider, ks.key, '/chat/completions', body)
  let upstream: Response
  try {
    upstream = await fetchFn(url, init)
  } catch (e) {
    return Response.json({ ok: false, error: 'upstream_unreachable', message: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
  if (upstream.status === 429) {
    coolKeyOnRateLimit(ks)
  } else if (upstream.ok) {
    ks.failures = 0
  }
  const headers = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) headers.set('content-type', ct)
  return new Response(upstream.body, { status: upstream.status, headers })
}

/** GET /models 처리 — HTTP 프로바이더는 상류 조회, workers-ai는 허용 목록. */
export async function handleModels(
  env: Env,
  provider: CraftRelayProvider,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const def = CRAFT_RELAY_PROVIDERS[provider]
  if (def.kind === 'binding') {
    return Response.json({
      object: 'list',
      data: def.models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'workers-ai' })),
    })
  }
  const ks = pickRelayKey(env, provider, def.models[0])
  if (!ks) return Response.json({ ok: false, error: 'no_key_available' }, { status: 429 })
  const { url, init } = buildUpstreamRequest(provider, ks.key, '/models', null)
  let upstream: Response
  try {
    upstream = await fetchFn(url, init)
  } catch (e) {
    return Response.json({ ok: false, error: 'upstream_unreachable', message: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
  if (upstream.status === 429) coolKeyOnRateLimit(ks)
  const headers = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) headers.set('content-type', ct)
  return new Response(upstream.body, { status: upstream.status, headers })
}
