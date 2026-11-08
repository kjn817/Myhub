/**
 * 자동화 승인 계약 고정 테스트 — 트랙 1 (2026-10-31, GPT 6.7 §7.1 대응)
 *
 * 확정 계약 (docs/gate-policy-equivalence-20261030.md "자동화 승인 계약" 절):
 * - 자동화(user_cron_jobs)의 정의 스키마는 action + nl_text + 스케줄뿐이다.
 *   action은 닫힌 집합(morning-briefing / news-summary / schedule-reminder /
 *   generic)이며, 전부 "읽기 + 본인 푸시 전달"이다. 실행 시점에 수행할
 *   쓰기 도구·대상·인자를 정의에 바인딩하는 필드 자체가 없다.
 * - 따라서 예약 실행(runDueCronJobs)은 승인 상속 문제가 생길 수 없다:
 *   도구를 제공받지 않고, AI가 필요하면 persona 없는 capability 호출
 *   (news-briefing, origin='scheduled')만 쓴다.
 * - 승인이 걸리는 지점은 "생성"이다: AI 경유 생성(cron_create / CRON_CREATE)은
 *   쓰기로 분류돼 대화형 승인 게이트를 거치고, REST 직접 생성은 세션 인증된
 *   사용자 본인의 직접 행위다. 예약 실행이 새 자동화를 만드는 것도 불가하다.
 * - §6.3의 출처 게이트는 이 계약과 양립한다: 비대화형 쓰기는 승인 기록·
 *   세션 허용이 있어도 3층(E1 decide / E2 FC 게이트 / E3 WriteGuard) 모두
 *   승인 판단 전에 deny다.
 *
 * 카나리아 성질:
 * - runDueCronJobs가 도구 실행을 시작하거나(메모 생성·삭제 등), parseNlCron이
 *   쓰기 액션을 반환하기 시작하면 ①·②가 실패한다.
 * - 어느 한 층이라도 origin 분기를 지우면 ③이 실패한다.
 * - cron_create가 승인 게이트 대상에서 빠지면 ④가 실패한다.
 */

import { createCronJob, runDueCronJobs, type CronJob } from '../src/services/cron-jobs'
import { parseNlCron } from '../src/services/nl-cron'
import { decideToolExecution, classifyToolRisk, approvalScopeKey, type ApprovalRecord } from '../src/services/tool-approval'
import { gateFCToolCall, isFCApprovalGated } from '../src/services/fc-approval-gate'
import { WriteExecutionGuard, createTestApproval } from '../src/ai/tools/write-guard'
import { FakeD1, asD1 } from './fake-d1'

const NOW = new Date('2026-10-25T07:00:00+09:00')
const LATER = new Date('2026-10-25T09:00:00+09:00')
const GATE_NOW = new Date('2026-10-30T08:00:00Z')
const FUTURE = new Date('2026-10-31T08:00:00Z').toISOString()

const CLOSED_ACTIONS = ['morning-briefing', 'news-summary', 'schedule-reminder', 'generic']

// ===========================================================================
// ① 정의 스키마는 닫혀 있다 — 쓰기 의도 문장도 쓰기 액션이 되지 않는다
// ===========================================================================
describe('① 자동화 정의의 닫힌 액션 집합', () => {
  test('쓰기·파괴 의도를 담은 자연어도 닫힌 4종 액션으로만 파싱된다', () => {
    const texts = [
      '매일 아침 8시에 메모 삭제해줘',
      '매일 아침 8시에 메모 만들어줘',
      '매일 저녁 7시에 일정 등록해줘',
      '매일 아침 8시에 이메일 보내줘',
      '매일 아침 8시에 브리핑해줘',
      '매일 아침 8시에 뉴스 요약해줘',
      '매일 아침 8시에 알려줘',
      '30분마다 메모 지워줘',
    ]
    for (const t of texts) {
      const parsed = parseNlCron(t)
      expect(parsed).not.toBeNull()
      expect(CLOSED_ACTIONS).toContain(parsed!.action)
    }
    // 삭제 의도는 generic(단순 알림)으로 축소된다 — 삭제 액션은 존재하지 않는다
    expect(parseNlCron('매일 아침 8시에 메모 삭제해줘')!.action).toBe('generic')
    expect(parseNlCron('30분마다 메모 지워줘')!.action).toBe('generic')
  })
})

// ===========================================================================
// ② E2E — 예약 실행 경로 실증: 전달만 하고 어떤 도구 쓰기도 하지 않는다
// ===========================================================================
describe('② 예약 실행 E2E (생성 → due → runDueCronJobs)', () => {
  test('브리핑·삭제의도 generic·뉴스 작업이 모두 전달만 하고 메모를 건드리지 않는다', async () => {
    const fake = new FakeD1()
    const db = asD1(fake)
    // 실행이 건드리면 안 되는 기존 데이터
    fake.tables.memos.push({ id: 1, text: '삭제되면 안 되는 메모', sensitivity: 0, is_locked: 0 } as any)
    fake.tables.schedules.push({ id: 1, title: '오전 회의', start_at: '2026-10-25T09:00', location: null } as any)
    const memosBefore = JSON.stringify(fake.tables.memos)

    // 대화형으로 생성·승인된 정의에 해당하는 저장 (생성 게이트는 ④에서 고정)
    // 뉴스 작업은 소스 체인(fetch)에 의존하므로 별도 테스트에서 목으로 고정한다.
    const briefing = await createCronJob(db, '매일 아침 8시에 브리핑해줘', NOW)
    const delIntent = await createCronJob(db, '매일 아침 8시에 메모 삭제해줘', NOW)
    expect([briefing, delIntent].every(Boolean)).toBe(true)
    expect(delIntent!.action).toBe('generic')

    const delivered: Array<{ job: CronJob; text: string }> = []
    const result = await runDueCronJobs(
      { DB: db },
      async (job, text) => { delivered.push({ job, text }) },
      LATER,
      { newsSummarize: async (items) => items.map((it, i) => `${i + 1}. ${it.title} — [출처](${it.url})`).join('\n') },
    )
    expect(result.checked).toBe(2)
    expect(result.delivered).toBe(2)
    expect(delivered.map((d) => d.job.id).sort()).toEqual([briefing!.id, delIntent!.id].sort())

    const byId = new Map(delivered.map((d) => [d.job.id, d.text]))
    // 브리핑: 일정 읽기 결과만으로 만든 문장
    expect(byId.get(briefing!.id)).toContain('오전 회의')
    // 삭제 의도 generic: 삭제 실행이 아니라 알림 확인 문장
    expect(byId.get(delIntent!.id)).toBe('매일 오전 8시에 알림을 보내드릴게요.')

    // 핵심 단언: 어떤 메모도 생성·삭제·수정되지 않았다
    expect(JSON.stringify(fake.tables.memos)).toBe(memosBefore)
    // 자동화 행은 next_run_at 선점(다음 실행 예약)만 바뀌었다 — 새 자동화가
    // 예약 실행 중에 생성되지 않았다
    expect(fake.tables.user_cron_jobs).toHaveLength(2)
    // 승인 대기 요청도 예약 실행이 만들지 않았다
    expect(fake.tables.tool_approval_requests).toHaveLength(0)
  })

  test('뉴스 요약 작업도 주입된 요약 결과의 전달이 전부다 (도구 쓰기 없음)', async () => {
    const fake = new FakeD1()
    const db = asD1(fake)
    fake.tables.memos.push({ id: 7, text: '유지돼야 할 메모', sensitivity: 0, is_locked: 0 } as any)
    await createCronJob(db, '매일 아침 8시에 뉴스 요약해줘', NOW)

    // 뉴스 소스 체인을 통과시키는 최소 fetch 목 (cron-jobs.test.ts와 같은 방식)
    const today = new Date().toISOString()
    const origFetch = global.fetch
    global.fetch = (async (url: any) => {
      const u = String(url)
      if (u.includes('api.exa.ai')) {
        return { ok: true, json: async () => ({ results: [{ title: '계약 뉴스', url: 'https://example.com/n1', highlights: ['요지'], publishedDate: today }] }) } as Response
      }
      if (u.includes('news.google.com')) {
        return { ok: true, text: async () => '<rss version="2.0"><channel></channel></rss>' } as Response
      }
      return { ok: true, text: async () => `<html><head><meta property="article:published_time" content="${today}"></head></html>` } as Response
    }) as typeof fetch
    try {
      const delivered: string[] = []
      const result = await runDueCronJobs(
        { DB: db, EXA_API_KEY: 'test-key' } as any,
        async (_job, text) => { delivered.push(text) },
        LATER,
        { newsSummarize: async (items) => items.map((it, i) => `${i + 1}. ${it.title} — [출처](${it.url})`).join('\n') },
      )
      expect(result.delivered).toBe(1)
      expect(delivered[0]).toContain('계약 뉴스')
      expect(fake.tables.memos).toHaveLength(1)
      expect(fake.tables.memos[0].text).toBe('유지돼야 할 메모')
    } finally {
      global.fetch = origFetch
    }
  })
})

// ===========================================================================
// ③ 출처 게이트 3층 — scheduled는 승인·세션 허용으로도 쓰기를 못 뚫는다
// ===========================================================================
describe('③ 비대화형(scheduled) 쓰기 deny — 3층 카나리아', () => {
  test('E1 decide: 유효한 승인 기록 + 세션 허용이 있어도 scheduled면 deny', () => {
    const approval: ApprovalRecord = {
      personaId: 'keeper', tool: 'MEMO_CREATE',
      scopeKey: approvalScopeKey('MEMO_CREATE', { text: 'x' }),
      decision: 'approved', expiresAt: FUTURE,
    }
    for (const origin of ['scheduled', 'mcp', 'channel', undefined] as const) {
      const d = decideToolExecution({
        personaId: 'keeper', tool: 'MEMO_CREATE', args: { text: 'x' },
        approval, sessionAllowed: true, origin, now: GATE_NOW,
      })
      expect(d.decision).toBe('deny')
      expect(d.reason).toBe('non_interactive_origin')
    }
    // 대조: 같은 승인·허용이라도 interactive면 allow (게이트가 통째로 닫힌 게 아님)
    const ok = decideToolExecution({
      personaId: 'keeper', tool: 'MEMO_CREATE', args: { text: 'x' },
      approval, sessionAllowed: true, origin: 'interactive', now: GATE_NOW,
    })
    expect(ok.decision).toBe('allow')
  })

  test('E2 FC 게이트: scheduled면 대기 요청조차 만들지 않고 deny', async () => {
    const fake = new FakeD1()
    const outcome = await gateFCToolCall({
      db: asD1(fake), personaId: 'keeper', conversationId: 1,
      toolName: 'memo_create', args: { text: '예약 실행이 쓰려는 메모' },
      userRequest: '예약', origin: 'scheduled', now: GATE_NOW,
    })
    expect(outcome.action).toBe('deny')
    if (outcome.action === 'deny') expect(outcome.error).toBe('non_interactive_origin')
    expect(fake.tables.tool_approval_requests).toHaveLength(0)
  })

  test('E3 WriteGuard: 유효한 승인 객체가 있어도 scheduled면 NON_INTERACTIVE_ORIGIN', async () => {
    const guard = new WriteExecutionGuard({
      db: { prepare: () => { const s: any = { bind: () => s, first: async () => null, run: async () => ({ meta: { changes: 1 } }) }; return s } } as any,
    })
    const args = { text: 'x' }
    const appr = await createTestApproval('u1', 'op-sched', 'memo_create', args)
    const r = await guard.checkBeforeExecute(
      { id: 'c1', name: 'memo_create', args, provider: 'workers-ai' } as any,
      { userId: 'u1', requestId: 'r1', approvedWrites: true, origin: 'scheduled' } as any,
      appr,
    )
    expect(r.allowed).toBe(false)
    expect((r as { allowed: false; errorCode: string }).errorCode).toBe('NON_INTERACTIVE_ORIGIN')
  })
})

// ===========================================================================
// ④ 승인이 걸리는 지점은 "생성"이다
// ===========================================================================
describe('④ 자동화 생성의 승인 게이트', () => {
  test('cron_create/CRON_CREATE는 쓰기로 분류되고 FC 승인 게이트 대상이다', () => {
    expect(classifyToolRisk('CRON_CREATE')).toBe('write')
    expect(classifyToolRisk('CRON_DELETE')).toBe('destructive')
    expect(isFCApprovalGated('cron_create')).toBe(true)
    expect(isFCApprovalGated('cron_delete')).toBe(true)
    // 대화형에서도 승인 없이는 ask (즉시 실행 아님)
    const d = decideToolExecution({
      personaId: 'keeper', tool: 'CRON_CREATE',
      args: { text: '매일 아침 8시에 브리핑해줘' }, origin: 'interactive', now: GATE_NOW,
    })
    expect(d.decision).toBe('ask')
  })

  test('예약 실행은 새 자동화를 만들 수 없다: scheduled + cron_create는 FC 게이트에서 deny', async () => {
    const fake = new FakeD1()
    const outcome = await gateFCToolCall({
      db: asD1(fake), personaId: 'keeper', conversationId: 1,
      toolName: 'cron_create', args: { text: '매일 아침 8시에 브리핑해줘' },
      userRequest: '예약', origin: 'scheduled', now: GATE_NOW,
    })
    expect(outcome.action).toBe('deny')
    expect(fake.tables.user_cron_jobs).toHaveLength(0)
  })
})
