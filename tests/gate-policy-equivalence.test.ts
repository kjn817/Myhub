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
 * - E2 판정 = dispatchToolCall (src/ai/memo-tool-dispatcher.ts) 결과.
 *   단, 출처 게이트는 디스패처가 아니라 aiChat FC 루프(src/services/ai.ts)의
 *   인라인 코드에만 있으므로, 디스패처 단독 판정과 루프 포함 판정을 구분한다.
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
          // executeMemoUpdate/Delete의 잠금 확인: 필터 없이 is_locked만 조회
          if (sql.includes('SELECT is_locked FROM memos')) {
            const row = store.get(Number(bound[0]))
            return row ? { is_locked: row.is_locked } : null
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
// 케이스 ② 잠긴 메모 쓰기/삭제 — 결과 일치(차단), 도달 방식·민감도 삭제는 불일치
// ===========================================================================
describe('② 잠긴 메모 쓰기/삭제 (E1 vs E2)', () => {
  test('수정: E1은 승인 후에도 실행층이 거부, E2는 도구 자체가 없다 [표면 불일치·결과 일치]', async () => {
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
    // E2: memo_update라는 FC 도구 자체가 존재하지 않는다 (의도적 부재 — UI가 직접 처리)
    const fc = await dispatchToolCall(env, { name: 'memo_update', arguments: { id: 2, text: '덮어쓰기' } })
    expect(fc.success).toBe(false)
    expect(fc.error).toContain('Unknown tool')
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
    const fc = await dispatchToolCall(env, { name: 'memo_delete', arguments: { id: 2 } })
    expect(fc.success).toBe(false)
    expect(fc.error).toBe('메모를 찾을 수 없음')
    expect(store.has(2)).toBe(true)
  })

  test('[불일치 D2] 민감도2(잠기지 않음) 메모 삭제: E1 실행층은 삭제하고 E2는 차단한다', async () => {
    // executeMemoDelete는 is_locked만 검사하고 sensitivity는 보지 않는다.
    // 반면 E2의 삭제 확인은 getAccessibleMemo(sensitivity<=1)를 경유한다.
    const e1 = makeMemoEnv()
    const gate = decideToolExecution({
      personaId: 'keeper', tool: 'MEMO_DELETE', args: { id: 3 },
      sessionAllowed: true, origin: 'interactive', now: NOW,
    })
    expect(gate.decision).toBe('allow')
    const exec = await executeMemoDelete(e1.env, 3)
    expect(exec.success).toBe(true) // E1 현행: 읽을 수 없는 메모를 (승인 하에) 지울 수 있다
    expect(e1.store.has(3)).toBe(false)

    const e2 = makeMemoEnv()
    const fc = await dispatchToolCall(e2.env, { name: 'memo_delete', arguments: { id: 3 } })
    expect(fc.success).toBe(false) // E2 현행: 확인 단계에서부터 차단
    expect(e2.store.has(3)).toBe(true)
  })
})

// ===========================================================================
// 케이스 ③ 일반 쓰기 승인 정책 — 핵심 불일치
// ===========================================================================
describe('③ 일반 쓰기 승인 정책 (E1 vs E2 vs E3)', () => {
  test('[불일치 D1] MEMO_CREATE: E1은 승인 없으면 ask(미실행), E2는 승인 없이 즉시 실행한다', async () => {
    // E1 현행 판정
    const gate = decideToolExecution({ personaId: 'keeper', tool: 'MEMO_CREATE', args: { text: '새 메모' }, origin: 'interactive', now: NOW })
    expect(gate.decision).toBe('ask')
    expect(gate.reason).toBe('approval_required')
    // E3(파일럿)도 E1과 같은 쪽: 승인 없으면 거부
    const guard = await writeGuard().checkBeforeExecute(
      { id: 'c1', name: 'memo_create', args: { text: '새 메모' } } as any,
      { userId: 'u1', requestId: 'r1', approvedWrites: false, origin: 'interactive' } as any,
      null,
    )
    expect(guard.allowed).toBe(false)
    if (!guard.allowed) expect(guard.errorCode).toBe('APPROVAL_REQUIRED')
    // E2 현행 판정: 디스패처에 승인 개념이 없어 바로 실행되고 행이 생긴다
    const { env, store } = makeMemoEnv()
    const before = store.size
    const fc = await dispatchToolCall(env, { name: 'memo_create', arguments: { text: '새 메모' } })
    expect(fc.success).toBe(true)
    expect(store.size).toBe(before + 1)
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
// 케이스 ④ 삭제 확인·승인 정책 — 메커니즘 불일치
// ===========================================================================
describe('④ 삭제 완결 방식 (E1 vs E2)', () => {
  test('[불일치 D3] 잠기지 않은 메모: E1은 승인 후 실제 삭제, E2는 확인 요청만 반환하고 지우지 않는다', async () => {
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

    // E2: memo_delete는 1단계(확인 요청)까지만 구현 — 실제 삭제 도구/단계가 없다
    const e2 = makeMemoEnv()
    const fc = await dispatchToolCall(e2.env, { name: 'memo_delete', arguments: { id: 1 } })
    expect(fc.success).toBe(true)
    expect((fc.data as any).status).toBe('confirmation_required')
    expect((fc.data as any).requiresConfirmation).toBe(true)
    expect(e2.store.has(1)).toBe(true) // 지워지지 않았다
  })
})

// ===========================================================================
// 케이스 ⑤ 비대화형 origin 쓰기 — 공유 게이트 일치, E2 디스패처 단독은 불일치
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

  test('[불일치 D4] E2 디스패처 단독으로는 origin을 강제하지 않는다 (강제는 ai.ts FC 루프 인라인뿐)', async () => {
    // 디스패처의 origin은 provenance 기록용일 뿐이다 (memo-tool-dispatcher.ts
    // DispatcherContext 주석). scheduled를 넘겨도 쓰기가 실행됨을 고정한다.
    // 운영 도달 경로는 aiChat FC 루프가 디스패치 전에 FC_GATED_WRITE_TOOLS를
    // 걸러내므로 오늘은 루프가 유일한 방어선이다 — 루프를 거치지 않는
    // 새 호출자가 생기면 이 특성이 그대로 구멍이 된다.
    const { env, store } = makeMemoEnv()
    const before = store.size
    const fc = await dispatchToolCall(env, { name: 'memo_create', arguments: { text: '예약 출처 메모' } }, { origin: 'scheduled' })
    expect(fc.success).toBe(true)
    expect(store.size).toBe(before + 1)
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
// 케이스 ⑦ 비서별 허용 목록 — 불일치 (E2 디스패처에 비서 개념이 없다)
// ===========================================================================
describe('⑦ 비서별 허용 목록 밖 도구 (E1 vs E2)', () => {
  test('E1: 허용 목록 밖은 deny (builder의 MEMO_DELETE, scheduler의 MEMO_GET, keeper의 SCHEDULE_CREATE)', () => {
    expect(decideToolExecution({ personaId: 'builder', tool: 'MEMO_DELETE', args: { id: 1 }, origin: 'interactive', now: NOW }).reason).toBe('tool_not_allowed')
    expect(decideToolExecution({ personaId: 'scheduler', tool: 'MEMO_GET', args: { id: 1 }, origin: 'interactive', now: NOW }).reason).toBe('tool_not_allowed')
    // keeper 마커 목록에는 일정 등록이 없다 — 그런데 E2 FC에는 schedule_create가 있다 (아래 D5)
    expect(getLegacyMarkerTools('keeper')).not.toContain('SCHEDULE_CREATE')
    expect(decideToolExecution({ personaId: 'keeper', tool: 'SCHEDULE_CREATE', args: {}, origin: 'interactive', now: NOW }).reason).toBe('tool_not_allowed')
    // 모르는 비서는 deny-by-default
    expect(decideToolExecution({ personaId: 'bogus', tool: 'MEMO_SEARCH', now: NOW }).reason).toBe('unknown_persona')
  })

  test('[불일치 D5] E2 디스패처는 비서를 검사하지 않는다 — persona 인자 자체가 없고 전역 목록만 본다', async () => {
    // dispatchToolCall의 시그니처에는 persona가 없다. 어떤 비서의 턴인지와
    // 무관하게 validTools(11종) 안이면 실행된다. 운영에서는 useFC 게이트
    // (keeper+workers-ai)와 스킬 로드(제공 목록)가 이를 대신하지만,
    // 제공(offering)과 강제(enforcement)는 다르다: preflight도 전역
    // MEMO_FC_TOOLS 기준이라 스킬 부분집합을 강제하지 않는다.
    const { env } = makeMemoEnv()
    const fc = await dispatchToolCall(env, { name: 'memo_create', arguments: { text: '비서 무관 실행' } })
    expect(fc.success).toBe(true) // builder라면 E1에서 MEMO_CREATE 자체가 deny인 호출이다
    expect(decideToolExecution({ personaId: 'builder', tool: 'MEMO_CREATE', args: { text: 'x' }, origin: 'interactive', now: NOW }).reason).toBe('tool_not_allowed')
  })

  test('[불일치 D5-보충] keeper 일정 등록: E1 마커로는 deny, E2 FC 도구 목록에는 존재한다', () => {
    // 도구 존재 자체의 비대칭을 고정한다 (실행은 schedule 실행층 DB 의존이
    // 커서 존재·게이트 판정까지만 단언 — 문서 §검증 불가능 구간 참조).
    const { SCHEDULE_FC_TOOLS } = require('../src/ai/schedule-fc-tools')
    expect(SCHEDULE_FC_TOOLS.map((t: any) => t.name)).toContain('schedule_create')
    expect(getLegacyMarkerTools('keeper')).not.toContain('SCHEDULE_CREATE')
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
