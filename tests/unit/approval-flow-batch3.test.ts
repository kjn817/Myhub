/// <reference types="jest" />
/**
 * src/services/approval-flow.ts 성질 테스트 (3차 배치 — 실제 SQLite).
 * approval-flow(-cov)와 겹치지 않는 영역: 저장 암호화 ON에서의 보호/복원
 * 왕복과 키 없음 fail-closed, 중복 생성의 원자 재사용(깨진 createdAt 포함),
 * cleanupApprovalRequests의 게이트·만료·삭제, executeApprovedRequestOnce의
 * 결과 정규화·미선점 폴백·기록 실패 내성, 일상 승인어의 제시 직후 요건.
 * 카나리아: protectInput의 암호화를 지우면 저장 행 평문 단언이,
 * cleanup의 암호화 게이트를 지우면 skipped 단언이 실패한다.
 */
import { createTestDb } from '../mcp-d1'
import {
  ToolApprovalRequestStore,
  cleanupApprovalRequests,
  executeApprovedRequestOnce,
  resolveApprovalReply,
  APPROVAL_TIMEOUT_MS,
  type CreatePendingInput,
} from '../../src/services/approval-flow'
import { encryptContent } from '../../src/services/crypto'

const KEY = 'approval-batch3-key-material'
const NOW = new Date('2026-11-08T01:00:00Z')
const FUTURE = new Date(NOW.getTime() + APPROVAL_TIMEOUT_MS).toISOString()

function pendingInput(over: Partial<CreatePendingInput> = {}): CreatePendingInput {
  return {
    personaId: 'keeper',
    conversationId: 1,
    tool: 'MEMO_DELETE',
    scopeKey: 'MEMO_DELETE:123',
    markerText: '[MEMO_DELETE]{"id":123}[/MEMO_DELETE]',
    summary: '메모 #123 삭제',
    userRequest: '그 메모 삭제해줘',
    reversible: false,
    impact: '영구 삭제됩니다',
    expiresAt: FUTURE,
    createdAt: NOW.toISOString(),
    ...over,
  }
}

function enableEncryption(db: any) {
  db.prepare("INSERT INTO ai_settings (key, value, updated_at) VALUES ('storage.protection', 'encrypted', '2026-11-08')").run()
}

describe('ToolApprovalRequestStore — 저장 암호화', () => {
  test('암호화 ON + 키 있음: 저장 행은 암호문이고 읽으면 원문으로 복원된다', async () => {
    const { db, d1 } = createTestDb()
    enableEncryption(db)
    const store = new ToolApprovalRequestStore(d1, { MEMO_ENCRYPTION_KEY: KEY })
    const created = await store.createPending(pendingInput())
    expect(created.markerText).toBe(pendingInput().markerText) // 반환값은 원문
    const raw = db.prepare('SELECT marker_text, user_request FROM tool_approval_requests WHERE id = ?').get(created.id) as any
    expect(raw.marker_text).not.toContain('MEMO_DELETE')
    expect(raw.marker_text.startsWith('ENC')).toBe(true)
    expect(raw.user_request).not.toContain('삭제해줘')
    const found = await store.findPendingByScope(1, 'MEMO_DELETE:123', NOW)
    expect(found?.markerText).toBe(pendingInput().markerText)
    expect(found?.userRequest).toBe('그 메모 삭제해줘')
    expect(found?.executionResult).toBeNull()
  })

  test('암호화 ON + 키 없음: 생성은 fail-closed로 던지고 행이 남지 않는다', async () => {
    const { db, d1 } = createTestDb()
    enableEncryption(db)
    const store = new ToolApprovalRequestStore(d1) // cryptoEnv 없음
    await expect(store.createPending(pendingInput())).rejects.toThrow('MEMO_ENCRYPTION_KEY not configured')
    const count = db.prepare('SELECT COUNT(*) AS n FROM tool_approval_requests').get() as any
    expect(count.n).toBe(0)
  })

  test('암호문 행을 키 없는 저장소로 읽으면 암호문을 원문처럼 넘기지 않고 던진다', async () => {
    const { db, d1 } = createTestDb()
    enableEncryption(db)
    const withKey = new ToolApprovalRequestStore(d1, { MEMO_ENCRYPTION_KEY: KEY })
    const created = await withKey.createPending(pendingInput())
    const noKey = new ToolApprovalRequestStore(d1)
    await expect(noKey.getRequestById(created.id)).rejects.toThrow('not configured for reveal')
    await expect(noKey.findNewestPending(1, NOW)).rejects.toThrow('not configured for reveal')
  })

  test('암호화 OFF면 키가 없어도 기존과 같이 평문으로 왕복한다', async () => {
    const { db, d1 } = createTestDb()
    const store = new ToolApprovalRequestStore(d1)
    expect(await store.encryptionEnabled()).toBe(false)
    const created = await store.createPending(pendingInput())
    const raw = db.prepare('SELECT marker_text FROM tool_approval_requests WHERE id = ?').get(created.id) as any
    expect(raw.marker_text).toBe(pendingInput().markerText)
  })
})

describe('createPending — 중복 범위의 원자 재사용', () => {
  test('같은 (대화, 범위) 두 번째 생성은 새 행을 만들지 않고 기존 건을 돌려준다', async () => {
    const { db, d1 } = createTestDb()
    const store = new ToolApprovalRequestStore(d1)
    const first = await store.createPending(pendingInput())
    const second = await store.createPending(pendingInput({ summary: '다른 요약' }))
    expect(second.id).toBe(first.id)
    expect(second.summary).toBe('메모 #123 삭제')
    const count = db.prepare('SELECT COUNT(*) AS n FROM tool_approval_requests').get() as any
    expect(count.n).toBe(1)
  })

  test('createdAt이 깨진 문자열이어도 중복 판정은 동작한다 (lookup 시각 폴백)', async () => {
    const { d1 } = createTestDb()
    const store = new ToolApprovalRequestStore(d1)
    // 깨진 createdAt이면 lookup 시각이 실제 현재 시각으로 폴백되므로,
    // 만료는 그보다 먼 미래로 둔다
    const first = await store.createPending(pendingInput({ expiresAt: '2027-06-01T00:00:00Z' }))
    const second = await store.createPending(pendingInput({ createdAt: '날짜아님', expiresAt: '2027-06-01T00:00:00Z' }))
    expect(second.id).toBe(first.id)
  })
})

describe('claimExecution / recordExecutionResult — 기본값과 암호화', () => {
  test('claimExecution은 now 기본값으로도 동작하고 두 번째 선점은 실패한다', async () => {
    const { d1 } = createTestDb()
    const store = new ToolApprovalRequestStore(d1)
    const created = await store.createPending(pendingInput())
    await store.resolveRequest(created.id, 'approved', NOW)
    expect(await store.claimExecution(created.id)).toBe(true)
    expect(await store.claimExecution(created.id)).toBe(false)
  })

  test('recordExecutionResult: null 요약은 빈 문자열로, 선점 전에는 기록되지 않는다', async () => {
    const { d1 } = createTestDb()
    const store = new ToolApprovalRequestStore(d1)
    const created = await store.createPending(pendingInput())
    // executed_at이 없으면 기록 불가
    expect(await store.recordExecutionResult(created.id, '요약')).toBe(false)
    await store.resolveRequest(created.id, 'approved', NOW)
    await store.claimExecution(created.id, NOW)
    expect(await store.recordExecutionResult(created.id, null as any)).toBe(true)
    const after = await store.getRequestById(created.id)
    expect(after?.executionResult).toBe('')
  })

  test('암호화 ON에서 실행 결과는 암호화 저장되고 복원돼 읽히며, 키 없이는 기록이 거부된다', async () => {
    const { db, d1 } = createTestDb()
    enableEncryption(db)
    const store = new ToolApprovalRequestStore(d1, { MEMO_ENCRYPTION_KEY: KEY })
    const created = await store.createPending(pendingInput())
    await store.resolveRequest(created.id, 'approved', NOW)
    await store.claimExecution(created.id, NOW)
    expect(await store.recordExecutionResult(created.id, '메모 5를 만들었어요')).toBe(true)
    const raw = db.prepare('SELECT execution_result FROM tool_approval_requests WHERE id = ?').get(created.id) as any
    expect(raw.execution_result).not.toContain('메모 5')
    const after = await store.getRequestById(created.id)
    expect(after?.executionResult).toBe('메모 5를 만들었어요')

    const noKey = new ToolApprovalRequestStore(d1)
    expect(await noKey.recordExecutionResult(created.id, '덮어쓰기 시도')).toBe(false)
    const still = await store.getRequestById(created.id)
    expect(still?.executionResult).toBe('메모 5를 만들었어요')
  })
})

describe('cleanupApprovalRequests — 암호화 게이트와 정리 범위', () => {
  test('암호화가 꺼져 있으면 skipped로 아무것도 지우지 않는다 (기본 인자)', async () => {
    const { db, d1 } = createTestDb()
    const store = new ToolApprovalRequestStore(d1)
    await store.createPending(pendingInput({ expiresAt: '2020-01-01T00:00:00Z' }))
    const r = await cleanupApprovalRequests(d1, undefined)
    expect(r).toEqual({ skipped: true, expired: 0, deleted: 0 })
    const count = db.prepare('SELECT COUNT(*) AS n FROM tool_approval_requests').get() as any
    expect(count.n).toBe(1)
  })

  test('암호화 ON: 만료된 pending은 expired로, 오래된 결정 건은 삭제된다', async () => {
    const { db, d1 } = createTestDb()
    enableEncryption(db)
    const store = new ToolApprovalRequestStore(d1, { MEMO_ENCRYPTION_KEY: KEY })
    // 만료 시각이 지난 pending 1건
    await store.createPending(pendingInput({ scopeKey: 'A:1', expiresAt: '2026-11-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z' }))
    // 오래 전에 거부된 건 1건 (보존 기간 30일 초과)
    const denied = await store.createPending(pendingInput({ scopeKey: 'B:2', conversationId: 2, expiresAt: '2026-12-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z' }))
    await store.resolveRequest(denied.id, 'denied', new Date('2026-10-02T00:00:00Z'))
    // 아직 유효한 pending 1건은 남아야 한다
    await store.createPending(pendingInput({ scopeKey: 'C:3', conversationId: 3, expiresAt: '2026-12-01T00:00:00Z', createdAt: NOW.toISOString() }))

    const r = await cleanupApprovalRequests(d1, { MEMO_ENCRYPTION_KEY: KEY }, NOW)
    expect(r.skipped).toBe(false)
    expect(r.expired).toBe(1)
    expect(r.deleted).toBe(1)
    const rows = db.prepare('SELECT scope_key, status FROM tool_approval_requests ORDER BY id').all() as any[]
    expect(rows).toEqual([
      { scope_key: 'A:1', status: 'expired' },
      { scope_key: 'C:3', status: 'pending' },
    ])
  })
})

describe('executeApprovedRequestOnce — 결과 정규화와 폴백', () => {
  async function approvedRequest(d1: D1Database) {
    const store = new ToolApprovalRequestStore(d1)
    const created = await store.createPending(pendingInput())
    await store.resolveRequest(created.id, 'approved', NOW)
    return created
  }

  test('결과 텍스트의 공백은 접어 요약하고, 빈 결과는 기본 문구로 기록한다', async () => {
    const { d1 } = createTestDb()
    const req = await approvedRequest(d1)
    const out = await executeApprovedRequestOnce(d1, req, async () => '메모를\n\n  만들었어요   ', NOW)
    expect(out.claimed).toBe(true)
    expect(out.executionResult).toBe('메모를 만들었어요')
    const stored = await new ToolApprovalRequestStore(d1).getRequestById(req.id)
    expect(stored?.executionResult).toBe('메모를 만들었어요')

    const { d1: d1b } = createTestDb()
    const reqB = await approvedRequest(d1b)
    const outB = await executeApprovedRequestOnce(d1b, reqB, async () => null as any, NOW)
    expect(outB.claimed).toBe(true)
    expect(outB.executionResult).toBeNull()
    const storedB = await new ToolApprovalRequestStore(d1b).getRequestById(reqB.id)
    expect(storedB?.executionResult).toBe('실행됨 (결과 텍스트 없음)')
  })

  test('executor가 문자열을 던져도 오류 문자열로 기록한다', async () => {
    const { d1 } = createTestDb()
    const req = await approvedRequest(d1)
    const out = await executeApprovedRequestOnce(d1, req, async () => { throw 'plain failure' }, NOW)
    expect(out.claimed).toBe(true)
    expect(out.error).toBe('plain failure')
    expect(out.executionResult).toBe('실행 시도 실패: plain failure')
  })

  test('미선점 시 저장된 건을 다시 읽어 돌려주고, 재조회가 실패하면 원본 요청으로 폴백한다', async () => {
    const { d1 } = createTestDb()
    const req = await approvedRequest(d1)
    const store = new ToolApprovalRequestStore(d1)
    await store.claimExecution(req.id, NOW)
    await store.recordExecutionResult(req.id, '이미 실행된 결과')
    const out = await executeApprovedRequestOnce(d1, req, async () => '다시 실행되면 안 됨', NOW)
    expect(out.claimed).toBe(false)
    expect(out.executionResult).toBe('이미 실행된 결과')
    expect(out.request.executionResult).toBe('이미 실행된 결과')

    // SELECT ... WHERE id = ? 가 던지는 DB — 재조회 실패 폴백
    const brokenDb: any = {
      prepare(sql: string) {
        if (sql.trimStart().startsWith('SELECT') && sql.includes('WHERE id = ?')) throw new Error('read down')
        return (d1 as any).prepare(sql)
      },
    }
    const out2 = await executeApprovedRequestOnce(brokenDb, req, async () => 'x', NOW)
    expect(out2.claimed).toBe(false)
    expect(out2.request).toBe(req)
    expect(out2.executionResult).toBe(req.executionResult ?? null)
  })

  test('실행 결과 기록이 실패해도 실행 결과 자체는 돌려준다', async () => {
    const { d1 } = createTestDb()
    const req = await approvedRequest(d1)
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const flakyDb: any = {
      prepare(sql: string) {
        if (sql.includes('SET execution_result')) throw new Error('write down')
        return (d1 as any).prepare(sql)
      },
    }
    const out = await executeApprovedRequestOnce(flakyDb, req, async () => '완료했어요', NOW)
    expect(out.claimed).toBe(true)
    expect(out.resultText).toBe('완료했어요')
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe('resolveApprovalReply — 일상 승인어의 제시 직후 요건', () => {
  async function seed(d1: D1Database) {
    const store = new ToolApprovalRequestStore(d1)
    return store.createPending(pendingInput())
  }

  test('직전 비서 메시지에 승인 안내나 요약이 없으면 일상어 승인은 무효다', async () => {
    const { d1 } = createTestDb()
    await seed(d1)
    const r = await resolveApprovalReply(d1, {
      conversationId: 1, personaId: 'keeper', reply: '응', now: NOW,
      messagesBeforeReply: [
        { role: 'user', content: '뭐 해?' },
        { role: 'assistant', content: '날씨가 좋네요' },
        { role: 'assistant', content: 42 },
      ],
    })
    expect(r.status).toBe('none')
  })

  test('직전 비서 메시지가 요약을 포함하면 일상어 승인도 유효하다', async () => {
    const { d1 } = createTestDb()
    await seed(d1)
    const r = await resolveApprovalReply(d1, {
      conversationId: 1, personaId: 'keeper', reply: '응', now: NOW,
      messagesBeforeReply: [
        { role: 'assistant', content: '메모 #123 삭제를 진행할까요?' },
      ],
    })
    expect(r.status).toBe('approved')
  })

  test('비서 메시지가 하나도 없으면 일상어 승인은 무효다', async () => {
    const { d1 } = createTestDb()
    await seed(d1)
    const r = await resolveApprovalReply(d1, {
      conversationId: 1, personaId: 'keeper', reply: '네', now: NOW,
      messagesBeforeReply: [{ role: 'user', content: '이전 대화' }],
    })
    expect(r.status).toBe('none')
  })
})
