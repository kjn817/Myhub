/**
 * MCP Tasks 확장 POC — `io.modelcontextprotocol/tasks` (2026-07-28, SEP-2663).
 *
 * 배경: SDK 2.4.0은 Tasks 확장의 런타임이 없다.
 * - 코어 스키마(Task·CreateTaskResult·tasks/get 등)는 2025-11-25 wire
 *   어휘로만 남아 있고("no SDK runtime"), typed 메서드 표면에는 없다.
 * - 모던(2026-07-28) 코덱은 `execution.taskSupport`·`capabilities.tasks`를
 *   삭제 필드로 강제한다 — 2026 Tasks는 코어가 아니라 확장이다.
 * - 그래서 확장 메서드(tasks/get·update·cancel)는 이 파일이 직접
 *   JSON-RPC로 답한다. tools/call의 태스크 반환만 SDK를 통한다
 *   (핸들러가 resultType:'task'인 flat 객체를 돌려주면 SDK가 그대로
 *   내보낸다 — 스크래치 프로브로 실측).
 *
 * 범위 (POC — 운영 도입 전제 조건은 docs/mcp-sdk-conformance-20261028.md):
 * - 도구 1개(briefing.generate)만 태스크를 반환한다.
 * - input_required 상태는 없다 — 브리핑은 추가 입력이 필요 없는 읽기
 *   작업이라 tasks/update는 항상 -32602이다.
 * - 완료는 첫 tasks/get 폴링 시점에 계산한다 (지연 완료). Stateless
 *   Worker에는 백그라운드 실행이 없어서, 실제 비동기는 Queue/Cron을
 *   붙여야 한다. wire 계약(핸들 → 폴링 → 완료 결과)이 POC의 검증 대상이다.
 * - notifications/tasks는 보내지 않는다 (스펙상 선택 사항).
 *
 * 보안 경계:
 * - 태스크는 이메일별로 소유한다 — 남의 taskId로는 조회·취소 불가.
 * - 브리핑 내용은 buildTodayBriefing과 같은 필터(잠금·민감도·동의)를 탄다.
 *   태스크 결과에도 잠긴 메모는 들어가지 않는다.
 * - 태스크 행은 D1에 둔다 (핸들 반환 전 durable 저장 — 스펙 요구).
 */

import { buildTodayBriefing } from '../briefing/service'

export const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks'

/** 태스크 TTL (10분). 만료된 태스크는 tasks/*에서 not found로 답한다. */
export const TASKS_TTL_MS = 600_000
/** 클라이언트에 권하는 폴링 간격 (ms). */
export const TASKS_POLL_INTERVAL_MS = 500

/** server.ts의 McpServer({ name: 'myhub', version: '0.1.0' })와 같은 값. */
const SERVER_INFO = { name: 'myhub', version: '0.1.0' }

export type McpTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled'

export interface McpTaskRow {
  task_id: string
  email: string
  tool: string
  status: McpTaskStatus
  params_json: string
  result_json: string | null
  error_json: string | null
  status_message: string | null
  ttl_ms: number
  poll_interval_ms: number
  created_at: string
  updated_at: string
}

/** tools/call 핸들러가 SDK에 그대로 돌려주는 태스크 핸들 (flat CreateTaskResult). */
export interface TaskHandle {
  resultType: 'task'
  taskId: string
  status: McpTaskStatus
  statusMessage?: string
  createdAt: string
  lastUpdatedAt: string
  ttlMs: number | null
  pollIntervalMs?: number
}

export interface JsonRpcError {
  code: number
  message: string
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: Record<string, unknown>
  error?: JsonRpcError
}

function serverMeta(): Record<string, unknown> {
  return { 'io.modelcontextprotocol/serverInfo': SERVER_INFO }
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * 클라이언트가 이 요청의 _meta 봉투에서 Tasks 확장을 선언했는가.
 * envelope이 없으면(레거시 era) false — 태스크를 반환하지 않고 동기 결과를 낸다
 * (스펙 규칙: 확장을 선언하지 않은 클라이언트에는 태스크를 반환하지 말 것).
 */
export function clientDeclaresTasksExtension(envelope: unknown): boolean {
  if (!envelope || typeof envelope !== 'object') return false
  const caps = (envelope as Record<string, unknown>)['io.modelcontextprotocol/clientCapabilities']
  if (!caps || typeof caps !== 'object') return false
  const ext = (caps as Record<string, unknown>).extensions
  if (!ext || typeof ext !== 'object') return false
  return TASKS_EXTENSION_ID in (ext as Record<string, unknown>)
}

/**
 * 태스크를 만들고 핸들을 돌려준다. 행을 먼저 저장한 뒤 핸들을 반환한다
 * (스펙: 태스크는 응답 전에 durable하게 저장되어야 한다).
 */
export async function createTask(
  db: D1Database,
  email: string,
  tool: string,
  params: Record<string, unknown>,
): Promise<TaskHandle> {
  const taskId = `task-${crypto.randomUUID()}`
  const now = nowIso()
  await db
    .prepare(
      `INSERT INTO mcp_tasks
         (task_id, email, tool, status, params_json, result_json, error_json,
          status_message, ttl_ms, poll_interval_ms, created_at, updated_at)
       VALUES (?, ?, ?, 'working', ?, NULL, NULL, NULL, ?, ?, ?, ?)`,
    )
    .bind(taskId, email, tool, JSON.stringify(params), TASKS_TTL_MS, TASKS_POLL_INTERVAL_MS, now, now)
    .run()
  return {
    resultType: 'task',
    taskId,
    status: 'working',
    createdAt: now,
    lastUpdatedAt: now,
    ttlMs: TASKS_TTL_MS,
    pollIntervalMs: TASKS_POLL_INTERVAL_MS,
  }
}

function rowToTaskFields(row: McpTaskRow): Record<string, unknown> {
  return {
    taskId: row.task_id,
    status: row.status,
    ...(row.status_message ? { statusMessage: row.status_message } : {}),
    createdAt: row.created_at,
    lastUpdatedAt: row.updated_at,
    ttlMs: row.ttl_ms,
    pollIntervalMs: row.poll_interval_ms,
  }
}

/** 이메일 소유권이 있는 태스크 행 1건 (없으면 null). */
export async function getTaskRow(
  db: D1Database,
  email: string,
  taskId: string,
): Promise<McpTaskRow | null> {
  const row = await db
    .prepare('SELECT * FROM mcp_tasks WHERE task_id = ? AND email = ?')
    .bind(taskId, email)
    .first<McpTaskRow>()
  return row ?? null
}

function isExpired(row: McpTaskRow): boolean {
  return Date.now() - Date.parse(row.created_at) > row.ttl_ms
}

async function deleteTask(db: D1Database, taskId: string): Promise<void> {
  await db.prepare('DELETE FROM mcp_tasks WHERE task_id = ?').bind(taskId).run()
}

/** 태스크의 최종 결과(CallToolResult 모양)를 만든다. */
function briefingCallResult(briefing: Awaited<ReturnType<typeof buildTodayBriefing>>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(briefing) }],
    structuredContent: briefing,
  }
}

/**
 * working 태스크를 완료로 전이한다 (지연 완료 — 첫 폴링 시점에 계산).
 * 상태 전이는 `WHERE status='working'` 조건부 UPDATE로 원자화한다:
 * 동시 폴링이 와도 한쪽만 완료시키고, 다른 쪽은 다시 읽어 완료된 행을 본다.
 */
async function completeBriefingTask(db: D1Database, row: McpTaskRow): Promise<McpTaskRow> {
  const params = JSON.parse(row.params_json || '{}') as { date?: string }
  const now = nowIso()
  try {
    const briefing = await buildTodayBriefing(db, params.date)
    const resultJson = JSON.stringify(briefingCallResult(briefing))
    const changed = await db
      .prepare(
        `UPDATE mcp_tasks
         SET status = 'completed', result_json = ?, updated_at = ?
         WHERE task_id = ? AND status = 'working'`,
      )
      .bind(resultJson, now, row.task_id)
      .run()
    if ((changed as unknown as { meta?: { changes?: number } }).meta?.changes === 0) {
      // 다른 폴링이 먼저 완료시켰다 — 최신 행을 다시 읽는다.
      const fresh = await getTaskRow(db, row.email, row.task_id)
      return fresh ?? { ...row, status: 'completed', result_json: resultJson, updated_at: now }
    }
    return { ...row, status: 'completed', result_json: resultJson, updated_at: now }
  } catch {
    const errorJson = JSON.stringify({ code: -32603, message: '브리핑 생성 실패' })
    await db
      .prepare(
        `UPDATE mcp_tasks
         SET status = 'failed', error_json = ?, updated_at = ?
         WHERE task_id = ? AND status = 'working'`,
      )
      .bind(errorJson, now, row.task_id)
      .run()
    return { ...row, status: 'failed', error_json: errorJson, updated_at: now }
  }
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function rpcResult(id: string | number | null, result: Record<string, unknown>): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: { ...result, _meta: serverMeta() } }
}

/** tasks/get — DetailedTask를 resultType:'complete'로 답한다. */
async function handleTasksGet(
  db: D1Database,
  email: string,
  params: Record<string, unknown>,
  id: string | number | null,
): Promise<JsonRpcResponse> {
  const taskId = params.taskId
  if (typeof taskId !== 'string' || !taskId) {
    return rpcError(id, -32602, 'taskId is required')
  }
  let row = await getTaskRow(db, email, taskId)
  if (!row) return rpcError(id, -32602, 'task not found')
  if (isExpired(row)) {
    await deleteTask(db, taskId)
    return rpcError(id, -32602, 'task expired')
  }
  if (row.status === 'working') {
    // 브리핑 태스크만 있다 (input_required 없음) — 첫 폴링에 완료시킨다.
    row = await completeBriefingTask(db, row)
  }
  const task = rowToTaskFields(row)
  if (row.status === 'completed' && row.result_json) {
    task.result = JSON.parse(row.result_json)
  }
  if (row.status === 'failed' && row.error_json) {
    task.error = JSON.parse(row.error_json)
  }
  return rpcResult(id, { resultType: 'complete', ...task })
}

/** tasks/update — POC에는 input_required 태스크가 없어 항상 -32602이다. */
async function handleTasksUpdate(
  db: D1Database,
  email: string,
  params: Record<string, unknown>,
  id: string | number | null,
): Promise<JsonRpcResponse> {
  const taskId = params.taskId
  if (typeof taskId !== 'string' || !taskId) {
    return rpcError(id, -32602, 'taskId is required')
  }
  const row = await getTaskRow(db, email, taskId)
  if (!row) return rpcError(id, -32602, 'task not found')
  if (isExpired(row)) {
    await deleteTask(db, taskId)
    return rpcError(id, -32602, 'task expired')
  }
  // input_required 상태가 존재하지 않으므로 답할 입력 요청이 없다.
  return rpcError(id, -32602, 'task is not awaiting input')
}

/** tasks/cancel — 협력적 취소. 이미 종료된 태스크도 빈 ack로 답한다. */
async function handleTasksCancel(
  db: D1Database,
  email: string,
  params: Record<string, unknown>,
  id: string | number | null,
): Promise<JsonRpcResponse> {
  const taskId = params.taskId
  if (typeof taskId !== 'string' || !taskId) {
    return rpcError(id, -32602, 'taskId is required')
  }
  const row = await getTaskRow(db, email, taskId)
  if (!row) return rpcError(id, -32602, 'task not found')
  if (isExpired(row)) {
    await deleteTask(db, taskId)
    return rpcError(id, -32602, 'task expired')
  }
  if (row.status === 'working') {
    await db
      .prepare(
        `UPDATE mcp_tasks
         SET status = 'cancelled', status_message = 'cancelled by client', updated_at = ?
         WHERE task_id = ? AND status = 'working'`,
      )
      .bind(nowIso(), taskId)
      .run()
  }
  return rpcResult(id, { resultType: 'complete' })
}

/**
 * 확장 메서드 디스패처 (routes.ts에서 가로채기 전에 SDK로 넘기지 않는다).
 * method가 tasks/*가 아니면 null을 돌려준다 (호출자가 SDK로 넘긴다).
 */
export async function handleTasksRequest(
  db: D1Database,
  email: string,
  method: string,
  params: Record<string, unknown>,
  id: string | number | null,
): Promise<JsonRpcResponse | null> {
  switch (method) {
    case 'tasks/get':
      return handleTasksGet(db, email, params, id)
    case 'tasks/update':
      return handleTasksUpdate(db, email, params, id)
    case 'tasks/cancel':
      return handleTasksCancel(db, email, params, id)
    default:
      return null
  }
}

/**
 * 가로채기 게이트 — 이 요청을 SDK 핸들러가 아니라 확장 디스패처가
 * 맡아도 되는가. SDK 분류기(프로브 실측)와 같은 조건을 쓴다:
 * MCP-Protocol-Version 헤더·Mcp-Method 헤더·Mcp-Name 헤더(= taskId)·
 * 본문 _meta 봉투의 protocolVersion이 모두 2026-07-28·일치해야 한다.
 * 하나라도 어긋나면 false — 그 요청은 SDK로 넘겨 SDK 자신의
 * -32020/-32602 오류를 그대로 받게 한다 (검증 래더를 직접 재구현하지 않는다).
 */
export function isWellFormedTasksRequest(
  method: string,
  headers: { get(name: string): string | null },
  body: unknown,
): boolean {
  if (method !== 'tasks/get' && method !== 'tasks/update' && method !== 'tasks/cancel') {
    return false
  }
  if (!body || typeof body !== 'object') return false
  const params = (body as Record<string, unknown>).params
  if (!params || typeof params !== 'object') return false
  const taskId = (params as Record<string, unknown>).taskId
  if (typeof taskId !== 'string' || !taskId) return false
  const meta = (params as Record<string, unknown>)._meta
  if (!meta || typeof meta !== 'object') return false
  if ((meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28') {
    return false
  }
  if (headers.get('MCP-Protocol-Version') !== '2026-07-28') return false
  if (headers.get('Mcp-Method') !== method) return false
  if (headers.get('Mcp-Name') !== taskId) return false
  return true
}
