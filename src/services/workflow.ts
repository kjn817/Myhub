/**
 * 작은 워크플로 엔진 — n8n 패턴 참고 (통째 이식 아님, 설계만 참고)
 *
 * n8n의 핵심 개념을 MyHub 규모로 축소했다:
 * - 트리거(Trigger): 실행을 시작하는 조건 (cron / event / manual)
 * - 노드(Node): 단계별 실행 단위. 입력·출력 스키마(requires/produces)로 검증
 * - 재시도(Retry): 노드 실패 시 지수 백오프 + 최대 횟수
 * - 멱등성 키: 같은 키의 실행은 재실행하지 않고 저장된 출력을 돌려준다
 * - 실행 기록: workflow_runs / workflow_run_steps (마이그레이션 0050)
 *
 * 지속성은 best-effort다: 기록용 테이블이 없어도(0050 미적용) 실행은
 * 계속되며, 그 경우 멱등성은 각 워크플로의 1차 가드(예: reminders 선점)에
 * 의존한다. 기록 실패가 본 실행을 망가뜨리지 않는다.
 *
 * 사용처: src/services/reminder-workflow.ts (일정 알림 Cron 이식)
 */

import type { Env } from '../types'

// ---------- 타입 ----------

export type WorkflowState = Record<string, unknown>

export interface RetryPolicy {
  /** 노드당 최대 시도 횟수 (1회 시도 포함). 1이면 재시도 없음. */
  maxAttempts: number
  /** 첫 재시도 전 대기 (ms) */
  baseDelayMs: number
  /** 대기 상한 (ms) */
  maxDelayMs: number
  /** 백오프 배수 (기본 2) */
  multiplier?: number
}

export type WorkflowTrigger =
  | { type: 'cron'; cron: string }
  | { type: 'event'; event: string }
  | { type: 'manual' }

export interface WorkflowNodeContext {
  env: Env
  /** 지금까지 누적된 상태 (초기 입력 + 앞 노드들의 출력 병합) */
  state: WorkflowState
  runId: number | null
  nodeId: string
  /** 현재 시도 횟수 (1부터) */
  attempt: number
}

/**
 * 노드 실행 함수. 반환값은 상태에 병합될 부분 상태(객체) 또는 void.
 * 객체가 아닌 값을 반환하면 엔진이 실행을 실패 처리한다.
 */
export type WorkflowNodeFn = (ctx: WorkflowNodeContext) => Promise<WorkflowState | void>

export interface WorkflowNodeDef {
  id: string
  name: string
  /** 실행 전 상태에 반드시 있어야 할 키 (입력 스키마) */
  requires?: string[]
  /** 실행 후 반환값에 반드시 있어야 할 키 (출력 스키마) */
  produces?: string[]
  /** false면 이 노드를 건너뛴다 (n8n의 IF 분기 대신 — 예: 미선점 시 발송 생략) */
  when?: (state: WorkflowState) => boolean
  /** true면 재시도를 다 써도 실패로 중단하지 않고 다음 노드로 진행한다
   *  (n8n의 "Continue On Fail"). 에러는 `<nodeId>Error` 키로 상태에 남는다. */
  continueOnError?: boolean
  /** 워크플로 기본 재시도 정책을 덮어쓴다 */
  retry?: RetryPolicy
  run: WorkflowNodeFn
}

export interface WorkflowDefinition {
  id: string
  name: string
  version: number
  trigger: WorkflowTrigger
  /** 기본 재시도 정책 (노드별 override 가능). 생략 시 재시도 없음. */
  retry?: RetryPolicy
  nodes: WorkflowNodeDef[]
}

export type WorkflowRunStatus = 'completed' | 'failed' | 'duplicate'

export interface WorkflowRunResult {
  runId: number | null
  workflowId: string
  status: WorkflowRunStatus
  /** 최종 누적 상태 */
  output: WorkflowState
  /** 모든 노드의 시도 횟수 합계 */
  attempts: number
  error?: string
  durationMs: number
}

export interface RunWorkflowOptions {
  env: Env
  /** 초기 상태 */
  input?: WorkflowState
  /** 멱등성 키. 같은 키의 완료/실패 실행은 재실행하지 않는다. */
  idempotencyKey?: string
  /** 기록용 DB. 생략 시 env.DB를 쓴다. null이면 기록 없이 실행만 한다. */
  db?: D1Database | null
  /** 테스트용 sleep 주입 (기본: setTimeout) */
  sleep?: (ms: number) => Promise<void>
  /** 테스트용 시간 주입 (기본: Date.now) */
  now?: () => number
}

// ---------- 상수 ----------

/** 'running'으로 남은 실행을 중단된 것으로 보고 재실행을 허용하는 경과 시간 */
export const STALE_RUNNING_MS = 15 * 60 * 1000

const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 }

const MAX_STORED_JSON_CHARS = 4000

// ---------- 유틸 ----------

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 지수 백오프 대기 시간 (ms). attempt는 방금 실패한 시도 번호 (1부터). */
export function computeBackoffMs(policy: RetryPolicy, attempt: number): number {
  const multiplier = policy.multiplier ?? 2
  const delay = policy.baseDelayMs * Math.pow(multiplier, attempt - 1)
  return Math.min(Math.max(delay, 0), policy.maxDelayMs)
}

/** 절단된 JSON 저장 시 표시하는 마커 키. parseJson으로 읽으면 이 키가 보인다. */
export const TRUNCATED_JSON_MARKER = '__truncated'

function truncateJson(value: unknown): string | null {
  try {
    const s = JSON.stringify(value ?? null)
    if (s === undefined) return null
    if (s.length <= MAX_STORED_JSON_CHARS) return s
    // 잘린 JSON을 그대로 저장하면 JSON.parse가 실패해 호출자(parseJson)가
    // 원래 출력을 {}로 오인한다 (조용한 데이터 손실). 절단 사실을 명시한
    // 유효 JSON으로 저장해 손실을 드러낸다.
    let preview = s.slice(0, MAX_STORED_JSON_CHARS)
    let out = JSON.stringify({ [TRUNCATED_JSON_MARKER]: true, preview })
    while (out.length > MAX_STORED_JSON_CHARS && preview.length > 0) {
      preview = preview.slice(0, Math.floor(preview.length / 2))
      out = JSON.stringify({ [TRUNCATED_JSON_MARKER]: true, preview })
    }
    return out
  } catch {
    return null
  }
}

function parseJson(text: string | null | undefined): WorkflowState {
  if (!text) return {}
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as WorkflowState) : {}
  } catch {
    return {}
  }
}

function validateDefinition(def: WorkflowDefinition): void {
  if (!def.id) throw new Error('workflow_definition_invalid: id 없음')
  if (!def.nodes || def.nodes.length === 0) {
    throw new Error('workflow_definition_invalid: nodes 비어 있음')
  }
  const seen = new Set<string>()
  for (const n of def.nodes) {
    if (!n.id) throw new Error('workflow_definition_invalid: node id 없음')
    if (seen.has(n.id)) throw new Error(`workflow_definition_invalid: node id 중복: ${n.id}`)
    seen.add(n.id)
    if (typeof n.run !== 'function') throw new Error(`workflow_definition_invalid: node ${n.id} run 없음`)
  }
  if (def.trigger.type === 'cron' && !def.trigger.cron) {
    throw new Error('workflow_definition_invalid: cron 트리거에 cron식 없음')
  }
  if (def.trigger.type === 'event' && !def.trigger.event) {
    throw new Error('workflow_definition_invalid: event 트리거에 event 없음')
  }
}

// ---------- 실행 기록 (best-effort: 실패해도 본 실행은 계속) ----------

interface ExistingRun {
  id: number
  status: string
  output_json: string | null
}

async function findRunByKey(
  db: D1Database, key: string
): Promise<ExistingRun | null> {
  const row = await db
    .prepare('SELECT id, status, output_json FROM workflow_runs WHERE idempotency_key = ?')
    .bind(key)
    .first<ExistingRun>()
  return row ?? null
}

/**
 * 실행 선점. 반환: { duplicate: true }면 재실행하지 말 것.
 * - 행 없음 → INSERT 후 { runId } 반환
 * - 완료/실패 행 있음 → duplicate (저장된 출력 반환)
 * - running 행 있음 → 15분 경과 시 stale로 보고 재실행 허용, 아니면 duplicate
 */
async function claimRun(
  db: D1Database, def: WorkflowDefinition, key: string, input: WorkflowState
): Promise<{ runId: number | null; duplicate: boolean; output?: WorkflowState; status?: string }> {
  const existing = await findRunByKey(db, key)
  if (existing) {
    if (existing.status === 'running') {
      // stale 판정은 SQL에서 수행 (JS 날짜 파싱의 타임존 함정 회피).
      // STALE_RUNNING_MS와 같은 값이어야 한다.
      const upd = await db
        .prepare(
          `UPDATE workflow_runs SET started_at = datetime('now'), attempts = 0
           WHERE id = ? AND datetime(started_at, '+${STALE_RUNNING_MS / 60000} minutes') < datetime('now')`
        )
        .bind(existing.id)
        .run()
      if ((upd.meta?.changes ?? 0) > 0) {
        return { runId: existing.id, duplicate: false }
      }
      return { runId: existing.id, duplicate: true, output: {}, status: 'running' }
    }
    return {
      runId: existing.id,
      duplicate: true,
      output: parseJson(existing.output_json),
      status: existing.status,
    }
  }
  const ins = await db
    .prepare(
      `INSERT OR IGNORE INTO workflow_runs
         (workflow_id, idempotency_key, trigger_type, status, input_json)
       VALUES (?, ?, ?, 'running', ?)`
    )
    .bind(def.id, key, def.trigger.type, truncateJson(input))
    .run()
  if ((ins.meta?.changes ?? 0) > 0) {
    return { runId: Number(ins.meta?.last_row_id ?? 0) || null, duplicate: false }
  }
  // 경합으로 다른 실행이 먼저 선점함 → 다시 조회해 duplicate로 처리
  const raced = await findRunByKey(db, key)
  if (raced) {
    return {
      runId: raced.id,
      duplicate: true,
      output: parseJson(raced.output_json),
      status: raced.status,
    }
  }
  return { runId: null, duplicate: false }
}

async function finishRun(
  db: D1Database, runId: number, status: 'completed' | 'failed',
  output: WorkflowState, error: string | undefined, attempts: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE workflow_runs
       SET status = ?, output_json = ?, error = ?, attempts = ?, finished_at = datetime('now')
       WHERE id = ?`
    )
    .bind(status, truncateJson(output), error ?? null, attempts, runId)
    .run()
}

async function recordStep(
  db: D1Database, runId: number, nodeId: string, status: 'completed' | 'failed' | 'skipped',
  attempt: number, input: WorkflowState, output: WorkflowState | null, error: string | undefined
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO workflow_run_steps
         (run_id, node_id, status, attempt, input_json, output_json, error, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .bind(runId, nodeId, status, attempt, truncateJson(input), truncateJson(output), error ?? null)
    .run()
}

// ---------- 노드 실행 ----------

function checkRequires(node: WorkflowNodeDef, state: WorkflowState): string | null {
  for (const k of node.requires ?? []) {
    if (state[k] === undefined) return `node ${node.id}: 입력 누락: ${k}`
  }
  return null
}

function checkProduces(node: WorkflowNodeDef, out: WorkflowState): string | null {
  for (const k of node.produces ?? []) {
    if (out[k] === undefined) return `node ${node.id}: 출력 누락: ${k}`
  }
  return null
}

interface NodeOutcome {
  output: WorkflowState
  attempts: number
  error?: string
}

async function runNodeWithRetry(
  node: WorkflowNodeDef, ctx: WorkflowNodeContext, policy: RetryPolicy,
  sleep: (ms: number) => Promise<void>
): Promise<NodeOutcome> {
  const maxAttempts = Math.max(1, Math.floor(policy.maxAttempts))
  let lastError = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // 상태 스냅샷을 넘긴다: 노드가 상태를 직접 바꿔도 누적 상태가 오염되지 않는다
      const out = await node.run({ ...ctx, state: { ...ctx.state }, attempt })
      if (out === undefined || out === null) return { output: {}, attempts: attempt }
      if (typeof out !== 'object' || Array.isArray(out)) {
        throw new Error(`node ${node.id}: 출력이 객체가 아님`)
      }
      const missing = checkProduces(node, out as WorkflowState)
      if (missing) throw new Error(missing)
      return { output: out as WorkflowState, attempts: attempt }
    } catch (e) {
      lastError = (e as Error)?.message || String(e)
      if (attempt < maxAttempts) {
        await sleep(computeBackoffMs(policy, attempt))
      }
    }
  }
  return { output: {}, attempts: maxAttempts, error: lastError }
}

// ---------- 메인 ----------

/**
 * 워크플로 실행. 노드를 순서대로 실행하며 상태를 누적한다.
 * - `when`이 false인 노드는 건너뛴다 (스킵 기록 남김)
 * - 노드 실패 시 정책만큼 재시도한다. 다 써도 실패면 중단한다
 *   (단, continueOnError 노드는 에러를 상태에 남기고 계속 진행)
 * - idempotencyKey가 가리키는 완료/실패 실행이 있으면 노드를 실행하지 않고
 *   저장된 출력을 돌려준다 (status 'duplicate')
 */
export async function runWorkflow(
  def: WorkflowDefinition, opts: RunWorkflowOptions
): Promise<WorkflowRunResult> {
  validateDefinition(def)
  const startedAt = (opts.now ?? Date.now)()
  const sleep = opts.sleep ?? defaultSleep
  const db = opts.db === undefined ? (opts.env.DB ?? null) : opts.db
  const input: WorkflowState = { ...(opts.input ?? {}) }
  const state: WorkflowState = { ...input }

  const finish = (status: WorkflowRunStatus, output: WorkflowState, attempts: number, error?: string): WorkflowRunResult => ({
    runId: null,
    workflowId: def.id,
    status,
    output,
    attempts,
    error,
    durationMs: (opts.now ?? Date.now)() - startedAt,
  })

  // --- 실행 선점 + 기록 행 확보 (best-effort) ---
  // 키가 없으면 자동 키를 만든다: 모든 실행이 기록되도록 한다 (n8n의 execution
  // 로그처럼). 자동 키는 유일하므로 duplicate가 되지 않는다.
  let runId: number | null = null
  if (db) {
    const key =
      opts.idempotencyKey ??
      `${def.id}:${(opts.now ?? Date.now)()}:${Math.random().toString(36).slice(2, 10)}`
    try {
      const claim = await claimRun(db, def, key, input)
      runId = claim.runId
      if (claim.duplicate) {
        return {
          ...finish('duplicate', claim.output ?? {}, 0),
          runId,
        }
      }
    } catch {
      runId = null // 기록 테이블 없음 등 — 실행은 계속
    }
  }

  const persistStep = async (
    nodeId: string, status: 'completed' | 'failed' | 'skipped',
    attempt: number, nodeInput: WorkflowState, output: WorkflowState | null, error?: string
  ): Promise<void> => {
    if (!db || runId === null) return
    try {
      await recordStep(db, runId, nodeId, status, attempt, nodeInput, output, error)
    } catch {
      // 기록 실패는 무시
    }
  }

  let totalAttempts = 0
  let failedNodeError: string | undefined

  for (const node of def.nodes) {
    const nodeInput: WorkflowState = { ...state }
    let shouldRun = true
    try {
      shouldRun = node.when ? node.when(state) : true
    } catch (e) {
      // when 조건 자체의 오류는 노드 실패로 처리 (틱 전체가 죽지 않는다)
      failedNodeError = `node ${node.id}: when 조건 오류: ${(e as Error)?.message || String(e)}`
      await persistStep(node.id, 'failed', 0, nodeInput, null, failedNodeError)
      break
    }
    if (!shouldRun) {
      await persistStep(node.id, 'skipped', 0, nodeInput, null)
      continue
    }
    const missing = checkRequires(node, state)
    if (missing) {
      failedNodeError = missing
      await persistStep(node.id, 'failed', 0, nodeInput, null, missing)
      break
    }
    const policy = node.retry ?? def.retry ?? DEFAULT_RETRY
    const outcome = await runNodeWithRetry(
      node,
      { env: opts.env, state, runId, nodeId: node.id, attempt: 1 },
      policy,
      sleep
    )
    totalAttempts += outcome.attempts
    if (outcome.error !== undefined) {
      await persistStep(node.id, 'failed', outcome.attempts, nodeInput, null, outcome.error)
      if (node.continueOnError) {
        state[`${node.id}Error`] = outcome.error
        continue
      }
      failedNodeError = outcome.error
      break
    }
    Object.assign(state, outcome.output)
    await persistStep(node.id, 'completed', outcome.attempts, nodeInput, outcome.output)
  }

  const status: WorkflowRunStatus = failedNodeError === undefined ? 'completed' : 'failed'
  if (db && runId !== null) {
    try {
      await finishRun(db, runId, status, state, failedNodeError, totalAttempts)
    } catch {
      // 기록 실패는 무시
    }
  }
  const result = finish(status, state, totalAttempts, failedNodeError)
  result.runId = runId
  return result
}
