/**
 * agent-framework 패턴 — 코디네이터·핸드오프·체크포인팅 (트랙 7)
 *
 * microsoft/agent-framework의 HandoffBuilder + CheckpointStorage 패턴만 참고:
 * - 코디네이터가 비서를 지정하고, 핸드오프는 형식 있는 기록으로 남긴다.
 * - 체크포인트는 단계(노드) 경계마다 저장하고, 중단된 실행은 마지막 완료
 *   단계 다음부터 이어서 재개한다.
 *
 * 0044 memory_handoffs와의 역할 분리:
 * - memory_handoffs = 소유권 있는 1회 수령 (claim-once). 기억 페이로드 인계용.
 * - agent_handoffs = 형식 있는 핸드오프 기록 (요청·맥락·제약·기대 출력).
 *   수령 토큰이 없고 상태 전이로 해결한다. 필요 시 memory_handoff_id로
 *   claim-once 인계와 연결만 한다 (소유권 로직은 memory-service에 둔다).
 * - agent_runs / agent_run_checkpoints = 실행 상태 스냅샷 (재개용).
 *
 * 보안 경계: 잠긴 메모는 모든 외부 AI 전송 경로에서 제외된다. 체크포인트
 * state는 실행자가 넘긴 단계 결과만 저장한다 — 잠긴 메모 내용을 state로
 * 전달하는 호출은 만들지 않는다. state JSON은 100KB로 제한한다.
 */

export type RunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export interface RunStep {
  /** 단계 이름 (체크포인트 키, 중복 불가) */
  name: string
  /** 담당 비서 ID (lumi/echo/nova/cali 또는 concierge/keeper/builder/scheduler) */
  persona: string
  /** 단계 목표 (10자 이상 권장 — subagent-orchestrator 위임 규칙과 동일) */
  objective: string
}

export interface RunPlan {
  steps: RunStep[]
}

export interface AgentRun {
  id: string
  conversationId: number
  userText: string
  status: RunStatus
  /** 다음에 실행할 단계 인덱스 (0..totalSteps) */
  currentStep: number
  totalSteps: number
  plan: RunPlan
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface RunCheckpoint {
  runId: string
  stepIndex: number
  stepName: string
  persona: string
  /** 단계 완료 시점의 누적 상태 ({ results: [...] }) */
  state: Record<string, unknown>
  createdAt: string
}

const MAX_STEPS = 20
const MAX_STATE_BYTES = 100_000
const RUN_STATUSES: RunStatus[] = ['running', 'paused', 'completed', 'failed', 'cancelled']
/** 완료·취소는 종단 상태 — 여기서 다시 시작할 수 없다 (재개는 paused/failed만). */
const TERMINAL_STATUSES: RunStatus[] = ['completed', 'cancelled']

export function generateRunId(): string {
  const rand = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')
  return `run_${Date.now().toString(36)}-${rand()}${rand()}`
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validatePlan(plan: unknown): { ok: true; steps: RunStep[] } | { ok: false; error: string } {
  if (!isRecord(plan) || !Array.isArray(plan.steps)) return { ok: false, error: 'plan.steps 필요' }
  const steps = plan.steps
  if (steps.length === 0) return { ok: false, error: 'plan.steps 비어 있음' }
  if (steps.length > MAX_STEPS) return { ok: false, error: `단계는 최대 ${MAX_STEPS}개` }
  const names = new Set<string>()
  for (const s of steps) {
    if (!isRecord(s)) return { ok: false, error: '단계 형식 오류' }
    const name = typeof s.name === 'string' ? s.name.trim() : ''
    const persona = typeof s.persona === 'string' ? s.persona.trim() : ''
    const objective = typeof s.objective === 'string' ? s.objective.trim() : ''
    if (!name || !persona || !objective) return { ok: false, error: '단계 name/persona/objective 필요' }
    if (names.has(name)) return { ok: false, error: `단계 이름 중복: ${name}` }
    names.add(name)
  }
  return {
    ok: true,
    steps: steps.map((s: any) => ({
      name: s.name.trim(),
      persona: s.persona.trim(),
      objective: s.objective.trim(),
    })),
  }
}

function parsePlan(json: string): RunPlan {
  try {
    const p = JSON.parse(json || '{}')
    if (isRecord(p) && Array.isArray(p.steps)) return { steps: p.steps as RunStep[] }
  } catch {
    // 파싱 실패 → 빈 계획 (호출자가 resume 시 plan 부재로 실패 처리)
  }
  return { steps: [] }
}

function rowToRun(row: any): AgentRun {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userText: row.user_text || '',
    status: row.status,
    currentStep: row.current_step,
    totalSteps: row.total_steps,
    plan: parsePlan(row.plan_json),
    error: row.error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ---------------------------------------------------------------------------
// 실행(run) 생성 · 조회 · 상태 전이
// ---------------------------------------------------------------------------

export async function createRun(
  env: any,
  input: { conversationId: number; userText?: string; plan: RunPlan }
): Promise<{ ok: boolean; runId?: string; error?: string }> {
  if (!Number.isInteger(input.conversationId) || input.conversationId <= 0) {
    return { ok: false, error: 'conversation_id 필요' }
  }
  const plan = validatePlan(input.plan)
  if (!plan.ok) return { ok: false, error: plan.error }
  const userText = (input.userText || '').slice(0, 2000)
  try {
    const id = generateRunId()
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO agent_runs (id, conversation_id, user_text, status, current_step, total_steps, plan_json, created_at, updated_at) VALUES (?, ?, ?, 'running', 0, ?, ?, ?, ?)`
    ).bind(id, input.conversationId, userText, plan.steps.length, JSON.stringify({ steps: plan.steps }), now, now).run()
    return { ok: true, runId: id }
  } catch {
    return { ok: false, error: 'db_error' }
  }
}

export async function getRun(env: any, runId: string): Promise<{ ok: boolean; run?: AgentRun; error?: string }> {
  const id = (runId || '').trim()
  if (!id) return { ok: false, error: 'run_id 필요' }
  try {
    const row = await env.DB.prepare(`SELECT * FROM agent_runs WHERE id = ?`).bind(id).first() as any
    if (!row) return { ok: false, error: 'run_not_found' }
    return { ok: true, run: rowToRun(row) }
  } catch {
    return { ok: false, error: 'db_error' }
  }
}

/**
 * 상태 전이 — completed/cancelled는 종단 상태라 빠져나올 수 없다.
 * (완료된 실행을 재개하려면 새 run을 만든다.)
 */
export async function updateRunStatus(
  env: any,
  runId: string,
  status: RunStatus,
  error?: string
): Promise<{ ok: boolean; error?: string }> {
  const id = (runId || '').trim()
  if (!id) return { ok: false, error: 'run_id 필요' }
  if (!RUN_STATUSES.includes(status)) return { ok: false, error: 'status 값 오류' }
  try {
    const row = await env.DB.prepare(`SELECT status FROM agent_runs WHERE id = ?`).bind(id).first() as any
    if (!row) return { ok: false, error: 'run_not_found' }
    if (TERMINAL_STATUSES.includes(row.status as RunStatus)) {
      return { ok: false, error: 'run_terminal' }
    }
    const now = new Date().toISOString()
    // 종단 가드를 UPDATE 자체에도 넣어, SELECT와 UPDATE 사이 경쟁에서
    // 완료·취소된 실행이 다시 열리는 것을 막는다.
    const changed = await env.DB.prepare(
      `UPDATE agent_runs SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status NOT IN ('completed', 'cancelled')`
    ).bind(status, error ? String(error).slice(0, 1000) : null, now, id).run()
    if (!changed.meta || changed.meta.changes !== 1) return { ok: false, error: 'run_terminal' }
    return { ok: true }
  } catch {
    return { ok: false, error: 'db_error' }
  }
}

// ---------------------------------------------------------------------------
// 체크포인팅 — 단계 경계마다 스냅샷 저장, 마지막 완료 단계부터 재개
// ---------------------------------------------------------------------------

export async function saveCheckpoint(
  env: any,
  runId: string,
  input: { stepIndex: number; stepName: string; persona: string; state: Record<string, unknown> }
): Promise<{ ok: boolean; error?: string }> {
  const id = (runId || '').trim()
  if (!id) return { ok: false, error: 'run_id 필요' }
  if (!Number.isInteger(input.stepIndex) || input.stepIndex < 0) return { ok: false, error: 'step_index 오류' }
  const stepName = (input.stepName || '').trim()
  const persona = (input.persona || '').trim()
  if (!stepName || !persona) return { ok: false, error: 'step_name/persona 필요' }
  if (!isRecord(input.state)) return { ok: false, error: 'state는 객체 필요' }
  let stateJson: string
  try {
    stateJson = JSON.stringify(input.state)
  } catch {
    return { ok: false, error: 'state 직렬화 실패' }
  }
  if (stateJson.length > MAX_STATE_BYTES) return { ok: false, error: 'state 과다 (100KB 초과)' }
  try {
    const run = await env.DB.prepare(`SELECT total_steps, status FROM agent_runs WHERE id = ?`).bind(id).first() as any
    if (!run) return { ok: false, error: 'run_not_found' }
    if (TERMINAL_STATUSES.includes(run.status as RunStatus)) return { ok: false, error: 'run_terminal' }
    if (input.stepIndex >= run.total_steps) return { ok: false, error: 'step_out_of_range' }
    const now = new Date().toISOString()
    // 같은 단계 재저장은 교체한다 (재시도 시 오래된 스냅샷이 남지 않게).
    await env.DB.prepare(
      `INSERT OR REPLACE INTO agent_run_checkpoints (run_id, step_index, step_name, persona, state_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, input.stepIndex, stepName, persona, stateJson, now).run()
    // current_step은 "다음에 실행할 단계" — 재개 시 이 값보다 체크포인트 행이 정보다.
    await env.DB.prepare(
      `UPDATE agent_runs SET current_step = ?, updated_at = ? WHERE id = ?`
    ).bind(input.stepIndex + 1, now, id).run()
    return { ok: true }
  } catch {
    return { ok: false, error: 'db_error' }
  }
}

/** 가장 최근에 완료된 단계의 체크포인트 (없으면 null). */
export async function loadLatestCheckpoint(
  env: any,
  runId: string
): Promise<{ ok: boolean; checkpoint?: RunCheckpoint | null; error?: string }> {
  const id = (runId || '').trim()
  if (!id) return { ok: false, error: 'run_id 필요' }
  try {
    const row = await env.DB.prepare(
      `SELECT * FROM agent_run_checkpoints WHERE run_id = ? ORDER BY step_index DESC LIMIT 1`
    ).bind(id).first() as any
    if (!row) return { ok: true, checkpoint: null }
    let state: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(row.state_json || '{}')
      if (isRecord(parsed)) state = parsed
    } catch {
      state = {}
    }
    return {
      ok: true,
      checkpoint: {
        runId: row.run_id,
        stepIndex: row.step_index,
        stepName: row.step_name,
        persona: row.persona,
        state,
        createdAt: row.created_at,
      },
    }
  } catch {
    return { ok: false, error: 'db_error' }
  }
}

/**
 * 재개 정보 — 다음 단계 인덱스 + 누적 상태 + 남은 단계.
 * 완료/취소된 실행은 재개 불가. 실패·일시정지된 실행은 마지막 완료 단계
 * 다음부터 이어한다 (완료 단계는 다시 실행하지 않는다).
 */
export async function resumeRun(
  env: any,
  runId: string
): Promise<{
  ok: boolean
  run?: AgentRun
  checkpoint?: RunCheckpoint | null
  nextStepIndex?: number
  remainingSteps?: RunStep[]
  state?: Record<string, unknown>
  error?: string
}> {
  const got = await getRun(env, runId)
  if (!got.ok || !got.run) return { ok: false, error: got.error || 'run_not_found' }
  const run = got.run
  if (TERMINAL_STATUSES.includes(run.status)) return { ok: false, error: 'run_terminal' }
  const loaded = await loadLatestCheckpoint(env, runId)
  if (!loaded.ok) return { ok: false, error: loaded.error || 'db_error' }
  const checkpoint = loaded.checkpoint ?? null
  const nextStepIndex = checkpoint ? checkpoint.stepIndex + 1 : 0
  if (nextStepIndex > run.totalSteps) return { ok: false, error: 'checkpoint_out_of_range' }
  return {
    ok: true,
    run,
    checkpoint,
    nextStepIndex,
    remainingSteps: run.plan.steps.slice(nextStepIndex),
    state: checkpoint ? checkpoint.state : {},
  }
}

// ---------------------------------------------------------------------------
// 다단계 실행 드라이버 — 단계마다 체크포인트, 중단 시 paused로 남기고 재개
// ---------------------------------------------------------------------------

export type StepExecutor = (
  step: RunStep,
  stepIndex: number,
  state: Record<string, unknown>
) => Promise<unknown>

/**
 * plan을 처음부터 또는 중단 지점부터 실행한다.
 * - 각 단계 성공 직후 체크포인트를 저장한다 (다음 단계 실행 전).
 * - 단계 실패 시 run을 paused로 남기고 중단한다 — driveRun을 다시 호출하면
 *   실패한 단계부터 이어한다 (성공한 단계는 재실행하지 않는다).
 * - 모든 단계 완료 시 run을 completed로 바꾼다.
 */
export async function driveRun(
  env: any,
  runId: string,
  executeStep: StepExecutor
): Promise<{ ok: boolean; completed: boolean; nextStepIndex: number; error?: string }> {
  const resumed = await resumeRun(env, runId)
  if (!resumed.ok || !resumed.run) {
    return { ok: false, completed: false, nextStepIndex: 0, error: resumed.error || 'run_not_found' }
  }
  const run = resumed.run
  // plan 무결성: 저장된 단계 수와 total_steps가 다르면 실행하지 않는다
  // (손상된 plan으로 undefined 단계를 실행자에게 넘기는 것을 방지).
  if (!Array.isArray(run.plan.steps) || run.plan.steps.length !== run.totalSteps) {
    return { ok: false, completed: false, nextStepIndex: resumed.nextStepIndex ?? 0, error: 'plan_mismatch' }
  }
  // 일시정지·실패 상태에서 재개하면 running으로 되돌린다.
  if (run.status !== 'running') {
    const back = await updateRunStatus(env, runId, 'running')
    if (!back.ok) return { ok: false, completed: false, nextStepIndex: resumed.nextStepIndex ?? 0, error: back.error }
  }
  const total = run.totalSteps
  let nextStepIndex = resumed.nextStepIndex ?? 0
  // 누적 상태: 체크포인트의 results 배열을 이어받는다.
  let state: Record<string, unknown> = { ...(resumed.state ?? {}) }
  let results: unknown[] = Array.isArray((state as any).results) ? [...(state as any).results] : []
  for (let i = nextStepIndex; i < total; i++) {
    const step = run.plan.steps[i]
    let result: unknown
    try {
      result = await executeStep(step, i, state)
    } catch (e: any) {
      const message = e?.message || 'step_failed'
      await updateRunStatus(env, runId, 'paused', `step ${i} (${step.name}) 실패: ${message}`).catch(() => {})
      return { ok: false, completed: false, nextStepIndex: i, error: message }
    }
    results[i] = result
    state = { ...state, results }
    const saved = await saveCheckpoint(env, runId, {
      stepIndex: i,
      stepName: step.name,
      persona: step.persona,
      state,
    })
    if (!saved.ok) {
      await updateRunStatus(env, runId, 'paused', `checkpoint 저장 실패: ${saved.error}`).catch(() => {})
      return { ok: false, completed: false, nextStepIndex: i, error: saved.error }
    }
    nextStepIndex = i + 1
  }
  const done = await updateRunStatus(env, runId, 'completed')
  if (!done.ok) return { ok: false, completed: false, nextStepIndex, error: done.error }
  return { ok: true, completed: true, nextStepIndex }
}
