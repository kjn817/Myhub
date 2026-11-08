// AI 비서 모듈: 채팅 API
// POST /api/ai/chat — { personaId, messages } → 비서 응답
// GET  /api/ai/personas — 비서 목록
// GET  /api/ai/usage — 일일 사용량 요약
// (routes.ts 분리, 2026-10-29 — 동작 변경 없는 순수 구조 분리로 이동된 코드)
import { Hono } from 'hono'
import type { Env } from '../../types'
import { aiChat, PERSONAS, MODELS, getSetting, setSetting, buildSystemPrompt, type TaskPolicy, type ProviderId } from '../../services/ai'
import {
  resolveRequestSensitivity,
  PrivacyBlockedError,
  getLegacyMarkerTools,
} from '../../ai/legacy-privacy-guard'
import { orchestrate } from '../../services/orchestrator'
import { PrivacyGatewayBlockedError, privacyGatewayUserNotice } from '../../services/privacy-gateway'
import { isQuotaError } from '../../services/clef-engine'
import type { PersonaId } from '../../services/router'
import { planTeam, runTeam, type TeamResult } from '../../services/agent-team'
import { shouldUseFunctionCalling, chatWithFunctionCalling } from '../../ai/function-calling-route'
import {
  ToolApprovalRequestStore,
  buildApprovalRequestText,
  describeMaskedToolAction,
  executeApprovedRequestOnce,
  isPossibleApprovalReply,
  resolveApprovalReply,
  APPROVAL_TIMEOUT_MS,
  type ApprovalRequestSummary,
} from '../../services/approval-flow'
import {
  buildDryRunPreview,
  formatDryRunPreview,
  SandboxAuditStore,
} from '../../services/sandbox'
import {
  isFCPayload,
  executeFCApprovalPayload,
} from '../../services/fc-approval-gate'
import { isValidLegacyPersonaId, normalizeLegacyPersonaId } from '../../services/persona-id-adapter'
import { feedbackApp } from './feedback'
import { officeAiApp } from './office-routes'
import { callSingleAssistant } from './assistant-call'
import { processToolMarkers } from './tool-markers'
import { saveChatHistory } from './chat-history'
import { AssistantInputError, type RawChatMessage, type AssistantCallResult } from './assistant-types'
import { aiAdminApp } from './admin-routes'

// 분리된 구현의 공개 표면은 분리 전과 동일하게 이 모듈에서 재노출한다
export { callSingleAssistant } from './assistant-call'
export { processToolMarkers } from './tool-markers'
export { AssistantInputError } from './assistant-types'
export type { RawChatMessage, AssistantCallResult } from './assistant-types'

export const aiApp = new Hono<{ Bindings: Env }>()

// Phase 3C: 피드백 API 연결
aiApp.route('/feedback', feedbackApp)
aiApp.route('/office', officeAiApp)

aiApp.get('/personas', (c) => {
  return c.json(PERSONAS.map((p) => ({ id: p.id, name: p.name, desc: p.desc, avatar: p.avatar })))
})

aiApp.post('/chat', async (c) => {
  type ChatBody = { personaId?: string; conversationId?: number | string; messages?: RawChatMessage[] }
  const body: ChatBody = await c.req.json<ChatBody>().catch((): ChatBody => ({}))
  // 신규 ID(echo 등)도 레거시 ID로 정규화 (assistant-call과 이중 방어 —
  // FC 파일럿 판정·긴급 차단 목록·대화 기록 저장이 모두 레거시 ID 기준).
  // 알 수 없는 ID는 원본 그대로 두어 callSingleAssistant가 거부하게 한다.
  const rawPersonaId = body.personaId || 'concierge'
  const personaId = isValidLegacyPersonaId(rawPersonaId)
    ? rawPersonaId
    : normalizeLegacyPersonaId(rawPersonaId) || rawPersonaId
  let conversationId = body.conversationId
  // 81차: 서버 자동 추측 폐기 (GPT 80차 자문)
  // conversationId가 없으면 새로 발급. 위젯이 메모리에 보관하여 다음 요청에 전달.
  // "최근 2시간 내 활동 대화 자동 검색"은 비결정적이므로 제거.
  if (!conversationId || conversationId === 'auto') {
    const now2 = new Date().toISOString()
    const convResult = await c.env.DB.prepare(
      'INSERT INTO ai_conversations (title, created_at, updated_at) VALUES (?, ?, ?)'
    ).bind('새 대화', now2, now2).run()
    conversationId = convResult?.meta?.last_row_id as number
    if (!conversationId) {
      throw new Error('CONVERSATION_CREATE_FAILED')
    }
  } else {
    // 명시된 ID가 존재하는지 확인 (임의 생성 금지)
    const exists = await c.env.DB.prepare('SELECT 1 FROM ai_conversations WHERE id = ?').bind(conversationId).first()
    if (!exists) {
      return c.json({ ok: false, error: 'CONVERSATION_NOT_FOUND' }, 404)
    }
  }

  // 78차: "방금 만든" 같은 상대 참조를 명시적 ID로 변환 (서버 선처리)
  // 모델이 이해하지 못해도 서버가 확실히 처리
  try {
    const msgs = body.messages || []
    if (msgs.length > 0) {
      const lastMsg = msgs[msgs.length - 1]
      const content = String(lastMsg.content || '')
      if (content.includes('방금 만든') || content.includes('방금 생성')) {
        // 최근 메모 ID 조회
        const recent = await c.env.DB.prepare(
          `SELECT id FROM memos WHERE is_locked = 0 ORDER BY id DESC LIMIT 1`
        ).first() as any
        if (recent?.id) {
          // 메시지에 ID 명시 (모델이 확실히 이해하도록)
          lastMsg.content = content + ` (메모 ID: ${recent.id})`
        }
      }
    }
  } catch { /* 선처리 실패는 무시 */ }

  // 승인 응답 가로채기 (b트랙): 대기 중인 승인 요청에 사용자가 "승인해" /
  // "거부해" / "이 세션 허용해"로 답하면 모델 호출 없이 처리한다.
  // pending이 없거나 승인 응답이 아니면 일반 채팅으로 진행한다.
  // (FC 분기보다 먼저 — 승인 답에 모델 호출이 필요 없기 때문)
  // 순수 파싱을 먼저 해서 승인 응답이 아닐 때는 DB를 조회하지 않는다
  // (일반 채팅마다 승인 조회 쿼리가 나가는 것을 방지).
  try {
    const _msgs = body.messages || []
    const _lastUser = [..._msgs]
      .reverse()
      .find((m) => m && m.role !== 'assistant' && typeof m.content === 'string' && m.content.trim())
    const _lastText = _lastUser ? String(_lastUser.content) : ''
    const _lastUserIdx = _lastUser ? _msgs.lastIndexOf(_lastUser) : -1
    const _messagesBeforeReply = _lastUserIdx >= 0
      ? _msgs.slice(0, _lastUserIdx).map((m) => ({
          role: String((m && m.role) || ''),
          content: m && typeof m.content === 'string' ? m.content : '',
        }))
      : undefined
    if (_lastText && isPossibleApprovalReply(_lastText)) {
      const { normalizeLegacyPersonaId } = await import('../../services/persona-id-adapter')
      const _legacyPersonaId = normalizeLegacyPersonaId(personaId) || personaId
      const _resolution = await resolveApprovalReply(c.env.DB, {
        conversationId: Number(conversationId),
        personaId: _legacyPersonaId,
        reply: _lastText,
        messagesBeforeReply: _messagesBeforeReply,
        cryptoEnv: c.env,
      })
      if (_resolution.status !== 'none' && _resolution.request) {
        const _req = _resolution.request
        // i트랙 감사 로그 — 무엇을·언제·누가 승인했는지 남긴다.
        // 감사 기록 실패가 승인 실행 자체를 막지는 않는다.
        const _audit = async (action: 'executed' | 'denied' | 'expired' | 'blocked'): Promise<void> => {
          try {
            await new SandboxAuditStore(c.env.DB).recordAudit({
              personaId: _req.personaId,
              conversationId: Number(conversationId),
              tool: _req.tool,
              scopeKey: _req.scopeKey,
              action,
              detail: _req.summary,
            })
          } catch {
            // 감사 실패는 무시 (요청 행의 상태가 1차 감사)
          }
        }
        let _replyText: string
        if (_resolution.status === 'approved' || _resolution.status === 'approved_session') {
          // 0063 (Talorys ②-0): 저장된 마커를 재실행하기 직전에 executed_at을
          // 원자적으로 선점한다. 승인 응답이 동시/중복으로 도달해도
          // (resolveRequest의 pending→approved 전이는 이미 원자적이지만,
          // 그 전이를 두 호출이 함께 통과하는 경합이 있다) 실행은 최대 1회다.
          // 실패해도 선점은 되돌리지 않는다 — 부작용이 났을 수 있는 실패의
          // 자동 재시도를 막기 위함 (executeApprovedRequestOnce 참조).
          const _outcome = await executeApprovedRequestOnce(c.env.DB, _req, async () => {
            // E2(FC) 페이로드면 마커 재실행이 아니라 FC 디스패처로 실행한다
            // (D1 정렬, 2026-10-31). 판정은 markerText의 FC: 접두사로만
            // 하며, 그 외(E1 마커) 페이로드는 기존 경로 그대로다.
            if (isFCPayload(_req.markerText)) {
              return executeFCApprovalPayload(c.env, _req, { userId: 'default' })
            }
            const _exec = await processToolMarkers(
              c.env,
              { text: _req.markerText },
              personaId,
              {
                conversationId: Number(conversationId),
                userRequest: _lastText,
                approvedScopeKeys: new Set([_req.scopeKey]),
                // 사용자의 채팅 승인 답으로 재실행되는 대화형 실행 (③-A)
                origin: 'interactive',
              },
            )
            return String(_exec.text || '')
          }, undefined, c.env)
          if (!_outcome.claimed) {
            // 이미 실행됨 — 재실행하지 않고 저장된 결과 요약을 안내한다
            _replyText = `이미 실행된 승인 건입니다. 다시 실행하지 않았습니다. (${_req.summary})`
            if (_outcome.executionResult) {
              _replyText += `\n이전 실행 결과: ${_outcome.executionResult}`
            }
            await _audit('blocked')
          } else if (_outcome.error) {
            _replyText = `실행 중 오류가 났습니다. 이미 실행됐을 수 있어 자동으로 다시 시도하지 않습니다. 다시 필요하면 새로 요청해 주세요. (${_req.summary})\n오류: ${_outcome.error}`
            await _audit('blocked')
          } else {
            const _resultText = String(_outcome.resultText || '')
            _replyText = `승인한 요청을 실행했습니다 (${_req.summary})${_resultText ? `\n${_resultText}` : ''}`
            await _audit('executed')
            if (_resolution.status === 'approved_session') {
              _replyText = `이 세션 동안 같은 종류의 작업은 다시 묻지 않겠습니다.\n${_replyText}`
            }
          }
        } else if (_resolution.status === 'denied') {
          _replyText = `알겠습니다. 실행하지 않았습니다. (${_req.summary})`
          await _audit('denied')
        } else {
          // expired
          _replyText = `승인 요청이 만료됐습니다 (10분 경과). 다시 요청해 주시면 새로 확인하겠습니다. (${_req.summary})`
          await _audit('expired')
        }
        const _msgIds = await saveChatHistory(c.env, Number(conversationId), _lastText, [
          { personaId, text: _replyText, model: 'approval' },
        ])
        return c.json({
          ok: true,
          personaId,
          conversationId: Number(conversationId),
          text: _replyText,
          provider: 'approval',
          model: 'approval',
          approvalResolved: _resolution.status,
          messageId: _msgIds[0] || null,
        })
      }
    }
  } catch (e: any) {
    // 가로채기 실패는 일반 채팅으로 진행 (승인 응답이 씹히지 않도록)
    console.warn('approval reply handling failed, continuing to chat:', e?.message)
  }

  // Phase 1G-C: Function Calling 파일럿 (feature flag)
  // 기본값은 legacy, ai.engine=function_calling일 때만 새 엔진
  try {
    const useFC = await shouldUseFunctionCalling(c.env.DB, personaId, c.env)
    if (useFC) {
      const fcResult = await chatWithFunctionCalling(c, personaId, body.messages || [])
      if (fcResult.ok) {
        // 대화 기록 저장 (Phase 3C: messageId 반환, Phase 3D: promptVersion)
        const messageIds = await saveChatHistory(c.env, Number(conversationId), '', [
          { personaId, text: fcResult.text || '', model: fcResult.model || 'function_calling', promptVersion: fcResult.promptVersion },
        ])
        return c.json({
          ok: true,
          personaId,
          conversationId: Number(conversationId),
          text: fcResult.text,
          provider: fcResult.provider || 'function_calling',
          model: fcResult.model || 'function_calling',
          engine: 'function_calling',
          messageId: messageIds[0] || null,
          promptVersion: fcResult.promptVersion || 'legacy',
        })
      }
      // FC 실패 시 legacy로 폴백하지 않음 (이중 실행 방지)
      // 명확한 오류 반환
      return c.json({ ok: false, error: fcResult.error || 'AI 처리 실패' }, 502)
    }
  } catch (e: any) {
    // feature flag 확인 실패 시 legacy로 진행
    console.warn('Function calling check failed, using legacy:', e?.message)
  }

  let result: AssistantCallResult
  try {
    // 긴급 차단 스위치: ai.emergency_disable = 'keeper,scheduler' 또는 'all'
    // D1 ai_settings에서 확인, 개인정보 보호 복구용
    try {
      const disableRow = await c.env.DB.prepare(
        "SELECT value FROM ai_settings WHERE key = 'ai.emergency_disable'"
      ).first() as { value?: string } | null
      const disabled = (disableRow?.value || '').split(',').map((s) => s.trim())
      if (disabled.includes('all') || disabled.includes(personaId)) {
        return c.json({
          ok: true,
          response: '현재 이 비서의 AI 기능이 일시적으로 비활성화되어 있습니다. 잠시 후 다시 시도해주세요.',
          provider: 'disabled',
          model: 'disabled',
          disabled: true,
        })
      }
    } catch {
      // 설정 조회 실패 시 정상 진행 (fail-open이 아닌 fail-safe: 차단은 명시적 설정만)
    }
    result = await callSingleAssistant(c.env, personaId, body.messages || [], {
      conversationId: conversationId,
      origin: 'interactive',
    })
  } catch (e: any) {
    if (e instanceof AssistantInputError) {
      if (e.code === 'unknown_persona') return c.json({ ok: false, error: 'unknown persona' }, 400)
      if (e.code === 'empty') return c.json({ ok: false, error: 'empty' }, 400)
      return c.json({ ok: false, error: 'too long' }, 400)
    }
    // Phase 3D-P: 개인정보 보호 차단 → 명확한 안내 (조용한 우회 금지)
    if (e instanceof PrivacyBlockedError || e?.name === 'PrivacyBlockedError') {
      return c.json({
        ok: false,
        error: '개인정보 보호 정책에 따라 이 요청을 처리할 수 없습니다. 민감한 정보가 포함된 요청은 허용된 AI 모델에서만 처리됩니다.',
        privacyBlocked: true,
      }, 403)
    }
    if (e instanceof PrivacyGatewayBlockedError || e?.name === 'PrivacyGatewayBlockedError' || e?.code === 'PRIVACY_GATEWAY_BLOCKED') {
      return c.json({
        ok: false,
        error: privacyGatewayUserNotice(Array.isArray(e?.reasons) ? e.reasons : []),
        privacyBlocked: true,
        code: 'PRIVACY_GATEWAY_BLOCKED',
        reasons: Array.isArray(e?.reasons) ? e.reasons : [],
      }, 403)
    }
    // 89차: Workers AI 일일 할당량 소진 (4006) → 명확한 안내
    if ((e as any)?.quotaExhausted) {
      return c.json({
        ok: false,
        error: 'AI 일일 사용량 한도에 도달했습니다. 내일 09:00(KST) 이후에 다시 시도해주세요.',
        code: 'AI_DAILY_QUOTA_EXHAUSTED',
        retryable: false,
      }, 429)
    }
    return c.json({ ok: false, error: 'AI 호출 실패. 잠시 후 다시 시도해주세요.' }, 502)
  }

  // 대화 기록 저장 (최근 200개만 유지, Phase 3C: messageId 반환, Phase 3D: promptVersion)
  const messageIds = await saveChatHistory(c.env, Number(conversationId), result.lastUserContent || '', [
    { personaId, text: result.text, model: result.model, promptVersion: result.promptVersion },
  ])
  return c.json({ ok: true, personaId, conversationId, text: result.text, provider: result.provider, model: result.model, fallbacks: result.fallbacks, sources: result.sources, pipeline: result.pipeline, approvalRequests: result.approvalRequests || [], messageId: messageIds[0] || null, promptVersion: result.promptVersion || 'legacy' })
})

// 오케스트레이터 — 라우터가 비서를 선택하고 필요시 협업
// POST /api/ai/orchestrate — { conversationId, messages } → { ok, text, participants, primaryId, decision }

aiApp.post('/orchestrate', async (c) => {
  type OrchBody = { conversationId?: number; messages?: RawChatMessage[]; previousPersona?: PersonaId; lockedPersona?: PersonaId }
  const body: OrchBody = await c.req.json<OrchBody>().catch((): OrchBody => ({}))
  const conversationId = body.conversationId || 1
  const rawMessages = body.messages || []

  // 마지막 사용자 메시지 추출 (라우팅 입력)
  const userTexts = rawMessages
    .filter((m) => m && m.role !== 'assistant' && typeof m.content === 'string' && m.content.trim())
    .map((m) => m.content.trim())
  if (userTexts.length === 0) return c.json({ ok: false, error: 'empty' }, 400)
  const userText = userTexts[userTexts.length - 1]
  if (userText.length > 8000) return c.json({ ok: false, error: 'too long' }, 400)

  try {
    const env = c.env
    const callResults = new Map<string, AssistantCallResult>()
    // AgentTeams(0047): 복합 요청은 다단계 팀으로, 단일 요청은 기존 오케스트레이터로.
    // callAssistant는 양쪽이 공유한다 (반환 형태가 동일해 아래 코드가 그대로 동작).
    const callAssistant = async (pid: string, msgs: any[]) => {
      // ID 게이트: 신규(lumi 등)·레거시(concierge 등) 어느 ID든 정규화해 받는다.
      // (기존 게이트는 신규 ID만 허용해 레거시 ID를 반환하는 오케스트레이터의
      //  기본 경로를 거부했음 — normalize가 양쪽을 허용하므로 게이트를 대체)
      const { normalizeLegacyPersonaId } = await import('../../services/persona-id-adapter')
      const legacyPid = normalizeLegacyPersonaId(pid)
      if (!legacyPid) throw new Error(`invalid persona: ${pid}`)
      const r = await callSingleAssistant(env, legacyPid, msgs, { conversationId, origin: 'interactive' })
      callResults.set(pid, r)
      return { text: r.text }
    }
    const { getClefRouterMode } = await import('../../services/clef-mode')
    const clefMode = await getClefRouterMode(env.DB).catch((): 'off' => 'off')
    const { getClefG6Mode } = await import('../../services/clef-g6')
    const g6Mode = await getClefG6Mode(env.DB).catch((): 'off' => 'off')
    const orchDeps = {
      callAssistant,
      clefMode,
      g6Mode,
      routeContext: {
        previousPersona: body.previousPersona,
        lockedPersona: body.lockedPersona,
      },
      recordDecision: async (entry: any) => {
        const { recordDecisionLog } = await import('../../services/clef-engine')
        await recordDecisionLog(env.DB, entry)
      },
      // Plan & Execute 루프(f트랙): env가 있으면 팀 실행을 0049 agent_runs·
      // 체크포인트에 기록한다. 진행 상황은 onProgress가 아닌 최종 응답의
      // progress/steps로 전달한다 (단일 요청·응답 형태 유지).
      env,
      clefInvoker: async (request: any) => {
        const { createClefInvoker } = await import('../../services/router');
        return createClefInvoker(env.AI as any, { db: env.DB })(request);
      },
    }
    const teamPlan = await planTeam(userText)
    const orch = teamPlan.needsTeam
      ? await runTeam(orchDeps, teamPlan, rawMessages, conversationId)
      : await orchestrate(orchDeps, userText, rawMessages, conversationId)

    // 각 비서의 응답을 persona_id 구분해서 저장
    await saveChatHistory(
      env,
      conversationId,
      userText,
      orch.responses.map((r) => ({
        personaId: r.personaId,
        text: r.text,
        model: callResults.get(r.personaId)?.model,
      })),
    )

    const primaryResult = callResults.get(orch.primaryId)
    return c.json({
      ok: true,
      text: orch.text,
      participants: orch.participants,
      primaryId: orch.primaryId,
      decision: orch.decision,
      provider: primaryResult?.provider,
      model: primaryResult?.model,
      sources: primaryResult?.sources,
      pipeline: primaryResult?.pipeline,
      // 팀 실행일 때만: 진행 상황 ("계획 n개 중 m개 완료") + 단계별 기록 + run ID
      ...('progress' in orch
        ? {
            progress: (orch as TeamResult).progress,
            steps: (orch as TeamResult).stepResults,
            runId: (orch as TeamResult).runId ?? null,
            clef: (orch as TeamResult).clef ?? null,
          }
        : {}),
    })
  } catch (e: any) {
    if (e instanceof PrivacyGatewayBlockedError || e?.name === 'PrivacyGatewayBlockedError' || e?.code === 'PRIVACY_GATEWAY_BLOCKED') {
      return c.json({
        ok: false,
        error: privacyGatewayUserNotice(Array.isArray(e?.reasons) ? e.reasons : []),
        privacyBlocked: true,
        code: 'PRIVACY_GATEWAY_BLOCKED',
        reasons: Array.isArray(e?.reasons) ? e.reasons : [],
      }, 403)
    }
    if ((e as any)?.quotaExhausted || isQuotaError(e)) {
      return c.json({
        ok: false,
        error: '오늘 AI 사용량을 다 썼습니다. 내일 09:00(KST) 이후에 다시 시도해주세요.',
        code: 'AI_DAILY_QUOTA_EXHAUSTED',
        retryable: false,
      }, 429)
    }
    return c.json({ ok: false, error: 'AI 호출 실패. 잠시 후 다시 시도해주세요.' }, 502)
  }
})

// 대화 기록 조회 (비서별 최근 50개)

aiApp.route('/', aiAdminApp)
