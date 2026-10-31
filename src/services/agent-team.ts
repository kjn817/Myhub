/**
 * AgentTeams 코디네이터 — Octop AgentTeams(Beta) 패턴 이식
 *
 * 복합 요청을 코디네이터가 여러 비서에게 다단계로 스케줄링한다.
 * - 기존 Clef 라우터·오케스트레이터 위에 얹는다 (중복 구현 금지):
 *   단일 요청은 기존 orchestrate()에 그대로 위임하고,
 *   다단계로 판단된 요청만 팀 루프를 탄다 (runTeamOrSingle).
 * - 단계 분해는 결정적 규칙 기반 (접속사 분리 + KeywordRouter 배정, zero-LLM).
 * - 단계는 순차 실행하며 이전 단계 결과를 다음 단계 컨텍스트로 전달한다
 *   (orchestrator의 협업자 패턴과 동일).
 * - 파괴적 동사가 있는 단계는 승인 없으면 실행하지 않는다 (tool-approval 경계).
 * - 잠긴 메모는 callAssistant 경유 시 기존 ai-access 계층이 원천 차단한다.
 *
 * Plan & Execute 루프 (f트랙): 계획(planTeam — 단계마다 담당 비서·기대 결과·
 * 검증 조건 명시) → 실행·검증·재시도(plan-execute.ts의 executePlan — 0049
 * agent_runs·체크포인트 기록, 최대 2회 재시도, 실패 시 중단·정직 보고) →
 * 진행 상황(TeamResult.progress + 응답 텍스트 첫 줄의 "계획 n개 중 m개 완료").
 */

import { orchestrate, type OrchestratorDeps, type OrchestrationResult } from './orchestrator'
import { KeywordRouter, type RouterDecision } from './legacy-router'
import { getExpertCapabilityByLegacyId } from './expert-registry'
import { requiresApprovalClause } from './tool-approval'
import {
  executePlan,
  MIN_STEP_RESULT_LENGTH,
  type PlanProgress,
  type PlanStep,
  type StepExecution,
} from './plan-execute'
import type { LegacyPersonaId } from './persona-id-adapter'

export const MAX_TEAM_STEPS = 3

// Plan & Execute 엔진에서 재노출 (호출부는 agent-team 경유로 일원화)
export { MAX_STEP_ATTEMPTS, MIN_STEP_RESULT_LENGTH, verifyStepResult, runStepName } from './plan-execute'
export type { StepExecution }

export interface TeamStep extends PlanStep {
  personaId: LegacyPersonaId
  reason: string
  /** 단일 절 다중 도메인일 때, 이 단계의 담당 범위 안내 */
  focus?: string
}

export interface TeamPlan {
  needsTeam: boolean
  /** 절 분리로 만든 계획인지 (false면 단일 절 + 협업자) */
  split: boolean
  steps: TeamStep[]
  /** 3단계 상한으로 잘렸는지 */
  truncated: boolean
  reason: string
}

export interface TeamResult {
  text: string
  participants: string[]
  primaryId: string
  decision: RouterDecision
  responses: Array<{ personaId: string; text: string }>
  steps: TeamStep[]
  skipped: Array<{ step: TeamStep; reason: string }>
  /** 단계별 실행 기록 */
  stepResults: StepExecution[]
  /** 진행 상황 */
  progress: PlanProgress
  /** 0049 agent_runs 행 ID (env가 없어 기록하지 않았으면 null) */
  runId: string | null
  /** 실패로 중단됐는지 (재시도 소진 — 남은 단계 미실행) */
  stoppedEarly: boolean
}

export interface TeamDeps extends OrchestratorDeps {
  /**
   * 파괴적 단계 승인 확인. 없거나 false를 반환하면 해당 단계는 스킵된다
   * (fail-closed — 승인 없는 삭제·취소는 실행하지 않음).
   */
  approvalChecker?: (step: TeamStep) => Promise<boolean> | boolean
  /**
   * D1 env — 있으면 0049 agent_runs·agent_run_checkpoints에 실행 기록을
   * 남긴다. 없으면 인메모리 실행만 한다 (기록 실패는 실행을 막지 않음).
   */
  env?: any
  /** 진행 상황 콜백 — 단계 경계(완료·스킵·실패)마다 호출된다. */
  onProgress?: (progress: PlanProgress) => void | Promise<void>
}

type ClauseRouter = {
  route(text: string, ctx?: unknown): Promise<RouterDecision>
}

const SEP = '\u0000'
const CONJUNCTION_RE =
  /(^|[\s.。!?,])(그리고|또|그\s*다음(?:에)?|이어서|그\s*후(?:에)?)(?=[\s.。!?,]|$)/gu

/** 접속사로 요청을 절로 나눈다. 접속사가 없으면 원문 1절. */
export function splitClauses(text: string): string[] {
  const marked = text.replace(CONJUNCTION_RE, `$1${SEP}`)
  return marked
    .split(SEP)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

const FOCUS_KO: Record<string, string> = {
  chat: '대화·설명',
  summarize: '메모 요약·정리',
  code: '코드 작성·수정',
  schedule: '일정·할 일',
}

const EXPECTED_OUTCOME_KO: Record<string, string> = {
  chat: '요청에 대한 답변이 담긴 응답',
  summarize: '요약 결과가 담긴 답변',
  code: '코드 또는 코드 설명이 담긴 답변',
  schedule: '일정·할 일 처리 결과가 담긴 답변',
}

function focusFor(personaId: string): string | undefined {
  // 단계의 personaId는 라우터가 이미 검증한 레거시 ID — 정규화 없이 직접 조회
  const capability = getExpertCapabilityByLegacyId(personaId)
  return capability ? FOCUS_KO[capability] : undefined
}

function expectedOutcomeFor(personaId: string): string {
  const capability = getExpertCapabilityByLegacyId(personaId)
  return (capability ? EXPECTED_OUTCOME_KO[capability] : undefined) ?? '요청 처리 결과가 담긴 답변'
}

function toStep(
  index: number,
  personaId: string,
  clause: string,
  reason: string,
  focus?: string,
): TeamStep {
  return {
    index,
    personaId: personaId as LegacyPersonaId,
    clause,
    reason,
    needsApproval: requiresApprovalClause(clause),
    focus,
    expectedOutcome: expectedOutcomeFor(personaId),
    verify: { kind: 'min_length', min: MIN_STEP_RESULT_LENGTH },
  }
}

/**
 * 복합 요청을 팀 계획으로 분해한다.
 * - 접속사로 절 분리 → 절마다 KeywordRouter 배정 → 연속 동일 비서 병합.
 * - 절이 1개인데 라우터가 협업자를 반환하면 2단계 팀 (주 담당 + 협업자).
 * - 그 외는 단일 단계 (needsTeam=false).
 * - 각 단계에 기대 결과(expectedOutcome)와 검증 조건(verify)을 명시한다.
 */
export async function planTeam(
  userText: string,
  router: ClauseRouter = new KeywordRouter(),
): Promise<TeamPlan> {
  const text = (userText || '').trim()
  if (!text) {
    return { needsTeam: false, split: false, steps: [], truncated: false, reason: 'empty' }
  }

  const clauses = splitClauses(text)
  if (clauses.length >= 2) {
    const steps: TeamStep[] = []
    for (const clause of clauses) {
      let decision: RouterDecision
      try {
        decision = await router.route(clause)
      } catch {
        decision = { primary: 'concierge', reason: 'router-error', confidence: 0 }
      }
      const primary = decision.primary as LegacyPersonaId
      const last = steps[steps.length - 1]
      if (last && last.personaId === primary) {
        // 연속 동일 비서는 한 단계로 병합
        last.clause = `${last.clause} 그리고 ${clause}`
        last.needsApproval = requiresApprovalClause(last.clause)
      } else {
        steps.push(toStep(steps.length, primary, clause, `clause:${decision.reason}`))
      }
    }
    const distinct = new Set(steps.map((s) => s.personaId)).size
    const truncated = steps.length > MAX_TEAM_STEPS
    const kept = truncated ? steps.slice(0, MAX_TEAM_STEPS) : steps
    kept.forEach((s, i) => {
      s.index = i
    })
    return {
      needsTeam: distinct >= 2,
      split: true,
      steps: kept,
      truncated,
      reason:
        distinct >= 2
          ? `team:split:${kept.map((s) => s.personaId).join('+')}`
          : 'single:same-persona',
    }
  }

  // 단일 절: 라우터의 협업자 판단 사용
  let decision: RouterDecision
  try {
    decision = await router.route(text)
  } catch {
    decision = { primary: 'concierge', reason: 'router-error', confidence: 0 }
  }
  if (decision.collaborator && decision.collaborator !== decision.primary) {
    const focus = focusFor(decision.collaborator)
    return {
      needsTeam: true,
      split: false,
      steps: [
        toStep(0, decision.primary, text, `primary:${decision.reason}`),
        toStep(
          1,
          decision.collaborator,
          text,
          `collaborator:${decision.reason}`,
          focus,
        ),
      ],
      truncated: false,
      reason: `team:multi-domain:${decision.primary}+${decision.collaborator}`,
    }
  }
  return {
    needsTeam: false,
    split: false,
    steps: [toStep(0, decision.primary, text, `single:${decision.reason}`)],
    truncated: false,
    reason: `single:${decision.reason}`,
  }
}

function messagesForStep(
  messages: any[],
  plan: TeamPlan,
  step: TeamStep,
  priorTexts: string,
): any[] {
  const base = [...messages]
  const content = step.focus
    ? `${step.clause}\n(위 요청 중 ${step.focus} 부분을 담당해줘. 다른 부분은 앞 단계에서 처리했으니 반복하지 마.)`
    : step.clause
  if (step.index === 0) {
    if (plan.split || step.focus) {
      // 절 분리된 첫 단계(또는 focus 안내가 있는 단계):
      // 마지막 사용자 메시지를 이 단계의 절로 교체 (전체 복합 요청을 다시 보지 않게)
      for (let i = base.length - 1; i >= 0; i--) {
        if (base[i]?.role === 'user') {
          base[i] = { ...base[i], content }
          return base
        }
      }
    } else {
      // 단일 절: 마지막 사용자 메시지가 이미 이 요청이면 그대로 사용 (중복 추가 금지)
      const last = base[base.length - 1]
      if (last?.role === 'user') return base
    }
    base.push({ role: 'user', content })
    return base
  }
  if (step.index > 0 && priorTexts) {
    base.push({
      role: 'assistant',
      content: `[이전 단계 결과]\n${priorTexts}`,
    })
  }
  base.push({ role: 'user', content })
  return base
}

/**
 * 팀 계획 실행 — Plan & Execute 루프 (executePlan에 위임하고 결과를 합성한다).
 * - 단계마다 결과를 검증하고, 예외·검증 실패 시 최대 2회까지 재시도한다.
 * - 재시도를 소진해도 실패하면 남은 단계를 실행하지 않고 중단한다.
 *   실패 사실·시도 횟수·사유를 최종 텍스트에 정직하게 보고한다 (조용한 실패 금지).
 * - 최종 텍스트 첫 줄에 "계획 n개 중 m개 완료" 진행 상황을 붙인다.
 */
export async function runTeam(
  deps: TeamDeps,
  plan: TeamPlan,
  messages: any[],
  conversationId: number,
): Promise<TeamResult> {
  const start = Date.now()

  const exec = await executePlan<TeamStep>(
    {
      runStep: async (step, _stepIndex, priorTexts) => {
        const stepMessages = messagesForStep(messages, plan, step, priorTexts)
        const result = await deps.callAssistant(step.personaId, stepMessages)
        return result.text
      },
      approvalChecker: deps.approvalChecker,
      onProgress: deps.onProgress,
      env: deps.env,
      runMeta: {
        conversationId,
        userText: messages
          .filter((m) => m?.role === 'user')
          .map((m) => m.content)
          .join(' ')
          .slice(0, 2000),
      },
    },
    plan.steps,
  )

  const { executions: stepResults, responses, participants, skipped } = exec

  // 최종 텍스트 합성 — 첫 줄에 진행 상황, 실패 시 정직한 보고를 붙인다.
  const total = plan.steps.length
  const completedCount = stepResults.filter((r) => r.status === 'completed').length
  let text = responses.map((r) => r.text).join('\n\n')
  if (total > 0) {
    const header = `계획 ${total}개 중 ${completedCount}개 완료.`
    const failed = stepResults.find((r) => r.status === 'failed')
    if (failed) {
      const failedStep = plan.steps[failed.index]
      const remaining = plan.steps.filter((s) => s.index > failed.index)
      const failNote =
        `${failed.personaId} 단계(${(failedStep?.clause ?? '').slice(0, 40)})가 ` +
        `${failed.attempts}회 시도 후에도 실패했습니다 (${failed.reason ?? 'unknown'}).` +
        (remaining.length > 0
          ? ` 남은 ${remaining.length}개 단계는 실행하지 않았습니다.`
          : '')
      text = text ? `${header}\n\n${text}\n\n${failNote}` : `${header}\n\n${failNote}`
    } else if (skipped.length > 0) {
      const notes = skipped
        .map(
          (s) =>
            `- ${s.step.personaId} 단계(${s.step.clause.slice(0, 40)}): ${
              s.reason === 'approval_required'
                ? '승인이 필요해 실행하지 않았습니다'
                : '실행에 실패했습니다'
            }`,
        )
        .join('\n')
      text = text
        ? `${header}\n\n${text}\n\n다음 단계는 처리하지 못했습니다:\n${notes}`
        : `${header}\n\n다음 단계는 처리하지 못했습니다:\n${notes}`
    } else {
      text = text ? `${header}\n\n${text}` : header
    }
  }
  if (!text) text = '요청을 처리하지 못했습니다. 다시 시도해 주세요.'

  const decision: RouterDecision = {
    primary: plan.steps[0]?.personaId ?? 'concierge',
    reason: plan.reason,
    confidence: 0.8,
  }
  if (deps.log) {
    await deps
      .log({
        conversationId,
        userText: messages
          .filter((m) => m?.role === 'user')
          .map((m) => m.content)
          .join(' ')
          .slice(0, 500),
        decision,
        participants,
        latencyMs: Date.now() - start,
        success: !exec.stoppedEarly && responses.length > 0,
      })
      .catch(() => {})
  }

  return {
    text,
    participants,
    primaryId: decision.primary,
    decision,
    responses,
    steps: plan.steps,
    skipped,
    stepResults,
    progress: exec.progress,
    runId: exec.runId,
    stoppedEarly: exec.stoppedEarly,
  }
}

/**
 * 단일 요청은 기존 orchestrate()에 위임하고, 다단계 요청만 팀 루프를 탄다.
 * 반환 형태가 orchestrate()와 동일해 호출부에서 그대로 쓸 수 있다.
 * (팀 결과는 progress·stepResults·runId·stoppedEarly를 추가로 담는다.)
 */
export async function runTeamOrSingle(
  deps: TeamDeps,
  userText: string,
  messages: any[],
  conversationId: number,
  suggestedPersonaId?: string,
): Promise<OrchestrationResult | TeamResult> {
  const plan = await planTeam(userText)
  if (!plan.needsTeam) {
    return orchestrate(deps, userText, messages, conversationId, suggestedPersonaId)
  }
  return runTeam(deps, plan, messages, conversationId)
}
