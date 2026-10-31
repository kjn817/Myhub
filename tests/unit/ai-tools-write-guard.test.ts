/// <reference types="jest" />
import {
  canTransition,
  hashArgs,
  createTestApproval,
  WriteExecutionGuard,
  type OperationStatus,
  type WriteApproval,
} from '../../src/ai/tools/write-guard'
import type { ExecutionContext } from '../../src/ai/types'

// ---------------------------------------------------------------------------
// Mock D1Database
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

function makeDb(opts: {
  firstValue?: Row | null
  runChanges?: number
  runThrows?: Error
  batchOk?: boolean
} = {}): { db: D1Database; calls: string[] } {
  const calls: string[] = []
  const db = {
    prepare: (sql: string) => ({
      bind: (..._args: unknown[]) => {
        calls.push(sql)
        return {
          first: async () => opts.firstValue ?? null,
          run: async () => {
            if (opts.runThrows) throw opts.runThrows
            return { meta: { changes: opts.runChanges ?? 1, last_row_id: 99 } }
          },
        }
      },
    }),
  } as unknown as D1Database
  return { db, calls }
}

// 대화형 실행을 대표하는 컨텍스트 (③-A: 쓰기 가드는 origin을 본다)
const CTX: ExecutionContext = { userId: 'u1', requestId: 'req-1', approvedWrites: true, origin: 'interactive' }

function validApproval(overrides: Partial<WriteApproval> = {}): WriteApproval {
  const future = new Date(Date.now() + 60000).toISOString()
  return {
    userId: 'u1',
    operationId: 'op-1',
    toolName: 'test_todo_add',
    argsHash: 'hash-abc',
    level: 'low_risk',
    status: 'approved',
    approvedAt: new Date().toISOString(),
    expiresAt: future,
    ...overrides,
  }
}

function makeCall(args: unknown = { title: 'x' }) {
  return { id: 'c1', name: 'test_todo_add', args, provider: 'gemini' as const }
}

// ---------------------------------------------------------------------------
// canTransition
// ---------------------------------------------------------------------------

describe('canTransition', () => {
  test.each<[OperationStatus, OperationStatus, boolean]>([
    ['pending', 'in_progress', true],
    ['pending', 'failed', true],
    ['pending', 'succeeded', false],
    ['pending', 'pending', false],
    ['in_progress', 'succeeded', true],
    ['in_progress', 'failed', true],
    ['in_progress', 'unknown', true],
    ['in_progress', 'pending', false],
    ['succeeded', 'pending', false],
    ['succeeded', 'failed', false],
    ['succeeded', 'in_progress', false],
    ['failed', 'pending', true],
    ['failed', 'succeeded', false],
    ['unknown', 'pending', true],
    ['unknown', 'in_progress', true],
    ['unknown', 'succeeded', false],
    ['unknown', 'failed', false],
  ])('from %s to %s = %s', (from, to, expected) => {
    expect(canTransition(from, to)).toBe(expected)
  })

  test('unknown from-status returns false', () => {
    expect(canTransition('bogus' as OperationStatus, 'pending')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// hashArgs
// ---------------------------------------------------------------------------

describe('hashArgs', () => {
  test('same args produce same hash', async () => {
    const a = await hashArgs({ b: 1, a: 2 })
    const b = await hashArgs({ a: 2, b: 1 })
    expect(a).toBe(b)
  })

  test('key order does not affect hash (normalization)', async () => {
    const a = await hashArgs({ x: { d: 1, c: 2 } })
    const b = await hashArgs({ x: { c: 2, d: 1 } })
    expect(a).toBe(b)
  })

  test('different args produce different hash', async () => {
    expect(await hashArgs({ a: 1 })).not.toBe(await hashArgs({ a: 2 }))
  })

  test('handles null, undefined, arrays', async () => {
    expect(await hashArgs(null)).toBe(await hashArgs(undefined))
    expect(await hashArgs([3, 2, 1])).not.toBe(await hashArgs([1, 2, 3]))
  })

  test('returns a non-empty string', async () => {
    const h = await hashArgs({ title: 'test' })
    expect(typeof h).toBe('string')
    expect(h.length).toBeGreaterThan(0)
  })

  test('fallback hash works when crypto.subtle unavailable', async () => {
    const realCrypto = (globalThis as any).crypto
    try {
      ;(globalThis as any).crypto = undefined
      const h = await hashArgs({ a: 1 })
      expect(typeof h).toBe('string')
      expect(h.length).toBeGreaterThan(0)
      // deterministic in fallback
      const h2 = await hashArgs({ a: 1 })
      expect(h).toBe(h2)
    } finally {
      ;(globalThis as any).crypto = realCrypto
    }
  })

  test('fallback hash with crypto but no subtle', async () => {
    const realCrypto = (globalThis as any).crypto
    try {
      ;(globalThis as any).crypto = {}
      const h = await hashArgs({ a: 1 })
      expect(typeof h).toBe('string')
    } finally {
      ;(globalThis as any).crypto = realCrypto
    }
  })
})

// ---------------------------------------------------------------------------
// createTestApproval
// ---------------------------------------------------------------------------

describe('createTestApproval', () => {
  test('creates an approved approval with 5-min expiry', async () => {
    const before = Date.now()
    const approval = await createTestApproval('u1', 'op-1', 'test_todo_add', { title: 't' })
    expect(approval.userId).toBe('u1')
    expect(approval.operationId).toBe('op-1')
    expect(approval.toolName).toBe('test_todo_add')
    expect(approval.status).toBe('approved')
    expect(approval.level).toBe('low_risk')
    expect(typeof approval.argsHash).toBe('string')
    const exp = new Date(approval.expiresAt!).getTime()
    expect(exp - before).toBeGreaterThanOrEqual(5 * 60 * 1000 - 1000)
    expect(exp - before).toBeLessThanOrEqual(5 * 60 * 1000 + 1000)
  })

  test('accepts custom level', async () => {
    const approval = await createTestApproval('u1', 'op-1', 'tool', {}, 'confirmation_required')
    expect(approval.level).toBe('confirmation_required')
  })

  test('argsHash matches hashArgs of args', async () => {
    const args = { title: 'hello', n: 5 }
    const approval = await createTestApproval('u1', 'op-1', 'tool', args)
    expect(approval.argsHash).toBe(await hashArgs(args))
  })
})

// ---------------------------------------------------------------------------
// WriteExecutionGuard.checkBeforeExecute
// ---------------------------------------------------------------------------

describe('WriteExecutionGuard.checkBeforeExecute — 출처 게이트 (Talorys ③-A)', () => {
  // FC 우회 경로(write-guard)에도 decideToolExecution과 같은 규칙:
  // 비대화형·미지정 출처의 쓰기는 유효한 승인이 있어도 거부된다.
  // 가드의 origin 분기를 지우면 아래 케이스가 allowed:true가 되어 실패한다.
  test('scheduled origin + valid approval → NON_INTERACTIVE_ORIGIN', async () => {
    const args = { title: 'x' }
    const argsHash = await hashArgs(args)
    const { db } = makeDb({ firstValue: null })
    const guard = new WriteExecutionGuard({ db })
    const result = await guard.checkBeforeExecute(
      makeCall(args) as any,
      { ...CTX, origin: 'scheduled' },
      validApproval({ argsHash }),
    )
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.errorCode).toBe('NON_INTERACTIVE_ORIGIN')
  })

  test('origin 미지정 + valid approval → NON_INTERACTIVE_ORIGIN (fail-closed)', async () => {
    const args = { title: 'x' }
    const argsHash = await hashArgs(args)
    const { db } = makeDb({ firstValue: null })
    const guard = new WriteExecutionGuard({ db })
    const noOrigin: ExecutionContext = { userId: 'u1', requestId: 'req-1', approvedWrites: true }
    const result = await guard.checkBeforeExecute(
      makeCall(args) as any,
      noOrigin,
      validApproval({ argsHash }),
    )
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.errorCode).toBe('NON_INTERACTIVE_ORIGIN')
  })

  test('mcp origin → NON_INTERACTIVE_ORIGIN (승인 검사보다 먼저)', async () => {
    const { db } = makeDb()
    const guard = new WriteExecutionGuard({ db })
    const result = await guard.checkBeforeExecute(makeCall() as any, { ...CTX, origin: 'mcp' }, null)
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.errorCode).toBe('NON_INTERACTIVE_ORIGIN')
  })
})

describe('WriteExecutionGuard.checkBeforeExecute', () => {
  test('rejects when approval is null', async () => {
    const { db } = makeDb()
    const guard = new WriteExecutionGuard({ db })
    const result = await guard.checkBeforeExecute(makeCall() as any, CTX, null)
    expect(result).toEqual({ allowed: false, errorCode: 'APPROVAL_REQUIRED', message: 'Write approval required' })
  })

  test('rejects on user mismatch', async () => {
    const { db } = makeDb()
    const guard = new WriteExecutionGuard({ db })
    const result = await guard.checkBeforeExecute(
      makeCall() as any, CTX, validApproval({ userId: 'other' })
    )
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.errorCode).toBe('APPROVAL_USER_MISMATCH')
  })

  test('rejects on tool name mismatch', async () => {
    const { db } = makeDb()
    const guard = new WriteExecutionGuard({ db })
    const result = await guard.checkBeforeExecute(
      makeCall() as any, CTX, validApproval({ toolName: 'other_tool' })
    )
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.errorCode).toBe('APPROVAL_TOOL_MISMATCH')
  })

  test('rejects when status is not approved', async () => {
    const { db } = makeDb()
    const guard = new WriteExecutionGuard({ db })
    for (const status of ['pending', 'expired', 'rejected'] as const) {
      const result = await guard.checkBeforeExecute(
        makeCall() as any, CTX, validApproval({ status })
      )
      expect(result.allowed).toBe(false)
      if (!result.allowed) expect(result.errorCode).toBe('APPROVAL_NOT_GRANTED')
    }
  })

  test('rejects expired approval', async () => {
    const { db } = makeDb()
    const guard = new WriteExecutionGuard({ db })
    const past = new Date(Date.now() - 60000).toISOString()
    const result = await guard.checkBeforeExecute(
      makeCall() as any, CTX, validApproval({ expiresAt: past })
    )
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.errorCode).toBe('APPROVAL_EXPIRED')
  })

  test('accepts approval without expiresAt', async () => {
    const { db } = makeDb({ firstValue: null })
    const guard = new WriteExecutionGuard({ db })
    const args = { title: 'x' }
    const approval = validApproval({ expiresAt: undefined, argsHash: await hashArgs(args) })
    const result = await guard.checkBeforeExecute(makeCall(args) as any, CTX, approval)
    expect(result.allowed).toBe(true)
  })

  test('rejects when args changed after approval', async () => {
    const { db } = makeDb()
    const guard = new WriteExecutionGuard({ db })
    const result = await guard.checkBeforeExecute(
      makeCall({ title: 'changed' }) as any,
      CTX,
      validApproval({ argsHash: 'stale-hash' })
    )
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.errorCode).toBe('IDEMPOTENCY_CONFLICT')
  })

  test('rejects already-succeeded operation', async () => {
    const args = { title: 'x' }
    const argsHash = await hashArgs(args)
    const { db } = makeDb({
      firstValue: {
        id: 1, user_id: 'u1', operation_id: 'op-1', request_id: 'r1',
        tool_name: 'test_todo_add', args_hash: argsHash, status: 'succeeded',
        result_ref: 'todo:5', error_code: null,
        created_at: 't', updated_at: 't',
      },
    })
    const guard = new WriteExecutionGuard({ db })
    const result = await guard.checkBeforeExecute(
      makeCall(args) as any, CTX, validApproval({ argsHash })
    )
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.errorCode).toBe('ALREADY_SUCCEEDED')
  })

  test('rejects in-progress operation', async () => {
    const args = { title: 'x' }
    const argsHash = await hashArgs(args)
    const { db } = makeDb({
      firstValue: {
        id: 1, user_id: 'u1', operation_id: 'op-1', request_id: 'r1',
        tool_name: 'test_todo_add', args_hash: argsHash, status: 'in_progress',
        created_at: 't', updated_at: 't',
      },
    })
    const guard = new WriteExecutionGuard({ db })
    const result = await guard.checkBeforeExecute(
      makeCall(args) as any, CTX, validApproval({ argsHash })
    )
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.errorCode).toBe('ALREADY_IN_PROGRESS')
  })

  test('rejects when existing argsHash differs', async () => {
    const args = { title: 'x' }
    const argsHash = await hashArgs(args)
    const { db } = makeDb({
      firstValue: {
        id: 1, user_id: 'u1', operation_id: 'op-1', request_id: 'r1',
        tool_name: 'test_todo_add', args_hash: 'different-hash', status: 'pending',
        created_at: 't', updated_at: 't',
      },
    })
    const guard = new WriteExecutionGuard({ db })
    const result = await guard.checkBeforeExecute(
      makeCall(args) as any, CTX, validApproval({ argsHash })
    )
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.errorCode).toBe('IDEMPOTENCY_CONFLICT')
  })

  test('allows retry for pending operation', async () => {
    const args = { title: 'x' }
    const argsHash = await hashArgs(args)
    const { db } = makeDb({
      firstValue: {
        id: 1, user_id: 'u1', operation_id: 'op-1', request_id: 'r1',
        tool_name: 'test_todo_add', args_hash: argsHash, status: 'pending',
        created_at: 't', updated_at: 't',
      },
    })
    const guard = new WriteExecutionGuard({ db })
    const result = await guard.checkBeforeExecute(
      makeCall(args) as any, CTX, validApproval({ argsHash })
    )
    expect(result).toEqual({ allowed: true, operationId: 'op-1', argsHash })
  })

  test('allows retry for failed operation', async () => {
    const args = { title: 'x' }
    const argsHash = await hashArgs(args)
    const { db } = makeDb({
      firstValue: {
        id: 1, user_id: 'u1', operation_id: 'op-1', request_id: 'r1',
        tool_name: 'test_todo_add', args_hash: argsHash, status: 'failed',
        created_at: 't', updated_at: 't',
      },
    })
    const guard = new WriteExecutionGuard({ db })
    const result = await guard.checkBeforeExecute(
      makeCall(args) as any, CTX, validApproval({ argsHash })
    )
    expect(result.allowed).toBe(true)
  })

  test('allows retry for unknown operation', async () => {
    const args = { title: 'x' }
    const argsHash = await hashArgs(args)
    const { db } = makeDb({
      firstValue: {
        id: 1, user_id: 'u1', operation_id: 'op-1', request_id: 'r1',
        tool_name: 'test_todo_add', args_hash: argsHash, status: 'unknown',
        created_at: 't', updated_at: 't',
      },
    })
    const guard = new WriteExecutionGuard({ db })
    const result = await guard.checkBeforeExecute(
      makeCall(args) as any, CTX, validApproval({ argsHash })
    )
    expect(result.allowed).toBe(true)
  })

  test('allows when no existing operation', async () => {
    const args = { title: 'x' }
    const argsHash = await hashArgs(args)
    const { db } = makeDb({ firstValue: null })
    const guard = new WriteExecutionGuard({ db })
    const result = await guard.checkBeforeExecute(
      makeCall(args) as any, CTX, validApproval({ argsHash })
    )
    expect(result).toEqual({ allowed: true, operationId: 'op-1', argsHash })
  })
})

// ---------------------------------------------------------------------------
// getOperation
// ---------------------------------------------------------------------------

describe('WriteExecutionGuard.getOperation', () => {
  test('maps DB row to OperationRecord', async () => {
    const { db } = makeDb({
      firstValue: {
        id: 10, user_id: 'u1', operation_id: 'op-9', request_id: 'req-9',
        tool_name: 'test_todo_add', args_hash: 'h', status: 'succeeded',
        result_ref: 'todo:3', error_code: null,
        created_at: '2026-01-01', updated_at: '2026-01-02',
      },
    })
    const guard = new WriteExecutionGuard({ db })
    const op = await guard.getOperation('u1', 'op-9')
    expect(op).toEqual({
      id: 10, userId: 'u1', operationId: 'op-9', requestId: 'req-9',
      toolName: 'test_todo_add', argsHash: 'h', status: 'succeeded',
      resultRef: 'todo:3', errorCode: null,
      createdAt: '2026-01-01', updatedAt: '2026-01-02',
    })
  })

  test('returns null when no row', async () => {
    const { db } = makeDb({ firstValue: null })
    const guard = new WriteExecutionGuard({ db })
    expect(await guard.getOperation('u1', 'missing')).toBeNull()
  })

  test('returns null on DB error', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({ first: async () => { throw new Error('D1 down') } }),
      }),
    } as unknown as D1Database
    const guard = new WriteExecutionGuard({ db })
    expect(await guard.getOperation('u1', 'op')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// transitionStatus
// ---------------------------------------------------------------------------

describe('WriteExecutionGuard.transitionStatus', () => {
  test('returns false for disallowed transition without touching DB', async () => {
    const { db, calls } = makeDb()
    const guard = new WriteExecutionGuard({ db })
    expect(await guard.transitionStatus('u1', 'op', 'succeeded', 'pending')).toBe(false)
    expect(calls.length).toBe(0)
  })

  test('returns true when update changes a row', async () => {
    const { db } = makeDb({ runChanges: 1 })
    const guard = new WriteExecutionGuard({ db })
    expect(await guard.transitionStatus('u1', 'op', 'pending', 'in_progress')).toBe(true)
  })

  test('returns false when no row changed', async () => {
    const { db } = makeDb({ runChanges: 0 })
    const guard = new WriteExecutionGuard({ db })
    expect(await guard.transitionStatus('u1', 'op', 'pending', 'in_progress')).toBe(false)
  })

  test('returns false on DB error', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({ run: async () => { throw new Error('D1 down') } }),
      }),
    } as unknown as D1Database
    const guard = new WriteExecutionGuard({ db })
    expect(await guard.transitionStatus('u1', 'op', 'pending', 'in_progress')).toBe(false)
  })

  test('handles run() result without meta (defensive ?? 0)', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({ run: async () => ({}) }), // no meta at all
      }),
    } as unknown as D1Database
    const guard = new WriteExecutionGuard({ db })
    expect(await guard.transitionStatus('u1', 'op', 'pending', 'in_progress')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// createOperation
// ---------------------------------------------------------------------------

describe('WriteExecutionGuard.createOperation', () => {
  test('returns created:true on successful insert', async () => {
    const { db } = makeDb()
    const guard = new WriteExecutionGuard({ db })
    const result = await guard.createOperation('u1', 'op-1', 'req-1', 'test_todo_add', 'h')
    expect(result).toEqual({ created: true })
  })

  test('returns existing on UNIQUE violation', async () => {
    const existing = {
      id: 1, user_id: 'u1', operation_id: 'op-1', request_id: 'r1',
      tool_name: 'test_todo_add', args_hash: 'h', status: 'pending',
      created_at: 't', updated_at: 't',
    }
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => existing,
          run: async () => { throw new Error('UNIQUE constraint failed: ai_tool_operations') },
        }),
      }),
    } as unknown as D1Database
    const guard = new WriteExecutionGuard({ db })
    const result = await guard.createOperation('u1', 'op-1', 'req-1', 'test_todo_add', 'h')
    expect(result.created).toBe(false)
    expect(result.existing?.operationId).toBe('op-1')
  })

  test('matches lowercase unique message too', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          run: async () => { throw new Error('unique constraint violation') },
        }),
      }),
    } as unknown as D1Database
    const guard = new WriteExecutionGuard({ db })
    const result = await guard.createOperation('u1', 'op-1', 'req-1', 'test_todo_add', 'h')
    expect(result.created).toBe(false)
    expect(result.existing).toBeUndefined()
  })

  test('rethrows non-UNIQUE errors', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({ run: async () => { throw new Error('D1 exploded') } }),
      }),
    } as unknown as D1Database
    const guard = new WriteExecutionGuard({ db })
    await expect(guard.createOperation('u1', 'op-1', 'req-1', 'test_todo_add', 'h')).rejects.toThrow(
      'D1 exploded'
    )
  })
})
