/// <reference types="jest" />
/**
 * src/services/fc-approval-gate.ts 성질 테스트 (3차 배치).
 * fc-approval-gate.test.ts와 겹치지 않는 영역: 페이로드 디코딩의 손상 형태,
 * 실행 결과 문구의 전 도구·결측 분기, 게이트의 인자 정규화(비객체 인자,
 * source_text 비문자열, 원본 문맥의 도구별 보존 조건).
 * 카나리아: decodeFCPayload의 kind 검사를 지우면 손상 페이로드 단언이,
 * formatFCExecutionResult의 id 폴백을 지우면 문구 단언이 실패한다.
 */
import {
  gateFCToolCall,
  executeFCApprovalPayload,
  encodeFCPayload,
  decodeFCPayload,
  isFCPayload,
  formatFCExecutionResult,
} from '../../src/services/fc-approval-gate'
import { FakeD1, asD1 } from '../fake-d1'

const NOW = new Date('2026-11-08T01:00:00Z')

describe('decodeFCPayload / isFCPayload — 손상 형태', () => {
  test('접두사가 없거나 JSON이 깨지면 null', () => {
    expect(isFCPayload(42)).toBe(false)
    expect(isFCPayload(null)).toBe(false)
    expect(decodeFCPayload(undefined)).toBeNull()
    expect(decodeFCPayload('FC:')).toBeNull()
    expect(decodeFCPayload('FC:null')).toBeNull()
  })

  test('kind가 fc가 아니거나 name/arguments 형태가 틀리면 null', () => {
    expect(decodeFCPayload('FC:{"kind":"marker","name":"memo_create","arguments":{}}')).toBeNull()
    expect(decodeFCPayload('FC:{"kind":"fc","name":42,"arguments":{}}')).toBeNull()
    expect(decodeFCPayload('FC:{"kind":"fc","name":"memo_create"}')).toBeNull()
    expect(decodeFCPayload('FC:{"kind":"fc","name":"memo_create","arguments":"x"}')).toBeNull()
    expect(decodeFCPayload('FC:{"kind":"fc","name":"memo_create","arguments":null}')).toBeNull()
  })

  test('sourceUserText가 실린 페이로드는 그대로 왕복한다', () => {
    const encoded = encodeFCPayload({ v: 1, kind: 'fc', name: 'memo_create_from_source', arguments: { source_text: '원문' }, sourceUserText: '사용자 원문' })
    expect(decodeFCPayload(encoded)).toEqual({
      v: 1, kind: 'fc', name: 'memo_create_from_source',
      arguments: { source_text: '원문' }, sourceUserText: '사용자 원문',
    })
  })
})

describe('formatFCExecutionResult — 도구별 문구와 결측 폴백', () => {
  test('실패: 오류 문구가 있으면 그것을, 없으면 알 수 없는 오류를 쓴다', () => {
    expect(formatFCExecutionResult('memo_create', {}, { success: false, error: 'DB 오류' })).toBe('실행에 실패했어: DB 오류')
    expect(formatFCExecutionResult('memo_create', {}, { success: false })).toBe('실행에 실패했어: 알 수 없는 오류')
  })

  test('메모 생성: data.id > data.memoId 순, 정수 id가 아니면 id 없이 안내한다', () => {
    expect(formatFCExecutionResult('memo_create', {}, { success: true, data: { id: 7 } })).toBe('메모를 생성했어 (id: 7).')
    expect(formatFCExecutionResult('memo_create_from_source', {}, { success: true, data: { memoId: 8 } })).toBe('메모를 생성했어 (id: 8).')
    expect(formatFCExecutionResult('memo_create', {}, { success: true, data: { id: '9' } })).toBe('메모를 생성했어.')
    expect(formatFCExecutionResult('memo_create', {}, { success: true })).toBe('메모를 생성했어.')
  })

  test('메모 삭제: args.id를 우선하고, 둘 다 없으면 일반 문구', () => {
    expect(formatFCExecutionResult('memo_delete', { id: 3 }, { success: true, data: { id: 4 } })).toBe('메모 3를 삭제했어.')
    expect(formatFCExecutionResult('memo_delete', {}, { success: true, data: { id: 4 } })).toBe('메모 4를 삭제했어.')
    expect(formatFCExecutionResult('memo_delete', {}, { success: true, data: {} })).toBe('메모를 삭제했어.')
    expect(formatFCExecutionResult('memo_delete', { id: null }, { success: true, data: {} })).toBe('메모를 삭제했어.')
  })

  test('일정: args.title > data.title 순, 둘 다 없으면 제목 없이 안내한다', () => {
    expect(formatFCExecutionResult('schedule_create', { title: '회의' }, { success: true, data: {} })).toBe('일정 등록했어: 회의')
    expect(formatFCExecutionResult('schedule_create', {}, { success: true, data: { title: '진료' } })).toBe('일정 등록했어: 진료')
    expect(formatFCExecutionResult('schedule_create', {}, { success: true, data: {} })).toBe('일정 등록했어:')
  })

  test('자동화: 설명 유무, 켜기/끄기, 삭제 id 폴백', () => {
    expect(formatFCExecutionResult('cron_create', {}, { success: true, data: { description: '아침 브리핑' } })).toBe('자동화를 저장했어: 아침 브리핑')
    expect(formatFCExecutionResult('cron_create', {}, { success: true, data: {} })).toBe('자동화를 저장했어.')
    expect(formatFCExecutionResult('cron_set_enabled', { id: 2 }, { success: true, data: { enabled: true } })).toBe('자동화 #2를 켰어.')
    expect(formatFCExecutionResult('cron_set_enabled', {}, { success: true, data: { id: 5, enabled: false } })).toBe('자동화 #5를 껐어.')
    expect(formatFCExecutionResult('cron_delete', { id: 6 }, { success: true, data: {} })).toBe('자동화 #6를 삭제했어.')
  })

  test('그 밖의 도구는 일반 완료 문구', () => {
    expect(formatFCExecutionResult('unknown_tool', {}, { success: true, data: {} })).toBe('요청한 작업을 실행했어.')
  })
})

describe('gateFCToolCall — 인자 정규화', () => {
  function world() {
    const fake = new FakeD1()
    return { fake, db: asD1(fake) }
  }

  test('인자가 객체가 아니면 빈 인자로 정규화해 대기 요청을 만든다', async () => {
    for (const badArgs of ['문자열 인자', null, 42]) {
      const { fake, db } = world()
      const outcome = await gateFCToolCall({
        db, personaId: 'keeper', conversationId: 1,
        toolName: 'memo_create', args: badArgs as any,
        userRequest: '메모해줘', origin: 'interactive', now: NOW,
      })
      expect(outcome.action).toBe('ask')
      const stored = fake.tables.tool_approval_requests[0]
      expect(decodeFCPayload(stored.marker_text)?.arguments).toEqual({})
    }
  })

  test('memo_create_from_source의 source_text가 문자열이 아니면 설명용 본문은 비어 있고, 원본 문맥은 도구 조건에 맞을 때만 실린다', async () => {
    const { fake, db } = world()
    const outcome = await gateFCToolCall({
      db, personaId: 'keeper', conversationId: 1,
      toolName: 'memo_create_from_source', args: { source_text: 123 },
      userRequest: '받아써줘', sourceUserText: '원본 사용자 문장',
      origin: 'interactive', now: NOW,
    })
    expect(outcome.action).toBe('ask')
    const payload = decodeFCPayload(fake.tables.tool_approval_requests[0].marker_text)
    expect(payload?.sourceUserText).toBe('원본 사용자 문장')
    expect(payload?.arguments).toEqual({ source_text: 123 })
  })

  test('일반 memo_create에는 sourceUserText가 있어도 페이로드에 싣지 않는다', async () => {
    const { fake, db } = world()
    await gateFCToolCall({
      db, personaId: 'keeper', conversationId: 1,
      toolName: 'memo_create', args: { text: '본문' },
      userRequest: '', sourceUserText: '원본 사용자 문장',
      origin: 'interactive', now: NOW,
    })
    const row = fake.tables.tool_approval_requests[0]
    const payload = decodeFCPayload(row.marker_text)
    expect(payload?.sourceUserText).toBeUndefined()
    expect(row.user_request).toBe('')
  })

  test('now를 생략하면 현재 시각으로 만료를 잡는다', async () => {
    const { db } = world()
    const before = Date.now()
    const outcome = await gateFCToolCall({
      db, personaId: 'keeper', conversationId: 1,
      toolName: 'memo_create', args: { text: 'x' },
      userRequest: '해줘', origin: 'interactive',
    })
    expect(outcome.action).toBe('ask')
    if (outcome.action === 'ask') {
      const expires = Date.parse(outcome.request.expiresAt)
      expect(expires).toBeGreaterThan(before)
    }
  })
})

describe('executeFCApprovalPayload — 손상 페이로드', () => {
  test('FC 페이로드가 아닌 승인 건은 실행하지 않고 던진다', async () => {
    const request: any = {
      id: 1, personaId: 'keeper', conversationId: 1, tool: 'MEMO_CREATE',
      scopeKey: 'MEMO_CREATE', markerText: '[MEMO_CREATE]{"text":"x"}[/MEMO_CREATE]',
      summary: 's', userRequest: 'u', reversible: true, impact: 'i',
      status: 'approved', createdAt: NOW.toISOString(), expiresAt: NOW.toISOString(),
    }
    await expect(executeFCApprovalPayload({}, request)).rejects.toThrow('승인된 FC 요청의 내용을 읽을 수 없습니다')
  })
})
