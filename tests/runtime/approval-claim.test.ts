/**
 * 승인 실행 claim 실런타임 테스트 (0063, Talorys ②-0)
 *
 * FakeD1이 흉내내지 못하는 실제 SQLite/D1 의미로 검증한다:
 * - 마이그레이션 체인(…→0063)이 tool_approval_requests에 executed_at /
 *   execution_result 컬럼을 실제로 만든다 (applyAllMigrations가 디스크의
 *   전 파일을 순서대로 적용 — 운영 적용 절차와 같은 파일).
 * - 실제 D1에서 동시 claim 2건 중 정확히 1건만 changes=1을 받는다.
 * - 실행 완료/실패 후에도 executed_at이 유지돼 재선점이 불가능하다.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { applyAllMigrations, testDb } from './helpers/apply-migrations'
import {
  ToolApprovalRequestStore,
  executeApprovedRequestOnce,
} from '../../src/services/approval-flow'

const NOW = new Date('2026-10-30T02:00:00Z')
const FUTURE = new Date(NOW.getTime() + 10 * 60 * 1000).toISOString()

async function seedApproved(conversationId: number) {
  const store = new ToolApprovalRequestStore(testDb())
  const pending = await store.createPending({
    personaId: 'concierge',
    conversationId,
    tool: 'MEMO_CREATE',
    scopeKey: 'MEMO_CREATE',
    markerText: '[MEMO_CREATE]{"text":"runtime claim"}[/MEMO_CREATE]',
    summary: '메모 생성 "runtime claim"',
    userRequest: '메모 만들어줘',
    reversible: true,
    impact: '새 메모 1개가 만들어집니다.',
    expiresAt: FUTURE,
    createdAt: NOW.toISOString(),
  })
  expect(await store.resolveRequest(pending.id, 'approved', NOW)).toBe(true)
  return { store, approved: { ...pending, status: 'approved' as const } }
}

describe('0063 승인 실행 claim (miniflare 실 D1)', () => {
  beforeAll(async () => {
    const result = await applyAllMigrations()
    expect(result.failed).toHaveLength(0)
  })

  it('0063 컬럼이 실제로 존재한다', async () => {
    const cols = await testDb()
      .prepare("SELECT name FROM pragma_table_info('tool_approval_requests')")
      .all<{ name: string }>()
    const names = new Set((cols.results || []).map((r) => r.name))
    expect(names.has('executed_at')).toBe(true)
    expect(names.has('execution_result')).toBe(true)
  })

  it('동시 실행 2건 → 실제 D1에서 도구 실행 정확히 1회', async () => {
    const { approved } = await seedApproved(9201)
    let executions = 0
    const executor = async () => {
      await new Promise((r) => setTimeout(r, 0))
      executions += 1
      return '메모를 생성했어 (id: 77).'
    }
    const outcomes = await Promise.all([
      executeApprovedRequestOnce(testDb(), approved, executor, NOW),
      executeApprovedRequestOnce(testDb(), approved, executor, NOW),
    ])
    expect(executions).toBe(1)
    expect(outcomes.filter((o) => o.claimed)).toHaveLength(1)
    const blocked = outcomes.find((o) => !o.claimed)!
    // 동시 차단된 쪽이 읽는 시점에는 1차 실행이 기록 전일 수 있다(실행 중).
    // 완료 후 저장값은 아래 행 검증 + Jest 카나리아 2가 엄격히 검증한다.
    expect(blocked.resultText).toBeUndefined()

    const row = await testDb()
      .prepare('SELECT executed_at, execution_result FROM tool_approval_requests WHERE id = ?')
      .bind(approved.id)
      .first<{ executed_at: string | null; execution_result: string | null }>()
    expect(row?.executed_at).toBe(NOW.toISOString())
    expect(row?.execution_result).toBe('메모를 생성했어 (id: 77).')
  })

  it('실행 실패 → executed_at 유지 + 시도 기록, 재선점 불가', async () => {
    const { store, approved } = await seedApproved(9202)
    const outcome = await executeApprovedRequestOnce(
      testDb(),
      approved,
      async () => {
        throw new Error('runtime 도구 실패')
      },
      NOW,
    )
    expect(outcome.claimed).toBe(true)
    expect(outcome.error).toContain('runtime 도구 실패')
    expect(await store.claimExecution(approved.id, NOW)).toBe(false)
    const stored = await store.getRequestById(approved.id)
    expect(stored?.executedAt).toBe(NOW.toISOString())
    expect(stored?.executionResult).toContain('실행 시도 실패')
    expect(stored?.executionResult).toContain('runtime 도구 실패')
  })
})
