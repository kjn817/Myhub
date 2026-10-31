/**
 * 테스트용 쓰기 도구 — Phase 1E-R
 *
 * 원자적 D1 쓰기:
 * - operation INSERT + todo INSERT + 상태 UPDATE를 단일 batch로
 * - UNIQUE 제약으로 동시성 방어 (TOCTOU 없음)
 */

import { z } from 'zod'
import type { ToolDefinition } from '../types'
import { WriteExecutionGuard, type WriteApproval } from './write-guard'

export const TestTodoAddInputSchema = z.object({
  title: z.string().min(1).max(200),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
}).strict()

export const TestTodoAddDefinition: ToolDefinition = {
  name: 'test_todo_add',
  description: '테스트용 할 일 생성 (Phase 1E)',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '할 일 제목' },
      dueDate: { type: 'string', description: '마감일 (YYYY-MM-DD)' },
      dueTime: { type: 'string', description: '마감 시간 (HH:MM)' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  mode: 'write',
  requiredPermission: 'todo.write',
}

export type TestTodoAddEnv = {
  DB: D1Database
}

/**
 * 원자적 쓰기 실행.
 *
 * D1 batch로 다음을 원자적으로 처리:
 * 1. operation INSERT (UNIQUE로 소유권 확보)
 * 2. todo INSERT
 * 3. operation UPDATE (succeeded + result_ref)
 *
 * 중간 실패 시 전체 롤백.
 */
export async function executeTestTodoAdd(
  args: unknown,
  ctx: { userId: string; requestId: string },
  env: TestTodoAddEnv,
  approval: WriteApproval | null,
  guard: WriteExecutionGuard
): Promise<{ ok: boolean; data?: unknown; errorCode?: string; message?: string }> {
  // 1. Zod 검증
  const parsed = TestTodoAddInputSchema.safeParse(args)
  if (!parsed.success) {
    return { ok: false, errorCode: 'INVALID_ARGUMENTS', message: 'Invalid arguments' }
  }

  // 2. Write Guard 검사 (승인, 인자 해시)
  const call = { id: 'test', name: 'test_todo_add', args: parsed.data, provider: 'test' as const }
  const check = await guard.checkBeforeExecute(call as any, ctx as any, approval)

  if (!check.allowed) {
    if (check.errorCode === 'ALREADY_SUCCEEDED') {
      const existing = await guard.getOperation(ctx.userId, approval!.operationId)
      // 기존 데이터 조회 (사용자 범위 확인)
      const todoId = existing?.resultRef?.replace('todo:', '')
      return { ok: true, data: { resultRef: existing?.resultRef, todoId, deduplicated: true } }
    }
    return { ok: false, errorCode: check.errorCode, message: check.message }
  }

  const { operationId, argsHash } = check
  const dueAt = parsed.data.dueDate
    ? parsed.data.dueTime
      ? `${parsed.data.dueDate}T${parsed.data.dueTime}`
      : parsed.data.dueDate
    : null

  // 3. 원자적 batch 실행
  // 순서: operation INSERT → todo INSERT → operation UPDATE
  // last_insert_rowid()는 todo INSERT의 ID를 가리킴
  try {
    const stmts = [
      env.DB.prepare(
        `INSERT INTO ai_tool_operations (user_id, operation_id, request_id, tool_name, args_hash, status)
         VALUES (?, ?, ?, ?, ?, 'in_progress')`
      ).bind(ctx.userId, operationId, ctx.requestId, 'test_todo_add', argsHash),

      env.DB.prepare(
        'INSERT INTO todos (title, due_at, status) VALUES (?, ?, ?)'
      ).bind(parsed.data.title, dueAt, 'pending'),

      env.DB.prepare(
        `UPDATE ai_tool_operations
         SET status = 'succeeded', result_ref = 'todo:' || last_insert_rowid(), updated_at = datetime('now')
         WHERE user_id = ? AND operation_id = ?`
      ).bind(ctx.userId, operationId),
    ]

    const results = await env.DB.batch(stmts as any)
    const todoId = results[1]?.meta?.last_row_id

    if (!todoId) {
      return { ok: false, errorCode: 'DB_ERROR', message: 'Failed to create todo' }
    }

    return { ok: true, data: { id: todoId, title: parsed.data.title, resultRef: `todo:${todoId}` } }
  } catch (e: any) {
    const msg = String(e?.message || '')

    // UNIQUE 제약 위반 → 이미 존재하는 operation
    if (msg.includes('UNIQUE') || msg.includes('unique')) {
      const existing = await guard.getOperation(ctx.userId, operationId)
      if (!existing) {
        return { ok: false, errorCode: 'DB_ERROR', message: 'Operation state unknown' }
      }
      if (existing.argsHash !== argsHash) {
        return { ok: false, errorCode: 'IDEMPOTENCY_CONFLICT', message: 'Different args for same operation' }
      }
      if (existing.status === 'succeeded') {
        const todoId = existing.resultRef?.replace('todo:', '')
        return { ok: true, data: { resultRef: existing.resultRef, todoId, deduplicated: true } }
      }
      if (existing.status === 'in_progress') {
        return { ok: false, errorCode: 'ALREADY_IN_PROGRESS', message: 'Operation in progress' }
      }
      if (existing.status === 'unknown') {
        return { ok: false, errorCode: 'OPERATION_UNKNOWN', message: 'Operation status unknown, manual check required' }
      }
      // pending, failed → 재시도 가능 (다음 호출에서 다시 시도)
      return { ok: false, errorCode: 'RETRY_ALLOWED', message: 'Operation can be retried' }
    }

    return { ok: false, errorCode: 'DB_ERROR', message: 'Database error' }
  }
}
