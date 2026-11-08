/// <reference types="jest" />
/**
 * src/services/fc-approval-gate.ts — executeFCApprovalPayload의 디스패처
 * 컨텍스트 조립 성질 (3차 배치). 디스패처는 mock으로 대체하고, 게이트가
 * 만드는 컨텍스트(비서 전파·승인 삭제 플래그·원본 문맥·userId 기본값)가
 * 계약대로인지를 검증한다.
 * 카나리아: approvedDelete 전파를 지우면 삭제 컨텍스트 단언이 실패한다.
 */
import { executeFCApprovalPayload, encodeFCPayload } from '../../src/services/fc-approval-gate'
import { dispatchToolCall } from '../../src/ai/memo-tool-dispatcher'

jest.mock('../../src/ai/memo-tool-dispatcher', () => ({ dispatchToolCall: jest.fn() }))

const mockDispatch = dispatchToolCall as jest.Mock

function requestWith(payload: any, over: any = {}): any {
  return {
    id: 1, personaId: 'keeper', conversationId: 12, tool: 'MEMO_CREATE',
    scopeKey: 'MEMO_CREATE', markerText: encodeFCPayload(payload),
    summary: 's', userRequest: 'u', reversible: true, impact: 'i',
    status: 'approved', createdAt: '2026-11-08T00:00:00Z', expiresAt: '2026-11-08T00:10:00Z',
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDispatch.mockResolvedValue({ success: true, data: { id: 3 } })
})

describe('executeFCApprovalPayload — 디스패처 컨텍스트', () => {
  test('승인 요청의 비서·대화 ID가 컨텍스트로 전파되고 결과가 문구로 변환된다', async () => {
    const env = { DB: null }
    const out = await executeFCApprovalPayload(env, requestWith({ v: 1, kind: 'fc', name: 'memo_create', arguments: { text: '본문' } }), { userId: 'user-9' })
    expect(out).toBe('메모를 생성했어 (id: 3).')
    expect(mockDispatch).toHaveBeenCalledTimes(1)
    const [passedEnv, call, ctx] = mockDispatch.mock.calls[0]
    expect(passedEnv).toBe(env)
    expect(call).toEqual({ name: 'memo_create', arguments: { text: '본문' } })
    expect(ctx).toMatchObject({ userId: 'user-9', conversationId: '12', personaId: 'keeper', origin: 'interactive' })
    expect(ctx.originalMessages).toBeUndefined()
    expect(ctx.approvedDelete).toBeUndefined()
  })

  test('ctx가 없으면 userId는 default가 된다', async () => {
    await executeFCApprovalPayload({}, requestWith({ v: 1, kind: 'fc', name: 'memo_create', arguments: { text: 'x' } }))
    expect(mockDispatch.mock.calls[0][2].userId).toBe('default')
  })

  test('memo_delete 페이로드에만 approvedDelete가 실린다', async () => {
    mockDispatch.mockResolvedValue({ success: true, data: {} })
    const out = await executeFCApprovalPayload({}, requestWith({ v: 1, kind: 'fc', name: 'memo_delete', arguments: { id: 4 } }))
    expect(mockDispatch.mock.calls[0][2].approvedDelete).toBe(true)
    expect(out).toBe('메모 4를 삭제했어.')
  })

  test('sourceUserText가 있으면 원본 사용자 메시지로 컨텍스트에 실린다', async () => {
    await executeFCApprovalPayload({}, requestWith({
      v: 1, kind: 'fc', name: 'memo_create_from_source',
      arguments: { source_text: '받아쓰기' }, sourceUserText: '메모해줘: 받아쓰기',
    }))
    expect(mockDispatch.mock.calls[0][2].originalMessages).toEqual([
      { role: 'user', content: '메모해줘: 받아쓰기' },
    ])
  })

  test('디스패처가 실패를 돌려주면 실패 문구로 변환된다 (던지지 않는다)', async () => {
    mockDispatch.mockResolvedValue({ success: false, error: '권한 없음' })
    const out = await executeFCApprovalPayload({}, requestWith({ v: 1, kind: 'fc', name: 'memo_create', arguments: { text: 'x' } }))
    expect(out).toBe('실행에 실패했어: 권한 없음')
  })
})
