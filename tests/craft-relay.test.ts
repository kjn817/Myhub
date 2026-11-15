/**
 * Craft 릴레이 테스트 (Phase 0 스파이크).
 *
 * 검증하는 성질:
 * - 인증: ORIGIN_SECRET Bearer만 통과, 미설정 시 비활성화(fail-closed)
 * - 모델 allowlist: 허용 모델만 상류로 나가고, craft-anything 기본값인
 *   gemini-3.8-flash(실측 전멸) 같은 목록 밖 모델은 400으로 차단
 * - 키 주입: 상류 Authorization은 풀의 실제 키이지 릴레이 시크릿이 아님
 * - NVIDIA: tools가 있을 때 chat_template_kwargs 주입 (없으면 미주입)
 * - 429: 해당 키를 쿨다운한다 (ai.ts와 같은 규칙)
 * - workers-ai: env.AI.run 결과를 OpenAI SSE/JSON으로 합성
 * - 비밀 누출 없음: 응답에 풀 키·ORIGIN_SECRET이 포함되지 않는다
 *
 * 키 풀은 모듈 전역 캐시라 이 파일 안에서만 더미 키를 쓴다 (Jest는 파일별
 * 프로세스 격리). 실제 키 값은 테스트에 없다.
 */
import {
  CRAFT_RELAY_PROVIDERS,
  buildUpstreamRequest,
  coolKeyOnRateLimit,
  handleChatCompletions,
  handleModels,
  isAllowedModel,
  openAiCompletionFromAiRun,
  relayAuth,
  synthesizeOpenAiSse,
} from '../src/modules/craft/relay'
import { getPool } from '../src/services/ai-key-pool'
import { craftApp } from '../src/modules/craft/routes'
import type { Env } from '../src/types'

const RELAY_SECRET = 'test-origin-secret-do-not-use'
const GEMINI_KEY = 'test-gemini-key-1'
const GROQ_KEY = 'test-groq-key-1'
const NVIDIA_KEY = 'test-nvidia-key-1'

function testEnv(extra: Partial<Env> = {}): Env {
  return {
    ORIGIN_SECRET: RELAY_SECRET,
    GEMINI_API_KEY_1: GEMINI_KEY,
    GEMINI_API_KEY_2: 'test-gemini-key-2',
    GEMINI_API_KEY_3: 'test-gemini-key-3',
    GEMINI_API_KEY_4: 'test-gemini-key-4',
    GROQ_API_KEY_1: GROQ_KEY,
    GROQ_API_KEY_2: 'test-groq-key-2',
    GROQ_API_KEY_3: 'test-groq-key-3',
    GROQ_API_KEY_4: 'test-groq-key-4',
    NVIDIA_API_KEY_1: NVIDIA_KEY,
    NVIDIA_API_KEY_2: 'test-nvidia-key-2',
    NVIDIA_API_KEY_3: 'test-nvidia-key-3',
    NVIDIA_API_KEY_4: 'test-nvidia-key-4',
    ...extra,
  } as Env
}

function sseResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

describe('relayAuth', () => {
  it('정확한 Bearer면 ok, 틀리면 unauthorized, 없으면 unauthorized', () => {
    const env = testEnv()
    expect(relayAuth(env, `Bearer ${RELAY_SECRET}`)).toBe('ok')
    expect(relayAuth(env, 'Bearer wrong-secret')).toBe('unauthorized')
    expect(relayAuth(env, undefined)).toBe('unauthorized')
    expect(relayAuth(env, '')).toBe('unauthorized')
    expect(relayAuth(env, RELAY_SECRET)).toBe('unauthorized') // Bearer 접두사 없음
  })

  it('ORIGIN_SECRET 미설정 시 disabled (fail-closed)', () => {
    const env = testEnv({ ORIGIN_SECRET: undefined })
    expect(relayAuth(env, `Bearer ${RELAY_SECRET}`)).toBe('disabled')
  })
})

describe('모델 allowlist', () => {
  it('프로바이더별 허용 모델만 통과', () => {
    expect(isAllowedModel('gemini', 'gemini-3.1-flash-lite')).toBe(true)
    expect(isAllowedModel('gemini', 'gemini-3.5-flash-lite')).toBe(true)
    expect(isAllowedModel('groq', 'openai/gpt-oss-120b')).toBe(true)
    expect(isAllowedModel('nvidia', 'nvidia/nemotron-3-ultra-550b-a55b')).toBe(true)
    expect(isAllowedModel('workers-ai', '@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toBe(true)
  })

  it('craft-anything 기본값 gemini-3.8-flash(실측 전멸)는 차단', () => {
    expect(isAllowedModel('gemini', 'gemini-3.8-flash')).toBe(false)
    expect(isAllowedModel('gemini', 'gemini-4-argon')).toBe(false)
  })

  it('종료된 Groq 모델·타 프로바이더 모델·미지정은 차단', () => {
    expect(isAllowedModel('groq', 'llama-3.3-70b-versatile')).toBe(false) // 2026-08-16 종료
    expect(isAllowedModel('groq', 'openai/gpt-oss-120b')).toBe(true)
    expect(isAllowedModel('groq', 'gemini-3.1-flash-lite')).toBe(false)
    expect(isAllowedModel('gemini', undefined)).toBe(false)
    expect(isAllowedModel('workers-ai', '@cf/qwen/qwen3-30b-a3b-fp8')).toBe(false) // FC 할루시네이션으로 제외
  })
})

describe('buildUpstreamRequest', () => {
  it('gemini 상류는 OpenAI 호환 엔드포인트이지 :generateContent가 아니다', () => {
    const { url, init } = buildUpstreamRequest('gemini', 'k', '/chat/completions', { model: 'gemini-3.1-flash-lite' })
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
    expect(url).not.toContain('generateContent')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k')
    expect(init.method).toBe('POST')
  })

  it('groq/nvidia 상류 URL이 맞다', () => {
    expect(buildUpstreamRequest('groq', 'k', '/chat/completions', { model: 'x' }).url).toBe(
      'https://api.groq.com/openai/v1/chat/completions',
    )
    expect(buildUpstreamRequest('nvidia', 'k', '/models', null).url).toBe('https://integrate.api.nvidia.com/v1/models')
    expect(buildUpstreamRequest('nvidia', 'k', '/models', null).init.method).toBe('GET')
  })

  it('NVIDIA + tools면 chat_template_kwargs를 주입하고, 없으면 주입하지 않는다', () => {
    const withTools = buildUpstreamRequest('nvidia', 'k', '/chat/completions', {
      model: 'nvidia/nemotron-3-ultra-550b-a55b',
      tools: [{ type: 'function', function: { name: 't' } }],
    })
    const parsed = JSON.parse(withTools.init.body as string)
    expect(parsed.chat_template_kwargs).toEqual({ enable_thinking: true, force_nonempty_content: true })

    const withoutTools = buildUpstreamRequest('nvidia', 'k', '/chat/completions', { model: 'nvidia/nemotron-3-ultra-550b-a55b' })
    expect(JSON.parse(withoutTools.init.body as string).chat_template_kwargs).toBeUndefined()

    const groq = buildUpstreamRequest('groq', 'k', '/chat/completions', {
      model: 'openai/gpt-oss-120b',
      tools: [{ type: 'function', function: { name: 't' } }],
    })
    expect(JSON.parse(groq.init.body as string).chat_template_kwargs).toBeUndefined()
  })

  it('workers-ai는 HTTP 프로바이더가 아니라 예외를 던진다', () => {
    expect(() => buildUpstreamRequest('workers-ai', 'k', '/chat/completions', {})).toThrow()
  })
})

describe('handleChatCompletions (HTTP 프로바이더, fetch 목)', () => {
  it('상류에 풀 키로 Authorization을 달아 보내고 SSE 본문을 그대로 돌려준다', async () => {
    const env = testEnv()
    const upstreamBody = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
    const fetchFn = jest.fn(async (_url: string, _init?: RequestInit) => sseResponse(upstreamBody))
    const res = await handleChatCompletions(
      env,
      'groq',
      { model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }], stream: true },
      fetchFn as unknown as typeof fetch,
    )
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions')
    const headers = init.headers as Record<string, string>
    // 상류 Authorization은 풀 키(GROQ_API_KEY_*)이지 릴레이 시크릿이 아니다
    expect(headers.Authorization).toMatch(/^Bearer test-groq-key-[1-4]$/)
    expect(headers.Authorization).not.toContain(RELAY_SECRET)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toBe(upstreamBody)
    // 응답에 어떤 키도 새지 않는다
    expect(text).not.toContain(GROQ_KEY)
    expect(text).not.toContain(RELAY_SECRET)
  })

  it('허용 밖 모델은 상류 호출 없이 400', async () => {
    const env = testEnv()
    const fetchFn = jest.fn(async () => sseResponse(''))
    const res = await handleChatCompletions(env, 'gemini', { model: 'gemini-3.8-flash', messages: [] }, fetchFn as unknown as typeof fetch)
    expect(res.status).toBe(400)
    expect(fetchFn).not.toHaveBeenCalled()
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('model_not_allowed')
  })

  it('상류 429면 키가 쿨다운되고 429가 그대로 전달된다', async () => {
    const env = testEnv()
    const poolBefore = getPool(env, 'nvidia')
    const cooledBefore = poolBefore.filter((k) => k.cooledUntil > Date.now()).length
    const fetchFn = jest.fn(async () => new Response('rate limited', { status: 429 }))
    const res = await handleChatCompletions(
      env,
      'nvidia',
      { model: 'nvidia/nemotron-3-ultra-550b-a55b', messages: [] },
      fetchFn as unknown as typeof fetch,
    )
    expect(res.status).toBe(429)
    const poolAfter = getPool(env, 'nvidia')
    const cooledAfter = poolAfter.filter((k) => k.cooledUntil > Date.now()).length
    expect(cooledAfter).toBe(cooledBefore + 1)
    expect(poolAfter.some((k) => k.failures > 0)).toBe(true)
  })

  it('상류 도달 불가면 502', async () => {
    const env = testEnv()
    const fetchFn = jest.fn(async () => {
      throw new Error('connect failed')
    })
    const res = await handleChatCompletions(env, 'gemini', { model: 'gemini-3.1-flash-lite', messages: [] }, fetchFn as unknown as typeof fetch)
    expect(res.status).toBe(502)
  })
})

describe('coolKeyOnRateLimit', () => {
  it('failures를 올리고 60초 쿨다운을 건다', () => {
    const ks = { key: 'k', failures: 0, cooledUntil: 0 }
    coolKeyOnRateLimit(ks)
    expect(ks.failures).toBe(1)
    expect(ks.cooledUntil).toBeGreaterThan(Date.now())
    expect(ks.cooledUntil - Date.now()).toBeLessThanOrEqual(60_000)
  })
})

describe('workers-ai 경로 (env.AI 바인딩 목)', () => {
  function aiEnv(run: (model: string, params: Record<string, unknown>) => Promise<unknown>): Env {
    return testEnv({ AI: { run } } as unknown as Partial<Env>)
  }

  it('stream:true면 content + tool_calls + [DONE] SSE를 합성한다', async () => {
    const env = aiEnv(async () => ({
      response: 'built it',
      tool_calls: [{ id: 'call_1', name: 'build_file_write', arguments: { path: 'index.html' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }))
    const res = await handleChatCompletions(env, 'workers-ai', {
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      messages: [{ role: 'user', content: 'build' }],
      stream: true,
      tools: [{ type: 'function', function: { name: 'build_file_write' } }],
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('"content":"built it"')
    expect(text).toContain('"name":"build_file_write"')
    expect(text).toContain('"finish_reason":"tool_calls"')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
    // SSE 각 줄이 유효한 JSON이다 (CLI 파서가 먹는 형식)
    for (const line of text.split('\n').filter((l) => l.startsWith('data: {'))) {
      expect(() => JSON.parse(line.slice(6))).not.toThrow()
    }
  })

  it('tool_calls가 없으면 finish_reason stop', async () => {
    const env = aiEnv(async () => ({ response: 'done', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    const res = await handleChatCompletions(env, 'workers-ai', {
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      messages: [],
      stream: true,
    })
    const text = await res.text()
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).not.toContain('tool_calls')
  })

  it('stream:false면 OpenAI chat.completion JSON을 돌려준다', async () => {
    const env = aiEnv(async () => ({ response: 'ok', tool_calls: [] }))
    const res = await handleChatCompletions(env, 'workers-ai', {
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      messages: [],
      stream: false,
    })
    const json = (await res.json()) as { object: string; choices: Array<{ message: { content: string }; finish_reason: string }> }
    expect(json.object).toBe('chat.completion')
    expect(json.choices[0].message.content).toBe('ok')
    expect(json.choices[0].finish_reason).toBe('stop')
  })

  it('max_tokens 미지정 시 8192를 ai.run에 넘긴다 (빌더는 2048로 부족)', async () => {
    let seen: Record<string, unknown> = {}
    const env = aiEnv(async (_m, params) => {
      seen = params
      return { response: '' }
    })
    await handleChatCompletions(env, 'workers-ai', {
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      messages: [],
    })
    expect(seen.max_tokens).toBe(8192)
  })

  it('AI 바인딩이 없으면 503', async () => {
    const res = await handleChatCompletions(testEnv(), 'workers-ai', {
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      messages: [],
    })
    expect(res.status).toBe(503)
  })
})

describe('synthesizeOpenAiSse / openAiCompletionFromAiRun (순수 함수)', () => {
  it('SSE는 content 청크·finish 청크·[DONE] 순서이며 OpenAI 필드를 갖는다', () => {
    const sse = synthesizeOpenAiSse({ response: 'x', usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }, 'm')
    const events = sse.split('\n\n').filter(Boolean)
    expect(events[events.length - 1]).toBe('data: [DONE]')
    const first = JSON.parse(events[0].slice(6))
    expect(first.object).toBe('chat.completion.chunk')
    expect(first.choices[0].delta.content).toBe('x')
    const last = JSON.parse(events[events.length - 2].slice(6))
    expect(last.choices[0].finish_reason).toBe('stop')
    expect(last.usage.total_tokens).toBe(5)
  })

  it('OpenAI 형식 tool_calls(function 래퍼)도 정규화된다', () => {
    const json = openAiCompletionFromAiRun(
      { response: '', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }] },
      'm',
    ) as { choices: Array<{ message: { tool_calls: Array<{ function: { name: string; arguments: string } }> }; finish_reason: string }> }
    expect(json.choices[0].message.tool_calls[0].function.name).toBe('f')
    expect(json.choices[0].message.tool_calls[0].function.arguments).toBe('{"a":1}')
    expect(json.choices[0].finish_reason).toBe('tool_calls')
  })
})

describe('handleModels', () => {
  it('workers-ai는 허용 목록을 그대로 돌려준다 (상류 호출 없음)', async () => {
    const fetchFn = jest.fn(async () => new Response('{}'))
    const res = await handleModels(testEnv(), 'workers-ai', fetchFn as unknown as typeof fetch)
    expect(fetchFn).not.toHaveBeenCalled()
    const json = (await res.json()) as { object: string; data: Array<{ id: string }> }
    expect(json.object).toBe('list')
    expect(json.data.map((d) => d.id)).toEqual([...CRAFT_RELAY_PROVIDERS['workers-ai'].models])
  })

  it('HTTP 프로바이더는 상류 /models를 조회한다', async () => {
    const fetchFn = jest.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ object: 'list', data: [] }), { headers: { 'content-type': 'application/json' } }))
    const res = await handleModels(testEnv(), 'groq', fetchFn as unknown as typeof fetch)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect((fetchFn.mock.calls[0] as [string, unknown])[0]).toBe('https://api.groq.com/openai/v1/models')
    expect(res.status).toBe(200)
  })
})

describe('craftApp 라우트 (Hono, env 주입)', () => {
  const env = testEnv()
  const url = '/relay/groq/chat/completions'

  it('Bearer 없으면 401, 틀리면 401', async () => {
    const noAuth = await craftApp.request(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [] }) },
      env as unknown as Env,
    )
    expect(noAuth.status).toBe(401)
    const wrong = await craftApp.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
        body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [] }),
      },
      env as unknown as Env,
    )
    expect(wrong.status).toBe(401)
  })

  it('알 수 없는 프로바이더는 404', async () => {
    const res = await craftApp.request(
      '/relay/openai/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RELAY_SECRET}` },
        body: JSON.stringify({ model: 'gpt-5', messages: [] }),
      },
      env as unknown as Env,
    )
    expect(res.status).toBe(404)
  })

  it('JSON이 아니면 400', async () => {
    const res = await craftApp.request(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RELAY_SECRET}` }, body: 'not-json{' },
      env as unknown as Env,
    )
    expect(res.status).toBe(400)
  })

  it('정상 요청은 핸들러로 연결된다 (전역 fetch 목)', async () => {
    const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      sseResponse('data: {"ok":1}\n\ndata: [DONE]\n\n'),
    )
    try {
      const res = await craftApp.request(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RELAY_SECRET}` },
          body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [], stream: true }),
        },
        env as unknown as Env,
      )
      expect(res.status).toBe(200)
      expect(spy).toHaveBeenCalledTimes(1)
      expect((await res.text()).trimEnd().endsWith('data: [DONE]')).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})
