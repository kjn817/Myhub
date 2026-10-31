/// <reference types="jest" />
/**
 * memo-context.ts 커버리지 테스트
 * - getMemoContext: 조회 / 없음 / 만료 / 파싱 / DB 에러
 * - updateMemoContext: 신규 생성 / 업데이트 / 동시성 충돌 / 에러
 * - resolveContextMemoId: 우선순위 1~4
 */
import {
  getMemoContext,
  updateMemoContext,
  resolveContextMemoId,
  MemoContext,
} from '../../src/services/memo-context'

// ---- MockDb ----
function makeDb(rows: Record<string, any> = {}) {
  const calls: any[] = []
  return {
    calls,
    prepare(sql: string) {
      const self = this
      return {
        _sql: sql,
        _params: [] as any[],
        bind(...params: any[]) {
          this._params = params
          return this
        },
        async first() {
          calls.push({ sql: this._sql, params: this._params, op: 'first' })
          // SELECT ... FROM memo_conversation_context → 행 반환
          if (this._sql.includes('memo_conversation_context') && this._sql.includes('SELECT')) {
            const key = `${this._params[0]}:${this._params[1]}`
            return rows[key] || null
          }
          return null
        },
        async run() {
          calls.push({ sql: this._sql, params: this._params, op: 'run' })
          return { success: true }
        },
      }
    },
  }
}

const futureExpiry = new Date(Date.now() + 3600 * 1000).toISOString()
const pastExpiry = new Date(Date.now() - 3600 * 1000).toISOString()

function ctxRow(over: Record<string, any> = {}) {
  return {
    user_id: 'u1',
    conversation_id: 'c1',
    last_created_memo_id: 10,
    last_target_memo_id: 20,
    last_search_result_ids: '[1,2,3]',
    revision: 3,
    updated_at: '2026-10-17T00:00:00Z',
    expires_at: futureExpiry,
    ...over,
  }
}

describe('getMemoContext', () => {
  test('정상 조회', async () => {
    const db = makeDb({ 'u1:c1': ctxRow() })
    const ctx = await getMemoContext({ DB: db }, 'u1', 'c1')
    expect(ctx).not.toBeNull()
    expect(ctx!.last_created_memo_id).toBe(10)
    expect(ctx!.last_search_result_ids).toEqual([1, 2, 3])
    expect(ctx!.revision).toBe(3)
  })

  test('행 없음 → null', async () => {
    const db = makeDb({})
    expect(await getMemoContext({ DB: db }, 'u1', 'c1')).toBeNull()
  })

  test('만료됨 → null', async () => {
    const db = makeDb({ 'u1:c1': ctxRow({ expires_at: pastExpiry }) })
    expect(await getMemoContext({ DB: db }, 'u1', 'c1')).toBeNull()
  })

  test('expires_at null → 만료 아님', async () => {
    const db = makeDb({ 'u1:c1': ctxRow({ expires_at: null }) })
    const ctx = await getMemoContext({ DB: db }, 'u1', 'c1')
    expect(ctx).not.toBeNull()
    expect(ctx!.expires_at).toBeNull()
  })

  test('last_search_result_ids null → 빈 배열', async () => {
    const db = makeDb({ 'u1:c1': ctxRow({ last_search_result_ids: null }) })
    const ctx = await getMemoContext({ DB: db }, 'u1', 'c1')
    expect(ctx!.last_search_result_ids).toEqual([])
  })

  test('DB 에러 → null', async () => {
    const db = {
      prepare() {
        throw new Error('boom')
      },
    }
    expect(await getMemoContext({ DB: db }, 'u1', 'c1')).toBeNull()
  })

  test('first() throw → null', async () => {
    const db = {
      prepare() {
        return {
          bind() { return this },
          async first() { throw new Error('x') },
        }
      },
    }
    expect(await getMemoContext({ DB: db }, 'u1', 'c1')).toBeNull()
  })
})

describe('updateMemoContext', () => {
  test('기존 문맥 업데이트 (검색결과 포함)', async () => {
    const db = makeDb({ 'u1:c1': ctxRow() })
    const ok = await updateMemoContext(
      { DB: db }, 'u1', 'c1', { last_created_memo_id: 99, last_search_result_ids: [8, 9] }
    )
    expect(ok).toBe(true)
    const upd = db.calls.find((c: any) => c.sql.includes('UPDATE'))
    expect(upd).toBeDefined()
    // revision 3 → 4
    expect(upd.params).toContain(4)
    expect(upd.params).toContain('[8,9]')
  })

  test('기존 없음 → INSERT', async () => {
    const db = makeDb({})
    const ok = await updateMemoContext(
      { DB: db }, 'u1', 'c1', { last_target_memo_id: 7, last_search_result_ids: [5] }
    )
    expect(ok).toBe(true)
    const ins = db.calls.find((c: any) => c.sql.includes('INSERT'))
    expect(ins).toBeDefined()
    expect(ins.params).toContain(7)
  })

  test('동시성 충돌 → false', async () => {
    const db = makeDb({ 'u1:c1': ctxRow({ revision: 3 }) })
    const ok = await updateMemoContext(
      { DB: db }, 'u1', 'c1', { last_created_memo_id: 1 }, 99 /* expectedRevision 불일치 */
    )
    expect(ok).toBe(false)
  })

  test('동시성 일치 → true', async () => {
    const db = makeDb({ 'u1:c1': ctxRow({ revision: 3 }) })
    const ok = await updateMemoContext(
      { DB: db }, 'u1', 'c1', { last_created_memo_id: 1 }, 3
    )
    expect(ok).toBe(true)
  })

  test('빈 updates → COALESCE null 전달', async () => {
    const db = makeDb({ 'u1:c1': ctxRow() })
    const ok = await updateMemoContext({ DB: db }, 'u1', 'c1', {})
    expect(ok).toBe(true)
  })

  test('DB 에러 → false', async () => {
    const db = {
      prepare() { throw new Error('boom') },
    }
    expect(await updateMemoContext({ DB: db }, 'u1', 'c1', {})).toBe(false)
  })

  test('run() throw → false', async () => {
    const db = {
      prepare() {
        return {
          bind() { return this },
          async first() { return null },
          async run() { throw new Error('x') },
        }
      },
    }
    expect(await updateMemoContext({ DB: db }, 'u1', 'c1', {})).toBe(false)
  })
})

describe('resolveContextMemoId', () => {
  const base: MemoContext = {
    user_id: 'u1',
    conversation_id: 'c1',
    last_created_memo_id: 10,
    last_target_memo_id: 20,
    last_search_result_ids: [30],
    revision: 1,
    updated_at: 'x',
    expires_at: null,
  }

  test('1순위: 명시된 ID', () => {
    expect(resolveContextMemoId(base, 42)).toBe(42)
  })

  test('2순위: UI 선택', () => {
    expect(resolveContextMemoId(base, undefined, 43)).toBe(43)
  })

  test('3순위: 최근 생성', () => {
    expect(resolveContextMemoId(base)).toBe(10)
  })

  test('3순위: 생성 없으면 타겟', () => {
    const ctx = { ...base, last_created_memo_id: null }
    expect(resolveContextMemoId(ctx)).toBe(20)
  })

  test('4순위: 유일한 검색 결과', () => {
    const ctx = { ...base, last_created_memo_id: null, last_target_memo_id: null }
    expect(resolveContextMemoId(ctx)).toBe(30)
  })

  test('검색 결과 2개 → null', () => {
    const ctx = {
      ...base,
      last_created_memo_id: null,
      last_target_memo_id: null,
      last_search_result_ids: [1, 2],
    }
    expect(resolveContextMemoId(ctx)).toBeNull()
  })

  test('ctx null → null', () => {
    expect(resolveContextMemoId(null)).toBeNull()
  })

  test('ctx null + 명시 ID → ID', () => {
    expect(resolveContextMemoId(null, 7)).toBe(7)
  })

  test('explicitId가 숫자가 아니면 무시', () => {
    expect(resolveContextMemoId(base, 'x' as any)).toBe(10)
  })

  test('uiSelectedId가 숫자가 아니면 무시', () => {
    expect(resolveContextMemoId(base, undefined, 'y' as any)).toBe(10)
  })

  test('explicitId 0 → falsy라 무시', () => {
    expect(resolveContextMemoId(base, 0)).toBe(10)
  })
})
