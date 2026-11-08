/// <reference types="jest" />
import {
  TestTodoAddInputSchema,
  TestTodoAddDefinition,
  executeTestTodoAdd,
} from '../../src/ai/tools/test-todo-add'
import {
  WriteExecutionGuard,
  createTestApproval,
  type WriteApproval,
} from '../../src/ai/tools/write-guard'

// ---------------------------------------------------------------------------
// Mock D1Database with batch support
// ---------------------------------------------------------------------------

function makeBatchDb(opts: {
  batchResults?: Array<{ meta?: { last_row_id?: number } }>
  batchThrows?: Error
  operation?: Record<string, unknown> | null
} = {}): { DB: D1Database } {
  const DB = {
    prepare: () => ({
      bind: (..._args: unknown[]) => ({
        first: async () => opts.operation ?? null,
        run: async () => ({ meta: { changes: 1 } }),
      }),
    }),
    batch: async () => {
      if (opts.batchThrows) throw opts.batchThrows
      return opts.batchResults ?? [{}, { meta: { last_row_id: 42 } }, {}]
    },
  } as unknown as D1Database
  return { DB }
}

function makeGuard(): WriteExecutionGuard {
  const { DB } = makeBatchDb()
  return new WriteExecutionGuard({ db: DB })
}

const CTX = { userId: 'u1', requestId: 'req-1' }

async function approvalFor(args: unknown, op = 'op-1'): Promise<WriteApproval> {
  return createTestApproval('u1', op, 'test_todo_add', args)
}

function okGuard(approval: WriteApproval): WriteExecutionGuard {
  const guard = makeGuard()
  // Stub checkBeforeExecute to the "allowed" path
  jest.spyOn(guard, 'checkBeforeExecute').mockResolvedValue({
    allowed: true,
    operationId: approval.operationId,
    argsHash: approval.argsHash,
  })
  return guard
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe('TestTodoAddInputSchema', () => {
  test('accepts title only', () => {
    expect(TestTodoAddInputSchema.safeParse({ title: 'buy milk' }).success).toBe(true)
  })

  test('accepts title with dueDate and dueTime', () => {
    const p = TestTodoAddInputSchema.safeParse({
      title: 't',
      dueDate: '2026-10-18',
      dueTime: '15:30',
    })
    expect(p.success).toBe(true)
  })

  test('rejects empty title', () => {
    expect(TestTodoAddInputSchema.safeParse({ title: '' }).success).toBe(false)
  })

  test('rejects title over 200 chars', () => {
    expect(TestTodoAddInputSchema.safeParse({ title: 'x'.repeat(201) }).success).toBe(false)
  })

  test('rejects bad dueDate format', () => {
    expect(TestTodoAddInputSchema.safeParse({ title: 't', dueDate: '10/18/2026' }).success).toBe(false)
  })

  test('rejects bad dueTime format', () => {
    expect(TestTodoAddInputSchema.safeParse({ title: 't', dueTime: '3pm' }).success).toBe(false)
  })

  test('rejects strict extra fields', () => {
    expect(TestTodoAddInputSchema.safeParse({ title: 't', foo: 1 }).success).toBe(false)
  })
})

describe('TestTodoAddDefinition', () => {
  test('has correct name, mode, permission', () => {
    expect(TestTodoAddDefinition.name).toBe('test_todo_add')
    expect(TestTodoAddDefinition.mode).toBe('write')
    expect(TestTodoAddDefinition.requiredPermission).toBe('todo.write')
  })

  test('parameters require title', () => {
    const params = TestTodoAddDefinition.parameters as any
    expect(params.required).toContain('title')
    expect(params.additionalProperties).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// executeTestTodoAdd
// ---------------------------------------------------------------------------

describe('executeTestTodoAdd', () => {
  test('returns INVALID_ARGUMENTS for bad args', async () => {
    const { DB } = makeBatchDb()
    const guard = makeGuard()
    const result = await executeTestTodoAdd({ title: '' }, CTX, { DB }, null, guard)
    expect(result).toEqual({ ok: false, errorCode: 'INVALID_ARGUMENTS', message: 'Invalid arguments' })
  })

  test('propagates guard rejection (approval required)', async () => {
    const { DB } = makeBatchDb()
    const guard = makeGuard()
    jest.spyOn(guard, 'checkBeforeExecute').mockResolvedValue({
      allowed: false,
      errorCode: 'APPROVAL_REQUIRED',
      message: 'Write approval required',
    })
    const result = await executeTestTodoAdd({ title: 't' }, CTX, { DB }, null, guard)
    expect(result).toEqual({ ok: false, errorCode: 'APPROVAL_REQUIRED', message: 'Write approval required' })
  })

  test('deduplicates when guard reports ALREADY_SUCCEEDED', async () => {
    const args = { title: 't' }
    const approval = await approvalFor(args)
    const guard = makeGuard()
    jest.spyOn(guard, 'checkBeforeExecute').mockResolvedValue({
      allowed: false,
      errorCode: 'ALREADY_SUCCEEDED',
      message: 'Operation already succeeded',
    })
    jest.spyOn(guard, 'getOperation').mockResolvedValue({
      id: 1, userId: 'u1', operationId: approval.operationId, requestId: 'r1',
      toolName: 'test_todo_add', argsHash: approval.argsHash, status: 'succeeded',
      resultRef: 'todo:7', createdAt: 't', updatedAt: 't',
    })
    const { DB } = makeBatchDb()
    const result = await executeTestTodoAdd(args, CTX, { DB }, approval, guard)
    expect(result).toEqual({ ok: true, data: { resultRef: 'todo:7', todoId: '7', deduplicated: true } })
  })

  test('creates todo atomically and returns id', async () => {
    const args = { title: 'buy milk' }
    const approval = await approvalFor(args)
    const guard = okGuard(approval)
    const { DB } = makeBatchDb()
    const result = await executeTestTodoAdd(args, CTX, { DB }, approval, guard)
    expect(result).toEqual({
      ok: true,
      data: { id: 42, title: 'buy milk', resultRef: 'todo:42' },
    })
  })

  test('combines dueDate and dueTime', async () => {
    const args = { title: 't', dueDate: '2026-10-18', dueTime: '15:30' }
    const approval = await approvalFor(args)
    const guard = okGuard(approval)
    const { DB } = makeBatchDb()
    const result = await executeTestTodoAdd(args, CTX, { DB }, approval, guard)
    expect(result.ok).toBe(true)
  })

  test('uses dueDate alone when no dueTime', async () => {
    const args = { title: 't', dueDate: '2026-10-18' }
    const approval = await approvalFor(args)
    const guard = okGuard(approval)
    const { DB } = makeBatchDb()
    const result = await executeTestTodoAdd(args, CTX, { DB }, approval, guard)
    expect(result.ok).toBe(true)
  })

  test('returns DB_ERROR when batch yields no todoId', async () => {
    const args = { title: 't' }
    const approval = await approvalFor(args)
    const guard = okGuard(approval)
    const { DB } = makeBatchDb({ batchResults: [{}, { meta: {} }, {}] })
    const result = await executeTestTodoAdd(args, CTX, { DB }, approval, guard)
    expect(result).toEqual({ ok: false, errorCode: 'DB_ERROR', message: 'Failed to create todo' })
  })

  // UNIQUE violation handling
  describe('UNIQUE violation in batch', () => {
    const args = { title: 't' }

    test('deduplicates succeeded operation', async () => {
      const approval = await approvalFor(args)
      const guard = makeGuard()
      jest.spyOn(guard, 'checkBeforeExecute').mockResolvedValue({
        allowed: true, operationId: approval.operationId, argsHash: approval.argsHash,
      })
      jest.spyOn(guard, 'getOperation').mockResolvedValue({
        id: 1, userId: 'u1', operationId: approval.operationId, requestId: 'r1',
        toolName: 'test_todo_add', argsHash: approval.argsHash, status: 'succeeded',
        resultRef: 'todo:11', createdAt: 't', updatedAt: 't',
      })
      const { DB } = makeBatchDb({ batchThrows: new Error('UNIQUE constraint failed') })
      const result = await executeTestTodoAdd(args, CTX, { DB }, approval, guard)
      expect(result).toEqual({ ok: true, data: { resultRef: 'todo:11', todoId: '11', deduplicated: true } })
    })

    test('reports DB_ERROR when existing operation unknown (lowercase unique)', async () => {
      const approval = await approvalFor(args)
      const guard = makeGuard()
      jest.spyOn(guard, 'checkBeforeExecute').mockResolvedValue({
        allowed: true, operationId: approval.operationId, argsHash: approval.argsHash,
      })
      jest.spyOn(guard, 'getOperation').mockResolvedValue(null)
      const { DB } = makeBatchDb({ batchThrows: new Error('unique violation') })
      const result = await executeTestTodoAdd(args, CTX, { DB }, approval, guard)
      expect(result).toEqual({ ok: false, errorCode: 'DB_ERROR', message: 'Operation state unknown' })
    })

    test('reports IDEMPOTENCY_CONFLICT when args differ', async () => {
      const approval = await approvalFor(args)
      const guard = makeGuard()
      jest.spyOn(guard, 'checkBeforeExecute').mockResolvedValue({
        allowed: true, operationId: approval.operationId, argsHash: approval.argsHash,
      })
      jest.spyOn(guard, 'getOperation').mockResolvedValue({
        id: 1, userId: 'u1', operationId: approval.operationId, requestId: 'r1',
        toolName: 'test_todo_add', argsHash: 'other-hash', status: 'pending',
        createdAt: 't', updatedAt: 't',
      })
      const { DB } = makeBatchDb({ batchThrows: new Error('UNIQUE constraint failed') })
      const result = await executeTestTodoAdd(args, CTX, { DB }, approval, guard)
      expect(result).toEqual({ ok: false, errorCode: 'IDEMPOTENCY_CONFLICT', message: 'Different args for same operation' })
    })

    test('reports ALREADY_IN_PROGRESS', async () => {
      const approval = await approvalFor(args)
      const guard = makeGuard()
      jest.spyOn(guard, 'checkBeforeExecute').mockResolvedValue({
        allowed: true, operationId: approval.operationId, argsHash: approval.argsHash,
      })
      jest.spyOn(guard, 'getOperation').mockResolvedValue({
        id: 1, userId: 'u1', operationId: approval.operationId, requestId: 'r1',
        toolName: 'test_todo_add', argsHash: approval.argsHash, status: 'in_progress',
        createdAt: 't', updatedAt: 't',
      })
      const { DB } = makeBatchDb({ batchThrows: new Error('UNIQUE constraint failed') })
      const result = await executeTestTodoAdd(args, CTX, { DB }, approval, guard)
      expect(result).toEqual({ ok: false, errorCode: 'ALREADY_IN_PROGRESS', message: 'Operation in progress' })
    })

    test('reports OPERATION_UNKNOWN for unknown status', async () => {
      const approval = await approvalFor(args)
      const guard = makeGuard()
      jest.spyOn(guard, 'checkBeforeExecute').mockResolvedValue({
        allowed: true, operationId: approval.operationId, argsHash: approval.argsHash,
      })
      jest.spyOn(guard, 'getOperation').mockResolvedValue({
        id: 1, userId: 'u1', operationId: approval.operationId, requestId: 'r1',
        toolName: 'test_todo_add', argsHash: approval.argsHash, status: 'unknown',
        createdAt: 't', updatedAt: 't',
      })
      const { DB } = makeBatchDb({ batchThrows: new Error('UNIQUE constraint failed') })
      const result = await executeTestTodoAdd(args, CTX, { DB }, approval, guard)
      expect(result).toEqual({
        ok: false, errorCode: 'OPERATION_UNKNOWN',
        message: 'Operation status unknown, manual check required',
      })
    })

    test('reports RETRY_ALLOWED for pending status', async () => {
      const approval = await approvalFor(args)
      const guard = makeGuard()
      jest.spyOn(guard, 'checkBeforeExecute').mockResolvedValue({
        allowed: true, operationId: approval.operationId, argsHash: approval.argsHash,
      })
      jest.spyOn(guard, 'getOperation').mockResolvedValue({
        id: 1, userId: 'u1', operationId: approval.operationId, requestId: 'r1',
        toolName: 'test_todo_add', argsHash: approval.argsHash, status: 'pending',
        createdAt: 't', updatedAt: 't',
      })
      const { DB } = makeBatchDb({ batchThrows: new Error('UNIQUE constraint failed') })
      const result = await executeTestTodoAdd(args, CTX, { DB }, approval, guard)
      expect(result).toEqual({ ok: false, errorCode: 'RETRY_ALLOWED', message: 'Operation can be retried' })
    })

    test('reports RETRY_ALLOWED for failed status', async () => {
      const approval = await approvalFor(args)
      const guard = makeGuard()
      jest.spyOn(guard, 'checkBeforeExecute').mockResolvedValue({
        allowed: true, operationId: approval.operationId, argsHash: approval.argsHash,
      })
      jest.spyOn(guard, 'getOperation').mockResolvedValue({
        id: 1, userId: 'u1', operationId: approval.operationId, requestId: 'r1',
        toolName: 'test_todo_add', argsHash: approval.argsHash, status: 'failed',
        createdAt: 't', updatedAt: 't',
      })
      const { DB } = makeBatchDb({ batchThrows: new Error('UNIQUE constraint failed') })
      const result = await executeTestTodoAdd(args, CTX, { DB }, approval, guard)
      expect(result).toEqual({ ok: false, errorCode: 'RETRY_ALLOWED', message: 'Operation can be retried' })
    })
  })

  test('returns DB_ERROR on non-UNIQUE batch failure', async () => {
    const args = { title: 't' }
    const approval = await approvalFor(args)
    const guard = okGuard(approval)
    const { DB } = makeBatchDb({ batchThrows: new Error('D1 exploded') })
    const result = await executeTestTodoAdd(args, CTX, { DB }, approval, guard)
    expect(result).toEqual({ ok: false, errorCode: 'DB_ERROR', message: 'Database error' })
  })

  test('handles batch throw without message (defensive || fallback)', async () => {
    const args = { title: 't' }
    const approval = await approvalFor(args)
    const guard = okGuard(approval)
    // throw a non-Error without message → String(e?.message || '') path
    const { DB } = makeBatchDb({ batchThrows: undefined })
    const throwingDb = {
      ...DB,
      batch: async () => { throw {} },
    } as unknown as D1Database
    const result = await executeTestTodoAdd(args, CTX, { DB: throwingDb }, approval, guard)
    expect(result).toEqual({ ok: false, errorCode: 'DB_ERROR', message: 'Database error' })
  })
})
