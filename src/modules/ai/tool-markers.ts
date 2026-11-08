// (routes.ts 분리, 2026-10-29 — 동작 변경 없는 순수 구조 분리로 이동된 코드)
// 도구 마커 처리 본체: 정책 가드·승인 게이트·비서 간 호출([ASK:])·최종 조립
import { aiChat, PERSONAS, MODELS, getSetting, setSetting, buildSystemPrompt, type TaskPolicy, type ProviderId } from '../../services/ai'
import {
  resolveRequestSensitivity,
  PrivacyBlockedError,
  getLegacyMarkerTools,
} from '../../ai/legacy-privacy-guard'
import { decideToolExecution, approvalScopeKey, ToolApprovalStore } from '../../services/tool-approval'
import {
  ToolApprovalRequestStore,
  buildApprovalRequestText,
  describeMaskedToolAction,
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
import { buildSearchFollowUpPrompt, validateItemSources, dedupeSources, filterFreshSources, isNewsQuery, resolveNewsIntent, noFreshNewsText, mergeSearchSources } from '../../lib/news-summary'
import { newLedgerRunId, ensureLedgerRun } from '../../services/tool-ledger'
import { sanitizeToolOutput, sandboxToolOutput, wrapToolOutputForModel } from '../../lib/context-sandbox'
import { enforceNoLockMarkers } from '../../services/policy-guard'
import type { ToolMarkerContext } from './tool-marker-context'
import { processMediaSearchMarkers, processMemoMarkers, processPageMarkers, processFileSearchMarkers } from './tool-markers-content'
import { processCronMarkers, processScheduleMarkers, processGoogleMarkers, processTodoMarkers, processArtifactMarkers } from './tool-markers-actions'
import { stripResidualToolMarkers } from './response-postprocess'

// [ASK:] 위임 호출 대상(callSingleAssistant)은 assistant-call.ts가 등록한다.
// 분리 전에는 같은 파일 안의 상호 재귀였으나, 모듈 순환 import를 만들지
// 않기 위해 레지스트리로 해소했다. routes.ts를 거치는 모든 실제 진입
// 경로에서는 assistant-call.ts 로드 시점에 등록이 끝나 있다.
// 미등록 상태에서 호출되면 예외가 발생하고, [ASK:] 처리의 기존 try/catch가
// '(비서 호출 실패)'로 치환한다 (호출 실패 시의 기존 동작과 동일).
type AssistantCaller = (
  env: any,
  personaId: string,
  messages: { role: string; content: string }[],
) => Promise<{ text?: string }>
let assistantCaller: AssistantCaller | null = null
export function registerAssistantCaller(fn: AssistantCaller): void {
  assistantCaller = fn
}
async function callRegisteredAssistant(
  env: any,
  personaId: string,
  messages: { role: string; content: string }[],
): Promise<{ text?: string }> {
  if (!assistantCaller) throw new Error('assistant caller not registered')
  return assistantCaller(env, personaId, messages)
}

export async function processToolMarkers(
  env: any,
  result: any,
  originalPersonaId?: string,
  options?: {
    conversationId?: number | string
    userRequest?: string
    approvedScopeKeys?: Set<string>
    /**
     * 실행 출처 (Talorys ③-A) — decideToolExecution에 그대로 전달한다.
     * 진입점(채팅 라우트·채널 핸들러)이 명시하는 것이 원칙이며, 미지정
     * 시의 폴백은 아래 gateOrigin 산출 규칙을 따른다.
     */
    origin?: import('../../ai/types').ExecutionOrigin
  },
): Promise<any> {
  let text = result.text || ''
  const images: { url: string; prompt: string }[] = []
  let dataChanged = false
  const toolResults: any[] = []
  const approvalRequests: ApprovalRequestSummary[] = []
  const gateNow = new Date()

  // 정책 가드 (트랙 5): 모델이 잠금/해제 마커를 출력해도 여기서 코드로 차단
  // (프롬프트 우회 불가 — 허용 목록 deny 처리보다 먼저 명시적 정책 메시지로 치환)
  text = enforceNoLockMarkers(text)

  // P0 보안: persona별 도구 허용 목록을 실행 시점에 강제
  // 프롬프트 안내는 soft 제한이므로, 여기서 실제 실행을 차단해야 함
  // GPT 2차 검토: personaId가 없거나 유효하지 않으면 deny-by-default (빈 권한)
  // 2026-10-15: GPT 권고 - 신규 ID도 기존 ID로 정규화하여 권한 검사
  const { normalizeLegacyPersonaId } = await import('../../services/persona-id-adapter');
  const effectivePersonaId = normalizeLegacyPersonaId(originalPersonaId);
  const allowedTools = effectivePersonaId ? getLegacyMarkerTools(effectivePersonaId) : []
  // 허용되지 않은 마커는 실행 전에 제거 (권한 없음 메시지로 치환)
  // 1) paired 마커: [TOOL]...[/TOOL]
  const denyPattern = /\[((?:MEMO|SCHEDULE|TODO)(?:_[A-Z]+)?|PAGE|FILE_SEARCH)\]([\s\S]*?)\[\/\1\]/gi
  // 2) single 마커: [SEARCH: query], [IMG: prompt], [GITHUB: query]
  const denySinglePattern = /\[(SEARCH|IMG|GITHUB|PAGE|FILE_SEARCH):\s*([^\]]+)\]/gi
  const denyReplacer = (full: string, tool: string) => {
    const toolUpper = String(tool).toUpperCase()
    if (!allowedTools.includes(toolUpper)) {
      return '(이 작업은 지금 대화 중인 비서가 처리할 수 없습니다. 담당 비서로 전환해 다시 요청해 주세요.)'
    }
    return full
  }
  text = text.replace(denyPattern, denyReplacer)
  text = text.replace(denySinglePattern, denyReplacer)

  // GPT 3차 검토: 도구 실행 결과에 삽입된 외부 데이터도 필터링
  // 검색 결과, 메모 내용 등에 마커가 포함되어 후속 파서에서 실행되는 것을 방지
  // 삽입 전 데이터를 sanitize하는 헬퍼
  // context-mode 샌드박스: 도구 출력은 데이터일 뿐 — 허용 목록에 있는 마커라도
  // 메모/검색 결과 안에 심어진 것은 실행되지 않도록 전부 무력화한다.
  // (기존 denyReplacer 방식은 허용된 마커를 그대로 둬서, 메모 내용 속
  // [MEMO_DELETE]가 후속 파서에 걸려 실행되는 구멍이 있었다)
  // 요약·절단은 하지 않는다 — MEMO_GET 등 사용자 화면 표시용 원문을 보존하기 위함.
  const sanitizeInserted = (data: string): string => sanitizeToolOutput(String(data || ''))

  // GPT 10차: 실행기 수준 권한 검사 (Parse → Authorize → Validate → Execute)
  // 정규식 사전 필터와 별도로, 실제 실행 직전에 권한을 재확인
  // 중앙 정책을 사용하되 실행 시점 검사를 생략하지 않음
  //
  // b트랙 (위험 기반 승인 게이트): 허용 목록 검사를 넘어 위험 등급을 본다.
  // - 읽기: 승인 없이 실행
  // - 쓰기: 기본 승인 필요 (단건 승인 일회성 / "이 세션 허용"은 대화 스코프)
  // - 삭제·외부 발송: 반드시 승인 / 잠금 관련: 승인 여부와 무관하게 거부
  // - 승인 없으면 실행하지 않고 대기 요청을 만들고, 사용자에게 무엇을·근거·
  //   되돌릴 수 있는지·영향 범위를 보여준다 (tool_approval_requests에 저장).
  // - 대화 ID가 없는 백그라운드 실행(크론·잡)은 pending을 만들 수 없어 실행하지 않음.
  const authorizeTool = async (
    toolName: string,
    args: unknown,
    markerFull: string,
  ): Promise<{ allowed: boolean; message: string; request?: ApprovalRequestSummary }> => {
    const toolUpper = String(toolName).toUpperCase()
    // 유효하지 않은 persona → 거부 (deny-by-default)
    if (!effectivePersonaId) return { allowed: false, message: denyExecution(toolName).error }
    // 단건 승인으로 재실행 중이면 일회성 허용 (이 집합에만 해당).
    // 단, 출처가 명시적으로 비대화형이면 일회성 승인으로도 우회할 수 없다 (③-A).
    if (
      options?.origin !== 'scheduled' &&
      options?.origin !== 'mcp' &&
      options?.origin !== 'channel' &&
      options?.approvedScopeKeys?.has(approvalScopeKey(toolUpper, args))
    ) {
      return { allowed: true, message: '' }
    }
    // 출처 (③-A): 진입점이 명시한 origin이 우선한다. 미지정인 경우의
    // 구조적 폴백 — 대화 ID를 가진 턴은 그 자체가 대화형 채팅 세션이므로
    // 'interactive'로 판정하고, 대화 ID가 없는 백그라운드 호출은 미지정
    // 그대로 두어 decide가 쓰기를 fail-closed로 막게 한다.
    const gateOrigin =
      options?.origin ??
      (options?.conversationId !== undefined && options?.conversationId !== null
        ? 'interactive'
        : undefined)
    const decision = decideToolExecution({
      personaId: effectivePersonaId,
      tool: toolUpper,
      args,
      approval: null,
      sessionAllowed: false,
      origin: gateOrigin,
      now: gateNow,
    })
    if (decision.decision === 'allow') return { allowed: true, message: '' }
    if (decision.decision === 'deny') {
      // 잠금/해제 도구는 승인 흐름이 아니라 정책 차단을 명시한다
      if (decision.reason === 'lock_forbidden') {
        return { allowed: false, message: '(잠금/해제는 AI가 할 수 없어 실행하지 않았습니다)' }
      }
      // 비대화형 출처의 쓰기·파괴적 도구: 승인 절차로 안내할 상대가
      // 없으므로, 채팅에서 다시 요청하도록 안내하고 실행하지 않는다.
      if (decision.reason === 'non_interactive_origin') {
        return {
          allowed: false,
          message: '(이 작업은 승인이 필요해 실행하지 않았습니다. 채팅에서 다시 요청해 주세요)',
        }
      }
      return { allowed: false, message: denyExecution(toolName).error }
    }

    // ask — "이 세션 허용"이 있으면 실행 (같은 대화·같은 종류의 도구)
    const conversationId = options?.conversationId
    if (conversationId === undefined || conversationId === null || !env?.DB) {
      return {
        allowed: false,
        message: '(이 작업은 승인이 필요해 실행하지 않았습니다. 채팅에서 다시 요청해 주세요)',
      }
    }
    const approvalStore = new ToolApprovalStore(env.DB)
    const requestStore = new ToolApprovalRequestStore(env.DB, env)
    try {
      const session = await approvalStore.findSessionAllowance(
        effectivePersonaId,
        toolUpper,
        conversationId,
        gateNow,
      )
      if (session) return { allowed: true, message: '' }
    } catch {
      // 세션 확인 실패는 ask로 진행 (실행은 하지 않음)
    }
    try {
      const scopeKey = decision.scopeKey
      const existing = await requestStore.findPendingByScope(Number(conversationId), scopeKey, gateNow)
      if (existing) {
        const msg = buildApprovalRequestText(existing)
        return { allowed: false, message: msg, request: existing }
      }
      const desc = describeMaskedToolAction(toolUpper, decision.maskedArgs)
      // i트랙 dry-run 미리보기 — 읽기 전용 조회로 "무엇이 바뀌는지"를 계산한다.
      // 미리보기 실패가 승인 요청 자체를 막지는 않는다 (게이트는 그대로 동작).
      // 미리보기는 마스킹된 인자만 쓰며, 잠긴 메모 내용은 절대 노출하지 않는다.
      let dryRunPreviewText: string | undefined
      try {
        const preview = await buildDryRunPreview(env.DB, toolUpper, decision.maskedArgs, scopeKey)
        dryRunPreviewText = formatDryRunPreview(preview)
        try {
          await new SandboxAuditStore(env.DB).recordAudit({
            personaId: effectivePersonaId,
            conversationId: Number(conversationId),
            tool: toolUpper,
            scopeKey,
            action: 'preview_shown',
            detail: JSON.stringify({ summary: desc.summary, preview }),
            createdAt: gateNow.toISOString(),
          })
        } catch {
          // 감사 기록 실패가 승인 흐름을 막지는 않는다
        }
      } catch {
        dryRunPreviewText = undefined
      }
      const pending = await requestStore.createPending({
        personaId: effectivePersonaId,
        conversationId: Number(conversationId),
        tool: toolUpper,
        scopeKey,
        markerText: markerFull,
        summary: desc.summary,
        userRequest: String(options?.userRequest || '').slice(0, 200),
        reversible: desc.reversible,
        impact: desc.impact,
        expiresAt: new Date(gateNow.getTime() + APPROVAL_TIMEOUT_MS).toISOString(),
        createdAt: gateNow.toISOString(),
      })
      const msg = buildApprovalRequestText({ ...pending, dryRunPreview: dryRunPreviewText })
      return { allowed: false, message: msg, request: pending }
    } catch {
      return { allowed: false, message: '(승인 요청을 만들지 못했습니다. 실행하지 않았습니다)' }
    }
  }

  // 권한 없는 도구 실행 시 거부 메시지 반환 헬퍼
  const denyExecution = (toolName: string) => ({
    success: false,
    error: `(이 작업은 지금 대화 중인 비서가 처리할 수 없습니다. 담당 비서로 전환해 다시 요청해 주세요.)`
  })

  // [ASK:persona_id]message[/ASK] → 다른 비서에게 질의 (비서 간 호출)
  // 최대 2단계까지만 허용 (무한 루프 방지)
  const askRe = /\[ASK:([a-z_]+)\]([\s\S]*?)\[\/ASK\]/gi;
  let askMatch;
  let askCount = 0;
  while ((askMatch = askRe.exec(text)) !== null && askCount < 2) {
    askCount++;
    const targetId = askMatch[1];
    const askMessage = askMatch[2].trim();
    const fullMarker = askMatch[0];
    
    // 자기 자신에게 호출 방지
    if (targetId === originalPersonaId) {
      text = text.replace(fullMarker, '(자기 자신에게는 질문할 수 없습니다)');
      continue;
    }
    
    try {
      const targetPersona = PERSONAS.find(p => p.id === targetId);
      if (!targetPersona) {
        text = text.replace(fullMarker, `(알 수 없는 비서: ${targetId})`);
        continue;
      }
      // 대상 비서 호출 (간단한 메시지로)
      // P0 보안: 호출자의 권한을 초과하지 않도록, 하위 비서 응답의 마커도
      // 호출자의 허용 목록으로 필터링 (권한 상승 방지)
      const subResult = await callRegisteredAssistant(env, targetId, [
        { role: 'user', content: askMessage }
      ]);
      let subText = subResult.text || '(응답 없음)';
      // 하위 응답에 포함된 마커를 호출자 권한으로 재필터링
      subText = subText.replace(denyPattern, denyReplacer);
      subText = subText.replace(denySinglePattern, denyReplacer);
      // 마커를 결과로 교체
      text = text.replace(fullMarker, `\n[${targetPersona.name}의 답변]\n${subText}\n`);
      dataChanged = true;
    } catch (e) {
      text = text.replace(fullMarker, '(비서 호출 실패)');
    }
  }

  // 마커 종류별 처리는 섹션 헬퍼로 위임한다 (공유 상태는 ctx로 전달,
  // 처리 순서와 본문 로직은 분리 전과 동일)
  const searchReplacementSources: { title: string; url: string }[] = []
  const uiActions: any[] = []
  const ledgerRunId = newLedgerRunId()
  if (env?.DB) {
    await ensureLedgerRun(env.DB, {
      runId: ledgerRunId,
      requestId: ledgerRunId,
      userId: 'default',
      personaId: effectivePersonaId || originalPersonaId,
      provider: typeof result?.provider === 'string' ? result.provider : undefined,
      model: typeof result?.model === 'string' ? result.model : undefined,
    })
  }
  const ctx: ToolMarkerContext = {
    env,
    text,
    images,
    uiActions,
    dataChanged,
    toolResults,
    approvalRequests,
    searchReplacementSources,
    authorizeTool,
    sanitizeInserted,
    denyExecution,
    ledgerRunId,
    ledgerRequestId: ledgerRunId,
    ledgerUserId: 'default',
    ledgerPersonaId: effectivePersonaId || originalPersonaId,
    ledgerExecutions: [],
    userRequest: options?.userRequest,
  }
  await processMediaSearchMarkers(ctx)
  await processMemoMarkers(ctx)
  await processPageMarkers(ctx)
  await processFileSearchMarkers(ctx)
  await processCronMarkers(ctx)
  await processScheduleMarkers(ctx)
  await processGoogleMarkers(ctx)
  await processTodoMarkers(ctx)
  await processArtifactMarkers(ctx)
  text = ctx.text
  dataChanged = ctx.dataChanged
  const swept = stripResidualToolMarkers(text)
  if (swept.removed > 0) text = swept.text
  result.ledgerExecutions = ctx.ledgerExecutions || []

  if (images.length > 0) {
    result.images = images
  }
  result.text = text
  // 대기 중인 승인 요청이 있으면 프론트 버튼용으로 전달
  if (approvalRequests.length > 0) {
    result.approvalRequests = approvalRequests
  }
  // FC 경로에서 이미 설정된 dataChanged와 uiActions를 보존 (마커 처리로 덮어쓰지 않음)
  ;(result as any).dataChanged = dataChanged || (result as any).dataChanged || false
  // 마커 실행 결과를 toolResults에 병합 (후보 버튼 UI용)
  if (toolResults.length > 0) {
    const existing = (result as any).toolResults || []
    ;(result as any).toolResults = [...existing, ...toolResults]
  }
  if (uiActions.length > 0) {
    const existing = result.uiActions || []
    result.uiActions = [...existing, ...uiActions]
  }
  // d트랙 (성찰): 도구가 실제로 데이터를 바꾼 턴에만, 요청 + 결과에서 배운
  // 사실·선호·제약을 기억에 반영한다. plain 채팅은 대상이 아니다 (기억 오염 방지).
  // 실패해도 응답은 그대로 반환한다 (fail-soft — 성찰은 부가 경로).
  if (dataChanged) {
    try {
      const { reflectOnTask } = await import('../../services/memory-reflection')
      await reflectOnTask(env, {
        taskType: 'chat',
        taskText: options?.userRequest || '',
        resultText: text,
        persona: effectivePersonaId || originalPersonaId,
      })
    } catch {
      // 성찰 실패는 응답에 영향 없음
    }
  }
  // sources/text 일치: [SEARCH:] 치환이 있었으면 최종 텍스트에 실제 표시된
  // 링크와 sources를 일치시킨다 (치환이 없으면 기존 sources 그대로 유지).
  if (searchReplacementSources.length > 0) {
    ;(result as any).sources = mergeSearchSources(
      (result as any).sources,
      searchReplacementSources,
      text,
    )
  }
  return result
}
