/**
 * 샌드박스 격리 테스트 (진짜 비서 3단계 i트랙)
 * - dry-run 미리보기: 읽기 전용 조회로 "무엇이 바뀌는지" 계산, 아무것도 바꾸지 않음
 * - 잠긴 메모·민감 메모 내용은 미리보기·감사 로그에 절대 노출하지 않음
 * - 실행 감사 로그: preview_shown / executed / denied / expired 기록·조회
 * - 승인 문안에 미리보기 섹션이 붙음
 */
import {
  buildDryRunPreview,
  formatDryRunPreview,
  SandboxAuditStore,
  type DryRunPreview,
} from '../src/services/sandbox'
import { buildApprovalRequestText } from '../src/services/approval-flow'
import { FakeD1, asD1 } from './fake-d1'

function makeFake(): FakeD1 {
  const fake = new FakeD1()
  fake.tables.memos.push(
    { id: 123, text: '회의 준비\n내일 10시 발표 자료 정리', sensitivity: 1, is_locked: 0 },
    { id: 124, text: '카드번호 4111 1111 1111 1111 / 비밀번호 secret123', sensitivity: 1, is_locked: 1 },
    { id: 125, text: '인사 평가 초안 — 비공개', sensitivity: 3, is_locked: 0 },
    { id: 126, text: 'API키는 sk-abcdefghij1234567890 이야', sensitivity: 1, is_locked: 0 },
  )
  fake.tables.schedules.push({
    id: 7,
    title: '주간 회의',
    description: '',
    location: '',
    start_at: '2026-10-27T10:00',
    end_at: '2026-10-27T11:00',
    timezone: 'Asia/Seoul',
    recurrence_rule: null,
    status: 'active',
    created_at: '',
    updated_at: '',
  })
  fake.tables.todos.push({ id: 9, title: '보고서 제출', description: '', due_at: null, priority: 1, status: 'pending' })
  fake.tables.user_cron_jobs.push({
    id: 5,
    action: 'briefing',
    nl_text: '매일 아침 8시 브리핑',
    cron_kst: '0 8 * * *',
    timezone: 'Asia/Seoul',
    next_run_at: '2026-10-27T08:00:00Z',
    enabled: 1,
    created_at: '',
    updated_at: '',
  })
  return fake
}

describe('buildDryRunPreview — 삭제·수정 미리보기', () => {
  test('MEMO_DELETE: 대상 메모 내용을 before로 보여주고 after는 삭제됨', async () => {
    const fake = makeFake()
    const p = await buildDryRunPreview(asD1(fake), 'MEMO_DELETE', { id: 123 }, 'MEMO_DELETE:123')
    expect(p.targetFound).toBe(true)
    expect(p.targetLocked).toBe(false)
    expect(p.risk).toBe('destructive')
    expect(p.targetLabel).toBe('메모 #123')
    expect(p.changes).toEqual([{ field: '메모', before: '"회의 준비 내일 10시 발표 자료 정리"', after: null }])
    expect(p.warnings).toEqual([])
  })

  test('MEMO_UPDATE: 변경 전후 내용을 보여줌', async () => {
    const fake = makeFake()
    const p = await buildDryRunPreview(asD1(fake), 'MEMO_UPDATE', { id: 123, text: '회의 준비 완료' }, 'MEMO_UPDATE:123')
    expect(p.targetFound).toBe(true)
    expect(p.changes).toEqual([{ field: '내용', before: '"회의 준비 내일 10시 발표 자료 정리"', after: '"회의 준비 완료"' }])
  })

  test('MEMO_DELETE: 잠긴 메모는 내용을 숨기고 실행 차단 경고를 보여줌', async () => {
    const fake = makeFake()
    const p = await buildDryRunPreview(asD1(fake), 'MEMO_DELETE', { id: 124 }, 'MEMO_DELETE:124')
    expect(p.targetFound).toBe(true)
    expect(p.targetLocked).toBe(true)
    expect(JSON.stringify(p)).not.toContain('4111')
    expect(JSON.stringify(p)).not.toContain('secret123')
    expect(p.changes[0].before).toContain('잠긴 메모')
    expect(p.warnings).toEqual(['잠긴 메모는 삭제할 수 없어요. 승인해도 실행이 차단돼요.'])
  })

  test('MEMO_UPDATE: 잠긴 메모 수정도 내용 비노출 + 차단 경고', async () => {
    const fake = makeFake()
    const p = await buildDryRunPreview(asD1(fake), 'MEMO_UPDATE', { id: 124, text: '바꾸기' }, 'MEMO_UPDATE:124')
    expect(p.targetLocked).toBe(true)
    expect(JSON.stringify(p)).not.toContain('4111')
    expect(p.warnings[0]).toContain('수정할 수 없어요')
  })

  test('MEMO_DELETE: sensitivity>=2 메모도 내용을 숨김', async () => {
    const fake = makeFake()
    const p = await buildDryRunPreview(asD1(fake), 'MEMO_DELETE', { id: 125 }, 'MEMO_DELETE:125')
    expect(JSON.stringify(p)).not.toContain('인사 평가')
    expect(p.changes[0].before).toContain('내용을 볼 수 없어요')
  })

  test('MEMO_DELETE: 메모 속 시크릿은 미리보기에서 마스킹됨', async () => {
    const fake = makeFake()
    const p = await buildDryRunPreview(asD1(fake), 'MEMO_DELETE', { id: 126 }, 'MEMO_DELETE:126')
    expect(JSON.stringify(p)).not.toContain('sk-abcdefghij1234567890')
    expect(p.changes[0].before).toContain('[API_KEY_MASKED]')
  })

  test('MEMO_DELETE: 대상이 없으면 "찾을 수 없음" 경고 (승인해도 실패)', async () => {
    const fake = makeFake()
    const p = await buildDryRunPreview(asD1(fake), 'MEMO_DELETE', { id: 999 }, 'MEMO_DELETE:999')
    expect(p.targetFound).toBe(false)
    expect(p.warnings).toEqual(['대상을 찾을 수 없어요. 승인해도 실행이 실패할 거예요.'])
  })

  test('SCHEDULE_DELETE / TODO_DONE / CRON_DELETE / CRON_TOGGLE 미리보기', async () => {
    const fake = makeFake()
    const db = asD1(fake)
    const s = await buildDryRunPreview(db, 'SCHEDULE_DELETE', { id: 7 }, 'SCHEDULE_DELETE:7')
    expect(s.targetFound).toBe(true)
    expect(s.changes[0].before).toContain('주간 회의')
    expect(s.changes[0].after).toBeNull()
    const t = await buildDryRunPreview(db, 'TODO_DONE', { id: 9 }, 'TODO_DONE:9')
    expect(t.changes).toEqual([{ field: '상태', before: 'pending', after: 'done' }])
    const c = await buildDryRunPreview(db, 'CRON_DELETE', { id: 5 }, 'CRON_DELETE:5')
    expect(c.targetFound).toBe(true)
    expect(c.changes[0].before).toContain('매일 아침 8시 브리핑')
    const tog = await buildDryRunPreview(db, 'CRON_TOGGLE', { id: 5, enabled: false }, 'CRON_TOGGLE:5')
    expect(tog.changes).toEqual([{ field: '상태', before: '켜짐', after: '꺼짐' }])
  })

  test('dry-run은 DB를 바꾸지 않는다 (읽기 전용)', async () => {
    const fake = makeFake()
    const before = JSON.stringify(fake.tables)
    const db = asD1(fake)
    await buildDryRunPreview(db, 'MEMO_DELETE', { id: 123 }, 'MEMO_DELETE:123')
    await buildDryRunPreview(db, 'MEMO_UPDATE', { id: 123, text: '바꿈' }, 'MEMO_UPDATE:123')
    await buildDryRunPreview(db, 'SCHEDULE_DELETE', { id: 7 }, 'SCHEDULE_DELETE:7')
    await buildDryRunPreview(db, 'TODO_DONE', { id: 9 }, 'TODO_DONE:9')
    await buildDryRunPreview(db, 'CRON_DELETE', { id: 5 }, 'CRON_DELETE:5')
    expect(JSON.stringify(fake.tables)).toBe(before)
  })
})

describe('buildDryRunPreview — 생성 도구·미리보기 불가 도구', () => {
  test('MEMO_CREATE / SCHEDULE_CREATE / TODO_ADD / CRON_CREATE: 만들 내용 표시', async () => {
    const fake = makeFake()
    const db = asD1(fake)
    const m = await buildDryRunPreview(db, 'MEMO_CREATE', { text: '새 메모 내용' }, 'MEMO_CREATE')
    expect(m.changes).toEqual([{ field: '내용', before: null, after: '"새 메모 내용"' }])
    const s = await buildDryRunPreview(db, 'SCHEDULE_CREATE', { title: '치과', startAt: '2026-10-28T14:00' }, 'SCHEDULE_CREATE')
    expect(s.changes[0]).toEqual({ field: '일정', before: null, after: '"치과"' })
    expect(s.changes[1]).toEqual({ field: '시간', before: null, after: '2026-10-28T14:00' })
    const t = await buildDryRunPreview(db, 'TODO_ADD', { title: '우유 사기' }, 'TODO_ADD')
    expect(t.changes).toEqual([{ field: '할 일', before: null, after: '"우유 사기"' }])
    const c = await buildDryRunPreview(db, 'CRON_CREATE', { text: '매일 아침 브리핑' }, 'CRON_CREATE')
    expect(c.changes).toEqual([{ field: '자동화', before: null, after: '"매일 아침 브리핑"' }])
  })

  test('ARTIFACT_CREATE / 알 수 없는 도구: 미리보기 불가 + 경고', async () => {
    const fake = makeFake()
    const db = asD1(fake)
    const a = await buildDryRunPreview(db, 'ARTIFACT_CREATE', { title: '앱' }, 'ARTIFACT_CREATE')
    expect(a.unavailable).toBe(true)
    expect(a.warnings[0]).toContain('미리보기를 만들 수 없어요')
    const u = await buildDryRunPreview(db, 'SOME_NEW_TOOL', { id: 1 }, 'SOME_NEW_TOOL:1')
    expect(u.unavailable).toBe(true)
  })

  test('대상 id가 없으면 미리보기 불가', async () => {
    const fake = makeFake()
    const p = await buildDryRunPreview(asD1(fake), 'MEMO_DELETE', {}, 'MEMO_DELETE')
    expect(p.unavailable).toBe(true)
    expect(p.warnings[0]).toContain('대상을 특정할 수 없어서')
  })
})

describe('formatDryRunPreview', () => {
  test('삭제 미리보기 문안: 대상·변경·헤더 포함', async () => {
    const fake = makeFake()
    const p = await buildDryRunPreview(asD1(fake), 'MEMO_DELETE', { id: 123 }, 'MEMO_DELETE:123')
    const text = formatDryRunPreview(p)
    expect(text).toContain('[실행 전 미리보기 — 아직 아무것도 바뀌지 않았어요]')
    expect(text).toContain('대상: 메모 #123')
    expect(text).toContain('→ (삭제됨)')
  })

  test('경고가 있으면 ⚠️ 행으로 포함', async () => {
    const fake = makeFake()
    const p = await buildDryRunPreview(asD1(fake), 'MEMO_DELETE', { id: 124 }, 'MEMO_DELETE:124')
    const text = formatDryRunPreview(p)
    expect(text).toContain('⚠️ 잠긴 메모는 삭제할 수 없어요')
    expect(text).not.toContain('4111')
  })

  test('생성 미리보기 문안: (없음) → 새 값', () => {
    const preview: DryRunPreview = {
      tool: 'MEMO_CREATE',
      scopeKey: 'MEMO_CREATE',
      risk: 'write',
      targetFound: false,
      targetLocked: false,
      targetLabel: '새 메모',
      changes: [{ field: '내용', before: null, after: '"새 메모"' }],
      warnings: [],
      unavailable: false,
    }
    expect(formatDryRunPreview(preview)).toContain('- 내용: (없음) → "새 메모"')
  })
})

describe('buildApprovalRequestText + dry-run 미리보기', () => {
  test('미리보기가 있으면 승인 문안 뒤에 붙고, 없으면 붙지 않음', async () => {
    const fake = makeFake()
    const p = await buildDryRunPreview(asD1(fake), 'MEMO_DELETE', { id: 123 }, 'MEMO_DELETE:123')
    const withPreview = buildApprovalRequestText({
      summary: '메모 #123 삭제',
      userRequest: '메모 123 지워줘',
      reversible: false,
      impact: '메모 1개가 영구히 삭제됩니다.',
      dryRunPreview: formatDryRunPreview(p),
    })
    expect(withPreview).toContain('[승인이 필요해요]')
    expect(withPreview).toContain('[실행 전 미리보기')
    expect(withPreview).toContain('대상: 메모 #123')
    expect(withPreview).toContain('"승인해" / "거부해"')
    const withoutPreview = buildApprovalRequestText({
      summary: '메모 #123 삭제',
      userRequest: '',
      reversible: false,
      impact: '메모 1개가 영구히 삭제됩니다.',
    })
    expect(withoutPreview).not.toContain('[실행 전 미리보기')
  })
})

describe('SandboxAuditStore — 실행 감사 로그', () => {
  test('preview_shown → executed 순서로 기록·조회 (최신순)', async () => {
    const fake = new FakeD1()
    const db = asD1(fake)
    const store = new SandboxAuditStore(db)
    await store.recordAudit({
      personaId: 'concierge',
      conversationId: 42,
      tool: 'MEMO_DELETE',
      scopeKey: 'MEMO_DELETE:123',
      action: 'preview_shown',
      detail: '메모 #123 삭제',
      createdAt: '2026-10-26T04:00:00Z',
    })
    await store.recordAudit({
      personaId: 'concierge',
      conversationId: 42,
      tool: 'MEMO_DELETE',
      scopeKey: 'MEMO_DELETE:123',
      action: 'executed',
      detail: '메모 #123 삭제',
      createdAt: '2026-10-26T04:01:00Z',
    })
    const rows = await store.listRecent(42)
    expect(rows).toHaveLength(2)
    expect(rows[0].action).toBe('executed')
    expect(rows[1].action).toBe('preview_shown')
    expect(rows[0].tool).toBe('MEMO_DELETE')
    expect(rows[0].personaId).toBe('concierge')
    expect(rows[0].conversationId).toBe(42)
  })

  test('다른 대화의 기록은 조회되지 않음', async () => {
    const fake = new FakeD1()
    const store = new SandboxAuditStore(asD1(fake))
    await store.recordAudit({
      personaId: 'concierge',
      conversationId: 7,
      tool: 'TODO_DELETE',
      scopeKey: 'TODO_DELETE:9',
      action: 'denied',
      detail: '할 일 #9 삭제',
    })
    expect(await store.listRecent(42)).toHaveLength(0)
    expect(await store.listRecent(7)).toHaveLength(1)
  })

  test('detail은 2000자로 절단됨', async () => {
    const fake = new FakeD1()
    const store = new SandboxAuditStore(asD1(fake))
    await store.recordAudit({
      personaId: 'concierge',
      conversationId: 1,
      tool: 'MEMO_DELETE',
      scopeKey: 'MEMO_DELETE:1',
      action: 'preview_shown',
      detail: 'x'.repeat(5000),
    })
    const rows = await store.listRecent(1)
    expect(rows[0].detail.length).toBe(2000)
  })

  test('감사 기록에 시크릿·잠긴 메모 내용이 들어가지 않음 (미리보기 JSON 경유)', async () => {
    const fake = makeFake()
    const db = asD1(fake)
    const store = new SandboxAuditStore(db)
    const p = await buildDryRunPreview(db, 'MEMO_DELETE', { id: 124 }, 'MEMO_DELETE:124')
    await store.recordAudit({
      personaId: 'concierge',
      conversationId: 42,
      tool: 'MEMO_DELETE',
      scopeKey: 'MEMO_DELETE:124',
      action: 'preview_shown',
      detail: JSON.stringify({ summary: '메모 #124 삭제', preview: p }),
    })
    const rows = await store.listRecent(42)
    expect(JSON.stringify(rows)).not.toContain('4111')
    expect(JSON.stringify(rows)).not.toContain('secret123')
  })
})
