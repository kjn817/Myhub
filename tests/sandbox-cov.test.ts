/**
 * 샌드박스 격리 커버리지 보강 (그룹 E)
 * - snippet 100자 절단 + 공백 정규화
 * - textOf 빈 값 폴백 (빈 메모/제목 없음/내용 없음/빈 내용)
 * - SCHEDULE/TODO/CRON 대상 없음 + 수정·삭제·완료·토글 전 분기
 * - targetId 문자열 숫자/비숫자/소수, asRecord 비객체 인자
 * - 미리보기 불가 도구 (ARTIFACT_FROM_GITHUB/GCAL_CREATE)
 * - formatDryRunPreview: 양쪽 값 있음/대상 라벨 폴백/둘 다 null
 * - SandboxAuditStore: insert 실패, limit, conversationId null, detail 경계
 */
import {
  buildDryRunPreview,
  formatDryRunPreview,
  SandboxAuditStore,
  type DryRunPreview,
} from '../src/services/sandbox'
import { FakeD1, asD1 } from './fake-d1'

function makeFake(): FakeD1 {
  const fake = new FakeD1()
  fake.tables.memos.push(
    { id: 123, text: '회의 준비\n내일 10시 발표 자료 정리', sensitivity: 1, is_locked: 0 },
    { id: 200, text: '가'.repeat(150), sensitivity: 1, is_locked: 0 },
    { id: 201, text: 'a\n\n  b\t c', sensitivity: 1, is_locked: 0 },
  )
  fake.tables.schedules.push(
    {
      id: 7, title: '주간 회의', description: '', location: '',
      start_at: '2026-10-27T10:00', end_at: '2026-10-27T11:00',
      timezone: 'Asia/Seoul', recurrence_rule: null, status: 'active',
      created_at: '', updated_at: '',
    },
    {
      id: 8, title: '시간 없는 일정', description: '', location: '',
      start_at: '', end_at: '', timezone: 'Asia/Seoul',
      recurrence_rule: null, status: 'active', created_at: '', updated_at: '',
    },
  )
  fake.tables.todos.push(
    { id: 9, title: '보고서 제출', description: '', due_at: null, priority: 1, status: 'pending' },
    { id: 10, title: '상태 없는 할 일', description: '', due_at: null, priority: 1, status: null },
  )
  fake.tables.user_cron_jobs.push(
    {
      id: 5, action: 'briefing', nl_text: '매일 아침 8시 브리핑',
      cron_kst: '0 8 * * *', timezone: 'Asia/Seoul',
      next_run_at: '2026-10-27T08:00:00Z', enabled: 1, created_at: '', updated_at: '',
    },
    {
      id: 6, action: 'briefing', nl_text: '매주 월요일 브리핑',
      cron_kst: '0 8 * * 1', timezone: 'Asia/Seoul',
      next_run_at: '2026-11-02T08:00:00Z', enabled: 0, created_at: '', updated_at: '',
    },
  )
  return fake
}

/** run()이 last_row_id 없는 meta를 돌려주는 DB (insert 실패 경로) */
const brokenInsertDb = {
  prepare() {
    return {
      bind() {
        return {
          async run() { return { success: true, meta: {} } },
          async all() { return { success: true, results: [] } },
          async first() { return null },
        }
      },
    }
  },
} as unknown as D1Database

describe('snippet — 100자 절단·공백 정규화', () => {
  test('100자 초과 스니펫은 100자 + …로 절단', async () => {
    const p = await buildDryRunPreview(asD1(makeFake()), 'MEMO_DELETE', { id: 200 }, 'MEMO_DELETE:200')
    expect(p.changes[0].before).toBe(`"${'가'.repeat(100)}…"`)
  })

  test('줄바꿈·탭·연속 공백은 한 칸으로 접힘', async () => {
    const p = await buildDryRunPreview(asD1(makeFake()), 'MEMO_DELETE', { id: 201 }, 'MEMO_DELETE:201')
    expect(p.changes[0].before).toBe('"a b c"')
  })
})

describe('buildDryRunPreview — 생성 도구 빈 값 폴백', () => {
  test('인자 없음·공백만 있으면 빈 값 표시', async () => {
    const db = asD1(makeFake())
    const m = await buildDryRunPreview(db, 'MEMO_CREATE', {}, 'MEMO_CREATE')
    expect(m.changes).toEqual([{ field: '내용', before: null, after: '(빈 메모)' }])
    expect((await buildDryRunPreview(db, 'MEMO_CREATE', { text: '   ' }, 'MEMO_CREATE')).changes[0].after)
      .toBe('(빈 메모)')
    const s = await buildDryRunPreview(db, 'SCHEDULE_CREATE', {}, 'SCHEDULE_CREATE')
    expect(s.changes).toEqual([{ field: '일정', before: null, after: '(제목 없음)' }])
    const t = await buildDryRunPreview(db, 'TODO_ADD', {}, 'TODO_ADD')
    expect(t.changes).toEqual([{ field: '할 일', before: null, after: '(제목 없음)' }])
    const c = await buildDryRunPreview(db, 'CRON_CREATE', {}, 'CRON_CREATE')
    expect(c.changes).toEqual([{ field: '자동화', before: null, after: '(내용 없음)' }])
    const c2 = await buildDryRunPreview(db, 'CRON_CREATE', { nlText: '매일 브리핑' }, 'CRON_CREATE')
    expect(c2.changes[0].after).toBe('"매일 브리핑"')
  })

  test('MEMO_UPDATE: 새 내용 없으면 (빈 내용)', async () => {
    const p = await buildDryRunPreview(asD1(makeFake()), 'MEMO_UPDATE', { id: 123 }, 'MEMO_UPDATE:123')
    expect(p.changes).toEqual([
      { field: '내용', before: '"회의 준비 내일 10시 발표 자료 정리"', after: '(빈 내용)' },
    ])
  })

  test('미리보기 불가 도구: ARTIFACT_FROM_GITHUB / GCAL_CREATE', async () => {
    const db = asD1(makeFake())
    for (const tool of ['ARTIFACT_FROM_GITHUB', 'GCAL_CREATE']) {
      const p = await buildDryRunPreview(db, tool, { title: 'x' }, tool)
      expect(p.unavailable).toBe(true)
      expect(p.targetLabel).toBe('새 항목')
      expect(p.warnings[0]).toContain('미리보기를 만들 수 없어요')
    }
  })
})

describe('buildDryRunPreview — targetId·asRecord 경계', () => {
  test('문자열 숫자 id도 대상을 찾음', async () => {
    const db = asD1(makeFake())
    expect((await buildDryRunPreview(db, 'MEMO_DELETE', { id: '123' }, 'MEMO_DELETE:123')).targetFound).toBe(true)
    expect((await buildDryRunPreview(db, 'TODO_DONE', { todoId: '9' }, 'TODO_DONE:9')).targetFound).toBe(true)
  })

  test('비숫자 문자열·소수 id는 대상 특정 불가', async () => {
    const db = asD1(makeFake())
    for (const args of [{ id: 'abc' }, { id: 1.5 }, { id: '' }]) {
      const p = await buildDryRunPreview(db, 'MEMO_DELETE', args, 'MEMO_DELETE')
      expect(p.unavailable).toBe(true)
      expect(p.warnings[0]).toContain('대상을 특정할 수 없어서')
    }
  })

  test('인자가 null·문자열이면 대상 특정 불가', async () => {
    const db = asD1(makeFake())
    for (const args of [null, 'text', 42]) {
      const p = await buildDryRunPreview(db, 'MEMO_DELETE', args, 'MEMO_DELETE')
      expect(p.unavailable).toBe(true)
    }
  })
})

describe('buildDryRunPreview — 일정 미리보기 전 분기', () => {
  test('SCHEDULE_DELETE / SCHEDULE_UPDATE: 대상 없음 경고', async () => {
    const db = asD1(makeFake())
    const d = await buildDryRunPreview(db, 'SCHEDULE_DELETE', { id: 999 }, 'SCHEDULE_DELETE:999')
    expect(d.targetFound).toBe(false)
    expect(d.targetLabel).toBe('일정 #999')
    expect(d.warnings).toEqual(['대상을 찾을 수 없어요. 승인해도 실행이 실패할 거예요.'])
    const u = await buildDryRunPreview(db, 'SCHEDULE_UPDATE', { id: 999, title: 'x' }, 'SCHEDULE_UPDATE:999')
    expect(u.targetFound).toBe(false)
    expect(u.warnings).toEqual(['대상을 찾을 수 없어요. 승인해도 실행이 실패할 거예요.'])
  })

  test('SCHEDULE_UPDATE: 제목 변경 전후 표시, 새 제목 없으면 after null', async () => {
    const db = asD1(makeFake())
    const u = await buildDryRunPreview(db, 'SCHEDULE_UPDATE', { id: 7, title: '주간 회의 변경' }, 'SCHEDULE_UPDATE:7')
    expect(u.targetFound).toBe(true)
    expect(u.targetLabel).toBe('일정 #7 "주간 회의"')
    expect(u.changes).toEqual([
      { field: '제목', before: '"주간 회의"', after: '"주간 회의 변경"' },
    ])
    const u2 = await buildDryRunPreview(db, 'SCHEDULE_UPDATE', { id: 7 }, 'SCHEDULE_UPDATE:7')
    expect(u2.changes[0].after).toBeNull()
  })

  test('SCHEDULE_DELETE: start_at이 비어 있으면 라벨만 before로', async () => {
    const p = await buildDryRunPreview(asD1(makeFake()), 'SCHEDULE_DELETE', { id: 8 }, 'SCHEDULE_DELETE:8')
    expect(p.changes).toEqual([
      { field: '일정', before: '일정 #8 "시간 없는 일정"', after: null },
    ])
  })
})

describe('buildDryRunPreview — 할 일 미리보기 전 분기', () => {
  test('TODO_DELETE / TODO_UPDATE / TODO_DONE: 대상 없음 경고', async () => {
    const db = asD1(makeFake())
    for (const tool of ['TODO_DELETE', 'TODO_UPDATE', 'TODO_DONE'] as const) {
      const p = await buildDryRunPreview(db, tool, { id: 999 }, `${tool}:999`)
      expect(p.targetFound).toBe(false)
      expect(p.targetLabel).toBe('할 일 #999')
      expect(p.warnings).toEqual(['대상을 찾을 수 없어요. 승인해도 실행이 실패할 거예요.'])
    }
  })

  test('TODO_DELETE 성공 미리보기', async () => {
    const p = await buildDryRunPreview(asD1(makeFake()), 'TODO_DELETE', { id: 9 }, 'TODO_DELETE:9')
    expect(p.targetFound).toBe(true)
    expect(p.changes).toEqual([{ field: '할 일', before: '할 일 #9 "보고서 제출"', after: null }])
  })

  test('TODO_UPDATE: 제목 변경 전후, 새 제목 없으면 after null', async () => {
    const db = asD1(makeFake())
    const u = await buildDryRunPreview(db, 'TODO_UPDATE', { id: 9, title: '보고서 제출 완료' }, 'TODO_UPDATE:9')
    expect(u.changes).toEqual([
      { field: '제목', before: '"보고서 제출"', after: '"보고서 제출 완료"' },
    ])
    const u2 = await buildDryRunPreview(db, 'TODO_UPDATE', { id: 9 }, 'TODO_UPDATE:9')
    expect(u2.changes[0].after).toBeNull()
  })

  test('TODO_DONE: status가 null이면 before는 pending', async () => {
    const p = await buildDryRunPreview(asD1(makeFake()), 'TODO_DONE', { id: 10 }, 'TODO_DONE:10')
    expect(p.changes).toEqual([{ field: '상태', before: 'pending', after: 'done' }])
  })
})

describe('buildDryRunPreview — 자동화 미리보기 전 분기', () => {
  test('CRON_DELETE / CRON_TOGGLE: 대상 없음 경고', async () => {
    const db = asD1(makeFake())
    const d = await buildDryRunPreview(db, 'CRON_DELETE', { id: 999 }, 'CRON_DELETE:999')
    expect(d.targetFound).toBe(false)
    expect(d.targetLabel).toBe('자동화 #999')
    expect(d.warnings).toEqual(['대상을 찾을 수 없어요. 승인해도 실행이 실패할 거예요.'])
    const t = await buildDryRunPreview(db, 'CRON_TOGGLE', { id: 999, enabled: true }, 'CRON_TOGGLE:999')
    expect(t.targetFound).toBe(false)
    expect(t.warnings).toEqual(['대상을 찾을 수 없어요. 승인해도 실행이 실패할 거예요.'])
  })

  test('CRON_TOGGLE: 켜기/판단 불가 + 꺼진 행의 before는 꺼짐', async () => {
    const db = asD1(makeFake())
    const on = await buildDryRunPreview(db, 'CRON_TOGGLE', { id: 5, enabled: true }, 'CRON_TOGGLE:5')
    expect(on.changes).toEqual([{ field: '상태', before: '켜짐', after: '켜짐' }])
    const unknown = await buildDryRunPreview(db, 'CRON_TOGGLE', { id: 5 }, 'CRON_TOGGLE:5')
    expect(unknown.changes).toEqual([{ field: '상태', before: '켜짐', after: '변경' }])
    const offRow = await buildDryRunPreview(db, 'CRON_TOGGLE', { id: 6, enabled: true }, 'CRON_TOGGLE:6')
    expect(offRow.changes).toEqual([{ field: '상태', before: '꺼짐', after: '켜짐' }])
    expect(offRow.targetLabel).toBe('자동화 #6 "매주 월요일 브리핑"')
  })
})

describe('memoHidden — 불리언 잠금·민감도/스니펫 결측', () => {
  test('is_locked: true(불리언) 메모도 잠금으로 취급', async () => {
    const fake = makeFake()
    fake.tables.memos.push({ id: 202, text: '불리언 잠금 메모', sensitivity: 1, is_locked: true })
    const p = await buildDryRunPreview(asD1(fake), 'MEMO_DELETE', { id: 202 }, 'MEMO_DELETE:202')
    expect(p.targetLocked).toBe(true)
    expect(p.changes[0].before).toContain('잠긴 메모')
    expect(JSON.stringify(p)).not.toContain('불리언 잠금 메모')
    expect(p.warnings).toEqual(['잠긴 메모는 삭제할 수 없어요. 승인해도 실행이 차단돼요.'])
  })

  test('sensitivity·snippet 키가 없는 행은 기본값으로 처리 (숨김 아님·빈 스니펫)', async () => {
    const stubDb = {
      prepare() {
        return {
          bind() {
            return {
              async first() { return { id: 203, is_locked: 0 } },
              async all() { return { results: [] } },
              async run() { return { success: true, meta: {} } },
            }
          },
        }
      },
    } as unknown as D1Database
    const p = await buildDryRunPreview(stubDb, 'MEMO_DELETE', { id: 203 }, 'MEMO_DELETE:203')
    expect(p.targetFound).toBe(true)
    expect(p.targetLocked).toBe(false)
    expect(p.changes).toEqual([{ field: '메모', before: '""', after: null }])
  })
})

describe('buildDryRunPreview — null 제목·시간·자동화 문구', () => {
  test('제목·시간이 null인 일정/할 일/자동화도 라벨 생성', async () => {
    const fake = makeFake()
    fake.tables.schedules.push({
      id: 11, title: null, description: '', location: '',
      start_at: null, end_at: null, timezone: 'Asia/Seoul',
      recurrence_rule: null, status: 'active', created_at: '', updated_at: '',
    })
    fake.tables.todos.push({ id: 11, title: null, description: '', due_at: null, priority: 1, status: 'pending' })
    fake.tables.user_cron_jobs.push({
      id: 11, action: 'briefing', nl_text: null, cron_kst: '0 8 * * *',
      timezone: 'Asia/Seoul', next_run_at: null, enabled: 1, created_at: '', updated_at: '',
    })
    const db = asD1(fake)
    const s = await buildDryRunPreview(db, 'SCHEDULE_DELETE', { id: 11 }, 'SCHEDULE_DELETE:11')
    expect(s.targetFound).toBe(true)
    expect(s.targetLabel).toBe('일정 #11 ""')
    expect(s.changes).toEqual([{ field: '일정', before: '일정 #11 ""', after: null }])
    const t = await buildDryRunPreview(db, 'TODO_DELETE', { id: 11 }, 'TODO_DELETE:11')
    expect(t.targetLabel).toBe('할 일 #11 ""')
    const u = await buildDryRunPreview(db, 'TODO_UPDATE', { id: 11, title: '새 제목' }, 'TODO_UPDATE:11')
    expect(u.changes).toEqual([{ field: '제목', before: '""', after: '"새 제목"' }])
    const su = await buildDryRunPreview(db, 'SCHEDULE_UPDATE', { id: 11 }, 'SCHEDULE_UPDATE:11')
    expect(su.targetFound).toBe(true)
    expect(su.changes).toEqual([{ field: '제목', before: '""', after: null }])
    const c = await buildDryRunPreview(db, 'CRON_DELETE', { id: 11 }, 'CRON_DELETE:11')
    expect(c.targetLabel).toBe('자동화 #11 ""')
    expect(c.changes).toEqual([{ field: '자동화', before: '자동화 #11 ""', after: null }])
  })
})

describe('SandboxAuditStore — listRecent 매핑 폴백', () => {
  test('필드 결측 행은 기본값으로 매핑 (id 비숫자 → undefined, 나머지는 빈 문자열)', async () => {
    const fake = new FakeD1()
    fake.tables.tool_execution_audit.push({
      id: 'not-a-number',
      persona_id: undefined,
      conversation_id: 5,
      tool: undefined,
      scope_key: undefined,
      action: 'denied',
      detail: undefined,
      created_at: undefined,
    })
    const store = new SandboxAuditStore(asD1(fake))
    const rows = await store.listRecent(5)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      id: undefined,
      personaId: '',
      conversationId: 5,
      tool: '',
      scopeKey: '',
      action: 'denied',
      detail: '',
      createdAt: '',
    })
  })

  test('all()이 results 없이 반환하면 빈 목록', async () => {
    const stubDb = {
      prepare() {
        return {
          bind() {
            return {
              async all() { return {} },
              async first() { return null },
              async run() { return { success: true, meta: {} } },
            }
          },
        }
      },
    } as unknown as D1Database
    const store = new SandboxAuditStore(stubDb)
    expect(await store.listRecent(1)).toEqual([])
  })
})

describe('formatDryRunPreview — 나머지 분기', () => {
  test('양쪽 값 있음: before → after 행', async () => {
    const p = await buildDryRunPreview(asD1(makeFake()), 'MEMO_UPDATE', { id: 123, text: '회의 준비 완료' }, 'MEMO_UPDATE:123')
    const text = formatDryRunPreview(p)
    expect(text).toContain('- 내용: "회의 준비 내일 10시 발표 자료 정리" → "회의 준비 완료"')
  })

  test('unavailable + targetLabel 비어 있으면 도구명 폴백', () => {
    const preview: DryRunPreview = {
      tool: 'SOME_TOOL',
      scopeKey: 'SOME_TOOL',
      risk: 'destructive',
      targetFound: false,
      targetLocked: false,
      targetLabel: '',
      changes: [],
      warnings: ['이 작업은 미리보기를 만들 수 없어요.'],
      unavailable: true,
    }
    const text = formatDryRunPreview(preview)
    expect(text).toContain('대상: SOME_TOOL')
    expect(text).toContain('⚠️ 이 작업은 미리보기를 만들 수 없어요.')
  })

  test('before·after 둘 다 null인 변경은 행을 만들지 않음', () => {
    const preview: DryRunPreview = {
      tool: 'SCHEDULE_UPDATE',
      scopeKey: 'SCHEDULE_UPDATE:7',
      risk: 'write',
      targetFound: true,
      targetLocked: false,
      targetLabel: '일정 #7 "주간 회의"',
      changes: [{ field: '제목', before: null, after: null }],
      warnings: [],
      unavailable: false,
    }
    const text = formatDryRunPreview(preview)
    expect(text).toContain('대상: 일정 #7 "주간 회의"')
    expect(text).not.toContain('- 제목:')
  })
})

describe('SandboxAuditStore — 실패·경계 경로', () => {
  test('insert가 last_row_id를 안 돌려주면 에러', async () => {
    const store = new SandboxAuditStore(brokenInsertDb)
    await expect(store.recordAudit({
      personaId: 'concierge', conversationId: 1, tool: 'MEMO_DELETE',
      scopeKey: 'MEMO_DELETE:1', action: 'preview_shown', detail: 'x',
    })).rejects.toThrow('sandbox audit insert failed')
  })

  test('listRecent limit이 적용됨 (최신 1건만)', async () => {
    const fake = new FakeD1()
    const store = new SandboxAuditStore(asD1(fake))
    for (const action of ['preview_shown', 'executed', 'denied'] as const) {
      await store.recordAudit({
        personaId: 'concierge', conversationId: 42, tool: 'MEMO_DELETE',
        scopeKey: 'MEMO_DELETE:123', action, detail: action,
      })
    }
    const rows = await store.listRecent(42, 1)
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('denied')
    expect(await store.listRecent(42)).toHaveLength(3)
  })

  test('conversationId null + createdAt 생략 시 기본 시각으로 기록', async () => {
    const fake = new FakeD1()
    const store = new SandboxAuditStore(asD1(fake))
    const id = await store.recordAudit({
      personaId: 'concierge', conversationId: null, tool: 'MEMO_DELETE',
      scopeKey: 'MEMO_DELETE:1', action: 'expired', detail: '만료됨',
    })
    expect(id).toBeGreaterThan(0)
    const row = fake.tables.tool_execution_audit.find((r) => r.id === id)
    expect(row?.conversation_id).toBeNull()
    expect(typeof row?.created_at).toBe('string')
    expect(row?.created_at.length).toBeGreaterThan(0)
    const listed = await store.listRecent(null as unknown as number)
    expect(listed).toHaveLength(1)
    expect(listed[0].conversationId).toBeNull()
  })

  test('detail 2000자 경계: 2000자는 그대로, 2001자는 절단', async () => {
    const fake = new FakeD1()
    const store = new SandboxAuditStore(asD1(fake))
    await store.recordAudit({
      personaId: 'concierge', conversationId: 1, tool: 'MEMO_DELETE',
      scopeKey: 'MEMO_DELETE:1', action: 'preview_shown', detail: 'y'.repeat(2000),
    })
    await store.recordAudit({
      personaId: 'concierge', conversationId: 1, tool: 'MEMO_DELETE',
      scopeKey: 'MEMO_DELETE:1', action: 'preview_shown', detail: 'z'.repeat(2001),
    })
    const rows = await store.listRecent(1)
    expect(rows.find((r) => r.detail.startsWith('z'))?.detail.length).toBe(2000)
    expect(rows.find((r) => r.detail.startsWith('y'))?.detail.length).toBe(2000)
  })
})
