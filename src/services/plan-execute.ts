/**
 * Plan & Execute 루프 엔진 — OpenManus의 계획→실행→검증 명시적 루프를 참고
 * (패턴만 참고하고 코드는 이식하지 않음).
 *
 * AgentTeams 분해(planTeam)가 만든 단계 목록을 받아 순서대로 실행한다.
 * - 계획: 각 단계는 담당 비서·기대 결과(expectedOutcome)·검증 조건(verify)을
 *   명시한다 (직렬화 가능해야 한다 — 계획이 agent_runs.plan_json에 저장됨).
 * - 실행: 단계를 순서대로 실행하고, 각 단계 결과를 0049 agent_runs·
 *   agent_run_checkpoints에 기록한다 (env가 있을 때만; 기록 실패는 실행을
 *   막지 않는다).
 * - 검증: 단계 결과가 검증 조건을 만족하는지 확인한다. 예외·검증 실패 시
 *   최대 2회까지 재시도하고(총 3회 시도), 그래도 실패하면 남은 단계를
 *   실행하지 않고 중단한다 (조용한 실패 금지).
 * - 진행: 단계 경계마다 onProgress 콜백으로 진행 상황을 알린다.
 *
 * 검증 한계 (정직한 표기): verify는 구조 검증(빈 응답·한 글자 응답 차단)만
 * 한다. 단계 결과 내용의 실질적 정확성은 LLM 심사관 없이는 판단할 수 없어
 * 검증하지 않는다 — 후속 트랙 과제.
 *
 * 보안 경계: 체크포인트 state는 단계 결과 텍스트만 담는다. 잠긴 메모 내용을
 * state로 전달하는 호출은 만들지 않는다 (agent-run 보안 경계와 동일).
 */

import { createRun, saveCheckpoint, updateRunStatus } from './agent-run'

/** 단계당 최대 시도 횟수 — 최초 1회 + 재시도 2회 */
export const MAX_STEP_ATTEMPTS = 3
/** 단계 결과 구조 검증 하한 — 빈 응답·한 글자 응답은 실패로 간주 */
export const MIN_STEP_RESULT_LENGTH = 2
/** 체크포인트에 저장하는 단계 결과 텍스트 상한 (100KB state 제한 여유 확보) */
export const MAX_CHECKPOINT_TEXT_LENGTH = 2000

/**
 * 단계 결과 검증 조건 — 직렬화 가능해야 한다 (계획이 agent_runs.plan_json에
 * 저장되므로 함수·정규식은 넣지 않는다).
 */
export type StepVerify =
  | { kind: 'non_empty' }
  | { kind: 'min_length'; min: number }
  | { kind: 'contains_any'; keywords: string[] }

export interface PlanStep {
  index: number
  personaId: string
  /** 이 단계가 처리할 요청 절 */
  clause: string
  /** 기대 결과 — 이 단계가 성공했을 때 얻어야 하는 것 (사용자 표시용) */
  expectedOutcome: string
  /** 검증 조건 — 단계 결과 텍스트가 만족해야 하는 조건 */
  verify: StepVerify
  /** 파괴적 동사 포함 — 승인 없으면 스킵 */
  needsApproval: boolean
}

/** 단계별 실행 기록 — 진행 상황·재시도·실패 보고의 근거 */
export interface StepExecution {
  index: number
  personaId: string
  status: 'completed' | 'skipped' | 'failed'
  /** 시도 횟수 (재시도 포함, 스킵은 0) */
  attempts: number
  /** 완료된 단계의 결과 텍스트 */
  text?: string
  /** 스킵·실패 사유 (approval_required / verify_failed:... / 예외 메시지) */
  reason?: string
}

/** 진행 상황 — "계획 n개 중 m개 완료"의 근거 */
export interface PlanProgress {
  total: number
  completed: number
  skipped: number
  failed: number
  done: boolean
}

export interface PlanExecuteDeps<S extends PlanStep> {
  /** 단계 실행 — 성공 시 단계 결과 텍스트 반환, 실패 시 throw */
  runStep: (step: S, stepIndex: number, priorTexts: string) => Promise<string>
  /**
   * 파괴적 단계 승인 확인. 없거나 false를 반환하면 해당 단계는 스킵된다
   * (fail-closed — 승인 없는 삭제·취소는 실행하지 않음).
   */
  approvalChecker?: (step: S) => Promise<boolean> | boolean
  /** 진행 상황 콜백 — 단계 경계(완료·스킵·실패)마다 호출된다. */
  onProgress?: (progress: PlanProgress) => void | Promise<void>
  /**
   * D1 env — 있으면 0049 agent_runs·agent_run_checkpoints에 실행 기록을
   * 남긴다. 없으면 인메모리 실행만 한다 (기록 실패는 실행을 막지 않음).
   */
  env?: any
  /** run 생성용 메타 (env가 있을 때만 사용) */
  runMeta?: { conversationId: number; userText: string }
}

export interface PlanExecuteResult<S extends PlanStep = PlanStep> {
  executions: StepExecution[]
  responses: Array<{ personaId: string; text: string }>
  participants: string[]
  skipped: Array<{ step: S; reason: string }>
  progress: PlanProgress
  /** 0049 agent_runs 행 ID (env가 없어 기록하지 않았으면 null) */
  runId: string | null
  /** 실패로 중단됐는지 (재시도 소진 — 남은 단계 미실행) */
  stoppedEarly: boolean
  /** 중단 원인 (stoppedEarly일 때만) */
  failureReason: string | null
}

/** agent_runs plan에 저장할 단계 이름 (RunStep.name — 중복 불가) */
export function runStepName(step: PlanStep): string {
  return `step-${step.index}-${step.personaId}`
}

/**
 * 단계 결과가 검증 조건을 만족하는지 확인한다 (순수 함수 — LLM 없이 구조만 검증).
 * - non_empty: 빈 응답 거부
 * - min_length: 지정 길이 미만 거부 (빈 응답·한 글자 응답 차단)
 * - contains_any: 기대 키워드 중 하나라도 포함돼야 함 (대소문자 무시)
 */
export function verifyStepResult(
  step: PlanStep,
  text: string,
): { ok: boolean; reason?: string } {
  const t = (text || '').trim()
  switch (step.verify.kind) {
    case 'non_empty':
      return t.length > 0 ? { ok: true } : { ok: false, reason: 'empty_result' }
    case 'min_length':
      return t.length >= step.verify.min
        ? { ok: true }
        : { ok: false, reason: `too_short:${t.length}<${step.verify.min}` }
    case 'contains_any': {
      const lower = t.toLowerCase()
      const hit = step.verify.keywords.some((k) => k && lower.includes(k.toLowerCase()))
      return hit ? { ok: true } : { ok: false, reason: 'missing_expected_content' }
    }
  }
}

/**
 * 계획 실행 — 단계를 순서대로 실행·검증·재시도한다.
 * - 승인 없는 파괴적 단계는 스킵하고 계속한다 (승인 스킵은 실패가 아니다).
 * - 예외·검증 실패 시 최대 2회까지 재시도한다 (총 MAX_STEP_ATTEMPTS회 시도).
 * - 재시도를 소진해도 실패하면 남은 단계를 실행하지 않고 중단한다.
 * - 완료·스킵된 단계는 단계 경계마다 체크포인트에 기록한다. 실패한 단계는
 *   체크포인트를 남기지 않아 재개 시 해당 단계부터 이어할 수 있게 한다.
 */
export async function executePlan<S extends PlanStep>(
  deps: PlanExecuteDeps<S>,
  steps: S[],
): Promise<PlanExecuteResult<S>> {
  const responses: Array<{ personaId: string; text: string }> = []
  const participants: string[] = []
  const skipped: Array<{ step: S; reason: string }> = []
  const executions: StepExecution[] = []
  const priorTexts: string[] = []
  let stoppedEarly = false
  let failureReason: string | null = null
  let failedStepIndex = -1

  const buildProgress = (): PlanProgress => ({
    total: steps.length,
    completed: executions.filter((r) => r.status === 'completed').length,
    skipped: executions.filter((r) => r.status === 'skipped').length,
    failed: executions.filter((r) => r.status === 'failed').length,
    done: executions.length >= steps.length || stoppedEarly,
  })

  const emitProgress = async () => {
    if (!deps.onProgress) return
    try {
      await deps.onProgress(buildProgress())
    } catch {
      // 진행 콜백 실패는 실행을 막지 않음
    }
  }

  // 0049 run 생성 (env가 있을 때만).
  let runId: string | null = null
  if (deps.env?.DB && steps.length > 0 && deps.runMeta) {
    try {
      const created = await createRun(deps.env, {
        conversationId: deps.runMeta.conversationId,
        userText: deps.runMeta.userText,
        plan: {
          steps: steps.map((s) => ({
            name: runStepName(s),
            persona: s.personaId,
            objective: s.clause,
          })),
        },
      })
      if (created.ok && created.runId) runId = created.runId
    } catch {
      // run 생성 실패는 실행을 막지 않음 (인메모리로 계속)
    }
  }

  // 단계 경계마다 체크포인트 저장 (완료·스킵된 단계만).
  const persistCheckpoint = async (step: S) => {
    if (!runId || !deps.env?.DB) return
    try {
      await saveCheckpoint(deps.env, runId, {
        stepIndex: step.index,
        stepName: runStepName(step),
        persona: step.personaId,
        state: {
          results: executions.map((r) => ({
            index: r.index,
            personaId: r.personaId,
            status: r.status,
            attempts: r.attempts,
            text: (r.text || '').slice(0, MAX_CHECKPOINT_TEXT_LENGTH),
            reason: r.reason,
          })),
        },
      })
    } catch {
      // 체크포인트 저장 실패는 실행을 막지 않음
    }
  }

  for (const step of steps) {
    if (step.needsApproval) {
      let approved = false
      try {
        approved = deps.approvalChecker ? await deps.approvalChecker(step) : false
      } catch {
        approved = false
      }
      if (!approved) {
        skipped.push({ step, reason: 'approval_required' })
        executions.push({
          index: step.index,
          personaId: step.personaId,
          status: 'skipped',
          attempts: 0,
          reason: 'approval_required',
        })
        await persistCheckpoint(step)
        await emitProgress()
        continue
      }
    }

    // 실행 + 검증 + 재시도 (최대 2회 재시도 = 총 3회 시도)
    let attempts = 0
    let lastError = ''
    let resultText: string | null = null
    while (attempts < MAX_STEP_ATTEMPTS) {
      attempts++
      try {
        const text = await deps.runStep(step, step.index, priorTexts.join('\n\n'))
        const check = verifyStepResult(step, text)
        if (check.ok) {
          resultText = text
          break
        }
        lastError = `verify_failed:${check.reason ?? 'unknown'}`
      } catch (e: any) {
        lastError = e?.message || 'unknown'
      }
    }

    if (resultText === null) {
      // 재시도 소진 — 남은 단계를 실행하지 않고 중단한다 (조용한 실패 금지).
      executions.push({
        index: step.index,
        personaId: step.personaId,
        status: 'failed',
        attempts,
        reason: lastError,
      })
      stoppedEarly = true
      failureReason = lastError
      failedStepIndex = step.index
      await emitProgress()
      break
    }

    responses.push({ personaId: step.personaId, text: resultText })
    participants.push(step.personaId)
    priorTexts.push(`[${step.personaId}]\n${resultText}`)
    executions.push({
      index: step.index,
      personaId: step.personaId,
      status: 'completed',
      attempts,
      text: resultText,
    })
    await persistCheckpoint(step)
    await emitProgress()
  }

  // run 종료 상태 기록
  if (runId && deps.env?.DB) {
    try {
      if (stoppedEarly) {
        await updateRunStatus(
          deps.env,
          runId,
          'failed',
          `step ${failedStepIndex} 실패: ${failureReason ?? 'unknown'}`,
        )
      } else {
        await updateRunStatus(deps.env, runId, 'completed')
      }
    } catch {
      // 종료 상태 기록 실패는 결과 반환을 막지 않음
    }
  }

  return {
    executions,
    responses,
    participants,
    skipped,
    progress: buildProgress(),
    runId,
    stoppedEarly,
    failureReason,
  }
}
