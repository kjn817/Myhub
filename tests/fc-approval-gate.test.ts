/**
 * E2(에코 FC) 쓰기 승인 게이트 통합 테스트 (D1 정렬, 2026-10-31)
 *
 * 성질: 대화형 FC 쓰기는 승인 전 0건 실행, 승인 시 정확히 1회 실행,
 * 거부·만료 시 0건, 동시 승인은 executed_at 선점으로 1회만, 세션 허용
 * 후에는 재승인 없이 실행, 비대화형은 승인 없이 deny, 삭제는 승인 후
 * 실제 삭제까지 완주하되 잠긴·민감(2) 메모는 승인해도 차단된다.
 *
 * 구성: 게이트(fc-approval-gate)·승인 흐름(approval-flow)·디스패처·
 * 실행층(memo-tools/ai-access)은 전부 실제 코드다. DB는 승인 테이블은
 * FakeD1(실제 SQL 의미 재현), 메모는 SQL 필터(is_locked=0,
 * sensitivity<=1)를 충실히 적용하는 페이크, 나머지는 스텁으로 합친
 * 하이브리드다. routes.ts의 승인 실행 분기는 실제 Hono 앱으로 태운다.
 *
 * 카나리아: 게이트의 ask 분기를 allow로 바꾸면 "승인 전 0건" 단언이,
 * claimExecution을 무력화하면 "동시 승인 1회" 단언이 실패해야 한다.
 */
import {
  gateFCToolCall,
  executeFCApprovalPayload,
  encodeFCPayload,
  decodeFCPayload,
  isFCPayload,
  isFCApprovalGated,
  fcApprovalToolFor,
} from '../src/services/fc-approval-gate'
import {
  resolveApprovalReply,
  executeApprovedRequestOnce,
  ToolApprovalRequestStore,
  APPROVAL_TIMEOUT_MS,
  type PendingApprovalRequest,
} from '../src/services/approval-flow'
import { ToolApprovalStore } from '../src/services/tool-approval'
import { dispatchToolCall } from '../src/ai/memo-tool-dispatcher'
import { executeMemoDelete } from '../src/services/memo-tools'
import { FakeD1, asD1 } from './fake-d1'
import { aiApp } from '../src/modules/ai/routes'

const NOW = new Date('2026-10-31T04:00:00Z')
const CONV = 1

// ---------------------------------------------------------------------------
// 하이브리드 DB — 승인 테이블: FakeD1 / 메모: 충실 페이크 / 나머지: 스텁
// ---------------------------------------------------------------------------
type MemoRow = { id: number; text: string; sensitivity: number; is_locked: number; locked_blocks: string }

class HybridDb {
  fake = new FakeD1()
  memos = new Map<number, MemoRow>()
  private memoSeq = 100
  private chatSeq = 0

  seedMemo(id: number, text: string, opts: { is_locked?: number; sensitivity?: number } = {}) {
    this.memos.set(id, {
      id,
      text,
      sensitivity: opts.sensitivity ?? 0,
      is_locked: opts.is_locked ?? 0,
      locked_blocks: '[]',
    })
  }

  prepare(sql: string) {
    if (
      sql.includes('tool_approvals') ||
      sql.includes('tool_approval_requests') ||
      sql.includes('tool_execution_audit') ||
      sql.includes('user_cron_jobs')
    ) {
      return this.fake.prepare(sql)
    }
    const memos = this.memos
    let bound: any[] = []
    const stmt: any = {
      bind(...args: any[]) {
        bound = args
        return stmt
      },
      async first() {
        if (sql.includes('FROM ai_conversations')) return { ok: 1 }
        // executeMemoUpdate/Delete의 잠금·민감도 확인 (트랙 3 D2부터
        // sensitivity도 함께 조회한다)
        if (sql.includes('SELECT is_locked') && sql.includes('FROM memos') && !sql.includes('is_locked = 0')) {
          const row = memos.get(Number(bound[0]))
          return row ? { is_locked: row.is_locked, sensitivity: row.sensitivity } : null
        }
        // getAccessibleMemo: WHERE id=? AND is_locked=0 AND sensitivity<=1
        if (sql.includes('FROM memos') && sql.includes('is_locked = 0')) {
          const row = memos.get(Number(bound[0]))
          if (!row || row.is_locked !== 0 || row.sensitivity > 1) return null
          return { ...row }
        }
        return null
      },
      async all() {
        return { results: [] }
      },
      async run() {
        return { meta: { changes: 0 } }
      },
    }
    // 쓰기 실행은 seq·맵 갱신이 필요해 클로저로 교체한다
    const self = this
    stmt.run = async () => {
      if (sql.includes('INSERT INTO memos')) {
        const id = ++self.memoSeq
        memos.set(id, { id, text: String(bound[0]), sensitivity: 0, is_locked: 0, locked_blocks: '[]' })
        return { meta: { last_row_id: id, changes: 1 } }
      }
      if (sql.includes('DELETE FROM memos')) {
        const existed = memos.delete(Number(bound[0]))
        return { meta: { changes: existed ? 1 : 0 } }
      }
      if (sql.includes('INSERT INTO ai_chats')) {
        return { meta: { last_row_id: ++self.chatSeq, changes: 1 } }
      }
      if (sql.includes('INSERT INTO ai_conversations')) {
        return { meta: { last_row_id: 1, changes: 1 } }
      }
      return { meta: { changes: 0 } }
    }
    return stmt
  }

  async batch(stmts: any[]) {
    const results: any[] = []
    for (const s of stmts) results.push(await s.run())
    return results
  }
}

function makeWorld() {
  const db = new HybridDb()
  const env: any = { DB: db }
  return { db, env, fake: db.fake }
}

/** routes.ts 승인 가로채기와 같은 순서·같은 분기로 승인 실행을 수행한다 */
async function approveAndExecute(
  env: any,
  db: HybridDb,
  conversationId: number,
  reply: string,
  now: Date = NOW,
) {
  const resolution = await resolveApprovalReply(db as any, {
    conversationId,
    personaId: 'keeper',
    reply,
    now,
  })
  if (resolution.status !== 'approved' && resolution.status !== 'approved_session') {
    return { resolution, outcome: null as null | Awaited<ReturnType<typeof executeApprovedRequestOnce>> }
  }
  const req = resolution.request!
  const outcome = await executeApprovedRequestOnce(db as any, req, async () => {
    if (isFCPayload(req.markerText)) {
      return executeFCApprovalPayload(env, req, { userId: 'default' })
    }
    throw new Error('FC 페이로드가 아님')
  }, now)
  return { resolution, outcome }
}

async function gateMemoCreate(db: HybridDb, conversationId: number = CONV, now: Date = NOW) {
  return gateFCToolCall({
    db: db as any,
    personaId: 'keeper',
    conversationId,
    toolName: 'memo_create',
    args: { text: '승인 게이트 테스트 메모' },
    userRequest: '이 내용 메모로 만들어줘',
    origin: 'interactive',
    now,
  })
}

// ---------------------------------------------------------------------------
// 페이로드·분류
// ---------------------------------------------------------------------------
describe('FC 페이로드 인코딩', () => {
  test('인코딩 왕복 + 마커 텍스트와 구분된다', () => {
    const encoded = encodeFCPayload({ v: 1, kind: 'fc', name: 'memo_create', arguments: { text: 'x' } })
    expect(isFCPayload(encoded)).toBe(true)
    expect(decodeFCPayload(encoded)).toEqual({ v: 1, kind: 'fc', name: 'memo_create', arguments: { text: 'x' } })
    expect(isFCPayload('[MEMO_CREATE]{"text":"x"}[/MEMO_CREATE]')).toBe(false)
    expect(decodeFCPayload('[MEMO_CREATE]{"text":"x"}[/MEMO_CREATE]')).toBeNull()
    expect(decodeFCPayload('FC:{깨진 json')).toBeNull()
  })

  test('게이트 대상 분류: 쓰기 7종만 대상, 읽기·UI는 아니다', () => {
    for (const t of ['memo_create', 'memo_create_from_source', 'memo_delete', 'schedule_create', 'cron_create', 'cron_set_enabled', 'cron_delete']) {
      expect(isFCApprovalGated(t)).toBe(true)
    }
    for (const t of ['memo_search', 'memo_get', 'cron_list', 'memo_ui_action']) {
      expect(isFCApprovalGated(t)).toBe(false)
    }
    expect(fcApprovalToolFor('cron_set_enabled')).toBe('CRON_TOGGLE')
    expect(fcApprovalToolFor('memo_create_from_source')).toBe('MEMO_CREATE')
  })
})

// ---------------------------------------------------------------------------
// 게이트 판정 + 승인 왕복 (메모 생성)
// ---------------------------------------------------------------------------
describe('FC 쓰기 승인 왕복 (memo_create)', () => {
  test('승인 전: ask + 대기 요청 1건 + 쓰기 0건, 문안은 E1과 같은 형태', async () => {
    const { db } = makeWorld()
    const outcome = await gateMemoCreate(db)
    expect(outcome.action).toBe('ask')
    if (outcome.action !== 'ask') return
    expect(outcome.request.tool).toBe('MEMO_CREATE')
    expect(outcome.approvalText).toContain('[승인이 필요해요]')
    expect(outcome.approvalText).toContain('"승인해"')
    expect(outcome.approvalText).toContain('"이 세션 허용해"')
    // 페이로드는 마커가 아니라 FC 형태로 저장된다
    const stored = db.fake.tables.tool_approval_requests[0]
    expect(isFCPayload(stored.marker_text)).toBe(true)
    expect(decodeFCPayload(stored.marker_text)?.name).toBe('memo_create')
    // 게이트 자체는 아무것도 실행하지 않는다
    expect(db.memos.size).toBe(0)
  })

  test('같은 범위 재요청은 대기 요청을 재사용한다 (중복 생성 없음)', async () => {
    const { db } = makeWorld()
    const a = await gateMemoCreate(db)
    const b = await gateMemoCreate(db)
    expect(a.action).toBe('ask')
    expect(b.action).toBe('ask')
    if (a.action === 'ask' && b.action === 'ask') expect(b.request.id).toBe(a.request.id)
    expect(db.fake.tables.tool_approval_requests).toHaveLength(1)
  })

  test('승인 → 정확히 1회 실행, 재실행 시도는 claim에 막힌다', async () => {
    const { db, env } = makeWorld()
    await gateMemoCreate(db)
    const { resolution, outcome } = await approveAndExecute(env, db, CONV, '승인해')
    expect(resolution.status).toBe('approved')
    expect(outcome?.claimed).toBe(true)
    expect(outcome?.resultText).toMatch(/메모를 생성했어 \(id: \d+\)/)
    expect(db.memos.size).toBe(1)
    expect([...db.memos.values()][0].text).toBe('승인 게이트 테스트 메모')

    // 같은 승인 건을 다시 실행하려 해도 선점이 막는다
    const req = (await new ToolApprovalRequestStore(db as any).getRequestById(1))!
    const again = await executeApprovedRequestOnce(db as any, req, async () => {
      throw new Error('재실행되면 안 됨')
    }, NOW)
    expect(again.claimed).toBe(false)
    expect(db.memos.size).toBe(1)
  })

  test('동시 승인 실행 2건 → 실행은 정확히 1회 (executed_at 선점)', async () => {
    const { db, env } = makeWorld()
    await gateMemoCreate(db)
    const resolution = await resolveApprovalReply(db as any, {
      conversationId: CONV, personaId: 'keeper', reply: '승인해', now: NOW,
    })
    const req = resolution.request!
    let executions = 0
    const executor = async () => {
      executions += 1
      return executeFCApprovalPayload(env, req, { userId: 'default' })
    }
    const [a, b] = await Promise.all([
      executeApprovedRequestOnce(db as any, req, executor, NOW),
      executeApprovedRequestOnce(db as any, req, executor, NOW),
    ])
    expect(executions).toBe(1)
    expect([a, b].filter((o) => o.claimed)).toHaveLength(1)
    expect(db.memos.size).toBe(1)
  })

  test('거부 → 실행 0건', async () => {
    const { db, env } = makeWorld()
    await gateMemoCreate(db)
    const { resolution, outcome } = await approveAndExecute(env, db, CONV, '거부해')
    expect(resolution.status).toBe('denied')
    expect(outcome).toBeNull()
    expect(db.memos.size).toBe(0)
    expect(db.fake.tables.tool_approval_requests[0].status).toBe('denied')
  })

  test('만료 (10분 경과) → 실행 0건', async () => {
    const { db, env } = makeWorld()
    await gateMemoCreate(db)
    const later = new Date(NOW.getTime() + APPROVAL_TIMEOUT_MS + 1000)
    const { resolution, outcome } = await approveAndExecute(env, db, CONV, '승인해', later)
    expect(resolution.status).toBe('expired')
    expect(outcome).toBeNull()
    expect(db.memos.size).toBe(0)
  })

  test('세션 허용 → 실행되고, 같은 종류 재요청은 재승인 없이 allow', async () => {
    const { db, env } = makeWorld()
    await gateMemoCreate(db)
    const { resolution, outcome } = await approveAndExecute(env, db, CONV, '이 세션 허용해')
    expect(resolution.status).toBe('approved_session')
    expect(outcome?.claimed).toBe(true)
    expect(db.memos.size).toBe(1)

    const second = await gateMemoCreate(db)
    expect(second.action).toBe('allow')
    // 새 대기 요청이 생기지 않았다
    expect(db.fake.tables.tool_approval_requests).toHaveLength(1)
  })

  test('대화 ID가 없으면 pending을 만들지 못하고 실행도 없다 (blocked)', async () => {
    const { db } = makeWorld()
    const outcome = await gateFCToolCall({
      db: db as any, personaId: 'keeper', conversationId: null,
      toolName: 'memo_create', args: { text: 'x' }, userRequest: '만들어줘',
      origin: 'interactive', now: NOW,
    })
    expect(outcome.action).toBe('blocked')
    expect(db.fake.tables.tool_approval_requests).toHaveLength(0)
    expect(db.memos.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 출처 게이트 — 비대화형은 승인 절차 없이 deny (기존 유지)
// ---------------------------------------------------------------------------
describe('FC 게이트 출처 판정', () => {
  test('scheduled / 미지정 origin 쓰기 → deny, 대기 요청도 만들지 않는다', async () => {
    const { db } = makeWorld()
    for (const origin of ['scheduled', undefined] as const) {
      const outcome = await gateFCToolCall({
        db: db as any, personaId: 'keeper', conversationId: CONV,
        toolName: 'memo_create', args: { text: 'x' }, userRequest: '만들어줘',
        origin, now: NOW,
      })
      expect(outcome.action).toBe('deny')
      if (outcome.action === 'deny') expect(outcome.error).toBe('non_interactive_origin')
    }
    expect(db.fake.tables.tool_approval_requests).toHaveLength(0)
    expect(db.memos.size).toBe(0)
  })

  test('읽기 도구는 게이트 대상이 아니라 origin과 무관하게 allow', async () => {
    const { db } = makeWorld()
    const outcome = await gateFCToolCall({
      db: db as any, personaId: 'keeper', conversationId: CONV,
      toolName: 'memo_search', args: { query: '회의' }, userRequest: '찾아줘',
      origin: 'scheduled', now: NOW,
    })
    expect(outcome.action).toBe('allow')
  })
})

// ---------------------------------------------------------------------------
// 삭제 (D3) — 승인 후 실제 삭제 완주, 잠긴·민감 메모는 승인해도 차단
// ---------------------------------------------------------------------------
describe('FC 삭제 승인 왕복 (D3)', () => {
  test('디스패처 직접 호출은 확인 단계까지만 (기존 동작 유지)', async () => {
    const { db, env } = makeWorld()
    db.seedMemo(1, '지울 메모')
    // 트랙 3: 직접 호출자도 실행 컨텍스트(keeper·interactive)를 명시한다
    const r = await dispatchToolCall(env, { name: 'memo_delete', arguments: { id: 1 } }, { personaId: 'keeper', origin: 'interactive' })
    expect(r.success).toBe(true)
    expect((r.data as any).status).toBe('confirmation_required')
    expect(db.memos.has(1)).toBe(true)
  })

  test('승인 → 실제 삭제까지 완주한다 ("삭제해" 동사 승인 포함)', async () => {
    const { db, env } = makeWorld()
    db.seedMemo(1, '지울 메모')
    const gate = await gateFCToolCall({
      db: db as any, personaId: 'keeper', conversationId: CONV,
      toolName: 'memo_delete', args: { id: 1 }, userRequest: '그 메모 삭제해줘',
      origin: 'interactive', now: NOW,
    })
    expect(gate.action).toBe('ask')
    if (gate.action === 'ask') expect(gate.request.scopeKey).toBe('MEMO_DELETE:1')
    expect(db.memos.has(1)).toBe(true) // 승인 전에는 남아 있다

    const { resolution, outcome } = await approveAndExecute(env, db, CONV, '삭제해')
    expect(resolution.status).toBe('approved')
    expect(outcome?.claimed).toBe(true)
    expect(outcome?.resultText).toBe('메모 1를 삭제했어.')
    expect(db.memos.has(1)).toBe(false)
  })

  test('잠긴 메모 삭제는 승인해도 차단된다', async () => {
    const { db, env } = makeWorld()
    db.seedMemo(2, '잠긴 비밀 메모', { is_locked: 1 })
    await gateFCToolCall({
      db: db as any, personaId: 'keeper', conversationId: CONV,
      toolName: 'memo_delete', args: { id: 2 }, userRequest: '삭제해줘',
      origin: 'interactive', now: NOW,
    })
    const { outcome } = await approveAndExecute(env, db, CONV, '승인해')
    expect(outcome?.claimed).toBe(true)
    expect(outcome?.resultText).toContain('실행에 실패했어')
    expect(outcome?.resultText).toContain('찾을 수 없음')
    expect(db.memos.has(2)).toBe(true)
  })

  test('[해소 D2] 민감도2 메모: E2 승인 실행도, E1 실행층도 승인 하에 삭제하지 못한다', async () => {
    // E2(FC): 확인·실행 모두 getAccessibleMemo(sensitivity<=1)를 거치므로
    // 승인 실행에서도 차단된다.
    const w1 = makeWorld()
    w1.db.seedMemo(3, '민감도2 메모', { sensitivity: 2 })
    await gateFCToolCall({
      db: w1.db as any, personaId: 'keeper', conversationId: CONV,
      toolName: 'memo_delete', args: { id: 3 }, userRequest: '삭제해줘',
      origin: 'interactive', now: NOW,
    })
    const { outcome } = await approveAndExecute(w1.env, w1.db, CONV, '승인해')
    expect(outcome?.resultText).toContain('실행에 실패했어')
    expect(w1.db.memos.has(3)).toBe(true)

    // E1: 트랙 3(D2 통일)로 executeMemoDelete도 민감도 2 이상을
    // 차단한다 — 더 엄격한 E2 판정으로 정렬됐다. 실행층의 민감도 검사를
    // 제거하면(카나리아) 이 단언이 실패한다.
    const w2 = makeWorld()
    w2.db.seedMemo(3, '민감도2 메모', { sensitivity: 2 })
    const e1 = await executeMemoDelete(w2.env, 3)
    expect(e1.success).toBe(false)
    expect(e1.error).toBe('메모를 찾을 수 없음')
    expect(w2.db.memos.has(3)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 받아쓰기·자동화 — 페이로드 보존과 타 도구 왕복
// ---------------------------------------------------------------------------
describe('FC 승인 왕복 (기타 도구)', () => {
  test('memo_create_from_source: 승인 실행이 원본 문맥으로 받아쓰기를 완주한다', async () => {
    const { db, env } = makeWorld()
    const userText = '메모해줘: 분기 보고서 초안을 저장해줘'
    const gate = await gateFCToolCall({
      db: db as any, personaId: 'keeper', conversationId: CONV,
      toolName: 'memo_create_from_source',
      args: { source_text: '분기 보고서 초안을 저장해줘' },
      userRequest: userText, sourceUserText: userText,
      origin: 'interactive', now: NOW,
    })
    expect(gate.action).toBe('ask')
    if (gate.action === 'ask') expect(gate.request.tool).toBe('MEMO_CREATE')
    const { outcome } = await approveAndExecute(env, db, CONV, '승인해')
    expect(outcome?.claimed).toBe(true)
    expect(outcome?.resultText).toMatch(/메모를 생성했어 \(id: \d+\)/)
    expect([...db.memos.values()].some((m) => m.text.includes('분기 보고서'))).toBe(true)
  })

  test('cron_create: 승인 → 자동화 1건 저장', async () => {
    const { db, env } = makeWorld()
    const gate = await gateFCToolCall({
      db: db as any, personaId: 'keeper', conversationId: CONV,
      toolName: 'cron_create',
      args: { text: '매일 아침 8시에 뉴스 요약해서 푸시해줘' },
      userRequest: '매일 아침 8시에 뉴스 요약해서 푸시해줘',
      origin: 'interactive', now: NOW,
    })
    expect(gate.action).toBe('ask')
    expect(db.fake.tables.user_cron_jobs).toHaveLength(0)
    const { outcome } = await approveAndExecute(env, db, CONV, '승인해')
    expect(outcome?.claimed).toBe(true)
    expect(outcome?.resultText).toContain('자동화를 저장했어')
    expect(db.fake.tables.user_cron_jobs).toHaveLength(1)
  })

  test('schedule_create / cron_delete / cron_set_enabled도 게이트 대상이다', async () => {
    const { db } = makeWorld()
    const cases: Array<[string, any, string]> = [
      ['schedule_create', { title: '회의', start_at: '2026-11-01T15:00:00' }, 'SCHEDULE_CREATE'],
      ['cron_delete', { id: 5 }, 'CRON_DELETE'],
      ['cron_set_enabled', { id: 5, enabled: false }, 'CRON_TOGGLE'],
    ]
    for (const [toolName, args, approvalTool] of cases) {
      const outcome = await gateFCToolCall({
        db: db as any, personaId: 'keeper', conversationId: CONV,
        toolName, args, userRequest: '해줘', origin: 'interactive', now: NOW,
      })
      expect(outcome.action).toBe('ask')
      if (outcome.action === 'ask') expect(outcome.request.tool).toBe(approvalTool)
    }
  })
})

// ---------------------------------------------------------------------------
// routes.ts 실제 HTTP 왕복 — 승인 답이 FC 페이로드를 실행한다
// ---------------------------------------------------------------------------
describe('POST /api/ai/chat 승인 가로채기 (FC 페이로드)', () => {
  async function postChat(env: any, conversationId: number, text: string) {
    const res = await aiApp.request(
      '/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personaId: 'keeper',
          conversationId,
          messages: [{ role: 'user', content: text }],
        }),
      },
      env,
    )
    return { status: res.status, json: (await res.json()) as any }
  }

  test('승인해 → FC 메모 생성이 실행되고 approvalResolved=approved', async () => {
    const { db, env } = makeWorld()
    // routes 핸들러는 실제 시계로 만료를 판정하므로 실제 현재 시각으로 심는다
    await gateMemoCreate(db, 7, new Date())
    const { status, json } = await postChat(env, 7, '승인해')
    expect(status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.approvalResolved).toBe('approved')
    expect(json.text).toMatch(/메모를 생성했어 \(id: \d+\)/)
    expect(db.memos.size).toBe(1)
  })

  test('거부해 → 실행 없이 approvalResolved=denied', async () => {
    const { db, env } = makeWorld()
    await gateMemoCreate(db, 8, new Date())
    const { status, json } = await postChat(env, 8, '거부해')
    expect(status).toBe(200)
    expect(json.approvalResolved).toBe('denied')
    // 번들 계약: 승인 응답 문구는 격식체 (ai/routes 원문)
    expect(json.text).toContain('알겠습니다. 실행하지 않았습니다.')
    expect(db.memos.size).toBe(0)
  })

  test('E1 마커 페이로드는 기존 경로를 탄다 (회귀: FC 분기가 마커를 가로채지 않음)', async () => {
    const { db, env } = makeWorld()
    // 마커 형태의 대기 요청을 직접 심는다 (E1이 만드는 것과 같은 형태)
    const requests = new ToolApprovalRequestStore(asD1(db.fake))
    await requests.createPending({
      personaId: 'keeper',
      conversationId: 9,
      tool: 'MEMO_CREATE',
      scopeKey: 'MEMO_CREATE',
      markerText: '[MEMO_CREATE]{"text":"마커 메모"}[/MEMO_CREATE]',
      summary: '메모 생성 "마커 메모"',
      userRequest: '메모 만들어줘',
      reversible: true,
      impact: '새 메모 1개가 만들어집니다.',
      expiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString(),
      createdAt: new Date().toISOString(),
    })
    expect(isFCPayload('[MEMO_CREATE]{"text":"마커 메모"}[/MEMO_CREATE]')).toBe(false)
    const { status, json } = await postChat(env, 9, '승인해')
    expect(status).toBe(200)
    expect(json.approvalResolved).toBe('approved')
    // 마커 실행기(processToolMarkers)가 메모를 만들었다
    expect([...db.memos.values()].some((m) => m.text.includes('마커 메모'))).toBe(true)
    void env
  })
})
