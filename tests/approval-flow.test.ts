/**
 * 채팅 승인 흐름 테스트 (진짜 비서 1단계 b트랙)
 * - 승인 응답 파싱 ("승인해" / "거부해" / "이 세션 허용해")
 * - 도구 설명 (무엇을 + 되돌릴 수 있는지 + 영향 범위) + 시크릿 마스킹
 * - 대기 요청 저장소 (생성 → 조회 → 해결 → 만료)
 * - 승인 응답 해결 (승인/거부/세션 허용/만료/없음 + 감사 기록)
 */
import {
  parseApprovalReply,
  describeToolAction,
  buildApprovalRequestText,
  resolveApprovalReply,
  ToolApprovalRequestStore,
  APPROVAL_TIMEOUT_MS,
} from '../src/services/approval-flow'
import { ToolApprovalStore } from '../src/services/tool-approval'
import { FakeD1, asD1 } from './fake-d1'

const NOW = new Date('2026-10-26T02:00:00Z')
const FUTURE = new Date(NOW.getTime() + APPROVAL_TIMEOUT_MS).toISOString()

function makeStores() {
  const fake = new FakeD1()
  const db = asD1(fake)
  return { fake, db, requests: new ToolApprovalRequestStore(db), approvals: new ToolApprovalStore(db) }
}

async function seedPending(requests: ToolApprovalRequestStore, overrides: Record<string, any> = {}) {
  return requests.createPending({
    personaId: 'concierge',
    conversationId: 1,
    tool: 'MEMO_DELETE',
    scopeKey: 'MEMO_DELETE:123',
    markerText: '[MEMO_DELETE]{"id":123}[/MEMO_DELETE]',
    summary: '메모 #123 삭제',
    userRequest: '그 메모 삭제해줘',
    reversible: false,
    impact: '메모 1개가 영구히 삭제됩니다. 되돌릴 수 없어요.',
    expiresAt: FUTURE,
    createdAt: NOW.toISOString(),
    ...overrides,
  })
}

describe('parseApprovalReply', () => {
  test('승인 응답', () => {
    for (const text of ['승인해', '승인', '승인해줘', '실행해', '진행해', '응', '좋아', '오케이', '네']) {
      expect(parseApprovalReply(text)).toBe('approve')
    }
  })

  test('거부 응답', () => {
    for (const text of ['거부해', '거부', '하지마', '안 해', '취소', '중단', '싫어', '아니요']) {
      expect(parseApprovalReply(text)).toBe('deny')
    }
  })

  test('세션 허용 응답', () => {
    for (const text of ['이 세션 허용해', '세션 허용', '이번 대화는 허용해', '계속 허용']) {
      expect(parseApprovalReply(text)).toBe('approve_session')
    }
  })

  test('삭제 동사는 삭제 도구일 때만 승인', () => {
    expect(parseApprovalReply('삭제해', 'MEMO_DELETE')).toBe('approve')
    expect(parseApprovalReply('삭제해', 'MEMO_CREATE')).toBeNull()
    expect(parseApprovalReply('삭제해')).toBeNull()
  })

  test('긴 문장·일반 메시지는 승인 응답이 아님', () => {
    expect(parseApprovalReply('승인해 그리고 요약해줘')).toBeNull()
    expect(parseApprovalReply('메모 삭제해줘')).toBeNull()
    expect(parseApprovalReply('')).toBeNull()
    expect(parseApprovalReply(undefined)).toBeNull()
    expect(parseApprovalReply('승인해.')).toBe('approve') // 끝 마침표는 허용
  })
})

describe('describeToolAction / buildApprovalRequestText', () => {
  test('삭제는 되돌릴 수 없음, 생성은 되돌릴 수 있음', () => {
    expect(describeToolAction('MEMO_DELETE', { id: 123 }).reversible).toBe(false)
    expect(describeToolAction('MEMO_DELETE', { id: 123 }).summary).toContain('#123')
    expect(describeToolAction('MEMO_CREATE', { text: 'hello' }).reversible).toBe(true)
    expect(describeToolAction('MEMO_UPDATE', { id: 1, text: 'x' }).reversible).toBe(false)
    expect(describeToolAction('TODO_DONE', { id: 2 }).reversible).toBe(true)
    expect(describeToolAction('CRON_TOGGLE', { id: 3, enabled: false }).summary).toContain('끄기')
    expect(describeToolAction('CRON_DELETE', { id: 3 }).reversible).toBe(false)
  })

  test('승인 요청 문안은 무엇+근거+되돌림+영향+답변법을 담는다', () => {
    const text = buildApprovalRequestText({
      summary: '메모 #123 삭제',
      userRequest: '그 메모 삭제해줘',
      reversible: false,
      impact: '메모 1개가 영구히 삭제됩니다.',
    })
    expect(text).toContain('메모 #123 삭제')
    expect(text).toContain('그 메모 삭제해줘')
    expect(text).toContain('되돌릴 수 없어요')
    expect(text).toContain('영구히 삭제됩니다')
    expect(text).toContain('"승인해"')
    expect(text).toContain('"거부해"')
    expect(text).toContain('"이 세션 허용해"')
    expect(text).toContain('10분')
  })
})

describe('ToolApprovalRequestStore (FakeD1)', () => {
  test('생성 → 최신 조회 → 해결 → 이후 조회 null', async () => {
    const { requests } = makeStores()
    const created = await seedPending(requests)
    expect(created.status).toBe('pending')

    const { request, expired } = await requests.findNewestPending(1, NOW)
    expect(expired).toBe(false)
    expect(request?.id).toBe(created.id)
    expect(request?.markerText).toBe('[MEMO_DELETE]{"id":123}[/MEMO_DELETE]')

    expect(await requests.resolveRequest(created.id, 'approved', NOW)).toBe(true)
    // 두 번 해결은 실패 (이미 pending이 아님)
    expect(await requests.resolveRequest(created.id, 'denied', NOW)).toBe(false)
    expect((await requests.findNewestPending(1, NOW)).request).toBeNull()
  })

  test('같은 범위 pending이 있으면 재사용 (중복 생성 방지용 조회)', async () => {
    const { requests } = makeStores()
    await seedPending(requests)
    const found = await requests.findPendingByScope(1, 'MEMO_DELETE:123', NOW)
    expect(found?.summary).toBe('메모 #123 삭제')
    expect(await requests.findPendingByScope(1, 'MEMO_DELETE:999', NOW)).toBeNull()
    expect(await requests.findPendingByScope(2, 'MEMO_DELETE:123', NOW)).toBeNull()
  })

  test('만료된 요청은 조회 시 expired로 갱신', async () => {
    const { requests } = makeStores()
    const created = await seedPending(requests)
    const later = new Date(NOW.getTime() + APPROVAL_TIMEOUT_MS + 1000)
    const { request, expired } = await requests.findNewestPending(1, later)
    expect(expired).toBe(true)
    expect(request?.status).toBe('expired')
    // 만료 후에는 대기 요청이 없음
    expect((await requests.findNewestPending(1, later)).request).toBeNull()
    expect((await requests.findPendingByScope(1, 'MEMO_DELETE:123', later))).toBeNull()
    void created
  })
})

describe('resolveApprovalReply', () => {
  test('승인 → 요청 approved + 감사 기록 approved, 마커는 그대로 반환', async () => {
    const { fake, db, requests, approvals } = makeStores()
    const pending = await seedPending(requests)
    const res = await resolveApprovalReply(db, {
      conversationId: 1,
      personaId: 'concierge',
      reply: '승인해',
      now: NOW,
    })
    expect(res.status).toBe('approved')
    expect(res.request?.id).toBe(pending.id)
    expect(res.request?.markerText).toBe('[MEMO_DELETE]{"id":123}[/MEMO_DELETE]')
    const audit = await approvals.findLatestApproval('concierge', 'MEMO_DELETE', 'MEMO_DELETE:123')
    expect(audit?.decision).toBe('approved')
    expect(fake.tables.tool_approval_requests[0].status).toBe('approved')
  })

  test('거부 → 요청 denied + 감사 기록 denied', async () => {
    const { db, requests, approvals } = makeStores()
    await seedPending(requests)
    const res = await resolveApprovalReply(db, {
      conversationId: 1,
      personaId: 'concierge',
      reply: '거부해',
      now: NOW,
    })
    expect(res.status).toBe('denied')
    const audit = await approvals.findLatestApproval('concierge', 'MEMO_DELETE', 'MEMO_DELETE:123')
    expect(audit?.decision).toBe('denied')
  })

  test('세션 허용 → 요청 approved + 세션 허용 행 저장', async () => {
    const { db, requests, approvals } = makeStores()
    await seedPending(requests)
    const res = await resolveApprovalReply(db, {
      conversationId: 1,
      personaId: 'concierge',
      reply: '이 세션 허용해',
      now: NOW,
    })
    expect(res.status).toBe('approved_session')
    const session = await approvals.findSessionAllowance('concierge', 'MEMO_DELETE', 1, NOW)
    expect(session?.decision).toBe('approved')
  })

  test('만료된 요청에 승인하면 expired', async () => {
    const { db, requests } = makeStores()
    await seedPending(requests)
    const later = new Date(NOW.getTime() + APPROVAL_TIMEOUT_MS + 1000)
    const res = await resolveApprovalReply(db, {
      conversationId: 1,
      personaId: 'concierge',
      reply: '승인해',
      now: later,
    })
    expect(res.status).toBe('expired')
  })

  test('pending이 없으면 none (일반 채팅으로 진행)', async () => {
    const { db } = makeStores()
    const res = await resolveApprovalReply(db, {
      conversationId: 1,
      personaId: 'concierge',
      reply: '승인해',
      now: NOW,
    })
    expect(res.status).toBe('none')
  })

  test('pending이 있어도 승인 응답이 아니면 none', async () => {
    const { db, requests } = makeStores()
    await seedPending(requests)
    const res = await resolveApprovalReply(db, {
      conversationId: 1,
      personaId: 'concierge',
      reply: '메모 요약해줘',
      now: NOW,
    })
    expect(res.status).toBe('none')
    // pending은 그대로 유지
    expect((await requests.findNewestPending(1, NOW)).request).not.toBeNull()
  })
})
