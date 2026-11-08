/**
 * 승인 실행 claim 테스트 (0063, Talorys ②-0 — executed_at 원자 선점)
 *
 * 성질: status='approved'인 승인 건의 실제 도구 실행은 최대 1회다.
 * - 카나리아 1: 같은 승인 건 동시 실행 2건 → 도구 실행 정확히 1회,
 *   다른 1건은 already-executed + 저장된 결과 안내 재료 반환.
 *   (claimExecution의 원자 UPDATE를 무력화하면 이 테스트는 실패해야 한다)
 * - 카나리아 2: 실행 완료된 승인의 재실행 시도 → 거부 + 재실행 없음 +
 *   저장된 execution_result 안내.
 * - 카나리아 3: 실행 중 실패 → executed_at 유지(자동 재시도 불가) +
 *   execution_result에 시도 기록.
 * - 경계: pending/denied 건은 claim 불가, 선점 전에는 결과 기록 불가.
 */
import {
  ToolApprovalRequestStore,
  executeApprovedRequestOnce,
  APPROVAL_TIMEOUT_MS,
  type PendingApprovalRequest,
} from '../src/services/approval-flow'
import { FakeD1, asD1 } from './fake-d1'

const NOW = new Date('2026-10-30T02:00:00Z')
const FUTURE = new Date(NOW.getTime() + APPROVAL_TIMEOUT_MS).toISOString()

function makeStore() {
  const fake = new FakeD1()
  const db = asD1(fake)
  return { fake, db, requests: new ToolApprovalRequestStore(db) }
}

async function seedApproved(requests: ToolApprovalRequestStore): Promise<PendingApprovalRequest> {
  const pending = await requests.createPending({
    personaId: 'concierge',
    conversationId: 1,
    tool: 'MEMO_CREATE',
    scopeKey: 'MEMO_CREATE',
    markerText: '[MEMO_CREATE]{"text":"hello"}[/MEMO_CREATE]',
    summary: '메모 생성 "hello"',
    userRequest: '메모 만들어줘',
    reversible: true,
    impact: '새 메모 1개가 만들어집니다.',
    expiresAt: FUTURE,
    createdAt: NOW.toISOString(),
  })
  expect(await requests.resolveRequest(pending.id, 'approved', NOW)).toBe(true)
  return { ...pending, status: 'approved' }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('승인 실행 claim (0063)', () => {
  test('카나리아 1: 동시 실행 2건 → 도구 실행 정확히 1회, 다른 1건은 이미 실행됨 + 저장된 결과', async () => {
    const { fake, db, requests } = makeStore()
    const approved = await seedApproved(requests)

    let executions = 0
    const executor = async () => {
      // 비동기 경계: claim이 없으면 두 호출이 모두 이 지점을 통과한다
      await tick()
      executions += 1
      return '메모를 생성했어 (id: 9).'
    }

    const [a, b] = await Promise.all([
      executeApprovedRequestOnce(db, approved, executor, NOW),
      executeApprovedRequestOnce(db, approved, executor, NOW),
    ])

    expect(executions).toBe(1)
    const claimed = [a, b].filter((o) => o.claimed)
    const blocked = [a, b].filter((o) => !o.claimed)
    expect(claimed).toHaveLength(1)
    expect(claimed[0].resultText).toBe('메모를 생성했어 (id: 9).')
    expect(blocked).toHaveLength(1)
    // 동시 차단된 쪽이 결과를 읽는 시점에는 1차 실행이 아직 기록 전일 수
    // 있다 (실행 중). 완료 후 저장값 안내는 카나리아 2가 엄격히 검증한다.
    expect(blocked[0].resultText).toBeUndefined()

    const row = fake.tables.tool_approval_requests[0]
    expect(row.executed_at).toBe(NOW.toISOString())
    expect(row.execution_result).toBe('메모를 생성했어 (id: 9).')
  })

  test('카나리아 2: 실행 완료된 승인의 재실행 시도 → 거부 + 도구 재실행 없음 + 저장된 결과 안내', async () => {
    const { db, requests } = makeStore()
    const approved = await seedApproved(requests)

    let executions = 0
    const executor = async () => {
      executions += 1
      return '메모를 생성했어 (id: 9).'
    }
    const first = await executeApprovedRequestOnce(db, approved, executor, NOW)
    expect(first.claimed).toBe(true)
    expect(executions).toBe(1)

    const second = await executeApprovedRequestOnce(db, approved, executor, NOW)
    expect(second.claimed).toBe(false)
    expect(second.resultText).toBeUndefined()
    expect(executions).toBe(1)
    expect(second.executionResult).toBe('메모를 생성했어 (id: 9).')
    // 직접 claim도 두 번째는 실패한다
    expect(await requests.claimExecution(approved.id, NOW)).toBe(false)
  })

  test('카나리아 3: 실행 중 실패 → executed_at 유지(재시도 불가) + execution_result에 시도 기록', async () => {
    const { fake, db, requests } = makeStore()
    const approved = await seedApproved(requests)

    let executions = 0
    const failing = async () => {
      executions += 1
      throw new Error('도구 실행 중 DB 오류')
    }
    const outcome = await executeApprovedRequestOnce(db, approved, failing, NOW)
    expect(outcome.claimed).toBe(true)
    expect(outcome.error).toContain('도구 실행 중 DB 오류')
    expect(executions).toBe(1)

    const row = fake.tables.tool_approval_requests[0]
    // executed_at은 되돌려지지 않는다 — 자동 재시도 불가 상태
    expect(row.executed_at).toBe(NOW.toISOString())
    expect(row.execution_result).toContain('실행 시도 실패')
    expect(row.execution_result).toContain('도구 실행 중 DB 오류')

    // 실패 후 재시도 시도도 claim에 막힌다 (새 승인 건이 필요한 상태)
    const retry = await executeApprovedRequestOnce(db, approved, failing, NOW)
    expect(retry.claimed).toBe(false)
    expect(retry.executionResult).toContain('실행 시도 실패')
    expect(executions).toBe(1)
  })

  test('경계: pending·denied 건은 claim 불가, 선점 전 결과 기록도 불가', async () => {
    const { requests } = makeStore()
    const pending = await requests.createPending({
      personaId: 'concierge',
      conversationId: 1,
      tool: 'MEMO_CREATE',
      scopeKey: 'MEMO_CREATE',
      markerText: '[MEMO_CREATE]{"text":"x"}[/MEMO_CREATE]',
      summary: '메모 생성 "x"',
      userRequest: '메모 만들어줘',
      reversible: true,
      impact: '새 메모 1개',
      expiresAt: FUTURE,
      createdAt: NOW.toISOString(),
    })
    expect(await requests.claimExecution(pending.id, NOW)).toBe(false)
    expect(await requests.recordExecutionResult(pending.id, '실행됨')).toBe(false)

    expect(await requests.resolveRequest(pending.id, 'denied', NOW)).toBe(true)
    expect(await requests.claimExecution(pending.id, NOW)).toBe(false)
  })

  test('getRequestById: 선점·기록 후 실행 상태를 그대로 읽는다', async () => {
    const { db, requests } = makeStore()
    const approved = await seedApproved(requests)
    const before = await requests.getRequestById(approved.id)
    expect(before?.status).toBe('approved')
    expect(before?.executedAt).toBeNull()
    expect(before?.executionResult).toBeNull()

    await executeApprovedRequestOnce(db, approved, async () => '일정을 등록했어 (id: 3).', NOW)
    const after = await requests.getRequestById(approved.id)
    expect(after?.executedAt).toBe(NOW.toISOString())
    expect(after?.executionResult).toBe('일정을 등록했어 (id: 3).')
    expect(await requests.getRequestById(99999)).toBeNull()
  })
})
