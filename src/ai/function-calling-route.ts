/**
 * Function Calling Hono 통합 — Phase 1G-C
 *
 * POST /api/ai/chat에서 feature flag에 따라 새 엔진을 사용.
 * - 기본값: legacy (기존 마커 엔진)
 * - ai.engine=function_calling이면 새 엔진
 * - 초기 파일럿: 캘리 + search_memo 읽기 전용
 */

import type { Context } from 'hono'
import type { Env } from '../types'
import { getSetting } from '../services/ai'
import { ToolRegistry } from './tools/registry'
import { createFCToolRegistry } from './tools/fc-registry'
import { GroqAdapter } from './providers/groq'
import { GeminiAdapter } from './providers/gemini'
import { WorkersAIAdapter } from './providers/workers-ai'
import { D1RunLogger } from './run-logger'
import { ModelRouter, resolveSensitivity, isVerifiedModel, type SensitivityLevel } from './model-router'
import {
  isPromptV2Enabled,
  createRequestTimeContext,
  composeV2Prompt,
  resolvePromptVersion,
  getPersonaCapabilities,
  LEGACY_PROMPT_VERSION, isPromptV2EnabledForPersona} from './prompt-integration'
import { PERSONA_REGISTRY } from './persona-registry'
import { FallbackController } from './fallback-controller'
import { inspectEgress } from '../services/privacy-gateway'
import { resolveRequestSensitivity, getLegacyMarkerTools } from './legacy-privacy-guard'

// 파일럿 허용 비서
// 주의: 'concierge'는 루미 (Phase 3A 매핑 확정)
// 이전 주석의 "캘리" 표기는 오류였음 — 실제 PERSONAS 정의 기준
const PILOT_ASSISTANTS = ['concierge'] // 루미

// 파일럿 허용 도구 (읽기 전용)
const PILOT_TOOLS = ['search_memo']

/**
 * Function Calling 엔진 사용 여부 확인
 *
 * 다중 방어:
 * 1. ENVIRONMENT === 'staging' (운영 환경 보호)
 * 2. 파일럿 비서(concierge)만 허용
 * 3. ai.engine=function_calling 설정 필요
 * 4. ai.fc_test_approved=true 필요
 */
export async function shouldUseFunctionCalling(
  db: D1Database,
  personaId: string,
  env?: any
): Promise<boolean> {
  // 1. 스테이징 환경 확인 (운영 환경 보호)
  // ENVIRONMENT가 명시적으로 'staging'이어야 함
  const environment = (env as any)?.ENVIRONMENT
  if (environment !== 'staging') {
    return false
  }
  // 2. 파일럿 비서가 아니면 legacy
  if (!PILOT_ASSISTANTS.includes(personaId)) {
    return false
  }
  // 3. feature flag 확인 (기본값: legacy)
  // 엄격한 문자열 비교 ("false"가 truthy로 처리되지 않도록)
  const engine = await getSetting(db, 'ai.engine')
  if (engine !== 'function_calling') {
    return false
  }
  // 4. 테스트 환경 승인 (서버 측, 엄격한 비교)
  const testApproved = await getSetting(db, 'ai.fc_test_approved')
  if (testApproved !== 'true') {
    return false
  }
  return true
}

/**
 * Function Calling으로 채팅 처리 (Phase 2B-V: FallbackController 연결)
 */
export async function chatWithFunctionCalling(
  c: Context<{ Bindings: Env }>,
  personaId: string,
  messages: Array<{ role: string; content: string }>,
  options?: { conversationId?: string | number; userId?: string }
): Promise<{ ok: boolean; text?: string; error?: string; runId?: string; provider?: string; model?: string; promptVersion?: string }> {
  const env = c.env
  const db = env.DB

  // Privacy 게이트 (진입): 마지막 사용자 발화 기준 민감도로 출구 검사
  const gateLastUserText = [...messages].reverse().find((m) => m.role !== 'assistant')?.content ?? ''
  let gateSensitivity: SensitivityLevel
  try {
    gateSensitivity = resolveRequestSensitivity(personaId, gateLastUserText, getLegacyMarkerTools(personaId)).sensitivity
  } catch {
    gateSensitivity = 'personal'
  }
  const gate = inspectEgress({
    origin: 'fc-route',
    policy: { sensitivity: gateSensitivity },
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  })
  if (gate.action === 'block') {
    return { ok: false, error: 'PRIVACY_BLOCKED' }
  }
  if (gate.action === 'tokenized') {
    messages = gate.messages.map((m) => ({ role: m.role, content: m.content }))
  }

  // 사용자 ID (인증된)
  const userId = 'default_user'
  const requestId = `req_${Date.now().toString(36)}`

  // 마지막 사용자 메시지
  const userMessages = messages.filter(m => m.role === 'user' || m.role !== 'assistant')
  const lastUserMessage = userMessages[userMessages.length - 1]?.content || ''

  // 세션 생성 팩토리 (Provider별 Adapter)
  // Mock 오류 주입 (스테이징 내부 테스트용, 외부 조작 불가)
  // ai.fc_test_mock_error 설정: "groq:429", "groq:503", "groq:401" 등
  // 첫 Provider 호출 시 지정된 오류를 발생시켜 Fallback 테스트
  const mockError = await getSetting(db, 'ai.fc_test_mock_error')

  const createSession = (providerId: string, modelId: string): any => {
    // Mock 오류 주입: 지정된 Provider의 첫 호출에서 오류 발생
    if (mockError) {
      const [mockProvider, mockCode] = mockError.split(':')
      if (mockProvider === providerId) {
        return createMockErrorSession(providerId, modelId, mockCode)
      }
    }

    if (providerId === 'groq') {
      const apiKey = (env as any).GROQ_API_KEY_1
      if (!apiKey) throw new Error('Provider not configured: groq')
      return new GroqAdapter({ apiKey, model: modelId })
    } else if (providerId === 'gemini') {
      const apiKey = (env as any).GEMINI_API_KEY_1
      if (!apiKey) throw new Error('Provider not configured: gemini')
      return new GeminiAdapter({
        apiKey,
        model: modelId,
        relayUrl: (env as any).GEMINI_RELAY_URL,
        relaySecret: (env as any).GEMINI_RELAY_SECRET,
        // R-05: 진입 게이트의 등급을 어댑터까지 전달 — L2+는 릴레이 금지
        privacyLevel: gate.level,
      })
    } else if (providerId === 'workers-ai') {
      const aiBinding = (env as any).AI
      if (!aiBinding) throw new Error('Workers AI binding not configured')
      return new WorkersAIAdapter({ ai: aiBinding, model: modelId, apiMode: 'native' })
    }
    throw new Error(`Unknown provider: ${providerId}`)
  }

  /**
   * Mock 오류 세션 (테스트용)
   * 지정된 오류 코드로 즉시 실패하는 가짜 세션
   */
  function createMockErrorSession(providerId: string, modelId: string, errorCode: string): any {
    const errorMap: Record<string, { code: string; status: number; message: string }> = {
      '429': { code: 'RATE_LIMITED', status: 429, message: 'Rate limited (mock)' },
      '503': { code: 'SERVICE_UNAVAILABLE', status: 503, message: 'Service unavailable (mock)' },
      '401': { code: 'AUTH_ERROR', status: 401, message: 'Unauthorized (mock)' },
      '403': { code: 'AUTH_ERROR', status: 403, message: 'Forbidden (mock)' },
      '500': { code: 'UNKNOWN', status: 500, message: 'Internal error (mock)' },
    }
    const err = errorMap[errorCode] || errorMap['500']
    return {
      provider: providerId,
      modelId,
      addUserMessage: () => {},
      setSystemPrompt: () => {},
      next: async () => {
        const e: any = new Error(err.message)
        e.code = err.status
        throw e
      },
    }
  }

  // 도구 레지스트리 팩토리 (공유 모듈 — 디버그 엔드포인트도 같은 팩토리를 읽는다)
  const createRegistry = (): ToolRegistry => createFCToolRegistry(db)

  // Phase 2B-V: FallbackController 사용
  // - ModelRouter로 첫 Provider 선택
  // - 실패 시 정책에 따라 최대 1회 Fallback
  // - 오버라이드 설정이 있으면 첫 Provider로 강제 (정책 검증 후)
  const router = new ModelRouter()

  // 테스트용: 도구 비활성화 플래그 (스테이징 내부 설정, 외부 조작 불가)
  // 일반 요청 Fallback 테스트용 (search_memo 없이 비민감 경로 검증)
  const noToolsFlag = await getSetting(db, 'ai.fc_test_no_tools')
  const testNoTools = noToolsFlag === 'true'
  const effectiveTools = testNoTools ? [] : ['search_memo']

  const { sensitivity } = resolveSensitivity({
    text: lastUserMessage,
    availableTools: effectiveTools,
  })

  const overrideProvider = await getSetting(db, 'ai.fc_provider')
  const overrideModel = await getSetting(db, 'ai.fc_model')

  // 오버라이드 검증 (승인 조건 A: 최초 Provider도 전체 정책 통과 필수)
  let forcedProvider: string | undefined
  let forcedModel: string | undefined
  if (overrideProvider) {
    // 1. Provider 정책 검증 (민감도, 상태, 릴레이 등)
    const check = router.canUseProvider(overrideProvider as any, sensitivity)
    if (!check.allowed) {
      return { ok: false, error: `Provider not allowed: ${check.reason}` }
    }
    // 2. 모델 검증 (실제 검증된 모델만 허용)
    const modelToUse = overrideModel || 'openai/gpt-oss-120b'
    if (!isVerifiedModel(overrideProvider as any, modelToUse)) {
      return { ok: false, error: `Model not verified: ${modelToUse}` }
    }
    forcedProvider = overrideProvider
    forcedModel = modelToUse
  }

  // Phase 3D: 프롬프트는 한 번만 합성 (시간 컨텍스트 일관성)
  const fcPrompt = await buildFCSystemPrompt(db, personaId, effectiveTools, testNoTools)

  const controller = new FallbackController({
    db,
    env,
    logger: new D1RunLogger({ db }),
    router,
    createSession: (provider, model) => {
      // 오버라이드가 있으면 첫 시도에만 적용
      const p = forcedProvider || provider
      const m = forcedModel || model
      forcedProvider = undefined // 한 번만 사용
      forcedModel = undefined
      return createSession(p, m)
    },
    createRegistry,
    systemPrompt: fcPrompt.prompt,
    allowedTools: effectiveTools,
    maxFallbacks: 1,
  })

  const result = await controller.execute({
    userId,
    personaId,
    messages,
    availableTools: effectiveTools,
    // 채팅 라우트(POST /api/ai/chat)에서만 도달하는 대화형 실행 (③-A)
    origin: 'interactive',
  })

  if (result.ok) {
    return {
      ok: true,
      // R-09 (배치 C 게이트에서 확정): 진입 게이트가 토큰화한 내용을 모델이
      // 되돌려 말하면 토큰이 사용자 화면에 그대로 노출된다 — 스튜디오
      // 경로(CW5)와 동일하게 반환 직전 vault로 복원한다. 복원은 외부 전송이
      // 끝난 뒤 서버 내부 산출물에만 적용된다.
      text: gate.vault.desanitize(result.text ?? ''),
      runId: requestId,
      provider: result.provider,
      model: result.model,
      promptVersion: fcPrompt.version,
    }
  } else {
    return { ok: false, error: 'AI 처리 중 오류가 발생했습니다.' }
  }
}

/**
 * Phase 3D: FC 시스템 프롬프트 빌더
 *
 * - 플래그 off → 기존 하드코딩 지시 그대로 (동작 변경 없음)
 * - 플래그 on → Prompt Composer + 기존 FC 도구 지시 보존
 * - FC는 concierge(루미) 파일럿만 대상 (캘리 자동 활성화 금지)
 */
async function buildFCSystemPrompt(
  db: any,
  personaId: string,
  effectiveTools: string[],
  testNoTools: boolean
): Promise<{ prompt: string; version: string }> {
  const useV2 = await isPromptV2EnabledForPersona(db, personaId)
  if (!useV2) {
    return {
      prompt: testNoTools
        ? `You are a helpful assistant.`
        : `You are a helpful assistant. Use search_memo to find relevant memos when the user asks about past notes.`,
      version: LEGACY_PROMPT_VERSION,
    }
  }

  // v2: Composer로 합성하되, 기존 FC 도구 지시를 보존
  const timeCtx = await createRequestTimeContext(db)
  const composed = composeV2Prompt(personaId, {
    timeContext: timeCtx,
    capabilities: getPersonaCapabilities(personaId),
    allowedTools: effectiveTools,
  })
  const fcToolNote = testNoTools
    ? ''
    : '\n\nUse search_memo to find relevant memos when the user asks about past notes.'
  return { prompt: composed.prompt + fcToolNote, version: composed.version }
}
