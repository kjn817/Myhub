// MyHub 공용 AI 서비스
// 화면의 비서(Persona)와 실제 실행(Capability)을 분리한다.
// Persona는 아바타·말투, Capability는 실행 가능한 능력, Policy가 둘을 연결한다.
// 키 개수로 쿼터를 계산하지 않는다 — provider별 실측 한도와 fallback으로 관리한다.
import type { Env } from '../types'
import {
  checkProviderAllowed,
  checkDataPolicy,
  resolvePolicySensitivity,
  PrivacyBlockedError,
  type SensitivityLevel,
} from '../ai/legacy-privacy-guard'
// 에코(keeper) Function Calling (2026-10-13 P0)
// - 스킬 패키지 (2026-10-26 e트랙): 도구 정의는 skill-registry가 소유하고,
//   ai.ts는 턴 의도에 맞는 스킬의 도구만 받는다 (MEMO/CRON_FC_TOOLS 직접 참조 금지)
import { extractEmbeddedToolCalls, normalizeToolCall, preflightToolCalls, prepareToolsFor } from '../ai/memo-fc-tools'
import { resolveSkillsForTurn } from './skill-registry'
import { dispatchToolCalls } from '../ai/memo-tool-dispatcher'
// E2 쓰기 승인 게이트 (D1 정렬, 2026-10-31): FC 쓰기·파괴적 호출은
// 디스패치 전에 fc-approval-gate를 거친다 (E1과 같은 승인 왕복 재사용)
import { gateFCToolCall, isFCApprovalGated } from './fc-approval-gate'
import { isFCWriteTool } from './fc-tool-policy'
// NVIDIA 메모 가드 (트랙 1): 메모 컨텍스트가 실리는 keeper 요청을
// NVIDIA Trial 경로에서 제외한다 (docs/nvidia-terms-review-20261029.md)
import {
  classifyMemoContext,
  withPersonalDataSignal,
  resolveEffectivePolicy,
  assertNoMemoContentForNvidia,
  assertNoMemoDerivedContentForNvidia,
  NvidiaMemoGuardError,
} from './nvidia-memo-guard'
import { validateCronFCArgs } from '../ai/cron-fc-tools'
import { validateScheduleFCArgs } from '../ai/schedule-fc-tools'
// 프로바이더 플러그인 레지스트리 (OpenClaw 패턴 — 트랙 5)
// - ProviderId 정의는 레지스트리가 소유, 여기는 재노출 (기존 import 경로 유지)
import { registerProvider, getProvider } from './provider-registry'
import type { ProviderId } from './provider-registry'
export type { ProviderId } from './provider-registry'
// 공용 타입은 잎 모듈 ai-types.ts가 소유한다 (트랙 D 순수 이동) — 여기서
// re-export하므로 기존 import 경로(services/ai)는 그대로 유효하다.
import type { ChatMessage, TaskPolicy, AIResult, UsageEngine, UsageRecord, ModelDef } from './ai-types'
import { UNATTRIBUTED } from './ai-types'
export type { ChatMessage, TaskPolicy, AIResult, UsageEngine, UsageRecord, ModelDef } from './ai-types'
// 키 풀은 ai-key-pool.ts가 소유한다 (트랙 D 순수 이동)
import { getPool, pickKey, pickKeyForModel, revokeKeyForModel, type KeyState } from './ai-key-pool'
// Provider별 실제 호출은 ai-provider-calls.ts가 소유한다 (트랙 D 순수 이동)
import { callGemini, callGroq, callNVIDIA, callWorkersAI } from './ai-provider-calls'
export { stripThinkingBlocks } from './ai-provider-calls'
// FC 순수 헬퍼는 ai-fc-helpers.ts가 소유한다 (트랙 D 순수 이동)
import { AI_CHAT_TOTAL_TIMEOUT_MS, buildFCFollowUpMessages, fcWriteSignature, FC_FINAL_RULES, FC_WRITE_TOOL_NAMES } from './ai-fc-helpers'
import { isFcEnabledForPersona } from './ai-engine-flags'
export { AI_CHAT_TOTAL_TIMEOUT_MS, buildFCFollowUpMessages, fcWriteSignature, FC_WRITE_TOOL_NAMES } from './ai-fc-helpers'
// Privacy Gateway — 모든 AI 출구의 관문 (차단/토큰화 판정 + 도구 결과 검사)
// 실행 원장 (K-03) — 런 귀속·검증된 성공 판정
// 모델 레지스트리·모델 선택은 ai-models.ts / ai-model-selection.ts가 소유한다 (트랙 D 순수 이동)
import { MODELS } from './ai-models'
export { MODELS } from './ai-models'
import { selectModel } from './ai-model-selection'
export { getSetting, setSetting } from './ai-model-selection'
import { PrivacyGatewayBlockedError, inspectToolResult } from './privacy-gateway'
import { inspectAiChatEgress } from './privacy-korean-mode'
import { redactStringForLog } from './privacy-engine'
// OTEL 스팬 식별자 (0057, 트랙 C2) — SDK 없이 규약만 차용
import { newSpanId, newTraceId, type TraceContext } from '../lib/trace'
import { remainingMs } from '../lib/deadline'
import { newLedgerRunId, finishLedgerRun, isLedgerVerifiedSuccess, findLedgerVerifiedSuccess, hasUnverifiedSuccess } from './tool-ledger'
// 도구 시스템은 안정성 확인 후 재활성화 예정
// import { getToolDefinitions, executeTool } from './tools'
// import { registerBuiltinTools } from './tools-builtin'
// registerBuiltinTools()

// ---------------------------------------------------------------------------
// 사용량 원장 (D1 — KV는 정확한 카운터에 부적합)
// ---------------------------------------------------------------------------

async function logUsage(db: D1Database, rec: UsageRecord): Promise<void> {
  // OTEL 스팬 (0057): 호출자가 안 주면 이 LLM 호출을 루트로 삼는다.
  const traceId = rec.traceId || newTraceId()
  const spanId = rec.spanId || newSpanId()
  const createdAt = new Date().toISOString()
  const insert = async (sql: string, params: unknown[]): Promise<void> => {
    await db.prepare(sql).bind(...params).run()
  }
  try {
    // 정식 형식: 0065(engine·persona 귀속) + 0064(neurons) + 런 귀속(run_id·call_index) 포함
    await insert(
      'INSERT INTO ai_usage (provider, model, capability, latency_ms, input_tokens, output_tokens, neurons, outcome, trace_id, span_id, parent_span_id, prompt_version, created_at, engine, persona, run_id, call_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        rec.provider, rec.model, rec.capability, rec.latencyMs,
        rec.inputTokens ?? null, rec.outputTokens ?? null, rec.neurons ?? null,
        rec.outcome, traceId, spanId, rec.parentSpanId ?? null,
        rec.promptVersion ?? null, createdAt,
        // 귀속 경계 보장: 정식 형식으로 기록되는 행은 engine·persona가
        // 절대 NULL로 남지 않는다. 판정 불가·맥락 부재는 'unattributed'
        // 센티넬로 저장해, NULL(=미기록·레거시)과 구분한다 (ai-types 어휘).
        rec.engine ?? UNATTRIBUTED, rec.persona ?? UNATTRIBUTED,
        // 런 귀속 (K-03): aiChat 경로는 턴 runId를 항상 실으므로 신규
        // 행의 run_id NULL은 유틸 직접 호출 등 런이 없는 경우뿐이다.
        rec.runId ?? null, rec.callIndex ?? null,
      ]
    )
  } catch {
    // 0065(귀속 컬럼) 미적용 DB에서는 위 INSERT가 실패한다 — 귀속 없는
    // 0064 형식으로 한 번 더 시도해 원장 자체가 끊기지 않게 한다.
    try {
      await insert(
        'INSERT INTO ai_usage (provider, model, capability, latency_ms, input_tokens, output_tokens, neurons, outcome, trace_id, span_id, parent_span_id, prompt_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          rec.provider, rec.model, rec.capability, rec.latencyMs,
          rec.inputTokens ?? null, rec.outputTokens ?? null, rec.neurons ?? null,
          rec.outcome, traceId, spanId, rec.parentSpanId ?? null,
          rec.promptVersion ?? null, createdAt,
        ]
      )
    } catch {
      // 0064(neurons 컬럼)도 미적용인 DB — 컬럼 없는 기존 형식으로 최종 시도.
      try {
        await insert(
          'INSERT INTO ai_usage (provider, model, capability, latency_ms, input_tokens, output_tokens, outcome, trace_id, span_id, parent_span_id, prompt_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            rec.provider, rec.model, rec.capability, rec.latencyMs,
            rec.inputTokens ?? null, rec.outputTokens ?? null,
            rec.outcome, traceId, spanId, rec.parentSpanId ?? null,
            rec.promptVersion ?? null, createdAt,
          ]
        )
      } catch {
        /* 원장 실패가 본 요청을 막지 않음 */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 메인 진입점
// ---------------------------------------------------------------------------


export const CAPACITY_BACKOFF_MS = 800

export function capacityBackoffDelayMs(error: any, opts: { attempt: number; attemptBudget: number; remainingMs: number }): number {
  if (opts.attempt + 1 >= opts.attemptBudget) return 0
  const msg = String(error?.message || error || '')
  const isCapacity = error?.kind === 'model_capacity' || error?.code === 503 || /resourceexhausted/i.test(msg)
  if (!isCapacity) return 0
  if (opts.remainingMs <= CAPACITY_BACKOFF_MS) return 0
  return CAPACITY_BACKOFF_MS
}

export async function aiChat(
  env: Env,
  policy: TaskPolicy,
  messages: ChatMessage[],
  context?: { userId?: string; conversationId?: string; signal?: AbortSignal; disableRetry?: boolean; trace?: TraceContext; promptVersion?: string; totalTimeoutMs?: number; turnWriteResults?: Map<string, any> }
): Promise<AIResult> {
  const t0 = Date.now()
  const db = env.DB
  const ledgerRunId = newLedgerRunId()
  const ledgerRequestId = context?.trace?.traceId || ledgerRunId
  // 전체 deadline: 진입 시점에 고정한다.
  const deadline = t0 + (context?.totalTimeoutMs ?? AI_CHAT_TOTAL_TIMEOUT_MS)

  // 입력 길이 가드 + 메시지 정규화 (TimelyAI 권고: malformed payload 방지)
  const maxChars = policy.maxInputChars ?? 12000
  let safeMessages = messages
    .filter((m) => m && ['system', 'user', 'assistant'].includes(m.role))
    .map((m) => ({
      role: m.role as 'system' | 'user' | 'assistant',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
    }))
    .map((m) => ({
      ...m,
      content: m.content.length > maxChars ? m.content.slice(0, maxChars) + '\n…(잘림)' : m.content,
    }))
    .filter((m) => m.content.trim().length > 0)

  if (safeMessages.length === 0) {
    throw new Error('no valid messages after normalization')
  }

  // Privacy Gateway — 진입 시점 출구 검사 (전 AI 출구의 관문).
  // 차단이면 전송하지 않고, 토큰화면 토큰화된 메시지로 교체해 진행한다.
  // 복원은 이 턴의 vault로만 수행한다 (최종 응답 desanitize 참조).
  const egress = await inspectAiChatEgress(db, {
    origin: 'aiChat',
    policy: { sensitivity: policy.sensitivity, privacy: policy.privacy },
    messages: safeMessages,
    memoDerived: !!policy.memoDataInjected,
  })
  if (egress.action === 'block') {
    console.warn('privacy_gateway_blocked', { origin: 'aiChat', reasons: egress.reasons.join(',') })
    throw new PrivacyGatewayBlockedError(egress.reasons)
  }
  if (egress.action === 'tokenized') {
    console.info('privacy_gateway_tokenized', { origin: 'aiChat', level: egress.level, reasons: egress.reasons.join(',') })
    safeMessages = egress.messages as typeof safeMessages
  }
  const privacyVault = egress.vault
  const privacyLevel = egress.level

  // NVIDIA 메모 가드 — 라우팅 (트랙 1, fail-closed)
  // 메모 컨텍스트를 포함하거나 포함할 수 있는 keeper 요청은 NVIDIA 대신
  // Workers AI로 보낸다. 분류는 구조적 신호만으로 결정적으로 수행하고
  // (nvidia-memo-guard.ts), effective pin을 workers-ai로 바꾸면
  // selectModel의 scopedModels·오버라이드·폴백이 전부 workers-ai 안에서
  // 돈다 (ai_settings의 model.<capability> 오버라이드가 NVIDIA 모델을
  // 가리켜도 scopedModels 밖이라 선택되지 않음을 selectModel에서 확인).
  // resolveSkillsForTurn은 lastUserText + personaId만으로 결정되므로
  // 모델 선택 전에 계산할 수 있다.
  const lastUserTextForGuard = [...safeMessages].reverse().find((m) => m.role === 'user')?.content ?? ''
  // 턴 일관성: 스킬 결정 입력은 policy.skillText(턴 원본 사용자 텍스트)를
  // 우선한다. [SEARCH:] 후속 호출처럼 마지막 user 메시지가 합성
  // 프롬프트인 경우에도 가드 분류가 턴 시작과 달라지지 않게 한다.
  const guardSkillText = policy.skillText ?? lastUserTextForGuard
  const guardSkillLoad = policy.personaId === 'keeper'
    ? resolveSkillsForTurn({ text: guardSkillText, personaId: policy.personaId })
    : null
  const memoClassification = withPersonalDataSignal(
    classifyMemoContext({
      policy,
      messages,
      fcToolNames: guardSkillLoad?.tools.map((t) => t.name) ?? [],
    }),
    messages,
  )
  const { policy: effectivePolicy, rerouted: nvidiaRerouted } = resolveEffectivePolicy(policy, memoClassification)
  if (nvidiaRerouted) {
    // 관측: 사유만 남긴다 (메모 내용·프롬프트는 절대 기록하지 않음).
    // 실제 호출된 프로바이더는 ai_usage 원장에 workers-ai로 기록된다.
    console.info('nvidia_guard_reroute', { persona: policy.personaId, reason: memoClassification.reasons.join(',') })
  }

  // 프롬프트 인젝션 경계: 외부 콘텐츠는 데이터임을 시스템 프롬프트에 명시
  // (호출자가 messages에 넣은 외부 텍스트는 여기서 구분할 수 없으므로,
  //  각 capability 구현에서 외부 텍스트를 별도 블록으로 감싸 전달할 것)

  const tried = new Set<string>()
  let lastError: any = null
  const fallbackChain: string[] = []
  // FC 쓰기 멱등성 (2026-10-30): 이 aiChat 호출 안에서 이미 성공한 생성
  // 호출의 서명 → 결과를 보관한다. FC 라운드가 바뀌거나 모델 폴백으로
  // 시도가 넘어가도 같은 쓰기를 재실행하지 않는다 (중복 생성의 실제
  // 원인이 "실행 후 후속 호출 실패 → 폴백 재실행"이었기 때문 — 아래 루프).
  const executedWriteResults = context?.turnWriteResults ?? new Map<string, any>()
  // Provider 실제 호출 여부 및 마지막 오류 추적 (오류 분류용)
  let providerCallAttempted = false
  let lastProviderError: any = null

  const maxAttempts = context?.disableRetry ? 1 : 4
  // Workers AI 뉴런 소진 degraded 폴백 (2026-10-30, NVIDIA 대체 트랙):
  // 에코가 Workers AI 전담이 되면서 "뉴런 소진 = 에코 전면 중단"이 되는 것을
  // 막는다. 소진(4006) 감지 시에 한해 핀을 풀고 Gemini lite로 1회만
  // 재시도한다 (아래 catch 참조). activePolicy는 그 전까지 effectivePolicy와
  // 동일하며, attemptBudget은 degraded 전환 시에만 1회분 늘어난다.
  let activePolicy = effectivePolicy
  let workersAiQuotaDegraded = false
  let attemptBudget = maxAttempts
  for (let attempt = 0; attempt < attemptBudget; attempt++) {
    // P-5: 전체 deadline 소진 시 다음 모델 시도를 건너뛴다 (이미 실패한
    // 시도가 있으면 lastError를 던져 종료한다).
    if (attempt > 0 && remainingMs(deadline) <= 0) break
    // 경로 귀속 (0065): 이 시도의 engine 태그. 시도 시작 시점에는 degraded
    // 전환 여부로만 판정하고, 아래 try에서 useFC 게이트가 계산되는 즉시
    // 그 값으로 확정한다. catch의 실패 기록도 같은 변수 값을 쓴다.
    let attemptEngine: UsageEngine = workersAiQuotaDegraded ? 'degraded' : 'marker'
    const model = await selectModel(db, activePolicy, tried, { providerCallAttempted, lastProviderError })
    tried.add(model.id)

    // 프로바이더 호출은 플러그인 경유 (미등록 프로바이더는 fail-closed)
    const plugin = getProvider(model.provider)
    if (!plugin) throw new Error(`provider plugin not registered: ${model.provider}`)

    // Phase 3D-P S0.1/S0.2: 실제 호출 직전 민감도 재검사
    const isPrivateCall = policy.privacy === 'private'
    const callSensitivity = resolvePolicySensitivity(policy)
    if (callSensitivity) {
      const callCheck = isPrivateCall
        ? checkDataPolicy(model.provider, callSensitivity)
        : checkProviderAllowed(model.provider, callSensitivity)
      if (!callCheck.allowed) {
        throw new PrivacyBlockedError(
          '개인정보 보호 정책에 따라 이 요청을 처리할 수 있는 AI 모델이 없습니다.',
          callSensitivity,
          callCheck.reason
        )
      }
    }

    // NVIDIA 메모 가드 — 호출 직전 (이중 방어): 라우팅을 우회해 NVIDIA로
    // 향하는 1차 호출에 메모 유래 내용이 있으면 전송하지 않고 중단한다.
    // 라우팅이 정상이면 도달 불가이며, 도달 자체가 버그 신호다.
    if (model.provider === 'nvidia') {
      try {
        assertNoMemoContentForNvidia(safeMessages)
      } catch (e) {
        if (e instanceof NvidiaMemoGuardError) {
          console.warn('nvidia_guard_blocked', { stage: 'pre-call', persona: policy.personaId, reason: (e as any).reason })
        }
        throw e
      }
    }

    try {
      let out: { text: string; inputTokens?: number; outputTokens?: number; neurons?: number; sources?: { title: string; url: string }[]; toolCalls?: any[] }
      let ks: KeyState | null = null
      // 에코(keeper) Function Calling — workers-ai 전용
      // (2026-10-26 P0 수정으로 nvidia까지 확장됐던 게이트를, 2026-10-30
      //  NVIDIA 운영 제외로 workers-ai만으로 되돌림)
      // 스킬 패키지 (2026-10-26 e트랙): 턴 의도에 맞는 스킬의 도구만 로드한다.
      // - 매칭되는 스킬이 없으면 비서 기본 스킬(keeper: 메모+자동화) — 기존 동작 유지
      //   (기존 [...MEMO_FC_TOOLS, ...CRON_FC_TOOLS]와 동일한 도구 집합)
      // - 스킬이 도구 없이 매칭되면(뉴스 등) fcTools 없음 — 마커 경로가 처리한다
      // - degraded Gemini 재시도에서는 useFC=false — 도구 없는 일반 답변이다
      const useFC = await isFcEnabledForPersona(db, policy.personaId) && model.provider === 'workers-ai'
      const lastUserText = [...safeMessages].reverse().find((m) => m.role === 'user')?.content ?? ''
      // 턴 일관성: 가드 분류와 같은 입력(policy.skillText 우선)을 써야
      // 두 결정이 어긋나지 않는다 (분류만 풀고 도구는 그대로 두는 것은 금지).
      const skillLoad = useFC ? resolveSkillsForTurn({ text: policy.skillText ?? lastUserText, personaId: policy.personaId, toolPath: 'fc' } as any) : null
      const fcTools = skillLoad && skillLoad.tools.length > 0 ? skillLoad.tools : undefined
      // 경로 귀속 확정 (0065): 판정 근거는 실제 분기인 useFC 게이트 값 그
      // 자체다. degraded 재시도 시도는 게이트와 무관하게 'degraded'가 우선
      // 한다 (그 시도에서는 useFC가 꺼져 있어도 1차 경로의 대체 서빙이다).
      attemptEngine = workersAiQuotaDegraded ? 'degraded' : useFC ? 'builtin-fc' : 'marker'
      if (model.provider === 'gemini') {
        const pool = getPool(env, 'gemini')
        ks = pickKeyForModel(pool, model.id)
        if (!ks) throw Object.assign(new Error('no gemini key available'), { code: 429 })
        try {
          out = await plugin.call({ env, key: ks.key, model: model.id, messages: safeMessages, useSearch: policy.useSearch ?? false, sensitivity: resolvePolicySensitivity(policy), signal: context?.signal, privacyLevel })
          ks.failures = 0
        } catch (e: any) {
          // 429만 쿨다운. 503 ResourceExhausted(Worker local)는 일시적 과부하로 키는 정상
          if (e?.code === 429) {
            ks.failures++
            ks.cooledUntil = Date.now() + 60_000
          }
          // 404 접근 제한은 (모델, 키) 조합의 영구 자격 문제 → 해당 조합 재시도 방지
          if (e?.code === 404 && String(e?.message || '').includes('no longer available')) {
            revokeKeyForModel(pool, model.id, ks)
          }
          throw e
        }
      } else if (model.provider === 'nvidia') {
        const pool = getPool(env, 'nvidia')
        ks = pickKey(pool)
        if (!ks) throw Object.assign(new Error('no nvidia key available'), { code: 429 })
        try {
          out = await plugin.call({ env, key: ks.key, model: model.id, messages: safeMessages, tools: fcTools, signal: context?.signal })
          ks.failures = 0
        } catch (e: any) {
          // 429만 쿨다운. 503 ResourceExhausted(Worker local)는 일시적 과부하로 키는 정상
          // → 쿨다운하지 않고 바로 재시도 (0.8초 대기 후)
          if (e?.code === 429) {
            ks.failures++
            ks.cooledUntil = Date.now() + 60_000
          }
          throw e
        }
      } else if (model.provider === 'groq') {
        const pool = getPool(env, 'groq')
        ks = pickKey(pool)
        if (!ks) throw Object.assign(new Error('no groq key available'), { code: 429 })
        try {
          out = await plugin.call({ env, key: ks.key, model: model.id, messages: safeMessages, signal: context?.signal })
          ks.failures = 0
        } catch (e: any) {
          // 429만 쿨다운. 503 ResourceExhausted(Worker local)는 일시적 과부하로 키는 정상
          // → 쿨다운하지 않고 바로 재시도 (0.8초 대기 후)
          if (e?.code === 429) {
            ks.failures++
            ks.cooledUntil = Date.now() + 60_000
          }
          throw e
        }
      } else {
        // 에코(keeper)는 Function Calling 사용 (2026-10-13 P0)
        // - Workers AI의 Traditional Function Calling
        // - 모델이 tool_calls를 반환하면 서버에서 검증 후 실행
        // - useFC/fcTools는 프로바이더 분기 전에 계산됨
        out = await plugin.call({ env, key: null, model: model.id, messages: safeMessages, tools: fcTools, signal: context?.signal })
      }

      // Function Calling 루프 (2026-10-26 정정)
      // - 도구 호출 → 실행 → tool 역할 피드백 → 재호출, 최대 MAX_FC_TURNS 라운드
      // - tool_calls가 비었으면 content 임베디드 JSON 폴백 (NVIDIA 문서 권장)
      // - preflight 검증(알 수 없는 도구·필수 인자 누락·JSON 파싱 실패)은 실행 전
      //   거르고 오류를 모델에게 돌려줘 1회 재시도하게 한다
      // - 재시도 소유권은 이 루프 한 곳으로 (모델 체인·키 풀 재시도와 중복 금지)
      const MAX_FC_TURNS = 3
      const effectiveToolCalls = (o: { toolCalls?: any[]; text?: string }): any[] => {
        if (o.toolCalls && o.toolCalls.length > 0) return o.toolCalls
        return extractEmbeddedToolCalls(o.text ?? '')
      }
      let pendingCalls: any[] = useFC ? effectiveToolCalls(out) : []
      let allToolResults: any[] = []
      let lastRoundResults: any[] = []
      // 승인 게이트 (D1 정렬): 이 시도에서 승인 대기가 된 요청·문안 누적.
      // 게이트에 걸린 호출은 실행되지 않으므로 executedWriteResults에도
      // 들어가지 않는다 (승인 대기/거부를 "실행됨"으로 캐시 금지).
      const fcApprovalRequests: any[] = []
      const fcApprovalTexts: string[] = []
      // 결정적 확인 문구용: 성공한 schedule_create의 제목은 실행 결과(data)에
      // 없어서 호출 인자에서 함께 추적한다 (메모 id는 결과 data에 있다).
      const createdScheduleTitles: string[] = []
      let turns = 0
      let fcMessages: ChatMessage[] = [...safeMessages]
      while (pendingCalls.length > 0 && turns < MAX_FC_TURNS) {
        turns++
        const normalized = pendingCalls.map((tc: any, i: number) => normalizeToolCall(tc, `call_${turns}_${i}`))
        const preflight = preflightToolCalls(normalized)
        // preflight 보정 (2026-10-30): preflightToolCalls의 validateFCArgs는
        // 메모 도구만 알아서, cron·schedule 도구가 "Unknown tool"로 전부
        // 거부되던 잠재 결함이 있었다 (디스패처는 전용 검증기로 실행 가능).
        // "Unknown tool"로 거부된 호출 중 전용 검증기(cron/schedule)를
        // 통과하는 것만 구제한다 — 그 외 거부(파싱 실패·필수 인자 누락)는 유지.
        const validSet = new Set<any>(preflight.valid)
        const rejected: typeof preflight.rejected = []
        for (const rej of preflight.rejected) {
          if (rej.error.startsWith('Unknown tool:')) {
            const name = rej.call.name
            const own = name.startsWith('cron_')
              ? validateCronFCArgs(name, rej.call.arguments)
              : name.startsWith('schedule_')
                ? validateScheduleFCArgs(name, rej.call.arguments)
                : null
            if (own && own.valid) {
              validSet.add(rej.call)
              continue
            }
          }
          rejected.push(rej)
        }
        let valid = normalized.filter((c) => validSet.has(c))
        // 출처 게이트 (Talorys ③-A + 트랙 3 D4): 판정은 공통 계층
        // (fc-tool-policy.ts)이 단일 원천이고 최종 강제는 디스패처가 한다.
        // 루프가 같은 판정(isFCWriteTool = 위험 분류 기반, 이름 목록 아님)
        // 으로 사전 거부하는 이유는 두 가지뿐이다: ① 판정이 확정된 호출에
        // 대한 디스패치 왕복을 피하고 ② 거부 결과를 rejected 채널로 모델에
        // 즉시 피드백하기 위해서다. 루프를 거치지 않는 호출자도 디스패처
        // 게이트에서 같은 결론(non_interactive_origin)을 받는다.
        if (policy.origin !== 'interactive') {
          const kept: typeof valid = []
          for (const c of valid) {
            if (isFCWriteTool(c.name)) {
              rejected.push({ call: c, error: 'non_interactive_origin' })
            } else {
              kept.push(c)
            }
          }
          valid = kept
        }
        // 승인 게이트 (D1 정렬, 2026-10-31): 대화형 출처의 쓰기·파괴적
        // 호출은 디스패치 전에 E1과 같은 승인 왕복을 거친다.
        // - 세션 허용이 있으면 그대로 통과, 없으면 대기 요청을 만들고
        //   실행하지 않은 채 approval_required 결과로 모델에 피드백한다.
        // - 비대화형 출처는 위 출처 게이트(공통 판정)가 이미 쓰기를 거부했으므로
        //   여기 도달하는 것은 읽기뿐이다 (현행 deny 동작 불변).
        const gateByCall = new Map<any, any>()
        const gatePassed: typeof valid = []
        if (policy.origin === 'interactive') {
          const convRaw = Number(context?.conversationId)
          const gateConversationId =
            Number.isInteger(convRaw) && convRaw > 0 ? convRaw : null
          for (const c of valid) {
            if (!isFCApprovalGated(c.name)) {
              gatePassed.push(c)
              continue
            }
            const outcome = await gateFCToolCall({
              db: env.DB,
              personaId: policy.personaId || 'keeper',
              conversationId: gateConversationId,
              toolName: c.name,
              args: c.arguments,
              userRequest: policy.skillText ?? lastUserText,
              sourceUserText: lastUserText,
              origin: policy.origin,
              cryptoEnv: env,
            } as any)
            if (outcome.action === 'allow') {
              gatePassed.push(c)
              continue
            }
            if (outcome.action === 'deny') {
              gateByCall.set(c, { success: false, toolName: c.name, error: outcome.error })
              continue
            }
            const reqSummary = outcome.action === 'ask' ? outcome.request : undefined
            const aText =
              outcome.action === 'ask'
                ? outcome.approvalText
                : '(이 작업은 승인이 필요해 실행하지 않았습니다. 채팅에서 다시 요청해 주세요)'
            if (reqSummary && !fcApprovalRequests.some((r) => r.id === reqSummary.id)) {
              fcApprovalRequests.push(reqSummary)
            }
            if (!fcApprovalTexts.includes(aText)) fcApprovalTexts.push(aText)
            gateByCall.set(c, {
              success: false,
              toolName: c.name,
              error: 'approval_required',
              data: {
                status: 'approval_required',
                approvalRequestId: reqSummary?.id ?? null,
                message: aText,
              },
            })
          }
        } else {
          gatePassed.push(...valid)
        }
        // 쓰기 멱등성: 이 턴에서 이미 성공한 동일 생성 호출은 재실행하지
        // 않고 저장된 결과를 그대로 피드백한다 (모델이 다음 라운드에서
        // 같은 호출을 반복하거나, 폴백 시도가 처음부터 다시 실행해도
        // 실제 쓰기는 한 번만 일어난다).
        const cachedByCall = new Map<any, any>()
        const toDispatch: typeof valid = []
        for (const c of gatePassed) {
          const sig = fcWriteSignature(c.name, c.arguments)
          const cached = sig ? executedWriteResults.get(sig) : undefined
          if (cached) {
            cachedByCall.set(c, cached)
          } else {
            toDispatch.push(c)
          }
        }
        const dispatchedFresh = toDispatch.length > 0
          ? await dispatchToolCalls(env, toDispatch.map((c) => ({ name: c.name, arguments: c.arguments })), {
              // 61차: 원문 참조형 도구를 위해 원본 메시지 전달
              // safeMessages는 정규화된 버전이므로, 원본 messages를 전달
              originalMessages: messages,
              // 65차: 문맥 저장을 위한 사용자·대화 ID
              userId: context?.userId || 'default',
              conversationId: context?.conversationId || 'default',
              // 트랙 3 (D4·D5): 실행 비서·출처를 디스패처 공통 게이트에
              // 전달한다 — 강제는 디스패처가 하며, 위 사전 거부는 같은
              // 판정 함수의 선행 적용일 뿐이다.
              personaId: policy.personaId || 'keeper',
              origin: policy.origin,
              // 실행 원장 귀속 (K-03): 디스패처 래퍼가 이 런으로 기록한다.
              runId: ledgerRunId,
              requestId: ledgerRequestId,
              provider: model.provider,
              model: model.id,
            })
          : []
        const freshByCall = new Map<any, any>()
        toDispatch.forEach((c, i) => {
          const r = dispatchedFresh[i]
          if (!r) return
          freshByCall.set(c, r)
          const sig = fcWriteSignature(c.name, c.arguments)
          if (sig && r.success) executedWriteResults.set(sig, r)
        })
        // 호출 순서대로 결과 정렬 (거부된 호출은 오류 결과로 피드백)
        const roundResults: any[] = []
        for (const call of normalized) {
          const rej = rejected.find((r) => r.call === call)
          if (rej) {
            roundResults.push({ success: false, toolName: call.name, error: rej.error })
          } else if (gateByCall.has(call)) {
            roundResults.push(gateByCall.get(call))
          } else if (cachedByCall.has(call)) {
            roundResults.push(cachedByCall.get(call))
          } else {
            roundResults.push(freshByCall.get(call) ?? { success: false, toolName: call.name, error: 'No result' })
          }
        }
        lastRoundResults = roundResults
        allToolResults = [...allToolResults, ...roundResults]
        normalized.forEach((call, i) => {
          if (call.name === 'schedule_create' && isLedgerVerifiedSuccess(roundResults[i])) {
            const title = String(call.arguments?.title || '').trim()
            if (title && !createdScheduleTitles.includes(title)) createdScheduleTitles.push(title)
          }
        })

        // 2026-10-15: 에코 문제 진단용 로그 (GPT 권고)
        // requestId, 도구 실행 결과, ui_pending 여부를 추적
        try {
          const toolSummaries = (roundResults as any[]).map((item: unknown) => {
            if (typeof item !== 'object' || item === null) return { valid: false };
            const r = item as Record<string, unknown>;
            return {
              valid: true,
              tool: typeof r.toolName === 'string' ? r.toolName : (typeof (r as any).name === 'string' ? (r as any).name : 'unknown'),
              status: typeof r.status === 'string' ? r.status : 'unknown',
              hasContent: r.content !== null && r.content !== undefined,
              contentLength: typeof r.content === 'string' ? r.content.length : undefined,
              success: (r as any).success,
            };
          });
          console.info('[echo.tool_execution]', JSON.stringify({
            personaId: policy.personaId,
            provider: model.provider,
            modelId: model.id,
            useFC,
            turn: turns,
            resultCount: (roundResults as any[]).length,
            tools: toolSummaries,
          }));
        } catch (e) { /* 로그 실패 무시 */ }

        // tool 피드백 메시지 (OpenAI 형식): assistant tool_calls + tool 결과
        fcMessages.push({
          role: 'assistant',
          content: '',
          tool_calls: normalized.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
          })),
        })
        normalized.forEach((c, i) => {
          fcMessages.push({
            role: 'tool',
            tool_call_id: c.id,
            content: JSON.stringify(roundResults[i] ?? { success: false, error: 'No result' }),
          })
        })

        // 도구 실행 결과를 포함한 후속 호출 (최종 응답 규칙은 매 호출에 전달)
        // tool 뒤 user 메시지는 mistral(vLLM)이 8007로 거부하므로 공용
        // 조립기(buildFCFollowUpMessages)를 쓴다 — 2026-10-30 중복 생성의
        // 근본 원인 (후속 호출 실패 → 폴백 시도가 쓰기를 재실행).
        const followUpMessagesRaw: ChatMessage[] = buildFCFollowUpMessages(fcMessages, FC_FINAL_RULES)
        // Privacy Gateway — 도구 결과 재전송 검사: tool 메시지 내용을
        // 검사해 차단 사유가 있으면 후속 호출 자체를 중단하고, 통과한
        // 내용은 이 턴 vault로 토큰화해 보낸다.
        for (const m of followUpMessagesRaw) {
          if (m.role === 'tool') {
            const chk = inspectToolResult(m.content)
            if (chk.action === 'block') {
              console.warn('privacy_gateway_blocked', { origin: 'aiChat:fc-followup', reasons: chk.reasons.join(',') })
              throw new PrivacyGatewayBlockedError(chk.reasons)
            }
          }
        }
        const followUpMessages: ChatMessage[] = followUpMessagesRaw.map(
          (m) => m.role === 'tool' ? { ...m, content: privacyVault.sanitize(m.content).text } : m
        )
        // NVIDIA 메모 가드 — FC 후속 호출 직전 (이중 방어): 메모 유래
        // 내용이 실린 followUpMessages는 NVIDIA로 재전송하지 않는다.
        // 가드 오류는 retryable=false라 폴백 체인이 즉시 중단한다.
        // 주의: 여기서 assertNoMemoContentForNvidia(역할 기반)를 쓰면
        // cron·schedule 같은 비메모 도구의 결과(tool 역할)까지 전부 막혀
        // FC 루프가 NVIDIA에서 완주할 수 없다. 후속 호출에서는 메모 유래
        // 내용만 검사하는 assertNoMemoDerivedContentForNvidia를 쓴다 —
        // 부착되지 않은 메모 도구를 모델이 지어내 실행한 경우는 도구 결과
        // JSON의 toolName 패턴으로 그대로 잡힌다.
        if (model.provider === 'nvidia') {
          try {
            assertNoMemoDerivedContentForNvidia(followUpMessages)
          } catch (e) {
            if (e instanceof NvidiaMemoGuardError) {
              console.warn('nvidia_guard_blocked', { stage: 'fc-followup', persona: policy.personaId, reason: (e as any).reason })
            }
            throw e
          }
        }
        let followUp: typeof out
        try {
          followUp = await plugin.call({ env, key: ks ? ks.key : null, model: model.id, messages: followUpMessages, signal: context?.signal })
        } catch (followErr) {
          // 쓰기가 이미 성공한 뒤의 후속(서술) 호출 실패를 시도 전체 실패로
          // 올리면, 모델 폴백이 처음부터 다시 실행돼 쓰기가 중복된다
          // (2026-10-30 라이브 실측: mistral 후속 8007 → qwen 폴백이
          // memo_create 재실행 → 메모 2건). 쓰기 성공이 있으면 폴백으로
          // 넘기지 않고 결정적 확인 문구로 마감한다. 쓰기 성공이 없을
          // 때만 기존대로 던져 폴백 체인이 동작하게 한다.
          const writeAlreadyDone = allToolResults.some(
            (r: any) => r?.success && FC_WRITE_TOOL_NAMES.includes(r.toolName)
          )
          if (!writeAlreadyDone) throw followErr
          console.info('[fc.followup_failed_after_write]', JSON.stringify({
            personaId: policy.personaId,
            provider: model.provider,
            modelId: model.id,
            error: redactStringForLog(String((followErr as any)?.message || followErr), 200),
          }))
          if (!out.text || !out.text.trim()) out.text = '요청한 작업을 처리했습니다.'
          break
        }
        out.text = followUp.text
        const addUsage = (a?: number, b?: number): number | undefined =>
          a == null && b == null ? undefined : (a ?? 0) + (b ?? 0)
        out.inputTokens = addUsage(out.inputTokens, followUp.inputTokens)
        out.outputTokens = addUsage(out.outputTokens, followUp.outputTokens)
        out.neurons = addUsage(out.neurons, followUp.neurons)
        pendingCalls = useFC ? effectiveToolCalls(followUp) : []
      }
      if (allToolResults.length > 0) {
        // 2026-10-15: 에코 문제 진단용 로그 (GPT 권고) - 최종 응답
        try {
          console.info('[echo.response]', JSON.stringify({
            personaId: policy.personaId,
            provider: model.provider,
            modelResponseLength: out.text?.length ?? 0,
            finalResponseLength: out.text?.length ?? 0,
            toolResultCount: (allToolResults as any[]).length,
            turns,
          }));
        } catch (e) { /* 로그 실패 무시 */ }
        // 마지막 라운드에서 메모 생성 도구가 실패했으면 사용자에게 알림
        // (모델이 오류 피드백을 받고도 고치지 못한 경우 — 마커 원본 노출 금지)
        // 승인 대기(approval_required)는 실패가 아니므로 제외한다 (D1 정렬).
        const memoCreateFailed = lastRoundResults.some(
          (r: any) => !r.success && r.error !== 'approval_required' && (r.toolName === 'memo_create' || r.toolName === 'memo_create_from_source')
        )
        if (memoCreateFailed && !out.text.includes('메모 생성')) {
          out.text = `${out.text}\n\n메모 생성에 실패했습니다.`
        }
        // 결정적 확인 문구 (2026-10-30, promptfoo 라이브 게이트 회귀 3):
        // 마커 경로는 서버가 "메모를 생성했어 (id: N)." / "일정 등록했어:
        // <제목>"으로 치환하지만, FC 경로는 후속 호출에서 모델이 결과를
        // 바꿔 말해 문구가 사라졌다 (라이브 실측: 메모는 생성됐으나 응답은
        // "메모가 성공적으로 생성되었습니다"로만 나옴). 쓰기가 성공한 경우
        // 서버가 같은 문구를 응답 앞에 확정적으로 붙인다.
        // - 메모: 결과 data의 숫자 id가 있을 때만 (id 없는 결과는 확정 불가)
        // - 일정: 성공한 schedule_create 호출 인자의 제목으로
        // - 이미 문구가 있으면 중복해서 붙이지 않는다.
        const memoCreated = findLedgerVerifiedSuccess(allToolResults, ['memo_create', 'memo_create_from_source'])
        const memoCreatedWithId = memoCreated && Number.isInteger(memoCreated.data?.id ?? memoCreated.data?.memoId) ? memoCreated : null
        if (memoCreatedWithId && !out.text.includes('메모를 생성했습니다')) {
          out.text = `메모를 생성했습니다.\n${out.text}`
        }
        // 미검증 성공 주장 교정 (response-postprocess): 원장에 기록되지
        // 않은 성공 주장은 그대로 내보내지 않는다. 모듈 로드 실패 시에는
        // 교정 없이 진행한다 (fail-soft).
        try {
          const { guardUnverifiedSuccessClaims } = await import('../modules/ai/response-postprocess')
          out.text = guardUnverifiedSuccessClaims(out.text, allToolResults).text
        } catch { /* 교정 모듈 미가용 시 원문 유지 */ }
        if (createdScheduleTitles.length > 0 && !out.text.includes('일정을 등록했습니다:')) {
          out.text = `일정을 등록했습니다: ${createdScheduleTitles[0]}\n${out.text}`
        }
        const unverifiedWrite = hasUnverifiedSuccess(allToolResults, ['memo_create', 'memo_create_from_source']) || hasUnverifiedSuccess(allToolResults, ['schedule_create'])
        if (unverifiedWrite && !out.text.includes('실행 기록을 확인하지 못해')) {
          out.text = `${out.text}\n(실행 기록을 확인하지 못해 성공으로 단정할 수 없습니다. 목록에서 직접 확인해 주세요.)`
        }
        await finishLedgerRun(db, ledgerRunId, {
          status: 'completed',
          requestedToolCalls: allToolResults.length,
          executedToolCalls: allToolResults.filter((r: any) => r?.ledgerRecorded).length,
          elapsedMs: Date.now() - t0,
        })
        // 도구 실행 결과를 메타데이터에 포함
        ;(out as any).toolResults = allToolResults
        // 위젯 새로고침용: 쓰기 도구가 성공하면 dataChanged 설정
        // 70차: memo_delete는 확인 단계이므로 제외 (실제 삭제 시에만 갱신)
        const writeTools = ['memo_create', 'memo_create_from_source', 'schedule_create']
        const hasWriteSuccess = allToolResults.some((r: any) => r.success && writeTools.includes(r.toolName))
        if (hasWriteSuccess) {
          ;(out as any).dataChanged = true
        }
        // UI 액션 수집 (메모 열기/닫기 등)
        const uiActions = allToolResults
          .filter((r: any) => r.success && r.data && r.data.uiAction)
          .map((r: any) => ({
            uiAction: r.data.uiAction,
            memoId: r.data.memoId,
          }))
        if (uiActions.length > 0) {
          ;(out as any).uiActions = uiActions
        }
        // 승인 대기 안내 (D1 정렬): 모델이 승인 문안을 바꿔 말해도
        // E1과 같은 승인 요청 문안이 최종 응답에 반드시 실리게 한다.
        // approvalRequests는 프론트 카드용으로 메타데이터에도 싣는다.
        if (fcApprovalRequests.length > 0) {
          ;(out as any).approvalRequests = fcApprovalRequests
        }
        for (const aText of fcApprovalTexts) {
          if (!out.text.includes(aText)) {
            out.text = out.text ? `${out.text}\n\n${aText}` : aText
          }
        }
      }

      const rec: UsageRecord = {
        provider: model.provider,
        model: model.id,
        capability: policy.capability,
        latencyMs: Date.now() - t0,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        neurons: out.neurons,
        outcome: 'success',
        at: Date.now(),
        engine: attemptEngine,
        persona: policy.personaId ?? undefined,
        runId: ledgerRunId,
        callIndex: attempt,
        traceId: context?.trace?.traceId,
        spanId: context?.trace?.spanId,
        parentSpanId: context?.trace?.parentSpanId ?? null,
        promptVersion: context?.promptVersion,
      }
      // D1 기록 실패가 모델 성공을 망치지 않도록 분리
      try { await logUsage(db, rec) } catch { /* 무시 */ }
      const result: any = { text: privacyVault.desanitize(out.text), provider: model.provider, model: model.id, latencyMs: Date.now() - t0, inputTokens: out.inputTokens, outputTokens: out.outputTokens, neurons: out.neurons }
      if (out.sources) result.sources = out.sources
      if ((out as any).pipeline) result.pipeline = (out as any).pipeline
      if (fallbackChain.length > 0) result.fallbacks = fallbackChain
      // FC 메타데이터 전달 (keeper FC 경로에서 설정된 toolResults/dataChanged/uiActions)
      if ((out as any).toolResults) result.toolResults = (out as any).toolResults
      if ((out as any).dataChanged) result.dataChanged = (out as any).dataChanged
      if ((out as any).uiActions) result.uiActions = (out as any).uiActions
      // 승인 대기 요청 전달 (D1 정렬 — E1 마커 경로와 같은 응답 필드)
      if ((out as any).approvalRequests) result.approvalRequests = (out as any).approvalRequests
      return result
    } catch (e: any) {
      lastError = e
      // Provider 실제 호출 시도 기록 (오류 분류용)
      providerCallAttempted = true
      lastProviderError = e
      fallbackChain.push(`${model.id}: ${redactStringForLog(String(e?.message || e), 100)}`)
      // 디버그 로그: 실제 에러 기록 (키 값은 절대 포함하지 않음)
      // Groq 400의 구조화된 오류 정보도 저장 (errorType, errorCode)
      try {
        const rawErrMsg = String(e?.message || e)
        const errMsg = redactStringForLog(rawErrMsg, 500)
        const httpStatus = e?.code || parseInt(rawErrMsg.match(/(\d{3})/)?.[1] || '0')
        const errDetail = e?.errorType ? ` [${e.errorType}${e.errorCode ? ':' + e.errorCode : ''}]` : ''
        await db.prepare(
          'INSERT INTO ai_error_log (provider, model, capability, error, http_status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(model.provider, model.id, policy.capability, redactStringForLog(errMsg + errDetail, 500), httpStatus, new Date().toISOString()).run()
      } catch { /* 로그 실패 무시 */ }
      const rec: UsageRecord = {
        provider: model.provider,
        model: model.id,
        capability: policy.capability,
        latencyMs: Date.now() - t0,
        outcome: e?.code === 429 ? 'rate_limited' : 'failed',
        at: Date.now(),
        engine: attemptEngine,
        persona: policy.personaId ?? undefined,
        runId: ledgerRunId,
        callIndex: attempt,
        traceId: context?.trace?.traceId,
        spanId: context?.trace?.spanId,
        parentSpanId: context?.trace?.parentSpanId ?? null,
        promptVersion: context?.promptVersion,
      }
      try { await logUsage(db, rec) } catch { /* 무시 */ }
      // 400 Bad Request는 재시도 불가능한 요청 오류 → 즉시 실패
      // (같은 잘못된 요청을 다른 모델에 반복 전송하지 않음)
      // 89차: 4006 (일일 뉴런 할당량 소진)은 계정 단위이므로 다른 모델로 폴백해도 무의미 → 즉시 중단
      const errMsgForCheck = String(e?.message || e || '')
      const isQuotaExhausted = errMsgForCheck.includes('4006') ||
        errMsgForCheck.includes('3036') ||
        errMsgForCheck.includes('daily free allocation') ||
        errMsgForCheck.includes('used up your daily')
      if (isQuotaExhausted) {
        // Workers AI 뉴런 소진 degraded 폴백 (2026-10-30): 핀이 workers-ai인
        // 요청(에코)에 한해, 핀을 풀고 Gemini lite로 1회만 재시도한다.
        // - Gemini에서는 useFC가 켜지지 않으므로 FC 없는 degraded 모드다
        //   (메모 도구 없는 일반 답변 + 스킬 마커 경로로만 동작).
        // - useSearch를 끄는 이유: 켜두면 selectModel 랭킹이 grounding 전용
        //   gemini-2.5-flash(+50)를 먼저 잡는다. 끄면 체인 1순위인
        //   gemini-3.5-flash-lite가 결정적으로 선택된다.
        // - 이미 degraded였거나 workers-ai 핀이 아니면 기존대로 즉시 중단
        //   (무한 재시도 금지 — 전환은 이 턴에서 정확히 1회만 일어난다).
        if (!workersAiQuotaDegraded && activePolicy.providerPin === 'workers-ai' && policy.privacy !== 'private') {
          workersAiQuotaDegraded = true
          activePolicy = { ...activePolicy, providerPin: 'gemini', useSearch: false }
          attemptBudget = attempt + 2 // 실패한 이번 시도 + degraded 재시도 1회
          console.info('workers_ai_quota_degraded', {
            persona: policy.personaId,
            capability: policy.capability,
            fromProvider: 'workers-ai',
            toProvider: 'gemini',
            toModel: 'gemini-3.5-flash-lite',
            fc: false,
            reason: 'workers_ai_quota_exhausted',
          })
          continue
        }
        // 할당량 소진 플래그를 에러에 표시 (상위에서 사용자 안내용)
        ;(e as any).quotaExhausted = true
        throw e
      }
      if (e?.retryable === false || e?.code === 400) {
        throw e
      }
      const backoffMs = capacityBackoffDelayMs(e, {
        attempt,
        attemptBudget,
        remainingMs: remainingMs(deadline),
      })
      if (backoffMs > 0) {
        await new Promise((r) => setTimeout(r, backoffMs))
      }
      // 어떤 실패든 다음 모델로 fallback (429는 쿨다운 추가)
      continue
    }
  }

  throw lastError ?? new Error('ai failed')
}

// 테스트용 export
export const __test = { selectModel, pickKey, pickKeyForModel, getPool };

// ---------------------------------------------------------------------------
// 프로바이더 플러그인 등록 (OpenClaw 패턴 — 모델은 갈아끼우는 플러그인)
// - 플러그인 인터페이스/레지스트리: src/services/provider-registry.ts
// - 각 플러그인의 call은 기존 호출 함수(callGemini/callGroq/callNVIDIA/
//   callWorkersAI)를 그대로 감싼다 — 호출 동작 변경 없음
// - 기본 핀(루미=gemini, 에코=workers-ai, 노바=gemini, 캘리=groq)은
//   레지스트리의 PERSONA_PROVIDER_PIN과 동일 (selectModel/providerPin 경로 유지)
// ---------------------------------------------------------------------------
registerProvider({
  id: 'gemini',
  displayName: 'Google Gemini',
  listModels: () => MODELS.filter((m) => m.provider === 'gemini'),
  call: (input) =>
    callGemini(input.env, input.key ?? '', input.model, input.messages, input.useSearch ?? false, input.sensitivity, input.signal, input.privacyLevel),
})
registerProvider({
  id: 'groq',
  displayName: 'Groq',
  listModels: () => MODELS.filter((m) => m.provider === 'groq'),
  call: (input) => callGroq(input.key ?? '', input.model, input.messages, input.signal),
})
registerProvider({
  id: 'nvidia',
  displayName: 'NVIDIA',
  listModels: () => MODELS.filter((m) => m.provider === 'nvidia'),
  call: (input) => callNVIDIA(input.key ?? '', input.model, input.messages, input.tools, input.signal),
})
registerProvider({
  id: 'workers-ai',
  displayName: 'Cloudflare Workers AI',
  listModels: () => MODELS.filter((m) => m.provider === 'workers-ai'),
  call: (input) => callWorkersAI(input.env, input.model, input.messages, input.tools, input.signal),
})

export { PERSONAS, buildPeerContext, buildSystemPrompt } from './ai-personas'
export type { Persona } from './ai-personas'
