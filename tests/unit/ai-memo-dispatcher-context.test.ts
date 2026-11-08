/// <reference types="jest" />
/**
 * 디스패처의 대화 문맥 업데이트 — 실제 memo-context 서비스 + 실제 SQLite 검증.
 *
 * (c) 정리(2026-11-08 최종 배치)로 ai-memo-tool-dispatcher.test.ts에서 이관.
 * 기존에는 updateMemoContext mock 호출 단언으로만 검증하던 성질을,
 * memo-context를 목하지 않고 0031 스키마의 실제 DB에 저장된 문맥
 * (getMemoContext 조회 결과)으로 단언한다.
 * 카나리아: 디스패처의 문맥 기록 분기를 끄면(예: memo_create 후 기록 제거)
 * 이 파일의 저장 단언이 실패함을 확인했다.
 */
import { dispatchToolCalls as dispatchToolCallsRaw } from '../../src/ai/memo-tool-dispatcher'
import { getMemoContext } from '../../src/services/memo-context'

const fs = require('fs')
const path = require('path')
const { createLocalD1 } = require('../helpers/local-d1.cjs')

const dispatchToolCalls = (env: any, calls: any[], ctx: any = {}) =>
  dispatchToolCallsRaw(env, calls, { personaId: 'keeper', origin: 'interactive' as const, ...ctx })

const mockValidateFCArgs = jest.fn()
jest.mock('../../src/ai/memo-fc-tools', () => ({
  ...jest.requireActual('../../src/ai/memo-fc-tools'),
  validateFCArgs: (...a: any[]) => mockValidateFCArgs(...a),
}))

const mockExecuteMemoCreate = jest.fn()
const mockExecuteMemoUpdate = jest.fn()
const mockExecuteMemoDelete = jest.fn()
const mockExecuteMemoSearch = jest.fn()
const mockExecuteMemoGet = jest.fn()
jest.mock('../../src/services/memo-tools', () => ({
  executeMemoCreate: (...a: any[]) => mockExecuteMemoCreate(...a),
  executeMemoUpdate: (...a: any[]) => mockExecuteMemoUpdate(...a),
  executeMemoDelete: (...a: any[]) => mockExecuteMemoDelete(...a),
  executeMemoSearch: (...a: any[]) => mockExecuteMemoSearch(...a),
  executeMemoGet: (...a: any[]) => mockExecuteMemoGet(...a),
}))

const mockSearchAnchor = jest.fn()
const mockGetLastUserMessage = jest.fn()
jest.mock('../../src/ai/source-preservation', () => ({
  searchAnchor: (...a: any[]) => mockSearchAnchor(...a),
  getLastUserMessage: (...a: any[]) => mockGetLastUserMessage(...a),
}))

const mockResolveMemoTarget = jest.fn()
jest.mock('../../src/services/memo-target-resolver', () => ({
  resolveMemoTarget: (...a: any[]) => mockResolveMemoTarget(...a),
}))

// memo-context는 목하지 않는다 — 실제 서비스가 실제 DB에 기록한다.
function makeEnv(withContextTable = true): any {
  const d1 = createLocalD1()
  if (withContextTable) {
    d1.exec(fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '0031_memo_context.sql'), 'utf8'))
  }
  return { DB: d1 }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockValidateFCArgs.mockReturnValue({ valid: true })
  mockExecuteMemoCreate.mockResolvedValue({ success: true, data: { memoId: 1 } })
  mockExecuteMemoUpdate.mockResolvedValue({ success: true, data: {} })
  mockExecuteMemoDelete.mockResolvedValue({ success: true, data: {} })
  mockExecuteMemoSearch.mockResolvedValue({ success: true, data: { memos: [] } })
  mockExecuteMemoGet.mockResolvedValue({ success: true, data: { id: 1, text: 't' } })
  mockGetLastUserMessage.mockReturnValue('사용자 원본 메시지')
  mockSearchAnchor.mockReturnValue({ found: true, extractedText: '추출된 텍스트' })
  mockResolveMemoTarget.mockResolvedValue({ ok: true, memoId: 9 })
})

describe('디스패처 → 실제 메모 문맥 저장', () => {
  test('memo_create 성공 + 문맥 있음 → last_created/last_target가 실제 저장된다', async () => {
    const env = makeEnv()
    await dispatchToolCalls(
      env,
      [{ name: 'memo_create', arguments: { text: 'a' } }],
      { userId: 'u', conversationId: 'c' },
    )
    const ctx = await getMemoContext(env, 'u', 'c')
    expect(ctx).not.toBeNull()
    expect(ctx!.last_created_memo_id).toBe(1)
    expect(ctx!.last_target_memo_id).toBe(1)
  })

  test('memo_get 성공 → last_target_memo_id가 call 인자 id로 저장된다', async () => {
    const env = makeEnv()
    mockExecuteMemoGet.mockResolvedValue({ success: true, data: {} })
    await dispatchToolCalls(
      env,
      [{ name: 'memo_get', arguments: { id: 7 } }],
      { userId: 'u', conversationId: 'c' },
    )
    const ctx = await getMemoContext(env, 'u', 'c')
    expect(ctx).not.toBeNull()
    expect(ctx!.last_target_memo_id).toBe(7)
  })

  test('memo_get 성공 → arguments.memo_id로도 last_target이 저장된다', async () => {
    const env = makeEnv()
    mockExecuteMemoGet.mockResolvedValue({ success: true, data: {} })
    await dispatchToolCalls(
      env,
      [{ name: 'memo_get', arguments: { memo_id: 42 } }],
      { userId: 'u', conversationId: 'c' },
    )
    const ctx = await getMemoContext(env, 'u', 'c')
    expect(ctx).not.toBeNull()
    expect(ctx!.last_target_memo_id).toBe(42)
  })

  test('memo_search 성공 → last_search_result_ids가 저장된다', async () => {
    const env = makeEnv()
    mockExecuteMemoSearch.mockResolvedValue({
      success: true,
      data: { memos: [{ id: 1 }, { id: 2 }] },
    })
    await dispatchToolCalls(
      env,
      [{ name: 'memo_search', arguments: { query: 'x' } }],
      { userId: 'u', conversationId: 'c' },
    )
    const ctx = await getMemoContext(env, 'u', 'c')
    expect(ctx).not.toBeNull()
    expect(ctx!.last_search_result_ids).toEqual([1, 2])
  })

  test('memo_search 성공 → data.ids로도 last_search_result_ids가 저장된다', async () => {
    const env = makeEnv()
    mockExecuteMemoSearch.mockResolvedValue({
      success: true,
      data: { ids: [5, 6] },
    })
    await dispatchToolCalls(
      env,
      [{ name: 'memo_search', arguments: { query: 'x' } }],
      { userId: 'u', conversationId: 'c' },
    )
    const ctx = await getMemoContext(env, 'u', 'c')
    expect(ctx).not.toBeNull()
    expect(ctx!.last_search_result_ids).toEqual([5, 6])
  })

  test('문맥 없음(사용자/대화 식별자 없음) → 문맥 행이 생기지 않는다', async () => {
    const env = makeEnv()
    await dispatchToolCalls(env, [{ name: 'memo_create', arguments: { text: 'a' } }])
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM memo_conversation_context').first()
    expect(row.n).toBe(0)
  })

  test('문맥 저장 실패(테이블 없음) → 무시하고 나머지 호출을 계속 실행한다', async () => {
    const env = makeEnv(false)
    const results = await dispatchToolCalls(
      env,
      [
        { name: 'memo_create', arguments: { text: 'a' } },
        { name: 'memo_create', arguments: { text: 'b' } },
      ],
      { userId: 'u', conversationId: 'c' },
    )
    expect(results).toHaveLength(2)
    expect(results[1].success).toBe(true)
  })

  test('memoId 없는 생성 결과 → 문맥이 저장되지 않는다', async () => {
    const env = makeEnv()
    mockExecuteMemoCreate.mockResolvedValue({ success: true, data: {} })
    await dispatchToolCalls(
      env,
      [{ name: 'memo_create', arguments: { text: 'a' } }],
      { userId: 'u', conversationId: 'c' },
    )
    expect(await getMemoContext(env, 'u', 'c')).toBeNull()
  })

  test('memo_get 성공 + id 없음 → 문맥이 저장되지 않는다', async () => {
    const env = makeEnv()
    mockExecuteMemoGet.mockResolvedValue({ success: true, data: {} })
    await dispatchToolCalls(
      env,
      [{ name: 'memo_get', arguments: {} }],
      { userId: 'u', conversationId: 'c' },
    )
    expect(await getMemoContext(env, 'u', 'c')).toBeNull()
  })

  test('memo_search 성공 + 결과 없음 → 문맥이 저장되지 않는다', async () => {
    const env = makeEnv()
    mockExecuteMemoSearch.mockResolvedValue({ success: true, data: {} })
    await dispatchToolCalls(
      env,
      [{ name: 'memo_search', arguments: { query: 'x' } }],
      { userId: 'u', conversationId: 'c' },
    )
    expect(await getMemoContext(env, 'u', 'c')).toBeNull()
  })
})
