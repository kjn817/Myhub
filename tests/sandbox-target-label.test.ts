/**
 * 승인 미리보기 대상 표기 회귀 (2026-10-31)
 *
 * 성질: 승인 scope·요약(summary)·dry-run 미리보기의 대상 표기는 전부
 * 실제 대상 하나를 가리켜야 한다. 트랙 3 라이브 QA에서 삭제 대상이
 * 아닌 번호가 미리보기에 표시된 보고가 있었다 — 원인 부류는 대상 id
 * 추출이 계층마다 흩어져 있는 것:
 * - sandbox(미리보기)·approval-flow(요약)·tool-approval(scope)의 추출
 *   키 집합이 서로 달라, 같은 인자에서도 계층마다 다른 대상을 가리킬
 *   수 있었다 (snake_case 대상 키 memo_id 등은 어느 계층도 못 봤다).
 * - ARTIFACT_DELETE는 미리보기 분기 자체가 없어 대상 대신 도구명이
 *   "대상:"으로 표시됐다.
 *
 * 카나리아: 추출 키 집합에서 memo_id를 빼거나 ARTIFACT_DELETE 분기를
 * 지우면 아래 단언이 실패한다. 미끼 행(메모 #2·#23)을 함께 심어,
 * 번호가 잘려 엉뚱한 행을 가리키는 회귀도 잡는다.
 */
import { buildDryRunPreview, formatDryRunPreview } from '../src/services/sandbox'
import { describeMaskedToolAction } from '../src/services/approval-flow'
import { approvalScopeKey } from '../src/services/tool-approval'
import { FakeD1, asD1 } from './fake-d1'

function makeFake(): FakeD1 {
  const fake = new FakeD1()
  fake.tables.memos.push(
    { id: 2, text: '미끼 메모 2 본문', sensitivity: 1, is_locked: 0 },
    { id: 23, text: '미끼 메모 23 본문', sensitivity: 1, is_locked: 0 },
    { id: 239, text: '실제 대상 메모 239 본문', sensitivity: 1, is_locked: 0 },
  )
  fake.tables.schedules.push({
    id: 239, title: '대상 일정 239', description: '', location: '',
    start_at: '2027-01-01T10:00', end_at: '2027-01-01T11:00',
    timezone: 'Asia/Seoul', recurrence_rule: null, status: 'active',
    created_at: '', updated_at: '',
  })
  fake.tables.todos.push({ id: 239, title: '대상 할 일 239', description: '', due_at: null, priority: 1, status: 'pending' })
  fake.tables.user_cron_jobs.push({
    id: 239, action: 'briefing', nl_text: '대상 자동화 239',
    cron_kst: '0 8 * * *', timezone: 'Asia/Seoul',
    next_run_at: '2027-01-01T08:00:00Z', enabled: 1, created_at: '', updated_at: '',
  })
  return fake
}

/** artifacts 조회만 답하는 스텁 DB (FakeD1은 artifacts 테이블이 없다) */
function artifactDb(row: Record<string, unknown> | null): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() { return row },
            async all() { return { results: row ? [row] : [] } },
            async run() { return { success: true, meta: {} } },
          }
        },
      }
    },
  } as unknown as D1Database
}

describe('승인 미리보기 대상 표기 — scope·요약·미리보기 일치', () => {
  test('MEMO_DELETE #239: 세 계층이 전부 메모 #239를 가리킨다 (미끼 #2·#23과 혼동 없음)', async () => {
    const db = asD1(makeFake())
    for (const args of [{ id: 239 }, { id: '239' }, { memoId: 239 }, { memo_id: 239 }]) {
      expect(approvalScopeKey('MEMO_DELETE', args)).toBe('MEMO_DELETE:239')
      expect(describeMaskedToolAction('MEMO_DELETE', args).summary).toBe('메모 #239 삭제')
      const p = await buildDryRunPreview(db, 'MEMO_DELETE', args, 'MEMO_DELETE:239')
      expect(p.targetFound).toBe(true)
      expect(p.targetLabel).toBe('메모 #239')
      expect(p.changes[0].before).toContain('실제 대상 메모 239 본문')
      expect(p.changes[0].before).not.toContain('미끼')
      expect(formatDryRunPreview(p)).toContain('대상: 메모 #239')
    }
  })

  test('MEMO_UPDATE #239: 요약·미리보기가 같은 대상을 가리킨다', async () => {
    const db = asD1(makeFake())
    const args = { id: 239, text: '새 내용' }
    expect(describeMaskedToolAction('MEMO_UPDATE', args).summary).toContain('메모 #239 수정')
    const p = await buildDryRunPreview(db, 'MEMO_UPDATE', args, 'MEMO_UPDATE:239')
    expect(p.targetLabel).toBe('메모 #239')
    expect(p.changes[0].before).toContain('실제 대상 메모 239 본문')
  })

  test('일정·할 일·자동화 삭제 #239: 미리보기 라벨이 실제 대상과 일치한다', async () => {
    const db = asD1(makeFake())
    const s = await buildDryRunPreview(db, 'SCHEDULE_DELETE', { id: 239 }, 'SCHEDULE_DELETE:239')
    expect(s.targetLabel).toBe('일정 #239 "대상 일정 239"')
    expect(formatDryRunPreview(s)).toContain('대상: 일정 #239')
    const t = await buildDryRunPreview(db, 'TODO_DELETE', { id: 239 }, 'TODO_DELETE:239')
    expect(t.targetLabel).toBe('할 일 #239 "대상 할 일 239"')
    const c = await buildDryRunPreview(db, 'CRON_DELETE', { id: 239 }, 'CRON_DELETE:239')
    expect(c.targetLabel).toBe('자동화 #239 "대상 자동화 239"')
    // snake_case 대상 키도 같은 대상을 가리킨다
    const c2 = await buildDryRunPreview(db, 'CRON_DELETE', { cron_id: 239 }, 'CRON_DELETE:239')
    expect(c2.targetLabel).toBe('자동화 #239 "대상 자동화 239"')
    expect(approvalScopeKey('CRON_DELETE', { cron_id: 239 })).toBe('CRON_DELETE:239')
  })

  test('ARTIFACT_DELETE #239: 미리보기가 도구명이 아니라 실제 아티팩트를 가리킨다', async () => {
    const db = artifactDb({ id: 239, title: '대상 아티팩트 239' })
    const p = await buildDryRunPreview(db, 'ARTIFACT_DELETE', { id: 239 }, 'ARTIFACT_DELETE:239')
    expect(p.unavailable).toBe(false)
    expect(p.targetFound).toBe(true)
    expect(p.targetLabel).toBe('아티팩트 #239 "대상 아티팩트 239"')
    expect(formatDryRunPreview(p)).toContain('대상: 아티팩트 #239')
    expect(describeMaskedToolAction('ARTIFACT_DELETE', { id: 239 }).summary).toBe('아티팩트 #239 삭제')
  })

  test('ARTIFACT_DELETE: 대상이 없어도 라벨은 실제 요청 id를 가리키고 경고를 단다', async () => {
    const p = await buildDryRunPreview(artifactDb(null), 'ARTIFACT_DELETE', { id: 239 }, 'ARTIFACT_DELETE:239')
    expect(p.targetFound).toBe(false)
    expect(p.targetLabel).toBe('아티팩트 #239')
    expect(p.warnings).toEqual(['대상을 찾을 수 없어요. 승인해도 실행이 실패할 거예요.'])
  })
})
