/**
 * 도구 승인 + PII 마스킹 경계 테스트 (Octop 트랙 4-4)
 * - deny-by-default, 파괴적 도구 승인 필수, 인자 마스킹, 승인 기록 저장소
 */
import {
  classifyToolRisk,
  approvalScopeKey,
  requiresApprovalClause,
  maskToolArgs,
  decideToolExecution,
  isLockTool,
  ToolApprovalStore,
  type ApprovalRecord,
} from '../src/services/tool-approval'
import { FakeD1, asD1 } from './fake-d1'

const NOW = new Date('2026-10-25T08:00:00Z')
const FUTURE = new Date('2026-10-26T08:00:00Z').toISOString()
const PAST = new Date('2026-10-24T08:00:00Z').toISOString()

function approval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    personaId: 'concierge',
    tool: 'MEMO_DELETE',
    scopeKey: 'MEMO_DELETE:123',
    decision: 'approved',
    expiresAt: FUTURE,
    ...overrides,
  }
}

describe('classifyToolRisk (승인 필요 판정은 위험 등급으로)', () => {
  test('파괴적/쓰기/읽기 분류', () => {
    expect(classifyToolRisk('MEMO_DELETE')).toBe('destructive')
    expect(classifyToolRisk('SCHEDULE_DELETE')).toBe('destructive')
    expect(classifyToolRisk('TODO_DELETE')).toBe('destructive')
    expect(classifyToolRisk('ARTIFACT_DELETE')).toBe('destructive')
    expect(classifyToolRisk('CRON_DELETE')).toBe('destructive')
    expect(classifyToolRisk('PUSH_SEND')).toBe('destructive') // 외부 발송 = 반드시 승인
    expect(classifyToolRisk('MEMO_CREATE')).toBe('write')
    expect(classifyToolRisk('SCHEDULE_CREATE')).toBe('write')
    expect(classifyToolRisk('CRON_CREATE')).toBe('write')
    expect(classifyToolRisk('CRON_TOGGLE')).toBe('write')
    expect(classifyToolRisk('MEMO_SEARCH')).toBe('read')
    expect(classifyToolRisk('MEMO_GET')).toBe('read')
    expect(classifyToolRisk('SEARCH')).toBe('read')
    expect(classifyToolRisk('CRON_LIST')).toBe('read')
  })

  test('소문자 도구명도 분류됨', () => {
    expect(classifyToolRisk('memo_delete')).toBe('destructive')
  })

  test('모르는 도구는 unknown (deny-by-default는 게이트에서), 승인 필요는 write·destructive 등급', () => {
    expect(classifyToolRisk('UNKNOWN_TOOL')).toBe('unknown')
    expect(classifyToolRisk(undefined)).toBe('unknown')
    // 구 toolNeedsApproval(tool) 헬퍼는 사라졌다 — 승인 필요 여부는
    // classifyToolRisk 등급(write·destructive)이 현행 판정 표면이다.
    const needsApproval = (tool: string) => {
      const risk = classifyToolRisk(tool)
      return risk === 'write' || risk === 'destructive'
    }
    expect(needsApproval('UNKNOWN_TOOL')).toBe(false)
    expect(needsApproval('MEMO_DELETE')).toBe(true)
    expect(needsApproval('MEMO_CREATE')).toBe(true) // b트랙: 쓰기도 기본 승인 필요
    expect(needsApproval('MEMO_SEARCH')).toBe(false)
  })

  test('잠금/해제 도구는 isLockTool로 식별', () => {
    expect(isLockTool('MEMO_LOCK')).toBe(true)
    expect(isLockTool('MEMO_UNLOCK')).toBe(true)
    expect(isLockTool('MEMO_DELETE')).toBe(false)
    expect(isLockTool(undefined)).toBe(false)
  })
})

describe('approvalScopeKey', () => {
  test('도구+대상 단위 키', () => {
    expect(approvalScopeKey('MEMO_DELETE', { id: 123 })).toBe('MEMO_DELETE:123')
    expect(approvalScopeKey('memo_delete', { memoId: 7 })).toBe('MEMO_DELETE:7')
    expect(approvalScopeKey('MEMO_DELETE', {})).toBe('MEMO_DELETE')
    expect(approvalScopeKey('MEMO_DELETE', null)).toBe('MEMO_DELETE')
  })
})

describe('requiresApprovalClause', () => {
  test('파괴적 동사 포함 여부', () => {
    expect(requiresApprovalClause('메모 123 삭제해줘')).toBe(true)
    expect(requiresApprovalClause('내일 일정 취소해줘')).toBe(true)
    expect(requiresApprovalClause('메모 요약해줘')).toBe(false)
    expect(requiresApprovalClause('내일 일정 알려줘')).toBe(false)
  })
})

describe('maskToolArgs', () => {
  test('중첩 인자의 시크릿을 마스킹하고 구조를 유지', () => {
    const { masked, count } = maskToolArgs({
      text: 'API키는 sk-abcdefghij1234567890 이야',
      nested: { card: '4111 1111 1111 1111', keep: 'hello' },
      tags: ['password=secret123', 'plain'],
      n: 42,
    })
    expect(count).toBeGreaterThanOrEqual(3)
    const m = masked as any
    expect(m.text).toContain('[API_KEY_MASKED]')
    expect(m.text).not.toContain('sk-abcdefghij1234567890')
    expect(m.nested.card).toBe('[CARD_MASKED]')
    expect(m.nested.keep).toBe('hello')
    expect(m.tags[0]).toContain('[PASSWORD_MASKED]')
    expect(m.tags[1]).toBe('plain')
    expect(m.n).toBe(42)
  })

  test('시크릿이 없으면 count 0, 원본 그대로', () => {
    const { masked, count } = maskToolArgs({ text: '회의 메모' })
    expect(count).toBe(0)
    expect(masked).toEqual({ text: '회의 메모' })
  })
})

describe('decideToolExecution', () => {
  test('모르는 비서는 deny', () => {
    const d = decideToolExecution({ personaId: 'bogus', tool: 'MEMO_SEARCH', now: NOW })
    expect(d.decision).toBe('deny')
    expect(d.reason).toBe('unknown_persona')
  })

  test('허용 목록 밖 도구는 deny (builder는 MEMO_DELETE 불가)', () => {
    const d = decideToolExecution({ personaId: 'builder', tool: 'MEMO_DELETE', args: { id: 1 }, origin: 'interactive', now: NOW })
    expect(d.decision).toBe('deny')
    expect(d.reason).toBe('tool_not_allowed')
  })

  test('읽기 도구(GITHUB)는 승인 없이 allow', () => {
    const d = decideToolExecution({ personaId: 'concierge', tool: 'GITHUB', args: {}, now: NOW })
    expect(d.decision).toBe('allow')
    expect(d.reason).toBe('allowed')
  })

  test('파괴적 도구는 승인 없으면 ask (실행 안 함)', () => {
    const d = decideToolExecution({
      personaId: 'concierge',
      tool: 'MEMO_DELETE',
      args: { id: 123 },
      origin: 'interactive',
      now: NOW,
    })
    expect(d.decision).toBe('ask')
    expect(d.reason).toBe('approval_required')
    expect(d.scopeKey).toBe('MEMO_DELETE:123')
  })

  test('유효한 승인 기록이 있으면 allow', () => {
    const d = decideToolExecution({
      personaId: 'concierge',
      tool: 'MEMO_DELETE',
      args: { id: 123 },
      approval: approval(),
      origin: 'interactive',
      now: NOW,
    })
    expect(d.decision).toBe('allow')
    expect(d.reason).toBe('approved')
  })

  test('범위가 다른 승인 기록은 ask', () => {
    const d = decideToolExecution({
      personaId: 'concierge',
      tool: 'MEMO_DELETE',
      args: { id: 999 },
      approval: approval(), // MEMO_DELETE:123 전용
      origin: 'interactive',
      now: NOW,
    })
    expect(d.decision).toBe('ask')
    expect(d.reason).toBe('approval_scope_mismatch')
  })

  test('만료된 승인은 ask', () => {
    const d = decideToolExecution({
      personaId: 'concierge',
      tool: 'MEMO_DELETE',
      args: { id: 123 },
      approval: approval({ expiresAt: PAST }),
      origin: 'interactive',
      now: NOW,
    })
    expect(d.decision).toBe('ask')
    expect(d.reason).toBe('approval_expired')
  })

  test('거부된 승인 기록은 ask', () => {
    const d = decideToolExecution({
      personaId: 'concierge',
      tool: 'MEMO_DELETE',
      args: { id: 123 },
      approval: approval({ decision: 'denied' }),
      origin: 'interactive',
      now: NOW,
    })
    expect(d.decision).toBe('ask')
    expect(d.reason).toBe('approval_required')
  })

  test('읽기 도구는 승인 없이 allow, 인자는 마스킹됨', () => {
    const d = decideToolExecution({
      personaId: 'keeper',
      tool: 'MEMO_SEARCH',
      args: { query: '키 sk-abcdefghij1234567890' },
      now: NOW,
    })
    expect(d.decision).toBe('allow')
    expect(d.maskedCount).toBe(1)
    expect((d.maskedArgs as any).query).toContain('[API_KEY_MASKED]')
  })

  test('쓰기 도구는 승인 없으면 ask (b트랙: 기본 승인 필요)', () => {
    const d = decideToolExecution({
      personaId: 'scheduler',
      tool: 'SCHEDULE_CREATE',
      args: { title: '회의' },
      origin: 'interactive',
      now: NOW,
    })
    expect(d.decision).toBe('ask')
    expect(d.reason).toBe('approval_required')
  })

  test('쓰기 도구는 유효한 승인 기록이 있으면 allow', () => {
    const d = decideToolExecution({
      personaId: 'concierge',
      tool: 'MEMO_CREATE',
      args: { text: 'hello' },
      approval: approval({ tool: 'MEMO_CREATE', scopeKey: 'MEMO_CREATE' }),
      origin: 'interactive',
      now: NOW,
    })
    expect(d.decision).toBe('allow')
    expect(d.reason).toBe('approved')
  })

  test('쓰기·파괴적 도구는 세션 허용이 있으면 allow', () => {
    const w = decideToolExecution({
      personaId: 'scheduler',
      tool: 'SCHEDULE_CREATE',
      args: { title: '회의' },
      sessionAllowed: true,
      origin: 'interactive',
      now: NOW,
    })
    expect(w.decision).toBe('allow')
    expect(w.reason).toBe('session_allowed')
    const d = decideToolExecution({
      personaId: 'concierge',
      tool: 'MEMO_DELETE',
      args: { id: 123 },
      sessionAllowed: true,
      origin: 'interactive',
      now: NOW,
    })
    expect(d.decision).toBe('allow')
    expect(d.reason).toBe('session_allowed')
  })

  test('잠금 도구는 승인 여부와 무관하게 deny', () => {
    const d = decideToolExecution({
      personaId: 'concierge',
      tool: 'MEMO_LOCK',
      args: { id: 1 },
      approval: approval({ tool: 'MEMO_LOCK', scopeKey: 'MEMO_LOCK:1' }),
      origin: 'interactive',
      now: NOW,
    })
    expect(d.decision).toBe('deny')
    expect(d.reason).toBe('lock_forbidden')
  })
})

describe('decideToolExecution — 출처 게이트 (Talorys ③-A)', () => {
  // 카나리아 1: 예약 출처의 쓰기는 ask가 아니라 deny여야 한다.
  // tool-approval.ts의 origin 분기를 지우면 approval_required(ask)로
  // 떨어져 이 테스트가 실패한다 (실제로 지워서 확인함 — 보고서 참조).
  test('scheduled origin + MEMO_CREATE → deny(non_interactive_origin)', () => {
    const d = decideToolExecution({
      personaId: 'concierge',
      tool: 'MEMO_CREATE',
      args: { text: '예약 실행이 만들려는 메모' },
      origin: 'scheduled',
      now: NOW,
    })
    expect(d.decision).toBe('deny')
    expect(d.reason).toBe('non_interactive_origin')
  })

  test('scheduled origin + 파괴적 도구(MEMO_DELETE) → deny', () => {
    const d = decideToolExecution({
      personaId: 'concierge',
      tool: 'MEMO_DELETE',
      args: { id: 123 },
      origin: 'scheduled',
      now: NOW,
    })
    expect(d.decision).toBe('deny')
    expect(d.reason).toBe('non_interactive_origin')
  })

  test('비대화형 origin은 유효한 승인·세션 허용으로도 쓰기를 실행할 수 없다', () => {
    const withApproval = decideToolExecution({
      personaId: 'concierge',
      tool: 'MEMO_DELETE',
      args: { id: 123 },
      approval: approval(),
      origin: 'mcp',
      now: NOW,
    })
    expect(withApproval.decision).toBe('deny')
    expect(withApproval.reason).toBe('non_interactive_origin')
    const withSession = decideToolExecution({
      personaId: 'concierge',
      tool: 'MEMO_CREATE',
      args: { text: 'x' },
      sessionAllowed: true,
      origin: 'channel',
      now: NOW,
    })
    expect(withSession.decision).toBe('deny')
    expect(withSession.reason).toBe('non_interactive_origin')
  })

  // 카나리아 2: origin 미지정은 쓰기 판정에 한해 비대화형 (fail-closed)
  test('origin 미지정 + MEMO_CREATE → deny(non_interactive_origin)', () => {
    const d = decideToolExecution({
      personaId: 'concierge',
      tool: 'MEMO_CREATE',
      args: { text: '출처 없는 메모' },
      now: NOW,
    })
    expect(d.decision).toBe('deny')
    expect(d.reason).toBe('non_interactive_origin')
    // 승인 기록이 있어도 미지정은 뚫지 못한다
    const withApproval = decideToolExecution({
      personaId: 'concierge',
      tool: 'MEMO_CREATE',
      args: { text: '출처 없는 메모' },
      approval: approval({ tool: 'MEMO_CREATE', scopeKey: 'MEMO_CREATE' }),
      now: NOW,
    })
    expect(withApproval.decision).toBe('deny')
    expect(withApproval.reason).toBe('non_interactive_origin')
  })

  test('읽기 도구는 출처와 무관하게 현행 유지 (scheduled도 allow)', () => {
    const d = decideToolExecution({
      personaId: 'keeper',
      tool: 'MEMO_SEARCH',
      args: { query: '회의' },
      origin: 'scheduled',
      now: NOW,
    })
    expect(d.decision).toBe('allow')
    expect(d.reason).toBe('allowed')
    const noOrigin = decideToolExecution({
      personaId: 'keeper',
      tool: 'MEMO_SEARCH',
      args: { query: '회의' },
      now: NOW,
    })
    expect(noOrigin.decision).toBe('allow')
  })

  test('interactive origin의 쓰기 판정은 기존과 동일 (승인 없으면 ask)', () => {
    const d = decideToolExecution({
      personaId: 'concierge',
      tool: 'MEMO_CREATE',
      args: { text: '대화형 메모' },
      origin: 'interactive',
      now: NOW,
    })
    expect(d.decision).toBe('ask')
    expect(d.reason).toBe('approval_required')
  })
})

describe('ToolApprovalStore (FakeD1)', () => {
  test('기록 → 유효 조회 → 만료 조회 → 철회', async () => {
    const fake = new FakeD1()
    const store = new ToolApprovalStore(asD1(fake))

    const id = await store.recordApproval({
      personaId: 'concierge',
      tool: 'MEMO_DELETE',
      scopeKey: 'MEMO_DELETE:123',
      decision: 'approved',
      expiresAt: FUTURE,
    })
    expect(typeof id).toBe('number')

    const found = await store.findValidApproval('concierge', 'MEMO_DELETE', 'MEMO_DELETE:123', NOW)
    expect(found?.decision).toBe('approved')
    expect(found?.scopeKey).toBe('MEMO_DELETE:123')

    // 다른 범위 조회는 null
    expect(
      await store.findValidApproval('concierge', 'MEMO_DELETE', 'MEMO_DELETE:999', NOW),
    ).toBeNull()

    // 만료 시점 기준으로는 null
    const later = new Date('2026-10-27T08:00:00Z')
    expect(
      await store.findValidApproval('concierge', 'MEMO_DELETE', 'MEMO_DELETE:123', later),
    ).toBeNull()

    // 철회 후 null
    expect(await store.revokeApproval('concierge', 'MEMO_DELETE', 'MEMO_DELETE:123')).toBe(true)
    expect(
      await store.findValidApproval('concierge', 'MEMO_DELETE', 'MEMO_DELETE:123', NOW),
    ).toBeNull()
    expect(await store.revokeApproval('concierge', 'MEMO_DELETE', 'MEMO_DELETE:123')).toBe(false)
  })

  test('같은 범위 재결정은 upsert (UNIQUE 위반 없음)', async () => {
    const fake = new FakeD1()
    const store = new ToolApprovalStore(asD1(fake))
    await store.recordApproval({
      personaId: 'concierge',
      tool: 'MEMO_DELETE',
      scopeKey: 'MEMO_DELETE:5',
      decision: 'denied',
      expiresAt: null,
    })
    await store.recordApproval({
      personaId: 'concierge',
      tool: 'MEMO_DELETE',
      scopeKey: 'MEMO_DELETE:5',
      decision: 'approved',
      expiresAt: FUTURE,
    })
    const found = await store.findValidApproval('concierge', 'MEMO_DELETE', 'MEMO_DELETE:5', NOW)
    expect(found?.decision).toBe('approved')
    expect(fake.tables.tool_approvals.filter((r) => r.scope_key === 'MEMO_DELETE:5')).toHaveLength(1)
  })
})

describe('ToolApprovalStore 세션 허용 (이 세션 허용)', () => {
  test('기록 → 조회 → 다른 대화에서는 null → 만료 → 철회', async () => {
    const fake = new FakeD1()
    const store = new ToolApprovalStore(asD1(fake))

    await store.recordSessionAllowance('concierge', 'MEMO_CREATE', 7, NOW)
    const found = await store.findSessionAllowance('concierge', 'MEMO_CREATE', 7, NOW)
    expect(found?.decision).toBe('approved')
    expect(found?.scopeKey).toBe('SESSION:7:MEMO_CREATE')

    // 다른 대화에서는 허용 안 됨 (세션 스코프)
    expect(await store.findSessionAllowance('concierge', 'MEMO_CREATE', 8, NOW)).toBeNull()
    // 다른 도구도 허용 안 됨 (도구 종류 단위)
    expect(await store.findSessionAllowance('concierge', 'MEMO_DELETE', 7, NOW)).toBeNull()

    // 24시간 뒤 만료
    const later = new Date(NOW.getTime() + 25 * 60 * 60 * 1000)
    expect(await store.findSessionAllowance('concierge', 'MEMO_CREATE', 7, later)).toBeNull()

    // 철회 후 null
    expect(await store.revokeSessionAllowance('concierge', 'MEMO_CREATE', 7)).toBe(true)
    expect(await store.findSessionAllowance('concierge', 'MEMO_CREATE', 7, NOW)).toBeNull()
  })
})
