/// <reference types="jest" />
/**
 * 최종 커버리지 마무리 — 전체 99% 달성을 위한 남은 구멍 메우기.
 * - 새 파일 1개로만 작업 (기존 파일·프로덕션 코드 수정 없음).
 * - 각 테스트는 실제 동작을 검증하는 의미 있는 assert만 둔다.
 * - 도달 불가로 판단한 라인은 파일 하단 주석(UNREACHABLE 목록)에 기록한다.
 * - 기준: HEAD 4f70b75 (에코 뉴스 신선도 후속 수정). news-summary.ts 라인 번호는
 *   4f70b75 기준으로 이동됨 (Number.isNaN 93→128, validateItemSources 238-243→275-281,
 *   attachMissingSources 293→331).
 */
import { Hono } from 'hono'
import { z } from 'zod'

// ---- jest.mock (import보다 먼저 — 팩토리에서 참조하는 목 fn은 여기서 정의) ----
const mockGetSetting = jest.fn()
const mockControllerCtor = jest.fn()
const mockControllerExecute = jest.fn()

jest.mock('../../src/services/ai', () => ({
  ...jest.requireActual('../../src/services/ai'),
  getSetting: (...args: any[]) => mockGetSetting(...args),
}))
jest.mock('../../src/ai/fallback-controller', () => ({
  FallbackController: jest.fn().mockImplementation((opts: any) => {
    mockControllerCtor(opts)
    return { execute: mockControllerExecute }
  }),
}))
jest.mock('../../src/services/studio-agent', () => ({
  ...jest.requireActual('../../src/services/studio-agent'),
  runStudioAgent: jest.fn(),
}))
jest.mock('../../src/modules/artifact/generate-html', () => ({
  generateArtifactHtml: jest.fn(),
}))
jest.mock('../../src/services/crypto', () => ({
  encryptContent: jest.fn(),
  decryptContent: jest.fn(),
  encryptBytes: jest.fn(),
  decryptBytes: jest.fn(),
  isEncrypted: jest.fn(),
}))
jest.mock('../../src/services/storage', () => ({
  storageUpload: jest.fn(),
  storageDestroy: jest.fn(),
  thumbUrl: jest.fn(),
}))
jest.mock('../../src/events', () => ({
  emit: jest.fn(),
}))

import { aiChat, MODELS, __test } from '../../src/services/ai'
import { getProvider } from '../../src/services/provider-registry'
import { chatWithFunctionCalling } from '../../src/ai/function-calling-route'
import { GeminiAdapter } from '../../src/ai/providers/gemini'
import { ProviderError } from '../../src/ai/types'
import { getAssistantHandler } from '../../src/services/channel-gateway'
import '../../src/modules'
import { processArtifactJob, generateHtml } from '../../src/modules/artifact/job-processor'
import { runStudioAgent, distillMessages } from '../../src/services/studio-agent'
import { generateArtifactHtml } from '../../src/modules/artifact/generate-html'
import { artifactApp } from '../../src/modules/artifact/routes'
import {
  authApp, verifyPassword, bumpSessionVersion, verifySessionInfo, hashPassword, hashPin,
} from '../../src/modules/auth/routes'
import { memoApp } from '../../src/modules/memo/routes'
import memoryApp from '../../src/modules/memory/routes'
import {
  verifyStepResult, runStepName, runTeam, type TeamDeps, type TeamPlan,
} from '../../src/services/agent-team'
import { isKnownPersona, ToolApprovalStore } from '../../src/services/tool-approval'
import { buildSkillLoad } from '../../src/services/skill-registry'
import { runReminderTick, buildScheduleReminderWorkflow } from '../../src/services/reminder-workflow'
import { sniffAudioContentType, synthesizeSpeech, getVoiceUsage } from '../../src/services/voice'
import { filterFreshSources, attachMissingSources } from '../../src/lib/news-summary'
import { validateFCArgs, prepareToolsFor, extractEmbeddedToolCalls } from '../../src/ai/memo-fc-tools'
import { sanitizeForAI } from '../../src/services/ai-access'
import { registerChannel } from '../../src/services/channel-gateway'
import { compactMessages, compactAssistantContent } from '../../src/services/context-compactor'
import { parseRRule } from '../../src/services/recurrence'
import { validateCronFCArgs } from '../../src/ai/cron-fc-tools'
import { generateRunId } from '../../src/ai/run-logger'
import { AgentRunner } from '../../src/ai/runner'
import { ToolRegistry } from '../../src/ai/tools/registry'
import { unifiedDiff } from '../../src/lib/text-diff'
import { storageUpload, storageDestroy } from '../../src/services/storage'
import type { Budget, ModelStep } from '../../src/ai/types'

const mockRunStudioAgent = runStudioAgent as jest.Mock
const mockGenerateArtifactHtml = generateArtifactHtml as jest.Mock
const mockStorageUpload = storageUpload as jest.Mock
const mockStorageDestroy = storageDestroy as jest.Mock

// ---------------- 전역 fetch mock 관리 ----------------
const realFetch = global.fetch
afterEach(() => {
  global.fetch = realFetch
})

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSetting.mockImplementation(async (_d: any, k: string) => {
    const map: Record<string, string | undefined> = {
      'ai.engine': 'function_calling',
      'ai.fc_test_approved': 'true',
    }
    return map[k]
  })
  mockControllerExecute.mockImplementation(async () => ({
    ok: true, text: 'ok', provider: 'groq', model: 'm1',
  }))
})

// ---------------- ai.ts용 Mock D1 (getSetting + logUsage/error_log) ----------------
function makeAiDb(settings: Record<string, string> = {}) {
  const calls: { sql: string; params: any[]; method: string }[] = []
  const db = {
    calls,
    prepare(sql: string) {
      return {
        bind(...params: any[]) {
          return {
            first: async () => {
              calls.push({ sql, params, method: 'first' })
              if (sql.includes('FROM ai_settings')) {
                const v = settings[params[0]]
                return v === undefined ? null : { value: v }
              }
              return null
            },
            all: async () => ({ results: [] }),
            run: async () => {
              calls.push({ sql, params, method: 'run' })
              return { meta: { changes: 1, last_row_id: 1 } }
            },
          }
        },
      }
    },
  }
  return db
}

function mockFetchOnce(response: any) {
  global.fetch = jest.fn().mockResolvedValueOnce(response)
}
function mockFetchRejectOnce(err: any) {
  global.fetch = jest.fn().mockRejectedValueOnce(err)
}

// ============================================================
// src/services/ai.ts — 프로바이더 플러그인 (getProvider 경유)
// ============================================================
describe('ai.ts provider plugins', () => {
  test('gemini: system/assistant 메시지 변환 + parts 빈 텍스트 (221/224/226/261)', async () => {
    const plugin = getProvider('gemini')!
    expect(plugin).toBeDefined()
    mockFetchOnce({
      status: 200,
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '안녕' }, {}] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      }),
    })
    const out = await plugin.call({
      env: {}, key: null, model: 'gemini-3.5-flash-lite',
      messages: [
        { role: 'system', content: '너는 비서야' },
        { role: 'user', content: '안녕' },
        { role: 'assistant', content: '반가워' },
      ],
    } as any)
    expect(out.text).toBe('안녕')
    expect(out.inputTokens).toBe(5)
    // fetch 본문에 systemInstruction + assistant→model 변환이 들어감
    const sentBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)
    expect(sentBody.systemInstruction).toEqual({ parts: [{ text: '너는 비서야' }] })
    expect(sentBody.contents[1]).toEqual({ role: 'model', parts: [{ text: '반가워' }] })
    // key:null → '' 로 폴백 (1065)
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('key=')
  })

  test('gemini: candidates 빈 객체 → text 빈 문자열 (261 ??)', async () => {
    const plugin = getProvider('gemini')!
    mockFetchOnce({ status: 200, ok: true, json: async () => ({ candidates: [{}] }) })
    const out = await plugin.call({
      env: {}, key: 'k', model: 'gemini-3.5-flash-lite',
      messages: [{ role: 'user', content: 'hi' }],
    } as any)
    expect(out.text).toBe('')
  })

  test('gemini: 500 + text() 실패 → errBody 빈 문자열 (257)', async () => {
    const plugin = getProvider('gemini')!
    mockFetchOnce({
      status: 500, ok: false,
      text: async () => { throw new Error('body gone') },
    })
    await expect(plugin.call({
      env: {}, key: 'k', model: 'gemini-3.5-flash-lite',
      messages: [{ role: 'user', content: 'hi' }],
    } as any)).rejects.toThrow('gemini 500: ')
  })

  test('gemini: 직접 호출 지역 제한 → 릴레이 경유 + grounding 출처 (241/308/314)', async () => {
    const plugin = getProvider('gemini')!
    global.fetch = jest.fn()
      .mockRejectedValueOnce(new Error('User location is not supported'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          body: JSON.stringify({
            candidates: [{
              content: { parts: [{ text: '릴레이 응답' }, {}] },
              groundingMetadata: { groundingChunks: [{ web: { title: 'T', uri: 'https://example.com' } }] },
            }],
          }),
        }),
      })
    const out = await plugin.call({
      env: { GEMINI_RELAY_URL: 'https://relay.example.com', GEMINI_RELAY_SECRET: 's3cret' },
      key: 'k', model: 'gemini-3.5-flash-lite',
      messages: [{ role: 'user', content: '뉴스 알려줘' }],
    } as any)
    expect(out.text).toBe('릴레이 응답')
    expect(out.sources).toEqual([{ title: 'T', url: 'https://example.com' }])
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toBe('https://relay.example.com')
    expect((global.fetch as jest.Mock).mock.calls[1][1].headers['X-Relay-Key']).toBe('s3cret')
  })

  test('nvidia: content null + tool_calls → text 빈 문자열 (446/1077)', async () => {
    const plugin = getProvider('nvidia')!
    mockFetchOnce({
      status: 200, ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'memo_get', arguments: '{"id":1}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      }),
    })
    const out = await plugin.call({
      env: {}, key: null, model: 'nvidia/nemotron-3-ultra-550b-a55b',
      messages: [{ role: 'user', content: '메모 보여줘' }],
    } as any)
    expect(out.text).toBe('')
    expect(out.toolCalls).toHaveLength(1)
    expect(out.toolCalls![0].function.name).toBe('memo_get')
    // key:null → Bearer 빈 값 (1077)
    expect((global.fetch as jest.Mock).mock.calls[0][1].headers.Authorization).toBe('Bearer ')
  })

  test('nvidia: 500 + text() 실패 → errBody 빈 문자열 (438)', async () => {
    const plugin = getProvider('nvidia')!
    mockFetchOnce({
      status: 500, ok: false,
      text: async () => { throw new Error('body gone') },
    })
    await expect(plugin.call({
      env: {}, key: 'k', model: 'nvidia/nemotron-3-ultra-550b-a55b',
      messages: [{ role: 'user', content: 'hi' }],
    } as any)).rejects.toThrow('nvidia 500: ')
  })

  test('groq: key:null → 빈 키로 호출 (1071)', async () => {
    const plugin = getProvider('groq')!
    mockFetchOnce({
      status: 200, ok: true,
      json: async () => ({
        choices: [{ message: { content: '그록 응답' } }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }),
    })
    const out = await plugin.call({
      env: {}, key: null, model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'hi' }],
    } as any)
    expect(out.text).toBe('그록 응답')
    expect((global.fetch as jest.Mock).mock.calls[0][1].headers.Authorization).toBe('Bearer ')
  })

  test('workers-ai: 빈 응답 → 빈 문자열 JSON 직렬화 (474 else/우측)', async () => {
    const plugin = getProvider('workers-ai')!
    const out = await plugin.call({
      env: { AI: { run: async () => null } }, key: null, model: '@cf/meta/llama-3.2-1b-instruct',
      messages: [{ role: 'user', content: 'hi' }],
    } as any)
    expect(out.text).toBe('""')
    expect(out.toolCalls).toEqual([])
  })
})

// ============================================================
// src/services/ai.ts — selectModel
// ============================================================
describe('ai.ts selectModel', () => {
  test('useSearch + chat → gemini-2.5-flash (+50) + 민감도 없음 경로 (556/663)', async () => {
    const db = makeAiDb()
    const m = await __test.selectModel(db as any, {
      capability: 'chat', privacy: 'external-ok', latency: 'interactive', quality: 'fast', useSearch: true,
    } as any)
    expect(m.id).toBe('gemini-2.5-flash')
  })

  test('builder + 존재하지 않는 model.code 오버라이드 → 폴백 (532 else/590 else)', async () => {
    const db = makeAiDb({ 'model.code': 'gemini-3.8-flash' })
    const m = await __test.selectModel(db as any, {
      personaId: 'builder', capability: 'code',
    } as any)
    expect(m).toBeDefined()
    expect(m.id).not.toBe('gemini-3.8-flash')
    expect(m.status).toBe('active')
  })

  test('builder + 제외된 선호 모델 → BUILDER_MODEL_EXCLUDED (532 then)', async () => {
    const db = makeAiDb()
    await expect(__test.selectModel(db as any, {
      personaId: 'builder', capability: 'code',
    } as any, new Set(['gemini-3.5-flash-lite']))).rejects.toThrow('BUILDER_MODEL_EXCLUDED: gemini-3.5-flash-lite')
  })

  test('gemini 2개 실패 → 체인 중단 (570 else)', async () => {
    const db = makeAiDb()
    const m = await __test.selectModel(db as any, {
      capability: 'chat', privacy: 'external-ok',
    } as any, new Set(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']))
    expect(m).toBeDefined()
    expect(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']).not.toContain(m.id)
  })

  test('체인 다음 모델이 핀된 provider에 없음 → 폴백 (578 else)', async () => {
    const db = makeAiDb()
    const m = await __test.selectModel(db as any, {
      capability: 'chat', privacy: 'external-ok', providerPin: 'groq',
    } as any, new Set(['gemini-3.5-flash-lite']))
    expect(m.provider).toBe('groq')
  })

  test('private + 체인 모델이 외부 모델 → 체인 반환 건너뜀 (579 else)', async () => {
    const db = makeAiDb()
    const m = await __test.selectModel(db as any, {
      capability: 'chat', privacy: 'private',
    } as any, new Set(['gemini-3.5-flash-lite']))
    expect(m.provider).toBe('workers-ai')
  })

  test('후보 소진 + 호출 시도 있음 + 마지막 오류 없음 → All allowed providers failed (637 else)', async () => {
    const db = makeAiDb()
    const allActive = new Set(MODELS.filter((x) => x.status === 'active').map((x) => x.id))
    await expect(__test.selectModel(db as any, {
      capability: 'summarize', privacy: 'external-ok', personaId: 'keeper',
    } as any, allActive, { providerCallAttempted: true, lastProviderError: undefined })).rejects.toThrow('All allowed providers failed')
  })

  test('후보 소진 + 호출 시도 없음 → 개인정보 차단 403', async () => {
    const db = makeAiDb()
    const allActive = new Set(MODELS.filter((x) => x.status === 'active').map((x) => x.id))
    await expect(__test.selectModel(db as any, {
      capability: 'summarize', privacy: 'external-ok', personaId: 'keeper',
    } as any, allActive, { providerCallAttempted: false, lastProviderError: undefined })).rejects.toThrow('개인정보 보호 정책')
  })
})

// ============================================================
// src/services/ai.ts — aiChat
// ============================================================
describe('ai.ts aiChat', () => {
  const baseEnv = (extra: Record<string, any> = {}) => ({ DB: makeAiDb(), ...extra } as any)
  const userMsg = [{ role: 'user' as const, content: '안녕' }]

  test('nvidia 핀 → 키 유무와 무관하게 모델 선택 단계에서 거부 (2026-10-30)', async () => {
    // 구 사양: nvidia 모델이 active라 키 풀까지 도달해 'no nvidia key'가 났다.
    // 현 사양: 비활성 모델이라 selectModel이 먼저 거부한다 (키를 넣어도 동일).
    const env = baseEnv()
    await expect(aiChat(env, {
      capability: 'chat', privacy: 'external-ok', providerPin: 'nvidia',
    } as any, userMsg, { disableRetry: true })).rejects.toThrow('no active model for policy')
    const envWithKey = baseEnv({ NVIDIA_API_KEY_1: 'test-nvidia-key' })
    await expect(aiChat(envWithKey, {
      capability: 'chat', privacy: 'external-ok', providerPin: 'nvidia',
    } as any, userMsg, { disableRetry: true })).rejects.toThrow('no active model for policy')
  })

  test('groq 키 없음 → no groq key available (810)', async () => {
    const env = baseEnv()
    await expect(aiChat(env, {
      capability: 'chat', privacy: 'external-ok', providerPin: 'groq',
    } as any, userMsg, { disableRetry: true })).rejects.toThrow('no groq key available')
  })

  test('404 + 메시지 없음 → revoke 건너뛰고 코드 404 전파 (786 우측)', async () => {
    const env = baseEnv({ GEMINI_API_KEY_1: 'k1', GEMINI_API_KEY_2: 'k2' })
    mockFetchRejectOnce(Object.assign(new Error(''), { code: 404 }))
    let caught: any
    try {
      await aiChat(env, {
        capability: 'chat', privacy: 'external-ok', providerPin: 'gemini',
      } as any, userMsg, { disableRetry: true })
    } catch (e) { caught = e }
    expect(caught).toBeDefined()
    expect(caught.code).toBe(404)
  })

  test('일반 Error 실패 → 에러 로그 경로 (1006/1010/1029 우측)', async () => {
    const db = makeAiDb()
    const env = { DB: db, GEMINI_API_KEY_1: 'k1', GEMINI_API_KEY_2: 'k2' } as any
    mockFetchRejectOnce(new Error('boom'))
    await expect(aiChat(env, {
      capability: 'chat', privacy: 'external-ok', providerPin: 'gemini',
    } as any, userMsg, { disableRetry: true })).rejects.toThrow('boom')
    // ai_error_log INSERT가 기록됨 (메시지에 3자리 숫자가 없어 http_status 0)
    const errLog = db.calls.find((c) => c.sql.includes('INSERT INTO ai_error_log'))
    expect(errLog).toBeDefined()
    expect(errLog!.params[4]).toBe(0)
  })

  test('문자열 실패 → fallbackChain에 원문 기록 (1006 우측)', async () => {
    const db = makeAiDb()
    const env = { DB: db, GEMINI_API_KEY_1: 'k1', GEMINI_API_KEY_2: 'k2' } as any
    mockFetchRejectOnce('plain failure')
    let caught: any
    try {
      await aiChat(env, {
        capability: 'chat', privacy: 'external-ok', providerPin: 'gemini',
      } as any, userMsg, { disableRetry: true })
    } catch (e) { caught = e }
    expect(caught).toBe('plain failure')
    const errLog = db.calls.find((c) => c.sql.includes('INSERT INTO ai_error_log'))
    expect(errLog).toBeDefined()
    expect(errLog!.params[3]).toContain('plain failure')
  })

  test('system 전용 메시지 → 마지막 사용자 메시지 빈 문자열 (769 우측)', async () => {
    const env = baseEnv({ GEMINI_API_KEY_1: 'k1', GEMINI_API_KEY_2: 'k2' })
    mockFetchOnce({
      status: 200, ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    })
    const out = await aiChat(env, {
      capability: 'chat', privacy: 'external-ok', providerPin: 'gemini',
    } as any, [{ role: 'system' as const, content: '지시' }], { disableRetry: true })
    expect(out.text).toBe('ok')
  })

  test('비문자열 메시지 content → 안전 변환 (710 우측)', async () => {
    const env = baseEnv({ GEMINI_API_KEY_1: 'k1', GEMINI_API_KEY_2: 'k2' })
    mockFetchOnce({
      status: 200, ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    })
    const out = await aiChat(env, {
      capability: 'chat', privacy: 'external-ok', providerPin: 'gemini',
    } as any, [{ role: 'user', content: 123 } as any], { disableRetry: true })
    expect(out.text).toBe('ok')
    const sentBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)
    expect(sentBody.contents[0].parts[0].text).toBe('123')
  })

  test('gemini 성공 → usage 원장 기록', async () => {
    const db = makeAiDb()
    const env = { DB: db, GEMINI_API_KEY_1: 'k1', GEMINI_API_KEY_2: 'k2' } as any
    mockFetchOnce({
      status: 200, ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '안녕' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      }),
    })
    const out = await aiChat(env, {
      capability: 'chat', privacy: 'external-ok', providerPin: 'gemini',
    } as any, userMsg, { disableRetry: true })
    expect(out.text).toBe('안녕')
    expect(out.provider).toBe('gemini')
    expect(db.calls.some((c) => c.sql.includes('INSERT INTO ai_usage'))).toBe(true)
  })

  // 모듈 레벨 키 풀/allowlist를 건드리므로 aiChat 테스트 중 마지막에 둔다.
  // (이전 gemini 테스트들은 404 해지를 유발하지 않아 allowlist가 깨끗한 상태)
  test('gemini 404 revoke: 2개 키 순차 해지 후 키 없음 (786/787/198 else)', async () => {
    const env = baseEnv({ GEMINI_API_KEY_1: 'k1', GEMINI_API_KEY_2: 'k2' })
    global.fetch = jest.fn().mockResolvedValue({
      status: 404, ok: false,
      text: async () => 'no longer available to new users',
    })
    const policy = { capability: 'chat', privacy: 'external-ok', providerPin: 'gemini' } as any
    // 1·2차: 404로 첫 선택 모델(gemini-3.5-flash-lite)의 키 자격 해지
    // (어느 키가 먼저 뽑히든 2차에는 남은 키가 뽑혀 둘 다 해지됨)
    await expect(aiChat(env, policy, userMsg, { disableRetry: true })).rejects.toThrow(/gemini 404/)
    await expect(aiChat(env, policy, userMsg, { disableRetry: true })).rejects.toThrow(/gemini 404/)
    // 3차: 허용 키가 남아있지 않아 키 없음 오류
    await expect(aiChat(env, policy, userMsg, { disableRetry: true })).rejects.toThrow('no gemini key available')
  })
})

// ============================================================
// src/modules.ts — 비서 핸들러 등록
// ============================================================
describe('modules.ts assistant handler', () => {
  test('핸들러가 등록되고 알 수 없는 비서에서 즉시 실패 (26)', async () => {
    const handler = getAssistantHandler()
    expect(handler).toBeDefined()
    await expect(handler!({} as any, 'bogus-persona', [{ role: 'user', content: 'hi' }]))
      .rejects.toThrow('unknown persona')
  })
})

// ============================================================
// src/ai/function-calling-route.ts
// ============================================================
describe('function-calling-route', () => {
  function makeFcContext(envOverrides: any = {}) {
    return {
      env: { DB: {} as any, ENVIRONMENT: 'staging', ...envOverrides },
    } as any
  }
  function mockErrorSettings(code: string) {
    mockGetSetting.mockImplementation(async (_d: any, k: string) => {
      const map: Record<string, string | undefined> = {
        'ai.engine': 'function_calling',
        'ai.fc_test_approved': 'true',
        'ai.fc_test_mock_error': code,
      }
      return map[k]
    })
  }

  test('mock 세션 no-op 메서드 + next() 오류 (148/149)', async () => {
    mockErrorSettings('groq:429')
    await chatWithFunctionCalling(
      makeFcContext({ GROQ_API_KEY_1: 'k', GEMINI_API_KEY_1: 'g' }),
      'concierge',
      [{ role: 'user', content: 'hi' }],
    )
    const createSession = mockControllerCtor.mock.calls[0][0].createSession
    const s = createSession('groq', 'm')
    expect(() => s.addUserMessage('hi')).not.toThrow()
    expect(() => s.setSystemPrompt('sys')).not.toThrow()
    await expect(s.next()).rejects.toThrow('Rate limited (mock)')
  })

  test('gemini 키 없음 → Provider not configured (117)', async () => {
    await chatWithFunctionCalling(
      makeFcContext({}),
      'concierge',
      [{ role: 'user', content: 'hi' }],
    )
    const createSession = mockControllerCtor.mock.calls[0][0].createSession
    expect(() => createSession('gemini', 'm')).toThrow('Provider not configured: gemini')
  })

  test('search_memo executor 직접 호출 — 잘못된 인자 (167)', async () => {
    await chatWithFunctionCalling(
      makeFcContext({ GROQ_API_KEY_1: 'k' }),
      'concierge',
      [{ role: 'user', content: 'hi' }],
    )
    const createRegistry = mockControllerCtor.mock.calls[0][0].createRegistry
    const registry = createRegistry()
    const tool = registry.get('search_memo')
    expect(tool).toBeDefined()
    const result = await tool.executor('not-an-object', { userId: 'u1' } as any, {} as any)
    expect(result).toEqual({ ok: false, errorCode: 'INVALID_ARGUMENTS', message: 'Invalid arguments' })
  })
})

// ============================================================
// src/ai/providers/gemini.ts — GeminiAdapter
// ============================================================
describe('gemini adapter', () => {
  test('500 + text() 실패 → UNKNOWN 프로바이더 오류 (246)', async () => {
    const adapter = new GeminiAdapter({ apiKey: 'k', model: 'gemini-3.5-flash-lite' })
    mockFetchOnce({
      status: 500, ok: false,
      text: async () => { throw new Error('body gone') },
    })
    let caught: any
    try {
      await adapter.next({ tools: [], toolChoice: 'none', maxOutputTokens: 100 })
    } catch (e) { caught = e }
    // 결함 4 수정: toProviderError가 실제 Error 객체(ProviderError)를 던진다.
    // 본문 실패로 빈 문자열이 들어감.
    expect(caught).toBeInstanceOf(Error)
    expect(caught).toBeInstanceOf(ProviderError)
    expect(caught).toMatchObject({
      code: 'UNKNOWN', retryable: false, provider: 'gemini', message: 'gemini 500: ',
    })
  })
})

// ============================================================
// src/services/agent-team.ts
// ============================================================
describe('agent-team', () => {
  test('plan-execute 재노출 함수 직접 호출 (37 ×2)', () => {
    expect(verifyStepResult({ verify: { kind: 'non_empty' } } as any, 'x')).toEqual({ ok: true })
    expect(verifyStepResult({ verify: { kind: 'non_empty' } } as any, '')).toEqual({ ok: false, reason: 'empty_result' })
    expect(verifyStepResult({ verify: { kind: 'min_length', min: 3 } } as any, 'abcd')).toEqual({ ok: true })
    expect(verifyStepResult({ verify: { kind: 'contains_any', keywords: ['메모'] } } as any, '메모 확인')).toEqual({ ok: true })
    expect(runStepName({ index: 0, personaId: 'concierge' } as any)).toBe('step-0-concierge')
    expect(runStepName({ index: 2, personaId: 'keeper' } as any)).toBe('step-2-keeper')
  })

  test('runTeam — 존재하지 않는 단계 인덱스 실패 보고 (329 ??)', async () => {
    const deps: TeamDeps = {
      callAssistant: async () => { throw new Error('boom') },
    }
    const plan = {
      needsTeam: true, split: true, truncated: false, reason: 'test',
      steps: [{
        index: 5, personaId: 'concierge', clause: '메모를 요약해줘',
        reason: 'test', verify: { kind: 'non_empty' }, needsApproval: false,
      }],
    } as unknown as TeamPlan
    const result = await runTeam(deps, plan, [{ role: 'user', content: '메모를 요약해줘' }], 1)
    expect(result.text).toContain('계획 1개 중 0개 완료')
    expect(result.text).toContain('실패했습니다')
    expect(result.text).toContain('3회 시도 후에도 실패했습니다')
  })

  test('runTeam — 빈 결과 + min_length 0 → 헤더만 (349 else)', async () => {
    const deps: TeamDeps = {
      callAssistant: async () => ({ text: '' }),
    }
    const plan = {
      needsTeam: true, split: false, truncated: false, reason: 'test',
      steps: [{
        index: 0, personaId: 'concierge', clause: '안녕',
        reason: 'test', verify: { kind: 'min_length', min: 0 }, needsApproval: false,
      }],
    } as unknown as TeamPlan
    const result = await runTeam(deps, plan, [{ role: 'user', content: '안녕' }], 1)
    expect(result.text).toBe('계획 1개 중 1개 완료.')
  })
})

// ============================================================
// src/services/tool-approval.ts
// ============================================================
describe('tool-approval', () => {
  test('isKnownPersona (424/425)', () => {
    expect(isKnownPersona('concierge')).toBe(true)
    expect(isKnownPersona('keeper')).toBe(true)
    expect(isKnownPersona('bogus')).toBe(false)
    expect(isKnownPersona(null)).toBe(false)
    expect(isKnownPersona(undefined)).toBe(false)
  })

  test('recordApproval — insert 메타 없음 → 실패 (306)', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({ run: async () => ({ meta: {} }) }),
      }),
    }
    const store = new ToolApprovalStore(db as any)
    await expect(store.recordApproval({
      personaId: 'concierge', tool: 'memo_delete', scopeKey: 's1',
      decision: 'approved', expiresAt: null,
    } as any)).rejects.toThrow('approval insert failed')
  })

  test('findLatestApproval — 승인/거부가 아닌 결정 → null (327)', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            id: 1, personaId: 'concierge', tool: 'MEMO_DELETE', scopeKey: 's1',
            decision: 'pending', expiresAt: null, createdAt: '2026-10-26',
          }),
        }),
      }),
    }
    const store = new ToolApprovalStore(db as any)
    await expect(store.findLatestApproval('concierge', 'memo_delete', 's1')).resolves.toBeNull()
  })
})

// ============================================================
// src/services/skill-registry.ts
// ============================================================
describe('skill-registry', () => {
  test('buildSkillLoad — 예산 초과 스킬 집계 (393)', () => {
    const bigSkill: any = {
      id: 'big-skill',
      name: 'Big',
      description: 'x'.repeat(50),
      keywords: ['big'],
      tools: [{
        name: 't',
        description: 'x'.repeat(500),
        parameters: { type: 'object', properties: {} },
      }],
      markerTools: [],
      promptHint: 'hint',
      personas: [],
      maxChars: 100,
    }
    const result = buildSkillLoad([{ skill: bigSkill, score: 1 }], 100000)
    // 초과 스킬은 탈락이 아니라 통계에만 기록되고 도구는 그대로 로드됨
    expect(result.stats.overBudgetSkills).toContain('big-skill')
    expect(result.tools).toHaveLength(1)
    expect(result.skills).toHaveLength(1)
  })
})

// ============================================================
// src/services/reminder-workflow.ts
// ============================================================
describe('reminder-workflow', () => {
  const dueRow = { id: 1, title: '주간 회의', start_at: '2026-10-27 10:00:00', location: '회의실' }
  const subRow = { endpoint: 'https://push.example.com/e1', p256dh: 'p', auth: 'a' }
  type RemOpts = {
    due?: any[] | 'throw' | null
    subs?: 'ok' | 'throw' | 'null' | 'inner-null'
    insertReminders?: 'ok' | 'throw' | 'no-meta'
    deleteSub?: 'ok' | 'throw'
    updateReminders?: 'ok' | 'throw'
    workflowRunsFirst?: 'ok' | 'throw'
  }
  function makeRemDb(opts: RemOpts = {}) {
    const calls: { sql: string; params: any[]; method: string }[] = []
    let subsCalls = 0
    const handler = (sql: string, params: any[], method: 'first' | 'all' | 'run') => {
      calls.push({ sql, params, method })
      if (method === 'first') {
        if (sql.includes('FROM workflow_runs')) {
          if (opts.workflowRunsFirst === 'throw') throw new Error('db down')
          return null
        }
        return null
      }
      if (method === 'all') {
        if (sql.includes('FROM schedules')) {
          if (opts.due === 'throw') throw new Error('db down')
          if (opts.due === null) return { results: null }
          return { results: opts.due ?? [dueRow] }
        }
        if (sql.includes('FROM push_subscriptions')) {
          subsCalls++
          if (opts.subs === 'throw') throw new Error('db down')
          if (opts.subs === 'null') return { results: null }
          if (opts.subs === 'inner-null') return subsCalls === 1 ? { results: [subRow] } : { results: null }
          return { results: [subRow] }
        }
        return { results: [] }
      }
      // run
      if (sql.includes('INTO reminders')) {
        if (opts.insertReminders === 'throw') throw new Error('db down')
        if (opts.insertReminders === 'no-meta') return {}
        return { meta: { changes: 1, last_row_id: 1 } }
      }
      if (sql.includes('DELETE FROM push_subscriptions')) {
        if (opts.deleteSub === 'throw') throw new Error('db down')
        return { meta: { changes: 1 } }
      }
      if (sql.includes('UPDATE reminders SET status')) {
        if (opts.updateReminders === 'throw') throw new Error('db down')
        return { meta: { changes: 1 } }
      }
      return { meta: { changes: 1, last_row_id: 1 } }
    }
    const db = {
      calls,
      prepare(sql: string) {
        const normSql = sql.replace(/\s+/g, ' ').trim()
        const exec = (params: any[]) => ({
          first: async () => handler(normSql, params, 'first'),
          all: async () => handler(normSql, params, 'all'),
          run: async () => handler(normSql, params, 'run'),
        })
        return {
          bind: (...params: any[]) => exec(params),
          first: () => exec([]).first(),
          all: () => exec([]).all(),
          run: () => exec([]).run(),
        }
      },
    }
    return db
  }
  const remEnv = (db: any) => ({ DB: db, VAPID_PRIVATE_KEY: 'test-vapid-key' } as any)
  const okPush = async () => ({ ok: true })

  test('buildScheduleReminderWorkflow 기본 인자 (73)', () => {
    const wf = buildScheduleReminderWorkflow()
    expect(wf.id).toBeTruthy()
    expect(wf.nodes).toHaveLength(4)
    expect(wf.nodes.map((n) => n.id)).toEqual(['claim', 'compose', 'send-push', 'record'])
  })

  test('정상 틱 → sent 1', async () => {
    const db = makeRemDb()
    const r = await runReminderTick(remEnv(db), { sendPush: okPush as any })
    expect(r).toEqual({ checked: 1, sent: 1, failed: 0 })
  })

  test('due 조회 결과 null → 조용히 종료 (69)', async () => {
    const db = makeRemDb({ due: null })
    await expect(runReminderTick(remEnv(db), { sendPush: okPush as any }))
      .resolves.toEqual({ checked: 0, sent: 0, failed: 0 })
  })

  test('due 조회 실패 → 조용히 종료 (198)', async () => {
    const db = makeRemDb({ due: 'throw' })
    await expect(runReminderTick(remEnv(db), { sendPush: okPush as any }))
      .resolves.toEqual({ checked: 0, sent: 0, failed: 0 })
  })

  test('구독 조회 실패 → checked만 1 (208)', async () => {
    const db = makeRemDb({ subs: 'throw' })
    await expect(runReminderTick(remEnv(db), { sendPush: okPush as any }))
      .resolves.toEqual({ checked: 1, sent: 0, failed: 0 })
  })

  test('구독 조회 결과 null → checked만 1 (206)', async () => {
    const db = makeRemDb({ subs: 'null' })
    await expect(runReminderTick(remEnv(db), { sendPush: okPush as any }))
      .resolves.toEqual({ checked: 1, sent: 0, failed: 0 })
  })

  test('claim INSERT 실패 → 미선점 건너뜀 (98)', async () => {
    const db = makeRemDb({ insertReminders: 'throw' })
    const r = await runReminderTick(remEnv(db), { sendPush: okPush as any })
    expect(r).toEqual({ checked: 1, sent: 0, failed: 0 })
    expect(db.calls.some((c) => c.sql.includes('INTO reminders'))).toBe(true)
  })

  test('claim INSERT 메타 없음 → 미선점 (96 ?? 0)', async () => {
    const db = makeRemDb({ insertReminders: 'no-meta' })
    const r = await runReminderTick(remEnv(db), { sendPush: okPush as any })
    expect(r).toEqual({ checked: 1, sent: 0, failed: 0 })
  })

  test('만료 구독 삭제 실패 무시 → failed 1 (145)', async () => {
    const db = makeRemDb({ deleteSub: 'throw' })
    const gonePush = async () => ({ ok: false, gone: true })
    const r = await runReminderTick(remEnv(db), { sendPush: gonePush as any })
    expect(r).toEqual({ checked: 1, sent: 0, failed: 1 })
    expect(db.calls.some((c) => c.sql.includes('DELETE FROM push_subscriptions'))).toBe(true)
  })

  test('발송 성공 + 상태 기록 UPDATE 실패 무시 → sent 1 (174)', async () => {
    const db = makeRemDb({ updateReminders: 'throw' })
    const r = await runReminderTick(remEnv(db), { sendPush: okPush as any })
    expect(r).toEqual({ checked: 1, sent: 1, failed: 0 })
    expect(db.calls.some((c) => c.sql.includes('UPDATE reminders SET status'))).toBe(true)
  })

  test('위치 없는 일정 → 본문에서 위치 생략 (221)', async () => {
    const db = makeRemDb({ due: [{ ...dueRow, location: null }] })
    const seen: any[] = []
    const capturePush = async (_e: any, _s: any, payload: any) => {
      seen.push(payload)
      return { ok: true }
    }
    const r = await runReminderTick(remEnv(db), { sendPush: capturePush as any })
    expect(r).toEqual({ checked: 1, sent: 1, failed: 0 })
    expect(seen[0].body).toBe('10:00 주간 회의')
  })

  test('워크플로 예외 → 다음 일정 계속 (227)', async () => {
    // 발송 노드가 던지고 재시도 sleep마저 던지면 runWorkflow가 예외를 전파한다.
    // (claim INSERT 실패는 노드 안에서 잡혀 선점 실패로 끝나므로 sleep이 안 불림)
    const db = makeRemDb()
    const throwingPush = async () => { throw new Error('push down') }
    const throwingSleep = async () => { throw new Error('sleep down') }
    const r = await runReminderTick(remEnv(db), { sendPush: throwingPush as any, sleep: throwingSleep as any })
    expect(r).toEqual({ checked: 1, sent: 0, failed: 0 })
  })

  test('발송 노드 구독 조회 null → sentCount 0 → failed 1 (125-127)', async () => {
    const db = makeRemDb({ subs: 'inner-null' })
    const r = await runReminderTick(remEnv(db), { sendPush: okPush as any })
    expect(r).toEqual({ checked: 1, sent: 0, failed: 1 })
  })

  test('푸시 미설정 → 즉시 종료', async () => {
    const db = makeRemDb()
    const r = await runReminderTick({ DB: db } as any, { sendPush: okPush as any })
    expect(r).toEqual({ checked: 0, sent: 0, failed: 0 })
  })
})

// ============================================================
// src/services/voice.ts
// ============================================================
describe('voice', () => {
  test('MP3 프레임 싱크 판별 (162)', () => {
    expect(sniffAudioContentType(new Uint8Array([0xff, 0xe0]))).toBe('audio/mpeg')
    expect(sniffAudioContentType(new Uint8Array([0xff, 0xfb]))).toBe('audio/mpeg')
    expect(sniffAudioContentType(new Uint8Array([0x49, 0x44, 0x33]))).toBe('audio/mpeg')
  })

  test('base64 오디오 정규화 (222-225)', async () => {
    const ai = {
      run: async () => ({ audio: btoa('RIFFxxxxWAVE') }),
    }
    const out = await synthesizeSpeech(ai as any, '안녕')
    expect(out.audio).toEqual(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x78, 0x78, 0x78, 0x78, 0x57, 0x41, 0x56, 0x45]))
    expect(out.contentType).toBe('audio/wav')
    expect(out.lang).toBe('kr')
    expect(out.chars).toBe(2)
  })

  test('KV 실패 → 사용량 0 (266)', async () => {
    const kv = { get: async () => { throw new Error('kv down') } }
    await expect(getVoiceUsage(kv as any)).resolves.toEqual({ stt: 0, tts: 0, total: 0 })
  })
})

// ============================================================
// src/lib/news-summary.ts
// ============================================================
describe('news-summary', () => {
  test('발행일 파싱 불가 → 신선으로 유지 (128)', () => {
    const kept = filterFreshSources([{ url: 'https://x', publishedDate: 'not-a-date' } as any])
    expect(kept).toHaveLength(1)
  })

  test('전부 오래됨 + strict → 빈 목록 (132)', () => {
    const kept = filterFreshSources(
      [{ url: 'https://x', publishedDate: '2020-01-01' } as any],
      30, new Date('2026-10-26T00:00:00Z'), true,
    )
    expect(kept).toHaveLength(0)
  })

  test('출처 URL 없음 → 건너뜀 (331)', () => {
    const out = attachMissingSources('1. 항목\n', [{ url: '' } as any])
    expect(out).toBe('1. 항목\n')
  })
})

// ============================================================
// src/ai/memo-fc-tools.ts · src/services/ai-access.ts · 채널/기타 유틸
// ============================================================
describe('memo-fc-tools', () => {
  test('memo_get 숫자 id 검증 실패 (163)', () => {
    const r = validateFCArgs('memo_get', { id: 'x' })
    expect(r.valid).toBe(false)
  })

  test('prepareToolsFor null → null (183)', () => {
    expect(prepareToolsFor('nvidia', null as any)).toBeNull()
  })

  test('임베디드 JSON 이스케이프 백슬래시 (319/320)', () => {
    const calls = extractEmbeddedToolCalls('{"tool":"memo_create","arguments":{"text":"a\\nb"}}')
    expect(calls).toHaveLength(1)
    expect(calls[0].arguments.text).toBe('a\nb')
  })

  test('닫히지 않은 JSON → 빈 배열 (331)', () => {
    expect(extractEmbeddedToolCalls('{"tool":"memo_create","arguments":')).toEqual([])
  })
})

describe('ai-access / channel-gateway / context-compactor / recurrence', () => {
  test('sanitizeForAI 비문자열 → 빈 문자열 (210)', () => {
    expect(sanitizeForAI(null as any)).toBe('')
    expect(sanitizeForAI(undefined as any)).toBe('')
  })

  test('registerChannel 검증 (52/54)', () => {
    expect(() => registerChannel(null as any)).toThrow('plugin.id required')
    expect(() => registerChannel({ id: 'x' } as any)).toThrow('has no normalizeInbound')
  })

  test('compactMessages — tool 역할은 그대로 통과 (135)', () => {
    // keepRecent=1이면 마지막 메시지만 최근 집합에 들고, tool 메시지는 압축 대상이 된다.
    // (keepRecent=0은 slice(-0)=전체를 뜻해 아무것도 압축하지 않으므로 주의)
    const out = compactMessages([
      { role: 'user', content: 'x'.repeat(100) },
      { role: 'tool', content: 'y'.repeat(100) },
      { role: 'user', content: '최근' },
    ] as any, { budgetChars: 1, keepRecent: 1 })
    expect(out.stats.skipped).toBe(false)
    const toolMsg = out.messages.find((m: any) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg.content).toBe('y'.repeat(100))
  })

  test('compactAssistantContent 빈 문자열 (159)', () => {
    expect(compactAssistantContent('', 100)).toEqual({ text: '', replaced: 0 })
  })

  test('parseRRule UNTIL — 존재하지 않는 날짜는 null (결함 3 수정)', () => {
    // 구 코드는 형식만 검사해 '2026-13-40'을 until로 저장했다.
    // 이제 isValidCalendarDate로 실제 날짜인지 검증한다.
    const rule = parseRRule('FREQ=DAILY;UNTIL=20261340')
    expect(rule.until).toBeNull()
    expect(parseRRule('FREQ=DAILY;UNTIL=20261026')!.until).toBe('2026-10-26')
  })
})

describe('studio-agent distillMessages', () => {
  const head = [
    { role: 'user', parts: [{ text: '앱 만들어줘' }] },
    { role: 'model', parts: [{ text: '알겠어' }] },
  ]
  const tail = Array.from({ length: 6 }, (_, i) => ({ role: 'user', parts: [{ text: `최근${i}` }] }))

  test('gemini — 텍스트 없는 part → 생략 문구 (62)', () => {
    const middle = [
      { role: 'user', parts: [{}] },
      { role: 'user', parts: [{ text: 'hello' }] },
    ]
    const out = distillMessages([...head, ...middle, ...tail], true)
    expect(out).toHaveLength(10)
    expect(out[2]).toEqual({ role: 'user', parts: [{ text: '(이전 내용 생략)' }] })
    expect(out[3]).toEqual({ role: 'user', parts: [{ text: 'hello' }] })
  })

  test('openai — 단독 tool 메시지 건너뜀 (86)', () => {
    const middle = [
      { role: 'tool', content: 'x' },
      { role: 'user', content: 'hi' },
    ]
    const out = distillMessages([...head, ...middle, ...tail], false)
    expect(out).toHaveLength(9)
    expect(out.some((m: any) => m.role === 'tool')).toBe(false)
    expect(out[2]).toEqual({ role: 'user', content: 'hi' })
  })
})

describe('cron-fc-tools / run-logger / text-diff', () => {
  test('validateCronFCArgs null 인자 (84)', () => {
    const r = validateCronFCArgs('cron_create', null)
    expect(r.valid).toBe(false)
    expect(r.error).toBe('Arguments must be an object')
  })

  test('generateRunId — crypto.randomUUID 없음 → 폴백 (254)', () => {
    const saved = (globalThis as any).crypto
    try {
      ;(globalThis as any).crypto = undefined
      const id = generateRunId()
      // 폴백 형식: run_<base36 시간>_<Math.random().toString(36) — '0.' 포함 가능>
      expect(id).toMatch(/^run_[0-9a-z]+_[0-9a-z.]+$/)
      expect(id.startsWith('run_')).toBe(true)
    } finally {
      ;(globalThis as any).crypto = saved
    }
  })

  test('unifiedDiff 초대형 diff → 생략 문구 (27)', () => {
    const a = Array.from({ length: 2001 }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: 2001 }, (_, i) => `b${i}`).join('\n')
    const diff = unifiedDiff(a, b)
    expect(diff).toContain('diff 생략')
  })
})

// ============================================================
// src/ai/runner.ts
// ============================================================
describe('ai runner', () => {
  const BASE_BUDGET: Budget = {
    maxModelCalls: 5,
    maxToolCalls: 4,
    maxTotalInputTokens: 8000,
    maxOutputTokensPerCall: 1024,
    maxToolResultChars: 1500,
    toolTimeoutMs: 1000,
  }
  function makeRegistry(): ToolRegistry {
    const registry = new ToolRegistry()
    registry.register(
      { name: 'search_memo', description: 'search memos', parameters: {}, mode: 'read' },
      z.object({ query: z.string() }),
      async (args: any) => ({ memos: [`hit:${args.query}`] }),
    )
    return registry
  }
  function makeSession(steps: Array<ModelStep | Error>) {
    let i = 0
    return {
      provider: 'groq',
      modelId: 'test-model',
      next: jest.fn(async (_opts: any) => {
        const step = steps[Math.min(i, steps.length - 1)]
        i++
        if (step instanceof Error) throw step
        return step
      }),
      appendToolResults: jest.fn(),
      estimateInputTokens: jest.fn(() => 100),
    }
  }

  test('maxModelCalls 0 → 즉시 budget_exceeded (399)', async () => {
    const runner = new AgentRunner()
    const session = makeSession([{ text: 'hi', toolCalls: [] } as ModelStep])
    const result = await runner.run({
      session: session as any,
      registry: makeRegistry(),
      ctx: { userId: 'u1' } as any,
      env: { DB: {} as any },
      budget: { ...BASE_BUDGET, maxModelCalls: 0 },
      allowedTools: ['search_memo'],
      systemPrompt: 'sys',
      requestId: 'req-1',
    })
    expect(result.status).toBe('budget_exceeded')
    expect(result.errorCode).toBe('MAX_MODEL_CALLS')
    expect(session.next).not.toHaveBeenCalled()
  })
})

// ============================================================
// src/modules/artifact/routes.ts
// ============================================================
describe('artifact routes', () => {
  class ArtifactMockDb {
    firstQueue: any[] = []
    allQueue: any[] = []
    runQueue: any[] = []
    calls: { sql: string; params: any[] }[] = []
    batchCalls: any[][] = []
    prepare(sql: string) {
      const db = this
      const exec = (params: any[]) => {
        db.calls.push({ sql, params })
        return {
          first: async () => {
            const v = db.firstQueue.shift()
            if (v === undefined) return null
            if (v instanceof Error) throw v
            return v
          },
          all: async () => {
            const v = db.allQueue.shift()
            if (v === undefined) return { results: [] }
            if (v instanceof Error) throw v
            return { results: v }
          },
          run: async () => {
            const v = db.runQueue.shift()
            if (v === undefined) return { meta: { last_row_id: 1, changes: 1 } }
            if (v instanceof Error) throw v
            return v
          },
        }
      }
      return {
        bind: (...params: any[]) => exec(params),
        first: () => exec([]).first(),
        all: () => exec([]).all(),
        run: () => exec([]).run(),
      }
    }
    async batch(stmts: any[]) {
      this.batchCalls.push(stmts)
      return []
    }
  }
  function makeArtifactQueue(shouldThrow = false, emptyMessage = false) {
    const sent: any[] = []
    return {
      sent,
      send: async (msg: any) => {
        if (shouldThrow) throw emptyMessage ? new Error() : new Error('queue down')
        sent.push(msg)
      },
    }
  }
  function makeArtifactApp(opts: {
    userEmail?: string | null
    db?: ArtifactMockDb
    queueThrows?: boolean
    queueEmptyMessage?: boolean
  } = {}) {
    const db = opts.db ?? new ArtifactMockDb()
    const queue = makeArtifactQueue(!!opts.queueThrows, !!opts.queueEmptyMessage)
    const app = new Hono()
    app.use('*', async (c, next) => {
      if (opts.userEmail === undefined) (c as any).set('userEmail', 'test@example.com')
      else if (opts.userEmail !== null) (c as any).set('userEmail', opts.userEmail)
      await next()
    })
    app.route('/a', artifactApp)
    const env: any = { DB: db, ARTIFACT_QUEUE: queue }
    const req = (path: string, init?: RequestInit) => app.request('/a' + path, init, env)
    const json = (path: string, method: string, body?: any) =>
      req(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    return { app, db, queue, env, req, json }
  }
  async function abody(res: Response) {
    return res.json() as Promise<any>
  }

  test('파일 저장 — 2MB 초과 (265)', async () => {
    const { json, db } = makeArtifactApp()
    db.firstQueue.push({ id: 1, draft_version_id: null })
    const res = await json('/1/versions/files', 'POST', { files: { 'big.txt': 'x'.repeat(2 * 1024 * 1024 + 1) } })
    const j = await abody(res)
    expect(res.status).toBe(400)
    expect(j.error).toContain('파일이 너무 큼')
  })

  test('파일 저장 — draft 버전 파일 없음 → html_content 폴백 (277-280)', async () => {
    const { json, db } = makeArtifactApp()
    db.firstQueue.push({ id: 1, draft_version_id: 5 })
    db.allQueue.push([])
    db.firstQueue.push({ html_content: '<html>old</html>' })
    db.firstQueue.push({ max_no: 2 })
    const res = await json('/1/versions/files', 'POST', { files: { 'style.css': 'body{}' } })
    const j = await abody(res)
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(j.data.version_no).toBe(3)
    const ins = db.calls.find((c) => c.sql.includes('INSERT INTO artifact_versions'))
    expect(ins).toBeDefined()
    expect(ins!.params[3]).toBe('<html>old</html>')
  })

  test('파일 저장 — 미리보기 없음 → 첫 파일 내용 폴백 (290)', async () => {
    const { json, db } = makeArtifactApp()
    db.firstQueue.push({ id: 1, draft_version_id: null })
    db.firstQueue.push(null)
    db.firstQueue.push({ max_no: 2 })
    const res = await json('/1/versions/files', 'POST', { files: { 'style.css': 'body{}' } })
    const j = await abody(res)
    expect(res.status).toBe(200)
    expect(j.data.version_no).toBe(3)
    const ins = db.calls.find((c) => c.sql.includes('INSERT INTO artifact_versions'))
    expect(ins!.params[3]).toBe('body{}')
  })

  test('파일 저장 — 빈 내용 (292)', async () => {
    const { json, db } = makeArtifactApp()
    db.firstQueue.push({ id: 1, draft_version_id: null })
    db.firstQueue.push(null)
    const res = await json('/1/versions/files', 'POST', { files: { 'empty.txt': '' } })
    const j = await abody(res)
    expect(res.status).toBe(400)
    expect(j.error).toBe('저장할 내용이 비어있습니다')
  })

  test('파일 저장 — DB 실패 (311)', async () => {
    const { json, db } = makeArtifactApp()
    db.firstQueue.push(new Error('db down'))
    const res = await json('/1/versions/files', 'POST', { files: { 'a.txt': 'hi' } })
    const j = await abody(res)
    expect(res.status).toBe(500)
    expect(j.error).toBe('파일 저장 실패')
  })

  test('진행 중 작업 조회 — DB 실패 (334)', async () => {
    const { req, db } = makeArtifactApp()
    db.firstQueue.push(new Error('db down'))
    const res = await req('/1/active-job', { method: 'GET' })
    const j = await abody(res)
    expect(res.status).toBe(500)
    expect(j.error).toBe('조회 실패')
  })

  test('답변 제출 — 잘못된 JSON (771)', async () => {
    const { req } = makeArtifactApp()
    const res = await req('/jobs/1/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid',
    })
    const j = await abody(res)
    expect(res.status).toBe(400)
    expect(j.error).toBe('answers가 필요합니다')
  })

  test('답변 제출 — 큐 실패 시 failed 처리 + unknown 메시지 (808-811)', async () => {
    const { json, db } = makeArtifactApp({ queueThrows: true, queueEmptyMessage: true })
    db.firstQueue.push({
      id: 1, status: 'awaiting_input',
      pending_state: JSON.stringify({ questions: [{ id: 'q1' }] }),
    })
    const res = await json('/jobs/1/answer', 'POST', { answers: [{ id: 'q1', answer: 'yes' }] })
    const j = await abody(res)
    expect(res.status).toBe(500)
    expect(j.error).toBe('큐 전송 실패')
    const failUpdate = db.calls.find((c) => c.sql.includes("SET status='failed'"))
    expect(failUpdate).toBeDefined()
    expect(failUpdate!.params[0]).toBe('큐 전송 실패: unknown')
  })

  test('답변 제출 — 작업 조회 실패 (815)', async () => {
    const { json, db } = makeArtifactApp()
    db.firstQueue.push(new Error('db down'))
    const res = await json('/jobs/1/answer', 'POST', { answers: [{ id: 'q1', answer: 'yes' }] })
    const j = await abody(res)
    expect(res.status).toBe(500)
    expect(j.error).toBe('답변 제출 실패')
  })
})

// ============================================================
// src/modules/auth/routes.ts
// ============================================================
describe('auth routes', () => {
  class AuthMockDb {
    firstQueue: any[] = []
    runQueue: any[] = []
    calls: { sql: string; params: any[] }[] = []
    prepare(sql: string) {
      const db = this
      const exec = (params: any[]) => {
        db.calls.push({ sql, params })
        return {
          first: async () => {
            const v = db.firstQueue.shift()
            if (v === undefined) return null
            if (v instanceof Error) throw v
            return v
          },
          all: async () => ({ results: [] }),
          run: async () => {
            const v = db.runQueue.shift()
            if (v === undefined) return { meta: { last_row_id: 1, changes: 1 } }
            if (v instanceof Error) throw v
            return v
          },
        }
      }
      return {
        bind: (...params: any[]) => exec(params),
        first: () => exec([]).first(),
        all: () => exec([]).all(),
        run: () => exec([]).run(),
      }
    }
  }
  class AuthMockKv {
    store = new Map<string, string>()
    puts: { key: string; value: string; opts?: any }[] = []
    async get(key: string) {
      return this.store.has(key) ? this.store.get(key)! : null
    }
    async put(key: string, value: string, opts?: any) {
      this.store.set(key, value)
      this.puts.push({ key, value, opts })
    }
  }
  function makeAuthApp(opts: {
    db?: AuthMockDb
    kv?: AuthMockKv
    env?: Record<string, any>
  } = {}) {
    const db = opts.db ?? new AuthMockDb()
    const kv = opts.kv ?? new AuthMockKv()
    const app = new Hono()
    app.route('/a', authApp)
    const env: any = {
      DB: db,
      KV: kv,
      SESSION_SECRET: SECRET,
      ENVIRONMENT: 'production',
      ...opts.env,
    }
    const req = (path: string, init?: RequestInit) => app.request('/a' + path, init, env)
    const json = (path: string, method: string, body?: any, headers?: Record<string, string>) =>
      req(path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(headers || {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    return { app, db, kv, env, req, json }
  }
  async function abody(res: Response) {
    return res.json() as Promise<any>
  }
  async function makeSessionToken(email: string, secret: string, expOffsetMs: number, method: 'otp' | 'pin' = 'otp', v = 0) {
    const exp = Date.now() + expOffsetMs
    const payload = JSON.stringify({ email, exp, method, v })
    const enc = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    )
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    return btoa(payload) + '.' + sigB64
  }
  const EMAIL = 'kimjn00003@naver.com'
  const SECRET = 'test-secret-32-chars-long!'

  test('verifyPassword — 해시 길이 불일치 → false (159)', async () => {
    const { saltB64 } = await hashPassword('pw', undefined, 1000)
    const shortHash = btoa(String.fromCharCode(...new Uint8Array(16)))
    expect(await verifyPassword('pw', {
      password_hash: shortHash, password_salt: saltB64, iterations: 100000,
    })).toBe(false)
  })

  test('bumpSessionVersion — UPDATE 행 없음 → 예외 (227)', async () => {
    const { db } = makeAuthApp()
    db.runQueue.push({ meta: { changes: 1 } })
    db.firstQueue.push(null)
    await expect(bumpSessionVersion({ DB: db } as any, EMAIL))
      .rejects.toThrow('bumpSessionVersion: session_versions row missing')
  })

  test('verifySessionInfo — email 비문자열 → null (266)', async () => {
    const token = await makeSessionToken(123 as any, SECRET, 3600000, 'otp', 0)
    await expect(verifySessionInfo(token, SECRET)).resolves.toBeNull()
  })

  test('POST /request — IP 속도 제한 (378)', async () => {
    const { json, db } = makeAuthApp()
    db.runQueue.push({ meta: { changes: 0 } })
    const res = await json('/request', 'POST', {}, { 'CF-Connecting-IP': '1.2.3.4' })
    const j = await abody(res)
    expect(res.status).toBe(429)
    expect(j.error).toContain('너무 많은 요청')
  })

  test('POST /request — 동시 요청 경합 패자 → 502 (414)', async () => {
    const { json, db } = makeAuthApp()
    db.runQueue.push({ meta: { changes: 1 } })
    db.runQueue.push({ meta: { changes: 0 } })
    db.firstQueue.push(null)
    db.firstQueue.push(null)
    const res = await json('/request', 'POST', {})
    const j = await abody(res)
    expect(res.status).toBe(502)
    expect(j.error).toBe('메일 발송 실패')
  })

  test('POST /verify — 전역 속도 제한 (452)', async () => {
    const { json, db } = makeAuthApp()
    db.runQueue.push({ meta: { changes: 0 } })
    const res = await json('/verify', 'POST', { code: '123456' })
    const j = await abody(res)
    expect(res.status).toBe(429)
    expect(j.error).toContain('너무 많은 요청')
  })

  test('POST /pin-login — 환경 설정 없음 → 500 (543)', async () => {
    const { json } = makeAuthApp({ env: { ENVIRONMENT: undefined } })
    const res = await json('/pin-login', 'POST', { pin: '123456' })
    expect(res.status).toBe(500)
  })

  test('POST /pin-login — 잘못된 JSON (545)', async () => {
    const { req } = makeAuthApp()
    const res = await req('/pin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid',
    })
    const j = await abody(res)
    expect(res.status).toBe(400)
    expect(j.error).toBe('PIN은 숫자 6자리입니다.')
  })

  test('POST /pin-login — 전역 속도 제한 (558)', async () => {
    const { json, db } = makeAuthApp()
    db.runQueue.push({ meta: { changes: 0 } })
    const res = await json('/pin-login', 'POST', { pin: '123456' })
    const j = await abody(res)
    expect(res.status).toBe(429)
    expect(j.error).toBe('PIN 입력 실패가 너무 많습니다. 1시간 후 다시 시도하세요.')
  })

  test('POST /pin-login — 보상 UPDATE마저 실패 → 로그 + 500 (668)', async () => {
    const { json, db } = makeAuthApp()
    const { hashB64, saltB64, iterations } = await hashPin('123456')
    db.firstQueue.push({
      pin_hash: hashB64, pin_salt: saltB64, iterations, fail_count: 0, locked_until: null,
    })
    db.runQueue.push({ meta: { changes: 1 } }) // 전역 속도 제한
    db.runQueue.push({ meta: { changes: 1 } }) // 게이트 선점
    db.runQueue.push(new Error('reset down')) // 초기화 UPDATE
    db.runQueue.push(new Error('compensation down')) // 보상 UPDATE
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await json('/pin-login', 'POST', { pin: '123456' })
      expect(res.status).toBe(500)
      expect(spy).toHaveBeenCalledWith('pin-login: gate compensation failed')
    } finally {
      spy.mockRestore()
    }
  })

  test('POST /pin-login — KV 폴백: 실패 카운터 상한 → 429 (708)', async () => {
    const { json, db, kv } = makeAuthApp()
    db.firstQueue.push(new Error('no such column: fail_count'))
    kv.store.set(`pinfail:${EMAIL}`, '5')
    const res = await json('/pin-login', 'POST', { pin: '123456' })
    const j = await abody(res)
    expect(res.status).toBe(429)
    expect(j.error).toContain('너무 많습니다')
  })

  test('POST /pin-login — KV 폴백: 행 없음 → PIN_NOT_SET (714)', async () => {
    const { json, db } = makeAuthApp()
    db.firstQueue.push(new Error('no such column: fail_count'))
    db.firstQueue.push(null)
    const res = await json('/pin-login', 'POST', { pin: '123456' })
    const j = await abody(res)
    expect(res.status).toBe(401)
    expect(j.code).toBe('PIN_NOT_SET')
  })

  test('POST /pin-login — KV 폴백 성공 → 세션 발급 (725-729)', async () => {
    const { json, db, kv } = makeAuthApp()
    const { hashB64, saltB64, iterations } = await hashPin('123456')
    db.firstQueue.push(new Error('no such column: fail_count'))
    db.firstQueue.push({ pin_hash: hashB64, pin_salt: saltB64, iterations })
    db.firstQueue.push(null) // getSessionVersion → 0
    const res = await json('/pin-login', 'POST', { pin: '123456' })
    const j = await abody(res)
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(res.headers.get('Set-Cookie')).toContain('myhub_session=')
    expect(kv.store.get(`pinfail:${EMAIL}`)).toBe('0')
  })

  test('POST /set-pin — 환경 설정 없음 → 500 (742)', async () => {
    const { json } = makeAuthApp({ env: { ENVIRONMENT: undefined } })
    const res = await json('/set-pin', 'POST', { pin: '123456' })
    expect(res.status).toBe(500)
  })

  test('POST /set-pin — 세션 없음 → 401 (748)', async () => {
    const { req } = makeAuthApp()
    const res = await req('/set-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'myhub_session=garbage' },
      body: JSON.stringify({ pin: '123456' }),
    })
    const j = await abody(res)
    expect(res.status).toBe(401)
    expect(j.error).toBe('로그인이 필요합니다.')
  })

  test('POST /set-pin — OTP 세션 + 잘못된 JSON → 400 (753)', async () => {
    const { req, db } = makeAuthApp()
    const token = await makeSessionToken(EMAIL, SECRET, 3600000, 'otp', 0)
    db.firstQueue.push(null) // getSessionVersion → 0
    const res = await req('/set-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `myhub_session=${token}` },
      body: '{invalid',
    })
    const j = await abody(res)
    expect(res.status).toBe(400)
    expect(j.error).toBe('PIN은 숫자 6자리여야 합니다.')
  })

  test('GET /me — auth_pins/accounts 조회 실패 → false로 취급 (818/827)', async () => {
    const { req, db } = makeAuthApp()
    const token = await makeSessionToken(EMAIL, SECRET, 3600000, 'otp', 0)
    db.firstQueue.push(null) // getSessionVersion → 0
    db.firstQueue.push(new Error('no such table: auth_pins'))
    db.firstQueue.push(new Error('no such table: accounts'))
    const res = await req('/me', {
      method: 'GET',
      headers: { Cookie: `myhub_session=${token}` },
    })
    const j = await abody(res)
    expect(res.status).toBe(200)
    expect(j).toEqual({ ok: true, email: EMAIL, hasPin: false, hasPassword: false })
  })
})

// ============================================================
// src/modules/memo/routes.ts
// ============================================================
describe('memo routes', () => {
  class MemoMockDb {
    firstQueue: any[] = []
    allQueue: any[] = []
    runQueue: any[] = []
    calls: { sql: string; params: any[] }[] = []
    prepare(sql: string) {
      const db = this
      const exec = (params: any[]) => {
        db.calls.push({ sql, params })
        return {
          first: async () => {
            const v = db.firstQueue.shift()
            if (v === undefined) return null
            if (v instanceof Error) throw v
            return v
          },
          all: async () => {
            const v = db.allQueue.shift()
            if (v === undefined) return { results: [] }
            if (v instanceof Error) throw v
            return { results: v }
          },
          run: async () => {
            const v = db.runQueue.shift()
            if (v === undefined) return { meta: { last_row_id: 1, changes: 1 } }
            if (v instanceof Error) throw v
            return v
          },
        }
      }
      return {
        bind: (...params: any[]) => exec(params),
        first: () => exec([]).first(),
        all: () => exec([]).all(),
        run: () => exec([]).run(),
      }
    }
    async batch(stmts: any[]) {
      return []
    }
  }
  class MemoMockKv {
    deleteCalls: string[] = []
    shouldThrow = false
    async delete(key: string) {
      this.deleteCalls.push(key)
      if (this.shouldThrow) throw new Error('kv down')
    }
  }
  function makeMemoApp(opts: { db?: MemoMockDb; kv?: MemoMockKv; kvThrows?: boolean } = {}) {
    const db = opts.db ?? new MemoMockDb()
    const kv = opts.kv ?? new MemoMockKv()
    if (opts.kvThrows) kv.shouldThrow = true
    const app = new Hono()
    app.route('/a', memoApp)
    const env: any = { DB: db, KV: kv, CLOUDINARY_CLOUD_NAME: 'demo' }
    const req = (path: string, init?: RequestInit) => app.request('/a' + path, init, env)
    const json = (path: string, method: string, body?: any) =>
      req(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    return { app, db, kv, env, req, json }
  }
  async function abody(res: Response) {
    return res.json() as Promise<any>
  }

  test('POST /1/lock — 잘못된 JSON → 잠금 해제 상태 유지 (290)', async () => {
    const { req, db } = makeMemoApp()
    db.firstQueue.push({ text: 'hello', is_locked: 0 })
    const res = await req('/1/lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid',
    })
    const j = await abody(res)
    expect(res.status).toBe(200)
    expect(j).toEqual({ ok: true, is_locked: 0 })
  })

  test('POST /1/lock-block — 잘못된 JSON → empty_html (329)', async () => {
    const { req } = makeMemoApp()
    const res = await req('/1/lock-block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid',
    })
    const j = await abody(res)
    expect(res.status).toBe(400)
    expect(j.error).toBe('empty_html')
  })

  test('POST /files/1/lock — 잘못된 JSON → 상태 변경 없음 (428)', async () => {
    const { req, db } = makeMemoApp()
    db.firstQueue.push({ id: 1, is_locked: 0 })
    const res = await req('/files/1/lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid',
    })
    const j = await abody(res)
    expect(res.status).toBe(200)
    expect(j).toEqual({ ok: true, is_locked: 0 })
  })

  test('POST /1/files — KV 캐시 무효화 실패 무시 (587)', async () => {
    mockStorageUpload.mockResolvedValue({
      public_id: 'p1', bytes: 10, secure_url: 'https://x', resource_type: 'image',
    })
    const { req, db, kv } = makeMemoApp({ kvThrows: true })
    db.runQueue.push({ meta: { last_row_id: 99, changes: 1 } })
    const fd = new FormData()
    fd.append('files', new File(['hello'], 'a.txt', { type: 'text/plain' }))
    const res = await req('/1/files', { method: 'POST', body: fd })
    const j = await abody(res)
    expect(res.status).toBe(200)
    expect(j).toEqual({ ok: true, files: [{ id: 99, filename: 'a.txt', size: 10 }] })
    expect(kv.deleteCalls).toContain('system:stats')
  })

  test('DELETE /files/1 — KV 캐시 무효화 실패 무시 (616)', async () => {
    mockStorageDestroy.mockResolvedValue(undefined)
    const { req, db, kv } = makeMemoApp({ kvThrows: true })
    db.allQueue.push([{ storage_key: 'k', resource_type: 'image' }])
    const res = await req('/files/1', { method: 'DELETE' })
    const j = await abody(res)
    expect(res.status).toBe(200)
    expect(j).toEqual({ ok: true })
    expect(kv.deleteCalls).toContain('system:stats')
    expect(mockStorageDestroy).toHaveBeenCalled()
  })
})

// ============================================================
// src/modules/memory/routes.ts
// ============================================================
describe('memory routes', () => {
  class MemoryMockDb {
    firstQueue: any[] = []
    allQueue: any[] = []
    runQueue: any[] = []
    calls: { sql: string; params: any[] }[] = []
    batchCalls: any[][] = []
    batchThrows = false
    async batch(statements: any[]) {
      this.batchCalls.push(statements)
      if (this.batchThrows) throw new Error('batch down')
      return statements.map(() => ({ meta: { changes: 1, last_row_id: 1 } }))
    }
    prepare(sql: string) {
      const db = this
      const exec = (params: any[]) => {
        db.calls.push({ sql, params })
        return {
          first: async () => {
            const v = db.firstQueue.shift()
            if (v === undefined) return null
            if (v instanceof Error) throw v
            return v
          },
          all: async () => {
            const v = db.allQueue.shift()
            if (v === undefined) return { results: [] }
            if (v instanceof Error) throw v
            return { results: v }
          },
          run: async () => {
            const v = db.runQueue.shift()
            if (v === undefined) return { meta: { last_row_id: 1, changes: 1 } }
            if (v instanceof Error) throw v
            return v
          },
        }
      }
      return {
        bind: (...params: any[]) => exec(params),
        first: () => exec([]).first(),
        all: () => exec([]).all(),
        run: () => exec([]).run(),
      }
    }
  }
  function makeMemoryApp(db?: MemoryMockDb) {
    const mock = db ?? new MemoryMockDb()
    const app = new Hono()
    app.route('/a', memoryApp)
    const env: any = { DB: mock }
    const req = (path: string, init?: RequestInit) => app.request('/a' + path, init, env)
    const json = (path: string, method: string, body?: any) =>
      req(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    return { app, db: mock, env, req, json }
  }
  async function abody(res: Response) {
    return res.json() as Promise<any>
  }

  test('POST /extract — 잘못된 JSON → text 필요 (218)', async () => {
    const { req } = makeMemoryApp()
    const res = await req('/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid',
    })
    const j = await abody(res)
    expect(res.status).toBe(400)
    expect(j.error).toBe('text 필요')
  })

  test('POST /pages — 잘못된 JSON → title 필요 (279)', async () => {
    const { req } = makeMemoryApp()
    const res = await req('/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid',
    })
    const j = await abody(res)
    expect(res.status).toBe(400)
    expect(j.error).toBe('title 필요')
  })

  test('POST /5/supersede — 잘못된 JSON → 유효하지 않은 ID (308)', async () => {
    const { req } = makeMemoryApp()
    const res = await req('/5/supersede', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid',
    })
    const j = await abody(res)
    expect(res.status).toBe(400)
    expect(j.error).toBe('유효하지 않은 ID')
  })

  test('POST /5/supersede — batch 실패 → 500 (323)', async () => {
    const db = new MemoryMockDb()
    db.batchThrows = true
    const { json } = makeMemoryApp(db)
    db.firstQueue.push({ id: 5 })
    db.firstQueue.push({ id: 9 })
    const res = await json('/5/supersede', 'POST', { superseded_by: 9 })
    const j = await abody(res)
    expect(res.status).toBe(500)
    expect(j.error).toBe('db_error')
  })

  test('POST /5/restore — UPDATE 실패 → 500 (336)', async () => {
    const { json, db } = makeMemoryApp()
    db.firstQueue.push({ id: 5 })
    db.runQueue.push(new Error('db down'))
    const res = await json('/5/restore', 'POST', {})
    const j = await abody(res)
    expect(res.status).toBe(500)
    expect(j.error).toBe('db_error')
  })

  test('POST /0/contradiction — 유효하지 않은 ID (343)', async () => {
    const { json } = makeMemoryApp()
    const res = await json('/0/contradiction', 'POST', { flag: true })
    const j = await abody(res)
    expect(res.status).toBe(400)
    expect(j.error).toBe('유효하지 않은 ID')
  })

  test('POST /1/contradiction — 잘못된 JSON → 기본값 false로 처리 (344)', async () => {
    const { req, db } = makeMemoryApp()
    db.firstQueue.push({ id: 1 })
    const res = await req('/1/contradiction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid',
    })
    const j = await abody(res)
    expect(res.status).toBe(200)
    expect(j).toEqual({ ok: true })
  })

  test('POST /1/contradiction — UPDATE 실패 → 500 (350)', async () => {
    const { json, db } = makeMemoryApp()
    db.firstQueue.push({ id: 1 })
    db.runQueue.push(new Error('db down'))
    const res = await json('/1/contradiction', 'POST', { flag: true })
    const j = await abody(res)
    expect(res.status).toBe(500)
    expect(j.error).toBe('db_error')
  })

  test('POST /handoffs — 잘못된 JSON → persona 필요 (362)', async () => {
    const { req } = makeMemoryApp()
    const res = await req('/handoffs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid',
    })
    const j = await abody(res)
    expect(res.status).toBe(400)
    expect(j.error).toBe('persona 필요')
  })
})

// ============================================================
// src/modules/artifact/job-processor.ts
// ============================================================
describe('job-processor', () => {
  type Handler = (sql: string, params: any[], method: 'first' | 'all' | 'run') => any
  function norm(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim()
  }
  function makeDb(handler: Handler) {
    const calls: { sql: string; params: any[]; method: string }[] = []
    const db = {
      calls,
      prepare(sql: string) {
        return {
          bind(...params: any[]) {
            return {
              first: async () => {
                calls.push({ sql: norm(sql), params, method: 'first' })
                return handler(norm(sql), params, 'first')
              },
              all: async () => {
                calls.push({ sql: norm(sql), params, method: 'all' })
                return handler(norm(sql), params, 'all')
              },
              run: async () => {
                calls.push({ sql: norm(sql), params, method: 'run' })
                return handler(norm(sql), params, 'run')
              },
            }
          },
        }
      },
      batch: async (stmts: any[]) => {
        calls.push({ sql: '__BATCH__', params: stmts, method: 'batch' })
        return []
      },
    }
    return db
  }
  const okRun = (changes = 1, lastRowId = 1) => ({ meta: { changes, last_row_id: lastRowId } })
  const mkEnv = (db: any) => ({ DB: db } as any)
  const baseJob = (over: any = {}) => ({
    id: 1,
    kind: 'create',
    prompt: '계산기 앱 만들어줘',
    status: 'running',
    model: 'gemini-3.5-flash-lite',
    provider: 'gemini',
    artifact_id: null,
    base_html: null,
    lease_token: 'lease-1',
    created_at: '2026-10-17 00:00:00',
    ...over,
  })
  const agentOk = (files: Record<string, string> = { 'index.html': '<!DOCTYPE html><html><body>hi</body></html>' }, extra: any = {}) => ({
    ok: true,
    files,
    summary: '',
    ...extra,
  })
  function createDb(job: any, opts: any = {}) {
    return makeDb((sql, params, m) => {
      if (sql.startsWith('UPDATE artifact_jobs SET status=\'running\'')) return okRun(1)
      if (sql.includes('SELECT * FROM artifact_jobs WHERE id=?')) return job
      if (sql.includes('SELECT artifact_id FROM artifact_jobs WHERE id=?')) return { artifact_id: opts.dupArtifactId ?? null }
      if (sql.includes('SELECT row_revision FROM artifacts')) return { row_revision: 1 }
      if (sql.includes('SELECT MAX(version_no)')) return { results: [{ m: opts.maxV ?? 0 }] }
      if (sql.includes('artifact_versions WHERE artifact_id=? AND content_sha256=?')) return opts.existingVer ?? null
      if (sql.startsWith('INSERT INTO artifact_versions')) return okRun(1, opts.versionId ?? 11)
      if (sql.startsWith('INSERT INTO artifacts')) return okRun(1, opts.artifactId ?? 5)
      if (sql.startsWith('UPDATE artifacts SET draft_version_id')) return okRun(1)
      if (sql.startsWith('UPDATE artifacts SET project_type')) return okRun(1)
      if (sql.includes('UPDATE artifact_jobs SET status=\'done\'')) return okRun(opts.doneChanges ?? 1)
      if (sql.includes('INSERT INTO artifact_job_events')) return okRun(1)
      if (sql.includes('SELECT value FROM ai_settings')) return opts.setting ?? null
      if (sql.includes('SELECT draft_version_id FROM artifacts')) return opts.art ?? null
      if (sql.includes('SELECT file_path, content FROM artifact_files')) return { results: opts.files ?? [] }
      if (m === 'run') return okRun(1)
      return null
    })
  }

  test('onFileWrite — null/초과/일반 내용 스트리밍 (152/153/155/156)', async () => {
    mockRunStudioAgent.mockImplementationOnce(async (_env: any, _sysCtx: any, opts: any) => {
      opts.onFileWrite('index.html', '<html>hi</html>')
      opts.onFileWrite('big.css', 'x'.repeat(200001))
      opts.onFileWrite('gone.html', null)
      return agentOk()
    })
    const db = createDb(baseJob())
    const r = await processArtifactJob(mkEnv(db), 1)
    expect(r).toBe('done')
    const streams = db.calls
      .filter((c) => c.sql.includes('INSERT INTO artifact_job_events') && c.params[1] === 'file.stream')
      .map((c) => JSON.parse(c.params[2]))
    expect(streams).toHaveLength(3)
    expect(streams[0]).toEqual({ file_path: 'index.html', content: '<html>hi</html>', truncated: false })
    expect(streams[1].file_path).toBe('big.css')
    expect(streams[1].truncated).toBe(true)
    expect(streams[1].content).toHaveLength(200000)
    expect(streams[2]).toEqual({ file_path: 'gone.html', content: null, truncated: false })
  })

  test('generateHtml — 180초 타이머 만료 → 타임아웃 (412)', async () => {
    mockGenerateArtifactHtml.mockImplementation(async (
      _e: any, _j: any, _l: any, _w: any, _s: any, _c: any, signal: AbortSignal,
    ) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('AI_TIMEOUT'), { name: 'AbortError' }))
        })
      })
    })
    jest.useFakeTimers()
    try {
      const p = generateHtml(mkEnv(makeDb(() => okRun())), 'sysCtx', 1, 'lease-1', 'wf-1')
      await jest.advanceTimersByTimeAsync(180_000)
      const r = await p
      expect(r).toEqual({ html: '', title: '', error: 'AI 타임아웃 (180초)' })
    } finally {
      jest.useRealTimers()
    }
  })
})

/**
 * 도달 불가로 판단한 라인 (억지로 커버하지 않음 — 이유와 함께 기록)
 * ----------------------------------------------------------------
 * - src/modules/artifact/job-processor.ts:157 — onFileWrite의 .catch(()=>{}):
 *   logJobEvent가 내부에서 모든 오류를 잡아 절대 reject하지 않음.
 * - src/services/ai.ts:196 — revokeKeyForModel의 `if (idx < 0) return`:
 *   ks는 항상 해당 풀에서 온 것이라 idx >= 0.
 * - src/services/ai.ts:383 — classifyNvidiaFailure 429 분기:
 *   유일한 호출자 callNVIDIA가 429를 먼저 던져 429가 도달하지 않음.
 * - src/services/ai.ts:575 else — selectModel 체인 `if (!exclude.has(nextId))`의 else:
 *   유일한 (failedId, nextId) 쌍은 (3.5, 3.1)이라 nextId 제외 시 둘 다 제외되어
 *   geminiFailed >= 2가 되고 체인 블록 자체가 건너뛰어짐.
 * - src/services/ai.ts:994 — `if ((out as any).pipeline)`: 어떤 프로바이더도
 *   출력에 pipeline을 설정하지 않음.
 * - src/services/ai.ts:1046 우측 — `throw lastError ?? new Error('ai failed')`의
 *   우측: 루프는 return/throw로만 빠져나가 lastError가 항상 설정됨.
 * - src/services/ai.ts:1315 — buildPeerContext의 빈 peers 분기: PERSONAS 4개라
 *   필터 후 항상 3개 이상 남음.
 * - src/services/ai.ts:1338/1341 — buildSystemPrompt의 capabilities/handoffWhen
 *   else: 4개 PERSONAS 모두 비어있지 않음.
 * - src/services/ai.ts:219 — callGemini 기본 인자 useSearch=false: 호출자가 항상 명시.
 * - src/ai/providers/gemini.ts:258 — callViaRelay의 relayUrl 없음 가드: 호출 전 검사됨.
 * - src/services/skill-registry.ts:42 — toLegacyPersonaId의 빈 값 분기: 호출처가 먼저 검사.
 * - src/services/recurrence.ts:127 — matchesRule default: parseRRule이 3개 freq만 반환.
 * - src/services/recurrence.ts:105 — parseRRule UNTIL 무효 분기: DATE_RE는
 *   /^\d{4}-\d{2}-\d{2}$/ 형식만 검사해 8자리 이상 숫자는 항상 통과하므로
 *   `until = null` 대입에 도달 불가. (부수 발견: '2026-13-40' 같은 무효 월도
 *   until로 그대로 저장되어 expandRecurrence에서 문자열 비교상 영원히 도달하지
 *   않아 사실상 무시됨 — 경미한 검증 누락으로 보고, 수정하지 않음.)
 * - src/ai/runner.ts:359 — `toolDef?.mode || 'read'` 우측: 351번 가드
 *   `toolDef?.mode === 'read'`를 통과해야만 들어오므로 toolDef는 항상 정의됨.
 *   starts.length === pool.length가 전제라 각 항목이 URL을 최대 1개씩 소비하면 소진 불가.
 * - src/lib/text-diff.ts:76 — ranges 빈 분기: 텍스트가 다르면 백트래킹이 항상 1개 이상 생성.
 * - src/ai/memo-fc-tools.ts:336 — extractEmbeddedToolCalls의 비객체 분기:
 *   균형 잡힌 중괄호 후보가 파싱되면 항상 객체.
 * - src/services/tool-approval.ts:215 — decideToolExecution의 risk 'unknown':
 *   모든 전문가 도구가 4개 위험 목록 중 하나에 속함.
 * - src/ai/memo-tool-dispatcher.ts:106 — assertToolCallAllowed 뒤 throw e:
 *   해당 함수는 PolicyViolationError만 던짐.
 * - src/ai/memo-tool-dispatcher.ts:154 — dispatchCronToolCall falsy 반환:
 *   검증이 알 수 없는 cron_* 이름을 먼저 거부하고 유효한 4개는 모두 처리됨.
 * - src/modules/auth/routes.ts:699 — isValidB64의 catch: atob이 던지는 경우는
 *   정규식이 먼저 거부함.
 * - src/services/ai.ts:474 — (이번 작업에서 커버됨: workers-ai 빈 응답 테스트)
 * - src/ai/runner.ts:359 — (위 참조)
 * - src/services/agent-run.ts:358/370, src/services/approval-flow.ts:481,
 *   src/services/google-tools.ts:167 — 부모가 이미 도달 불가로 기록 (건드리지 않음).
 */
