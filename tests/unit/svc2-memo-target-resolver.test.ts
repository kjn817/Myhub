/// <reference types="jest" />
/**
 * memo-target-resolver.ts 커버리지 테스트
 * - resolveMemoTarget: explicit_id / selected / last_created / last_target / 폴백
 * - inferTargetKind: 명시 ID / 폴백
 *
 * resolveMemoTarget은 './memo-context'를 동적 import하므로 jest.mock으로 대체.
 */
import { resolveMemoTarget, inferTargetKind } from '../../src/services/memo-target-resolver'

jest.mock('../../src/services/memo-context', () => ({
  getMemoContext: jest.fn(),
}))

import { getMemoContext } from '../../src/services/memo-context'
const mockGetCtx = getMemoContext as jest.Mock

function makeDb(memoRow: any, recentRow: any = null) {
  return {
    prepare(sql: string) {
      return {
        _sql: sql,
        _params: [] as any[],
        bind(...p: any[]) { this._params = p; return this },
        async first() {
          if (this._sql.includes('SELECT id, is_locked FROM memos')) return memoRow
          if (this._sql.includes('ORDER BY id DESC')) return recentRow
          return null
        },
      }
    },
  }
}

const ctx = { userId: 'u1', conversationId: 'c1' }

beforeEach(() => {
  mockGetCtx.mockReset()
})

describe('resolveMemoTarget', () => {
  test('explicit_id 정상', async () => {
    const db = makeDb({ id: 5, is_locked: 0 })
    const out = await resolveMemoTarget({ DB: db } as any, { kind: 'explicit_id', memoId: 5 }, ctx)
    expect(out).toEqual({ ok: true, memoId: 5 })
  })

  test('selected + target.memoId', async () => {
    const db = makeDb({ id: 6, is_locked: 0 })
    const out = await resolveMemoTarget({ DB: db } as any, { kind: 'selected', memoId: 6 }, ctx)
    expect(out).toEqual({ ok: true, memoId: 6 })
  })

  test('selected + context.selectedMemoId', async () => {
    const db = makeDb({ id: 7, is_locked: 0 })
    const out = await resolveMemoTarget(
      { DB: db } as any, { kind: 'selected' }, { ...ctx, selectedMemoId: 7 }
    )
    expect(out).toEqual({ ok: true, memoId: 7 })
  })

  test('last_created: 문맥에서 조회', async () => {
    mockGetCtx.mockResolvedValue({ last_created_memo_id: 11, last_target_memo_id: 22 })
    const db = makeDb({ id: 11, is_locked: 0 })
    const out = await resolveMemoTarget({ DB: db } as any, { kind: 'last_created' }, ctx)
    expect(out).toEqual({ ok: true, memoId: 11 })
  })

  test('last_target: target 우선, 없으면 created', async () => {
    mockGetCtx.mockResolvedValue({ last_created_memo_id: 11, last_target_memo_id: null })
    const db = makeDb({ id: 11, is_locked: 0 })
    const out = await resolveMemoTarget({ DB: db } as any, { kind: 'last_target' }, ctx)
    expect(out).toEqual({ ok: true, memoId: 11 })
  })

  test('last_created인데 문맥에 없음 → 최근 메모 폴백', async () => {
    mockGetCtx.mockResolvedValue({ last_created_memo_id: null, last_target_memo_id: null })
    const db = makeDb({ id: 77, is_locked: 0 }, { id: 77 })
    const out = await resolveMemoTarget({ DB: db } as any, { kind: 'last_created' }, ctx)
    expect(out).toEqual({ ok: true, memoId: 77 })
  })

  test('문맥 없음 → 최근 메모 폴백', async () => {
    mockGetCtx.mockResolvedValue(null)
    const db = makeDb({ id: 99, is_locked: 0 }, { id: 99 })
    const out = await resolveMemoTarget({ DB: db } as any, { kind: 'last_target' }, ctx)
    expect(out).toEqual({ ok: true, memoId: 99 })
  })

  test('문맥 조회 throw → 최근 메모 폴백', async () => {
    mockGetCtx.mockRejectedValue(new Error('x'))
    const db = makeDb({ id: 98, is_locked: 0 }, { id: 98 })
    const out = await resolveMemoTarget({ DB: db } as any, { kind: 'last_created' }, ctx)
    expect(out).toEqual({ ok: true, memoId: 98 })
  })

  test('최근 메모도 없음 → TARGET_NOT_FOUND', async () => {
    mockGetCtx.mockResolvedValue(null)
    const db = makeDb(null, null)
    const out = await resolveMemoTarget({ DB: db } as any, { kind: 'last_target' }, ctx)
    expect(out).toEqual({ ok: false, error: 'TARGET_NOT_FOUND' })
  })

  test('최근 메모 조회 throw → TARGET_NOT_FOUND', async () => {
    mockGetCtx.mockResolvedValue(null)
    const db = {
      prepare(sql: string) {
        return {
          bind() { return this },
          async first() {
            if (sql.includes('ORDER BY id DESC')) throw new Error('db')
            return { id: 1, is_locked: 0 }
          },
        }
      },
    }
    const out = await resolveMemoTarget({ DB: db } as any, { kind: 'last_target' }, ctx)
    // memoId가 null이므로 TARGET_NOT_FOUND
    expect(out.ok).toBe(false)
  })

  test('메모 없음 → MEMO_NOT_FOUND', async () => {
    const db = makeDb(null)
    const out = await resolveMemoTarget({ DB: db } as any, { kind: 'explicit_id', memoId: 123 }, ctx)
    expect(out).toEqual({ ok: false, error: 'MEMO_NOT_FOUND' })
  })

  test('잠긴 메모 → MEMO_LOCKED', async () => {
    const db = makeDb({ id: 5, is_locked: 1 })
    const out = await resolveMemoTarget({ DB: db } as any, { kind: 'explicit_id', memoId: 5 }, ctx)
    expect(out).toEqual({ ok: false, error: 'MEMO_LOCKED' })
  })

  test('검증 쿼리 throw → DB_ERROR', async () => {
    const db = {
      prepare() {
        return {
          bind() { return this },
          async first() { throw new Error('boom') },
        }
      },
    }
    const out = await resolveMemoTarget({ DB: db } as any, { kind: 'explicit_id', memoId: 5 }, ctx)
    expect(out).toEqual({ ok: false, error: 'DB_ERROR' })
  })

  test('memoId가 숫자가 아님 → TARGET_NOT_FOUND', async () => {
    const db = makeDb({ id: 5, is_locked: 0 })
    const out = await resolveMemoTarget(
      { DB: db } as any, { kind: 'explicit_id', memoId: 'x' as any }, ctx
    )
    expect(out).toEqual({ ok: false, error: 'TARGET_NOT_FOUND' })
  })

  test('selected인데 ID 없음 → 문맥 폴백 시도', async () => {
    mockGetCtx.mockResolvedValue({ last_created_memo_id: 33, last_target_memo_id: null })
    const db = makeDb({ id: 33, is_locked: 0 })
    const out = await resolveMemoTarget({ DB: db } as any, { kind: 'selected' }, ctx)
    expect(out).toEqual({ ok: true, memoId: 33 })
  })
})

describe('inferTargetKind', () => {
  test('명시 ID → explicit_id', () => {
    expect(inferTargetKind('anything', 42)).toEqual({ kind: 'explicit_id', memoId: 42 })
  })

  test('ID 없음 → last_target 폴백', () => {
    expect(inferTargetKind('그 메모 요약해줘')).toEqual({ kind: 'last_target' })
  })

  test('ID 0 → falsy라 폴백', () => {
    expect(inferTargetKind('x', 0)).toEqual({ kind: 'last_target' })
  })

  test('문자열 ID → 폴백 (typeof 체크)', () => {
    expect(inferTargetKind('x', '5' as any)).toEqual({ kind: 'last_target' })
  })
})
