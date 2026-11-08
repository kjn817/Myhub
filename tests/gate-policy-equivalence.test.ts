/**
 * 게이트 정책 동등성 테스트 — E1(마커) × E2(운영 FC) × E3(파일럿 WriteGuard)
 *
 * 배경: docs/gate-policy-equivalence-20261030.md, docs/fc-transition-plan-20261029.md §2.3.
 * GPT 지적 "마커 경로와 FC 경로의 정책 동등성 테스트가 없다"에 대한 고정 테스트.
 *
 * 원칙 (AGENTS.md 테스트 원칙):
 * - 실제 게이트 함수를 호출한다 (decideToolExecution / dispatchToolCall /
 *   WriteExecutionGuard.checkBeforeExecute / 정책 가드 / 실제 execute* 실행층).
 *   mock 호출 확인만 하는 테스트는 두지 않는다. DB는 SQL 필터를 충실히
 *   흉내 내는 인메모리 페이크로 대체한다 (실행층 코드는 전부 실제 코드).
 * - 판정이 일치하는 케이스는 양 경로의 판정을 각각 단언해 동등성을 고정한다.
 * - 판정이 갈리는 케이스는 테스트 이름에 [불일치 D*]를 명시하고, 양쪽의
 *   현행 판정을 각각 특성화(characterization)로 고정한다. 억지로 같은
 *   판정이라고 쓰지 않는다 — 한쪽 게이트가 바뀌면 이 테스트가 실패해
 *   불일치의 해소/변화를 사람이 확인하게 된다.
 *
 * 경로 판정 모델:
 * - E1 판정 = decideToolExecution (src/services/tool-approval.ts) 결과 +
 *   승인 통과 시 실제 execute* (src/services/memo-tools.ts)의 결과.
 *   (tool-markers.ts의 authorizeTool이 이 함수를 그대로 경유한다.)
 * - E2 판정 = 운영 판정 (2026-10-31 D1·D3 정렬 + 트랙 3 D2·D4·D5 해소):
 *   aiChat FC 루프가 디스패치 직전에 거치는 승인 게이트
 *   gateFCToolCall (src/services/fc-approval-gate.ts)의 판정 + 승인 시
 *   routes.ts와 같은 순서 (resolveApprovalReply →
 *   executeApprovedRequestOnce → executeFCApprovalPayload)의 실행 결과.
 *   디스패처 단독 판정(dispatchToolCall)도 트랙 3부터 공통 실행 정책
 *   (src/services/fc-tool-policy.ts의 checkFCDispatchPolicy — 비서별
 *   허용 목록 + 출처 게이트)를 실행 전에 강제하므로, 직접 호출자의
 *   판정도 같은 함수로 고정한다. 루프 자체의 통합 동작은
 *   tests/unit/ai-fc-approval-loop.test.ts, 게이트 왕복 전반은
 *   tests/fc-approval-gate.test.ts가 고정한다.
 * - E3 판정 = WriteExecutionGuard.checkBeforeExecute (src/ai/tools/write-guard.ts).
 *   E3는 운영 도달 불가(스테이징 전용)이므로 참고 대조로만 둔다.
 */

import { decideToolExecution, classifyToolRisk, isLockTool, type ApprovalRecord } from '../src/services/tool-approval'
import {
  assertToolCallAllowed,
  enforceNoLockMarkers,
  isMemoAccessibleForAI,
  PolicyViolationError,
} from '../src/services/policy-guard'
import { dispatchToolCall } from '../src/ai/memo-tool-dispatcher'
import { executeMemoGet, executeMemoSearch, executeMemoUpdate, executeMemoDelete } from '../src/services/memo-tools'
import { parseMemoCreateMarkers } from '../src/services/memo-tools'
import { preflightToolCalls, normalizeFCToolName } from '../src/ai/memo-fc-tools'
import { WriteExecutionGuard, createTestApproval } from '../src/ai/tools/write-guard'
import { checkProviderAllowed } from '../src/ai/legacy-privacy-guard'
import { getLegacyMarkerTools } from '../src/ai/legacy-privacy-guard'
import {
  gateFCToolCall,
  executeFCApprovalPayload,
  isFCPayload,
  fcApprovalToolFor,
  FC_APPROVAL_GATED_TOOLS,
} from '../src/services/fc-approval-gate'
import { resolveApprovalReply, executeApprovedRequestOnce } from '../src/services/approval-flow'
import {
  checkFCDispatchPolicy,
  classifyFCToolRisk,
  getPersonaFCTools,
  FC_TOOL_NAMES,
} from '../src/services/fc-tool-policy'
import { FakeD1 } from './fake-d1'

/** 디스패처 직접 호출의 표준 실행 컨텍스트 (keeper·대화형) */
const KEEPER_CTX = { personaId: 'keeper', origin: 'interactive' as const }

const NOW = new Date('2026-10-30T08:00:00Z')
const FUTURE = new Date('2026-10-31T08:00:00Z').toISOString()

function approvalFor(tool: string, scopeKey: string): ApprovalRecord {
  return { personaId: 'keeper', tool, scopeKey, decision: 'approved', expiresAt: FUTURE }
}

// ---------------------------------------------------------------------------
// 충실 페이크 D1 — memos 테이블의 SQL 필터(is_locked=0, sensitivity<=1)를
// 실제로 적용한다. 실행층 코드(memo-tools/ai-access)는 전부 실제 코드다.
// ---------------------------------------------------------------------------
type MemoRow = { id: number; text: string; sensitivity: number; is_locked: number; locked_blocks: string }

function makeMemoEnv() {
  const store = new Map<number, MemoRow>([
    [1, { id: 1, text: '공개 회의 메모', sensitivity: 0, is_locked: 0, locked_blocks: '[]' }],
    [2, { id: 2, text: '잠긴 카드번호 비밀', sensitivity: 0, is_locked: 1, locked_blocks: '[]' }],
    [3, { id: 3, text: '민감도2 메모 본문', sensitivity: 2, is_locked: 0, locked_blocks: '[]' }],
    [4, { id: 4, text: '개인 메모', sensitivity: 1, is_locked: 0, locked_blocks: '[]' }],
  ])
  let nextId = 100
  const db = {
    prepare(sql: string) {
      let bound: any[] = []
      const stmt: any = {
        bind(...args: any[]) { bound = args; return stmt },
        async first() {
          // executeMemoUpdate/Delete의 잠금·민감도 확인 (트랙 3 D2부터
          // sensitivity도 함께 조회한다): 필터 없이 행의 두 필드를 반환
          if (sql.includes('SELECT is_locked') && sql.includes('FROM memos') && !sql.includes('is_locked = 0')) {
            const row = store.get(Number(bound[0]))
            return row ? { is_locked: row.is_locked, sensitivity: row.sensitivity } : null
          }
          // getAccessibleMemo: WHERE id=? AND is_locked=0 AND sensitivity<=1 (SQL 필터 충실 재현)
          if (sql.includes('FROM memos') && sql.includes('is_locked = 0')) {
            const row = store.get(Number(bound[0]))
            if (!row || row.is_locked !== 0 || row.sensitivity > 1) return null
            return { ...row }
          }
          return null
        },
        async all() {
          // searchAccessibleMemos: SQL WHERE is_locked=0 AND sensitivity<=1 적용 후 반환.
          // 키워드 매칭 정밀도는 게이트 성질이 아니므로 접근 가능 행 전체를 돌려준다
          // (게이트 성질 = 잠긴/민감 행이 결과에 섞이지 않는 것).
          const results = [...store.values()]
            .filter((r) => r.is_locked === 0 && r.sensitivity <= 1)
            .map((r) => ({ id: r.id, snippet: r.text, sensitivity: r.sensitivity, is_locked: r.is_locked }))
          return { results }
        },
        async run() {
          if (sql.includes('INSERT INTO memos')) {
            const id = nextId++
            store.set(id, { id, text: String(bound[0]), sensitivity: 0, is_locked: 0, locked_blocks: '[]' })
            return { meta: { last_row_id: id, changes: 1 } }
          }
          if (sql.includes('DELETE FROM memos')) {
            const existed = store.delete(Number(bound[0]))
            return { meta: { changes: existed ? 1 : 0 } }
          }
          if (sql.includes('UPDATE memos SET text')) {
            const row = store.get(Number(bound[1]))
            if (row) row.text = String(bound[0])
            return { meta: { changes: row ? 1 : 0 } }
          }
          return { meta: { changes: 0 } }
        },
      }
      return stmt
    },
  }
  return { env: { DB: db } as any, store }
}

/**
 * 운영 판정용 하이브리드 env (D1 정렬 이후 E2 판정용).
 * 승인 테이블(tool_approvals/tool_approval_requests/tool_execution_audit)은
 * FakeD1이, 메모 테이블은 위 makeMemoEnv의 충실 페이크가 처리한다.
 * 게이트·승인 흐름·디스패처·실행층은 전부 실제 코드다.
 */
function makeOperationalEnv() {
  const memo = makeMemoEnv()
  const fake = new FakeD1()
  const db: any = {
    prepare(sql: string) {
      if (sql.includes('tool_approval') || sql.includes('tool_execution_audit')) {
        return (fake as any).prepare(sql)
      }
      return (memo.env.DB as any).prepare(sql)
    },
    async batch(stmts: any[]) {
      const results: any[] = []
      for (const s of stmts) results.push(await s.run())
      return results
    },
  }
  return { env: { DB: db } as any, store: memo.store, fake }
}

/** routes.ts 승인 가로채기와 같은 순서·분기(FC 페이로드 판별)로 승인 실행 */
async function approveFC(env: any, now: Date = NOW) {
  const resolution = await resolveApprovalReply(env.DB, {
    conversationId: 1,
    personaId: 'keeper',
    reply: '승인해',
    now,
  })
  expect(resolution.status).toBe('approved')
  const req = resolution.request!
  expect(isFCPayload(req.markerText)).toBe(true)
  const outcome = await executeApprovedRequestOnce(env.DB, req, async () =>
    executeFCApprovalPayload(env, req, { userId: 'default' }), now)
  return outcome
}

/** WriteGuard용 페이크 D1 — ai_tool_operations에 기존 operation이 없다고 답한다 */
function makeGuardDb(): any {
  return {
    prepare() {
      const stmt: any = {
        bind() { return stmt },
        async first() { return null },
        async run() { return { meta: { changes: 1 } } },
      }
      return stmt
    },
  }
}

const writeGuard = () => new WriteExecutionGuard({ db: makeGuardDb() })

// ===========================================================================
// 케이스 ① 잠긴 메모 읽기 — 일치 (양 경로 모두 차단, 공유 실행층)
// ===========================================================================
describe('① 잠긴 메모 읽기 (E1 vs E2)', () => {
  test('E1: MEMO_GET은 읽기라 게이트는 allow지만 실행층이 잠긴 메모를 숨긴다', async () => {
    const { env } = makeMemoEnv()
    const gate = decideToolExecution({ personaId: 'keeper', tool: 'MEMO_GET', args: { id: 2 }, origin: 'interactive', now: NOW })
    expect(gate.decision).toBe('allow') // 읽기 게이트 통과가 곧 노출은 아니다
    const exec = await executeMemoGet(env, 2)
    expect(exec.success).toBe(false)
    expect(exec.error).toBe('메모를 찾을 수 없음')
    expect(JSON.stringify(exec)).not.toContain('카드번호')
  })

  test('E2: memo_get(잠긴 id)도 같은 실행층에서 같은 실패', async () => {
    const { env } = makeMemoEnv()
    const r = await dispatchToolCall(env, { name: 'memo_get', arguments: { id: 2 } })
    expect(r.success).toBe(false)
    expect(r.error).toBe('메모를 찾을 수 없음')
    expect(JSON.stringify(r)).not.toContain('카드번호')
  })

  test('검색: 양 경로 모두 잠긴(2)·민감도2(3) 행을 결과에 포함하지 않는다', async () => {
    const { env } = makeMemoEnv()
    const e1 = await executeMemoSearch(env, '메모')
    const e2 = await dispatchToolCall(env, { name: 'memo_search', arguments: { query: '메모' } })
    expect(e1.success).toBe(true)
    expect(e2.success).toBe(true)
    const e1Ids = (e1.data as any[]).map((m) => m.id)
    const e2Ids = ((e2.data as any[]) ?? []).map((m: any) => m.id)
    for (const ids of [e1Ids, e2Ids]) {
      expect(ids).not.toContain(2)
      expect(ids).not.toContain(3)
      expect(ids).toContain(1)
    }
    // 공유 판정 함수 자체도 같은 결론
    expect(isMemoAccessibleForAI({ is_locked: 1, sensitivity: 0 })).toBe(false)
    expect(isMemoAccessibleForAI({ is_locked: 0, sensitivity: 2 })).toBe(false)
    expect(isMemoAccessibleForAI({ is_locked: 0, sensitivity: 1 })).toBe(true)
  })
})

// ===========================================================================
// 케이스 ② 잠긴 메모 쓰기/삭제 — 결과 일치(차단). 민감도2 삭제·수정도
// 트랙 3(D2)에서 실행층 통일로 일치에 편입됨
// ===========================================================================
describe('② 잠긴 메모 쓰기/삭제 (E1 vs E2)', () => {
  test('수정: E1·E2 모두 실행층이 잠금을 거부한다 [결과 일치]', async () => {
    const { env, store } = makeMemoEnv()
    // E1: 승인(세션 허용)을 받아 게이트를 통과해도 실행층이 잠금을 거부한다
    const gate = decideToolExecution({
      personaId: 'keeper', tool: 'MEMO_UPDATE', args: { id: 2, text: '덮어쓰기' },
      sessionAllowed: true, origin: 'interactive', now: NOW,
    })
    expect(gate.decision).toBe('allow')
    const exec = await executeMemoUpdate(env, 2, '덮어쓰기')
    expect(exec).toEqual({ success: false, error: '잠긴 메모는 수정할 수 없습니다' })
    expect(store.get(2)!.text).toBe('잠긴 카드번호 비밀')
    // E2: FC memo_update도 같은 실행층(executeMemoUpdate)에 닿아 같은
    // 문구로 거부된다 (실행층 통일 D2). 컨텍스트 없는 호출은 그 전에
    // 출처 게이트가 막는다 — ⑤ D4 테스트가 담당.
    const fc = await dispatchToolCall(env, { name: 'memo_update', arguments: { id: 2, text: '덮어쓰기' } }, KEEPER_CTX)
    expect(fc.success).toBe(false)
    expect(fc.error).toBe('잠긴 메모는 수정할 수 없습니다')
    expect(store.get(2)!.text).toBe('잠긴 카드번호 비밀')
  })

  test('삭제: 양 경로 모두 잠긴 메모를 지우지 못한다 (E1=승인+실행층 거부, E2=존재 숨김)', async () => {
    const { env, store } = makeMemoEnv()
    // E1: 승인 없이는 실행층에 도달조차 못 한다
    const noApproval = decideToolExecution({ personaId: 'keeper', tool: 'MEMO_DELETE', args: { id: 2 }, origin: 'interactive', now: NOW })
    expect(noApproval.decision).toBe('ask')
    // E1: 승인이 있어도 실행층이 거부한다
    const exec = await executeMemoDelete(env, 2)
    expect(exec).toEqual({ success: false, error: '잠긴 메모는 삭제할 수 없습니다' })
    // E2: 확인 단계가 getAccessibleMemo 경유라 잠긴 메모는 "찾을 수 없음"으로 실패
    const fc = await dispatchToolCall(env, { name: 'memo_delete', arguments: { id: 2 } }, KEEPER_CTX)
    expect(fc.success).toBe(false)
    expect(fc.error).toBe('메모를 찾을 수 없음')
    expect(store.has(2)).toBe(true)
  })

  test('[해소 D2] 민감도2(잠기지 않음) 메모 삭제·수정: E1 실행층도 E2도 승인으로도 허용하지 않는다', async () => {
    // 트랙 3 (2026-10-31): 더 엄격한 E2 판정으로 통일 — executeMemoDelete/
    // executeMemoUpdate(양 엔진이 공유하는 실행층)가 잠금뿐 아니라
    // 민감도 2 이상도 차단한다. 실행층의 민감도 검사를 제거하면(카나리아)
    // 아래 E1 삭제·수정이 성공으로 뒤집혀 이 테스트가 실패한다.
    const e1 = makeMemoEnv()
    const gate = decideToolExecution({
      personaId: 'keeper', tool: 'MEMO_DELETE', args: { id: 3 },
      sessionAllowed: true, origin: 'interactive', now: NOW,
    })
    expect(gate.decision).toBe('allow') // 게이트는 통과해도 실행층이 막는다
    const exec = await executeMemoDelete(e1.env, 3)
    expect(exec.success).toBe(false)
    expect(exec.error).toBe('메모를 찾을 수 없음') // 읽기 계층과 같은 존재 숨김
    expect(e1.store.has(3)).toBe(true)
    // 수정도 같은 결론 (E2는 memo_update 도구 자체가 없어 원래 차단)
    const upd = await executeMemoUpdate(e1.env, 3, '덮어쓰기')
    expect(upd.success).toBe(false)
    expect(e1.store.get(3)!.text).toBe('민감도2 메모 본문')

    // E2 직접 호출: 확인 단계에서부터 차단 (기존과 동일)
    const e2 = makeMemoEnv()
    const fc = await dispatchToolCall(e2.env, { name: 'memo_delete', arguments: { id: 3 } }, KEEPER_CTX)
    expect(fc.success).toBe(false)
    expect(e2.store.has(3)).toBe(true)

    // E2 운영 판정: 승인 게이트를 통과해 승인 실행(approvedDelete)까지 가도 차단
    const op = makeOperationalEnv()
    const fcGate = await gateFCToolCall({
      db: op.env.DB, personaId: 'keeper', conversationId: 1,
      toolName: 'memo_delete', args: { id: 3 },
      userRequest: '민감도2 메모 지워줘', origin: 'interactive', now: NOW,
    })
    expect(fcGate.action).toBe('ask') // 게이트 자체는 삭제 일반과 같이 승인을 요구한다
    const outcome = await approveFC(op.env)
    expect(outcome.claimed).toBe(true)
    expect(outcome.resultText).toContain('실행에 실패했어')
    expect(op.store.has(3)).toBe(true) // 승인 실행층의 접근 검사가 차단 — 행이 남는다
  })
})

// ===========================================================================
// 케이스 ③ 일반 쓰기 승인 정책 — 해소 (D1, 2026-10-31 fcaee4d)
// ===========================================================================
describe('③ 일반 쓰기 승인 정책 (E1 vs E2 vs E3)', () => {
  test('[해소 D1] MEMO_CREATE: E1·E2·E3 모두 승인 없으면 실행되지 않는다 (E2 운영 판정 = 게이트 ask)', async () => {
    // E1 판정
    const gate = decideToolExecution({ personaId: 'keeper', tool: 'MEMO_CREATE', args: { text: '새 메모' }, origin: 'interactive', now: NOW })
    expect(gate.decision).toBe('ask')
    expect(gate.reason).toBe('approval_required')
    // E3(파일럿)도 같은 쪽: 승인 없으면 거부
    const guard = await writeGuard().checkBeforeExecute(
      { id: 'c1', name: 'memo_create', args: { text: '새 메모' } } as any,
      { userId: 'u1', requestId: 'r1', approvedWrites: false, origin: 'interactive' } as any,
      null,
    )
    expect(guard.allowed).toBe(false)
    if (!guard.allowed) expect(guard.errorCode).toBe('APPROVAL_REQUIRED')
    // E2 운영 판정: FC 루프가 디스패치 직전에 거치는 게이트 실물 판정.
    // 승인 전에는 ask + FC 페이로드 대기 요청만 생기고 메모 행은 생기지
    // 않는다. 게이트가 ask 대신 allow를 돌려주면(우회 변형) 여기서 실패한다
    // — 카나리아 확인済 (보고 참조). 루프가 ask에서 디스패치를 멈추는
    // 통합 동작은 tests/unit/ai-fc-approval-loop.test.ts가 고정한다.
    const op = makeOperationalEnv()
    const before = op.store.size
    const fcGate = await gateFCToolCall({
      db: op.env.DB, personaId: 'keeper', conversationId: 1,
      toolName: 'memo_create', args: { text: '새 메모' },
      userRequest: '새 메모 만들어줘', origin: 'interactive', now: NOW,
    })
    expect(fcGate.action).toBe('ask')
    if (fcGate.action === 'ask') {
      expect(fcGate.approvalTool).toBe('MEMO_CREATE') // E1과 같은 도구명으로 정규화
      expect(isFCPayload(fcGate.request.markerText)).toBe(true)
    }
    expect(op.store.size).toBe(before) // 승인 전 실행 0건
    // 승인하면 E1과 같은 왕복(선점 실행)으로 정확히 실행된다
    const outcome = await approveFC(op.env)
    expect(outcome.claimed).toBe(true)
    expect(outcome.resultText).toMatch(/메모를 생성했어 \(id: \d+\)/)
    expect(op.store.size).toBe(before + 1)
  })

  test('[해소 D1] 게이트 정규화: FC 쓰기 8종은 E1 위험 분류표의 write/destructive 도구명으로 매핑된다', () => {
    // 게이트 대상에서 도구가 빠지거나(null), 매핑된 E1 이름이 분류표에서
    // write/destructive가 아니면 정렬이 깨진 것이므로 실패해야 한다.
    expect(FC_APPROVAL_GATED_TOOLS).toHaveLength(8) // cron_delete 추가 (2026-11-0x)
    for (const fcTool of FC_APPROVAL_GATED_TOOLS) {
      const approvalTool = fcApprovalToolFor(fcTool)
      expect(approvalTool).not.toBeNull()
      expect(['write', 'destructive']).toContain(classifyToolRisk(approvalTool!))
    }
    // 읽기·UI 도구는 게이트 대상이 아니다 (과잉 게이트 방지)
    expect(fcApprovalToolFor('memo_search')).toBeNull()
    expect(fcApprovalToolFor('memo_get')).toBeNull()
    expect(fcApprovalToolFor('memo_ui_action')).toBeNull()
  })

  test('E1/E3 일치 구간: 유효한 승인이 있으면 양쪽 모두 allow', async () => {
    const gate = decideToolExecution({
      personaId: 'keeper', tool: 'MEMO_CREATE', args: { text: '승인된 메모' },
      approval: approvalFor('MEMO_CREATE', 'MEMO_CREATE'), origin: 'interactive', now: NOW,
    })
    expect(gate.decision).toBe('allow')
    expect(gate.reason).toBe('approved')
    const args = { text: '승인된 메모' }
    const appr = await createTestApproval('u1', 'op-1', 'memo_create', args)
    const guard = await writeGuard().checkBeforeExecute(
      { id: 'c1', name: 'memo_create', args } as any,
      { userId: 'u1', requestId: 'r1', approvedWrites: true, origin: 'interactive' } as any,
      appr,
    )
    expect(guard.allowed).toBe(true)
  })

  test('읽기 쓰기 분류 자체는 공유된다: FC 이름도 정규화하면 같은 위험 등급', () => {
    // 이름 공간이 달라(대문자 마커 vs 소문자 FC) decide는 FC 이름을 직접
    // 분류하지 못한다 — 정규화(normalizeFCToolName) 후 대문자화해야 같은 표가 된다.
    expect(normalizeFCToolName('memo_create')).toBe('memo_create')
    expect(classifyToolRisk('MEMO_CREATE')).toBe('write')
    expect(classifyToolRisk('MEMO_DELETE')).toBe('destructive')
    expect(classifyToolRisk('MEMO_SEARCH')).toBe('read')
    // FC 전용 memo_ui_action / cron_set_enabled는 E1 분류표에 없다 (unknown)
    expect(classifyToolRisk('MEMO_UI_ACTION')).toBe('unknown')
    expect(classifyToolRisk('CRON_SET_ENABLED')).toBe('unknown')
    expect(classifyToolRisk('CRON_TOGGLE')).toBe('write') // E1 쪽 이름은 TOGGLE
  })
})

// ===========================================================================
// 케이스 ④ 삭제 완결 방식 — 해소 (D3, 2026-10-31 fcaee4d)
// ===========================================================================
describe('④ 삭제 완결 방식 (E1 vs E2)', () => {
  test('[해소 D3] 잠기지 않은 메모: E1·E2 모두 승인 후 실제 삭제까지 완주한다 (E2 직접 호출은 확인 단계가 기본값)', async () => {
    // E1: 세션 허용 → 게이트 allow → 실행층이 실제로 지운다
    const e1 = makeMemoEnv()
    const gate = decideToolExecution({
      personaId: 'keeper', tool: 'MEMO_DELETE', args: { id: 1 },
      sessionAllowed: true, origin: 'interactive', now: NOW,
    })
    expect(gate.decision).toBe('allow')
    const exec = await executeMemoDelete(e1.env, 1)
    expect(exec.success).toBe(true)
    expect(e1.store.has(1)).toBe(false)

    // E2 직접 호출(승인 게이트 미경유): 기존대로 확인 요청까지만 — 안전 기본값 유지
    const e2 = makeMemoEnv()
    const fc = await dispatchToolCall(e2.env, { name: 'memo_delete', arguments: { id: 1 } }, KEEPER_CTX)
    expect(fc.success).toBe(true)
    expect((fc.data as any).status).toBe('confirmation_required')
    expect((fc.data as any).requiresConfirmation).toBe(true)
    expect(e2.store.has(1)).toBe(true) // 지워지지 않았다

    // E2 운영 판정: 승인 게이트 ask → 승인 실행(approvedDelete)이 실제
    // 삭제까지 완주한다. 승인 실행이 확인 단계로 되돌아가면 행이 남아 실패한다.
    const op = makeOperationalEnv()
    const fcGate = await gateFCToolCall({
      db: op.env.DB, personaId: 'keeper', conversationId: 1,
      toolName: 'memo_delete', args: { id: 1 },
      userRequest: '이 메모 지워줘', origin: 'interactive', now: NOW,
    })
    expect(fcGate.action).toBe('ask')
    expect(op.store.has(1)).toBe(true) // 승인 전에는 지워지지 않는다
    const outcome = await approveFC(op.env)
    expect(outcome.claimed).toBe(true)
    expect(outcome.resultText).toBe('메모 1를 삭제했어.')
    expect(op.store.has(1)).toBe(false) // 실제 삭제 완주
  })
})

// ===========================================================================
// 케이스 ⑤ 비대화형 origin 쓰기 — 해소 (D4, 트랙 3: 디스패처가 공통 강제)
// ===========================================================================
describe('⑤ 비대화형 origin에서의 쓰기 (E1 vs E2 vs E3)', () => {
  test('공유 규칙 일치: decideToolExecution과 WriteExecutionGuard 모두 scheduled 쓰기를 deny', async () => {
    const gate = decideToolExecution({ personaId: 'concierge', tool: 'MEMO_CREATE', args: { text: 'x' }, origin: 'scheduled', now: NOW })
    expect(gate.decision).toBe('deny')
    expect(gate.reason).toBe('non_interactive_origin')
    // 승인 기록이 있어도 비대화형은 뚫지 못한다 (양 게이트 공통)
    const gateWithApproval = decideToolExecution({
      personaId: 'keeper', tool: 'MEMO_CREATE', args: { text: 'x' },
      approval: approvalFor('MEMO_CREATE', 'MEMO_CREATE'), origin: 'mcp', now: NOW,
    })
    expect(gateWithApproval.decision).toBe('deny')
    const appr = await createTestApproval('u1', 'op-2', 'memo_create', { text: 'x' })
    const guard = await writeGuard().checkBeforeExecute(
      { id: 'c1', name: 'memo_create', args: { text: 'x' } } as any,
      { userId: 'u1', requestId: 'r1', approvedWrites: true, origin: 'scheduled' } as any,
      appr,
    )
    expect(guard.allowed).toBe(false)
    if (!guard.allowed) expect(guard.errorCode).toBe('NON_INTERACTIVE_ORIGIN')
  })

  test('origin 미지정도 쓰기는 fail-closed로 deny (decide / WriteGuard 공통)', async () => {
    const gate = decideToolExecution({ personaId: 'concierge', tool: 'MEMO_CREATE', args: { text: 'x' }, now: NOW })
    expect(gate.decision).toBe('deny')
    expect(gate.reason).toBe('non_interactive_origin')
    const appr = await createTestApproval('u1', 'op-3', 'memo_create', { text: 'x' })
    const guard = await writeGuard().checkBeforeExecute(
      { id: 'c1', name: 'memo_create', args: { text: 'x' } } as any,
      { userId: 'u1', requestId: 'r1', approvedWrites: true } as any, // origin 없음
      appr,
    )
    expect(guard.allowed).toBe(false)
    if (!guard.allowed) expect(guard.errorCode).toBe('NON_INTERACTIVE_ORIGIN')
  })

  test('읽기는 origin과 무관하게 양 경로 모두 허용 (일치)', async () => {
    const gate = decideToolExecution({ personaId: 'keeper', tool: 'MEMO_SEARCH', args: { query: '메모' }, origin: 'scheduled', now: NOW })
    expect(gate.decision).toBe('allow')
    const { env } = makeMemoEnv()
    const fc = await dispatchToolCall(env, { name: 'memo_search', arguments: { query: '메모' } }, { origin: 'scheduled' })
    expect(fc.success).toBe(true)
  })

  test('[해소 D4] E2 디스패처가 origin을 직접 강제한다 — 비대화형·미지정 쓰기는 실행 전에 deny', async () => {
    // 트랙 3 (2026-10-31): 강제 지점이 ai.ts 루프 인라인 목록에서
    // 디스패처 공통 계층(fc-tool-policy.checkFCDispatchPolicy)으로 옮겨졌다.
    // 디스패처의 출처 검사를 무력화하면(카나리아) 아래 쓰기가 실행돼
    // 이 테스트가 실패한다.
    for (const origin of ['scheduled', 'mcp', 'channel', undefined] as const) {
      const { env, store } = makeMemoEnv()
      const before = store.size
      const fc = await dispatchToolCall(
        env,
        { name: 'memo_create', arguments: { text: '예약 출처 메모' } },
        { personaId: 'keeper', ...(origin ? { origin } : {}) },
      )
      expect(fc.success).toBe(false)
      expect(fc.error).toBe('non_interactive_origin')
      expect(store.size).toBe(before) // 실행층에 닿지 않았다
    }
    // 삭제(파괴적)도 같은 판정 — 승인 실행 플래그가 있어도 출처가 먼저다
    const del = makeMemoEnv()
    const fcDel = await dispatchToolCall(
      del.env,
      { name: 'memo_delete', arguments: { id: 1 } },
      { personaId: 'keeper', origin: 'scheduled', approvedDelete: true },
    )
    expect(fcDel.success).toBe(false)
    expect(fcDel.error).toBe('non_interactive_origin')
    expect(del.store.has(1)).toBe(true)
  })

  test('[해소 D4] 출처 게이트는 이름 목록이 아니라 위험 분류로 판정한다 — 전 FC 도구가 분류를 가진다', async () => {
    // 통합 전 결함: 루프 인라인 목록(7종)에 없는 신규 쓰기 도구는 무방비.
    // 이제 분류표에 없는 이름은 'unknown'으로 deny-by-default이고,
    // 쓰기·파괴적 전 도구가 scheduled에서 같은 deny를 받는다.
    const writeArgs: Record<string, any> = {
      memo_create: { text: 'x' },
      memo_create_from_source: { source_text: 'x' },
      memo_update: { id: 1, text: 'x' },
      memo_delete: { id: 1 },
      schedule_create: { title: 'x', start_at: '2999-01-01T00:00:00' },
      cron_create: { text: '매일 아침 8시에 브리핑해줘' },
      cron_set_enabled: { id: 1, enabled: false },
      cron_delete: { id: 1 },
    }
    for (const name of FC_TOOL_NAMES) {
      const risk = classifyFCToolRisk(name)
      expect(risk).not.toBe('unknown') // 등록된 12종은 전부 분류된다
      if (risk === 'write' || risk === 'destructive') {
        const { env } = makeMemoEnv()
        const fc = await dispatchToolCall(env, { name, arguments: writeArgs[name] }, { personaId: 'keeper', origin: 'scheduled' })
        expect(fc.success).toBe(false)
        expect(fc.error).toBe('non_interactive_origin')
      }
    }
    // 분류되지 않은 이름은 디스패처의 도구 목록 검사에서 거부된다
    expect(classifyFCToolRisk('memo_fly')).toBe('unknown')
    const { env } = makeMemoEnv()
    const unknown = await dispatchToolCall(env, { name: 'memo_fly', arguments: {} }, KEEPER_CTX)
    expect(unknown.success).toBe(false)
    // 읽기는 비대화형에서도 허용된다 (MCP 읽기 전용 등 기존 동작 유지)
    const read = await dispatchToolCall(env, { name: 'memo_search', arguments: { query: '메모' } }, { personaId: 'keeper', origin: 'mcp' })
    expect(read.success).toBe(true)
  })
})

// ===========================================================================
// 케이스 ⑥ 민감도 높은 메모의 외부 전송 — 공유 프로바이더 게이트 일치
// ===========================================================================
describe('⑥ 민감도·외부 전송 게이트 (공유 계층)', () => {
  test('restricted는 전 프로바이더 차단, personal/general은 허용 — E1·E2가 같은 함수를 쓴다', () => {
    // checkProviderAllowed는 legacy-privacy-guard 경유로 selectModel/aiChat가
    // 공유한다 (E1/E2 모두 aiChat를 통과). E3는 ModelRouter.canUseProvider를
    // 쓰지만 기본 정책표의 결론이 같다 (전 프로바이더 allowRestricted=false).
    for (const p of ['groq', 'gemini', 'nvidia', 'workers-ai']) {
      expect(checkProviderAllowed(p, 'restricted').allowed).toBe(false)
      expect(checkProviderAllowed(p, 'personal').allowed).toBe(true)
      expect(checkProviderAllowed(p, 'general').allowed).toBe(true)
    }
  })

  test('민감도 2 이상 메모 본문은 읽기 게이트에서 원천 차단 (양 경로 공유 판정)', () => {
    expect(() => {
      const { assertMemoAccessibleForAI } = require('../src/services/policy-guard')
      assertMemoAccessibleForAI({ is_locked: 0, sensitivity: 2 })
    }).toThrow(PolicyViolationError)
  })
})

// ===========================================================================
// 케이스 ⑦ 비서별 허용 목록 — 해소 (D5, 트랙 3: 디스패처가 강제)
// ===========================================================================
describe('⑦ 비서별 허용 목록 밖 도구 (E1 vs E2)', () => {
  test('E1: 허용 목록 밖은 deny (builder의 MEMO_DELETE, scheduler의 MEMO_GET, keeper의 SCHEDULE_CREATE)', () => {
    expect(decideToolExecution({ personaId: 'builder', tool: 'MEMO_DELETE', args: { id: 1 }, origin: 'interactive', now: NOW }).reason).toBe('tool_not_allowed')
    expect(decideToolExecution({ personaId: 'scheduler', tool: 'MEMO_GET', args: { id: 1 }, origin: 'interactive', now: NOW }).reason).toBe('tool_not_allowed')
    // keeper 마커 목록에는 일정 등록이 없다 — 그런데 E2 FC에는 schedule_create가 있다 (아래 D5-보충)
    expect(getLegacyMarkerTools('keeper')).not.toContain('SCHEDULE_CREATE')
    expect(decideToolExecution({ personaId: 'keeper', tool: 'SCHEDULE_CREATE', args: {}, origin: 'interactive', now: NOW }).reason).toBe('tool_not_allowed')
    // 모르는 비서는 deny-by-default
    expect(decideToolExecution({ personaId: 'bogus', tool: 'MEMO_SEARCH', now: NOW }).reason).toBe('unknown_persona')
  })

  test('[해소 D5] E2 디스패처가 비서별 허용 목록을 실행 전에 강제한다 (스킬 레지스트리 기준)', async () => {
    // 트랙 3 (2026-10-31): 허용 집합의 단일 원천은 스킬 레지스트리다 —
    // 루프가 모델에게 제공하는 집합과 디스패처가 강제하는 집합이 같다.
    // 디스패처의 비서 검사를 무력화하면(카나리아) 아래 deny가 실행으로
    // 뒤집혀 이 테스트가 실패한다.
    expect(getPersonaFCTools('keeper')).toHaveLength(12) // 메모 7(memo_ui_action 포함) + 자동화 4 + 일정등록 1
    expect(getPersonaFCTools('builder')).toEqual([]) // FC 스킬이 없는 비서
    expect(getPersonaFCTools('bogus')).toBeNull()

    // builder는 E1에서 MEMO_CREATE 자체가 deny다 — E2에서도 실행 전에 deny
    const b = makeMemoEnv()
    const fcBuilder = await dispatchToolCall(b.env, { name: 'memo_create', arguments: { text: '노바 메모' } }, { personaId: 'builder', origin: 'interactive' })
    expect(fcBuilder.success).toBe(false)
    expect(fcBuilder.error).toBe('tool_not_allowed')
    expect(b.store.size).toBe(4) // 실행층에 닿지 않았다

    // scheduler는 메모 읽기가 허용 목록에 없다 (자동화만 있다)
    const s = makeMemoEnv()
    const fcSched = await dispatchToolCall(s.env, { name: 'memo_get', arguments: { id: 1 } }, { personaId: 'scheduler', origin: 'interactive' })
    expect(fcSched.success).toBe(false)
    expect(fcSched.error).toBe('tool_not_allowed')
    // scheduler의 허용 도구(자동화 읽기)는 출처가 비대화형이어도 통과한다
    expect(checkFCDispatchPolicy({ toolName: 'cron_list', personaId: 'scheduler', origin: 'mcp' }).allowed).toBe(true)

    // 모르는 비서는 E1과 같은 deny-by-default
    const u = makeMemoEnv()
    const fcBogus = await dispatchToolCall(u.env, { name: 'memo_search', arguments: { query: '메모' } }, { personaId: 'bogus', origin: 'interactive' })
    expect(fcBogus.success).toBe(false)
    expect(fcBogus.error).toBe('unknown_persona')

    // keeper는 전 도구 허용 — 같은 호출이 실행까지 간다 (양성 대조)
    const k = makeMemoEnv()
    const fcKeeper = await dispatchToolCall(k.env, { name: 'memo_create', arguments: { text: '에코 메모' } }, KEEPER_CTX)
    expect(fcKeeper.success).toBe(true)
    expect(k.store.size).toBe(5)
  })

  test('[D5 기본값] persona 미지정 직접 호출은 keeper로 간주한다 (운영 호출자는 전원 명시)', async () => {
    // FC 디스패처는 keeper 전용으로 도입됐고, 운영 호출자(ai.ts 루프·
    // 승인 실행)는 persona를 명시한다. 미지정 기본값은 그 이전부터
    // 디스패처를 직접 호출해 온 내부 호출자와의 호환을 위한 것으로,
    // fc-tool-policy.ts에 근거를 명시했다. 명시한 비서에 대한 강제는
    // 위 [해소 D5]가 고정한다.
    const { env, store } = makeMemoEnv()
    const fc = await dispatchToolCall(env, { name: 'memo_create', arguments: { text: '기본값 실행' } }, { origin: 'interactive' })
    expect(fc.success).toBe(true)
    expect(store.size).toBe(5)
  })

  test('[D5-보충 유지] keeper 일정 등록: E1 마커로는 deny, E2 FC에서는 keeper에게만 허용되는 의도된 확장', async () => {
    // 도구 존재 자체의 비대칭은 설계 결정으로 유지한다. 트랙 3 이후
    // FC 쪽 경계도 강제된다: schedule_create는 keeper 전용 스킬이라
    // 다른 비서(concierge 포함)는 디스패처에서 deny된다.
    const { SCHEDULE_FC_TOOLS } = require('../src/ai/schedule-fc-tools')
    expect(SCHEDULE_FC_TOOLS.map((t: any) => t.name)).toContain('schedule_create')
    expect(getLegacyMarkerTools('keeper')).not.toContain('SCHEDULE_CREATE')
    expect(checkFCDispatchPolicy({ toolName: 'schedule_create', personaId: 'keeper', origin: 'interactive' }).allowed).toBe(true)
    expect(checkFCDispatchPolicy({ toolName: 'schedule_create', personaId: 'concierge', origin: 'interactive' }))
      .toEqual({ allowed: false, reason: 'tool_not_allowed' })
    const { env } = makeMemoEnv()
    const fc = await dispatchToolCall(
      env,
      { name: 'schedule_create', arguments: { title: 'x', start_at: '2999-01-01T00:00:00' } },
      { personaId: 'concierge', origin: 'interactive' },
    )
    expect(fc.success).toBe(false)
    expect(fc.error).toBe('tool_not_allowed')
  })
})

// ===========================================================================
// 잠금/해제 도구 + step-up 도달성 — 일치 (양 경로 모두 전면 deny)
// ===========================================================================
describe('잠금/해제 도구 (E1 vs E2, step-up 전 단계)', () => {
  test('E1: 잠금 도구는 유효한 승인이 있어도 deny(lock_forbidden)', () => {
    const d = decideToolExecution({
      personaId: 'concierge', tool: 'MEMO_LOCK', args: { id: 1 },
      approval: approvalFor('MEMO_LOCK', 'MEMO_LOCK:1'), origin: 'interactive', now: NOW,
    })
    expect(d.decision).toBe('deny')
    expect(d.reason).toBe('lock_forbidden')
    expect(isLockTool('MEMO_UNLOCK')).toBe(true)
  })

  test('E2: 잠금 도구 호출은 정책 가드에서 실패하고 실행층에 닿지 않는다', async () => {
    const { env, store } = makeMemoEnv()
    for (const name of ['memo_lock', 'memo_unlock', 'MEMO_LOCK']) {
      const r = await dispatchToolCall(env, { name, arguments: { id: 1 } })
      expect(r.success).toBe(false)
      expect(r.error).toContain('잠그거나 해제')
    }
    // 정확 일치 목록에 없는 변형(lock/unlock 부분 문자열)도 정책 가드가 잡아야 한다.
    // 부분 문자열 규칙을 끄면 이 이름들은 'Unknown tool'로만 거부돼 메시지가
    // 달라진다 — 카나리아 2(부분 문자열 규칙 flip → 이 단언 실패)로 확인함.
    for (const name of ['memo_lock_v2', 'unlock_memo_ext']) {
      const r = await dispatchToolCall(env, { name, arguments: { id: 1 } })
      expect(r.success).toBe(false)
      expect(r.error).toContain('잠그거나 해제')
    }
    expect(() => assertToolCallAllowed('memo_lock', {})).toThrow(PolicyViolationError)
    expect(store.get(1)!.is_locked).toBe(0) // 아무것도 잠기지 않았다
    // 따라서 AI 경로에서는 잠금 해제 step-up(PIN 재입력)에 도달할 수 없다 —
    // step-up은 사용자 전용 API(POST /api/memo/:id/unlock 등)에서만 강제된다.
  })

  test('E1 마커 텍스트 단계: 잠금 마커는 실행 전에 정책 문구로 치환된다', () => {
    const out = enforceNoLockMarkers('잠가줘 [MEMO_LOCK]{"id":1}[/MEMO_LOCK]')
    expect(out).not.toContain('[MEMO_LOCK]')
    expect(out).toContain('정책 위반으로 차단됨')
  })

  test('[구조 차이] 잠금 필드 가드: E2는 인자의 is_locked를 명시 거부, E1 게이트는 필드를 보지 않는다', async () => {
    // E2 현행: 정상 도구라도 잠금 필드가 섞이면 정책 위반
    const { env } = makeMemoEnv()
    const fc = await dispatchToolCall(env, { name: 'memo_get', arguments: { id: 1, is_locked: 1 } })
    expect(fc.success).toBe(false)
    expect(fc.error).toContain('잠금 필드')
    // E1 현행: decideToolExecution은 인자 키를 검사하지 않는다 (읽기 allow).
    // 실제 마커 경로는 파서가 id/text/query만 추출해 필드가 흘러들 수 없으므로
    // 오늘은 도달 불가한 차이 — 파서 형태에 의존하는 방어임을 고정해 둔다.
    const gate = decideToolExecution({ personaId: 'keeper', tool: 'MEMO_GET', args: { id: 1, is_locked: 1 }, origin: 'interactive', now: NOW })
    expect(gate.decision).toBe('allow')
  })
})

// ===========================================================================
// 형식 검증 fail-closed — 일치 (양 경로 모두 깨진 호출을 실행하지 않음)
// ===========================================================================
describe('형식 검증 (E1 파서 vs E2 preflight)', () => {
  test('깨진 마커 JSON은 파서가 버리고, 깨진 FC 호출은 preflight가 거부한다', () => {
    expect(parseMemoCreateMarkers('[MEMO_CREATE]{깨진 json}[/MEMO_CREATE]')).toEqual([])
    expect(parseMemoCreateMarkers('[MEMO_CREATE]{"text":"정상"}[/MEMO_CREATE]')).toHaveLength(1)
    const pf = preflightToolCalls([
      { name: 'memo_create', arguments: {} }, // 필수 text 누락
      { name: 'memo_create', arguments: { text: '정상' } },
      { name: 'no_such_tool', arguments: {} },
    ])
    expect(pf.valid).toHaveLength(1)
    expect(pf.rejected).toHaveLength(2)
  })
})
