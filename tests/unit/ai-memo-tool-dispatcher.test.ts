/// <reference types="jest" />
/**
 * src/ai/memo-tool-dispatcher.ts — 메모 FC 도구 디스패처 단위 테스트
 *
 * 전략: memo-fc-tools/services/memo-tools/source-preservation 및
 * 동적 import 2개(memo-context, memo-target-resolver)를 전부 jest.mock.
 * 내부 데드 함수 4개(executeMemoUpdateFromSource/executeMemoOpen/
 * executeMemoClose/executeMemoFormat)는 도달 불가 — 문서화.
 * 소스 수정 없음.
 *
 * 커버리지 상한 (도달 불가 코드):
 * - 36행: normalizeText의 catch — String() 변환 후 원시 문자열의
 *   normalize('NFC')는 throw하지 않음 (방어 코드)
 * - 179행: switch default — validTools 사전 검증으로 도달 불가
 * - 358-455행: executeMemoUpdateFromSource — export되지 않고
 *   어디서도 호출되지 않는 데드 코드
 * - 606-691행: executeMemoFormat — 동상
 * - executeMemoOpen/executeMemoClose — 동상 (데드 코드)
 */
import {
  dispatchToolCall,
  dispatchToolCalls,
} from '../../src/ai/memo-tool-dispatcher'

const mockValidateFCArgs = jest.fn()
jest.mock('../../src/ai/memo-fc-tools', () => ({
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

const mockUpdateMemoContext = jest.fn()
jest.mock('../../src/services/memo-context', () => ({
  updateMemoContext: (...a: any[]) => mockUpdateMemoContext(...a),
}))

const mockResolveMemoTarget = jest.fn()
jest.mock('../../src/services/memo-target-resolver', () => ({
  resolveMemoTarget: (...a: any[]) => mockResolveMemoTarget(...a),
}))

const env = { DB: {} } as any

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
  mockUpdateMemoContext.mockResolvedValue(undefined)
})

describe('dispatchToolCall', () => {
  test('알 수 없는 도구 → 거부', async () => {
    const r = await dispatchToolCall(env, { name: 'evil', arguments: {} })
    expect(r.success).toBe(false)
    expect(r.error).toContain('Unknown tool')
    expect(r.toolName).toBe('evil')
  })

  test('인자 검증 실패 → 에러', async () => {
    mockValidateFCArgs.mockReturnValue({ valid: false, error: 'bad args' })
    const r = await dispatchToolCall(env, { name: 'memo_create', arguments: {} })
    expect(r.success).toBe(false)
    expect(r.error).toBe('bad args')
    expect(mockExecuteMemoCreate).not.toHaveBeenCalled()
  })

  test('memo_create → 텍스트 정규화 후 실행', async () => {
    const r = await dispatchToolCall(env, {
      name: 'memo_create',
      arguments: { text: '  hello  ' },
    })
    expect(r.success).toBe(true)
    expect(mockExecuteMemoCreate).toHaveBeenCalledWith(env, 'hello')
    expect(r.data).toEqual({ memoId: 1 })
  })

  test('memo_create 비문자열 텍스트 → 문자열 변환', async () => {
    await dispatchToolCall(env, { name: 'memo_create', arguments: { text: 12345 } })
    expect(mockExecuteMemoCreate).toHaveBeenCalledWith(env, '12345')
  })

  test('memo_create null 텍스트 → 빈 문자열', async () => {
    await dispatchToolCall(env, { name: 'memo_create', arguments: { text: null } })
    expect(mockExecuteMemoCreate).toHaveBeenCalledWith(env, '')
  })

  test('도구 실행 결과 success=false → 그대로 전달', async () => {
    mockExecuteMemoCreate.mockResolvedValue({ success: false, error: 'DB fail' })
    const r = await dispatchToolCall(env, {
      name: 'memo_create',
      arguments: { text: 'x' },
    })
    expect(r.success).toBe(false)
    expect(r.error).toBe('DB fail')
  })

  test('잘못된 도구 결과 형식 → Invalid tool result format', async () => {
    mockExecuteMemoCreate.mockResolvedValue({ weird: true } as any)
    const r = await dispatchToolCall(env, {
      name: 'memo_create',
      arguments: { text: 'x' },
    })
    expect(r.success).toBe(false)
    expect(r.error).toBe('Invalid tool result format')
  })

  test('도구 실행 throw → Execution failed', async () => {
    mockExecuteMemoCreate.mockRejectedValue(new Error('kaboom'))
    const r = await dispatchToolCall(env, {
      name: 'memo_create',
      arguments: { text: 'x' },
    })
    expect(r.success).toBe(false)
    expect(r.error).toContain('kaboom')
  })

  describe('memo_create_from_source', () => {
    const call = (args: any, ctx?: any) =>
      dispatchToolCall(env, { name: 'memo_create_from_source', arguments: args }, ctx)

    test('원본 메시지 없음 → 실패', async () => {
      const r = await call({ source_text: 'x' })
      expect(r.success).toBe(false)
      expect(r.error).toContain('Original messages not available')
    })

    test('빈 원본 메시지 → 실패', async () => {
      const r = await call({ source_text: 'x' }, { originalMessages: [] })
      expect(r.success).toBe(false)
    })

    test('사용자 메시지 없음 → 실패', async () => {
      mockGetLastUserMessage.mockReturnValue(null)
      const r = await call(
        { source_text: 'x' },
        { originalMessages: [{ role: 'user', content: 'y' }] }
      )
      expect(r.success).toBe(false)
      expect(r.error).toContain('No user message')
    })

    test('source_text 비문자열 → 실패', async () => {
      const r = await call({ source_text: 123 }, { originalMessages: [{ role: 'user', content: 'y' }] })
      expect(r.success).toBe(false)
      expect(r.error).toContain('non-empty string')
    })

    test('source_text 빈 문자열 → 실패', async () => {
      const r = await call({ source_text: '   ' }, { originalMessages: [{ role: 'user', content: 'y' }] })
      expect(r.success).toBe(false)
    })

    test('앵커 NOT_FOUND → 실패', async () => {
      mockSearchAnchor.mockReturnValue({ found: false, reason: 'NOT_FOUND' })
      const r = await call({ source_text: 'x' }, { originalMessages: [{ role: 'user', content: 'y' }] })
      expect(r.success).toBe(false)
      expect(r.error).toContain('not found')
    })

    test('앵커 MULTIPLE_MATCHES → 실패', async () => {
      mockSearchAnchor.mockReturnValue({ found: false, reason: 'MULTIPLE_MATCHES' })
      const r = await call({ source_text: 'x' }, { originalMessages: [{ role: 'user', content: 'y' }] })
      expect(r.success).toBe(false)
      expect(r.error).toContain('multiple')
    })

    test('앵커 EMPTY_ANCHOR → 실패', async () => {
      mockSearchAnchor.mockReturnValue({ found: false, reason: 'EMPTY_ANCHOR' })
      const r = await call({ source_text: 'x' }, { originalMessages: [{ role: 'user', content: 'y' }] })
      expect(r.success).toBe(false)
      expect(r.error).toContain('empty')
    })

    test('앵커 알 수 없는 reason → 기본 메시지', async () => {
      mockSearchAnchor.mockReturnValue({ found: false, reason: 'WEIRD' })
      const r = await call({ source_text: 'x' }, { originalMessages: [{ role: 'user', content: 'y' }] })
      expect(r.success).toBe(false)
      expect(r.error).toBe('Source text validation failed')
    })

    test('앵커 reason 없음 → NOT_FOUND 기본값 사용', async () => {
      mockSearchAnchor.mockReturnValue({ found: false })
      const r = await call({ source_text: 'x' }, { originalMessages: [{ role: 'user', content: 'y' }] })
      expect(r.success).toBe(false)
      // reason || 'NOT_FOUND' → NOT_FOUND 메시지
      expect(r.error).toContain('not found')
    })

    test('앵커 발견 → 추출 텍스트로 메모 생성', async () => {
      const r = await call(
        { source_text: '추출' },
        { originalMessages: [{ role: 'user', content: '사용자 원본 메시지' }] }
      )
      expect(r.success).toBe(true)
      expect(mockExecuteMemoCreate).toHaveBeenCalledWith(env, '추출된 텍스트')
      expect(mockSearchAnchor).toHaveBeenCalledWith('사용자 원본 메시지', '추출')
    })
  })

  describe('memo_search', () => {
    test('일반 검색 → executeMemoSearch', async () => {
      await dispatchToolCall(env, { name: 'memo_search', arguments: { query: '회의' } })
      expect(mockExecuteMemoSearch).toHaveBeenCalledWith(env, '회의')
      expect(mockResolveMemoTarget).not.toHaveBeenCalled()
    })

    test('상대 참조(방금) → resolveMemoTarget 성공 시 memo_get', async () => {
      const r = await dispatchToolCall(env, {
        name: 'memo_search',
        arguments: { query: '방금 만든 메모' },
      })
      expect(mockResolveMemoTarget).toHaveBeenCalled()
      expect(mockExecuteMemoGet).toHaveBeenCalledWith(env, 9)
      expect(mockExecuteMemoSearch).not.toHaveBeenCalled()
      expect(r.success).toBe(true)
    })

    test('상대 참조(이 메모) 패턴', async () => {
      const r = await dispatchToolCall(env, { name: 'memo_search', arguments: { query: '이 메모 보여줘' } })
      expect(mockResolveMemoTarget).toHaveBeenCalledWith(
        env,
        { kind: 'last_target' },
        { userId: 'default', conversationId: 'default' }
      )
      expect(mockExecuteMemoGet).toHaveBeenCalledWith(env, 9)
      expect(mockExecuteMemoSearch).not.toHaveBeenCalled()
      expect(r.success).toBe(true)
      expect(r.data).toEqual({ id: 1, text: 't' })
    })

    test('상대 참조(그 메모/최근) 패턴', async () => {
      const r1 = await dispatchToolCall(env, { name: 'memo_search', arguments: { query: '그 메모' } })
      expect(mockResolveMemoTarget).toHaveBeenCalledWith(
        env,
        { kind: 'last_target' },
        { userId: 'default', conversationId: 'default' }
      )
      expect(mockExecuteMemoGet).toHaveBeenCalledWith(env, 9)
      expect(mockExecuteMemoSearch).not.toHaveBeenCalled()
      expect(r1.success).toBe(true)
      expect(r1.data).toEqual({ id: 1, text: 't' })
      jest.clearAllMocks()
      mockValidateFCArgs.mockReturnValue({ valid: true })
      const r2 = await dispatchToolCall(env, { name: 'memo_search', arguments: { query: '최근 메모' } })
      expect(mockResolveMemoTarget).toHaveBeenCalledWith(
        env,
        { kind: 'last_target' },
        { userId: 'default', conversationId: 'default' }
      )
      expect(mockExecuteMemoGet).toHaveBeenCalledWith(env, 9)
      expect(mockExecuteMemoSearch).not.toHaveBeenCalled()
      expect(r2.success).toBe(true)
      expect(r2.data).toEqual({ id: 1, text: 't' })
    })

    test('resolve 실패(not ok) → 일반 검색 폴백', async () => {
      mockResolveMemoTarget.mockResolvedValue({ ok: false })
      const r = await dispatchToolCall(env, {
        name: 'memo_search',
        arguments: { query: '방금 메모' },
      })
      expect(mockExecuteMemoSearch).toHaveBeenCalledWith(env, '방금 메모')
      expect(mockExecuteMemoGet).not.toHaveBeenCalled()
      expect(r.success).toBe(true)
      expect(r.data).toEqual({ memos: [] })
    })

    test('resolve throw → 일반 검색 폴백', async () => {
      mockResolveMemoTarget.mockRejectedValue(new Error('x'))
      const r = await dispatchToolCall(env, {
        name: 'memo_search',
        arguments: { query: '방금 메모' },
      })
      expect(mockExecuteMemoSearch).toHaveBeenCalledWith(env, '방금 메모')
      expect(mockExecuteMemoGet).not.toHaveBeenCalled()
      expect(r.success).toBe(true)
      expect(r.data).toEqual({ memos: [] })
    })

    test('resolve ok지만 memoId 없음 → 일반 검색 폴백', async () => {
      mockResolveMemoTarget.mockResolvedValue({ ok: true })
      const r = await dispatchToolCall(env, {
        name: 'memo_search',
        arguments: { query: '방금 메모' },
      })
      expect(mockExecuteMemoSearch).toHaveBeenCalledWith(env, '방금 메모')
      expect(mockExecuteMemoGet).not.toHaveBeenCalled()
      expect(r.success).toBe(true)
      expect(r.data).toEqual({ memos: [] })
    })
  })

  describe('memo_get / memo_delete', () => {
    test('memo_get → executeMemoGet', async () => {
      const r = await dispatchToolCall(env, { name: 'memo_get', arguments: { id: 5 } })
      expect(mockExecuteMemoGet).toHaveBeenCalledWith(env, 5)
      expect(r.success).toBe(true)
    })

    test('memo_delete: id 비숫자 → 실패', async () => {
      const r = await dispatchToolCall(env, {
        name: 'memo_delete',
        arguments: { id: 'abc' },
      })
      expect(r.success).toBe(false)
      expect(r.error).toContain('must be a number')
    })

    test('memo_delete: 메모 없음 → getResult 그대로 반환', async () => {
      mockExecuteMemoGet.mockResolvedValue({ success: false, error: 'not found' })
      const r = await dispatchToolCall(env, { name: 'memo_delete', arguments: { id: 9 } })
      expect(r.success).toBe(false)
      expect(r.error).toBe('not found')
    })

    test('memo_delete: 확인 요청 반환 (실제 삭제 안 함)', async () => {
      mockExecuteMemoGet.mockResolvedValue({
        success: true,
        data: { id: 9, text: '삭제할 메모 내용입니다' },
      })
      const r = await dispatchToolCall(env, { name: 'memo_delete', arguments: { id: 9 } })
      expect(r.success).toBe(true)
      expect(r.data.requiresConfirmation).toBe(true)
      expect(r.data.status).toBe('confirmation_required')
      expect(r.data.uiAction).toBe('confirm_delete')
      expect(r.data.message).toContain('9')
      expect(mockExecuteMemoDelete).not.toHaveBeenCalled()
    })

    test('memo_delete: content 필드 메모도 미리보기', async () => {
      mockExecuteMemoGet.mockResolvedValue({
        success: true,
        data: { id: 9, content: 'content 필드' },
      })
      const r = await dispatchToolCall(env, { name: 'memo_delete', arguments: { id: 9 } })
      expect(r.data.message).toContain('content 필드')
    })
  })

  describe('memo_ui_action', () => {
    test('잘못된 action → 실패', async () => {
      const r = await dispatchToolCall(env, {
        name: 'memo_ui_action',
        arguments: { action: 'explode', memo_id: 1 },
      })
      expect(r.success).toBe(false)
      expect(r.error).toContain('Invalid action')
    })

    test('open 성공 → open_memo 액션', async () => {
      const r = await dispatchToolCall(env, {
        name: 'memo_ui_action',
        arguments: { action: 'open', memo_id: 3 },
      })
      expect(r.success).toBe(true)
      expect(r.data.uiAction).toBe('open_memo')
      expect(r.data.status).toBe('ui_pending')
      expect(r.data.action).toBe('open')
    })

    test('open + 메모 없음 → 실패', async () => {
      mockExecuteMemoGet.mockResolvedValue({ success: false, error: 'nope' })
      const r = await dispatchToolCall(env, {
        name: 'memo_ui_action',
        arguments: { action: 'open', memo_id: 3 },
      })
      expect(r.success).toBe(false)
      expect(r.error).toBe('nope')
    })

    test('close는 memo_id 없이 동작', async () => {
      const r = await dispatchToolCall(env, {
        name: 'memo_ui_action',
        arguments: { action: 'close' },
      })
      expect(r.success).toBe(true)
      expect(r.data.uiAction).toBe('close_memo')
      expect(mockExecuteMemoGet).not.toHaveBeenCalled()
    })

    test('close + memo_id 지정 → 검증 없이 액션 반환', async () => {
      const r = await dispatchToolCall(env, {
        name: 'memo_ui_action',
        arguments: { action: 'close', memo_id: 3 },
      })
      expect(r.success).toBe(true)
      expect(mockExecuteMemoGet).not.toHaveBeenCalled()
    })

    test('start_edit → start_edit_memo', async () => {
      const r = await dispatchToolCall(env, {
        name: 'memo_ui_action',
        arguments: { action: 'start_edit', memo_id: 3 },
      })
      expect(r.success).toBe(true)
      expect(r.data.uiAction).toBe('start_edit_memo')
    })

    test('start_format → start_format_memo', async () => {
      const r = await dispatchToolCall(env, {
        name: 'memo_ui_action',
        arguments: { action: 'start_format', memo_id: 3 },
      })
      expect(r.success).toBe(true)
      expect(r.data.uiAction).toBe('start_format_memo')
    })

    test('memo_id 없음 → resolveMemoTarget으로 해석', async () => {
      const r = await dispatchToolCall(
        env,
        { name: 'memo_ui_action', arguments: { action: 'open' } },
        { userId: 'u', conversationId: 'c' }
      )
      expect(mockResolveMemoTarget).toHaveBeenCalled()
      expect(r.success).toBe(true)
      expect(r.data.memoId).toBe(9)
    })

    test('memo_id 해석 실패 → 에러', async () => {
      mockResolveMemoTarget.mockResolvedValue({ ok: false })
      const r = await dispatchToolCall(
        env,
        { name: 'memo_ui_action', arguments: { action: 'open' } },
        { userId: 'u', conversationId: 'c' }
      )
      expect(r.success).toBe(false)
      expect(r.error).toContain('memo_id must be a number')
    })

    test('memo_id 해석 중 throw → 에러', async () => {
      mockResolveMemoTarget.mockRejectedValue(new Error('x'))
      const r = await dispatchToolCall(
        env,
        { name: 'memo_ui_action', arguments: { action: 'open' } },
        { userId: 'u', conversationId: 'c' }
      )
      expect(r.success).toBe(false)
    })
  })

  test('traceId 전달 → console.log 호출 (에러 아님)', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const r = await dispatchToolCall(
      env,
      { name: 'memo_create', arguments: { text: 'x' } },
      { traceId: 't1' }
    )
    expect(r.success).toBe(true)
    // traceId가 로그 라인의 접두사로 들어가고, 디스패치 시작이 기록된다
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[t1]'))
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('DISPATCH_STARTED'))
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('tool=memo_create'))
    spy.mockRestore()
  })

  test('args가 객체가 아니면 argTypes 스킵', async () => {
    const r = await dispatchToolCall(env, { name: 'memo_create', arguments: 'str' })
    expect(r.success).toBe(true)
  })
})

describe('dispatchToolCalls', () => {
  test('여러 호출 순차 실행', async () => {
    const results = await dispatchToolCalls(env, [
      { name: 'memo_create', arguments: { text: 'a' } },
      { name: 'memo_create', arguments: { text: 'b' } },
    ])
    expect(results).toHaveLength(2)
    expect(results[0].success).toBe(true)
    expect(results[1].success).toBe(true)
    expect(mockExecuteMemoCreate).toHaveBeenCalledTimes(2)
  })

  test('최대 3개로 제한', async () => {
    const calls = [1, 2, 3, 4, 5].map((i) => ({
      name: 'memo_create',
      arguments: { text: `t${i}` },
    }))
    const results = await dispatchToolCalls(env, calls)
    expect(results).toHaveLength(3)
    expect(mockExecuteMemoCreate).toHaveBeenCalledTimes(3)
  })

  test('실패 시 중단', async () => {
    mockExecuteMemoCreate
      .mockResolvedValueOnce({ success: false, error: 'fail' })
      .mockResolvedValue({ success: true, data: {} })
    const results = await dispatchToolCalls(env, [
      { name: 'memo_create', arguments: { text: 'a' } },
      { name: 'memo_create', arguments: { text: 'b' } },
    ])
    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(false)
  })

  test('성공 + 문맥 있음 → memo_create 문맥 업데이트', async () => {
    await dispatchToolCalls(
      env,
      [{ name: 'memo_create', arguments: { text: 'a' } }],
      { userId: 'u', conversationId: 'c' }
    )
    expect(mockUpdateMemoContext).toHaveBeenCalledWith(env, 'u', 'c', {
      last_created_memo_id: 1,
      last_target_memo_id: 1,
    })
  })

  test('memo_get 성공 → last_target_memo_id 업데이트 (call 인자 id 사용)', async () => {
    mockExecuteMemoGet.mockResolvedValue({ success: true, data: {} })
    await dispatchToolCalls(
      env,
      [{ name: 'memo_get', arguments: { id: 7 } }],
      { userId: 'u', conversationId: 'c' }
    )
    expect(mockUpdateMemoContext).toHaveBeenCalledWith(env, 'u', 'c', {
      last_target_memo_id: 7,
    })
  })

  test('memo_search 성공 → last_search_result_ids 업데이트', async () => {
    mockExecuteMemoSearch.mockResolvedValue({
      success: true,
      data: { memos: [{ id: 1 }, { id: 2 }] },
    })
    await dispatchToolCalls(
      env,
      [{ name: 'memo_search', arguments: { query: 'x' } }],
      { userId: 'u', conversationId: 'c' }
    )
    expect(mockUpdateMemoContext).toHaveBeenCalledWith(env, 'u', 'c', {
      last_search_result_ids: [1, 2],
    })
  })

  test('문맥 없음 → 업데이트 스킵', async () => {
    await dispatchToolCalls(env, [{ name: 'memo_create', arguments: { text: 'a' } }])
    expect(mockUpdateMemoContext).not.toHaveBeenCalled()
  })

  test('문맥 업데이트 실패 → 무시하고 계속', async () => {
    mockUpdateMemoContext.mockRejectedValue(new Error('ctx fail'))
    const results = await dispatchToolCalls(
      env,
      [
        { name: 'memo_create', arguments: { text: 'a' } },
        { name: 'memo_create', arguments: { text: 'b' } },
      ],
      { userId: 'u', conversationId: 'c' }
    )
    expect(results).toHaveLength(2)
    expect(results[1].success).toBe(true)
  })

  test('memoId 없는 생성 결과 → 업데이트 스킵', async () => {
    mockExecuteMemoCreate.mockResolvedValue({ success: true, data: {} })
    await dispatchToolCalls(
      env,
      [{ name: 'memo_create', arguments: { text: 'a' } }],
      { userId: 'u', conversationId: 'c' }
    )
    expect(mockUpdateMemoContext).not.toHaveBeenCalled()
  })
})

describe('branch 커버리지 추가 (실제 테스트)', () => {
  test('normalizeText: normalize throw → trim 폴백', async () => {
    const origNormalize = String.prototype.normalize
    try {
      String.prototype.normalize = function () {
        throw new Error('normalize disabled')
      } as any
      const r = await dispatchToolCall(env, {
        name: 'memo_create',
        arguments: { text: '  hi  ' },
      })
      expect(r.success).toBe(true)
      expect(mockExecuteMemoCreate).toHaveBeenCalledWith(env, 'hi')
    } finally {
      String.prototype.normalize = origNormalize
    }
  })

  test('도구 실행 throw(문자열, message 없음) → e 그대로 사용', async () => {
    mockExecuteMemoCreate.mockRejectedValue('plain string failure')
    const r = await dispatchToolCall(env, {
      name: 'memo_create',
      arguments: { text: 'x' },
    })
    expect(r.success).toBe(false)
    expect(r.error).toContain('plain string failure')
  })

  test('memo_get 성공 → arguments.memo_id로 문맥 업데이트', async () => {
    mockExecuteMemoGet.mockResolvedValue({ success: true, data: {} })
    await dispatchToolCalls(
      env,
      [{ name: 'memo_get', arguments: { memo_id: 42 } }],
      { userId: 'u', conversationId: 'c' }
    )
    expect(mockUpdateMemoContext).toHaveBeenCalledWith(env, 'u', 'c', {
      last_target_memo_id: 42,
    })
  })

  test('memo_get 성공 + id 없음 → 문맥 업데이트 스킵', async () => {
    mockExecuteMemoGet.mockResolvedValue({ success: true, data: {} })
    await dispatchToolCalls(
      env,
      [{ name: 'memo_get', arguments: {} }],
      { userId: 'u', conversationId: 'c' }
    )
    expect(mockUpdateMemoContext).not.toHaveBeenCalled()
  })

  test('memo_search 성공 → data.ids로 문맥 업데이트 (memos 없음)', async () => {
    mockExecuteMemoSearch.mockResolvedValue({
      success: true,
      data: { ids: [5, 6] },
    })
    await dispatchToolCalls(
      env,
      [{ name: 'memo_search', arguments: { query: 'x' } }],
      { userId: 'u', conversationId: 'c' }
    )
    expect(mockUpdateMemoContext).toHaveBeenCalledWith(env, 'u', 'c', {
      last_search_result_ids: [5, 6],
    })
  })

  test('memo_search 성공 + 결과 없음 → 문맥 업데이트 스킵', async () => {
    mockExecuteMemoSearch.mockResolvedValue({ success: true, data: {} })
    await dispatchToolCalls(
      env,
      [{ name: 'memo_search', arguments: { query: 'x' } }],
      { userId: 'u', conversationId: 'c' }
    )
    expect(mockUpdateMemoContext).not.toHaveBeenCalled()
  })

  test('memo_delete: text/content 없음 → 빈 미리보기', async () => {
    mockExecuteMemoGet.mockResolvedValue({
      success: true,
      data: { id: 9 },
    })
    const r = await dispatchToolCall(env, { name: 'memo_delete', arguments: { id: 9 } })
    expect(r.success).toBe(true)
    expect(r.data.message).toContain('9("...")')
  })

  test('memo_ui_action: ctx 없음 → default로 resolve', async () => {
    const r = await dispatchToolCall(env, {
      name: 'memo_ui_action',
      arguments: { action: 'open' },
    })
    expect(mockResolveMemoTarget).toHaveBeenCalledWith(
      env,
      { kind: 'last_target' },
      { userId: 'default', conversationId: 'default' }
    )
    expect(r.success).toBe(true)
    expect(r.data.memoId).toBe(9)
  })
})

describe('branch 커버리지 추가 2', () => {
  test('memo_delete 성공 → 문맥 업데이트 분기 없음', async () => {
    mockExecuteMemoGet.mockResolvedValue({ success: true, data: { id: 9, text: 'x' } })
    const results = await dispatchToolCalls(
      env,
      [{ name: 'memo_delete', arguments: { id: 9 } }],
      { userId: 'u', conversationId: 'c' }
    )
    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(true)
    expect(mockUpdateMemoContext).not.toHaveBeenCalled()
  })
})
