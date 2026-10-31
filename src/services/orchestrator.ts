/**
 * 서버 측 오케스트레이터 — 비서 선택, 협업, 답변 종합, 기록
 *
 * 설계 원칙:
 * - 기존 비서의 역할/도구 권한 변경 없음
 * - 라야 등 외부 의사결정 API 의존성 없음 (Router 인터페이스로 분리)
 * - 협업은 추가 비서 최대 1명으로 제한
 * - 실패 시 기존 동작으로 폴백
 */

import { KeywordRouter, isValidPersonaId, type Router, type RouterDecision } from './legacy-router'
import { buildCoordinatorHandoff, type StructuredHandoffInput } from './agent-handoff'

// 라우터 인스턴스 (나중에 교체 가능)
let router: Router = new KeywordRouter()

export function setRouter(r: Router) {
  router = r
}

export function getRouter(): Router {
  return router
}

export interface OrchestrationResult {
  /** 최종 응답 텍스트 */
  text: string
  /** 실제 참여한 비서 ID 목록 */
  participants: string[]
  /** 주 담당 비서 ID */
  primaryId: string
  /** 라우팅 결정 정보 */
  decision: RouterDecision
  /** 각 비서의 개별 응답 (디버깅/기록용) */
  responses: Array<{ personaId: string; text: string }>
}

export interface OrchestratorDeps {
  /** 비서 호출 함수 (기존 aiChat 래퍼) */
  callAssistant: (personaId: string, messages: any[]) => Promise<{ text: string }>
  /** 실행 기록 함수 */
  log?: (entry: OrchestrationLog) => Promise<void>
  /** Clef-flash 라우터 활성화 여부 (Feature Flag, 기본값 false) */
  useClefRouter?: boolean
  /** Clef-flash 호출 함수 (useClefRouter=true일 때 필요) */
  clefInvoker?: (request: any) => Promise<unknown>
  /**
   * 코디네이터 핸드오프 기록 함수 (트랙 7) — 협업 인계 시 형식 있는
   * 핸드오프 기록(요청·맥락·제약·기대 출력)을 남긴다. 없으면 기록하지 않고,
   * 실패해도 협업은 계속된다 (log와 같은 취급).
   */
  recordHandoff?: (handoff: StructuredHandoffInput) => Promise<void>
  /** 비서별 핸드오프 제약 (없으면 빈 배열) */
  handoffConstraints?: Record<string, string[]>
}

export interface OrchestrationLog {
  conversationId: number
  userText: string
  decision: RouterDecision
  participants: string[]
  latencyMs: number
  success: boolean
  error?: string
}

const MAX_COLLABORATORS = 1

/**
 * 오케스트레이션 실행
 */
export async function orchestrate(
  deps: OrchestratorDeps,
  userText: string,
  messages: any[],
  conversationId: number,
  suggestedPersonaId?: string
): Promise<OrchestrationResult> {
  const start = Date.now()
  const log: OrchestrationLog = {
    conversationId,
    userText: userText.slice(0, 500),
    decision: { primary: 'concierge', reason: 'fallback', confidence: 0 },
    participants: [],
    latencyMs: 0,
    success: false,
  }

  try {
    // 1. 라우팅 결정 (Feature Flag: CLEF_ROUTER_ENABLED)
    let decision: RouterDecision
    try {
      // 신규 Clef-flash 라우터 사용 (활성화된 경우)
      if (deps.useClefRouter && deps.clefInvoker) {
        const { routeMessage } = await import('./router');
        const { resolveClefRoute } = await import('./persona-id-adapter');
        const routeResult = await routeMessage(
          deps.clefInvoker,
          userText,
          {} // context는 추후 세션에서 전달
        );
        // GPT 권고: persona:null을 정상 분류 결과로 처리 (예외 아님)
        const outcome = resolveClefRoute(routeResult);
        if (outcome.kind === 'reply') {
          // 복합 요청 또는 낮은 신뢰도: 사용자에게 안내 메시지 반환
          // 기존 채팅 응답 형식에 맞춰 반환
          log.decision = { primary: 'concierge', reason: outcome.reason, confidence: 0 };
          log.success = true;
          log.latencyMs = Date.now() - start;
          if (deps.log) await deps.log(log).catch(() => {});
          return {
            text: outcome.message,
            participants: [],
            primaryId: 'concierge',
            decision: log.decision,
            responses: [],
          };
        }
        // 정상 dispatch: 기존 ID로 변환됨
        decision = {
          primary: outcome.primary,
          reason: `clef:${outcome.reason}`,
          confidence: routeResult.confidence ?? 0,
        };
      } else {
        // 기존 레거시 라우터 사용 (기본값)
        decision = await router.route(userText, { suggestedPersonaId })
      }
      // 검증: 허용된 ID만
      if (!isValidPersonaId(decision.primary)) {
        throw new Error(`invalid primary: ${decision.primary}`)
      }
      if (decision.collaborator && !isValidPersonaId(decision.collaborator)) {
        decision.collaborator = undefined
      }
      // 협업자 수 제한
      if (decision.collaborator === decision.primary) {
        decision.collaborator = undefined
      }
    } catch (e) {
      // 라우터 실패 → 클라이언트 힌트 또는 기본값으로 폴백
      const fallbackId = suggestedPersonaId && isValidPersonaId(suggestedPersonaId)
        ? suggestedPersonaId
        : 'concierge'
      decision = { primary: fallbackId, reason: 'router-fallback', confidence: 0 }
    }
    log.decision = decision

    // 2. 주 담당 비서 호출
    const responses: Array<{ personaId: string; text: string }> = []
    const primaryResult = await deps.callAssistant(decision.primary, messages)
    responses.push({ personaId: decision.primary, text: primaryResult.text })

    const participants = [decision.primary]

    // 3. 협업 (최대 1명)
    if (decision.collaborator && participants.length <= MAX_COLLABORATORS) {
      try {
        // 코디네이터 핸드오프 기록 (트랙 7) — 협업자 호출 전에 인계 내용을
        // 형식 있게 남긴다. 기록 실패는 협업을 막지 않는다.
        if (deps.recordHandoff) {
          const constraints = deps.handoffConstraints?.[decision.collaborator] ?? []
          await deps.recordHandoff(
            buildCoordinatorHandoff(decision.primary, decision.collaborator, userText, primaryResult.text, constraints)
          ).catch(() => {})
        }
        // 협업 비서에게는 주 담당의 답변을 컨텍스트로 전달
        const collabMessages = [
          ...messages,
          {
            role: 'assistant',
            content: `[${decision.primary}의 답변]\n${primaryResult.text}\n\n위 답변을 보완하거나 다른 관점에서 추가해줘. 같은 내용을 반복하지 마.`,
          },
        ]
        const collabResult = await deps.callAssistant(decision.collaborator, collabMessages)
        responses.push({ personaId: decision.collaborator, text: collabResult.text })
        participants.push(decision.collaborator)
      } catch (e) {
        // 협업 실패 → 주 담당 답변만 사용 (조용히 폴백)
      }
    }

    // 4. 답변 종합
    const text = synthesize(responses)

    log.participants = participants
    log.latencyMs = Date.now() - start
    log.success = true
    if (deps.log) await deps.log(log).catch(() => {})

    return { text, participants, primaryId: decision.primary, decision, responses }
  } catch (e: any) {
    log.latencyMs = Date.now() - start
    log.error = e?.message || 'unknown'
    if (deps.log) await deps.log(log).catch(() => {})
    throw e
  }
}

/**
 * 여러 비서의 답변을 하나로 종합
 * 현재는 단순 결합 (나중에 개선 가능)
 */
function synthesize(responses: Array<{ personaId: string; text: string }>): string {
  if (responses.length === 1) return responses[0].text
  // 협업 시: 주 담당 답변 + 협업자 보완을 구분해서 표시
  return responses.map(r => r.text).join('\n\n')
}
